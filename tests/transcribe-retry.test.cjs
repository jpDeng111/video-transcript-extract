'use strict';

// Chunk transcribe retries must classify a cut SSE stream as transient: undici
// reports it as "terminated", and an unclassified error aborts the whole video
// even when 13/36 chunks were already persisted.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function isolatedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-retry-'));
  const serverPath = path.resolve(__dirname, '../server.js');
  const module = { exports: {} };
  const context = {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root, DASHSCOPE_API_KEY: 'local-test-key' } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = { isRetryableTranscribeError, MAX_TRANSCRIBE_ATTEMPTS };
  `, context, { filename: serverPath });
  t.after(async () => {
    await module.exports.stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return module.exports.test;
}

test('a cut provider stream is retried instead of failing the whole video', (t) => {
  const service = isolatedServer(t);
  assert.equal(service.MAX_TRANSCRIBE_ATTEMPTS, 3);
  for (const message of [
    'terminated',
    'fetch failed',
    'TypeError: terminated',
    'premature close',
    'other side closed',
    'EPIPE: broken pipe',
    'socket hang up',
    'read ECONNRESET',
    'upstream timed out',
    '429 Too Many Requests',
    '503 Service Unavailable'
  ]) {
    assert.equal(service.isRetryableTranscribeError(new Error(message)), true, message);
  }
});

test('permanent request errors still fail fast without retrying', (t) => {
  const service = isolatedServer(t);
  for (const message of [
    'DashScope returned no transcript text.',
    'invalid_parameter_error: messages.content too large',
    'Incorrect API key provided',
    'Model not exist.'
  ]) {
    assert.equal(service.isRetryableTranscribeError(new Error(message)), false, message);
  }
});
