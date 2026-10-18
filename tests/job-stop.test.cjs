'use strict';

// A stop must interrupt work that is already in flight (a live model request) and
// keep every chunk the run already finished, so the job resumes instead of failing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const STOP_MESSAGE = '已手动停止，已完成的部分都保留在本地。';
// Values built inside the vm realm are structurally plain but not referentially
// comparable, so every assertion on them goes through JSON first.
const plain = (value) => JSON.parse(JSON.stringify(value));

function isolatedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-stop-'));
  const serverPath = path.resolve(__dirname, '../server.js');
  const module = { exports: {} };
  const context = {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = {
      delay, beginJobRun, endJobRun, stopJobRun, stopAllJobRuns, assertJobRunning,
      stoppedJobError, stoppedEventPayload, estimateStageEta, JobStoppedError,
      runCommand,
    };
  `, context, { filename: serverPath });
  t.after(async () => {
    await module.exports.stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return module.exports.test;
}

test('the retry backoff wakes up at once when the run is stopped', async (t) => {
  const service = isolatedServer(t);
  const controller = new AbortController();
  const startedAt = Date.now();
  const waiting = service.delay(60000, controller.signal);
  controller.abort(new service.JobStoppedError('abcdef0123456789'));
  await assert.rejects(waiting, (error) => error instanceof service.JobStoppedError);
  assert(Date.now() - startedAt < 1000, 'stop during backoff must not wait out the timer');
  // The original single-argument call still just sleeps.
  await service.delay(5);
});

test('a stop reaches the media command that is already running', async (t) => {
  const service = isolatedServer(t);
  const job = { id: 'abcdef0123456789' };
  const run = service.beginJobRun(job);
  const startedAt = Date.now();
  // A child that would otherwise sit there for eight hours: the stop is only
  // real if SIGTERM reaches the process and the wait rejects as a stop.
  const pending = service.runCommand(process.execPath,
    ['-e', 'setTimeout(() => process.exit(0), 28800000)'],
    { signal: run.signal, cwd: os.tmpdir() });
  await new Promise((resolve) => setTimeout(resolve, 150));
  service.stopJobRun(job.id, 'user pressed stop');
  await assert.rejects(pending, (error) => error instanceof service.JobStoppedError);
  assert(Date.now() - startedAt < 8000, 'the running child must die with the run');
});

test('a stopped run is reported as a stop and never as a retryable failure', (t) => {  const service = isolatedServer(t);
  const job = { id: 'abcdef0123456789' };
  const run = service.beginJobRun(job);
  assert.equal(job.run, run);
  assert.equal(service.stopJobRun(job.id, 'user pressed stop'), job.id);
  assert.equal(run.stopped, true);
  assert.equal(run.signal.aborted, true);
  assert.equal(run.signal.reason instanceof service.JobStoppedError, true);
  assert.throws(() => service.assertJobRunning(job), (error) => error instanceof service.JobStoppedError);
  // An abort that the HTTP client reported as its own error is still a stop.
  assert.equal(service.stoppedJobError(job, new Error('fetch failed')) instanceof service.JobStoppedError, true);
  assert.equal(service.stoppedJobError({ id: 'other' }, new Error('fetch failed')), null);
  assert.deepEqual(plain(service.stoppedEventPayload(job.id)), { type: 'stopped', jobId: job.id, message: STOP_MESSAGE });
  assert.deepEqual(plain(service.stopAllJobRuns('shutdown')), [job.id]);
  service.endJobRun(job);
  assert.equal(job.run, null);
  assert.deepEqual(plain(service.stopAllJobRuns('shutdown')), []);
  assert.equal(service.stopJobRun('ffffffffffffffff', 'idle'), '', 'an idle jobId stops nothing');
});

test('the remaining-time estimate comes from the chunks this run really measured', (t) => {
  const service = isolatedServer(t);
  const run = { stage: 'transcribe', stageStartedAt: Date.now() - 10000, chunkDurations: [], stageAnchorPercent: null };
  assert.deepEqual(plain(service.estimateStageEta(run, { completed: 0, total: 3 })), {});
  run.chunkDurations.push(4000, 4000);
  assert.deepEqual(plain(service.estimateStageEta(run, { completed: 2, total: 3 })), { etaSeconds: 4, etaBasis: 'chunk-rate' });
  // A measured chunk rate only describes the stage that measured it.
  const reading = { ...run, stage: 'reading' };
  assert.equal(plain(service.estimateStageEta(reading, { completed: 2, total: 3 })).etaBasis, 'stage-rate');
  assert.deepEqual(plain(service.estimateStageEta(null, { completed: 2, total: 3 })), {});
});

test('stop mid-request ends the stream as stopped and keeps the finished chunks', async (t) => {
  const root = fs.mkdtempSync(path.join(path.resolve(__dirname, '../tmp'), 'job-stop-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const fakeCommand = `#!${process.execPath}
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const name = path.basename(process.argv[1]);
    const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    if (name === 'ffprobe') {
      if (args.includes('-read_intervals')) {
        process.stdout.write('1.0\\n2.0\\n3.0\\n4.0\\n');
      } else {
        process.stdout.write(String(read(args.at(-1)).duration ?? 2) + '\\n');
      }
    } else if (name === 'yt-dlp') {
      process.stdout.write('测试标题\\n测试作者\\n');
    } else {
      const output = args.at(-1);
      const duration = read(args[args.indexOf('-i') + 1]).duration || 250;
      if (output.includes('%03d')) {
        for (let i = 0; i < Math.ceil(duration / 120); i++) {
          fs.writeFileSync(output.replace('%03d', String(i).padStart(3, '0')), JSON.stringify({ duration: Math.min(120, duration - i * 120) }));
        }
      } else {
        fs.writeFileSync(output, JSON.stringify({ duration }));
      }
    }
  `;
  for (const name of ['ffprobe', 'ffmpeg', 'yt-dlp']) {
    fs.writeFileSync(path.join(bin, name), fakeCommand, { mode: 0o755 });
  }

  let asrCalls = 0;
  let hold = null;
  let arrived = null;
  const reply = (res, payload) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(payload);
  };
  const model = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      const payload = JSON.parse(raw);
      if (payload.model !== 'mock-asr') return reply(res, 'data: [DONE]\n\n');
      asrCalls++;
      // Announce arrival before waiting for the gate, or the test deadlocks.
      if (asrCalls === 2 && arrived) {
        const started = arrived;
        arrived = null;
        started();
      }
      if (asrCalls >= 2 && hold) await hold;
      const content = `转写片段 ${asrCalls}。`;
      reply(res, `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));

  const previousEnv = ['APP_DATA_DIR', 'DASHSCOPE_BASE_URL', 'DASHSCOPE_API_KEY', 'DASHSCOPE_ASR_MODEL', 'DASHSCOPE_CHAT_MODEL', 'PATH']
    .map((key) => [key, process.env[key]]);
  process.env.APP_DATA_DIR = root;
  process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  process.env.DASHSCOPE_API_KEY = 'local-test-only';
  process.env.DASHSCOPE_ASR_MODEL = 'mock-asr';
  process.env.DASHSCOPE_CHAT_MODEL = 'mock-reading';
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  const service = require('../server');
  const { url: base } = await service.startServer(0);
  t.after(async () => {
    hold = null;
    await service.stopServer();
    await new Promise((resolve) => model.close(resolve));
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const videoUrl = 'https://example.com/stop-me';
  const jobId = crypto.createHash('sha256').update(videoUrl).digest('hex').slice(0, 16);
  const dir = path.join(root, 'jobs', jobId);
  fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ title: '测试标题', uploader: '测试作者', sourceUrl: videoUrl }));
  fs.writeFileSync(path.join(dir, 'normalized.mp4'), JSON.stringify({ duration: 250 }));

  const post = (endpoint, body) => fetch(base + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const secondChunkStarted = new Promise((resolve) => { arrived = resolve; });
  let release;
  hold = new Promise((resolve) => { release = resolve; });

  const pending = post('/api/transcribe', { url: videoUrl });
  await secondChunkStarted;
  assert.equal(asrCalls, 2, 'the first chunk finished and the second is in flight');

  const stop = await post('/api/stop', { jobId });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { stopped: [jobId] });

  const events = (await (await pending).text()).trim().split('\n').map(JSON.parse);
  release();
  arrived = null;
  hold = null;

  const meter = events.filter((event) => event.type === 'stage-progress' && event.stage === 'transcribe');
  assert(meter.some((event) => event.etaBasis === 'chunk-rate' && event.etaSeconds >= 0),
    `the progress meter must carry an estimate: ${JSON.stringify(meter)}`);

  const stopped = events.find((event) => event.type === 'stopped');
  assert.deepEqual(stopped, { type: 'stopped', jobId, message: STOP_MESSAGE }, JSON.stringify(events));
  assert(!events.some((event) => event.type === 'done'), 'a stop must not report completion');
  assert(!events.some((event) => event.type === 'error'), 'a stop must not report a failure');
  assert.equal(asrCalls, 2, 'a stop must not retry the interrupted chunk nor start the next one');

  const checkpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(checkpoint.status, 'stopped');
  assert.equal(checkpoint.error, '');
  assert.equal(checkpoint.totalChunks, 3);
  assert.equal(checkpoint.completedChunks, 1, 'the chunk that was already written survives the stop');
  assert.equal(checkpoint.currentChunk, null);
  assert(fs.existsSync(path.join(dir, 'results', 'chunk-000.txt')));
  assert(!fs.existsSync(path.join(dir, 'results', 'chunk-001.txt')));

  const status = await (await fetch(`${base}/api/job?jobId=${jobId}`)).json();
  assert.equal(status.status, 'stopped');
  assert.equal(status.error, '');
  assert.equal(status.completedChunks, 1);
  assert.equal(status.nextResumeChunk, 1, 'the next submit resumes at the interrupted chunk');

  assert.deepEqual(await (await post('/api/stop', { jobId: 'ffffffffffffffff' })).json(), { stopped: [] });
  assert.deepEqual(await (await post('/api/stop', { all: true })).json(), { stopped: [] });
  assert.deepEqual(await (await post('/api/stop', { jobId })).json(), { stopped: [] },
    'a stop after the run ended is a no-op, never a 500');
  assert.deepEqual(await (await post('/api/stop', {})).json(), { stopped: [] });
  const malformed = await fetch(`${base}/api/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json'
  });
  assert.equal(malformed.status, 200);
  assert.deepEqual(await malformed.json(), { stopped: [] });

  // The stopped job resumes from the interrupted chunk instead of redoing chunk 0.
  const resumedEvents = (await (await post('/api/transcribe', { url: videoUrl })).text())
    .trim().split('\n').map(JSON.parse);
  assert(resumedEvents.some((event) => event.type === 'done'), JSON.stringify(resumedEvents));
  assert(resumedEvents.some((event) => event.step === 'resume' && /跳过已完成/.test(event.message)),
    'the chunk that survived the stop is skipped on resume');
  assert.equal(asrCalls, 4, 'only the two unfinished chunks are transcribed again');
  const resumedCheckpoint = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(resumedCheckpoint.status, 'complete');
  assert.equal(resumedCheckpoint.completedChunks, 3);
});
