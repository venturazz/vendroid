#!/usr/bin/env bash
# Idempotent Android SDK + aarch64 aapt2 bootstrap. Used by the Docker entrypoint and by the
# direct-Linux setup script. Safe to re-run; skips whatever is already present.
#
#   ANDROID_HOME          SDK location                      (default /opt/android-sdk)
#   SDK_PACKAGES          sdkmanager packages (space sep.)  (default "platforms;android-35 build-tools;35.0.0")
#   CMDLINE_TOOLS_BUILD   cmdline-tools zip build number    (default 11076708)
#   AAPT2_MODE            auto | apt | box64 | path         (default auto)
#   AAPT2_BINARY          native aarch64 aapt2 for mode "path"
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
SDK_PACKAGES="${SDK_PACKAGES:-platforms;android-35 build-tools;35.0.0}"
CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-11076708}"
AAPT2_MODE="${AAPT2_MODE:-auto}"
log() { echo "[bootstrap-sdk] $*"; }

mkdir -p "$ANDROID_HOME"

# --- 1. cmdline-tools (pure Java, architecture independent) -----------------------------------
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  log "installing cmdline-tools $CMDLINE_TOOLS_BUILD"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" -o "$tmp/ct.zip"
  unzip -q "$tmp/ct.zip" -d "$tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi

# --- 2. SDK packages -----------------------------------------------------------------------------
# platform-tools is intentionally NOT installed: Google's build is x86_64 only. The runner uses the
# distro's native arm64 adb (package android-tools-adb / adb).
missing=()
IFS=' ' read -r -a pkgs <<< "$SDK_PACKAGES"
for p in "${pkgs[@]}"; do
  [ -d "$ANDROID_HOME/${p//;//}" ] || missing+=("$p")
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "accepting licenses and installing: ${missing[*]}"
  yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null || true
  "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "${missing[@]}"
fi

# --- 3. aarch64 aapt2 ------------------------------------------------------------------------------
# Strategy: Gradle's `android.aapt2FromMavenOverride` (written by the runner into
# $GRADLE_USER_HOME/gradle.properties) points at a working aapt2. We record that path in
# $ANDROID_HOME/.aapt2_path which the runner reads at startup.
works() { [ -x "$1" ] && "$1" version >/dev/null 2>&1; }
choose=""

try_path() { [ -n "${AAPT2_BINARY:-}" ] && works "$AAPT2_BINARY" && choose="$AAPT2_BINARY"; }
try_apt()  { local b; b="$(command -v aapt2 2>/dev/null || true)"; [ -n "$b" ] && works "$b" && choose="$b"; }
try_box64() {
  command -v box64 >/dev/null 2>&1 || return 1
  local x86; x86="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -n1 || true)"
  [ -n "$x86" ] || return 1
  mkdir -p "$ANDROID_HOME/aapt2-box64"
  printf '#!/bin/sh\nexec box64 "%s" "$@"\n' "$x86" > "$ANDROID_HOME/aapt2-box64/aapt2"
  chmod 0755 "$ANDROID_HOME/aapt2-box64/aapt2"
  works "$ANDROID_HOME/aapt2-box64/aapt2" && choose="$ANDROID_HOME/aapt2-box64/aapt2"
}

case "$AAPT2_MODE" in
  path)  try_path || true ;;
  apt)   try_apt || true ;;
  box64) try_box64 || true ;;
  auto)  try_path || try_apt || try_box64 || true ;;
  *) log "unknown AAPT2_MODE=$AAPT2_MODE"; exit 2 ;;
esac

if [ -z "$choose" ]; then
  log "ERROR: no working aarch64 aapt2 found (mode=$AAPT2_MODE)."
  log "  - apt:   apt install aapt        (only helps if your distro ships /usr/bin/aapt2 in it; check `dpkg -L aapt`)"
  log "  - box64: install box64, re-run with AAPT2_MODE=box64"
  log "  - path:  set AAPT2_BINARY=/path/to/native/aarch64/aapt2 and AAPT2_MODE=path"
  exit 1
fi
echo "$choose" > "$ANDROID_HOME/.aapt2_path"
log "aapt2 -> $choose ($("$choose" version 2>&1 | head -n1))"
