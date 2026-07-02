const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT_DIR = __dirname;
const STATIC_DIR = path.join(ROOT_DIR, "public");
const JOBS_ROOT = path.join(ROOT_DIR, "jobs");
const DATA_DIR = path.join(ROOT_DIR, "data");
const QUITTR_STATE_PATH = path.join(DATA_DIR, "quittr-state.json");
const MAX_CHUNK_SECONDS = 120;
const MAX_TRANSCRIBE_ATTEMPTS = 3;
const CHUNKS_MANIFEST_NAME = "chunks-manifest.json";

loadEnvFile(path.join(ROOT_DIR, ".env"));

const ASR_MODEL_NAME = process.env.DASHSCOPE_ASR_MODEL || "qwen3.7-plus";
const CHAT_MODEL_NAME = process.env.DASHSCOPE_CHAT_MODEL || "qwen3.7-plus";
const API_BASE_URL = String(
  process.env.DASHSCOPE_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
).replace(/\/+$/, "");

const YTDLP_EXTRA_ARGS = parseShellArgs(process.env.YTDLP_EXTRA_ARGS || "");
fs.mkdirSync(JOBS_ROOT, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
const PORT = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "OPTIONS") {
      setCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return serveFile(res, path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/app.js") {
      return serveFile(res, path.join(STATIC_DIR, "app.js"), "application/javascript; charset=utf-8");
    }

    if (req.method === "GET" && url.pathname === "/styles.css") {
      return serveFile(res, path.join(STATIC_DIR, "styles.css"), "text/css; charset=utf-8");
    }

    if (req.method === "POST" && url.pathname === "/api/transcribe") {
      return await handleTranscribe(req, res);
    }

    if (req.method === "POST" && url.pathname === "/api/ask") {
      return await handleAsk(req, res);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return sendJson(res, 200, buildPublicConfig());
    }

    if (req.method === "GET" && url.pathname === "/api/job") {
      return handleJobStatus(url, res);
    }

    if (req.method === "GET" && url.pathname === "/api/quittr/analytics") {
      return sendJson(res, 200, buildQuittrAnalytics());
    }

    if (req.method === "POST" && url.pathname === "/api/quittr/relapses") {
      return await handleQuittrRelapse(req, res);
    }

    sendJson(res, 404, { error: "Not Found" });
  } catch (error) {
    sendJson(res, 500, { error: getErrorMessage(error) });
  }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});

async function handleQuittrRelapse(req, res) {
  await readJson(req).catch(() => ({}));
  const state = readQuittrState();
  const relapsedAt = new Date().toISOString();
  const relapses = Array.isArray(state.relapses) ? state.relapses : [];

  writeQuittrState({
    ...state,
    relapses: [...relapses, relapsedAt],
    updatedAt: relapsedAt
  });

  sendJson(res, 200, buildQuittrAnalytics());
}

function buildQuittrAnalytics(now = new Date()) {
  const state = readQuittrState();
  const startedAt = parseDate(state.startedAt) || new Date(now.getTime() - 13 * DAY_MS);
  const relapses = normalizeRelapses(state.relapses, startedAt, now);
  const streaks = buildStreaks(startedAt, relapses, now);
  const completedStreaks = streaks.filter((streak) => streak.relapseAt);
  const currentStreak = streaks[streaks.length - 1] || {
    startAt: startedAt.toISOString(),
    endAt: now.toISOString(),
    days: 0,
    relapseAt: null,
    current: true
  };
  const allDurations = streaks.map((streak) => streak.days);
  const bestStreak = Math.max(0, ...allDurations);
  const avgStreak = allDurations.length
    ? allDurations.reduce((sum, value) => sum + value, 0) / allDurations.length
    : 0;
  const currentDays = currentStreak.days;
  const rankPercent = estimateRankPercent(currentDays, bestStreak, relapses.length);
  const encouragement = getQuittrEncouragement(currentDays);

  return {
    startedAt: startedAt.toISOString(),
    generatedAt: now.toISOString(),
    currentStreakDays: roundDays(currentDays),
    currentStreakLabel: formatDaysLabel(currentDays),
    relapses: relapses.map((date) => date.toISOString()),
    streaks: streaks.map((streak, index) => ({
      id: index + 1,
      startAt: streak.startAt,
      endAt: streak.endAt,
      relapseAt: streak.relapseAt,
      days: roundDays(streak.days),
      label: formatCompactDays(streak.days),
      current: streak.current
    })),
    progressPoints: buildProgressPoints(completedStreaks, currentStreak),
    stats: {
      bestStreakDays: roundDays(bestStreak),
      bestStreakLabel: formatCompactDays(bestStreak),
      avgStreakDays: roundDays(avgStreak),
      avgStreakLabel: formatCompactDays(avgStreak),
      relapseCount: relapses.length,
      rankPercent,
      karma: Math.max(1, Math.round(currentDays + bestStreak / 2))
    },
    encouragement
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

function readQuittrState() {
  if (!fs.existsSync(QUITTR_STATE_PATH)) {
    const seeded = createDefaultQuittrState();
    writeQuittrState(seeded);
    return seeded;
  }

  const state = readJsonFile(QUITTR_STATE_PATH);
  if (!state.startedAt) {
    const seeded = createDefaultQuittrState();
    writeQuittrState(seeded);
    return seeded;
  }

  return state;
}

function writeQuittrState(state) {
  writeJsonFile(QUITTR_STATE_PATH, {
    ...state,
    updatedAt: state.updatedAt || new Date().toISOString()
  });
}

function createDefaultQuittrState(now = new Date()) {
  const day = DAY_MS;
  return {
    startedAt: new Date(now.getTime() - 34 * day).toISOString(),
    relapses: [31, 30, 27, 19, 12, 7].map((daysAgo) => new Date(now.getTime() - daysAgo * day).toISOString()),
    updatedAt: now.toISOString()
  };
}

function normalizeRelapses(relapses, startedAt, now) {
  if (!Array.isArray(relapses)) {
    return [];
  }

  const unique = new Set();
  for (const item of relapses) {
    const date = parseDate(item);
    if (!date || date <= startedAt || date > now) {
      continue;
    }
    unique.add(date.toISOString());
  }

  return [...unique].sort().map((item) => new Date(item));
}

function buildStreaks(startedAt, relapses, now) {
  const streaks = [];
  let cursor = startedAt;

  for (const relapse of relapses) {
    streaks.push(createStreak(cursor, relapse, relapse, false));
    cursor = relapse;
  }

  streaks.push(createStreak(cursor, now, null, true));
  return streaks;
}

function createStreak(start, end, relapseAt, current) {
  return {
    startAt: start.toISOString(),
    endAt: end.toISOString(),
    relapseAt: relapseAt ? relapseAt.toISOString() : null,
    days: Math.max(0, (end.getTime() - start.getTime()) / DAY_MS),
    current
  };
}

function buildProgressPoints(completedStreaks, currentStreak) {
  const points = completedStreaks.map((streak, index) => ({
    id: index + 1,
    days: roundDays(streak.days),
    type: "relapse",
    label: formatCompactDays(streak.days),
    at: streak.relapseAt
  }));

  points.push({
    id: points.length + 1,
    days: roundDays(currentStreak.days),
    type: "progress",
    label: formatCompactDays(currentStreak.days),
    at: currentStreak.endAt
  });

  return points;
}

function estimateRankPercent(currentDays, bestStreak, relapseCount) {
  const score = currentDays * 6 + bestStreak * 4 - relapseCount * 5;
  if (score >= 90) return 10;
  if (score >= 60) return 25;
  if (score >= 34) return 40;
  if (score >= 16) return 55;
  return 72;
}

function getQuittrEncouragement(days) {
  const stageDays = roundDays(days);

  if (stageDays < 2) {
    return {
      title: "First Steps Count",
      body: "Your brain is already responding to the decision. Keep the next hour simple and protect your focus."
    };
  }

  if (stageDays < 7) {
    return {
      title: "Momentum Is Building",
      body: "You may notice clearer energy and a little more control over urges. Small choices are starting to stack up."
    };
  }

  if (stageDays < 14) {
    return {
      title: "One Week Strong!",
      body: "A full week is a major milestone. Your brain is beginning to heal. You might notice improved focus and energy. This is just the beginning."
    };
  }

  return {
    title: "Deeper Reset",
    body: "Your discipline is becoming part of your identity. Expect steadier confidence, better attention, and more space between urges and action."
  };
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function roundDays(value) {
  return Math.round(value * 10) / 10;
}

function formatDaysLabel(days) {
  const roundedDays = roundDays(days);

  if (roundedDays < 1) {
    const hours = Math.max(0, Math.round(days * 24));
    return `${hours}h`;
  }
  return `${Math.round(roundedDays)}d`;
}

function formatCompactDays(days) {
  if (days < 1) {
    return `${Math.max(0, Math.round(days * 24))}h`;
  }
  return `${Math.round(days)}d`;
}

async function handleTranscribe(req, res) {
  let job = null;

  try {
    const body = await readJson(req);
    const videoUrl = String(body.url || "").trim();
    const apiKey = String(process.env.DASHSCOPE_API_KEY || "").trim();

    if (!videoUrl) {
      return sendJson(res, 400, { error: "Please provide a video URL." });
    }

    if (!apiKey) {
      return sendJson(res, 500, { error: "Missing DASHSCOPE_API_KEY in .env." });
    }

    assertRequiredCommands(["yt-dlp", "ffmpeg", "ffprobe"]);

    job = createJob(videoUrl);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.mkdirSync(job.chunksDir, { recursive: true });
    fs.mkdirSync(job.resultsDir, { recursive: true });

    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const sendEvent = (payload) => {
      if (res.writableEnded || res.destroyed) {
        return;
      }

      try {
        res.write(`${JSON.stringify(payload)}\n`);
      } catch {
        // Keep the background job moving even if the browser connection closes.
      }
    };

    sendEvent({
      type: "status",
      step: "prepare",
      message: `Preparing resumable job ${job.id}...`
    });
    updateCheckpoint(job, {
      id: job.id,
      sourceUrl: videoUrl,
      asrModel: ASR_MODEL_NAME,
      chunkSeconds: MAX_CHUNK_SECONDS,
      status: "preparing"
    });

    const existingTranscript = readTextFile(job.transcriptPath);
    if (existingTranscript) {
      sendEvent({
        type: "partial",
        transcript: existingTranscript,
        transcriptPath: job.transcriptPath
      });
    }

    const info = await downloadVideo(videoUrl, job, sendEvent);
    sendEvent({
      type: "status",
      step: "downloaded",
      message: `已下载视频：${info.title}`
    });

    const metadata = {
      id: job.id,
      sourceUrl: videoUrl,
      title: info.title,
      asrModel: ASR_MODEL_NAME,
      chatModel: CHAT_MODEL_NAME,
      chunkSeconds: MAX_CHUNK_SECONDS,
      updatedAt: new Date().toISOString(),
      transcriptPath: job.transcriptPath
    };
    writeJsonFile(job.metadataPath, metadata);
    updateCheckpoint(job, {
      ...metadata,
      status: "downloaded",
      sourcePath: info.sourcePath || "",
      videoPath: info.videoPath
    });

    const chunks = await splitVideo(info.videoPath, job, sendEvent);
    sendEvent({
      type: "status",
      step: "chunks_ready",
      message: `视频已切成 ${chunks.length} 段。`
    });
    updateCheckpoint(job, {
      id: job.id,
      sourceUrl: videoUrl,
      title: info.title,
      asrModel: ASR_MODEL_NAME,
      totalChunks: chunks.length,
      completedChunks: countCompletedChunks(job, chunks.length),
      lastCompletedChunk: getLastCompletedChunk(job, chunks.length),
      status: "chunks_ready",
      transcriptPath: job.transcriptPath
    });

    for (let index = 0; index < chunks.length; index += 1) {
      const chunkPath = chunks[index];
      const resultPath = getChunkResultPath(job, index);
      const existingChunkText = readTextFile(resultPath);

      if (existingChunkText) {
        const transcript = rebuildTranscript(job, chunks.length);
        updateCheckpoint(job, {
          id: job.id,
          sourceUrl: videoUrl,
          title: info.title,
          asrModel: ASR_MODEL_NAME,
          totalChunks: chunks.length,
          completedChunks: countCompletedChunks(job, chunks.length),
          lastCompletedChunk: getLastCompletedChunk(job, chunks.length),
          status: countCompletedChunks(job, chunks.length) === chunks.length ? "complete" : "transcribing",
          transcriptPath: job.transcriptPath
        });
        sendEvent({
          type: "partial",
          jobId: job.id,
          transcript,
          transcriptPath: job.transcriptPath
        });
        sendEvent({
          type: "status",
          step: "resume",
          message: `跳过已完成视频段 ${index + 1}/${chunks.length}。`,
          progress: Math.round(((index + 1) / chunks.length) * 100)
        });
        continue;
      }

      sendEvent({
        type: "status",
        step: "transcribing",
        message: `正在识别视频段 ${index + 1}/${chunks.length}...`,
        progress: Math.round((index / chunks.length) * 100)
      });
      updateCheckpoint(job, {
        id: job.id,
        sourceUrl: videoUrl,
        title: info.title,
        asrModel: ASR_MODEL_NAME,
        totalChunks: chunks.length,
        completedChunks: countCompletedChunks(job, chunks.length),
        lastCompletedChunk: getLastCompletedChunk(job, chunks.length),
        currentChunk: index,
        status: "transcribing",
        transcriptPath: job.transcriptPath
      });
      const piece = await transcribeChunkWithRetry({
        apiKey,
        chunkPath,
        job,
        index,
        totalChunks: chunks.length,
        sendEvent
      });

      writeTextFileAtomic(resultPath, piece.trim() ? `${piece.trim()}\n` : "");
      const transcript = rebuildTranscript(job, chunks.length);
      updateCheckpoint(job, {
        id: job.id,
        sourceUrl: videoUrl,
        title: info.title,
        asrModel: ASR_MODEL_NAME,
        totalChunks: chunks.length,
        lastCompletedChunk: index,
        completedChunks: countCompletedChunks(job, chunks.length),
        currentChunk: null,
        status: countCompletedChunks(job, chunks.length) === chunks.length ? "complete" : "transcribing",
        transcriptPath: job.transcriptPath
      });

      sendEvent({
        type: "partial",
        jobId: job.id,
        transcript,
        transcriptPath: job.transcriptPath
      });
      sendEvent({
        type: "status",
        step: "saved",
        message: `已保存视频段 ${index + 1}/${chunks.length} 到 transcript.txt。`,
        progress: Math.round(((index + 1) / chunks.length) * 100)
      });
    }

    const finalText = readTextFile(job.transcriptPath).trim();
    updateCheckpoint(job, {
      id: job.id,
      sourceUrl: videoUrl,
      title: info.title,
      asrModel: ASR_MODEL_NAME,
      totalChunks: chunks.length,
      completedChunks: chunks.length,
      lastCompletedChunk: chunks.length - 1,
      currentChunk: null,
      status: "complete",
      completedAt: new Date().toISOString(),
      transcriptPath: job.transcriptPath
    });
    sendEvent({
      type: "done",
      jobId: job.id,
      title: info.title,
      sourceUrl: videoUrl,
      transcript: finalText,
      transcriptPath: job.transcriptPath,
      progress: 100
    });
    res.end();
  } catch (error) {
    const message = getErrorMessage(error);

    if (job?.checkpointPath) {
      const checkpoint = readJsonFile(job.checkpointPath);
      updateCheckpoint(job, {
        ...checkpoint,
        id: job.id,
        status: "failed",
        failedAt: new Date().toISOString(),
        error: message,
        transcriptPath: job.transcriptPath
      });
    }

    if (!res.headersSent) {
      return sendJson(res, 500, { error: message });
    }

    if (!res.writableEnded && !res.destroyed) {
      res.write(`${JSON.stringify({ type: "error", error: message })}\n`);
    }
    res.end();
  }
}

async function handleAsk(req, res) {
  try {
    const body = await readJson(req);
    const apiKey = String(process.env.DASHSCOPE_API_KEY || "").trim();
    const question = String(body.question || "").trim();
    const sourceUrl = String(body.url || "").trim();
    const jobId = String(body.jobId || "").trim();

    if (!apiKey) {
      return sendJson(res, 500, { error: "Missing DASHSCOPE_API_KEY in .env." });
    }

    if (!question) {
      return sendJson(res, 400, { error: "Please provide a question." });
    }

    const job = jobId ? getJobById(jobId) : sourceUrl ? createJob(sourceUrl) : null;
    if (!job || !fs.existsSync(job.transcriptPath)) {
      return sendJson(res, 404, { error: "还没有找到可用文稿，请先完成一次转写。" });
    }

    const transcript = readTextFile(job.transcriptPath).trim();
    if (!transcript) {
      return sendJson(res, 400, { error: "文稿为空，请先完成转写。" });
    }

    const metadata = readJsonFile(job.metadataPath);
    const answer = await askAboutTranscript({
      apiKey,
      question,
      transcript,
      title: metadata.title || "未命名视频",
      sourceUrl: metadata.sourceUrl || sourceUrl || ""
    });

    sendJson(res, 200, {
      answer,
      jobId: job.id,
      transcriptPath: job.transcriptPath
    });
  } catch (error) {
    sendJson(res, 500, { error: getErrorMessage(error) });
  }
}

function handleJobStatus(url, res) {
  const sourceUrl = String(url.searchParams.get("url") || "").trim();
  const jobId = String(url.searchParams.get("jobId") || "").trim();
  const job = jobId ? getJobById(jobId) : sourceUrl ? createJob(sourceUrl) : null;

  if (!job) {
    return sendJson(res, 400, { error: "Please provide url or jobId." });
  }

  if (!fs.existsSync(job.dir)) {
    return sendJson(res, 404, { error: "还没有找到这个链接的本地任务。" });
  }

  return sendJson(res, 200, buildJobStatus(job));
}

async function prepareAudio(videoUrl, job, sendEvent) {
  const existingMetadata = readJsonFile(job.metadataPath);
  let existingSourcePath = findFirstFile(job.dir, /^source\.(m4a|mp3|webm|mp4|mkv|mov|m4v|wav|aac|opus)$/i);

  if (fs.existsSync(job.audioPath) && await isValidMediaFile(job.audioPath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "找到已有规范化音频，跳过下载。"
    });
    return {
      title: existingMetadata.title || await fetchVideoTitle(videoUrl),
      sourcePath: existingSourcePath,
      audioPath: job.audioPath
    };
  }

  if (fs.existsSync(job.audioPath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "找到未完成的音频文件，重新生成。"
    });
    removeFileIfExists(job.audioPath);
  }

  if (existingSourcePath && !await isValidMediaFile(existingSourcePath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "找到未完成的源音频，重新下载。"
    });
    removeFileIfExists(existingSourcePath);
    existingSourcePath = "";
  }

  let sourcePath = existingSourcePath;
  const outputTemplate = path.join(job.dir, "source.%(ext)s");

  if (!sourcePath) {
    sendEvent({
      type: "status",
      step: "download",
      message: "正在用 yt-dlp 提取 B 站音频..."
    });

    await downloadAudioWithYtDlp(videoUrl, outputTemplate, job, sendEvent);

    sourcePath = findFirstFile(job.dir, /^source\.(m4a|mp3|webm|mp4|mkv|mov|m4v|wav|aac|opus)$/i);
    if (sourcePath && !await isValidMediaFile(sourcePath)) {
      removeFileIfExists(sourcePath);
      sourcePath = "";
    }
  } else {
    sendEvent({
      type: "status",
      step: "resume",
      message: "找到已有源音频，跳过下载。"
    });
  }

  if (!sourcePath) {
    throw new Error("Could not find downloaded audio file.");
  }

  sendEvent({
    type: "status",
    step: "normalize",
    message: "正在用 ffmpeg 规范化音频..."
  });

  const normalizedTmpPath = path.join(job.dir, `audio.tmp-${process.pid}-${Date.now()}.mp3`);
  removeFileIfExists(normalizedTmpPath);
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    normalizedTmpPath
  ], {
    cwd: job.dir
  });

  if (!await isValidMediaFile(normalizedTmpPath)) {
    removeFileIfExists(normalizedTmpPath);
    throw new Error("Audio normalization completed but the output file is not readable.");
  }

  fs.renameSync(normalizedTmpPath, job.audioPath);
  const title = existingMetadata.title || await fetchVideoTitle(videoUrl);
  return {
    title,
    sourcePath,
    audioPath: job.audioPath
  };
}

async function splitAudio(audioPath, job, sendEvent) {
  const durationSeconds = await getMediaDuration(audioPath);
  if (durationSeconds <= MAX_CHUNK_SECONDS) {
    writeChunksManifest(job, {
      kind: "audio",
      totalChunks: 1,
      chunkSeconds: MAX_CHUNK_SECONDS,
      durationSeconds,
      chunks: [path.basename(audioPath)],
      singleFile: true
    });
    return [audioPath];
  }

  const reusableChunks = await getReusableChunks(job, durationSeconds);
  if (reusableChunks.length > 0) {
    sendEvent({
      type: "status",
      step: "resume",
      message: `找到 ${reusableChunks.length} 个完整音频分段，跳过切分。`
    });
    return reusableChunks;
  }

  if (getExistingChunks(job).length > 0) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "找到未完成的音频分段，重新切分。"
    });
  }

  sendEvent({
    type: "status",
    step: "split",
    message: `音频 ${Math.ceil(durationSeconds)} 秒，正在按 ${MAX_CHUNK_SECONDS} 秒切分...`
  });

  updateCheckpoint(job, {
    status: "splitting",
    durationSeconds,
    expectedChunks: Math.ceil(durationSeconds / MAX_CHUNK_SECONDS),
    chunkSeconds: MAX_CHUNK_SECONDS
  });

  const tempChunksDir = path.join(job.dir, `chunks.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempChunksDir, { recursive: true });

  try {
    const chunkPattern = path.join(tempChunksDir, "chunk-%03d.mp3");
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      audioPath,
      "-f",
      "segment",
      "-segment_time",
      String(MAX_CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "32k",
      chunkPattern
    ], {
      cwd: job.dir
    });

    const chunkFiles = listChunkFiles(tempChunksDir);

    if (chunkFiles.length === 0) {
      throw new Error("Audio splitting completed but no chunk files were produced.");
    }

    for (const chunkFile of chunkFiles) {
      if (!await isValidMediaFile(chunkFile)) {
        throw new Error(`Audio splitting produced an unreadable chunk: ${path.basename(chunkFile)}`);
      }
    }

    cleanChunkFiles(job);
    fs.mkdirSync(job.chunksDir, { recursive: true });
    for (const chunkFile of chunkFiles) {
      fs.renameSync(chunkFile, path.join(job.chunksDir, path.basename(chunkFile)));
    }

    const finalChunks = getExistingChunks(job);
    writeChunksManifest(job, {
      kind: "audio",
      totalChunks: finalChunks.length,
      chunkSeconds: MAX_CHUNK_SECONDS,
      durationSeconds,
      chunks: finalChunks.map((chunkPath) => path.basename(chunkPath)),
      singleFile: false
    });

    return finalChunks;
  } finally {
    fs.rmSync(tempChunksDir, { recursive: true, force: true });
  }
}

async function downloadVideo(videoUrl, job, sendEvent) {
  const existingMetadata = readJsonFile(job.metadataPath);
  let existingSourcePath = findFirstFile(job.dir, /^source\.(mp4|mkv|webm|mov|m4v)$/i);

  if (fs.existsSync(job.normalizedPath) && await isValidMediaFile(job.normalizedPath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "Found existing normalized video, skipping download."
    });
    return {
      title: existingMetadata.title || await fetchVideoTitle(videoUrl),
      sourcePath: existingSourcePath,
      videoPath: job.normalizedPath
    };
  }

  if (fs.existsSync(job.normalizedPath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "Found incomplete normalized video, rebuilding it."
    });
    removeFileIfExists(job.normalizedPath);
  }

  if (existingSourcePath && !await isValidMediaFile(existingSourcePath)) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "Found incomplete source video, downloading it again."
    });
    removeFileIfExists(existingSourcePath);
    existingSourcePath = "";
  }

  let sourcePath = existingSourcePath;
  const outputTemplate = path.join(job.dir, "source.%(ext)s");

  if (!sourcePath) {
    sendEvent({
      type: "status",
      step: "download",
      message: "Downloading video with yt-dlp..."
    });

    await downloadWithYtDlp(videoUrl, outputTemplate, job, sendEvent);

    sourcePath = findFirstFile(job.dir, /^source\.(mp4|mkv|webm|mov|m4v)$/i);
    if (sourcePath && !await isValidMediaFile(sourcePath)) {
      removeFileIfExists(sourcePath);
      sourcePath = "";
    }
  } else {
    sendEvent({
      type: "status",
      step: "resume",
      message: "Found existing source video, skipping download."
    });
  }

  if (!sourcePath) {
    throw new Error("Could not find downloaded video file.");
  }

  sendEvent({
    type: "status",
    step: "normalize",
    message: "Normalizing video with ffmpeg..."
  });

  const normalizedTmpPath = path.join(job.dir, `normalized.tmp-${process.pid}-${Date.now()}.mp4`);
  removeFileIfExists(normalizedTmpPath);
  await runCommand("ffmpeg", [
    "-y",
    "-i",
    sourcePath,
    "-vf",
    "scale='min(640,iw)':-2",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "36",
    "-maxrate",
    "800k",
    "-bufsize",
    "1600k",
    "-c:a",
    "aac",
    "-b:a",
    "32k",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-movflags",
    "+faststart",
    normalizedTmpPath
  ], {
    cwd: job.dir
  });

  if (!await isValidMediaFile(normalizedTmpPath)) {
    removeFileIfExists(normalizedTmpPath);
    throw new Error("Video normalization completed but the output file is not readable.");
  }

  fs.renameSync(normalizedTmpPath, job.normalizedPath);
  const title = existingMetadata.title || await fetchVideoTitle(videoUrl);
  return {
    title,
    sourcePath,
    videoPath: job.normalizedPath
  };
}

async function splitVideo(videoPath, job, sendEvent) {
  const durationSeconds = await getMediaDuration(videoPath);
  if (durationSeconds <= MAX_CHUNK_SECONDS) {
    writeChunksManifest(job, {
      kind: "video",
      totalChunks: 1,
      chunkSeconds: MAX_CHUNK_SECONDS,
      durationSeconds,
      chunks: [path.basename(videoPath)],
      singleFile: true
    });
    return [videoPath];
  }

  const reusableChunks = await getReusableChunks(job, durationSeconds, "video");
  if (reusableChunks.length > 0) {
    sendEvent({
      type: "status",
      step: "resume",
      message: `Found ${reusableChunks.length} complete video chunk(s), skipping split.`
    });
    return reusableChunks;
  }

  if (getExistingChunks(job).length > 0) {
    sendEvent({
      type: "status",
      step: "resume",
      message: "Found incomplete video chunks, rebuilding the chunk set."
    });
  }

  sendEvent({
    type: "status",
    step: "split",
    message: `Video is ${Math.ceil(durationSeconds)}s long, splitting into ${MAX_CHUNK_SECONDS}s chunks...`
  });

  updateCheckpoint(job, {
    status: "splitting",
    durationSeconds,
    expectedChunks: Math.ceil(durationSeconds / MAX_CHUNK_SECONDS),
    chunkSeconds: MAX_CHUNK_SECONDS
  });

  const tempChunksDir = path.join(job.dir, `chunks.tmp-${process.pid}-${Date.now()}`);
  fs.mkdirSync(tempChunksDir, { recursive: true });

  try {
    const chunkPattern = path.join(tempChunksDir, "chunk-%03d.mp4");
    await runCommand("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-f",
      "segment",
      "-segment_time",
      String(MAX_CHUNK_SECONDS),
      "-reset_timestamps",
      "1",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "36",
      "-maxrate",
      "800k",
      "-bufsize",
      "1600k",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-ac",
      "1",
      "-ar",
      "16000",
      chunkPattern
    ], {
      cwd: job.dir
    });

    const chunkFiles = listChunkFiles(tempChunksDir);

    if (chunkFiles.length === 0) {
      throw new Error("Video splitting completed but no chunk files were produced.");
    }

    for (const chunkFile of chunkFiles) {
      if (!await isValidMediaFile(chunkFile)) {
        throw new Error(`Video splitting produced an unreadable chunk: ${path.basename(chunkFile)}`);
      }
    }

    cleanChunkFiles(job);
    fs.mkdirSync(job.chunksDir, { recursive: true });
    for (const chunkFile of chunkFiles) {
      fs.renameSync(chunkFile, path.join(job.chunksDir, path.basename(chunkFile)));
    }

    const finalChunks = getExistingChunks(job);
    writeChunksManifest(job, {
      kind: "video",
      totalChunks: finalChunks.length,
      chunkSeconds: MAX_CHUNK_SECONDS,
      durationSeconds,
      chunks: finalChunks.map((chunkPath) => path.basename(chunkPath)),
      singleFile: false
    });

    return finalChunks;
  } finally {
    fs.rmSync(tempChunksDir, { recursive: true, force: true });
  }
}

async function downloadWithYtDlp(videoUrl, outputTemplate, job, sendEvent) {
  const strategies = buildYtDlpStrategies(videoUrl, outputTemplate);
  let lastError = null;

  for (const strategy of strategies) {
    sendEvent({
      type: "status",
      step: "download",
      message: strategy.label
    });
    updateCheckpoint(job, {
      status: "downloading",
      downloadStrategy: strategy.name
    });

    try {
      await runCommand("yt-dlp", strategy.args, { cwd: job.dir });
      return;
    } catch (error) {
      lastError = error;
      sendEvent({
        type: "status",
        step: "download_retry",
        message: `${strategy.name} failed, trying next download strategy...`
      });
    }
  }

  throw new Error(formatYtDlpError(lastError));
}

async function downloadAudioWithYtDlp(videoUrl, outputTemplate, job, sendEvent) {
  const strategies = buildYtDlpStrategies(videoUrl, outputTemplate, {
    audioOnly: true
  });
  let lastError = null;

  for (const strategy of strategies) {
    sendEvent({
      type: "status",
      step: "download",
      message: strategy.label
    });
    updateCheckpoint(job, {
      status: "downloading",
      downloadStrategy: strategy.name
    });

    try {
      await runCommand("yt-dlp", strategy.args, { cwd: job.dir });
      return;
    } catch (error) {
      lastError = error;
      sendEvent({
        type: "status",
        step: "download_retry",
        message: `${strategy.name} 下载失败，正在尝试下一种方式...`
      });
    }
  }

  throw new Error(formatYtDlpError(lastError));
}

function buildYtDlpStrategies(videoUrl, outputTemplate, options = {}) {
  const baseArgs = [
    "--no-playlist",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--extractor-retries",
    "5",
    "--retry-sleep",
    "linear=1::3",
    "--socket-timeout",
    "30",
    "--output",
    outputTemplate,
    ...YTDLP_EXTRA_ARGS
  ];

  if (options.audioOnly) {
    baseArgs.unshift("-f", "ba/bestaudio");
  } else {
    baseArgs.unshift("--merge-output-format", "mp4");
  }

  const strategies = [
    {
      name: "default",
      label: options.audioOnly ? "正在下载最佳音频..." : "Downloading video with yt-dlp..."
    },
    {
      name: "ipv4",
      label: options.audioOnly ? "正在通过 IPv4 重试音频下载..." : "Retrying download over IPv4...",
      args: ["--force-ipv4"]
    },
    {
      name: "legacy_tls",
      label: options.audioOnly ? "正在用 legacy TLS 兼容模式重试..." : "Retrying download with legacy TLS compatibility...",
      args: ["--legacy-server-connect"]
    },
    {
      name: "ipv4_no_certificate_check",
      label: options.audioOnly ? "正在通过 IPv4 且跳过证书校验重试..." : "Retrying download over IPv4 without certificate validation...",
      args: ["--force-ipv4", "--no-check-certificates"]
    }
  ];

  return strategies.map((strategy) => ({
    ...strategy,
    args: [
      ...baseArgs,
      ...(strategy.args || []),
      videoUrl
    ]
  }));
}

function formatYtDlpError(error) {
  const message = getErrorMessage(error);
  if (/HTTP Error 412|Precondition Failed/i.test(message)) {
    return [
      "B 站拒绝了 yt-dlp 的网页请求：HTTP 412 Precondition Failed。",
      "这通常需要带上你本人浏览器里的 B 站登录 cookies。",
      "优先尝试在 Chrome 登录 B 站后设置：YTDLP_EXTRA_ARGS=\"--no-update --cookies-from-browser chrome --user-agent Mozilla/5.0 --referer https://www.bilibili.com/ --add-headers Accept-Language:zh-CN,zh;q=0.9,en;q=0.8\"。",
      "如果读取浏览器 cookies 失败，再导出 Netscape 格式 cookies.txt 放到项目根目录，并设置：YTDLP_EXTRA_ARGS=\"--no-update --cookies cookies.txt --user-agent Mozilla/5.0 --referer https://www.bilibili.com/ --add-headers Accept-Language:zh-CN,zh;q=0.9,en;q=0.8\"。",
      `原始错误：${message}`
    ].join("\n");
  }

  if (/UNEXPECTED_EOF_WHILE_READING|SSLError|SSL/i.test(message)) {
    return [
      "yt-dlp 下载视频时 SSL 连接被中断。",
      "我已经自动尝试了普通下载、IPv4、legacy TLS 和跳过证书校验，但仍未成功。",
      "这通常是 B 站连接、代理/VPN、证书链或网络运营商导致的。",
      "可以在 .env 里设置 YTDLP_EXTRA_ARGS，例如：YTDLP_EXTRA_ARGS=\"--proxy http://127.0.0.1:7890 --cookies-from-browser chrome\"。",
      `原始错误：${message}`
    ].join("\n");
  }

  return message;
}

async function transcribeChunk({ apiKey, chunkPath }) {
  const videoBase64 = fs.readFileSync(chunkPath).toString("base64");
  const body = {
    model: ASR_MODEL_NAME,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "video_url",
            video_url: {
              url: `data:video/mp4;base64,${videoBase64}`
            }
          },
          {
            type: "text",
            text: [
              "请把这段视频中的中文、英文或其他语言口播尽可能完整地转写成连续文字。",
              "不要总结，不要补充解释，不要输出无关内容。",
              "如果有明显听不清的片段，用[不清晰]标记。"
            ].join("")
          }
        ]
      }
    ],
    stream: true
  };

  const text = await callDashScopeChat(apiKey, body);
  if (!text) {
    throw new Error("DashScope returned no transcript text.");
  }

  return text;
}

async function transcribeChunkWithRetry({ apiKey, chunkPath, job, index, totalChunks, sendEvent }) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_TRANSCRIBE_ATTEMPTS; attempt += 1) {
    try {
      if (attempt > 1) {
        sendEvent({
          type: "status",
          step: "retry",
          message: `第 ${index + 1}/${totalChunks} 段识别失败后重试 ${attempt}/${MAX_TRANSCRIBE_ATTEMPTS}...`
        });
      }

      updateCheckpoint(job, {
        currentChunk: index,
        currentChunkHuman: index + 1,
        status: "transcribing",
        transcribeAttempt: attempt
      });
      return await transcribeChunk({ apiKey, chunkPath });
    } catch (error) {
      lastError = error;
      updateCheckpoint(job, {
        currentChunk: index,
        currentChunkHuman: index + 1,
        status: "transcribing",
        transcribeAttempt: attempt,
        lastChunkError: getErrorMessage(error)
      });

      if (!isRetryableTranscribeError(error) || attempt === MAX_TRANSCRIBE_ATTEMPTS) {
        break;
      }

      await delay(1000 * attempt);
    }
  }

  throw lastError;
}

function isRetryableTranscribeError(error) {
  const message = getErrorMessage(error);
  return /timeout|timed out|socket|network|ECONN|ETIMEDOUT|429|rate|Too Many|500|502|503|504|Bad Gateway|Service Unavailable/i.test(message);
}

async function askAboutTranscript({ apiKey, question, transcript, title, sourceUrl }) {
  const trimmedTranscript = limitTextByChars(transcript, 90000);
  const body = {
    model: CHAT_MODEL_NAME,
    messages: [
      {
        role: "system",
        content: [
          "你是一个视频文稿问答助手。",
          "只基于用户提供的视频文稿回答问题；如果文稿里没有依据，请明确说文稿中没有相关信息。",
          "回答要直接、清楚，必要时引用文稿中的关键句，但不要编造时间戳。"
        ].join("")
      },
      {
        role: "user",
        content: [
          `视频标题：${title}`,
          sourceUrl ? `来源链接：${sourceUrl}` : "",
          "视频文稿：",
          trimmedTranscript,
          "",
          `问题：${question}`
        ].filter(Boolean).join("\n")
      }
    ],
    stream: true
  };

  const text = await callDashScopeChat(apiKey, body);
  if (!text) {
    throw new Error("DashScope returned no answer text.");
  }

  return text;
}

async function callDashScopeChat(apiKey, body) {
  const response = await fetch(`${API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    const detail = formatDashScopeDetail(data, response.statusText);
    throw new Error(formatDashScopeError(detail));
  }

  const raw = await response.text();
  const contentType = response.headers.get("content-type") || "";
  if (/text\/event-stream/i.test(contentType) || /^\s*data:/m.test(raw)) {
    return extractTextFromSse(raw);
  }

  return extractTextFromDashScope(JSON.parse(raw || "{}"));
}

function extractTextFromSse(text) {
  const parts = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") {
      continue;
    }

    const data = JSON.parse(payload);
    const choices = data?.choices || data?.output?.choices || [];
    for (const choice of choices) {
      const items = [choice?.delta, choice?.message];
      for (const item of items) {
        if (typeof item?.content === "string") {
          parts.push(item.content);
        } else if (Array.isArray(item?.content)) {
          for (const contentItem of item.content) {
            if (typeof contentItem?.text === "string") {
              parts.push(contentItem.text);
            }
          }
        }
      }
    }
  }

  return parts.join("").trim();
}

function extractTextFromDashScope(data) {
  const candidates = [];

  if (typeof data?.output?.text === "string") {
    candidates.push(data.output.text);
  }

  const choices = data?.choices || data?.output?.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      if (typeof choice?.message?.content === "string") {
        candidates.push(choice.message.content);
      }

      if (Array.isArray(choice?.message?.content)) {
        for (const item of choice.message.content) {
          if (typeof item?.text === "string") {
            candidates.push(item.text);
          }
        }
      }
    }
  }

  return candidates.map((item) => item.trim()).find(Boolean) || "";
}

function limitTextByChars(text, maxChars) {
  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars)}\n\n[文稿过长，已截取前 ${maxChars} 个字符用于本次问答]`;
}

function buildJobStatus(job) {
  const checkpoint = readJsonFile(job.checkpointPath);
  const metadata = readJsonFile(job.metadataPath);
  const manifest = readJsonFile(job.chunksManifestPath);
  const totalChunks = Number(checkpoint.totalChunks || manifest.totalChunks || 0);
  const completedChunks = totalChunks ? countCompletedChunks(job, totalChunks) : listCompletedResultFiles(job).length;
  const lastCompletedChunk = totalChunks ? getLastCompletedChunk(job, totalChunks) : getLastCompletedResultIndex(job);
  const nextResumeChunk = totalChunks ? findNextIncompleteChunk(job, totalChunks) : null;
  const videoExists = fs.existsSync(job.normalizedPath);
  const transcript = readTextFile(job.transcriptPath);

  return {
    id: job.id,
    sourceUrl: checkpoint.sourceUrl || metadata.sourceUrl || "",
    title: checkpoint.title || metadata.title || "",
    status: checkpoint.status || "unknown",
    totalChunks,
    completedChunks,
    currentChunk: checkpoint.currentChunk ?? null,
    currentChunkHuman: checkpoint.currentChunk != null ? checkpoint.currentChunk + 1 : null,
    lastCompletedChunk,
    lastCompletedChunkHuman: lastCompletedChunk != null ? lastCompletedChunk + 1 : null,
    nextResumeChunk,
    nextResumeChunkHuman: nextResumeChunk != null ? nextResumeChunk + 1 : null,
    progress: totalChunks ? Math.round((completedChunks / totalChunks) * 100) : 0,
    videoPath: videoExists ? job.normalizedPath : "",
    audioPath: videoExists ? job.normalizedPath : "",
    chunksDir: fs.existsSync(job.chunksDir) ? job.chunksDir : "",
    resultsDir: fs.existsSync(job.resultsDir) ? job.resultsDir : "",
    transcriptPath: fs.existsSync(job.transcriptPath) ? job.transcriptPath : "",
    transcriptPreview: transcript.trim().slice(0, 2000),
    error: checkpoint.error || "",
    lastChunkError: checkpoint.lastChunkError || "",
    updatedAt: checkpoint.updatedAt || metadata.updatedAt || ""
  };
}

function listCompletedResultFiles(job) {
  if (!fs.existsSync(job.resultsDir)) {
    return [];
  }

  return fs.readdirSync(job.resultsDir)
    .filter((name) => /^chunk-\d{3}\.txt$/i.test(name))
    .sort()
    .filter((name) => readTextFile(path.join(job.resultsDir, name)).trim());
}

function getLastCompletedResultIndex(job) {
  const files = listCompletedResultFiles(job);
  if (!files.length) {
    return null;
  }

  const match = files[files.length - 1].match(/chunk-(\d{3})\.txt/i);
  return match ? Number(match[1]) : null;
}

function findNextIncompleteChunk(job, totalChunks) {
  for (let index = 0; index < totalChunks; index += 1) {
    if (!readTextFile(getChunkResultPath(job, index)).trim()) {
      return index;
    }
  }

  return null;
}

function buildPublicConfig() {
  const apiKey = String(process.env.DASHSCOPE_API_KEY || "");
  return {
    dashscope: {
      apiKeyConfigured: Boolean(apiKey.trim()),
      apiKeyLength: apiKey.length || 0,
      baseUrl: API_BASE_URL,
      asrModel: ASR_MODEL_NAME,
      chatModel: CHAT_MODEL_NAME
    },
    ytdlpExtraArgsConfigured: YTDLP_EXTRA_ARGS.length > 0
  };
}

function formatDashScopeError(detail) {
  if (/unauthorized|invalid api[-_ ]?key|401/i.test(String(detail))) {
    return [
      `DashScope request failed: ${detail}`,
      `当前 Base URL：${API_BASE_URL}`,
      `当前 ASR 模型：${ASR_MODEL_NAME}`,
      "这通常表示 DASHSCOPE_API_KEY 无效，或 API Key 与 DASHSCOPE_BASE_URL 不属于同一个百炼工作空间。",
      "请在 .env 中补充正确的 DASHSCOPE_BASE_URL，例如：https://你的工作空间ID.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，然后重启服务。"
    ].join("\n");
  }

  return `DashScope request failed: ${detail}`;
}

function formatDashScopeDetail(data, fallback) {
  const parts = [];

  for (const key of ["code", "message", "request_id", "requestId"]) {
    if (data && data[key]) {
      parts.push(`${key}=${data[key]}`);
    }
  }

  if (Array.isArray(data?.errors)) {
    parts.push(`errors=${JSON.stringify(data.errors)}`);
  }

  if (data?.error) {
    parts.push(`error=${typeof data.error === "string" ? data.error : JSON.stringify(data.error)}`);
  }

  return parts.join("; ") || fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJob(videoUrl) {
  const id = crypto.createHash("sha256").update(videoUrl).digest("hex").slice(0, 16);
  const dir = path.join(JOBS_ROOT, id);
  return {
    id,
    dir,
    chunksDir: path.join(dir, "chunks"),
    resultsDir: path.join(dir, "results"),
    chunksManifestPath: path.join(dir, CHUNKS_MANIFEST_NAME),
    metadataPath: path.join(dir, "metadata.json"),
    checkpointPath: path.join(dir, "checkpoint.json"),
    normalizedPath: path.join(dir, "normalized.mp4"),
    audioPath: path.join(dir, "audio.mp3"),
    transcriptPath: path.join(dir, "transcript.txt")
  };
}

function getJobById(jobId) {
  if (!/^[a-f0-9]{16}$/i.test(jobId)) {
    return null;
  }

  const dir = path.join(JOBS_ROOT, jobId);
  return {
    id: jobId,
    dir,
    chunksDir: path.join(dir, "chunks"),
    resultsDir: path.join(dir, "results"),
    chunksManifestPath: path.join(dir, CHUNKS_MANIFEST_NAME),
    metadataPath: path.join(dir, "metadata.json"),
    checkpointPath: path.join(dir, "checkpoint.json"),
    normalizedPath: path.join(dir, "normalized.mp4"),
    audioPath: path.join(dir, "audio.mp3"),
    transcriptPath: path.join(dir, "transcript.txt")
  };
}

function getExistingChunks(job) {
  return listChunkFiles(job.chunksDir);
}

function listChunkFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .filter((name) => /^chunk-\d{3}\.(mp3|mp4)$/i.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

async function getReusableChunks(job, durationSeconds, kind = "audio") {
  const manifest = readJsonFile(job.chunksManifestPath);
  const manifestDuration = Number(manifest.durationSeconds);
  if (
    manifest.kind !== kind ||
    manifest.chunkSeconds !== MAX_CHUNK_SECONDS ||
    !Number.isFinite(manifestDuration) ||
    Math.abs(manifestDuration - durationSeconds) > 1 ||
    !Array.isArray(manifest.chunks) ||
    manifest.chunks.length === 0 ||
    manifest.totalChunks !== manifest.chunks.length
  ) {
    return [];
  }

  const chunks = manifest.chunks.map((name) => path.join(job.chunksDir, path.basename(name)));
  if (chunks.some((chunkPath) => !fs.existsSync(chunkPath))) {
    return [];
  }

  for (const chunkPath of chunks) {
    if (!await isValidMediaFile(chunkPath)) {
      return [];
    }
  }

  return chunks;
}

function writeChunksManifest(job, payload) {
  writeJsonFile(job.chunksManifestPath, {
    ...payload,
    updatedAt: new Date().toISOString()
  });
}

function cleanChunkFiles(job) {
  fs.mkdirSync(job.chunksDir, { recursive: true });
  for (const chunkPath of getExistingChunks(job)) {
    removeFileIfExists(chunkPath);
  }
  removeFileIfExists(job.chunksManifestPath);
}

function getChunkResultPath(job, index) {
  return path.join(job.resultsDir, `chunk-${String(index).padStart(3, "0")}.txt`);
}

function rebuildTranscript(job, totalChunks) {
  const parts = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const text = readTextFile(getChunkResultPath(job, index)).trim();
    if (!text) {
      continue;
    }

    parts.push(`## Chunk ${index + 1}\n\n${text}`);
  }

  const transcript = parts.join("\n\n").trim();
  writeTextFileAtomic(job.transcriptPath, transcript ? `${transcript}\n` : "");
  return transcript;
}

function countCompletedChunks(job, totalChunks) {
  let count = 0;
  for (let index = 0; index < totalChunks; index += 1) {
    if (readTextFile(getChunkResultPath(job, index)).trim()) {
      count += 1;
    }
  }
  return count;
}

function getLastCompletedChunk(job, totalChunks) {
  for (let index = totalChunks - 1; index >= 0; index -= 1) {
    if (readTextFile(getChunkResultPath(job, index)).trim()) {
      return index;
    }
  }
  return null;
}

function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return "";
  }

  return fs.readFileSync(filePath, "utf8");
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, payload) {
  writeTextFileAtomic(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function updateCheckpoint(job, patch) {
  const current = readJsonFile(job.checkpointPath);
  writeJsonFile(job.checkpointPath, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function writeTextFileAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, text, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function removeFileIfExists(filePath) {
  fs.rmSync(filePath, { force: true });
}

async function isValidMediaFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  try {
    const duration = await getMediaDuration(filePath);
    return Number.isFinite(duration) && duration > 0;
  } catch {
    return false;
  }
}

async function fetchVideoTitle(videoUrl) {
  try {
    const output = await runCommand("yt-dlp", [
      "--print",
      "%(title)s",
      "--no-playlist",
      videoUrl
    ]);
    return output.trim() || "Untitled Video";
  } catch {
    return "Untitled Video";
  }
}

async function getMediaDuration(mediaPath) {
  const output = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    mediaPath
  ]);

  const duration = Number(output.trim());
  if (!Number.isFinite(duration)) {
    throw new Error("Could not determine media duration.");
  }

  return duration;
}

function assertRequiredCommands(commands) {
  for (const command of commands) {
    if (!findCommandInPath(command)) {
      throw new Error(`Missing required command: ${command}. Please install it first.`);
    }
  }
}

function findCommandInPath(command) {
  const pathValue = process.env.PATH || "";
  for (const directory of pathValue.split(path.delimiter)) {
    const fullPath = path.join(directory, command);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }
  return "";
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      const message = stderr.trim() || stdout.trim() || `${command} exited with code ${code}`;
      reject(new Error(message));
    });
  });
}

function findFirstFile(directory, pattern) {
  const names = fs.readdirSync(directory);
  const match = names.find((name) => pattern.test(name));
  return match ? path.join(directory, match) : "";
}

function sendJson(res, statusCode, payload) {
  setCorsHeaders(res);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload));
}

function serveFile(res, filePath, contentType) {
  const content = fs.readFileSync(filePath);
  setCorsHeaders(res);
  res.writeHead(200, { "Content-Type": contentType });
  res.end(content);
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(new Error("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const index = trimmed.indexOf("=");
    if (index === -1) {
      continue;
    }

    const key = trimmed.slice(0, index).trim();
    const value = unquoteEnvValue(trimmed.slice(index + 1).trim());
    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

function unquoteEnvValue(value) {
  if (value.length < 2) {
    return value;
  }

  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }

  return value;
}

function parseShellArgs(value) {
  const args = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (const char of value) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
