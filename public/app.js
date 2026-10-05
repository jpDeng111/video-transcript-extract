const form = document.querySelector("[data-form]");
const urlInput = document.querySelector("[data-url]");
const submitButton = document.querySelector("[data-submit]");
const statusText = document.querySelector("[data-status]");
const progressBar = document.querySelector("[data-progress]");
const transcriptOutput = document.querySelector("[data-transcript]");
const transcriptPath = document.querySelector("[data-transcript-path]");
const logList = document.querySelector("[data-log]");
const qaForm = document.querySelector("[data-qa-form]");
const questionInput = document.querySelector("[data-question]");
const askButton = document.querySelector("[data-ask]");
const answerOutput = document.querySelector("[data-answer]");
const checkStatusButton = document.querySelector("[data-check-status]");
const downloadButton = document.querySelector("[data-download]");
const summaryCompleted = document.querySelector("[data-summary-completed]");
const summaryNext = document.querySelector("[data-summary-next]");
const summaryStatus = document.querySelector("[data-summary-status]");
const statusPanel = document.querySelector(".status-panel");
const batchPanel = document.querySelector("[data-batch-panel]");
const batchSummary = document.querySelector("[data-batch-summary]");
const batchProgressBar = document.querySelector("[data-batch-progress]");
const batchList = document.querySelector("[data-batch-list]");
const readingView = document.querySelector("[data-reading-view]");
const viewTabs = [...document.querySelectorAll("[data-view]")];
const readingState = document.querySelector("[data-reading-state]");
const readingMessage = document.querySelector("[data-reading-message]");
const readingErrorOutput = document.querySelector("[data-reading-error]");
const readingDocument = document.querySelector("[data-reading-document]");
const readingTitle = document.querySelector("[data-reading-title]");
const readingSummary = document.querySelector("[data-reading-summary]");
const readingPoints = document.querySelector("[data-reading-points]");
const readingToc = document.querySelector("[data-reading-toc]");
const readingSections = document.querySelector("[data-reading-sections]");
const generateReadingButton = document.querySelector("[data-generate-reading]");
const readingDownloadButton = document.querySelector("[data-download-reading]");

let activeRequest = null;
let activeJobId = "";
let documentUrl = urlInput.value.trim();
let documentVersion = 0;
let historyRequestId = 0;
let readingRequestId = 0;
let pendingReadingRequest = 0;
let qaRequestId = 0;
let reading = null;
let readingStatus = "missing";
let readingError = "";
let transcriptComplete = false;
let batchMode = false;
let batchVideos = [];
let batchTotalVideos = 0;
let batchCompletedVideos = 0;
let batchVideoIndex = -1;
let batchFinished = false;
let readingPollTimer = null;
let readingPollController = null;
let readingPostController = null;
let lastLegacyLog = { message: "", stage: "", at: -Infinity };

// One injectable clock for progress only; network and UI event loops stay independent.
const progressClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id)
};
const progressStages = [
  ["prepare", "准备与检测", 0, 3], ["download", "下载媒体", 3, 20],
  ["normalize", "音频转换", 20, 28], ["split", "音频分段", 28, 32],
  ["transcribe", "逐段转写", 32, 90], ["reading", "主题整理", 90, 99]
];

// Stage percent is NEVER an overall percent. The visual counter only consumes
// one integer point per tick; terminal results may settle immediately (cached jobs).
function createProgressTracker({ stages, render, clock = progressClock }) {
  let timer = null;
  let state;
  const bounded = value => Math.max(0, Math.min(100, value));
  const emit = () => render({ ...state });
  function reset() {
    clock.clearInterval(timer);
    timer = null;
    state = { value: 0, target: 0, stage: -1, label: "等待开始", running: false,
      outcome: "idle", elapsed: 0, started: 0, changed: 0, percent: null,
      completed: null, total: null, scope: "", estimated: false, authoritative: false };
    emit();
  }
  function tick() {
    if (!state.running) return;
    state.elapsed = Math.max(0, clock.now() - state.started);
    const [, , start, end] = stages[state.stage];
    const waited = Math.max(0, clock.now() - state.changed);
    let fraction = state.percent === null ? 0 : state.percent / 100;
    if (state.total) {
      // Only speculate inside ONE unfinished chunk/batch, never the next one.
      fraction = (state.completed + (state.completed < state.total ? Math.min(0.9, waited / 90000) : 0)) / state.total;
    } else if (state.percent === null && !["transcribe", "reading"].includes(stages[state.stage][0])) {
      fraction = Math.min(0.9, waited / 90000);
    }
    // With no AI batch denominator, wait honestly instead of inventing batches.
    const ceiling = end === 99 ? 99 : end - 1;
    state.target = Math.max(state.target, Math.min(ceiling, Math.floor(start + (end - start) * fraction)));
    if (state.value < state.target) state.value += 1;
    emit();
  }
  function start(stage = stages[0][0]) {
    reset();
    state.running = true;
    state.outcome = "running";
    state.started = clock.now();
    update({ stage, percent: null }, false);
    timer = clock.setInterval(tick, 120);
  }
  function update(event, authoritative = true) {
    if (!state.running) return;
    const index = stages.findIndex(item => item[0] === event.stage);
    if (index < state.stage || index < 0) return;
    if (index > state.stage) {
      Object.assign(state, { stage: index, label: stages[index][1], percent: null,
        completed: null, total: null, scope: "", estimated: false, authoritative: false, changed: clock.now() });
    }
    if (!authoritative && state.authoritative) return;
    const percent = Number.isFinite(event.percent) ? bounded(event.percent) : null;
    const total = Number.isFinite(event.total) && event.total > 0 ? event.total : null;
    const completed = total && Number.isFinite(event.completed) ? Math.max(0, Math.min(total, event.completed)) : null;
    // A delayed count must not rewind the unit being estimated. File percentages
    // may legitimately reset when a downloader switches from video to audio.
    if (total && total === state.total && completed !== null && completed < state.completed) return;
    if (percent !== state.percent || completed !== state.completed || total !== state.total) state.changed = clock.now();
    Object.assign(state, { percent, total: completed === null ? null : total, completed,
      scope: event.scope || "", estimated: Boolean(event.estimated), authoritative: authoritative || state.authoritative });
    // Do not advance here: bursts of network events must not skip a visual point.
    emit();
  }
  function finish(success) {
    if (state.running) state.elapsed = Math.max(0, clock.now() - state.started);
    clock.clearInterval(timer);
    timer = null;
    state.running = false;
    state.outcome = success ? "done" : "stopped";
    if (success) state.value = 100;
    state.target = state.value; // Drop queued animation on failure or cancellation.
    emit();
  }
  function snapshot(event, complete, keepRunning = false) {
    start(event.stage);
    update(event);
    tick();
    state.value = state.target;
    if (keepRunning) emit();
    else finish(complete);
  }
  reset();
  return { start, reset, update, finish, snapshot, get: () => ({ ...state }) };
}

function formatElapsed(ms) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function progressDetail(state) {
  if (state.total) return `实际已完成 ${state.completed}/${state.total} ${state.label === "逐段转写" ? "段" : "批"}`;
  if (state.percent !== null) return `${state.scope === "file" ? "当前媒体流" : "当前阶段"}${state.estimated ? " · 估算" : " · 实际"} ${Math.floor(state.percent)}%`;
  return state.running ? "等待阶段进度；总百分比为加权估算。" : "各阶段加权估算，非实际完成比例。";
}

function progressNote(state) {
  if (state.outcome === "done") return "已结束处理，结果可在下方查看。";
  if (state.outcome === "stopped") return "进度已停止，保留当前数值；可读取本地进度或重试。";
  if (state.running && progressClock.now() - state.changed >= 15000) return "暂未收到新进度，仍在等待处理结果；耗时较长不代表故障。估算不会跨越当前阶段或批次。";
  return "每次推进 1%；估算仅限当前阶段或批次，结束前不会到达 100%。";
}

const overallProgress = createProgressTracker({ stages: progressStages, render(state) {
  setProgress(state.value);
  const label = state.outcome === "done" ? "总进度 · 已完成" : "总进度 · 估算";
  document.querySelector("[data-progress-label]").textContent = label;
  document.querySelector("[data-progress-stage]").textContent = state.outcome === "done" ? "处理结束" : state.label;
  document.querySelector("[data-progress-elapsed]").textContent = `已等待 ${formatElapsed(state.elapsed)}`;
  document.querySelector("[data-progress-detail]").textContent = progressDetail(state);
  document.querySelector("[data-progress-note]").textContent = progressNote(state);
  progressBar.parentElement.setAttribute("aria-label", label);
  progressBar.parentElement.setAttribute("aria-valuetext", `${state.value}%，${label}，${state.label}`);
  if (batchMode) renderBatchProgress(state.value);
} });
const readingProgress = createProgressTracker({ stages: [["reading", "主题整理", 0, 99]], render(state) {
  document.querySelector("[data-reading-progress-panel]").hidden = state.outcome === "idle";
  document.querySelector("[data-reading-percent]").textContent = state.value;
  document.querySelector("[data-reading-elapsed]").textContent = `已等待 ${formatElapsed(state.elapsed)}`;
  document.querySelector("[data-reading-progress-detail]").textContent = progressDetail(state);
  document.querySelector("[data-reading-progress-note]").textContent = progressNote(state);
  const label = state.outcome === "done" ? "主题整理 · 已完成" : "主题整理 · 估算";
  document.querySelector("[data-reading-progress-label]").textContent = label;
  const bar = document.querySelector("[data-reading-progress]");
  bar.style.width = `${state.value}%`;
  bar.parentElement.setAttribute("aria-valuenow", String(state.value));
  bar.parentElement.setAttribute("aria-label", label);
  bar.parentElement.setAttribute("aria-valuetext", `${state.value}%，${label}，${progressDetail(state)}`);
} });

function cancelReadingPolling() {
  progressClock.clearTimeout(readingPollTimer);
  readingPollTimer = null;
  readingPollController?.abort();
  readingPollController = null;
  readingPostController?.abort();
  readingPostController = null;
}

function pollReadingProgress(target, requestId, { followResult = false } = {}) {
  const current = () => pendingReadingRequest === requestId && readingRequestId === requestId && isCurrentTarget(target);
  const schedule = () => {
    if (current()) readingPollTimer = progressClock.setTimeout(poll, 1500);
  };
  const settle = (data) => {
    pendingReadingRequest = 0;
    historyRequestId += 1;
    cancelReadingPolling();
    applyReadingState(data);
    const ready = data.readingStatus === "ready" && Boolean(data.reading);
    if (readingProgress.get().running) readingProgress.finish(false);
    overallProgress.finish(ready);
    setStatus(ready ? "转写与主题整理完成，结果已保存到本地。" : "原文已保存，主题整理待恢复；可读取本地进度或重试。");
    // Reading errors must not relabel the saved transcription as failed.
    setStatusKind("success");
  };
  const poll = async () => {
    readingPollTimer = null;
    if (!current()) return;
    const controller = new AbortController();
    readingPollController = controller;
    try {
      const params = new URLSearchParams(target.jobId ? { jobId: target.jobId } : { url: target.url });
      const response = await fetch(`/api/job?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (!current()) return;
      if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
      if (target.jobId && data.id && data.id !== target.jobId) throw new Error("进度属于其他文稿，请重新读取。");
      if (followResult && (!["generating", "ready", "failed", "missing"].includes(data.readingStatus)
        || (data.readingStatus === "ready" && data.reading?.version !== 1))) throw new Error("未收到有效的主题整理状态。");
      if (data.readingProgress) {
        readingProgress.update({ stage: "reading", ...data.readingProgress });
        if (followResult) overallProgress.update({ stage: "reading", ...data.readingProgress });
      }
      if (followResult && data.readingStatus !== "generating") settle(data);
    } catch (error) {
      // Manual POSTs own their result; history-only observers have no other
      // completion channel, so a lost connection must stop their clock.
      if (followResult && current()) settle({ readingStatus: "failed", readingError: `进度同步中断：${error.message}。请读取本地进度。` });
    } finally {
      if (readingPollController === controller) readingPollController = null;
      schedule(); // Non-overlapping, at least 1.5 seconds after the last response.
    }
  };
  schedule();
}

function selectTranscriptView(view) {
  readingView.hidden = view !== "reading";
  transcriptOutput.hidden = view !== "raw";
  for (const tab of viewTabs) {
    const selected = tab.dataset.view === view;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
}

for (const tab of viewTabs) {
  tab.addEventListener("click", () => selectTranscriptView(tab.dataset.view));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? viewTabs[0] : event.key === "End" ? viewTabs[1]
      : viewTabs.find(item => item !== tab);
    selectTranscriptView(next.dataset.view);
    next.focus();
  });
}

function resetDocument() {
  documentVersion += 1;
  historyRequestId += 1;
  readingRequestId += 1;
  pendingReadingRequest = 0;
  cancelReadingPolling();
  stopBatchAnimation();
  overallProgress.reset();
  readingProgress.reset();
  flushChunkNotify();
  lastLegacyLog = { message: "", stage: "", at: -Infinity };
  qaRequestId += 1;
  documentUrl = urlInput.value.trim();
  activeJobId = "";
  transcriptComplete = false;
  transcriptOutput.value = "";
  transcriptPath.textContent = "尚未生成";
  reading = null;
  readingStatus = "missing";
  readingError = "";
  readingTitle.textContent = "";
  readingSummary.textContent = "";
  readingPoints.replaceChildren();
  readingToc.replaceChildren();
  readingSections.replaceChildren();
  answerOutput.textContent = "转写完成后，可以在这里提问。";
  setAskBusy(false);
  selectTranscriptView("reading");
  renderReadingState();
}

function syncDocumentUrl() {
  if (documentUrl === urlInput.value.trim()) return;
  activeRequest?.abort();
  activeRequest = null;
  setBusy(false);
  batchMode = false;
  batchVideos = [];
  batchTotalVideos = 0;
  batchCompletedVideos = 0;
  batchVideoIndex = -1;
  batchFinished = false;
  setBatchProgress(0);
  resetDocument();
  updateJobSummary({});
  setStatusKind("idle");
  setStatus("等待提交视频链接，或读取本地进度。");
  batchPanel.hidden = true;
}

urlInput.addEventListener("input", syncDocumentUrl);
urlInput.addEventListener("change", syncDocumentUrl);

// UI requests never own the transcription lock. Both the version and target
// must still match before an asynchronous response may update this document.
function documentTarget() {
  return { version: documentVersion, url: urlInput.value.trim(), jobId: activeJobId };
}

function isCurrentTarget(target) {
  return target.version === documentVersion && target.url === urlInput.value.trim()
    && (!target.jobId || target.jobId === activeJobId);
}

function textElement(tag, text, className = "") {
  const element = document.createElement(tag);
  element.textContent = typeof text === "string" ? text : "";
  if (className) element.className = className;
  return element;
}

function appendPoints(list, points) {
  list.replaceChildren();
  for (const point of Array.isArray(points) ? points : []) {
    list.append(textElement("li", point));
  }
}

function renderReadingDocument() {
  readingTitle.textContent = reading.title || "视频文稿";
  readingSummary.textContent = reading.summary || "";
  appendPoints(readingPoints, reading.keyPoints);
  readingToc.replaceChildren();
  readingSections.replaceChildren();
  for (const [index, section] of (reading.sections || []).entries()) {
    // Model-provided IDs/HTML never become selectors, anchors or markup.
    const id = `reading-topic-${index + 1}`;
    const article = document.createElement("section");
    article.className = "reading-topic";
    article.setAttribute("aria-labelledby", id);
    const title = textElement("h4", section.title || `主题 ${index + 1}`);
    title.id = id;
    title.tabIndex = -1;
    const link = textElement("a", `${String(index + 1).padStart(2, "0")} / ${section.title || "主题"}`);
    link.href = `#${id}`;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      for (const item of readingToc.querySelectorAll("a")) item.removeAttribute("aria-current");
      link.setAttribute("aria-current", "location");
      title.focus({ preventScroll: true });
      title.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
        block: "start"
      });
    });
    const item = document.createElement("li");
    item.append(link);
    readingToc.append(item);
    article.append(title);
    const points = document.createElement("ul");
    points.className = "topic-key-points";
    appendPoints(points, section.keyPoints);
    article.append(points, textElement("p", "对应原文", "original-label"));
    for (const paragraph of section.paragraphs || []) {
      article.append(textElement("p", paragraph, "topic-paragraph"));
    }
    readingSections.append(article);
  }
}

function renderReadingState() {
  const ready = readingStatus === "ready" && Boolean(reading);
  const generating = readingStatus === "generating" || (readingStatus === "ready" && !reading);
  readingState.dataset.state = readingStatus;
  readingView.setAttribute("aria-busy", String(generating));
  readingDocument.hidden = !ready;
  readingMessage.textContent = ready ? "按主题阅读，原始逐字稿完整保留。"
    : generating ? "正在整理主题、重点与目录，请稍候。你仍可切换查看逐字稿。"
    : readingStatus === "failed" ? "主题整理失败，原始逐字稿不受影响。可以重试。"
    : transcriptComplete ? "这份文稿尚未整理。生成主题阅读，更轻松地回看重点与原文。"
    : "转写结束后，将自动整理主题、重点与目录。原始逐字稿始终保留。";
  readingErrorOutput.textContent = readingError;
  readingErrorOutput.hidden = readingStatus !== "failed" || !readingError;
  generateReadingButton.hidden = ready || !transcriptComplete;
  generateReadingButton.disabled = generating;
  generateReadingButton.textContent = generating ? "正在整理..."
    : readingStatus === "failed" ? "重试主题整理" : "生成主题阅读";
  const hasTarget = Boolean(activeJobId || documentUrl);
  downloadButton.disabled = !transcriptComplete || !hasTarget;
  readingDownloadButton.disabled = !ready || !hasTarget;
}

function applyReadingState(data) {
  if (data.reading !== undefined) {
    reading = data.reading && data.reading.version === 1 ? data.reading : null;
  }
  if (data.readingStatus !== undefined) readingStatus = data.readingStatus;
  if (data.readingError !== undefined) readingError = data.readingError || "";
  if (readingStatus === "generating" && !readingProgress.get().running) readingProgress.start();
  if (data.readingProgress && readingStatus === "generating") readingProgress.update({ stage: "reading", ...data.readingProgress });
  if (readingStatus === "ready" && reading) {
    readingProgress.finish(true);
    renderReadingDocument();
  } else if (readingStatus === "failed") readingProgress.finish(false);
  renderReadingState();
}

function completeDocument(event) {
  historyRequestId += 1;
  readingRequestId += 1;
  pendingReadingRequest = 0;
  cancelReadingPolling();
  activeJobId = event.jobId || activeJobId;
  if (typeof event.transcript === "string") transcriptOutput.value = event.transcript;
  if (event.transcriptPath) transcriptPath.textContent = event.transcriptPath;
  transcriptComplete = Boolean(transcriptOutput.value.trim());
  applyReadingState(event);
  if (readingProgress.get().running) readingProgress.finish(false);
  selectTranscriptView("reading");
}

generateReadingButton.addEventListener("click", async () => {
  syncDocumentUrl();
  if (!transcriptComplete || generateReadingButton.disabled || readingStatus === "ready") return;
  const target = documentTarget();
  const requestId = ++readingRequestId;
  pendingReadingRequest = requestId;
  historyRequestId += 1;
  readingStatus = "generating";
  readingError = "";
  cancelReadingPolling();
  const controller = new AbortController();
  readingPostController = controller;
  readingProgress.start();
  pollReadingProgress(target, requestId);
  renderReadingState();
  try {
    const response = await fetch("/api/reading", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(target.jobId ? { jobId: target.jobId } : { url: target.url }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!isCurrentTarget(target) || requestId !== readingRequestId) return;
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    if ((target.jobId && data.jobId !== target.jobId) || data.readingStatus !== "ready" || data.reading?.version !== 1) {
      throw new Error("未收到当前文稿的阅读版，请重试。");
    }
    if (data.jobId) activeJobId = data.jobId;
    applyReadingState({ ...data, readingError: "" });
  } catch (error) {
    if (!isCurrentTarget(target) || requestId !== readingRequestId) return;
    readingStatus = "failed";
    readingError = error.message;
    readingProgress.finish(false);
    renderReadingState();
  } finally {
    if (isCurrentTarget(target) && requestId === readingRequestId) {
      pendingReadingRequest = 0;
      cancelReadingPolling();
      historyRequestId += 1;
    }
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url || activeRequest) {
    return;
  }

  resetDocument();
  const request = new AbortController();
  activeRequest = request;
  batchMode = false;
  batchVideos = [];
  batchTotalVideos = 0;
  batchCompletedVideos = 0;
  batchVideoIndex = -1;
  batchFinished = false;
  batchPanel.hidden = true;
  setBatchProgress(0);
  requestNotifyPermission();
  flushChunkNotify();
  setStatusKind("running");
  setBusy(true);
  overallProgress.start();
  updateJobSummary({ completedChunks: 0, totalChunks: 0, status: "preparing" });
  setStatus("正在检测是否为合集...");
  addLog("提交视频链接，开始准备转写任务。");
  answerOutput.textContent = "转写完成后，可以在这里提问。";

  try {
    // Step 1: Check if URL is a playlist
    const checkResponse = await fetch("/api/playlist-check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      signal: request.signal
    });
    const checkData = await checkResponse.json().catch(() => ({}));
    if (activeRequest !== request || urlInput.value.trim() !== url) return;
    if (!checkResponse.ok) throw new Error(checkData.error || `请求失败：${checkResponse.status}`);

    if (checkData.isPlaylist) {
      // Batch mode: process playlist
      batchMode = true;
      batchTotalVideos = checkData.count;
      batchCompletedVideos = 0;
      batchVideos = (checkData.entries || []).map((e, i) => ({
        index: i, title: e.title, url: e.url, state: "waiting", jobId: ""
      }));
      batchPanel.hidden = false;
      renderBatchList();
      setBatchProgress(0);
      batchSummary.textContent = `0/${batchTotalVideos} 个视频`;
      setStatus(`检测到合集：${batchTotalVideos} 个视频，开始处理...`);
      addLog(`检测到合集，共 ${batchTotalVideos} 个视频。`);

      const batchResponse = await fetch("/api/transcribe-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: request.signal
      });

      if (!batchResponse.ok || !batchResponse.body) {
        const error = await batchResponse.json().catch(() => ({}));
        throw new Error(error.error || `请求失败：${batchResponse.status}`);
      }

      await readNdjsonStream(batchResponse.body, request, url);
    } else {
      // Single video mode
      setStatus("准备任务...");
      addLog("单个视频，开始转写。");

      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: request.signal
      });

      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `请求失败：${response.status}`);
      }

      await readNdjsonStream(response.body, request, url);
    }
    if (activeRequest === request && (overallProgress.get().running || (batchMode && !batchFinished))) {
      throw new Error("连接已结束，但尚未收到完成确认。请读取本地进度后重试。");
    }
  } catch (error) {
    if (activeRequest !== request || urlInput.value.trim() !== url) return;
    overallProgress.finish(false);
    stopBatchAnimation();
    if (readingProgress.get().running) applyReadingState({ readingStatus: "failed", readingError: "处理已中断，请重试主题整理。" });
    const message = error.name === "AbortError" ? "已停止。" : `处理失败：${error.message}`;
    setStatusKind(error.name === "AbortError" ? "idle" : "error");
    flushChunkNotify();
    if (error.name !== "AbortError") {
      notifyDesktop("转写失败", message);
    }
    setStatus(message);
    addLog(message, error.name === "AbortError" ? "" : "error");
  } finally {
    if (activeRequest === request) {
      activeRequest = null;
      setBusy(false);
    }
  }
});

async function readNdjsonStream(body, request, url) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (line) => {
    if (activeRequest === request && urlInput.value.trim() === url) handleEvent(JSON.parse(line));
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        dispatch(line);
      }
    }
  }

  if (buffer.trim()) {
    dispatch(buffer);
  }
}

function handleEvent(event) {
  const expectedJob = activeJobId || (batchMode ? batchVideos[batchVideoIndex]?.jobId : "");
  if (event.type !== "batch-video-start" && event.jobId && expectedJob && event.jobId !== expectedJob) return;
  if (event.type !== "batch-video-start" && event.batchVideoIndex !== undefined && event.batchVideoIndex !== batchVideoIndex) return;
  if (["batch-video-done", "batch-video-error"].includes(event.type) && event.videoIndex !== batchVideoIndex) return;
  // Stream updates supersede any earlier history snapshot.
  historyRequestId += 1;
  if (event.type === "stage-progress") {
    if (!overallProgress.get().running) return;
    if (event.jobId) activeJobId = event.jobId;
    const previousStage = overallProgress.get().stage;
    overallProgress.update(event);
    const current = overallProgress.get();
    if (progressStages[current.stage]?.[0] !== event.stage) return;
    if (current.stage !== previousStage) setStatus(`正在${current.label}，请稍候。`);
    summaryStatus.textContent = current.label;
    if (event.stage === "transcribe" && current.total) {
      updateJobSummary({ completedChunks: current.completed, totalChunks: current.total, status: current.label });
    }
    if (event.stage === "reading" && !pendingReadingRequest) {
      if (!readingProgress.get().running && !["ready", "failed"].includes(readingStatus)) applyReadingState({ readingStatus: "generating" });
      readingProgress.update(event);
    }
    return; // High-frequency stage values belong in the meter, not the log.
  }
  if (event.type === "reading-status") {
    if (!overallProgress.get().running) return;
    if (event.jobId) activeJobId = event.jobId;
    readingRequestId += 1;
    pendingReadingRequest = 0;
    cancelReadingPolling();
    if (event.readingStatus === "generating") {
      overallProgress.update({ stage: "reading", percent: null }, false);
      setStatus("正在主题整理，请稍候。");
    }
    applyReadingState(event);
    if (event.message) addLog(event.message);
    return; // Theme-generation errors must not change transcription status.
  }

  // Batch-specific events
  if (event.type === "batch-start" || event.type === "batch-info") {
    if (event.type === "batch-info" && batchVideoIndex < 0 && Number.isSafeInteger(event.totalVideos) && event.totalVideos > 0) {
      // The server resolves the playlist again: that result, not preflight,
      // defines the denominator and which waiting rows belong to this run.
      batchTotalVideos = event.totalVideos;
      batchVideos = Array.from({ length: batchTotalVideos }, (_, index) => ({
        index, title: `视频 ${index + 1}`, url: "", state: "waiting", jobId: ""
      }));
      renderBatchList();
      renderBatchProgress();
    }
    if (event.message) {
      setStatus(event.message);
      addLog(event.message);
    }
    return;
  }

  if (event.type === "batch-video-start") {
    if (batchFinished || event.videoIndex <= batchVideoIndex) return;
    batchVideoIndex = event.videoIndex;
    stopBatchAnimation();
    resetDocument();
    overallProgress.start();
    updateJobSummary({ status: "preparing" });
    setStatusKind("running");
    const video = batchVideos[event.videoIndex];
    updateBatchVideo(event.videoIndex, { state: "processing", jobId: event.jobId || "",
      title: event.videoTitle || video?.title || `视频 ${event.videoIndex + 1}`,
      url: event.videoUrl || video?.url || "" });
    scrollToBatchVideo(event.videoIndex);
    setStatus(event.message);
    addLog(event.message);
    return;
  }

  if (event.type === "batch-video-done") {
    updateBatchVideo(event.videoIndex, { state: "done", jobId: event.jobId });
    overallProgress.finish(true);
    flushChunkNotify();
    notifyDesktop("合集进度", event.message || "一个视频已完成。");
    completeDocument(event);
    answerOutput.textContent = "现在可以基于这份文稿提问。";
    setStatus(readingStatus === "failed" ? "转写完成 · 主题整理待重试" : event.message);
    addLog(event.message);
    return;
  }

  if (event.type === "batch-video-error") {
    updateBatchVideo(event.videoIndex, { state: "error" });
    overallProgress.finish(false);
    if (readingProgress.get().running) applyReadingState({ readingStatus: "failed", readingError: "处理已中断，请重试主题整理。" });
    setStatusKind("error");
    flushChunkNotify();
    notifyDesktop("合集视频失败", event.message || "合集中的一个视频处理失败。");
    setStatus(event.message);
    addLog(event.message, "error");
    return;
  }

  if (event.type === "batch-done") {
    batchFinished = true;
    if (overallProgress.get().running) overallProgress.finish(false);
    if (readingProgress.get().running) readingProgress.finish(false);
    renderBatchProgress();
    const failed = batchVideos.filter(video => video.state === "error").length;
    const unfinished = batchVideos.filter(video => !["done", "error"].includes(video.state)).length;
    const message = unfinished ? `合集已停止，${unfinished} 个视频未结束，${failed} 个失败。`
      : failed ? `合集已处理完毕，${failed} 个视频失败，可重试。` : "合集内全部视频转写完成。";
    setStatusKind(failed || unfinished ? "error" : "success");
    setStatus(message);
    addLog(message, failed || unfinished ? "error" : "success");
    flushChunkNotify();
    notifyDesktop("合集转写完成", message);
    return;
  }

  // Late stream payloads cannot resurrect a terminated video's state.
  if (!overallProgress.get().running) return;
  // Single video events
  if (event.jobId) {
    activeJobId = event.jobId;
  }

  const legacyStages = {
    prepare: "prepare", playlist: "prepare", download: "download", download_retry: "download",
    normalize: "normalize", downloaded: "normalize", split: "split", chunks_ready: "transcribe",
    transcribing: "transcribe", saved: "transcribe", retry: "transcribe"
  };
  // Media reuse and damaged-file recovery also use "resume". Only a resume
  // carrying chunk progress identifies transcription; its message alone does not.
  const resumedChunk = event.step === "resume" && (Number.isFinite(event.progress)
    || (event.totalChunks > 0 && Number.isFinite(event.completedChunks)));
  const legacyStage = legacyStages[event.step] || (resumedChunk || event.type === "progress" ? "transcribe" : null);
  if (legacyStage) overallProgress.update({
    stage: legacyStage, percent: event.progress,
    completed: event.completedChunks, total: event.totalChunks
  }, false);
  const staleStage = legacyStage && progressStages.findIndex(stage => stage[0] === legacyStage) < overallProgress.get().stage;

  if (event.message && !staleStage) {
    setStatus(event.message);
    const kind = event.type === "done" || event.step === "saved" ? "success"
      : event.type === "error" ? "error"
      : "running";
    const progressMessage = event.type === "progress" || (event.type === "status" && event.progress !== undefined);
    if (!progressMessage || (event.message !== lastLegacyLog.message
      && (legacyStage !== lastLegacyLog.stage || progressClock.now() - lastLegacyLog.at >= 5000))) {
      addLog(event.message, kind);
      if (progressMessage) lastLegacyLog = { message: event.message, stage: legacyStage, at: progressClock.now() };
    }
    if (event.step === "saved") {
      notifyChunkProgress(event.message);
    }
  }

  if (event.transcript !== undefined) {
    transcriptOutput.value = event.transcript;
  }

  if (event.transcriptPath) {
    transcriptPath.textContent = event.transcriptPath;
  }

  if (event.progress !== undefined && !staleStage) {
    summaryStatus.textContent = overallProgress.get().label;
  }

  if (event.type === "done") {
    overallProgress.finish(true);
    setStatusKind("success");
    setStatus(event.readingStatus === "failed" || readingStatus === "failed"
      ? "转写完成 · 主题整理待重试" : "转写完成，结果已保存到本地。");
    addLog("全部视频分段已完成。", "success");
    flushChunkNotify();
    notifyDesktop("转写完成", event.title ? `《${event.title}》已全部转写完毕。` : "全部视频分段已完成。");
    answerOutput.textContent = "现在可以基于这份文稿提问。";
    completeDocument(event);
    loadJobStatus({ summaryOnly: true }).catch(() => {});
  }

  if (event.type === "error") {
    flushChunkNotify();
    setStatusKind("error");
    addLog(event.error || "未知错误", "error");
    notifyDesktop("转写失败", event.error || "未知错误");
    throw new Error(event.error || "未知错误");
  }
}

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  urlInput.disabled = isBusy;
  checkStatusButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "处理中..." : "提取并转写";
}

function setStatus(message) {
  statusText.textContent = message;
}

function setProgress(value) {
  const progress = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
  progressBar.style.width = `${progress}%`;
  document.querySelector("[data-progress-percent]").textContent = progress;
  progressBar.parentElement.setAttribute("aria-valuenow", String(progress));
}

let batchAnimation = null;
let batchVisible = 0;
let batchTarget = 0;
function stopBatchAnimation() {
  progressClock.clearInterval(batchAnimation);
  batchAnimation = null;
  batchTarget = batchVisible;
}

function setBatchProgress(value) {
  stopBatchAnimation();
  batchVisible = Math.max(0, Math.min(100, Math.floor(Number(value) || 0)));
  batchTarget = batchVisible;
  paintBatchProgress();
}

function paintBatchProgress() {
  batchProgressBar.style.width = `${batchVisible}%`;
  document.querySelector("[data-batch-percent]").textContent = batchVisible;
  batchProgressBar.parentElement.setAttribute("aria-valuenow", String(batchVisible));
  batchProgressBar.parentElement.setAttribute("aria-valuetext", `${batchVisible}%，${batchSummary.textContent}`);
}

function renderBatchProgress(current = 0) {
  const failed = batchVideos.filter(video => video.state === "error").length;
  batchCompletedVideos = batchVideos.filter(video => ["done", "error"].includes(video.state)).length;
  const fraction = batchVideos[batchVideoIndex]?.state === "processing" ? current / 100 : 0;
  batchSummary.textContent = `${batchCompletedVideos}/${batchTotalVideos} 个已处理 · ${failed} 个失败`;
  const ended = batchFinished && batchCompletedVideos === batchTotalVideos;
  document.querySelector("[data-batch-label]").textContent = batchFinished ? "已处理 · 已结束" : "已处理 · 估算";
  batchProgressBar.parentElement.setAttribute("aria-label", batchFinished ? "合集已处理进度" : "合集已处理进度 · 估算");
  const value = batchTotalVideos ? Math.floor((batchCompletedVideos + fraction) / batchTotalVideos * 100) : 0;
  if (batchFinished) {
    setBatchProgress(ended ? 100 : Math.max(batchVisible, Math.min(99, value)));
    return;
  }
  batchTarget = Math.max(batchTarget, Math.min(99, value));
  paintBatchProgress();
  if (batchTarget > batchVisible && batchAnimation === null) {
    batchAnimation = progressClock.setInterval(() => {
      if (batchVisible < batchTarget) batchVisible += 1;
      paintBatchProgress();
      if (batchVisible >= batchTarget) stopBatchAnimation();
    }, 120);
  }
}

function renderBatchList() {
  batchList.replaceChildren();
  for (const video of batchVideos) {
    const li = document.createElement("li");
    li.className = "batch-video-item";
    li.dataset.state = video.state;
    li.dataset.index = video.index;

    const indexSpan = document.createElement("span");
    indexSpan.className = "bv-index";
    indexSpan.textContent = String(video.index + 1);

    const titleSpan = document.createElement("span");
    titleSpan.className = "bv-title";
    titleSpan.textContent = video.title;
    titleSpan.title = video.title;

    const statusSpan = document.createElement("span");
    statusSpan.className = "bv-status";
    statusSpan.textContent = video.state === "waiting" ? "等待中" : video.state === "processing" ? "处理中" : video.state === "done" ? "已完成" : "失败";

    li.append(indexSpan, titleSpan, statusSpan);
    batchList.appendChild(li);
  }
}

function updateBatchVideo(index, updates) {
  const video = batchVideos[index];
  if (!video) return;

  Object.assign(video, updates);

  const item = batchList.children[index];
  if (!item) return;

  item.dataset.state = video.state;
  const titleEl = item.querySelector(".bv-title");
  if (titleEl) {
    titleEl.textContent = video.title;
    titleEl.title = video.title;
  }
  const statusEl = item.querySelector(".bv-status");
  if (statusEl) {
    statusEl.textContent = video.state === "waiting" ? "等待中" : video.state === "processing" ? "处理中" : video.state === "done" ? "已完成" : "失败";
  }
}

function scrollToBatchVideo(index) {
  const item = batchList.children[index];
  if (item) {
    item.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
  }
}

function addLog(message, kind = "") {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  item.textContent = `${time} ${message}`;
  if (kind) {
    item.dataset.kind = kind;
  }
  logList.prepend(item);

  while (logList.children.length > 8) {
    logList.lastElementChild.remove();
  }
}

// contextBridge exposes a non-configurable global property; a same-named
// top-level const would prevent this entire script from loading in Electron.
const desktopNotifications = window.desktopBridge || null;

function notifyDesktop(title, body) {
  if (desktopNotifications?.notify) {
    desktopNotifications.notify({ title, body });
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      new Notification(title, { body });
    } catch {
      // Browser without Notification support; ignore.
    }
  }
}

let chunkNotifyTimer = null;

// Chunk completions arrive every few seconds; coalesce them so macOS
// notification center doesn't get flooded mid-task.
function notifyChunkProgress(message) {
  if (!chunkNotifyTimer) {
    notifyDesktop("转写进度", message);
  }
  clearTimeout(chunkNotifyTimer);
  chunkNotifyTimer = setTimeout(() => {
    chunkNotifyTimer = null;
  }, 20000);
}

function flushChunkNotify() {
  clearTimeout(chunkNotifyTimer);
  chunkNotifyTimer = null;
}

function setStatusKind(kind) {
  statusPanel.dataset.statusKind = kind;
}

function requestNotifyPermission() {
  if (desktopNotifications || typeof Notification === "undefined" || Notification.permission !== "default") {
    return;
  }
  Notification.requestPermission().catch(() => {});
}

qaForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  syncDocumentUrl();
  const question = questionInput.value.trim();
  const url = urlInput.value.trim();
  if (!question || askButton.disabled) {
    return;
  }

  const target = documentTarget();
  const requestId = ++qaRequestId;
  setAskBusy(true);
  answerOutput.textContent = "正在根据文稿生成回答...";

  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        question,
        url,
        jobId: activeJobId
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!isCurrentTarget(target) || requestId !== qaRequestId) return;
    if (!response.ok) {
      throw new Error(data.error || `请求失败：${response.status}`);
    }

    if (data.jobId && (!target.jobId || data.jobId === target.jobId)) {
      activeJobId = data.jobId;
    }
    answerOutput.textContent = data.answer || "没有生成回答。";
  } catch (error) {
    if (isCurrentTarget(target) && requestId === qaRequestId) answerOutput.textContent = `提问失败：${error.message}`;
  } finally {
    if (isCurrentTarget(target) && requestId === qaRequestId) setAskBusy(false);
  }
});

checkStatusButton.addEventListener("click", async () => {
  try {
    await loadJobStatus();
  } catch (error) {
    const message = `读取进度失败：${error.message}`;
    setStatus(message);
    addLog(message);
  }
});

async function loadJobStatus({ summaryOnly = false } = {}) {
  syncDocumentUrl();
  const target = documentTarget();
  const requestId = ++historyRequestId;
  const params = new URLSearchParams();
  if (target.jobId) {
    params.set("jobId", target.jobId);
  } else if (target.url) {
    params.set("url", target.url);
  } else {
    throw new Error("请先输入视频链接。");
  }

  try {
    const response = await fetch(`/api/job?${params.toString()}`);
    const data = await response.json().catch(() => ({}));
    if (!isCurrentTarget(target) || requestId !== historyRequestId) return;
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    if (target.jobId && data.id && data.id !== target.jobId) return;

    if (data.id) activeJobId = data.id;
    updateJobSummary(data);
    // A summary refresh must never reset completed progress, timers or the view.
    if (summaryOnly) return;
    const followReading = !pendingReadingRequest && !activeRequest && data.readingStatus === "generating";
    if (!pendingReadingRequest && !activeRequest) {
      if (followReading) overallProgress.snapshot({ stage: "reading", ...data.readingProgress }, false, true);
      else overallProgress.snapshot({ stage: data.totalChunks > 0 ? "transcribe" : "prepare",
        completed: data.completedChunks, total: data.totalChunks, percent: data.progress
      }, data.status === "complete");
    }
    if (data.transcriptPath) transcriptPath.textContent = data.transcriptPath;
    if (typeof data.transcript === "string") transcriptOutput.value = data.transcript;
    // Never substitute transcriptPreview (which may be truncated to 2,000 chars).
    transcriptComplete = Boolean(transcriptOutput.value.trim()) && (data.status === "complete"
      || (data.completedChunks > 0 && data.completedChunks >= (data.totalChunks || 1)));
    if (!pendingReadingRequest) applyReadingState(data);
    else renderReadingState();
    if (followReading) {
      cancelReadingPolling();
      const followId = ++readingRequestId;
      pendingReadingRequest = followId;
      pollReadingProgress(documentTarget(), followId, { followResult: true });
    }
    selectTranscriptView("reading");
    if (transcriptComplete) answerOutput.textContent = "现在可以基于这份文稿提问。";

    const next = data.nextResumeChunkHuman ? `下次从第 ${data.nextResumeChunkHuman} 段继续` : "没有待处理片段";
    setStatus(followReading ? "原文已保存，正在同步主题整理进度。" : `本地进度：${data.completedChunks}/${data.totalChunks || 0} 段，${next}。`);
    addLog(`读取本地进度：${data.completedChunks}/${data.totalChunks || 0} 段。`);
  } catch (error) {
    if (isCurrentTarget(target) && requestId === historyRequestId) throw error;
  }
}

function updateJobSummary(data) {
  const total = Number(data.totalChunks || 0);
  const completed = Number(data.completedChunks || 0);
  summaryCompleted.textContent = `${completed}/${total}`;
  summaryStatus.textContent = data.status || "等待";

  if (data.nextResumeChunkHuman) {
    summaryNext.textContent = `第 ${data.nextResumeChunkHuman} 段`;
  } else if (total > 0 && completed >= total) {
    summaryNext.textContent = "已完成";
  } else if (data.currentChunkHuman) {
    summaryNext.textContent = `正在第 ${data.currentChunkHuman} 段`;
  } else {
    summaryNext.textContent = "尚未开始";
  }
}

function setAskBusy(isBusy) {
  askButton.disabled = isBusy;
  questionInput.disabled = isBusy;
  askButton.textContent = isBusy ? "思考中..." : "提问";
}

function downloadDocument(format) {
  syncDocumentUrl();
  const button = format === "reading" ? readingDownloadButton : downloadButton;
  if (button.disabled) return;
  const params = new URLSearchParams();
  if (activeJobId) params.set("jobId", activeJobId);
  else if (documentUrl) params.set("url", documentUrl);
  else return;
  if (format === "reading") params.set("format", "reading");
  window.location.href = `/api/download?${params.toString()}`;
}

downloadButton.addEventListener("click", () => downloadDocument("raw"));
readingDownloadButton.addEventListener("click", () => downloadDocument("reading"));
