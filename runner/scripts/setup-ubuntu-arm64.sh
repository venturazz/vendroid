#!/usr/bin/env bash
# Direct (non-Docker) install on Ubuntu 22.04/24.04 aarch64. Run as root from the repo root:
#   sudo bash runner/scripts/setup-ubuntu-arm64.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root"; exit 1; }
[ "$(uname -m)" = "aarch64" ] || echo "WARNING: not aarch64 ($(uname -m))"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/android-runner
SDK_DIR="${ANDROID_HOME:-/opt/android-sdk}"
STATE_DIR=/var/lib/android-runner
PROJECT_DIR="${ANDROID_PROJECT_PATH:-/srv/android-project}"
JDK_PACKAGE="${JDK_PACKAGE:-openjdk-17-jdk-headless}"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends "$JDK_PACKAGE" git curl unzip ca-certificates adb
# aapt (native arm64 aapt2, if packaged by your release) - optional, bootstrap-sdk.sh verifies it works.
apt-get install -y --no-install-recommends aapt || echo "aapt package unavailable; use AAPT2_MODE=box64 or path"

# Node.js >= 20 (NodeSource) if missing
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# Optional box64 fallback for the x86_64 aapt2 shipped in SDK build-tools:  BUILD_BOX64=1
if [ "${BUILD_BOX64:-0}" = "1" ] && ! command -v box64 >/dev/null; then
  apt-get install -y --no-install-recommends cmake build-essential python3
  git clone --depth 1 https://github.com/ptitSeb/box64 /tmp/box64
  cmake -S /tmp/box64 -B /tmp/box64/build -DARM_DYNAREC=ON -DCMAKE_BUILD_TYPE=RelWithDebInfo
  cmake --build /tmp/box64/build -j"$(nproc)" && cmake --install /tmp/box64/build
  rm -rf /tmp/box64
fi

id android-runner >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin android-runner
mkdir -p "$APP_DIR" "$SDK_DIR" "$PROJECT_DIR" "$STATE_DIR/data" "$STATE_DIR/.android" "$STATE_DIR/.gradle"
rsync -a --delete --exclude node_modules --exclude data "$REPO_DIR/runner/" "$APP_DIR/" 2>/dev/null \
  || { rm -rf "$APP_DIR"/*; cp -a "$REPO_DIR/runner/." "$APP_DIR/"; }
chown -R root:root "$APP_DIR"; chmod +x "$APP_DIR"/scripts/*.sh
chown -R android-runner:android-runner "$STATE_DIR" "$SDK_DIR" "$PROJECT_DIR"
chmod 700 "$STATE_DIR/.android"

if [ ! -f /etc/android-runner.env ]; then
  install -m 600 -o root -g android-runner "$REPO_DIR/.env.example" /etc/android-runner.env
  sed -i "s|^AUTH_PASSWORD=.*|AUTH_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')|" /etc/android-runner.env
  echo "Created /etc/android-runner.env (random AUTH_PASSWORD). Edit it: package, phone address, AI keys."
fi
chgrp android-runner /etc/android-runner.env; chmod 640 /etc/android-runner.env

# SDK + aapt2 as the service user (JAVA_HOME resolved from the installed JDK)
JAVA_HOME_DETECTED="$(dirname "$(dirname "$(readlink -f "$(command -v javac)")")")"
sudo -u android-runner env HOME="$STATE_DIR" JAVA_HOME="$JAVA_HOME_DETECTED" ANDROID_HOME="$SDK_DIR" \
  AAPT2_MODE="${AAPT2_MODE:-auto}" "$APP_DIR/scripts/bootstrap-sdk.sh"

install -m 644 "$REPO_DIR/deploy/systemd/android-runner.service" /etc/systemd/system/android-runner.service
systemctl daemon-reload
systemctl enable --now android-runner
echo "Done. Status: systemctl status android-runner   Logs: journalctl -u android-runner -f"
echo "Put your Android project in $PROJECT_DIR (git clone as android-runner) and set ANDROID_PROJECT_PATH."
