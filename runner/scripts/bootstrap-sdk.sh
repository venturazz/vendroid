#!/usr/bin/env bash
# Idempotent Android SDK + aarch64 toolchain bootstrap. Used by the Docker entrypoint and by the
# direct-Linux setup script. Safe to re-run; it skips whatever is already present.
#
#   ANDROID_HOME          SDK location                        (default /opt/android-sdk)
#   SDK_PACKAGES          sdkmanager packages (space separated) (default "platforms;android-35 build-tools;35.0.0")
#   CMDLINE_TOOLS_BUILD   cmdline-tools zip build number      (default 11076708)
#   AAPT2_MODE            auto | prebuilt | path | apt | box64 (default auto)
#   AAPT2_BINARY          native aarch64 aapt2 for mode "path"
#
# Why: Google ships aapt2/aidl/zipalign (SDK build-tools and the aapt2 Maven artifact AGP downloads)
# for x86_64 only. "prebuilt" installs statically linked aarch64 builds compiled from AOSP
# (github.com/lzhiyong/android-sdk-tools, pinned by SHA-256), swaps them into build-tools, and the
# runner points AGP at that aapt2 via android.aapt2FromMavenOverride.
set -euo pipefail

ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
SDK_PACKAGES="${SDK_PACKAGES:-platforms;android-35 build-tools;35.0.0}"
CMDLINE_TOOLS_BUILD="${CMDLINE_TOOLS_BUILD:-11076708}"
AAPT2_MODE="${AAPT2_MODE:-auto}"

PREBUILT_VERSION="35.0.2"
PREBUILT_URL="https://github.com/lzhiyong/android-sdk-tools/releases/download/${PREBUILT_VERSION}/android-sdk-tools-static-aarch64.zip"
PREBUILT_SHA256="db1cea2c4454d5f9c5a802646b2d1cf560b4ee7badbe23e51ab8e1881bb50fc2"
PREBUILT_DIR="$ANDROID_HOME/aarch64-tools/$PREBUILT_VERSION"

log() { echo "[bootstrap-sdk] $*"; }
ARCH="$(uname -m)"
tmp="$(mktemp -d)"
mkdir -p "$ANDROID_HOME"
# The runner reads this to show progress and to hold queued builds until the SDK is ready.
STATE_FILE="$ANDROID_HOME/.bootstrap_state"
echo running > "$STATE_FILE"
finish() {
  local rc=$?
  rm -rf "$tmp"
  if [ "$rc" -eq 0 ]; then echo ok > "$STATE_FILE"; else echo failed > "$STATE_FILE"; fi
}
trap finish EXIT

download() { # url dest
  curl -fsSL --retry 4 --retry-delay 3 --connect-timeout 20 "$1" -o "$2"
}

# ELF e_machine at offset 18: 0x3e = x86-64, 0xb7 = aarch64
elf_machine() { od -An -tx1 -j18 -N1 "$1" 2>/dev/null | tr -d ' \n'; }

# --- 1. cmdline-tools (pure Java, architecture independent) ---------------------------------------
SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
if [ ! -x "$SDKMANAGER" ]; then
  log "installing cmdline-tools $CMDLINE_TOOLS_BUILD"
  download "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_BUILD}_latest.zip" "$tmp/ct.zip"
  unzip -q "$tmp/ct.zip" -d "$tmp/ct"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/ct/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
fi

# --- 2. SDK packages -------------------------------------------------------------------------------
# Licenses are always (re)accepted so AGP can auto-download a missing platform/build-tools at build time.
yes 2>/dev/null | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses >/dev/null 2>&1 || true
missing=()
IFS=' ' read -r -a pkgs <<< "$SDK_PACKAGES"
for p in "${pkgs[@]}"; do
  [ -d "$ANDROID_HOME/${p//;//}" ] || missing+=("$p")
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "installing: ${missing[*]}"
  "$SDKMANAGER" --sdk_root="$ANDROID_HOME" "${missing[@]}" | grep -v '^\[=*' || true
  for p in "${missing[@]}"; do
    [ -d "$ANDROID_HOME/${p//;//}" ] || { log "ERROR: sdkmanager did not install $p"; exit 1; }
  done
fi

# --- 3. aarch64 native tools -------------------------------------------------------------------------
works() { [ -x "$1" ] && "$1" version >/dev/null 2>&1; }

install_prebuilt() {
  [ "$ARCH" = "aarch64" ] || return 1
  if [ ! -x "$PREBUILT_DIR/build-tools/aapt2" ]; then
    log "downloading aarch64 build-tools $PREBUILT_VERSION"
    download "$PREBUILT_URL" "$tmp/tools.zip"
    echo "$PREBUILT_SHA256  $tmp/tools.zip" | sha256sum -c --quiet - || { log "ERROR: checksum mismatch for $PREBUILT_URL"; return 1; }
    rm -rf "$PREBUILT_DIR"
    mkdir -p "$PREBUILT_DIR"
    unzip -q "$tmp/tools.zip" -d "$PREBUILT_DIR"
    chmod 0755 "$PREBUILT_DIR"/build-tools/* "$PREBUILT_DIR"/platform-tools/*
  fi
  works "$PREBUILT_DIR/build-tools/aapt2"
}

# Replace x86_64 executables inside every installed build-tools/<ver> with the aarch64 builds, so
# tasks that call them directly (AIDL, legacy aapt, zipalign) work too. Originals kept as *.x86_64.
patch_build_tools() {
  local bt bin name
  for bt in "$ANDROID_HOME"/build-tools/*/; do
    [ -d "$bt" ] || continue
    for bin in "$PREBUILT_DIR"/build-tools/*; do
      name="$(basename "$bin")"
      if [ -f "$bt$name" ] && [ "$(elf_machine "$bt$name")" = "3e" ]; then
        mv "$bt$name" "$bt$name.x86_64"
        cp "$bin" "$bt$name"
        chmod 0755 "$bt$name"
        log "patched ${bt#"$ANDROID_HOME"/}$name -> aarch64"
      fi
    done
  done
}

choose=""
try_path()     { [ -n "${AAPT2_BINARY:-}" ] && works "$AAPT2_BINARY" && choose="$AAPT2_BINARY"; }
try_prebuilt() { install_prebuilt && patch_build_tools && choose="$PREBUILT_DIR/build-tools/aapt2"; }
try_apt()      { local b; b="$(command -v aapt2 2>/dev/null || true)"; [ -n "$b" ] && works "$b" && choose="$b"; }
try_box64() {
  command -v box64 >/dev/null 2>&1 || return 1
  local x86
  x86="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2.x86_64 "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -n1 || true)"
  [ -n "$x86" ] || return 1
  mkdir -p "$ANDROID_HOME/aapt2-box64"
  printf '#!/bin/sh\nexec box64 "%s" "$@"\n' "$x86" > "$ANDROID_HOME/aapt2-box64/aapt2"
  chmod 0755 "$ANDROID_HOME/aapt2-box64/aapt2"
  works "$ANDROID_HOME/aapt2-box64/aapt2" && choose="$ANDROID_HOME/aapt2-box64/aapt2"
}
try_native_x86() { # x86_64 hosts (dev machines / CI): the SDK's own aapt2 works as-is
  [ "$ARCH" = "x86_64" ] || return 1
  local b
  b="$(ls -d "$ANDROID_HOME"/build-tools/*/aapt2 2>/dev/null | sort -V | tail -n1 || true)"
  [ -n "$b" ] && works "$b" && choose=""
}

case "$AAPT2_MODE" in
  path)     try_path || true ;;
  prebuilt) try_prebuilt || true ;;
  apt)      try_apt || true ;;
  box64)    try_box64 || true ;;
  auto)     try_path || try_prebuilt || try_apt || try_box64 || try_native_x86 || true ;;
  *) log "unknown AAPT2_MODE=$AAPT2_MODE"; exit 2 ;;
esac

if [ -n "$choose" ]; then
  echo "$choose" > "$ANDROID_HOME/.aapt2_path"
  log "aapt2 -> $choose ($("$choose" version 2>&1 | head -n1))"
elif [ "$ARCH" = "x86_64" ]; then
  rm -f "$ANDROID_HOME/.aapt2_path"
  log "x86_64 host: using the SDK's own aapt2 (no override needed)"
else
  log "ERROR: no working aarch64 aapt2 found (mode=$AAPT2_MODE). Options:"
  log "  AAPT2_MODE=prebuilt  (default; needs github.com reachable)"
  log "  AAPT2_MODE=path AAPT2_BINARY=/path/to/aarch64/aapt2"
  log "  AAPT2_MODE=box64     (install box64 first)"
  exit 1
fi

# adb: prefer a system adb; fall back to the static aarch64 adb from the prebuilt bundle.
if ! command -v adb >/dev/null 2>&1 && [ -x "$PREBUILT_DIR/platform-tools/adb" ]; then
  mkdir -p "$ANDROID_HOME/platform-tools"
  [ -e "$ANDROID_HOME/platform-tools/adb" ] || cp "$PREBUILT_DIR/platform-tools/adb" "$ANDROID_HOME/platform-tools/adb"
  log "adb -> $ANDROID_HOME/platform-tools/adb (static aarch64)"
fi
log "done"
