'use strict';

// A logged-in Chrome cookie jar makes YouTube answer with its "downgraded"
// streaming table, which for long lectures exposes only progressive format 18 —
// and that URL comes back byte-truncated while yt-dlp still exits 0. The app has
// to reach a genuinely different extraction path (anonymous DASH) instead of
// burning bandwidth on the same broken stream.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const serverPath = path.resolve(__dirname, '../server.js');

function loadServer(exports, env = {}) {
  const module = { exports: {} };
  const context = {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, DASHSCOPE_API_KEY: 'local-test-key', ...env } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = { ${exports.join(', ')} };
  `, context, { filename: serverPath });
  return module.exports.test;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}

// faststart keeps moov at the front, so cutting the tail off leaves the declared
// duration intact — the exact shape of the poisoned YouTube stub. Encoding the
// fixtures is the slow part of this file, so they are built once and reused.
const fixtures = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-dash-fixtures-'));
  const full = path.join(dir, 'full.mp4');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', full]);
  const bytes = fs.readFileSync(full);
  const stub = path.join(dir, 'stub.mp4');
  fs.writeFileSync(stub, bytes.subarray(0, Math.floor(bytes.length * 0.2)));
  return { dir, full, stub };
})();

after(() => fs.rmSync(fixtures.dir, { recursive: true, force: true }));

test('only YouTube gets the extra cookie-free DASH strategy', () => {
  const service = loadServer(['buildYtDlpStrategies']);
  const youtube = service.buildYtDlpStrategies(
    'https://www.youtube.com/watch?v=nBor4jfWetQ', '/tmp/source.%(ext)s');
  const last = youtube.at(-1);
  const joined = last.args.join(' ');

  assert.equal(last.name, 'youtube_dash_without_cookies');
  assert.equal(last.changesExtraction, true);
  assert.equal(last.args.includes('--cookies-from-browser'), false,
    'the fallback must not re-send the cookie jar that produced the truncated format list');
  assert.match(joined, /player_client=default/);
  // The later -f wins, so the DASH selector has to come after the base selector.
  assert.deepEqual(last.args.filter((item, index) => last.args[index - 1] === '-f').at(-1),
    'bv*[protocol=https][ext=mp4][vcodec^=avc1][height<=360]+ba[protocol=https][ext=m4a]/b[protocol=https][height<=360]');
  assert.equal(youtube.slice(0, -1).every(strategy =>
    strategy.args.includes('--cookies-from-browser')), true);
  assert.equal(last.args.at(-1), 'https://www.youtube.com/watch?v=nBor4jfWetQ');

  const audio = service.buildYtDlpStrategies(
    'https://youtu.be/nBor4jfWetQ', '/tmp/source.%(ext)s', { audioOnly: true });
  assert.match(audio.at(-1).args.join(' '), /ba\[protocol=https\]\[ext=m4a\]/);
  assert.equal(audio.at(-1).skipCookies, true);

  for (const url of ['https://www.bilibili.com/video/BV1xx', 'https://example.com/video']) {
    const list = service.buildYtDlpStrategies(url, '/tmp/source.%(ext)s');
    assert.equal(list.length, 4, `${url} must keep the original four strategies`);
    assert.equal(list.some(strategy => strategy.changesExtraction), false);
  }
});

// Only yt-dlp is faked: ffprobe and ffmpeg stay the real binaries so the
// completeness gate is exercised against genuine media files.
function isolatedServer(t, { stubEverywhere = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-dash-fallback-'));
  const bin = path.join(root, 'bin');
  const stateFile = path.join(root, 'calls.json');
  fs.mkdirSync(bin);
  fs.writeFileSync(stateFile, '[]');
  fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const anonymous = !args.includes('--cookies-from-browser');
    const seen = JSON.parse(fs.readFileSync(process.env.TEST_STATE_FILE, 'utf8'));
    seen.push({ anonymous, dash: args.join(' ').includes('player_client=default') });
    fs.writeFileSync(process.env.TEST_STATE_FILE, JSON.stringify(seen));
    const complete = anonymous && !process.env.TEST_STUB_EVERYWHERE;
    const out = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
    fs.writeFileSync(out, fs.readFileSync(complete ? ${JSON.stringify(fixtures.full)}
      : ${JSON.stringify(fixtures.stub)}));
    process.stdout.write('[download] 100.0% of 2.27MiB in 00:00:01 at 1.00MiB/s\\n');
  `, { mode: 0o755 });

  const env = {
    APP_DATA_DIR: root,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    TEST_STATE_FILE: stateFile
  };
  if (stubEverywhere) env.TEST_STUB_EVERYWHERE = '1';
  const service = loadServer(
    ['buildYtDlpStrategies', 'runYtDlpStrategies', 'createJob'], env);

  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  return {
    ...service,
    calls: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    download(url) {
      const job = service.createJob(url);
      fs.mkdirSync(job.dir, { recursive: true });
      const events = [];
      const promise = service.runYtDlpStrategies({
        videoUrl: url,
        job,
        sendEvent: event => events.push(event),
        strategies: service.buildYtDlpStrategies(
          url, path.join(job.dir, 'source.%(ext)s')),
        sourcePattern: /^source\.(mp4|mkv|webm|mov|m4v)$/i,
        retryLabel: strategy => `${strategy.name} failed, trying next download strategy...`
      });
      return { job, events, promise };
    }
  };
}

// Download retries ride on `type: "status"` events and are identified by step.
const retries = events => events.filter(event => event.step === 'download_retry');

test('a truncated cookie download is retried until the anonymous DASH strategy succeeds', async t => {
  const service = isolatedServer(t);
  const url = 'https://www.youtube.com/watch?v=nBor4jfWetQ';
  const { job, events, promise } = service.download(url);

  const source = await promise;
  assert.equal(path.basename(source), 'source.mp4');
  assert.equal(fs.statSync(source).size, fs.statSync(fixtures.full).size,
    'the accepted file must be the complete download, not the truncated stub');
  assert.equal(retries(events).length, 4, 'each cookie strategy must report the truncated stub');
  assert.match(retries(events).at(-1).message, /incomplete file/);
  assert.deepEqual(service.calls(), [
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: true, dash: true }
  ]);
  assert.equal(JSON.parse(fs.readFileSync(job.checkpointPath, 'utf8')).downloadStrategy,
    'youtube_dash_without_cookies');
});

test('a stream that is broken for every strategy still stops without leaving the stub behind', async t => {
  const service = isolatedServer(t, { stubEverywhere: true });
  const { job, events, promise } = service.download('https://www.youtube.com/watch?v=nBor4jfWetQ');

  // A truncated stub only costs the few megabytes YouTube actually sends, so the
  // loop keeps going while a genuinely different extraction path is still
  // untried — and then stops instead of looping forever on a known-broken stream.
  await assert.rejects(promise, /stopped early/);
  assert.equal(retries(events).length, 5);
  assert.match(retries(events).at(-1).message, /incomplete file/);
  assert.equal(fs.existsSync(path.join(job.dir, 'source.mp4')), false,
    'a rejected stub must never be left for the next run to trust');
  assert.deepEqual(service.calls(), [
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: false, dash: false },
    { anonymous: true, dash: true }
  ]);
});

test('non-YouTube URLs keep the original two-stub cutoff', async t => {
  const service = isolatedServer(t, { stubEverywhere: true });
  const { events, promise } = service.download('https://example.com/video');

  await assert.rejects(promise, /stopped early/);
  assert.equal(retries(events).length, 2);
  assert.equal(service.calls().length, 2);
});
