'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function loadServer(t, fetchImpl) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-asr-'));
  const serverPath = path.resolve(__dirname, '../server.js');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = { transcribeChunk, buildAsrEndpoint, createJob,
      archivePreviousAsrResults, ASR_MODEL_NAME, buildPublicConfig };
  `, {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root,
      ASR_API_KEY: 'private-asr-test-key', ASR_MODEL: 'qwen-audio-3.1-asr-flash',
      ASR_BASE_URL: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      DASHSCOPE_BASE_URL: 'https://different-chat.example/v1',
    } },
    fetch: fetchImpl, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  }, { filename: serverPath });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...module.exports.test, root };
}

test('latest audio model uses the native workspace endpoint and MP3 input, separately from chat', async t => {
  let captured;
  const service = loadServer(t, async (url, options) => {
    captured = { url, ...options, body: JSON.parse(options.body) };
    return { ok: true, status: 200, json: async () => ({ output: { text: '真实口播。' } }) };
  });
  const chunk = path.join(service.root, 'chunk.mp3');
  fs.writeFileSync(chunk, 'audio fixture');
  const controller = new AbortController();
  assert.equal(await service.transcribeChunk({ apiKey: 'private-asr-test-key', chunkPath: chunk,
    signal: controller.signal }), '真实口播。');
  assert.equal(captured.url, 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(captured.body.model, 'qwen-audio-3.1-asr-flash');
  assert.equal(captured.body.input.messages[0].content[0].type, 'input_audio');
  assert.equal(captured.body.input.messages[0].content[0].input_audio.data,
    `data:audio/mpeg;base64,${Buffer.from('audio fixture').toString('base64')}`);
  assert.equal(captured.headers.Authorization, 'Bearer private-asr-test-key');
  assert.equal(captured.headers['X-DashScope-SSE'], 'disable');
  assert.equal(captured.body.parameters.format, 'mp3');
  assert.equal(captured.signal, controller.signal);
  assert(!JSON.stringify(service.buildPublicConfig()).includes('private-asr-test-key'));
});

test('provider errors and empty output cannot be saved as a completed transcript', async t => {
  for (const [status, data, expected] of [
    [403, { code: 'InvalidApiKey', message: 'key rejected' }, /403.*key rejected/],
    [200, { code: 'ModelNotFound', message: 'unknown model' }, /unknown model/],
    [200, { output: { text: '' } }, /no transcript text/],
  ]) {
    const service = loadServer(t, async () => ({ status, ok: status === 200, json: async () => data }));
    const chunk = path.join(service.root, 'chunk.mp3');
    fs.writeFileSync(chunk, 'audio');
    await assert.rejects(service.transcribeChunk({ apiKey: 'test', chunkPath: chunk }), expected);
  }
});

test('switching ASR models archives derived output and preserves reusable source media', t => {
  const service = loadServer(t);
  const job = service.createJob('https://example.com/video');
  fs.mkdirSync(job.resultsDir, { recursive: true });
  fs.mkdirSync(job.chunksDir, { recursive: true });
  fs.writeFileSync(job.metadataPath, JSON.stringify({ asrModel: 'qwen3.7-plus', title: 'Old title' }));
  fs.writeFileSync(job.checkpointPath, JSON.stringify({ asrModel: 'qwen3.7-plus', status: 'complete' }));
  fs.writeFileSync(job.transcriptPath, 'old visual output');
  fs.writeFileSync(path.join(job.resultsDir, 'chunk-000.txt'), 'old chunk');
  fs.writeFileSync(job.readingPath, '{}');
  fs.writeFileSync(job.normalizedPath, 'reusable video');
  service.archivePreviousAsrResults(job);
  const backups = fs.readdirSync(job.dir).filter(name => name.startsWith('previous-transcription-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(job.dir, backups[0], 'transcript.txt'), 'utf8'), 'old visual output');
  assert.equal(fs.readFileSync(job.normalizedPath, 'utf8'), 'reusable video');
  assert.equal(fs.existsSync(job.transcriptPath), false);
  assert.equal(fs.readdirSync(job.resultsDir).length, 0);
  fs.writeFileSync(job.metadataPath, JSON.stringify({ asrModel: service.ASR_MODEL_NAME }));
  fs.writeFileSync(job.checkpointPath, JSON.stringify({ asrModel: service.ASR_MODEL_NAME }));
  fs.writeFileSync(path.join(job.resultsDir, 'chunk-000.txt'), 'new audio chunk');
  service.archivePreviousAsrResults(job);
  assert.equal(fs.readFileSync(path.join(job.resultsDir, 'chunk-000.txt'), 'utf8'), 'new audio chunk');
});
