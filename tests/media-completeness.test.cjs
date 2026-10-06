'use strict';

// Regression coverage for truncated downloads: YouTube's CDN sometimes returns a
// stub whose header declares the full duration while the body holds only the
// first seconds. yt-dlp exits 0 for such a file, so duration-only validation
// accepted it and every later ffmpeg step died with "partial file".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function isolatedServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-completeness-'));
  const serverPath = path.resolve(__dirname, '../server.js');
  const module = { exports: {} };
  const context = {
    require: createRequire(serverPath), module, __dirname: path.dirname(serverPath),
    process: { ...process, env: { ...process.env, APP_DATA_DIR: root, DASHSCOPE_API_KEY: 'local-test-key' } },
    console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
  };
  vm.runInNewContext(fs.readFileSync(serverPath, 'utf8') + `
    module.exports.test = { validateMediaFile, getMediaDuration };
  `, context, { filename: serverPath });
  t.after(async () => {
    await module.exports.stopServer();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { ...module.exports.test, root };
}

function run(command, args) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}

// A faststart mp4 keeps its moov box at the front, so cutting off the tail of
// the file leaves the declared duration intact — exactly the poisoned shape a
// truncated YouTube download has.
function writeTruncatedFixture(dir) {
  const full = path.join(dir, 'full.mp4');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', full]);
  const stub = path.join(dir, 'stub.mp4');
  const bytes = fs.statSync(full).size;
  const fd = fs.openSync(stub, 'w');
  fs.writeSync(fd, fs.readFileSync(full).subarray(0, Math.floor(bytes * 0.2)));
  fs.closeSync(fd);
  return { full, stub, duration: Number(run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', full]).trim()) };
}

test('a truncated download with an intact header passes duration-only validation', async t => {
  const service = isolatedServer(t);
  const { stub, duration } = writeTruncatedFixture(service.root);
  assert.equal(duration, 40);
  assert.equal(fs.statSync(stub).size < fs.statSync(path.join(service.root, 'full.mp4')).size, true);

  const check = await service.validateMediaFile(stub);
  assert.equal(check.ok, true, 'documents why the old duration-only gate could not help');
});

test('requireCompleteContent rejects the truncated stub and keeps the healthy file', async t => {
  const service = isolatedServer(t);
  const { full, stub } = writeTruncatedFixture(service.root);

  const broken = await service.validateMediaFile(stub, { requireCompleteContent: true });
  assert.equal(broken.ok, false);
  assert.match(broken.reason, /stopped early/);
  assert.match(broken.reason, /claims 40s/);

  const healthy = await service.validateMediaFile(full, { requireCompleteContent: true });
  assert.equal(healthy.ok, true, healthy.reason);
});

test('audio-only media passes the tail probe', async t => {
  const service = isolatedServer(t);
  const clip = path.join(service.root, 'voice.m4a');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=60', '-c:a', 'aac', clip]);

  const check = await service.validateMediaFile(clip, { requireCompleteContent: true });
  assert.equal(check.ok, true, check.reason);
});

test('short media skips the tail probe instead of failing on itself', async t => {
  const service = isolatedServer(t);
  const clip = path.join(service.root, 'short.mp4');
  run('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=4',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);

  const check = await service.validateMediaFile(clip, { requireCompleteContent: true });
  assert.equal(check.ok, true, check.reason);
});
