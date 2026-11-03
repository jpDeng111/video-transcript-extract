#!/usr/bin/env bash
# Stage the external tools the app shells out to into ./bin, so the packaged
# .app carries its own copy instead of depending on the user's Homebrew setup.
#
#   bin/yt-dlp    universal2 single-file binary (GitHub release)
#   bin/ffmpeg    static build, LGPL preferred (see note below)
#   bin/ffprobe   static build
#
# Usage: npm run fetch:binaries
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$ROOT/bin"
mkdir -p "$BIN_DIR"

echo "==> staging into $BIN_DIR"

# ---------------------------------------------------------------- yt-dlp ----
if [[ -x "$BIN_DIR/yt-dlp" ]]; then
  echo "    yt-dlp already staged, skipping"
else
  echo "==> downloading yt-dlp (universal2)"
  curl -L --fail --progress-bar \
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" \
    -o "$BIN_DIR/yt-dlp"
  chmod +x "$BIN_DIR/yt-dlp"
fi

# ---------------------------------------------------------------- ffmpeg ----
if [[ -x "$BIN_DIR/ffmpeg" && -x "$BIN_DIR/ffprobe" ]]; then
  echo "    ffmpeg/ffprobe already staged, skipping"
else
  echo ""
  echo "==> ffmpeg / ffprobe need a STATIC build. Two options:"
  echo ""
  echo "    A. Apple Silicon (recommended, LGPL static build):"
  echo "       https://www.osxexperts.net/  ->  ffmpeg 7.x arm64  ->  unzip into ./bin"
  echo ""
  echo "    B. If dylibbundler is installed, bundle your Homebrew copy:"
  echo "       brew install dylibbundler"
  echo "       cp \"\$(brew --prefix)/bin/ffmpeg\" \"\$(brew --prefix)/bin/ffprobe\" ./bin/"
  echo "       dylibbundler -od -b -x ./bin/ffmpeg -x ./bin/ffprobe -d ./bin/lib -p @executable_path/lib"
  echo ""
  echo "    Do NOT copy a Homebrew binary on its own: it links against"
  echo "    /opt/homebrew/... dylibs and will die on any other Mac."
  echo ""
  if command -v dylibbundler >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
    echo "==> dylibbundler found, bundling Homebrew ffmpeg automatically"
    cp "$(brew --prefix)/bin/ffmpeg" "$BIN_DIR/ffmpeg"
    cp "$(brew --prefix)/bin/ffprobe" "$BIN_DIR/ffprobe"
    chmod +w "$BIN_DIR/ffmpeg" "$BIN_DIR/ffprobe"
    dylibbundler -od -b \
      -x "$BIN_DIR/ffmpeg" -x "$BIN_DIR/ffprobe" \
      -d "$BIN_DIR/lib" -p "@executable_path/lib"
  else
    echo "!! ffmpeg not staged yet. Re-run this script after downloading it."
    exit 1
  fi
fi

# ------------------------------------------------------------------ sign ----
# Ad-hoc sign so the binaries survive Gatekeeper/codesign checks during local
# testing. electron-builder re-signs them with your Developer ID at package time.
if command -v codesign >/dev/null 2>&1; then
  for tool in yt-dlp ffmpeg ffprobe; do
    [[ -f "$BIN_DIR/$tool" ]] && codesign --force --sign - "$BIN_DIR/$tool" 2>/dev/null || true
  done
fi

echo ""
echo "==> done"
for tool in yt-dlp ffmpeg ffprobe; do
  if [[ -x "$BIN_DIR/$tool" ]]; then
    printf "    %-8s %s\n" "$tool" "$("$BIN_DIR/$tool" -version 2>&1 | head -n1 | cut -c1-60)"
  else
    printf "    %-8s MISSING\n" "$tool"
  fi
done
echo ""
echo "Next: npm run check:mas   (preflight before packaging)"
