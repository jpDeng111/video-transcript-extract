'use strict';

// stdout/stderr may interleave, and records may end in CR, LF, or CRLF.
// Keep incomplete records separate and bounded even when a tool prints a long log.
function createLineOutput(onLine) {
  const buffers = new Map();
  return {
    onOutput(chunk, stream = 'stderr') {
      const lines = ((buffers.get(stream) || '') + chunk.toString()).split(/[\r\n]/);
      buffers.set(stream, lines.pop().slice(-16384));
      for (const line of lines) if (line) onLine(line);
    },
    onOutputEnd() {
      for (const line of buffers.values()) if (line) onLine(line);
      buffers.clear();
    },
  };
}

function createYtDlpProgress(onProgress) {
  let lastPercent = null;
  return createLineOutput((line) => {
    // A destination is a new media stream/file, not a new overall download.
    if (/^\s*\[download\]\s+Destination:/.test(line)) lastPercent = null;
    const match = /^\s*\[download\]\s+(\d+(?:\.\d+)?)%\s*(?:of\b|$)/.exec(line);
    if (!match) return;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0 || value > 100) return;
    const percent = Math.floor(value);
    if (percent === lastPercent) return;
    lastPercent = percent;
    // 100 here means this file only; verification/merging can still fail.
    onProgress({ percent, scope: 'file' });
  });
}

function createFfmpegProgress(durationSeconds, onProgress) {
  let lastPercent = -1;
  return createLineOutput((line) => {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    const match = /(?:^|\s)time=(\d+):([0-5]\d):([0-5]\d(?:\.\d+)?)(?=\s|$)/.exec(line);
    if (!match) return;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (!Number.isFinite(seconds)) return;
    // Processing the last timestamp is not proof the output was saved/validated.
    const percent = Math.min(99, Math.floor(seconds / durationSeconds * 100));
    if (percent <= lastPercent) return;
    lastPercent = percent;
    onProgress({ percent });
  });
}

function countProgress(completed, total) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isSafeInteger(completed)
    || completed < 0 || completed > total) {
    throw new RangeError('Progress counts must satisfy 0 <= completed <= total, with total > 0');
  }
  return { percent: Math.floor(completed / total * 100), completed, total };
}

module.exports = { createYtDlpProgress, createFfmpegProgress, countProgress };
