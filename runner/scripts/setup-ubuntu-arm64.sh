#!/usr/bin/env bash
# Direct (non-Docker) install on Ubuntu 22.04/24.04 aarch64. Idempotent: re-run it to upgrade.
#   sudo bash runner/scripts/setup-ubuntu-arm64.sh
# Optional env: PROJECT_GIT_URL, PROJECT_GIT_BRANCH, BUILD_BOX64=1, AAPT2_MODE, SKIP_SDK=1
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ "$(uname -m)" = "aarch64" ] || echo "WARNING: this host is $(uname -m), not aarch64"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR=/opt/android-runner
SDK_DIR=/opt/android-sdk
STATE_DIR=/var/lib/android-runner
ENV_FILE=/etc/android-runner.env
PROJECT_DIR=/srv/android-project
SVC_USER=android-runner
log() { echo -e "\033[1;32m==>\033[0m $*"; }
# Commands below run as the service user, which usually cannot read the caller's working directory.
cd /

log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends \
  openjdk-17-jdk-headless openjdk-21-jdk-headless git curl unzip ca-certificates adb openssl rsync

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  log "installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

if [ "${BUILD_BOX64:-0}" = "1" ] && ! command -v box64 >/dev/null; then
  log "building box64"
  apt-get install -y -q --no-install-recommends cmake build-essential python3
  git clone --depth 1 https://github.com/ptitSeb/box64 /tmp/box64
  cmake -S /tmp/box64 -B /tmp/box64/build -DARM_DYNAREC=ON -DCMAKE_BUILD_TYPE=RelWithDebInfo
  cmake --build /tmp/box64/build -j"$(nproc)" && cmake --install /tmp/box64/build
  rm -rf /tmp/box64
fi

log "creating user and directories"
id "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$STATE_DIR" --create-home --shell /usr/sbin/nologin "$SVC_USER"
mkdir -p "$APP_DIR" "$SDK_DIR" "$PROJECT_DIR" "$STATE_DIR/data" "$STATE_DIR/.android" "$STATE_DIR/.gradle"
rsync -a --delete --exclude node_modules --exclude data --exclude test "$REPO_DIR/runner/" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chmod +x "$APP_DIR"/scripts/*.sh
chown -R "$SVC_USER:$SVC_USER" "$STATE_DIR" "$SDK_DIR" "$PROJECT_DIR"
chmod 700 "$STATE_DIR/.android"

JAVA_HOME_17="/usr/lib/jvm/java-17-openjdk-$(dpkg --print-architecture)"

NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  log "creating $ENV_FILE"
  install -m 640 -o root -g "$SVC_USER" "$REPO_DIR/.env.example" "$ENV_FILE"
  NEW_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  sed -i "s|^AUTH_PASSWORD=.*|AUTH_PASSWORD=$NEW_PASSWORD|" "$ENV_FILE"
  grep -q '^JAVA_HOME=' "$ENV_FILE" || echo "JAVA_HOME=$JAVA_HOME_17" >> "$ENV_FILE"
fi
chgrp "$SVC_USER" "$ENV_FILE"
chmod 640 "$ENV_FILE"

# Optional first clone of the Android project
if [ -n "${PROJECT_GIT_URL:-}" ] && [ -z "$(ls -A "$PROJECT_DIR")" ]; then
  log "cloning $PROJECT_GIT_URL"
  sudo -u "$SVC_USER" git clone --branch "${PROJECT_GIT_BRANCH:-main}" -- "$PROJECT_GIT_URL" "$PROJECT_DIR"
fi

if [ "${SKIP_SDK:-0}" != "1" ]; then
  log "installing Android SDK + aarch64 build tools (first run takes a few minutes)"
  # shellcheck disable=SC2046
  sudo -u "$SVC_USER" env HOME="$STATE_DIR" JAVA_HOME="$JAVA_HOME_17" ANDROID_HOME="$SDK_DIR" \
    AAPT2_MODE="${AAPT2_MODE:-auto}" AAPT2_BINARY="${AAPT2_BINARY:-}" \
    SDK_PACKAGES="$(sed -n 's/^SDK_PACKAGES="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ENV_FILE" | tail -n1)" \
    "$APP_DIR/scripts/bootstrap-sdk.sh"
fi

log "installing systemd unit"
install -m 644 "$REPO_DIR/deploy/systemd/android-runner.service" /etc/systemd/system/android-runner.service
systemctl daemon-reload
systemctl enable android-runner >/dev/null
systemctl restart android-runner

for _ in $(seq 1 30); do
  curl -fs "http://127.0.0.1:$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n1 || echo 3080)/healthz" >/dev/null 2>&1 && break
  sleep 1
done
systemctl is-active --quiet android-runner && log "android-runner is running" || { journalctl -u android-runner -n 50 --no-pager; exit 1; }

echo
log "Next steps"
echo "  1. Edit $ENV_FILE: DEFAULT_PACKAGE_NAME, DEFAULT_DEVICE_ADDRESS, AI keys; then: systemctl restart android-runner"
[ -z "$(ls -A "$PROJECT_DIR")" ] && echo "  2. Put your project in $PROJECT_DIR:  sudo -u $SVC_USER git clone <url> $PROJECT_DIR"
echo "  3. HTTPS: deploy/proxy/Caddyfile (Caddy) or deploy/proxy/nginx.conf (Nginx) -> 127.0.0.1:3080"
[ -n "$NEW_PASSWORD" ] && echo -e "\n  Dashboard password: \033[1m$NEW_PASSWORD\033[0m  (stored in $ENV_FILE)"
echo "  Logs: journalctl -u android-runner -f"
