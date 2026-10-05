// Real frontend + real backend contract, with local fake model/media tools only.
// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/progress-integration.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const projectRoot = path.resolve(__dirname, '..');
const root = process.env.APP_TEST_ROOT || projectRoot;
fs.mkdirSync(path.join(projectRoot, 'tmp'), { recursive: true });
const temp = fs.mkdtempSync(path.join(projectRoot, 'tmp/progress-integration-'));
app.setName('百分比进度集成测试');
app.setPath('userData', path.join(temp, 'electron'));
app.on('window-all-closed', () => {});
let window;
let historyWindow;
let service;
let model;
let releaseModel;
let modelArrived;
let rejectModel;
const arrived = new Promise((resolve, reject) => { modelArrived = resolve; rejectModel = reject; });
const gate = new Promise(resolve => { releaseModel = resolve; });
const errors = [];
const timeout = setTimeout(() => { console.error('FAIL: integration timed out'); app.exit(1); }, 45000);

async function main() {
  await app.whenReady();
  const bin = path.join(temp, 'bin');
  fs.mkdirSync(bin);
  for (const [name, output] of [['ffprobe', '2\n'], ['ffmpeg', '']]) {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'yt-dlp'), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--flat-playlist')) process.stdout.write('fixture\\t本地测试视频\\thttps://example.com/real-progress-contract\\n');
else if (args.includes('--print')) process.stdout.write('本地测试视频\\n测试作者\\n');
else if (args.includes('--version')) process.stdout.write('fixture\\n');
else { process.stderr.write('Unexpected media download in cached-only test'); process.exitCode = 1; }
`, { mode: 0o755 });
  let modelCalls = 0;
  model = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        assert.equal(req.url, '/chat/completions');
        const request = JSON.parse(body);
        assert.equal(request.model, 'mock-progress');
        const payload = JSON.parse(request.messages[1].content);
        modelCalls++;
        modelArrived();
        await gate;
        const content = JSON.stringify({ summary: '这是本地进度测试。', keyPoints: ['保留原文。'], sections: [
          { title: '进度测试', startParagraph: 1, endParagraph: payload.paragraphCount, keyPoints: ['仅测试，不调用外部服务。'] }
        ] });
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        errors.push(error.message);
        rejectModel(error);
        res.writeHead(500); res.end('Local fixture failed');
      }
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  process.env.APP_DATA_DIR = temp;
  process.env.DASHSCOPE_BASE_URL = `http://127.0.0.1:${model.address().port}`;
  process.env.DASHSCOPE_API_KEY = 'local-test-only';
  process.env.DASHSCOPE_CHAT_MODEL = 'mock-progress';
  process.env.PATH = bin + path.delimiter + process.env.PATH;
  const url = 'https://example.com/real-progress-contract';
  const jobId = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const jobDir = path.join(temp, 'jobs', jobId);
  fs.mkdirSync(path.join(jobDir, 'results'), { recursive: true });
  const body = '这是一份用于验证前后端进度契约的原始文稿。';
  const raw = `## Chunk 1\n\n${body}\n`;
  fs.writeFileSync(path.join(jobDir, 'transcript.txt'), raw);
  fs.writeFileSync(path.join(jobDir, 'results/chunk-000.txt'), body + '\n');
  fs.writeFileSync(path.join(jobDir, 'normalized.mp4'), 'fake media validated by local fake ffprobe');
  fs.writeFileSync(path.join(jobDir, 'metadata.json'), JSON.stringify({ title: '本地进度测试', uploader: '测试作者', sourceUrl: url }));
  fs.writeFileSync(path.join(jobDir, 'checkpoint.json'), JSON.stringify({ id: jobId, sourceUrl: url, status: 'complete', completedChunks: 1, totalChunks: 1 }));
  const originalFetch = global.fetch;
  global.fetch = (input, ...options) => {
    const target = new URL(typeof input === 'string' ? input : input.url || String(input));
    if (target.hostname !== '127.0.0.1') return Promise.reject(new Error(`External request blocked by test: ${target.origin}`));
    return originalFetch(input, ...options);
  };
  service = require(path.join(root, 'server.js'));
  const { url: base } = await service.startServer(0);
  window = new BrowserWindow({ width: 1180, height: 860, webPreferences: {
    preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false,
    sandbox: true, backgroundThrottling: false
  } });
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']}, (details, callback) => {
    callback({cancel:new URL(details.url).hostname !== '127.0.0.1'});
  });
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const js = expression => window.webContents.executeJavaScript(expression, true);
  const wait = expression => js(`new Promise((resolve,reject)=>{
    const check=()=>{if(${expression}){clearTimeout(timer);observer.disconnect();resolve(true);}};
    const observer=new MutationObserver(check);
    const timer=setTimeout(()=>{observer.disconnect();reject(new Error('UI wait timed out'));},15000);
    observer.observe(document.body,{attributes:true,childList:true,characterData:true,subtree:true});check();
  })`);
  await window.loadURL(base);
  await js(`(() => {
    window.integrationErrors=[];
    window.addEventListener('error',event=>window.integrationErrors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.integrationErrors.push(String(event.reason)));
    const input=document.querySelector('[data-url]');input.value=${JSON.stringify(url)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('[data-submit]').click();
  })()`);
  await arrived;
  await wait(`document.querySelector('[data-reading-state]').dataset.state==='generating'`);
  await wait(`Number(document.querySelector('.progress').getAttribute('aria-valuenow'))>=90`);
  const pending = await js(`({
    percent:Number(document.querySelector('.progress').getAttribute('aria-valuenow')),
    text:document.querySelector('.status-panel').textContent,
    raw:document.querySelector('[data-transcript]').value,
    disabled:document.querySelector('[data-submit]').disabled
  })`);
  assert(Number.isInteger(pending.percent) && pending.percent >= 0 && pending.percent < 100);
  assert.match(pending.text, /估算/);
  assert.match(pending.text, /\d+\s*%/);
  assert.equal(pending.raw, raw.trim());
  assert.equal(pending.disabled, true);
  const state = await (await fetch(`${base}/api/job?jobId=${jobId}`)).json();
  assert.equal(state.readingStatus, 'generating');
  assert.equal(state.readingProgress.completed, 0);
  assert.equal(state.readingProgress.total, 1);
  assert.equal(state.readingProgress.percent, 0);
  await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(projectRoot,'tmp/percent-progress-integration.png'),(await window.webContents.capturePage()).toPNG());
  // A second renderer has no original NDJSON stream or POST to own completion.
  // It must attach via history GETs, stay below 100, and stop itself on ready.
  historyWindow = new BrowserWindow({ width: 1180, height: 860, webPreferences: {
    preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false,
    sandbox: true, backgroundThrottling: false
  } });
  historyWindow.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  await historyWindow.loadURL(base);
  const historyJs = expression => historyWindow.webContents.executeJavaScript(expression, true);
  await historyJs(`(async () => {
    const input=document.querySelector('[data-url]');input.value=${JSON.stringify(url)};
    input.dispatchEvent(new Event('input',{bubbles:true}));
    await loadJobStatus();
    selectTranscriptView('raw');
  })()`);
  const historyPending = await historyJs(`({percent:Number(document.querySelector('.progress').getAttribute('aria-valuenow')),status:readingStatus,pending:pendingReadingRequest})`);
  assert.equal(historyPending.status, 'generating');
  assert(historyPending.pending > 0);
  assert(historyPending.percent >= 90 && historyPending.percent < 100);
  releaseModel();
  await wait(`!document.querySelector('[data-submit]').disabled && document.querySelector('[data-reading-state]').dataset.state==='ready'`);
  await historyJs(`new Promise((resolve,reject)=>{
    const observer=new MutationObserver(check);
    const timeout=setTimeout(()=>{observer.disconnect();reject(new Error('History observer did not finish'));},10000);
    function check(){if(readingStatus==='ready' && !pendingReadingRequest){clearTimeout(timeout);observer.disconnect();resolve();}}
    observer.observe(document.body,{attributes:true,childList:true,subtree:true});check();
  })`);
  assert.deepEqual(await historyJs(`({percent:overallProgress.get().value,running:readingProgress.get().running,raw:document.querySelector('[data-transcript]').value,rawVisible:!document.querySelector('[data-transcript]').hidden})`),
    { percent:100, running:false, raw:raw.trim(), rawVisible:true });
  await wait(`Number(document.querySelector('.progress').getAttribute('aria-valuenow'))===100`);
  assert.equal(modelCalls, 1);
  assert.equal(fs.readFileSync(path.join(jobDir, 'transcript.txt'), 'utf8'), raw);
  assert.deepEqual(await js('window.integrationErrors'), []);
  assert.deepEqual(errors, []);
  console.log('PASS: real server + real Electron UI: completed ASR stays below 100 while reading waits; an independent history window follows progress to completion without a POST or tab change. Local fixtures only.');
}

main().then(()=>finish(0),error=>{console.error(error);finish(1);});
async function finish(code) {
  releaseModel();
  if(historyWindow&&!historyWindow.isDestroyed()) historyWindow.destroy();
  if(window&&!window.isDestroyed()) window.destroy();
  if(service) await service.stopServer().catch(()=>{});
  if(model) await new Promise(resolve=>model.close(resolve));
  clearTimeout(timeout);
  app.exit(code);
}
