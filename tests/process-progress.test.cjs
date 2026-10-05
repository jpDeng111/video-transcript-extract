'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createYtDlpProgress, createFfmpegProgress, countProgress } = require('../lib/process-progress');

const plain = value => JSON.parse(JSON.stringify(value));

test('download parser buffers across chunks and CRLF, separates pipes, deduplicates integers', () => {
  const events = [];
  const parser = createYtDlpProgress(value => events.push(value));
  parser.onOutput(Buffer.from('[down'), 'stdout');
  parser.onOutput('unrelated log\r\n', 'stderr');
  parser.onOutput('load] 12.', 'stdout');
  parser.onOutput('8% of 10MiB\r', 'stdout');
  parser.onOutput('\n[download] 12.9% of 10MiB\n[download] 13.0% of 10MiB\n', 'stdout');
  parser.onOutput('[download] 100% of 10MiB', 'stdout');
  parser.onOutputEnd();
  assert.deepEqual(events, [12, 13, 100].map(percent => ({ percent, scope: 'file' })));
});

test('download rejects anomalous numbers and preserves multi-stream/reset progress as file scope', () => {
  const events = [];
  const parser = createYtDlpProgress(value => events.push(value));
  parser.onOutput(['-1', '101', '100.1', 'NaN', 'Infinity', '1e2', '12.3.4', '+3'].map(value => `[download] ${value}% of x`).join('\n') + '\n');
  assert.equal(events.length, 0);
  parser.onOutput('[download] 99.9% of x\n[download] 100% of x\n[download] 0% of y\n[download] 1% of y\n');
  parser.onOutput('[download] Destination: retry-or-next-file.mp4\n[download] 1% of z\n');
  assert.deepEqual(events.map(value => value.percent), [99, 100, 0, 1, 1]);
  assert(events.every(value => value.scope === 'file'));
});

test('ffmpeg time progress is monotonic, bounded below 100 until output verification', () => {
  const events = [];
  const parser = createFfmpegProgress(10, value => events.push(value.percent));
  parser.onOutput('frame=1 time=00:00:0');
  parser.onOutput('5.00 bitrate=N/A\r\nframe=2 time=00:00:05.09 speed=1x\r');
  parser.onOutput('frame=3 time=00:00:04.00 speed=1x\rframe=4 time=00:00:10.00 speed=1x\n');
  parser.onOutput('time=N/A\ntime=-00:00:01.00\ntime=00:60:00\ntime=00:00:99.00\ntime=00:00:20.00');
  parser.onOutputEnd();
  assert.deepEqual(events, [50, 99]);
  for (const duration of [0, -1, NaN, Infinity, undefined]) {
    const unknown = createFfmpegProgress(duration, () => assert.fail('unknown duration is not measurable'));
    unknown.onOutput('time=00:00:05.00\n');
    unknown.onOutputEnd();
  }
});

test('chunk/batch counts preserve exact completion and never round an incomplete count to 100', () => {
  assert.deepEqual(countProgress(0, 3), { percent: 0, completed: 0, total: 3 });
  assert.deepEqual(countProgress(1, 3), { percent: 33, completed: 1, total: 3 });
  assert.deepEqual(countProgress(199, 200), { percent: 99, completed: 199, total: 200 });
  assert.deepEqual(countProgress(200, 200), { percent: 100, completed: 200, total: 200 });
  for (const counts of [[-1, 2], [3, 2], [0, 0], [1.5, 2], [0, Infinity], [NaN, 2]]) {
    assert.throws(() => countProgress(...counts), /Progress counts/);
  }
});

// Access internals only inside an isolated VM; production exports stay unchanged.
// Commands below are local node scripts, and the model is always an in-memory fake.
function isolatedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-progress-'));
  const serverPath = path.resolve(__dirname, '../server.js');
  const module = { exports: {} };
  const context = {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root, DASHSCOPE_API_KEY: 'local-test-key' } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = {
      runCommand, activeChildProcesses, createJob, generateReadingForJob,
      activeReadingRuns, getReadingState,
      setModel: (callback) => { callDashScopeChat = callback; }
    };
  `, context, { filename: serverPath });
  t.after(async () => {
    await module.exports.stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...module.exports.test, stop: module.exports.stopServer, root };
}

test('runCommand keeps stdout, errors and logs even when output callbacks throw', async t => {
  const service = isolatedServer(t);
  const seen = [];
  const logPath = path.join(service.root, 'command.log');
  const output = await service.runCommand(process.execPath, ['-e', 'process.stdout.write("hello");process.stderr.write("diagnostic");'], {
    logPath,
    onOutput: (chunk, stream) => { seen.push([stream, chunk.toString()]); throw new Error('broken observer'); },
    onOutputEnd: () => { throw new Error('broken final parser'); },
  });
  assert.equal(output, 'hello');
  assert(seen.some(([stream, text]) => stream === 'stdout' && text === 'hello'));
  assert(seen.some(([stream, text]) => stream === 'stderr' && text === 'diagnostic'));
  assert.match(fs.readFileSync(logPath, 'utf8'), /diagnostic/);
  assert.equal(service.activeChildProcesses.size, 0);
  await assert.rejects(service.runCommand(process.execPath, ['-e', 'process.stderr.write("original failure");process.exitCode=7;'], {
    onOutput: () => { throw new Error('must not mask exit error'); },
  }), /original failure/);
  await assert.rejects(service.runCommand(path.join(service.root, 'does-not-exist'), []), /failed to start/);
  assert.equal(service.activeChildProcesses.size, 0);
});

test('shutdown still owns child processes after a parser throws; exit cannot complete a stage', async t => {
  const service = isolatedServer(t);
  let arrived;
  const ready = new Promise(resolve => { arrived = resolve; });
  const events = [];
  const parser = createFfmpegProgress(10, value => events.push(value));
  const command = service.runCommand(process.execPath, ['-e', 'process.stderr.write("time=00:00:10.00 speed=1x\\n");setInterval(()=>{},1000);'], {
    ...parser,
    onOutput: (chunk, stream) => { parser.onOutput(chunk, stream); arrived(); throw new Error('observer'); },
  });
  const rejected = assert.rejects(command);
  await ready;
  assert.equal(service.activeChildProcesses.size, 1);
  await service.stop();
  await rejected;
  assert.equal(service.activeChildProcesses.size, 0);
  assert(events.every(value => value.percent < 100));
});

test('shared reading has independent subscribers, replays latest counts, and detaches cancellation/errors', async t => {
  const service = isolatedServer(t);
  const job = service.createJob('https://example.com/isolated-reading');
  fs.mkdirSync(job.dir, { recursive: true });
  fs.writeFileSync(job.transcriptPath, '完整原文。');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let arrived;
  const reached = new Promise(resolve => { arrived = resolve; });
  let calls = 0;
  service.setModel(async () => {
    calls++;
    arrived();
    await gate;
    return JSON.stringify({ summary: '概览', keyPoints: ['重点'], sections: [{ title: '主题', startParagraph: 1, endParagraph: 1, keyPoints: [] }] });
  });
  const first = [];
  const second = [];
  const controller = new AbortController();
  const pending = service.generateReadingForJob(job, { onProgress: value => first.push(plain(value)), signal: controller.signal });
  await reached;
  const joined = service.generateReadingForJob(job, { onProgress: value => second.push(plain(value)) });
  const broken = service.generateReadingForJob(job, { onProgress: () => { throw new Error('subscriber failure'); } });
  const rejectedObserver = service.generateReadingForJob(job, { onProgress: async () => { throw new Error('async subscriber failure'); } });
  // Cross-realm promise assimilation needs a full microtask drain, not one turn.
  await new Promise(setImmediate);
  const run = service.activeReadingRuns.get(job.id);
  assert.equal(run.subscribers.size, 2);
  assert.deepEqual(second, [{ percent: 0, completed: 0, total: 1 }]);
  controller.abort();
  assert.equal(run.subscribers.size, 1);
  assert.equal(run.controller.signal.aborted, false);
  release();
  await Promise.all([pending, joined, broken, rejectedObserver]);
  assert.equal(calls, 1);
  assert.equal(first.at(-1).percent, 0);
  assert.equal(second.at(-1).percent, 100);
  assert.equal(run.subscribers.size, 0);
  assert.equal(service.activeReadingRuns.size, 0);
  assert.equal(service.getReadingState(job).readingProgress.percent, 100);
});

test('hash changes and save failures retain retryable sub-100 reading progress', async t => {
  for (const failure of ['hash', 'save']) {
    const service = isolatedServer(t);
    const job = service.createJob(`https://example.com/isolated-${failure}`);
    fs.mkdirSync(job.dir, { recursive: true });
    fs.writeFileSync(job.transcriptPath, '完整原文。');
    service.setModel(async () => {
      if (failure === 'hash') fs.appendFileSync(job.transcriptPath, '已更改。');
      else fs.mkdirSync(job.readingMarkdownPath);
      return JSON.stringify({ summary: '概览', keyPoints: ['重点'], sections: [{ title: '主题', startParagraph: 1, endParagraph: 1, keyPoints: [] }] });
    });
    const events = [];
    await assert.rejects(service.generateReadingForJob(job, { onProgress: value => events.push(value) }));
    assert(events.every(value => value.percent === null || value.percent < 100));
    assert.equal(service.activeReadingRuns.size, 0);
    const persisted = JSON.parse(fs.readFileSync(job.readingStatePath, 'utf8'));
    assert.equal(persisted.status, 'failed');
    assert(persisted.readingProgress.percent < 100);
    assert(!fs.existsSync(job.readingPath));
  }
});
