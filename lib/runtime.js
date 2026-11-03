"use strict";

/**
 * Runtime environment abstraction.
 *
 * The app has to run in three very different worlds:
 *
 *   dev      `npm start` / `electron .`  -> tools come from PATH (brew)
 *   direct   Developer ID + notarized .dmg -> tools ship inside the bundle
 *   mas      Mac App Store (sandboxed)   -> tools ship inside the bundle AND
 *                                          the sandbox forbids reading other
 *                                          apps' cookie stores
 *
 * Everything that differs between those worlds is resolved here so the rest of
 * the code keeps a single code path.
 */

const fs = require("fs");
const path = require("path");

const IS_MAC = process.platform === "darwin";
// process.mas is set by Electron when the app was built for the Mac App Store.
const IS_MAS = process.mas === true || process.env.APP_DISTRIBUTION === "mas";
const IS_SANDBOXED = IS_MAS || process.env.APP_SANDBOXED === "1";

const BINARY_NAMES = ["yt-dlp", "ffmpeg", "ffprobe"];

function bundledBinaryDirs() {
  const dirs = [];
  if (process.env.APP_BIN_DIR) dirs.push(path.resolve(process.env.APP_BIN_DIR));
  // Packaged: Contents/Resources/bin (see build.extraResources in package.json)
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, "bin"));
  // Dev / unpacked
  dirs.push(path.join(__dirname, "..", "bin"));
  dirs.push(path.join(__dirname, "..", "bin", `${process.arch}`));
  return dirs;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findInPath(command) {
  for (const directory of String(process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return "";
}

/**
 * Resolve a tool to an absolute path.
 * Order: bundled binary -> PATH -> "" (not found).
 */
function findBinary(command) {
  for (const dir of bundledBinaryDirs()) {
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return findInPath(command);
}

function resolveBinary(command) {
  return findBinary(command) || command;
}

function binaryReport() {
  return BINARY_NAMES.map((name) => {
    const resolved = findBinary(name);
    return {
      name,
      path: resolved,
      source: resolved ? (resolved.startsWith(path.sep) && !resolved.includes(`${path.sep}node_modules`) && resolved.startsWith(path.join(__dirname, "..")) ? "bundled" : "system") : "missing",
      ok: Boolean(resolved)
    };
  });
}

/**
 * Cookie policy.
 *
 * `--cookies-from-browser chrome` decrypts Chrome's cookie DB through the
 * Keychain and reads files under ~/Library/Application Support/Google/Chrome.
 * Inside the App Sandbox that path belongs to another app's container and is
 * unreachable, so the flag can only ever fail there. A user-supplied
 * Netscape cookies.txt (picked through an open panel, i.e. a security-scoped
 * bookmark) is the only lawful equivalent under MAS.
 */
function getCookieArgs() {
  const file = String(process.env.YTDLP_COOKIES_FILE || "").trim();
  if (file && fs.existsSync(file)) {
    return ["--cookies", file];
  }
  if (IS_SANDBOXED) {
    return [];
  }
  return ["--cookies-from-browser", "chrome"];
}

/**
 * Drop cookie flags a user may have pasted into YTDLP_EXTRA_ARGS. Under the
 * sandbox they cannot work, and a hard failure is worse than an anonymous
 * attempt that may still succeed.
 */
function stripBrowserCookieArgs(args) {
  const result = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--cookies-from-browser") {
      index++;
      continue;
    }
    result.push(args[index]);
  }
  return result;
}

function applyCookiePolicy(args) {
  return IS_SANDBOXED ? stripBrowserCookieArgs(args) : args;
}

function runtimeMode() {
  if (IS_MAS) return "mas";
  if (process.resourcesPath &&
      !String(process.resourcesPath).includes("node_modules") &&
      String(process.execPath).includes(".app/Contents/MacOS")) {
    return "direct";
  }
  return "dev";
}

module.exports = {
  IS_MAC,
  IS_MAS,
  IS_SANDBOXED,
  BINARY_NAMES,
  findBinary,
  resolveBinary,
  binaryReport,
  getCookieArgs,
  stripBrowserCookieArgs,
  applyCookiePolicy,
  runtimeMode
};
