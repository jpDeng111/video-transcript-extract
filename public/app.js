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

let activeRequest = null;
let activeJobId = "";
let batchMode = false;
let batchVideos = [];
let batchTotalVideos = 0;
let batchCompletedVideos = 0;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url || activeRequest) {
    return;
  }

  activeRequest = new AbortController();
  activeJobId = "";
  batchMode = false;
  batchVideos = [];
  batchTotalVideos = 0;
  batchCompletedVideos = 0;
  batchPanel.hidden = true;
  requestNotifyPermission();
  flushChunkNotify();
  setStatusKind("running");
  setBusy(true);
  setProgress(0);
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
      signal: activeRequest.signal
    });
    const checkData = await checkResponse.json().catch(() => ({}));

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
        signal: activeRequest.signal
      });

      if (!batchResponse.ok || !batchResponse.body) {
        const error = await batchResponse.json().catch(() => ({}));
        throw new Error(error.error || `请求失败：${batchResponse.status}`);
      }

      await readNdjsonStream(batchResponse.body);
    } else {
      // Single video mode
      setStatus("准备任务...");
      addLog("单个视频，开始转写。");

      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
        signal: activeRequest.signal
      });

      if (!response.ok || !response.body) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || `请求失败：${response.status}`);
      }

      await readNdjsonStream(response.body);
    }
  } catch (error) {
    const message = error.name === "AbortError" ? "已停止。" : `处理失败：${error.message}`;
    setStatusKind(error.name === "AbortError" ? "idle" : "error");
    flushChunkNotify();
    if (error.name !== "AbortError") {
      notifyDesktop("转写失败", message);
    }
    setStatus(message);
    addLog(message, error.name === "AbortError" ? "" : "error");
  } finally {
    activeRequest = null;
    setBusy(false);
  }
});

async function readNdjsonStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

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
        handleEvent(JSON.parse(line));
      }
    }
  }

  if (buffer.trim()) {
    handleEvent(JSON.parse(buffer));
  }
}

function handleEvent(event) {
  // Batch-specific events
  if (event.type === "batch-start" || event.type === "batch-info") {
    if (event.message) {
      setStatus(event.message);
      addLog(event.message);
    }
    return;
  }

  if (event.type === "batch-video-start") {
    setStatusKind("running");
    updateBatchVideo(event.videoIndex, { state: "processing", jobId: "" });
    scrollToBatchVideo(event.videoIndex);
    setStatus(event.message);
    addLog(event.message);
    setProgress(0);
    return;
  }

  if (event.type === "batch-video-done") {
    batchCompletedVideos = event.completedVideos || batchCompletedVideos + 1;
    updateBatchVideo(event.videoIndex, { state: "done", jobId: event.jobId });
    flushChunkNotify();
    notifyDesktop("合集进度", event.message || "一个视频已完成。");
    setBatchProgress(batchCompletedVideos / batchTotalVideos * 100);
    batchSummary.textContent = `${batchCompletedVideos}/${batchTotalVideos} 个视频`;
    activeJobId = event.jobId || activeJobId;
    if (event.transcript) {
      transcriptOutput.value = event.transcript;
    }
    if (event.transcriptPath) {
      transcriptPath.textContent = event.transcriptPath;
    }
    downloadButton.disabled = false;
    setStatus(event.message);
    addLog(event.message);
    return;
  }

  if (event.type === "batch-video-error") {
    batchCompletedVideos = event.completedVideos || batchCompletedVideos + 1;
    updateBatchVideo(event.videoIndex, { state: "error" });
    setStatusKind("error");
    flushChunkNotify();
    notifyDesktop("合集视频失败", event.message || "合集中的一个视频处理失败。");
    setBatchProgress(batchCompletedVideos / batchTotalVideos * 100);
    batchSummary.textContent = `${batchCompletedVideos}/${batchTotalVideos} 个视频`;
    setStatus(event.message);
    addLog(event.message);
    return;
  }

  if (event.type === "batch-done") {
    setBatchProgress(100);
    setProgress(100);
    setStatusKind("success");
    setStatus(event.message);
    addLog(event.message, "success");
    notifyDesktop("合集转写完成", event.message || "合集内全部视频已处理完毕。");
    batchSummary.textContent = `${event.completedVideos}/${event.totalVideos} 个视频 — 完成`;
    return;
  }

  // Single video events
  if (event.jobId) {
    activeJobId = event.jobId;
  }

  if (event.progress !== undefined) {
    setProgress(event.progress);
  }

  if (event.message) {
    setStatus(event.message);
    const kind = event.type === "done" || event.step === "saved" ? "success"
      : event.type === "error" ? "error"
      : "running";
    addLog(event.message, kind);
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

  if (event.progress !== undefined) {
    summaryStatus.textContent = event.step || "处理中";
  }

  if (event.type === "done") {
    setProgress(100);
    setStatusKind("success");
    setStatus("转写完成，结果已保存到本地。");
    addLog("全部视频分段已完成。", "success");
    flushChunkNotify();
    notifyDesktop("转写完成", event.title ? `《${event.title}》已全部转写完毕。` : "全部视频分段已完成。");
    answerOutput.textContent = "现在可以基于这份文稿提问。";
    downloadButton.disabled = false;
    loadJobStatus().catch(() => {});
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
  submitButton.textContent = isBusy ? "处理中..." : "提取并转写";
}

function setStatus(message) {
  statusText.textContent = message;
}

function setProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${progress}%`;
  progressBar.parentElement.setAttribute("aria-valuenow", String(Math.round(progress)));
}

function setBatchProgress(value) {
  const progress = Math.max(0, Math.min(100, Number(value) || 0));
  batchProgressBar.style.width = `${progress}%`;
}

function renderBatchList() {
  batchList.innerHTML = "";
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
  const statusEl = item.querySelector(".bv-status");
  if (statusEl) {
    statusEl.textContent = video.state === "waiting" ? "等待中" : video.state === "processing" ? "处理中" : video.state === "done" ? "已完成" : "失败";
  }
}

function scrollToBatchVideo(index) {
  const item = batchList.children[index];
  if (item) {
    item.scrollIntoView({ behavior: "smooth", block: "nearest" });
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

const desktopBridge = window.desktopBridge || null;

function notifyDesktop(title, body) {
  if (desktopBridge?.notify) {
    desktopBridge.notify({ title, body });
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
  if (desktopBridge || typeof Notification === "undefined" || Notification.permission !== "default") {
    return;
  }
  Notification.requestPermission().catch(() => {});
}

qaForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const question = questionInput.value.trim();
  const url = urlInput.value.trim();
  if (!question || askButton.disabled) {
    return;
  }

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
    if (!response.ok) {
      throw new Error(data.error || `请求失败：${response.status}`);
    }

    if (data.jobId) {
      activeJobId = data.jobId;
    }
    answerOutput.textContent = data.answer || "没有生成回答。";
  } catch (error) {
    answerOutput.textContent = `提问失败：${error.message}`;
  } finally {
    setAskBusy(false);
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

async function loadJobStatus() {
  const url = urlInput.value.trim();
  const params = new URLSearchParams();
  if (activeJobId) {
    params.set("jobId", activeJobId);
  } else if (url) {
    params.set("url", url);
  } else {
    throw new Error("请先输入 B 站链接。");
  }

  const response = await fetch(`/api/job?${params.toString()}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }

  if (data.id) {
    activeJobId = data.id;
  }
  updateJobSummary(data);
  if (data.progress !== undefined) {
    setProgress(data.progress);
  }
  if (data.transcriptPath) {
    transcriptPath.textContent = data.transcriptPath;
  }
  if (data.transcriptPreview) {
    transcriptOutput.value = data.transcriptPreview;
  }

  if (data.completedChunks > 0 && data.completedChunks >= (data.totalChunks || 1)) {
    downloadButton.disabled = false;
  }

  const next = data.nextResumeChunkHuman ? `下次从第 ${data.nextResumeChunkHuman} 段继续` : "没有待处理片段";
  setStatus(`本地进度：${data.completedChunks}/${data.totalChunks || 0} 段，${next}。`);
  addLog(`读取本地进度：${data.completedChunks}/${data.totalChunks || 0} 段。`);
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

downloadButton.addEventListener("click", () => {
  const url = urlInput.value.trim();
  const params = new URLSearchParams();
  if (activeJobId) {
    params.set("jobId", activeJobId);
  } else if (url) {
    params.set("url", url);
  }
  window.location.href = `/api/download?${params.toString()}`;
});
