'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

const serverPath = path.resolve(__dirname, '../server.js');
function loadServer(t, env = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-options-'));
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = { buildYtDlpStrategies, getJobVideoInfo,
      runYtDlpStrategies, createJob, withoutCookieArgs,
      setInfoFetcher(fn) { fetchVideoInfo = fn; } };
  `, {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root,
      YTDLP_EXTRA_ARGS: '', YTDLP_MAX_HEIGHT: '', YTDLP_CONCURRENT_FRAGMENTS: '', ...env } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  }, { filename: serverPath });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { ...module.exports.test, root };
}

const flag = (args, name) => args[args.lastIndexOf(name) + 1];
const hasYtDlp = spawnSync('yt-dlp', ['--version']).status === 0;

// Exercise yt-dlp's real format selector against an offline format table.
// This catches a syntactically valid selector that still picks the 4K stream.
function selectedFormat(service, formats, { audioOnly = false, anonymous = false } = {}) {
  const input = path.join(service.root, 'formats.json');
  fs.writeFileSync(input, JSON.stringify({
    id: 'offline-fixture', title: 'Offline fixture', extractor: 'generic',
    webpage_url: 'https://example.com/video', formats,
  }));
  const strategies = service.buildYtDlpStrategies('https://youtu.be/offline-fixture',
    path.join(service.root, 'source.%(ext)s'), { audioOnly });
  const args = (anonymous ? strategies.at(-1) : strategies[0]).args;
  const result = spawnSync('yt-dlp', ['--ignore-config', '--load-info-json', input,
    '--simulate', '--no-check-formats', '-f', flag(args, '-f'), '-S', flag(args, '-S'),
    '--print', '%(format_id)s'], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function video(id, height, protocol = 'https', withAudio = false) {
  return { format_id: id, url: `https://example.com/${id}.mp4`, ext: 'mp4',
    height, width: Math.round(height * 16 / 9), fps: 30, vcodec: 'avc1.64001e',
    acodec: withAudio ? 'mp4a.40.2' : 'none', protocol };
}
function audio(id, abr) {
  return { format_id: id, url: `https://example.com/${id}.m4a`, ext: 'm4a',
    vcodec: 'none', acodec: 'mp4a.40.2', abr, protocol: 'https' };
}

test('chooses 480p and speech audio over 4K and high-bitrate audio', { skip: !hasYtDlp }, t => {
  const service = loadServer(t);
  const formats = [video('4k', 2160), video('720p', 720), video('480p', 480),
    video('360p', 360), audio('64k', 64), audio('256k', 256)];
  assert.equal(selectedFormat(service, formats), '480p+64k');
  assert.equal(selectedFormat(service, formats, { anonymous: true }), '480p+64k');
  assert.equal(selectedFormat(service, formats, { audioOnly: true }), '64k');
});

test('a capped HLS stream wins over an oversized HTTPS stream', { skip: !hasYtDlp }, t => {
  const service = loadServer(t);
  assert.equal(selectedFormat(service, [video('4k', 2160),
    video('hls480', 480, 'm3u8_native', true), audio('64k', 64)]), 'hls480');
});

test('falls back to the smallest resolution above the cap when required', { skip: !hasYtDlp }, t => {
  const service = loadServer(t);
  const formats = [video('4k', 2160), video('720p', 720), audio('64k', 64)];
  assert.equal(selectedFormat(service, formats), '720p+64k');
  assert.equal(selectedFormat(service, formats, { anonymous: true }), '720p+64k');
});

test('download defaults are bounded and user overrides remain effective', t => {
  const service = loadServer(t, { YTDLP_MAX_HEIGHT: '720', YTDLP_CONCURRENT_FRAGMENTS: '8',
    YTDLP_EXTRA_ARGS: '--concurrent-fragments 2 -f best --socket-timeout 25' });
  const args = service.buildYtDlpStrategies('https://example.com/video', '/tmp/source.%(ext)s')[0].args;
  assert.equal(flag(args, '--concurrent-fragments'), '2');
  assert.equal(flag(args, '-f'), 'best');
  assert.equal(flag(args, '--socket-timeout'), '25');
  assert.equal(flag(args, '-S'), 'res:720,fps:30,abr:64');
  assert.ok(args.includes('--abort-on-unavailable-fragments'));
  const invalid = loadServer(t, { YTDLP_MAX_HEIGHT: '-1', YTDLP_CONCURRENT_FRAGMENTS: '999' });
  const safeArgs = invalid.buildYtDlpStrategies('https://example.com/video', '/tmp/source.%(ext)s')[0].args;
  assert.equal(flag(safeArgs, '--concurrent-fragments'), '4');
  assert.match(flag(safeArgs, '-S'), /^res:480,/);
});

test('reuses captured title/uploader without a second network extraction', async t => {
  const service = loadServer(t);
  const job = { dir: service.root, metadataPath: path.join(service.root, 'metadata.json') };
  let calls = 0;
  service.setInfoFetcher(async () => { calls++; return { title: 'Network fallback', uploader: '' }; });
  fs.writeFileSync(path.join(job.dir, 'download-info.json'),
    JSON.stringify({ title: '中文标题 "test"', uploader: '作者' }) + '\n');
  const info = await service.getJobVideoInfo('https://example.com/video', job);
  assert.equal(info.title, '中文标题 "test"');
  assert.equal(info.uploader, '作者');
  assert.equal(calls, 0);
  fs.writeFileSync(job.metadataPath, 'null');
  assert.equal((await service.getJobVideoInfo('https://example.com/video', job)).title, info.title);
  fs.writeFileSync(job.metadataPath, JSON.stringify({ title: 'Saved title', uploader: '' }));
  assert.equal((await service.getJobVideoInfo('https://example.com/video', job)).title, 'Saved title');
  assert.equal(calls, 0, 'an empty uploader must not trigger another extraction');
  fs.rmSync(job.metadataPath);
  fs.writeFileSync(path.join(job.dir, 'download-info.json'), 'invalid json');
  assert.equal((await service.getJobVideoInfo('https://example.com/video', job)).title, 'Network fallback');
  assert.equal(calls, 1);
});

test('real downloader saves usable media and escaped metadata in a single pass',
  { skip: !hasYtDlp }, async t => {
    const service = loadServer(t);
    const fixture = path.join(service.root, 'fixture.mp4');
    const encoded = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'color=size=160x90:rate=10:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', fixture], { encoding: 'utf8' });
    assert.equal(encoded.status, 0, encoded.stderr);
    const bytes = fs.readFileSync(fixture);
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length });
      res.end(bytes);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/fixture.mp4`;
    const job = service.createJob(url);
    fs.mkdirSync(job.dir, { recursive: true });
    const infoPath = path.join(service.root, 'local-info.json');
    fs.writeFileSync(infoPath, JSON.stringify({
      id: 'local', title: '中文 "标题"', uploader: '本地作者', extractor: 'generic',
      webpage_url: url, formats: [{ ...video('local', 90, 'http', true), url }],
    }));
    const strategy = service.buildYtDlpStrategies(url, path.join(job.dir, 'source.%(ext)s'))[0];
    // Load an offline extraction result, then run the real native downloader
    // against loopback. No platform, browser cookies or external API is used.
    strategy.args = ['--ignore-config', ...service.withoutCookieArgs(strategy.args.slice(0, -1)),
      '--load-info-json', infoPath];
    const result = await service.runYtDlpStrategies({
      videoUrl: url, job, sendEvent() {}, strategies: [strategy],
      sourcePattern: /^source\.mp4$/, retryLabel: () => 'retry',
    });
    assert.deepEqual(fs.readFileSync(result), bytes);
    service.setInfoFetcher(() => { throw new Error('metadata must not need a second extraction'); });
    const info = await service.getJobVideoInfo(url, job);
    assert.equal(info.title, '中文 "标题"');
    assert.equal(info.uploader, '本地作者');
    assert.equal(requests, 1, 'one media request must be sufficient');
  });
