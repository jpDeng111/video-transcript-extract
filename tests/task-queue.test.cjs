'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskQueue } = require('../lib/task-queue');

function setup(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-queue-'));
  const queue = new TaskQueue({ filePath: path.join(dir, 'queue.json'),
    resolveTitle: async url => `Title ${url.slice(-1)}`, ...options });
  t.after(() => { queue.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return queue;
}
async function until(predicate) {
  const limit = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > limit) throw new Error('queue state timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('FIFO queue resolves names, deduplicates URLs, isolates failures and runs one task at a time', async t => {
  let running = 0;
  let peak = 0;
  const order = [];
  const queue = setup(t, { run: async (task, onEvent) => {
    peak = Math.max(peak, ++running);
    order.push(task.url);
    onEvent({ type: 'stage-progress', stage: 'transcribe', completed: 1, total: 2, percent: 50 });
    await new Promise(resolve => setTimeout(resolve, 10));
    running--;
    if (task.url.endsWith('b')) throw new Error('provider error');
    onEvent({ type: 'done', title: `视频 ${task.url.slice(-1)}` });
  } });
  queue.add({ url: 'https://example.com/a', jobId: 'a' });
  assert.equal(queue.add({ url: 'https://example.com/a' }).duplicate, true);
  queue.add({ url: 'https://example.com/b', title: '视频 B', jobId: 'b' });
  queue.add({ url: 'https://example.com/c', title: '视频 C', jobId: 'c' });
  queue.start();
  await until(() => queue.list().every(task => ['complete', 'failed'].includes(task.state)));
  assert.equal(peak, 1);
  assert.deepEqual(order, ['https://example.com/a', 'https://example.com/b', 'https://example.com/c']);
  assert.deepEqual(queue.list().map(task => task.state), ['complete', 'failed', 'complete']);
  assert.equal(queue.list()[0].title, '视频 a');
  assert.equal(queue.list()[1].error, 'provider error');
});

test('cancellation stops only its task, skips pending tasks, and retry rejoins the queue', async t => {
  const ran = [];
  let holdFirst = true;
  const queue = setup(t, { run: async (task, _, signal) => {
    ran.push(task.jobId);
    if (task.jobId === 'a' && holdFirst) await new Promise((resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const first = queue.add({ url: 'https://example.com/a', title: 'A', jobId: 'a' }).task;
  const second = queue.add({ url: 'https://example.com/b', title: 'B', jobId: 'b' }).task;
  const third = queue.add({ url: 'https://example.com/c', title: 'C', jobId: 'c' }).task;
  queue.start();
  await until(() => ran.length === 1);
  queue.cancel(second.id);
  queue.cancel(first.id);
  await until(() => queue.list().find(task => task.id === third.id).state === 'complete');
  assert.deepEqual(ran, ['a', 'c']);
  assert.equal(queue.list().find(task => task.id === first.id).state, 'cancelled');
  holdFirst = false;
  queue.retry(first.id);
  await until(() => queue.list().find(task => task.id === first.id).state === 'complete');
  assert.deepEqual(ran, ['a', 'c', 'a']);
});

test('restart preserves names and resumes interrupted work without rerunning completed tasks', async t => {
  const calls = [];
  const queue = setup(t, { run: async task => { calls.push(task.jobId); } });
  const completed = queue.add({ url: 'https://example.com/a', title: '已完成的视频', jobId: 'a' }).task;
  queue.start();
  await until(() => queue.list()[0].state === 'complete');
  queue.close();
  const pending = queue.add({ url: 'https://example.com/b', title: '待恢复的视频', jobId: 'b' }).task;
  const stored = queue.list();
  stored.find(task => task.id === pending.id).state = 'running';
  fs.writeFileSync(queue.filePath, JSON.stringify(stored));
  const restarted = new TaskQueue({ filePath: queue.filePath,
    resolveTitle: async () => { throw new Error('saved title should be reused'); },
    run: async task => { calls.push(task.jobId); } });
  t.after(() => restarted.close());
  assert.equal(restarted.list().find(task => task.id === completed.id).state, 'complete');
  restarted.start();
  await until(() => restarted.list().find(task => task.id === pending.id).state === 'complete');
  assert.deepEqual(calls, ['a', 'b']);
  assert.equal(restarted.list()[1].title, '待恢复的视频');
});
