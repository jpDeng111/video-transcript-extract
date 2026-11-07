// Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron tests/task-queue-ui.cjs
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
app.setName('任务队列界面验证');
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(root, 'tmp/queue-ui-')));
app.on('window-all-closed', () => {});
const tasks = [
  { id: 'first', title: '如何把知识变成自己的能力', url: 'https://example.com/one',
    jobId: '0123456789abcdef', state: 'running', message: '正在转写音频',
    progress: { stage: 'transcribe', completed: 2, total: 5 } },
  { id: 'second', title: '长视频中的关键观点与完整语境', url: 'https://example.com/two',
    jobId: '1111111111111111', state: 'queued', message: '等待处理' }
];
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  if (pathname === '/api/queue' && req.method === 'GET') return json({ tasks });
  if (pathname === '/api/queue' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    return req.on('end', () => {
      const task = { id: 'third', title: '新加入的视频标题 <img src=x>', url: JSON.parse(body).url,
        jobId: '2222222222222222', state: 'queued', message: '等待处理' };
      tasks.push(task); json({ tasks: [task], duplicates: 0 });
    });
  }
  const action = /^\/api\/queue\/(\w+)\/(cancel|retry)$/.exec(pathname);
  if (action) {
    const task = tasks.find(item => item.id === action[1]);
    task.state = action[2] === 'cancel' ? 'cancelled' : 'queued';
    return json({ task });
  }
  if (pathname === '/api/job') return json({ id: tasks[0].jobId,
    sourceUrl: tasks[0].url, title: tasks[0].title, status: 'transcribing',
    totalChunks: 5, completedChunks: 2, transcript: '已经保存的音频转写文字。', readingStatus: 'missing' });
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'],
    '/styles.css': ['styles.css', 'text/css'] };
  if (files[pathname]) {
    res.writeHead(200, { 'Content-Type': files[pathname][1] });
    return res.end(fs.readFileSync(path.join(root, 'public', files[pathname][0])));
  }
  res.writeHead(404); res.end('{}');
});
let win;
const timer = setTimeout(() => finish(1, new Error('queue UI timed out')), 20000);
function finish(code, error) {
  if (error) console.error(error);
  clearTimeout(timer);
  win?.destroy();
  server.close();
  app.exit(code);
}
(async () => {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  win = new BrowserWindow({ width: 1100, height: 950,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] },
    (details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
  const js = code => win.webContents.executeJavaScript(code, true);
  const wait = code => js(`new Promise((resolve,reject)=>{
    const end=Date.now()+5000; const poll=()=>{if(${code})resolve();else if(Date.now()>end)reject(new Error('UI wait timed out'));else setTimeout(poll,20);};poll();
  })`);
  await win.loadURL(`http://127.0.0.1:${server.address().port}`);
  await wait(`!document.querySelector('[data-task-queue]').hidden && document.querySelectorAll('.task-queue-item').length===2`);
  assert.equal(await js(`document.querySelector('[data-url]').disabled`), false);
  assert.equal(await js(`document.querySelector('[data-submit]').textContent`), '加入任务队列');
  assert.equal(await js(`document.querySelector('[data-queue-list]').textContent.includes('https://')`), false);
  await js(`document.querySelector('[data-task-id="first"] button').click()`);
  await wait(`!document.querySelector('[data-current-task]').hidden`);
  assert.equal(await js(`document.querySelector('[data-current-task]').textContent`), tasks[0].title);
  await js(`document.querySelector('[data-url]').value='https://example.com/three';document.querySelector('[data-url]').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('[data-submit]').click()`);
  await wait(`document.querySelectorAll('.task-queue-item').length===3`);
  assert.equal(await js(`document.querySelector('[data-task-id="third"] strong').textContent`), '新加入的视频标题 <img src=x>');
  assert.equal(await js(`document.querySelectorAll('[data-queue-list] img').length`), 0);
  await js(`document.querySelector('[data-task-id="first"] button:last-child').click()`);
  await wait(`document.querySelector('[data-task-id="first"]').dataset.state==='cancelled'`);
  await js(`document.querySelector('[data-task-id="first"] button:last-child').click()`);
  await wait(`document.querySelector('[data-task-id="first"]').dataset.state==='queued'`);
  await wait(`!document.querySelector('[data-submit]').disabled`);
  await js(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.join(root, 'tmp/task-queue-desktop.png'), (await win.webContents.capturePage()).toPNG());
  await win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 1000, deviceScaleFactor: 1, mobile: false });
  assert.equal(await js(`document.documentElement.scrollWidth > innerWidth`), false);
  fs.writeFileSync(path.join(root, 'tmp/task-queue-mobile.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS queue UI: video titles, add during processing, cancel/retry, view transcript, inert titles and responsive layout.');
  finish(0);
})().catch(error => finish(1, error));
