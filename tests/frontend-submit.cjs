// Run with: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/frontend-submit.cjs
// APP_TEST_ROOT can point to a packaged app.asar to test the shipped files.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const projectRoot = path.resolve(__dirname, "..");
const root = process.env.APP_TEST_ROOT || projectRoot;
const tempRoot = path.join(projectRoot, "tmp");
fs.mkdirSync(tempRoot, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(tempRoot, "frontend-submit-test-")));
app.setName("视频转写提交回归测试");
app.on("window-all-closed", () => {});

const SINGLE_JOB = "0123456789abcdef";
const HISTORY_JOB = "1111111111111111";
const LONG_JOB = "2222222222222222";
const BATCH_JOB_1 = "3333333333333333";
const BATCH_JOB_2 = "4444444444444444";
const BATCH_JOB_3 = "5555555555555555";
const VIDEO_URL = "https://www.youtube.com/watch?v=inOno_bdSus";
const HISTORY_URL = "https://example.com/history";
const FULL_TRANSCRIPT = "这是完整的原始逐字稿，保留说话顺序、细节与每一个段落。\n".repeat(160) + "全文结尾：不能被两千字预览截断。";
const HOSTILE = '<img src=x onerror="window.modelHtmlExecuted=true">';

function makeReading(title = "从信息到理解：保留原文的主题阅读") {
  return {
    version: 1, sourceHash: "mock-source-hash", model: "mock-model", title,
    sourceUrl: VIDEO_URL, summary: "先把文稿读薄，再把细节读深。围绕主题回顾视频的核心观点，也能随时回到未经改写的原始逐字稿。",
    keyPoints: ["主题帮助建立内容脉络。", "重点提炼观点，不替代原文。", "原始段落保留语境与细节。"],
    sections: [
      { id: "topic-1", title: "先建立整体脉络", keyPoints: ["从概览进入具体主题。"], paragraphs: ["我们常常收集了很多信息，却很少留出时间去理解。先看整体，再按主题回到原文，是一种更从容的阅读方式。", "主题并不替代原文。它只是让我们知道，这段讨论在回答什么问题。"] },
      { id: "topic-2", title: "把重点放回语境", keyPoints: ["观点与例子应当一起阅读。"], paragraphs: ["如果只留下结论，就可能错过说话者的前提。这里保留原始段落，方便我们核对与重读。", "我们可以先读重点，再回到完整的逐字稿，确认没有忽略重要细节。"] },
      { id: "topic-3", title: "让阅读成为下一步行动", keyPoints: ["保存阅读版，也保留原始记录。"], paragraphs: ["最终，我们希望把理解带回自己的工作和生活。不同版本的文稿服务于不同目的，原文始终独立保留。"] }
    ],
    generatedAt: "2026-10-05T12:00:00.000Z"
  };
}

function maliciousReading() {
  const reading = makeReading(HOSTILE);
  reading.summary = `概览 ${HOSTILE}`;
  reading.keyPoints[0] = HOSTILE;
  reading.sections[0] = {
    id: '\"><script>window.modelHtmlExecuted=true</script>', title: HOSTILE,
    keyPoints: [HOSTILE], paragraphs: [HOSTILE, FULL_TRANSCRIPT.slice(0, 800)]
  };
  return reading;
}

function jobFixture(id = HISTORY_JOB, transcript = FULL_TRANSCRIPT, reading = null, readingStatus = reading ? "ready" : "missing") {
  return {
    id, status: "complete", completedChunks: 1, totalChunks: 1, progress: 100,
    transcript, transcriptPreview: transcript.slice(0, 2000), transcriptPath: `jobs/${id || "by-url"}/transcript.txt`,
    reading, readingStatus, readingError: ""
  };
}

function doneEvent(id, transcript, reading, extra = {}) {
  const data = jobFixture(id, transcript, reading);
  jobs.set(id, data);
  return { type: "done", jobId: id, title: "回归测试", ...data, ...extra };
}

const requests = [];
const notifications = [];
const jobs = new Map();
const pendingHistory = [];
const pendingReading = [];
let scenario = "failure";
let historyData = jobFixture();
let holdNextJob = false;
let nextJobStatus = 200;
let readingMode = "success";
let streamControl = null;
let batchControl = null;
let progressControl = null;
let win;
const startupErrors = [];
ipcMain.on("app:notify", (_event, payload) => notifications.push(payload));

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, "http://localhost");
  const pathname = requestUrl.pathname;
  const files = {
    "/": ["public/index.html", "text/html"],
    "/app.js": ["public/app.js", "application/javascript"],
    "/styles.css": ["public/styles.css", "text/css"]
  };
  if (files[pathname]) {
    const [file, type] = files[pathname];
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    return res.end(fs.readFileSync(path.join(root, file)));
  }
  let body = "";
  req.on("data", chunk => { body += chunk; });
  req.on("end", () => {
    const data = body ? JSON.parse(body) : null;
    requests.push({ pathname, body: data, query: Object.fromEntries(requestUrl.searchParams) });
    const json = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const send = event => res.write(JSON.stringify(event) + "\n");
    if (pathname === "/api/playlist-check") {
      return json(200, scenario.startsWith("batch") ? {
        isPlaylist: true, count: 2,
        entries: [
          { title: "测试视频一", url: "https://example.com/1" },
          { title: "测试视频二", url: "https://example.com/2" }
        ]
      } : { isPlaylist: false });
    }
    if (pathname === "/api/transcribe" || pathname === "/api/transcribe-batch") {
      if (scenario === "failure") return json(500, { error: "回归测试：模拟后端失败" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      if (scenario === "progress-held") {
        send({ type: "status", step: "prepare", jobId: LONG_JOB, message: "准备进度测试" });
        progressControl = { send, end: () => res.end() };
        return;
      }
      if (scenario === "batch-count-held") {
        // playlist-check deliberately estimates two; the stream supplies the
        // actual count and titles later, as the production batch endpoint does.
        send({ type: "batch-start", step: "fetching-playlist", message: "正在解析实际合集" });
        batchControl = { send, end: () => res.end() };
        return;
      }
      if (scenario.startsWith("batch")) {
        send({ type: "batch-start", totalVideos: 2, message: "开始测试合集" });
        send({ type: "batch-video-start", videoIndex: 0, jobId: BATCH_JOB_1, message: "开始视频一" });
        send(doneEvent(BATCH_JOB_1, "合集第一份原文", makeReading("合集主题一"), {
          type: "batch-video-done", videoIndex: 0, completedVideos: 1, message: "视频一已完成"
        }));
        batchControl = {
          send,
          failSecond: () => {
            send({ type: "batch-video-error", videoIndex: 1, jobId: BATCH_JOB_2, completedVideos: 1, message: "模拟第二个视频失败" });
            send({ type: "batch-done", completedVideos: 1, totalVideos: 2, message: "不可信的全部成功文案" });
            res.end();
          },
          startSecond: () => send({ type: "batch-video-start", videoIndex: 1, jobId: BATCH_JOB_2, message: "开始视频二" }),
          finish: () => {
            send(doneEvent(BATCH_JOB_2, "合集第二份原文", makeReading("合集主题二"), {
              type: "batch-video-done", videoIndex: 1, completedVideos: 2, message: "视频二已完成"
            }));
            send({ type: "batch-done", completedVideos: 2, totalVideos: 2, message: "测试合集完成" });
            res.end();
          }
        };
        if (scenario === "batch") {
          batchControl.startSecond();
          batchControl.finish();
        }
        return;
      }
      if (scenario === "stream-reading") {
        send({ type: "progress", jobId: LONG_JOB, step: "saved", progress: 100, transcript: FULL_TRANSCRIPT, message: "分段已保存" });
        send({ type: "reading-status", jobId: LONG_JOB, readingStatus: "generating", readingError: "", message: "开始整理主题" });
        streamControl = () => {
          send({ type: "reading-status", jobId: LONG_JOB, readingStatus: "failed", readingError: "模拟主题整理失败", message: "主题整理失败，原文保留" });
          send(doneEvent(LONG_JOB, FULL_TRANSCRIPT, null, { readingStatus: "failed", readingError: "模拟主题整理失败" }));
          res.end();
        };
        return;
      }
      send(scenario === "long" ? doneEvent(LONG_JOB, FULL_TRANSCRIPT, maliciousReading())
        : doneEvent(SINGLE_JOB, "测试文稿", makeReading()));
      return res.end();
    }
    if (pathname === "/api/job") {
      const id = requestUrl.searchParams.get("jobId");
      const status = nextJobStatus;
      nextJobStatus = 200;
      const value = status === 200 ? (id ? jobs.get(id) || historyData : historyData) : { error: "迟到的历史查询错误" };
      if (holdNextJob) {
        holdNextJob = false;
        pendingHistory.push(() => json(status, value));
        return;
      }
      return json(status, value);
    }
    if (pathname === "/api/reading") {
      const jobId = data.jobId || historyData.id || HISTORY_JOB;
      const result = { jobId, reading: makeReading("回到内容的脉络：从主题到原文"), readingStatus: "ready" };
      if (readingMode === "hold") {
        pendingReading.push(() => json(200, result));
        return;
      }
      if (readingMode === "failure") return json(500, { error: `模拟整理服务失败 ${HOSTILE}` });
      return json(200, result);
    }
    if (pathname === "/api/ask") {
      return json(200, { jobId: data.jobId || HISTORY_JOB, answer: "模拟回答：主题帮助阅读，原始文稿始终保留。" });
    }
    if (pathname === "/api/download") {
      const reading = requestUrl.searchParams.get("format") === "reading";
      res.writeHead(200, {
        "Content-Type": reading ? "text/markdown" : "text/plain",
        "Content-Disposition": `attachment; filename="${reading ? "reading.md" : "transcript.txt"}"`
      });
      return res.end(reading ? "# Mock reading\n\n## 目录\n" : FULL_TRANSCRIPT);
    }
    json(404, { error: "Not found" });
  });
});

const timeout = setTimeout(() => {
  console.error("FAIL: frontend test exceeded 90 seconds");
  app.exit(1);
}, 90000);

const js = code => win.webContents.executeJavaScript(code, true);
async function waitFor(expression, label = expression) {
  return js(`(async () => {
    const deadline = Date.now() + 5000;
    while (!(${expression})) {
      if (Date.now() > deadline) throw new Error(${JSON.stringify(`Timed out: ${label}`)});
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  })()`);
}
async function waitUntil(check, label) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}
const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
async function changeUrl(url, event = "input") {
  await js(`(() => {
    const input = document.querySelector('[data-url]');
    input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
}
async function state() {
  return js(`(() => {
    const q = selector => document.querySelector(selector);
    return {
      disabled: q('[data-submit]').disabled, inputDisabled: q('[data-url]').disabled,
      status: q('[data-status]').textContent, kind: q('.status-panel').dataset.statusKind,
      transcript: q('[data-transcript]').value, rawHidden: getComputedStyle(q('[data-transcript]')).display === 'none',
      batchHidden: q('[data-batch-panel]').hidden, jobId: activeJobId,
      readingStatus: q('[data-reading-state]').dataset.state,
      title: q('[data-reading-title]').textContent, readingText: q('[data-reading-document]').textContent,
      readingHidden: getComputedStyle(q('[data-reading-view]')).display === 'none',
      documentHidden: q('[data-reading-document]').hidden,
      message: q('[data-reading-message]').textContent, error: q('[data-reading-error]').textContent,
      generateHidden: q('[data-generate-reading]').hidden, generateDisabled: q('[data-generate-reading]').disabled,
      rawDownloadDisabled: q('[data-download]').disabled, readingDownloadDisabled: q('[data-download-reading]').disabled,
      path: q('[data-transcript-path]').textContent, errors: window.testErrors
    };
  })()`);
}
async function clickSubmit(url = VIDEO_URL) {
  await changeUrl(url);
  await click("[data-submit]");
  await waitFor("!document.querySelector('[data-submit]').disabled", "submit completion");
  return state();
}
async function loadHistory(url = HISTORY_URL, fixture = jobFixture()) {
  historyData = fixture;
  if (fixture.id) jobs.set(fixture.id, fixture);
  await changeUrl(url);
  await click("[data-check-status]");
  await waitFor(`document.querySelector('[data-transcript]').value === ${JSON.stringify(fixture.transcript)}`, "history full transcript");
}
function assertCleared(result) {
  assert.equal(result.transcript, "", "old raw text must be cleared");
  assert.equal(result.title, "", "old reading title must be cleared");
  assert(!result.readingText.includes("对应原文"), "old sections must be removed, not merely hidden");
  assert.equal(result.jobId, "", "old download/QA target must be cleared");
  assert.equal(result.path, "尚未生成");
  assert.equal(result.rawDownloadDisabled, true);
  assert.equal(result.readingDownloadDisabled, true);
  assert.equal(result.documentHidden, true);
}
async function assertDownload(selector, expected) {
  const start = requests.length;
  await click(selector);
  await waitUntil(() => requests.slice(start).some(req => req.pathname === "/api/download"), "download request");
  const request = requests.slice(start).find(req => req.pathname === "/api/download");
  assert.deepEqual(request.query, expected);
}
async function settleResponses() {
  // A same-origin round trip plus a paint lets any previously released response
  // finish in the renderer, without relying on a fixed delay.
  await js(`(async () => {
    await fetch('/styles.css');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`);
}

async function testReading(desktop) {
  const mode = desktop ? "desktop" : "web";
  const pass = label => console.log(`PASS ${mode}: ${label}`);

  scenario = "long";
  let result = await clickSubmit();
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  assert(result.transcript.length > 2000);
  assert.equal(result.readingStatus, "ready");
  assert.equal(result.title, HOSTILE);
  assert.equal(result.rawHidden, true, "global textarea display:block must not override hidden");
  assert.equal(result.readingHidden, false);
  assert.equal(result.readingDownloadDisabled, false);
  const safe = await js(`(() => ({
    htmlNodes: document.querySelector('[data-reading-document]').querySelectorAll('img, script, iframe').length,
    executed: Boolean(window.modelHtmlExecuted),
    anchors: [...document.querySelectorAll('[data-reading-toc] a')].map(a => a.getAttribute('href')),
    text: document.querySelector('[data-reading-sections]').textContent
  }))()`);
  assert.equal(safe.htmlNodes, 0);
  assert.equal(safe.executed, false);
  assert(safe.text.includes(HOSTILE));
  assert.deepEqual(safe.anchors, ["#reading-topic-1", "#reading-topic-2", "#reading-topic-3"]);
  await click('[data-reading-toc] a[href="#reading-topic-2"]');
  await waitFor("document.activeElement.id === 'reading-topic-2'");
  await waitFor("Math.abs(document.querySelector('#reading-topic-2').getBoundingClientRect().top - 30) < 5", "TOC scroll target");
  await js("document.querySelector('[data-reading-toc] a').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
  await waitFor("document.activeElement.id === 'reading-topic-1'", "keyboard TOC activation");
  await click('[data-view="raw"]');
  result = await state();
  assert.equal(result.rawHidden, false);
  assert.equal(result.readingHidden, true);
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  await js("document.querySelector('[data-view=raw]').focus()");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
  await waitFor("document.querySelector('[data-view=reading]').getAttribute('aria-selected') === 'true'", "keyboard tabs");
  await assertDownload("[data-download-reading]", { jobId: LONG_JOB, format: "reading" });
  await assertDownload("[data-download]", { jobId: LONG_JOB });
  pass("done reading, full raw text, safe HTML, keyboard TOC/tabs and separate downloads");

  await changeUrl(HISTORY_URL, "change");
  assertCleared(await state());
  await loadHistory();
  result = await state();
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  assert.equal(result.readingStatus, "missing");
  assert.equal(result.generateHidden, false);
  assert.equal(result.readingDownloadDisabled, true);
  assert.equal(result.rawDownloadDisabled, false);
  const statusBefore = result.status;
  const notifyStart = notifications.length;
  readingMode = "failure";
  await click("[data-generate-reading]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'failed'");
  result = await state();
  assert.match(result.error, /模拟整理服务失败/);
  assert.equal(result.status, statusBefore, "reading errors must not replace transcription status");
  assert.equal(result.kind, "idle");
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  assert.equal(result.generateDisabled, false);
  assert.equal(result.rawDownloadDisabled, false);
  assert.equal(result.readingDownloadDisabled, true);
  assert.equal(await js("document.querySelector('[data-reading-error]').querySelectorAll('img').length"), 0);
  assert(!notifications.slice(notifyStart).some(item => item.title === "转写失败"));
  readingMode = "hold";
  const readingStart = requests.filter(req => req.pathname === "/api/reading").length;
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "held retry");
  result = await state();
  assert.equal(result.generateDisabled, true);
  assert.equal(result.readingStatus, "generating");
  assert.equal(result.disabled, false, "theme generation must not lock transcription submit");
  await click("[data-generate-reading]");
  assert.equal(requests.filter(req => req.pathname === "/api/reading").length, readingStart + 1, "no duplicate generation");
  assert.deepEqual(requests.filter(req => req.pathname === "/api/reading").at(-1).body, { jobId: HISTORY_JOB });
  pendingReading.shift()();
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'");
  assert.equal((await state()).transcript, FULL_TRANSCRIPT);
  await assertDownload("[data-download-reading]", { jobId: HISTORY_JOB, format: "reading" });
  await js("document.querySelector('[data-question]').value = '这期视频的核心观点是什么？'");
  await click("[data-ask]");
  await waitFor("document.querySelector('[data-answer]').textContent.includes('模拟回答')");
  assert.equal(requests.filter(req => req.pathname === "/api/ask").at(-1).body.jobId, HISTORY_JOB);
  pass("history full text, generation failure/retry, button lock, safe error and QA");

  await win.webContents.executeJavaScript("document.querySelector('.transcript-panel').scrollIntoView()");
  await settleResponses();
  fs.writeFileSync(path.join(tempRoot, `frontend-reading-${mode}.png`), (await win.webContents.capturePage()).toPNG());
  const wide = await js(`(() => {
    const panel = document.querySelector('.transcript-panel').getBoundingClientRect();
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    return Math.abs(panel.width - workspace.width) < 2;
  })()`);
  assert(wide, "transcript must span both workspace columns");
  win.setSize(390, 844);
  await settleResponses();
  await js("document.querySelector('.transcript-panel').scrollIntoView()");
  await settleResponses();
  const mobile = await js(`(() => {
    const toc = document.querySelector('.reading-toc').getBoundingClientRect();
    const sections = document.querySelector('.reading-sections').getBoundingClientRect();
    return { stacked: toc.bottom <= sections.top, overflow: document.documentElement.scrollWidth > innerWidth };
  })()`);
  assert.equal(mobile.stacked, true);
  assert.equal(mobile.overflow, false);
  fs.writeFileSync(path.join(tempRoot, `frontend-reading-${mode}-mobile.png`), (await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('.reading-layout').scrollIntoView()");
  await settleResponses();
  fs.writeFileSync(path.join(tempRoot, `frontend-reading-${mode}-mobile-topics.png`), (await win.webContents.capturePage()).toPNG());
  win.setSize(1100, 800);
  await settleResponses();
  pass("full-width reading spread and narrow-screen stacked layout");

  // Exercise URL fallback for both download formats, then generation without an ID.
  historyData = { ...jobFixture(), id: undefined, reading: makeReading(), readingStatus: "ready" };
  await changeUrl("https://example.com/by-url-2");
  await click("[data-check-status]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'");
  await assertDownload("[data-download]", { url: "https://example.com/by-url-2" });
  await assertDownload("[data-download-reading]", { url: "https://example.com/by-url-2", format: "reading" });
  historyData = { ...jobFixture(), id: undefined };
  await changeUrl("https://example.com/by-url-3");
  await click("[data-check-status]");
  await waitFor("!document.querySelector('[data-generate-reading]').hidden");
  readingMode = "success";
  await click("[data-generate-reading]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'");
  assert.deepEqual(requests.filter(req => req.pathname === "/api/reading").at(-1).body, { url: "https://example.com/by-url-3" });
  pass("URL-based original/reading downloads and generation fallback");

  // A slow history request must neither lock submit nor overwrite a new
  // submission to the very same URL (target equality alone is insufficient).
  historyData = jobFixture();
  await changeUrl("https://example.com/same-url");
  holdNextJob = true;
  await click("[data-check-status]");
  await waitUntil(() => pendingHistory.length === 1, "held history");
  assert.equal((await state()).disabled, false);
  scenario = "long";
  await clickSubmit("https://example.com/same-url");
  pendingHistory.shift()();
  await settleResponses();
  result = await state();
  assert.equal(result.jobId, LONG_JOB);
  assert.equal(result.title, HOSTILE);
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  await changeUrl("https://example.com/old-error");
  holdNextJob = true;
  nextJobStatus = 500;
  await click("[data-check-status]");
  await waitUntil(() => pendingHistory.length === 1, "held history error");
  await changeUrl("https://example.com/new-empty");
  pendingHistory.shift()();
  await settleResponses();
  result = await state();
  assertCleared(result);
  assert(!result.status.includes("迟到"));
  pass("late history success/error ignored; slow history never blocks submission");

  await loadHistory();
  readingMode = "hold";
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "old generation");
  scenario = "success";
  await click("[data-submit]");
  // The click begins an asynchronous playlist check; reset is synchronous.
  await waitFor("!document.querySelector('[data-submit]').disabled");
  pendingReading.shift()();
  await settleResponses();
  result = await state();
  assert.equal(result.jobId, SINGLE_JOB);
  assert.equal(result.transcript, "测试文稿");
  assert.equal(result.title, makeReading().title);
  await assertDownload("[data-download-reading]", { jobId: SINGLE_JOB, format: "reading" });

  await loadHistory("https://example.com/old-generation");
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "generation before URL change");
  await changeUrl("https://example.com/new-generation-target");
  assertCleared(await state());
  pendingReading.shift()();
  await settleResponses();
  assertCleared(await state());
  pass("late generation cannot resurrect a previous submit or changed URL");

  // Capture the reset in the same renderer turn as a failed new submission.
  await loadHistory("https://example.com/reset", jobFixture(HISTORY_JOB, FULL_TRANSCRIPT, makeReading()));
  scenario = "failure";
  const clearedAtSubmit = await js(`(() => {
    document.querySelector('[data-submit]').click();
    return {
      raw: document.querySelector('[data-transcript]').value,
      title: document.querySelector('[data-reading-title]').textContent,
      jobId: activeJobId,
      rawDisabled: document.querySelector('[data-download]').disabled,
      readingDisabled: document.querySelector('[data-download-reading]').disabled
    };
  })()`);
  assert.deepEqual(clearedAtSubmit, { raw: "", title: "", jobId: "", rawDisabled: true, readingDisabled: true });
  await waitFor("!document.querySelector('[data-submit]').disabled");
  assertCleared(await state());
  pass("new submission synchronously clears all previous content and download state");

  scenario = "stream-reading";
  await changeUrl(VIDEO_URL);
  await click("[data-submit]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'generating'");
  result = await state();
  assert.match(result.message, /正在整理/);
  assert.equal(result.kind, "running");
  assert.equal(result.transcript, FULL_TRANSCRIPT);
  assert.equal(result.readingDownloadDisabled, true);
  await click('[data-view="raw"]');
  assert.equal((await state()).rawHidden, false);
  streamControl();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  result = await state();
  assert.equal(result.readingStatus, "failed");
  assert.equal(result.kind, "success", "reading-status failure is not transcription failure");
  assert.equal(result.rawHidden, true, "done must select theme reading");
  assert.equal(result.rawDownloadDisabled, false);
  assert.equal(result.generateDisabled, false);
  readingMode = "success";
  await click("[data-generate-reading]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'");
  pass("streamed generating/failure state remains separate from successful transcription");

  scenario = "batch-held";
  await changeUrl("https://example.com/playlist");
  await click("[data-submit]");
  await waitFor(`activeJobId === '${BATCH_JOB_1}' && document.querySelector('[data-reading-state]').dataset.state === 'ready'`);
  result = await state();
  assert.equal(result.transcript, "合集第一份原文");
  assert.equal(result.title, "合集主题一");
  batchControl.startSecond();
  await waitFor("document.querySelector('[data-status]').textContent === '开始视频二'");
  assertCleared(await state());
  batchControl.finish();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  result = await state();
  assert.equal(result.jobId, BATCH_JOB_2);
  assert.equal(result.transcript, "合集第二份原文");
  assert.equal(result.title, "合集主题二");
  assert.equal(await js("document.querySelectorAll('.batch-video-item[data-state=done]').length"), 2);
  await assertDownload("[data-download-reading]", { jobId: BATCH_JOB_2, format: "reading" });
  assert.deepEqual(result.errors, []);
  pass("batch-video-done reading and next-video reset, correct batch download target");
}

// Progress timers use a deterministic clock inside the real renderer. Fetch,
// animation frames and the test runner retain their real clocks.
async function installProgressClock() {
  await changeUrl("https://example.com/progress-clock-reset");
  await js(`(() => {
    window.realProgressClock = { ...progressClock };
    let now = 0, id = 0;
    const tasks = new Map();
    const schedule = (fn, delay, repeat) => {
      const key = ++id;
      tasks.set(key, { fn, at: now + delay, repeat });
      return key;
    };
    Object.assign(progressClock, {
      now: () => now,
      setInterval: (fn, delay) => schedule(fn, delay, delay),
      clearInterval: key => tasks.delete(key),
      setTimeout: (fn, delay) => schedule(fn, delay, 0),
      clearTimeout: key => tasks.delete(key)
    });
    window.testProgressClock = {
      size: () => tasks.size,
      advance(ms) {
        const end = now + ms;
        let iterations = 0;
        while (true) {
          const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > end) break;
          if (++iterations > 50000) throw new Error('Timer loop');
          const [key, task] = next;
          now = task.at;
          if (task.repeat) task.at += task.repeat;
          else tasks.delete(key);
          task.fn();
        }
        now = end;
      }
    };
  })()`);
}
const advanceProgress = ms => js(`testProgressClock.advance(${ms})`);
async function meters() {
  return js(`(() => {
    const q = selector => document.querySelector(selector);
    return {
      main: overallProgress.get(), reading: readingProgress.get(), timers: testProgressClock.size(),
      value: Number(q('[data-progress-percent]').textContent), label: q('[data-progress-label]').textContent,
      detail: q('[data-progress-detail]').textContent, note: q('[data-progress-note]').textContent,
      elapsed: q('[data-progress-elapsed]').textContent,
      aria: q('[data-progress]').parentElement.getAttribute('aria-valuenow'),
      readingValue: Number(q('[data-reading-percent]').textContent),
      batch: Number(q('[data-batch-percent]').textContent), batchSummary: q('[data-batch-summary]').textContent,
      batchAria: q('[data-batch-progress]').parentElement.getAttribute('aria-valuenow'),
      pollPending: readingPollController !== null, pending: pendingReadingRequest
    };
  })()`);
}
async function testPercentProgress(desktop) {
  const mode = desktop ? "desktop" : "web";
  const pass = label => console.log(`PASS ${mode} progress: ${label}`);
  await installProgressClock();
  let sequence = 0;
  async function begin() {
    scenario = "progress-held";
    progressControl = null;
    await changeUrl(`https://example.com/progress-${mode}-${++sequence}`);
    await click("[data-submit]");
    await waitUntil(() => Boolean(progressControl), "controlled progress stream");
    await waitFor(`activeJobId === '${LONG_JOB}'`);
  }
  async function send(event) {
    progressControl.send({ jobId: LONG_JOB, ...event });
    await settleResponses();
  }
  async function stage(stage, percent, extra = {}) {
    await send({ type: "stage-progress", stage, percent, ...extra });
  }

  await begin();
  await advanceProgress(15000);
  let result = await meters();
  assert.equal(result.value, 0, "prepare estimate starts slowly rather than inventing completed work");
  assert.match(result.label, /总进度 · 估算/);
  assert.match(result.note, /仍在等待处理结果.*不代表故障/);
  assert.equal(result.elapsed, "已等待 00:15");
  await advanceProgress(180000);
  assert.equal((await meters()).value, 2, "preparation never automatically crosses into download");
  pass("long waits keep timing, label estimates and remain in the current stage");

  await begin();
  const logBeforeStages = await js("document.querySelector('[data-log]').textContent");
  await stage("download", 50, { scope: "file" });
  const samples = await js(`(() => {
    const values = [Number(document.querySelector('[data-progress-percent]').textContent)];
    for (let i = 0; i < 15; i++) {
      testProgressClock.advance(120);
      values.push(Number(document.querySelector('[data-progress-percent]').textContent));
    }
    return values;
  })()`);
  assert.equal(samples.at(-1), 11, "download 50% is weighted to 11%, not overall 50%");
  assert(samples.every((value, i) => Number.isInteger(value) && (!i || value - samples[i - 1] === 0 || value - samples[i - 1] === 1)));
  assert(samples.includes(1) && samples.includes(10), "natural progress renders every integer");
  result = await meters();
  assert.match(result.detail, /当前媒体流 · 实际 50%/);
  assert.equal(result.aria, "11");
  await stage("download", 100, { scope: "file" });
  await advanceProgress(2400);
  assert.equal((await meters()).value, 19, "file completion cannot cross the download stage boundary");
  await stage("download", 0, { scope: "file" });
  await advanceProgress(12000);
  result = await meters();
  assert.equal(result.value, 19);
  assert.match(result.detail, /实际 0%/);
  await send({ type: "status", step: "download", progress: 100 });
  assert.equal((await meters()).main.percent, 0, "new stage values outrank legacy progress");
  assert.equal(await js("document.querySelector('[data-log]').textContent"), logBeforeStages, "stage events do not spam logs");
  for (let percent = 1; percent <= 20; percent++) progressControl.send({
    type: "status", step: "download", progress: percent, message: `连续旧版进度 ${percent}%`, jobId: LONG_JOB
  });
  await settleResponses();
  assert.equal(await js("[...document.querySelector('[data-log]').children].filter(item => item.textContent.includes('连续旧版进度')).length"), 1, "legacy percentage messages are throttled rather than flooding the log");
  assert.equal((await meters()).main.percent, 0);
  pass("1-point integer updates, real stage values/ARIA, download stream reset and legacy precedence");

  await stage("normalize", 50);
  await advanceProgress(2400);
  assert.equal((await meters()).value, 24);
  await stage("split", 100);
  await advanceProgress(2400);
  assert.equal((await meters()).value, 31);
  await stage("transcribe", 20, { completed: 2, total: 10 });
  await advanceProgress(120);
  assert.equal((await meters()).main.target, 43, "real chunk count is weighted within transcription");
  await advanceProgress(600000);
  result = await meters();
  assert.equal(result.value, 48, "AI estimates stop at completed + 0.9 of ONE chunk");
  assert.match(result.detail, /实际已完成 2\/10 段/);
  assert.match(result.note, /不会跨越当前阶段或批次/);
  await send({ type: "progress", step: "saved", progress: 100 });
  await stage("download", 100);
  await stage("transcribe", 10, { completed: 1, total: 10 });
  await advanceProgress(12000);
  assert.equal((await meters()).value, 48, "legacy 100 and stale counts/stages cannot advance or rewind the active chunk");
  assert.equal((await meters()).main.completed, 2);
  pass("weighted normalization/splitting and bounded AI estimates using real completed counts");

  await stage("reading", 25, { completed: 1, total: 4 });
  await advanceProgress(600000);
  result = await meters();
  assert.equal(result.value, 94);
  assert.equal(result.readingValue, 47, "automatic reading gets an independent, batch-bounded meter");
  assert.equal(result.reading.completed, 1);
  assert.equal((await state()).readingStatus, "generating");
  const stoppedValue = result.value;
  const stoppedReading = result.readingValue;
  await send({ type: "error", error: "模拟进度处理中断" });
  progressControl.end();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  result = await meters();
  const stoppedElapsed = result.main.elapsed;
  await advanceProgress(600000);
  result = await meters();
  assert.equal(result.value, stoppedValue);
  assert.equal(result.readingValue, stoppedReading);
  assert.equal(result.main.elapsed, stoppedElapsed);
  assert.equal(result.timers, 0);
  assert.equal((await state()).kind, "error");
  pass("automatic reading sync and failure freezes all estimates, queued points and elapsed clocks");

  await begin();
  await send({ type: "progress", step: "saved", progress: 100, transcript: FULL_TRANSCRIPT });
  await advanceProgress(15000);
  assert.equal((await meters()).value, 89, "legacy chunk 100 is never overall completion");
  progressControl.end();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  assert.equal((await meters()).value, 89);
  assert.equal((await meters()).timers, 0);
  assert.match((await state()).status, /尚未收到完成确认/);
  await begin();
  await send(doneEvent(LONG_JOB, FULL_TRANSCRIPT, null, { readingStatus: "failed", readingError: "主题需重试" }));
  progressControl.end();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  result = await meters();
  assert.equal(result.value, 100, "cached terminal results need no forced 100-step animation");
  assert.equal(result.timers, 0);
  assert.match(result.label, /已完成/);
  assert.match((await state()).status, /转写完成 · 主题整理待重试/);
  assert.equal((await state()).rawDownloadDisabled, false);
  await advanceProgress(600000);
  assert.equal((await meters()).main.elapsed, result.main.elapsed);
  pass("legacy-only fallback, incomplete stream detection and fast terminal completion without false reading success");

  const manualFixture = { ...jobFixture(), readingProgress: { percent: 25, completed: 1, total: 4 } };
  await loadHistory(`https://example.com/manual-progress-${mode}`, manualFixture);
  readingMode = "hold";
  const beforePolls = requests.filter(req => req.pathname === "/api/job").length;
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "manual reading POST pending");
  await click('[data-view="raw"]');
  await advanceProgress(1499);
  assert.equal(requests.filter(req => req.pathname === "/api/job").length, beforePolls);
  await advanceProgress(1);
  await waitFor("readingProgress.get().completed === 1", "first reading progress poll");
  assert.equal(requests.filter(req => req.pathname === "/api/job").length, beforePolls + 1);
  holdNextJob = true;
  await advanceProgress(1500);
  await waitUntil(() => pendingHistory.length === 1, "held polling request");
  const heldCount = requests.filter(req => req.pathname === "/api/job").length;
  await advanceProgress(9000);
  assert.equal(requests.filter(req => req.pathname === "/api/job").length, heldCount, "slow polls never overlap");
  assert.equal((await meters()).value, 100, "manual reading never drives the top meter");
  assert.equal((await state()).rawHidden, false, "polling must not switch transcript views");
  assert.equal((await state()).transcript, FULL_TRANSCRIPT);
  jobs.set(HISTORY_JOB, { ...manualFixture, transcript: "不应覆盖的轮询文稿", readingProgress: { percent: 50, completed: 2, total: 4 } });
  pendingHistory.shift()();
  await waitFor("readingPollController === null");
  await advanceProgress(1499);
  assert.equal(requests.filter(req => req.pathname === "/api/job").length, heldCount);
  await advanceProgress(1);
  await waitFor("readingProgress.get().completed === 2", "latest readingProgress");
  assert.equal((await state()).transcript, FULL_TRANSCRIPT, "poll only consumes readingProgress, not the job document");
  pendingReading.shift()();
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'");
  result = await meters();
  assert.equal(result.readingValue, 100);
  assert.equal(result.timers, 0);
  const terminalRequests = requests.length;
  await advanceProgress(600000);
  assert.equal(requests.length, terminalRequests);
  pass("manual GET progress at <=1/1.5s, non-overlap, latest counts, independent top meter and no document/view overwrite");

  await loadHistory(`https://example.com/manual-stale-${mode}`, manualFixture);
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "stale reading POST");
  holdNextJob = true;
  await advanceProgress(1500);
  await waitUntil(() => pendingHistory.length === 1, "stale reading poll");
  await changeUrl(`https://example.com/manual-new-${mode}`);
  pendingHistory.shift()();
  pendingReading.shift()();
  await settleResponses();
  await advanceProgress(600000);
  assertCleared(await state());
  result = await meters();
  assert.equal(result.value, 0);
  assert.equal(result.readingValue, 0);
  assert.equal(result.timers, 0);
  assert.equal(result.pending, 0);
  assert.equal(result.pollPending, false);

  await loadHistory(`https://example.com/manual-resubmit-${mode}`, manualFixture);
  await click("[data-generate-reading]");
  await waitUntil(() => pendingReading.length === 1, "manual generation before same-URL submit");
  scenario = "progress-held";
  progressControl = null;
  await click("[data-submit]");
  await waitUntil(() => Boolean(progressControl), "new same-URL stream");
  await waitFor(`activeJobId === '${LONG_JOB}'`);
  pendingReading.shift()();
  await settleResponses();
  await advanceProgress(600000);
  assert.equal((await meters()).value, 2);
  assert.equal((await meters()).readingValue, 0);
  assert.equal((await state()).readingStatus, "missing");
  const oldStream = progressControl;
  await begin(); // URL change must abort the previous stream, not unlock this new request.
  oldStream.send({ type: "stage-progress", stage: "reading", percent: 100, jobId: LONG_JOB });
  oldStream.end();
  await settleResponses();
  assert.equal((await meters()).value, 0);
  assert.equal((await state()).disabled, true);
  await send(doneEvent(LONG_JOB, FULL_TRANSCRIPT, makeReading()));
  progressControl.end();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  pass("URL changes and same-URL resubmission cancel old polling/timers and reject stale stream/POST callbacks");

  await loadHistory(`https://example.com/manual-failed-${mode}`, manualFixture);
  readingMode = "failure";
  const transcriptionStatus = (await state()).status;
  await click("[data-generate-reading]");
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'failed'");
  const failedReading = await meters();
  await advanceProgress(600000);
  result = await meters();
  assert.equal(result.value, 100);
  assert.equal(result.readingValue, failedReading.readingValue);
  assert.equal(result.reading.elapsed, failedReading.reading.elapsed);
  assert.equal(result.timers, 0);
  assert.equal((await state()).status, transcriptionStatus);
  pass("manual reading failure stops polling and time without failing or advancing transcription");

  scenario = "batch-held";
  await changeUrl(`https://example.com/batch-progress-${mode}`);
  await click("[data-submit]");
  await waitFor(`activeJobId === '${BATCH_JOB_1}'`);
  await advanceProgress(6000);
  assert.equal((await meters()).batch, 50);
  batchControl.startSecond();
  await waitFor("document.querySelector('[data-status]').textContent === '开始视频二'");
  assert.equal((await meters()).readingValue, 0);
  batchControl.send({ type: "stage-progress", stage: "transcribe", percent: 50, jobId: BATCH_JOB_2, batchVideoIndex: 1, batchTotalVideos: 2 });
  await waitFor("overallProgress.get().percent === 50");
  await advanceProgress(12000);
  result = await meters();
  assert.equal(result.value, 61);
  assert.equal(result.batch, 80, "batch includes the fraction of the current video");
  assert.equal(result.batchAria, "80");
  batchControl.send({ type: "stage-progress", stage: "reading", percent: 100, jobId: BATCH_JOB_1, batchVideoIndex: 0 });
  await settleResponses();
  assert.equal((await meters()).main.label, "逐段转写");
  batchControl.failSecond();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  result = await meters();
  assert.equal(result.value, 61, "a failed final video must never become 100%");
  assert.equal(result.batch, 100, "failed entries still count as processed");
  assert.match(result.batchSummary, /2\/2 个已处理 · 1 个失败/);
  assert.match((await state()).status, /1 个视频失败/);
  assert.equal((await state()).kind, "error");
  assert.equal(result.timers, 0);
  pass("batch percentage includes active video, clears reading, ignores stale indices and explicitly counts failures");

  await begin();
  await stage("transcribe", null, { estimated: true });
  await advanceProgress(600000);
  assert.equal((await meters()).value, 32, "unknown AI denominator waits instead of inventing completed chunks");
  await stage("reading", 25, { completed: 1, total: 4 });
  await advanceProgress(600000);
  await js("window.scrollTo(0, 0)");
  win.setSize(1100, 900);
  await settleResponses();
  fs.writeFileSync(path.join(tempRoot, `percent-progress-${mode}.png`), (await win.webContents.capturePage()).toPNG());
  await js("document.querySelector('[data-reading-progress-panel]').scrollIntoView({block:'center'})");
  await settleResponses();
  fs.writeFileSync(path.join(tempRoot, `percent-progress-${mode}-reading.png`), (await win.webContents.capturePage()).toPNG());
  win.webContents.debugger.attach("1.3");
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const width of [390, 320]) {
    win.setSize(width, 844);
    await settleResponses();
    await js("document.querySelector('.status-panel').scrollIntoView({block:'start'})");
    await settleResponses();
    const layout = await js(`(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animation: getComputedStyle(document.querySelector('.status-dot')).animationName,
      transition: getComputedStyle(document.querySelector('[data-progress]')).transitionDuration,
      readingOverflow: document.querySelector('[data-reading-progress-panel]').scrollWidth > document.querySelector('[data-reading-progress-panel]').clientWidth
    }))()`);
    assert.equal(layout.overflow, false);
    assert.equal(layout.readingOverflow, false);
    assert.equal(layout.reduced, true);
    assert.equal(layout.animation, "none");
    assert.equal(layout.transition, "0s");
    fs.writeFileSync(path.join(tempRoot, `percent-progress-${mode}-${width}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { features: [] });
  win.webContents.debugger.detach();
  win.setSize(1100, 800);
  const finalStream = progressControl;
  await changeUrl(`https://example.com/final-progress-cleanup-${mode}`);
  finalStream.end();
  await advanceProgress(600000);
  assert.equal((await meters()).timers, 0);
  assert.equal((await meters()).batch, 0);
  assert.equal((await meters()).value, 0);
  await js("void Object.assign(progressClock, window.realProgressClock)");
  pass("source Electron screenshots, 320/390px no overflow, reduced motion and final timer cleanup");
}

async function testReviewRegressions(desktop) {
  const mode = desktop ? "desktop" : "web";
  let groups = 0;
  const pass = label => { groups += 1; console.log(`PASS ${mode} review: ${label}`); };
  const jobRequests = () => requests.filter(req => req.pathname === "/api/job");
  const readingRequests = () => requests.filter(req => req.pathname === "/api/reading");
  const generatingFixture = () => ({
    ...jobFixture(HISTORY_JOB, FULL_TRANSCRIPT, null, "generating"),
    readingProgress: { percent: 25, completed: 1, total: 4 }
  });
  await installProgressClock();

  async function beginStream(url) {
    scenario = "progress-held";
    progressControl = null;
    if (url) await changeUrl(url);
    await click("[data-submit]");
    await waitUntil(() => Boolean(progressControl), "review controlled stream");
    await waitFor(`activeJobId === '${LONG_JOB}'`);
  }
  async function send(event) {
    progressControl.send({ jobId: LONG_JOB, ...event });
    await settleResponses();
  }
  async function assertStoppedNoPolling(label) {
    const frozen = await meters();
    assert.equal(frozen.main.running, false, `${label}: overall clock stops`);
    assert.equal(frozen.reading.running, false, `${label}: reading clock stops`);
    assert.equal(frozen.timers, 0, `${label}: no queued timers`);
    assert.equal(frozen.pending, 0, `${label}: release the reading request token`);
    assert.equal(frozen.pollPending, false, `${label}: no GET remains active`);
    const count = requests.length;
    await advanceProgress(600000);
    await settleResponses();
    assert.equal(requests.length, count, `${label}: no more polling after termination`);
    assert.deepEqual(await meters(), frozen, `${label}: percentages and elapsed time stay frozen`);
  }

  await beginStream(`https://example.com/review-media-resume-${mode}`);
  for (const extra of [
    { message: "Found incomplete normalized video, rebuilding it." },
    { message: "Found incomplete source video, downloading it again." },
    { totalChunks: 4 },
    { totalChunks: 0, completedChunks: 0 },
    { totalChunks: -1, completedChunks: 1 },
    { totalChunks: 4, completedChunks: null },
    { totalChunks: 4, completedChunks: "1" }
  ]) {
    await send({ type: "status", step: "resume", ...extra });
    assert.equal((await meters()).main.stage, 0, "resume without chunk percent or valid counts must not invent transcription progress");
  }
  for (const [stage, index, message] of [
    ["download", 1, "Found existing source video, skipping download."],
    ["normalize", 2, "Found existing normalized video, skipping download."],
    ["split", 3, "Found 4 complete video chunk(s), skipping split."]
  ]) {
    await send({ type: "stage-progress", stage, percent: 40 });
    await send({ type: "status", step: "resume", message });
    assert.equal((await meters()).main.stage, index, `media resume stays in ${stage}`);
    await send({ type: "stage-progress", stage, percent: 60 });
    assert.equal((await meters()).main.percent, 60, `real ${stage} progress is still accepted after resume`);
  }
  // Actual legacy chunk-skip events carry progress but no completed/total pair
  // (server.js handleTranscribe/handleBatchTranscribe). Keep that fallback.
  await send({ type: "status", step: "resume", progress: 25 });
  assert.equal((await meters()).main.stage, 4);
  assert.equal((await meters()).main.percent, 25);
  await send({ type: "status", step: "resume", totalChunks: 4, completedChunks: 1, progress: 25 });
  await advanceProgress(600000);
  let result = await meters();
  assert.equal(result.main.stage, 4, "counted resume still supports legacy transcription recovery");
  assert.equal(result.main.completed, 1);
  assert.equal(result.main.total, 4);
  assert.equal(result.value, 59, "a counted resume estimates at most 0.9 of the next chunk");
  await send({ type: "error", error: "结束媒体恢复测试" });
  progressControl.end();
  await waitFor("!document.querySelector('[data-submit]').disabled");
  await assertStoppedNoPolling("media resume cleanup");
  pass("media/invalid-count resume never advances stages; real media events and counted transcription resume still work");

  for (const withProgress of [true, false]) {
    const fixture = generatingFixture();
    if (!withProgress) delete fixture.readingProgress;
    await loadHistory(`https://example.com/review-history-snapshot-${mode}-${withProgress}`, fixture);
    result = await meters();
    assert.equal((await state()).readingStatus, "generating");
    assert.equal(result.main.label, "主题整理", "complete transcription with generating reading belongs to the reading stage");
    assert(result.value < 100, "history status:complete must not claim overall completion while reading is generating");
    assert.notEqual(result.main.outcome, "done");
    assert.equal(result.reading.running, true);
    assert.equal((await state()).rawDownloadDisabled, false);
    await changeUrl(`https://example.com/review-snapshot-cleared-${mode}-${withProgress}`);
    await assertStoppedNoPolling("generating snapshot cancellation");
  }
  pass("complete/generating history stays below 100 in the reading stage, with or without readingProgress");

  const fixture = generatingFixture();
  const postsBeforeHistory = readingRequests().length;
  await loadHistory(`https://example.com/review-history-ready-${mode}`, fixture);
  const initialPath = (await state()).path;
  const historyToken = (await meters()).pending;
  assert(historyToken > 0, "historical generation owns the existing pending-reading token without starting another POST");
  await click('[data-view="raw"]');
  const pollsBefore = jobRequests().length;
  jobs.set(HISTORY_JOB, { ...fixture, transcript: "轮询文稿不应覆盖原始逐字稿", transcriptPath: "wrong/poll.txt",
    readingProgress: { percent: 50, completed: 2, total: 4 } });
  await advanceProgress(1499);
  assert.equal(jobRequests().length, pollsBefore, "historical GET waits for the same 1.5-second cadence");
  await advanceProgress(1);
  await waitFor("readingProgress.get().completed === 2 && readingPollController === null", "historical progress advances automatically");
  assert.equal(jobRequests().length, pollsBefore + 1);
  assert.deepEqual(jobRequests().at(-1).query, { jobId: HISTORY_JOB });
  assert.equal((await meters()).pending, historyToken, "follow-up GETs retain the same request token");
  assert.equal((await state()).transcript, FULL_TRANSCRIPT);
  assert.equal((await state()).path, initialPath);
  assert.equal((await state()).rawHidden, false);
  jobs.set(HISTORY_JOB, { ...fixture, readingProgress: { percent: 75, completed: 3, total: 4 } });
  holdNextJob = true;
  await advanceProgress(1500);
  await waitUntil(() => pendingHistory.length === 1, "held historical follow-up GET");
  const heldCount = jobRequests().length;
  await advanceProgress(9000);
  await settleResponses();
  assert.equal(jobRequests().length, heldCount, "historical GETs never overlap a slow response");
  assert((await meters()).value < 100);
  pendingHistory.shift()();
  await waitFor("readingProgress.get().completed === 3 && readingPollController === null", "released historical progress");
  const finalReading = makeReading("历史任务自动整理完成");
  jobs.set(HISTORY_JOB, { ...jobFixture(HISTORY_JOB, "终态也不能覆盖原文", finalReading), transcriptPath: "wrong/terminal.txt" });
  await advanceProgress(1499);
  assert.equal(jobRequests().length, heldCount, "next GET waits 1.5 seconds after the previous response, not request start");
  await advanceProgress(1);
  await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'", "historical ready result is consumed without another click");
  result = await meters();
  assert.equal(result.value, 100);
  assert.equal(result.readingValue, 100);
  const ready = await state();
  assert.equal(ready.title, finalReading.title);
  assert(ready.readingText.includes(finalReading.sections[0].paragraphs[0]));
  assert.equal(ready.documentHidden, false);
  assert.equal(ready.transcript, FULL_TRANSCRIPT);
  assert.equal(ready.path, initialPath);
  assert.equal(ready.jobId, HISTORY_JOB);
  assert.equal(ready.rawHidden, false, "ready GET must preserve the user's raw tab selection");
  assert.equal(ready.readingHidden, true);
  assert.equal(ready.readingDownloadDisabled, false);
  assert.equal(readingRequests().length, postsBeforeHistory, "observing historical generation must not duplicate model work");
  await assertStoppedNoPolling("historical ready");
  pass("historical GET follows latest counts and ready, preserves raw/tab, avoids overlap and stops every timer");

  for (const terminal of ["failed", "missing", "http-error"]) {
    const failedFixture = generatingFixture();
    await loadHistory(`https://example.com/review-history-${terminal}-${mode}`, failedFixture);
    await click('[data-view="raw"]');
    await advanceProgress(1200);
    if (terminal === "http-error") nextJobStatus = 503;
    else jobs.set(HISTORY_JOB, { ...failedFixture, transcript: "失败终态不能覆盖原文", readingStatus: terminal,
      readingError: terminal === "failed" ? "历史主题整理失败，可重试" : "" });
    await advanceProgress(300);
    await waitFor("pendingReadingRequest === 0 && !readingProgress.get().running", `historical ${terminal} stops following`);
    result = await meters();
    assert(result.value < 100, `${terminal} cannot finish overall progress`);
    assert(result.readingValue < 100, `${terminal} cannot finish reading progress`);
    const failed = await state();
    if (terminal !== "http-error") assert.equal(failed.readingStatus, terminal);
    assert.equal(failed.transcript, FULL_TRANSCRIPT);
    assert.equal(failed.rawHidden, false);
    assert.equal(failed.rawDownloadDisabled, false);
    assert.equal(failed.readingDownloadDisabled, true);
    assert.equal(failed.generateHidden, false);
    assert.equal(failed.generateDisabled, false, `${terminal} must leave retry available`);
    await assertStoppedNoPolling(`historical ${terminal}`);
    readingMode = "hold";
    const beforeRetry = readingRequests().length;
    await click("[data-generate-reading]");
    await waitUntil(() => pendingReading.length === 1, `retry after historical ${terminal}`);
    assert.equal(readingRequests().length, beforeRetry + 1);
    assert.deepEqual(readingRequests().at(-1).body, { jobId: HISTORY_JOB });
    assert.equal((await state()).readingStatus, "generating");
    pendingReading.shift()();
    await waitFor("document.querySelector('[data-reading-state]').dataset.state === 'ready'", `retry recovers ${terminal}`);
    assert.equal((await state()).transcript, FULL_TRANSCRIPT);
    assert.equal((await meters()).readingValue, 100);
    await assertStoppedNoPolling(`historical ${terminal} retry`);
    pass(`historical ${terminal} freezes sub-100 progress/time, releases polling and allows a successful retry`);
  }

  for (const status of [200, 503]) {
    await loadHistory(`https://example.com/review-old-url-${mode}-${status}`, generatingFixture());
    jobs.set(HISTORY_JOB, jobFixture(HISTORY_JOB, "迟到的历史逐字稿", makeReading("迟到的历史主题")));
    holdNextJob = true;
    nextJobStatus = status;
    await advanceProgress(1500);
    await waitUntil(() => pendingHistory.length === 1, "historical GET pending before URL change");
    await changeUrl(`https://example.com/review-new-url-${mode}-${status}`);
    assertCleared(await state());
    pendingHistory.shift()();
    await settleResponses();
    assertCleared(await state());
    assert.equal((await meters()).value, 0);
    assert.equal((await meters()).readingValue, 0);
    assert(!(await state()).status.includes("迟到"));
    await assertStoppedNoPolling(`stale historical ${status} after URL change`);
  }
  pass("URL changes isolate late historical GET success/error and cancel old reading tokens, timers and content");

  for (const status of [200, 503]) {
    await loadHistory(`https://example.com/review-resubmit-${mode}-${status}`, generatingFixture());
    jobs.set(HISTORY_JOB, jobFixture(HISTORY_JOB, "旧请求原文", makeReading("旧请求主题")));
    holdNextJob = true;
    nextJobStatus = status;
    await advanceProgress(1500);
    await waitUntil(() => pendingHistory.length === 1, "historical GET pending before same-URL submit");
    await beginStream(); // Do not change the URL: token/version isolation is required.
    pendingHistory.shift()();
    await settleResponses();
    await advanceProgress(12000);
    result = await meters();
    assert.equal(result.main.stage, 0);
    assert.equal(result.main.running, true, "old GET must not stop the new submission's clock");
    assert(result.value < 3);
    assert.equal(result.readingValue, 0);
    assert.equal(result.pending, 0);
    assert.equal(result.pollPending, false);
    const current = await state();
    assert.equal(current.disabled, true, "old GET must not unlock the new submission");
    assert.equal(current.jobId, LONG_JOB);
    assert.equal(current.transcript, "");
    assert.equal(current.title, "");
    assert.equal(current.readingStatus, "missing");
    const newReading = makeReading("重新提交的新主题");
    await send(doneEvent(LONG_JOB, FULL_TRANSCRIPT, newReading));
    progressControl.end();
    await waitFor("!document.querySelector('[data-submit]').disabled");
    await settleResponses();
    assert.equal((await state()).title, newReading.title);
    await assertStoppedNoPolling(`stale historical ${status} after same-URL submit`);
  }
  pass("same-URL resubmission rejects old historical GET success/error without stopping or overwriting the new task");

  const batchState = () => js(`(() => ({
    total: batchTotalVideos,
    videos: batchVideos.map(video => ({ index: video.index, title: video.title, url: video.url, state: video.state })),
    items: [...document.querySelectorAll('.batch-video-item')].map(item => ({
      index: Number(item.dataset.index), state: item.dataset.state,
      title: item.querySelector('.bv-title').textContent, tooltip: item.querySelector('.bv-title').title
    }))
  }))()`);
  for (const actualTotal of [3, 1]) {
    scenario = "batch-count-held";
    batchControl = null;
    await changeUrl(`https://example.com/review-batch-count-${mode}-${actualTotal}`);
    await click("[data-submit]");
    await waitUntil(() => Boolean(batchControl), "batch awaits actual server count");
    await waitFor("document.querySelector('[data-status]').textContent === '正在解析实际合集'");
    assert.equal((await batchState()).items.length, 2, "playlist-check supplies only the initial estimate");
    batchControl.send({ type: "batch-info", totalVideos: actualTotal, message: `实际找到 ${actualTotal} 个视频` });
    await settleResponses();
    let batch = await batchState();
    assert.equal(batch.total, actualTotal, "batch-info overrides the playlist-check estimate");
    assert.equal(batch.items.length, actualTotal, "actual count rebuilds/shortens waiting placeholders");
    assert.equal(batch.videos.length, actualTotal);
    assert(batch.items.every((item, index) => item.index === index && item.state === "waiting" && item.title));
    assert.equal((await meters()).batch, 0);
    assert.match((await meters()).batchSummary, new RegExp(`0/${actualTotal} 个`));
    let failures = 0;
    for (let index = 0; index < actualTotal; index++) {
      const id = [BATCH_JOB_1, BATCH_JOB_2, BATCH_JOB_3][index];
      const title = `服务端实际视频 ${actualTotal}-${index + 1}`;
      const url = `https://example.com/actual-${actualTotal}-${index + 1}`;
      batchControl.send({ type: "batch-video-start", videoIndex: index, totalVideos: actualTotal,
        jobId: id, videoTitle: title, videoUrl: url, message: `处理 ${title}` });
      await settleResponses();
      batch = await batchState();
      assert.deepEqual(batch.items[index], { index, state: "processing", title, tooltip: title }, "server title replaces placeholder/old preview title in both visible text and tooltip");
      assert.deepEqual(batch.videos[index], { index, state: "processing", title, url }, "server URL/title replace preview metadata, including newly added entries");
      batchControl.send({ type: "stage-progress", stage: "transcribe", percent: 50, jobId: id,
        batchVideoIndex: index, batchTotalVideos: actualTotal });
      await settleResponses();
      await advanceProgress(12000);
      result = await meters();
      assert.equal(result.value, 61);
      assert.equal(result.batch, Math.floor((index + 0.61) / actualTotal * 100), "processed fraction uses the actual denominator and current video");
      assert.equal(result.batchAria, String(result.batch));
      const fail = actualTotal === 3 && index === 2;
      if (fail) {
        failures += 1;
        batchControl.send({ type: "batch-video-error", videoIndex: index, jobId: id,
          completedVideos: index, message: "新增的最后一个视频失败" });
      } else {
        batchControl.send(doneEvent(id, `实际合集原文 ${index + 1}`, makeReading(title), {
          type: "batch-video-done", videoIndex: index, completedVideos: index + 1, message: `${title} 已完成`
        }));
      }
      await settleResponses();
      await advanceProgress(12000);
      result = await meters();
      assert.equal(result.batch, Math.min(99, Math.floor((index + 1) / actualTotal * 100)), "failed entries count as processed but only batch-done can report 100");
      assert.match(result.batchSummary, new RegExp(`${index + 1}/${actualTotal} 个已处理 · ${failures} 个失败`));
    }
    batchControl.send({ type: "batch-done", totalVideos: actualTotal, completedVideos: actualTotal - failures,
      message: "不可信的合集全部成功文案" });
    batchControl.end();
    await waitFor("!document.querySelector('[data-submit]').disabled");
    result = await meters();
    assert.equal(result.batch, 100);
    assert.equal(result.batchAria, "100");
    assert.equal(result.value, failures ? 61 : 100);
    assert.match(result.batchSummary, new RegExp(`${actualTotal}/${actualTotal} 个已处理 · ${failures} 个失败`));
    batch = await batchState();
    assert.deepEqual(batch.items.map(item => item.state), failures ? ["done", "done", "error"] : ["done"]);
    assert.equal((await state()).kind, failures ? "error" : "success");
    if (failures) assert.match((await state()).status, /1 个视频失败/);
    else assert.match((await state()).status, /全部视频转写完成/);
    assert(!(await state()).status.includes("未结束"), "removed preview entries must not become ghost unfinished videos");
    await assertStoppedNoPolling(`actual batch total ${actualTotal}`);
    pass(`batch estimate 2 becomes actual ${actualTotal}: placeholders, server metadata, fractions, failure counts and terminal state`);
  }

  await changeUrl(`https://example.com/review-final-cleanup-${mode}`);
  await assertStoppedNoPolling("review final cleanup");
  assert.equal(pendingHistory.length, 0);
  assert.equal(pendingReading.length, 0);
  assert.equal(groups, 10, "ten new review groups run in each Electron mode");
  await js("void Object.assign(progressClock, window.realProgressClock)");
}

async function main() {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const desktop of [true, false]) {
    win = new BrowserWindow({
      width: 1100, height: 800,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        ...(desktop ? { preload: path.join(root, "electron/preload.js") } : {})
      }
    });
    startupErrors.length = 0;
    win.webContents.on("console-message", event => {
      if (event.level === "error") startupErrors.push(event.message);
    });
    const preventDownload = event => event.preventDefault();
    win.webContents.session.on("will-download", preventDownload);
    win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await win.loadURL(baseUrl);
    assert.deepEqual(startupErrors, [], "UI must load without JavaScript errors");
    const bridgePresent = await js(`(() => {
      window.testErrors = [];
      window.addEventListener('unhandledrejection', event => window.testErrors.push(String(event.reason)));
      window.addEventListener('error', event => window.testErrors.push(event.message));
      document.querySelector('[data-form]').addEventListener('submit', event => event.preventDefault(), true);
      return typeof window.desktopBridge?.notify === 'function';
    })()`);
    assert.equal(bridgePresent, desktop);
    assert.match((await state()).message, /转写结束后/);

    // Keep the original eight desktop/web submit regression cases.
    const notificationStart = notifications.length;
    for (const nextScenario of ["failure", "failure", "success", "batch"]) {
      scenario = nextScenario;
      const start = requests.length;
      const result = await clickSubmit();
      const sent = requests.slice(start);
      assert(sent.some(req => req.pathname === "/api/playlist-check"), "click must submit playlist check");
      const expectedPath = scenario === "batch" ? "/api/transcribe-batch" : "/api/transcribe";
      const submission = sent.find(req => req.pathname === expectedPath);
      assert(submission, `click must reach ${expectedPath}`);
      assert.equal(submission.body.url, VIDEO_URL);
      assert.equal(result.disabled, false, "button must be restored after completion/failure");
      assert.equal(result.inputDisabled, false, "input must be restored");
      assert.deepEqual(result.errors, []);
      assert.equal(result.kind, scenario === "failure" ? "error" : "success");
      if (scenario === "failure") assert.match(result.status, /模拟后端失败/);
      if (scenario === "success") assert.equal(result.transcript, "测试文稿");
      if (scenario === "batch") assert.equal(result.batchHidden, false);
      console.log(`PASS ${desktop ? "desktop" : "web"}: ${scenario}`);
    }
    if (desktop) {
      const titles = notifications.slice(notificationStart).map(item => item.title);
      for (const title of ["转写失败", "转写完成", "合集进度", "合集转写完成"]) assert(titles.includes(title));
    }
    fs.writeFileSync(path.join(tempRoot, `frontend-submit-${desktop ? "desktop" : "web"}.png`), (await win.webContents.capturePage()).toPNG());
    await testReading(desktop);
    await testPercentProgress(desktop);
    await testReviewRegressions(desktop);
    assert.deepEqual((await state()).errors, [], "no runtime errors or unhandled rejections");
    win.webContents.session.removeListener("will-download", preventDownload);
    win.destroy();
    win = null;
  }
  console.log("All 8 original submit scenarios, 18 reading groups, 20 percent-progress groups and 20 review-regression groups passed (66 total). Real Electron + controlled clocks + mock APIs only; no video/model requests or packaging.");
}

main().then(() => finish(0), error => {
  console.error(error);
  finish(1);
});

function finish(code) {
  clearTimeout(timeout);
  if (win && !win.isDestroyed()) win.destroy();
  server.close();
  app.exit(code);
}
