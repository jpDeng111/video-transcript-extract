const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// Isolated fixture jobs and a local fake model: never call the real provider.
test('reading API, persistence, downloads and automatic pipelines', async t => {
  const temp = path.resolve(__dirname, '../tmp');
  fs.mkdirSync(temp, { recursive: true });
  const root = fs.mkdtempSync(path.join(temp, 'reading-api-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const batchUrls = ['https://example.com/batch-a', 'https://example.com/batch-b'];
  const fakeCommand = `#!${process.execPath}
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const name = path.basename(process.argv[1]);
    const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    const mode = read(path.join(process.cwd(), 'fake-command.json'));
    if (name === 'ffprobe') {
      if (args.includes('-read_intervals')) {
        // Completeness probe: a healthy file always has packets at its tail.
        // The probe runs outside the job cwd, so read the job's own mode file.
        const probed = args[args.indexOf('-i') + 1];
        const jobMode = read(path.join(path.dirname(probed), 'fake-command.json'));
        const count = jobMode.tailPackets ?? mode.tailPackets ?? 4;
        process.stdout.write(Array.from({ length: count }, (_, i) => i + '.0').join('\\n') + (count ? '\\n' : ''));
      } else {
        process.stdout.write(String(read(args.at(-1)).duration ?? 2) + '\\n');
      }
    } else if (name === 'yt-dlp') {
      if (args.includes('--flat-playlist')) {
        process.stdout.write(${JSON.stringify(batchUrls.map((url, i) => `${i}\t测试视频${i + 1}\t${url}`).join('\n') + '\n')});
      } else if (args.includes('--output')) {
        if (!args.includes('--newline') || !args.includes('--progress')) throw new Error('Missing progress flags');
        process.stdout.write('[download] 10.1% of x\\r\\n[download] 100% of x\\n[download] 0% of y\\n[download] 80.1% of y\\n[download] 100% of y');
        const file = args[args.indexOf('--output') + 1].replace('%(ext)s', 'mp4');
        fs.writeFileSync(file, JSON.stringify({ duration: mode.downloadInvalid ? 0 : (mode.duration || 250) }));
        if (mode.downloadFail || (mode.downloadRetry && !args.includes('--force-ipv4'))) process.exitCode = 7;
      } else process.stdout.write('测试视频\\n测试作者\\n');
    } else {
      const output = args.at(-1);
      const split = output.includes('%03d');
      const duration = read(args[args.indexOf('-i') + 1]).duration || 250;
      process.stderr.write('frame=1 time=00:02:05.00 speed=1x\\rframe=2 time=00:04:10.00 speed=1x');
      const invalid = split ? mode.splitInvalid : mode.normalizeInvalid;
      if (split) {
        for (let i = 0; i < Math.ceil(duration / 120); i++) {
          fs.writeFileSync(output.replace('%03d', String(i).padStart(3, '0')), JSON.stringify({ duration: invalid ? 0 : Math.min(120, duration - i * 120) }));
        }
      } else fs.writeFileSync(output, JSON.stringify({ duration: invalid ? 0 : duration }));
      if (split ? mode.splitFail : mode.normalizeFail) process.exitCode = 7;
    }
  `;
  for (const name of ['ffprobe', 'ffmpeg', 'yt-dlp']) {
    fs.writeFileSync(path.join(bin, name), fakeCommand, { mode: 0o755 });
  }
  let modelCalls = 0;
  let asrCalls = 0;
  let asrFailure = false;
  let mode = 'success';
  let gate = null;
  let arrived = null;
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      const payload = JSON.parse(body);
      assert.equal(req.url, '/chat/completions');
      if (payload.model === 'mock-asr') {
        asrCalls++;
        assert.equal(payload.messages[0].content[0].type, 'video_url');
        assert.match(payload.messages[0].content[1].text, /角色名请根据你听到的身份/);
        if (asrFailure) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'mock ASR rejected this chunk' } }));
        }
        const content = '主持人：完整转写。嘉宾：保留原话。';
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        return res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      }
      modelCalls++;
      assert.equal(payload.model, 'mock-reading');
      assert.equal(payload.messages[0].role, 'system');
      if (arrived) arrived();
      if (gate) await gate;
      if (mode === 'http-failure') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'test provider unavailable' } }));
      }
      const content = mode === 'invalid' ? 'not-json' : JSON.stringify({
        summary: '围绕学习方法展开讨论。', keyPoints: ['练习与复盘需要结合。'],
        sections: [{ title: '练习与复盘', startParagraph: 1, endParagraph: JSON.parse(payload.messages[1].content).paragraphCount, keyPoints: ['先练习，再复盘。'] }]
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  process.env.APP_DATA_DIR = root;
  process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  process.env.DASHSCOPE_API_KEY = 'local-test-only';
  process.env.DASHSCOPE_CHAT_MODEL = 'mock-reading';
  process.env.DASHSCOPE_ASR_MODEL = 'mock-asr';
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const service = require('../server');
  const { url: base } = await service.startServer(0);
  t.after(async () => { await service.stopServer(); await new Promise(resolve => model.close(resolve)); });
  const raw = '## Chunk 1\n\n- 主持人：如何提升学习效果？嘉宾：保持练习，及时复盘。\n';
  function seed(url, status = 'complete') {
    const id = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
    const dir = path.join(root, 'jobs', id);
    fs.mkdirSync(path.join(dir, 'results'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'transcript.txt'), raw);
    fs.writeFileSync(path.join(dir, 'checkpoint.json'), JSON.stringify({ id, sourceUrl:url, status, totalChunks:1, completedChunks:1 }));
    fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify({ title:'测试标题', uploader:'测试作者', sourceUrl:url }));
    fs.writeFileSync(path.join(dir, 'normalized.mp4'), 'mock media, validated only by fake ffprobe');
    fs.writeFileSync(path.join(dir, 'results/chunk-000.txt'), raw.split('\n\n')[1]);
    return { id, dir, url };
  }
  const job = seed('https://example.com/reading');
  const post = (endpoint, body) => fetch(base + endpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const state = async target => (await fetch(`${base}/api/job?jobId=${target.id}`)).json();

  await t.test('raw transcript remains complete; invalid and unfinished jobs are rejected', async () => {
    const current = await state(job);
    assert.equal(current.transcript, raw.trim());
    assert.equal(current.readingStatus, 'missing');
    assert.equal(await (await fetch(`${base}/api/download?jobId=${job.id}`)).text(), raw);
    assert.equal((await post('/api/reading', { jobId:'../../escape' })).status, 400);
    assert.equal((await post('/api/reading', { jobId:'1111111111111111' })).status, 404);
    const unfinished = seed('https://example.com/unfinished', 'transcribing');
    assert.equal((await post('/api/reading', { jobId:unfinished.id })).status, 409);
    assert.equal((await fetch(`${base}/api/download?jobId=${job.id}&format=reading`)).status, 404);
  });
  await t.test('generation persists structure, full raw text and downloadable linked contents', async () => {
    const response = await post('/api/reading', { jobId:job.id });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.readingStatus, 'ready');
    assert.equal(data.reading.sections[0].paragraphs.join(''), raw.trim().replace(/^## Chunk \d+(?:\r\n|\n|\r|$)/gm, ''));
    assert.equal(fs.readFileSync(path.join(job.dir, 'transcript.txt'), 'utf8'), raw);
    assert(fs.existsSync(path.join(job.dir, 'reading.json')));
    const download = await fetch(`${base}/api/download?jobId=${job.id}&format=reading`);
    const markdown = await download.text();
    assert.match(download.headers.get('content-type'), /markdown/);
    assert.match(download.headers.get('content-disposition'), /\.md/);
    assert.match(markdown, /目录/);
    assert.match(markdown, /\]\(#topic-1\)/);
    assert.match(markdown, /练习与复盘/);
    assert.equal(markdown, fs.readFileSync(path.join(job.dir, 'reading.md'), 'utf8'));
    const calls = modelCalls;
    await post('/api/reading', { url:job.url });
    assert.equal(modelCalls, calls, 'cached reading must not spend another request');
    assert.equal((await state(job)).readingStatus, 'ready');
  });
  await t.test('concurrent requests share generation; edited raw text invalidates cache', async () => {
    fs.writeFileSync(path.join(job.dir, 'transcript.txt'), raw.trimEnd() + '补充一句。\n');
    assert.equal((await state(job)).readingStatus, 'missing');
    let release;
    gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { arrived = resolve; });
    const calls = modelCalls;
    const first = post('/api/reading', { jobId:job.id });
    await reached;
    const second = post('/api/reading', { jobId:job.id.toUpperCase() });
    assert.equal((await state(job)).readingStatus, 'generating');
    const uppercaseState = await state({ id: job.id.toUpperCase() });
    assert.equal(uppercaseState.id, job.id);
    assert.equal(uppercaseState.readingStatus, 'generating');
    assert.deepEqual(uppercaseState.readingProgress, { percent: 0, completed: 0, total: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(job.dir, 'reading-state.json'), 'utf8')).readingProgress, uppercaseState.readingProgress);
    release(); gate = null; arrived = null;
    assert.equal((await first).status, 200);
    const secondResponse = await second;
    assert.equal(secondResponse.status, 200);
    assert.equal((await secondResponse.json()).jobId, job.id);
    assert.equal(modelCalls, calls + 1);
  });
  await t.test('manual GET exposes completed reading batches while POST remains one JSON response', async () => {
    const target = seed('https://example.com/manual-progress');
    fs.writeFileSync(path.join(target.dir, 'transcript.txt'), '完整原文。'.repeat(9000));
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    let reached;
    const secondBatch = new Promise(resolve => { reached = resolve; });
    let calls = 0;
    arrived = () => { if (++calls === 2) { gate = hold; reached(); } };
    const pending = post('/api/reading', { jobId: target.id });
    await secondBatch;
    try {
      const current = await state(target);
      assert.equal(current.readingStatus, 'generating');
      assert.equal(current.readingProgress.completed, 1);
      assert(current.readingProgress.total > 2);
      assert.equal(current.readingProgress.percent, Math.floor(100 / current.readingProgress.total));
      const saved = JSON.parse(fs.readFileSync(path.join(target.dir, 'reading-state.json'), 'utf8'));
      assert.deepEqual(saved.readingProgress, current.readingProgress);
    } finally { release(); gate = null; arrived = null; }
    const response = await pending;
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).readingStatus, 'ready');
    const ready = await state(target);
    assert.equal(ready.readingProgress.percent, 100);
    assert.equal(ready.readingProgress.completed, ready.readingProgress.total);
  });
  await t.test('missing API key persists a retryable error without affecting the original', async () => {
    const target = seed('https://example.com/missing-key');
    const savedKey = process.env.DASHSCOPE_API_KEY;
    const calls = modelCalls;
    try {
      process.env.DASHSCOPE_API_KEY = '';
      assert.equal((await post('/api/reading', { jobId: target.id })).status, 500);
      const current = await state(target);
      assert.equal(current.status, 'complete');
      assert.equal(current.readingStatus, 'failed');
      assert.match(current.readingError, /API Key/);
      assert.equal(modelCalls, calls);
      assert.equal(fs.readFileSync(path.join(target.dir, 'transcript.txt'), 'utf8'), raw);
    } finally {
      process.env.DASHSCOPE_API_KEY = savedKey;
    }
    assert.equal((await post('/api/reading', { jobId: target.id })).status, 200);
  });
  await t.test('failed and interrupted generation preserves raw and can retry', async () => {
    const failed = seed('https://example.com/failure');
    mode = 'invalid';
    assert.equal((await post('/api/reading', { jobId:failed.id })).status, 500);
    assert.equal((await state(failed)).readingStatus, 'failed');
    assert.equal(fs.readFileSync(path.join(failed.dir,'transcript.txt'),'utf8'),raw);
    mode = 'success';
    assert.equal((await post('/api/reading', { jobId:failed.id })).status, 200);
    const interrupted = seed('https://example.com/interrupted');
    const hash = crypto.createHash('sha256').update(raw.trim()).digest('hex');
    fs.writeFileSync(path.join(interrupted.dir,'reading-state.json'),JSON.stringify({sourceHash:hash,status:'generating'}));
    assert.equal((await state(interrupted)).readingStatus, 'failed');
  });
  await t.test('source changes during generation are never overwritten', async () => {
    const changing = seed('https://example.com/changing');
    let release;
    gate = new Promise(resolve => { release=resolve; });
    const reached = new Promise(resolve => { arrived=resolve; });
    const pending = post('/api/reading', { jobId:changing.id });
    await reached;
    fs.appendFileSync(path.join(changing.dir,'transcript.txt'),'新的内容。');
    release(); gate=null; arrived=null;
    assert.equal((await pending).status,500);
    assert.equal((await state(changing)).readingStatus,'missing');
    assert(!fs.existsSync(path.join(changing.dir,'reading.json')));
  });
  await t.test('single-video completion automatically generates reading; failure stays nonfatal', async () => {
    for (const failure of [false,true]) {
      mode = failure ? 'http-failure' : 'success';
      const target = seed('https://example.com/automatic-'+failure);
      const response = await post('/api/transcribe', { url:target.url });
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      const done = events.find(event => event.type==='done');
      assert(done,JSON.stringify(events));
      assert.equal(done.readingStatus, failure ? 'failed' : 'ready');
      assert(events.some(event=>event.type==='reading-status'));
      const stages = events.filter(event => event.type === 'stage-progress');
      assert(stages.every(event => event.jobId === target.id));
      for (const stage of ['download', 'normalize', 'split', 'transcribe']) {
        assert(stages.some(event => event.stage === stage && event.percent === 100), stage);
      }
      const reading = stages.filter(event => event.stage === 'reading');
      assert.equal(reading.some(event => event.percent === 100), !failure);
      assert(reading.some(event => event.percent === 0 && event.completed === 0 && event.total === 1));
      assert.equal((await state(target)).status,'complete');
      assert.equal(fs.readFileSync(path.join(target.dir,'transcript.txt'),'utf8'),raw);
    }
    mode='success';
  });
  await t.test('real pipeline steps emit verified stages and count non-contiguous resumed chunks', async () => {
    const target = seed('https://example.com/measured-pipeline');
    fs.unlinkSync(path.join(target.dir, 'normalized.mp4'));
    fs.renameSync(path.join(target.dir, 'results/chunk-000.txt'), path.join(target.dir, 'results/chunk-002.txt'));
    fs.writeFileSync(path.join(target.dir, 'fake-command.json'), JSON.stringify({ duration: 250, downloadRetry: true }));
    const calls = asrCalls;
    const response = await post('/api/transcribe', { url: target.url });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert(events.some(event => event.type === 'done'), JSON.stringify(events));
    const stages = events.filter(event => event.type === 'stage-progress');
    assert(stages.every(event => event.jobId === target.id));
    const download = stages.filter(event => event.stage === 'download');
    assert(download.some(event => event.scope === 'file' && event.percent === 0));
    assert.equal(download.filter(event => event.scope !== 'file' && event.percent === 100).length, 1);
    const retryIndex = events.findIndex(event => event.step === 'download_retry');
    const verifiedIndex = events.findIndex(event => event.stage === 'download' && !event.scope && event.percent === 100);
    assert(retryIndex >= 0 && retryIndex < verifiedIndex);
    for (const stage of ['normalize', 'split']) {
      const progress = stages.filter(event => event.stage === stage);
      assert(progress.some(event => event.percent === 50), JSON.stringify(progress));
      assert(progress.some(event => event.percent === 99));
      assert.equal(progress.at(-1).percent, 100);
    }
    const transcribe = stages.filter(event => event.stage === 'transcribe');
    assert.equal(transcribe[0].completed, 1);
    assert.equal(transcribe.at(-1).completed, 3);
    assert.equal(asrCalls, calls + 2);
    for (const event of transcribe) {
      assert.equal(event.total, 3);
      assert.equal(event.percent, Math.floor(event.completed / 3 * 100));
    }
    assert(events.some(event => event.step === 'saved' && typeof event.progress === 'number'));
    assert(events.findIndex(event => event.stage === 'transcribe' && event.percent === 100)
      < events.findIndex(event => event.stage === 'reading' && event.percent === 100));
  });
  await t.test('failed commands and unreadable outputs never complete their stage', async () => {
    for (const [option, stage] of [
      ['downloadFail', 'download'], ['downloadInvalid', 'download'],
      ['normalizeFail', 'normalize'], ['normalizeInvalid', 'normalize'],
      ['splitFail', 'split'], ['splitInvalid', 'split']
    ]) {
      const target = seed('https://example.com/progress-failure-' + option);
      fs.unlinkSync(path.join(target.dir, 'normalized.mp4'));
      fs.writeFileSync(path.join(target.dir, 'fake-command.json'), JSON.stringify({ [option]: true, duration: 250 }));
      const calls = asrCalls;
      const response = await post('/api/transcribe', { url: target.url });
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert(events.some(event => event.type === 'error'), option);
      assert(!events.some(event => event.type === 'done'), option);
      assert(!events.some(event => event.stage === stage && !event.scope && event.percent === 100), option);
      assert.equal(asrCalls, calls);
    }
  });
  await t.test('a header-only download stub is retried through every strategy and reported as truncated', async () => {
    const target = seed('https://example.com/progress-failure-truncated');
    fs.unlinkSync(path.join(target.dir, 'normalized.mp4'));
    fs.writeFileSync(path.join(target.dir, 'fake-command.json'), JSON.stringify({ duration: 250, tailPackets: 0 }));
    const response = await post('/api/transcribe', { url: target.url });
    const events = (await response.text()).trim().split('\n').map(JSON.parse);
    assert(events.some(event => event.type === 'error'));
    assert.equal(events.filter(event => event.step === 'download_retry').length, 2,
      'two header-only stubs stop the strategy loop instead of re-downloading four times');
    assert.match(JSON.stringify(events), /残缺/);
    assert.equal(fs.existsSync(path.join(target.dir, 'source.mp4')), false, 'the stub is deleted');
  });
  await t.test('failed ASR preserves completed chunk counts and never starts reading or reports 100', async () => {
    const target = seed('https://example.com/asr-progress-failure');
    fs.writeFileSync(path.join(target.dir, 'normalized.mp4'), JSON.stringify({ duration: 250 }));
    const calls = modelCalls;
    asrFailure = true;
    try {
      const response = await post('/api/transcribe', { url: target.url });
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert(events.some(event => event.type === 'error'));
      const progress = events.filter(event => event.stage === 'transcribe');
      assert(progress.length > 0);
      assert(progress.every(event => event.percent === 33 && event.completed === 1 && event.total === 3));
      assert(!events.some(event => event.stage === 'reading' || event.type === 'done'));
      assert.equal(modelCalls, calls);
      assert.equal((await state(target)).completedChunks, 1);
    } finally { asrFailure = false; }
  });
  await t.test('batch videos each receive a persisted reading version and indexed chunk progress', async () => {
    const targets=batchUrls.map(url=>seed(url));
    for (const target of targets) {
      fs.writeFileSync(path.join(target.dir, 'normalized.mp4'), JSON.stringify({ duration: 250 }));
    }
    fs.unlinkSync(path.join(targets[1].dir, 'results/chunk-000.txt'));
    const calls = asrCalls;
    const response=await post('/api/transcribe-batch',{url:'https://example.com/playlist'});
    const events=(await response.text()).trim().split('\n').map(JSON.parse);
    const completed=events.filter(event=>event.type==='batch-video-done');
    assert.equal(completed.length,2,JSON.stringify(events));
    for(const event of completed) assert.equal(event.readingStatus,'ready');
    for(const target of targets) assert.equal((await state(target)).readingStatus,'ready');
    assert.equal(asrCalls, calls + 5);
    for (let i = 0; i < targets.length; i++) {
      const stages = events.filter(event => event.type === 'stage-progress' && event.batchVideoIndex === i);
      assert(stages.every(event => event.jobId === targets[i].id && event.batchTotalVideos === 2));
      const transcribe = stages.filter(event => event.stage === 'transcribe');
      assert.equal(transcribe[0].completed, i === 0 ? 1 : 0);
      assert.equal(transcribe.at(-1).percent, 100);
      assert(transcribe.every(event => event.total === 3 && event.percent === Math.floor(event.completed / 3 * 100)));
      assert.equal(stages.filter(event => event.stage === 'reading').at(-1).percent, 100);
    }
  });
  await t.test('shutdown aborts pending model calls and preserves a retryable state', { timeout: 10000 }, async () => {
    const target = seed('https://example.com/shutdown');
    let release;
    gate = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { arrived = resolve; });
    const response = post('/api/reading', { jobId: target.id });
    await reached;
    try {
      const stopped = service.stopServer();
      assert.equal((await response).status, 500);
      await stopped;
      const persisted = JSON.parse(fs.readFileSync(path.join(target.dir, 'reading-state.json'), 'utf8'));
      assert.equal(persisted.status, 'failed');
      assert.match(persisted.error, /退出|中断/);
      assert(persisted.readingProgress.percent < 100);
      assert.equal(persisted.readingProgress.completed, 0);
      assert.equal(fs.readFileSync(path.join(target.dir, 'transcript.txt'), 'utf8'), raw);
      assert.equal(JSON.parse(fs.readFileSync(path.join(target.dir, 'checkpoint.json'), 'utf8')).status, 'complete');
      assert(!fs.existsSync(path.join(target.dir, 'reading.json')));
    } finally {
      release(); gate = null; arrived = null;
    }
  });
});
