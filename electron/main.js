const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell } = require("electron");

const APP_NAME = "视频转写问答";
let mainWindow = null;
let serverInfo = null;
let serverModule = null;

function extendPathForDesktopLaunch() {
  const additions = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin"
  ];
  const current = process.env.PATH || "";
  const paths = current.split(path.delimiter).filter(Boolean);

  for (const item of additions.reverse()) {
    if (!paths.includes(item)) {
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
          "DASHSCOPE_ASR_MODEL=qwen3.7-plus",
          "DASHSCOPE_CHAT_MODEL=qwen3.7-plus",
          "YTDLP_EXTRA_ARGS="
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
    backgroundColor: "#f6f3ee",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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

app.setName(APP_NAME);

app.whenReady().then(async () => {
  try {
    const info = await startLocalServer();
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
