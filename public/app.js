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

let activeRequest = null;
let activeJobId = "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const url = urlInput.value.trim();
  if (!url || activeRequest) {
    return;
  }

  activeRequest = new AbortController();
  activeJobId = "";
  setBusy(true);
  setProgress(0);
  updateJobSummary({ completedChunks: 0, totalChunks: 0, status: "preparing" });
  setStatus("准备任务...");
  addLog("提交 B 站链接，开始准备本地视频转写任务。");
  answerOutput.textContent = "转写完成后，可以在这里提问。";

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ url }),
      signal: activeRequest.signal
    });

    if (!response.ok || !response.body) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `请求失败：${response.status}`);
    }

    await readNdjsonStream(response.body);
  } catch (error) {
    const message = error.name === "AbortError" ? "已停止。" : `处理失败：${error.message}`;
    setStatus(message);
    addLog(message);
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
  if (event.jobId) {
    activeJobId = event.jobId;
  }

  if (event.progress !== undefined) {
    setProgress(event.progress);
  }

  if (event.message) {
    setStatus(event.message);
    addLog(event.message);
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
    setStatus("转写完成，结果已保存到本地。");
    addLog("全部视频分段已完成。");
    answerOutput.textContent = "现在可以基于这份文稿提问。";
    downloadButton.disabled = false;
    loadJobStatus().catch(() => {});
  }

  if (event.type === "error") {
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

function addLog(message) {
  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  item.textContent = `${time} ${message}`;
  logList.prepend(item);

  while (logList.children.length > 8) {
    logList.lastElementChild.remove();
  }
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
