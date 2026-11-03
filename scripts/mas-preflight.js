#!/usr/bin/env node
"use strict";

/**
 * Mac App Store preflight.
 *
 * Catches the mistakes that only show up after upload — missing bundled
 * binaries, a sandbox entitlement that lets cookie scraping limp through, a
 * bundle id that cannot match a provisioning profile — before you spend 20
 * minutes packing a build that review will bounce.
 *
 *   npm run check:mas
 *
 * Exit code 1 when any check FAILs. WARNs are advisory.
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const results = [];

function add(level, name, detail) {
  results.push({ level, name, detail });
}

function check(condition, name, failDetail, warnOnly = false) {
  if (condition) add("PASS", name, "");
  else add(warnOnly ? "WARN" : "FAIL", name, failDetail);
}

function read(file) {
  try {
    return fs.readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- binaries --
for (const tool of ["yt-dlp", "ffmpeg", "ffprobe"]) {
  const file = path.join(ROOT, "bin", tool);
  let ok = false;
  try {
    fs.accessSync(file, fs.constants.X_OK);
    ok = fs.statSync(file).isFile();
  } catch {
    ok = false;
  }
  check(ok, `bin/${tool} 已存在且可执行`, "运行 npm run fetch:binaries 之后重试");
}

// A Homebrew binary copied on its own points at /opt/homebrew dylibs and dies
// on any machine without the same Homebrew prefix.
for (const tool of ["ffmpeg", "ffprobe"]) {
  const file = path.join(ROOT, "bin", tool);
  if (!fs.existsSync(file)) continue;
  let linked = "";
  try {
    linked = execFileSync("otool", ["-L", file], { encoding: "utf8" });
  } catch {
    // otool unavailable: not fatal, just skip the check.
  }
  const homebrewRefs = (linked.match(/\/opt\/homebrew|\/usr\/local\/opt/g) || []).length;
  if (homebrewRefs > 0) {
    add("FAIL", `bin/${tool} 不依赖本机 Homebrew 路径`,
      `发现 ${homebrewRefs} 处 /opt/homebrew 动态库引用，换台 Mac 会直接起不来。需用 dylibbundler 或静态构建。`);
  } else if (linked) {
    add("PASS", `bin/${tool} 不依赖本机 Homebrew 路径`, "");
  }
}

// ----------------------------------------------------------------- sandbox --
const runtime = read("lib/runtime.js");
check(/com\.apple\.security\.app-sandbox/.test(read("build/entitlements.mas.plist")),
  "MAS entitlements 声明 app-sandbox", "build/entitlements.mas.plist 缺少 app-sandbox");
check(/com\.apple\.security\.inherit/.test(read("build/entitlements.mas.inherit.plist")),
  "子进程使用 inherit entitlements", "build/entitlements.mas.inherit.plist 缺少 inherit");
check(/files\.user-selected\.read-write/.test(read("build/entitlements.mas.plist")),
  "允许用户选择 cookies/导出目录", "缺少 files.user-selected.read-write，选文件会失败");
check(/network\.client/.test(read("build/entitlements.mas.plist")),
  "允许出站网络", "缺少 network.client，下载与 API 调用都会失败");

// The whole point of lib/runtime.js: cookie access must degrade, not throw.
try {
  const out = execFileSync(process.execPath, ["-e", `
    process.env.APP_DISTRIBUTION = "mas";
    const r = require(${JSON.stringify(path.join(ROOT, "lib", "runtime.js"))});
    process.stdout.write(JSON.stringify({ mode: r.runtimeMode(), cookies: r.getCookieArgs() }));
  `], { encoding: "utf8", env: { ...process.env, APP_DISTRIBUTION: "mas" } });
  const parsed = JSON.parse(out);
  check(Array.isArray(parsed.cookies) && parsed.cookies.length === 0,
    "沙盒模式下自动禁用 --cookies-from-browser",
    `沙盒模式仍返回了 cookie 参数：${JSON.stringify(parsed.cookies)}`);
  check(parsed.mode === "mas", "运行时能识别 MAS 模式", `runtimeMode() 返回 ${parsed.mode}`);
} catch (error) {
  add("FAIL", "runtime.js 可在沙盒模式下加载", String(error.message).slice(0, 200));
}

// ------------------------------------------------------------------ spawns --
check(/spawn\(executable/.test(read("server.js")),
  "外部命令使用绝对路径启动",
  "server.js 仍在 spawn 裸命令名，打包后 PATH 里找不到 yt-dlp");

// ------------------------------------------------------------------ bundle --
const pkg = JSON.parse(read("package.json") || "{}");
check(Boolean(pkg.build && pkg.build.mas), "package.json 含 mas 打包配置", "缺少 build.mas");
check(String(pkg.build?.appId || "") !== "local.video-script-extract",
  "appId 已替换为已注册的反向域名",
  `当前 appId 为 ${pkg.build?.appId}，必须与 App Store Connect 里的 App ID 完全一致`,
  true);
check(fs.existsSync(path.join(ROOT, "build", "embedded.provisionprofile")),
  "已放入 embedded.provisionprofile",
  "从 Apple Developer 后台下载 Mac App Store 描述文件，命名后放进 build/",
  true);
check(fs.existsSync(path.join(ROOT, "assets", "icon.icns")),
  "打包图标存在", "缺少 assets/icon.icns");

// ------------------------------------------------------------------ review --
check(Boolean(pkg.build?.extraResources?.length),
  "外部工具随包分发", "extraResources 未配置，用户机器上没有 yt-dlp", true);

const hasSettingsUi = fs.existsSync(path.join(ROOT, "public", "settings.html")) ||
  /data-settings/.test(read("public/index.html"));
check(hasSettingsUi, "存在应用内设置界面",
  "现在只能手改 .env 并重启，App Review 会当作“未完成的应用”", true);

// ---------------------------------------------------------------- report ----
const width = 62;
const color = { PASS: "\x1b[32m", WARN: "\x1b[33m", FAIL: "\x1b[31m" };
console.log("\nMac App Store 上架预检\n" + "─".repeat(width));
for (const item of results) {
  const tag = `${color[item.level]}${item.level}\x1b[0m`;
  console.log(`${tag}  ${item.name}`);
  if (item.detail) console.log(`      ↳ ${item.detail}`);
}
const fails = results.filter((r) => r.level === "FAIL").length;
const warns = results.filter((r) => r.level === "WARN").length;
console.log("─".repeat(width));
console.log(`${results.length - fails - warns} 通过 · ${warns} 警告 · ${fails} 失败\n`);

if (fails > 0) {
  console.log("有 FAIL 项时不要提交审核：这些会在打包或审核阶段直接卡住。\n");
  process.exit(1);
}
if (warns > 0) {
  console.log("WARN 项不阻塞打包，但会影响过审或首次启动体验。\n");
}
