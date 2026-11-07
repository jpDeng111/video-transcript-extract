const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell } = require("electron");

const APP_NAME = "视频转写问答";
let mainWindow = null;
let serverInfo = null;
let serverModule = null;

function getIconPath() {
  return path.join(app.getAppPath(), "assets", "icon.png");
}

function extendPathForDesktopLaunch() {
  // Bundled tools first: a packaged .app launched from Finder inherits a
  // minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew paths only help
  // developers. Under the Mac App Store sandbox they are unreachable anyway.
  const bundledBin = path.join(process.resourcesPath || path.join(app.getAppPath(), ".."), "bin");
  if (fs.existsSync(bundledBin)) {
    process.env.APP_BIN_DIR = bundledBin;
  }

  const additions = [
    bundledBin,
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin"
  ];
  const current = process.env.PATH || "";
  const paths = current.split(path.delimiter).filter(Boolean);

  for (const item of additions.reverse()) {
    if (item && !paths.includes(item)) {
      paths.unshift(item);
    }
  }

  process.env.PATH = paths.join(path.delimiter);
}

function ensureConfigFiles(userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });

  const envPath = path.join(userDataDir, ".env");
  if (!fs.existsSync(envPath)) {
    const examplePath = path.join(app.getAppPath(), ".env.example");
    const template = fs.existsSync(examplePath)
      ? fs.readFileSync(examplePath, "utf8")
      : [
          "DASHSCOPE_API_KEY=",
          "DASHSCOPE_BASE_URL=https://coding.dashscope.aliyuncs.com/v1",
          "ASR_API_KEY=",
          "ASR_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1",
          "ASR_MODEL=qwen-audio-3.1-asr-flash",
          "DASHSCOPE_CHAT_MODEL=qwen3.7-plus",
          "YTDLP_EXTRA_ARGS=",
          "YTDLP_COOKIES_FILE="
        ].join("\n");

    fs.writeFileSync(envPath, template.endsWith("\n") ? template : `${template}\n`, "utf8");
  }

  fs.mkdirSync(path.join(userDataDir, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(userDataDir, "data"), { recursive: true });
}

async function startLocalServer() {
  const userDataDir = app.getPath("userData");
  process.env.APP_DATA_DIR = userDataDir;
  extendPathForDesktopLaunch();
  ensureConfigFiles(userDataDir);

  serverModule = require("../server");
  serverInfo = await serverModule.startServer(0);
  return serverInfo;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 860,
    minWidth: 960,
    minHeight: 680,
    title: APP_NAME,
    icon: getIconPath(),
    backgroundColor: "#f6f3ee",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindow.loadURL(url);

  mainWindow.webContents.setWindowOpenHandler(({ url: nextUrl }) => {
    shell.openExternal(nextUrl);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function writeEnvValue(userDataDir, key, value) {
  const envPath = path.join(userDataDir, ".env");
  const lines = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8").split("\n") : [];
  const prefix = `${key}=`;
  let replaced = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      replaced = true;
      return `${prefix}${value}`;
    }
    return line;
  });
  if (!replaced) next.push(`${prefix}${value}`);
  fs.writeFileSync(envPath, `${next.join("\n").replace(/\n+$/, "")}\n`, "utf8");
}

// The App Sandbox cannot read Chrome's cookie database, so a user-exported
// Netscape cookies.txt picked through an open panel is the only supported
// cookie source in the Mac App Store build.
async function pickCookiesFile() {
  const result = await dialog.showOpenDialog({
    title: "选择 cookies.txt（Netscape 格式）",
    message: "在浏览器扩展（如 Get cookies.txt LOCALLY）里导出后选择该文件。",
    properties: ["openFile"],
    filters: [{ name: "Cookies", extensions: ["txt"] }]
  });
  if (result.canceled || !result.filePaths[0]) return;

  writeEnvValue(app.getPath("userData"), "YTDLP_COOKIES_FILE", result.filePaths[0]);
  const restart = await dialog.showMessageBox({
    type: "question",
    buttons: ["稍后", "立即重启"],
    defaultId: 1,
    message: "cookies 文件已保存，重启应用后生效。",
    detail: result.filePaths[0]
  });
  if (restart.response === 1) {
    app.relaunch();
    app.exit(0);
  }
}

function buildMenu() {
  const userDataDir = app.getPath("userData");
  const jobsDir = path.join(userDataDir, "jobs");

  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: `关于 ${APP_NAME}` },
        { type: "separator" },
        {
          label: "打开配置目录",
          click: () => shell.openPath(userDataDir)
        },
        {
          label: "打开文稿目录",
          click: () => shell.openPath(jobsDir)
        },
        { type: "separator" },
        {
          label: "选择 cookies 文件…",
          click: () => pickCookiesFile()
        },
        { type: "separator" },
        { role: "quit", label: "退出" }
      ]
    },
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { role: "reload", label: "重新载入" },
        { role: "toggleDevTools", label: "开发者工具" },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { role: "togglefullscreen", label: "全屏" }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerNotificationIpc() {
  if (process.platform === "darwin" && typeof Notification.requestAuthorization === "function") {
    Notification.requestAuthorization();
  }

  ipcMain.on("app:notify", (_event, payload) => {
    if (!Notification.isSupported()) {
      return;
    }

    const notification = new Notification({
      title: String(payload?.title || "").slice(0, 120) || "视频转写问答",
      body: String(payload?.body || "").slice(0, 500),
      silent: false
    });

    notification.on("click", () => {
      if (!mainWindow) {
        return;
      }
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    });

    notification.show();
  });
}

app.setName(APP_NAME);
const ownsInstance = app.requestSingleInstanceLock();
if (!ownsInstance) app.quit();
app.on("second-instance", () => {
  if (!mainWindow && serverInfo) createWindow(serverInfo.url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  if (!ownsInstance) return;
  try {
    const info = await startLocalServer();
    if (process.platform === "darwin") {
      app.dock.setIcon(getIconPath());
    }
    registerNotificationIpc();
    buildMenu();
    createWindow(info.url);
  } catch (error) {
    dialog.showErrorBox("启动失败", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("activate", () => {
  if (!mainWindow && serverInfo) {
    createWindow(serverInfo.url);
  }
});

app.on("window-all-closed", () => {
  // Closing the Mac window detaches the view; queued jobs keep running.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async (event) => {
  if (!serverModule) {
    return;
  }

  event.preventDefault();
  const moduleToStop = serverModule;
  serverModule = null;
  await moduleToStop.stopServer().catch(() => {});
  app.quit();
});
