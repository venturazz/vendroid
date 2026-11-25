#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export WORKSPACES_DIR="${WORKSPACES_DIR:-/workspace}"
export DATA_DIR="${DATA_DIR:-/data}"

# Gradle runs on this JDK; the other installed JDKs stay available for Gradle toolchains.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="/usr/lib/jvm/java-${JAVA_VERSION:-17}-openjdk-$(dpkg --print-architecture)"
  export JAVA_HOME
fi
export PATH="$JAVA_HOME/bin:$PATH"

mkdir -p "$WORKSPACES_DIR" "$DATA_DIR" /root/.android
chmod 700 /root/.android

# v1 compatibility: a project cloned into /workspace/android-project shows up as a project in the Hub.
# Optional first-start clone (PROJECT_GIT_URL); more projects can be created or cloned from the Hub.
if [ -n "${PROJECT_GIT_URL:-}" ]; then
  target="${ANDROID_PROJECT_PATH:-$WORKSPACES_DIR/$(basename "${PROJECT_GIT_URL%.git}")}"
  if [ ! -e "$target" ] || [ -z "$(ls -A "$target" 2>/dev/null)" ]; then
    echo "[entrypoint] cloning project (branch ${PROJECT_GIT_BRANCH:-main}) into $target"
    if [ -n "${GIT_TOKEN:-}" ]; then
      GIT_ASKPASS=/opt/runner/scripts/git-askpass.sh VENDROID_GIT_TOKEN="$GIT_TOKEN" GIT_TERMINAL_PROMPT=0 \
        git -c credential.helper= clone --branch "${PROJECT_GIT_BRANCH:-main}" -- "$PROJECT_GIT_URL" "$target" \
        || echo "[entrypoint] WARNING: clone failed; fix PROJECT_GIT_URL/GIT_TOKEN or clone from the Hub"
    else
      git clone --branch "${PROJECT_GIT_BRANCH:-main}" -- "$PROJECT_GIT_URL" "$target" \
        || echo "[entrypoint] WARNING: clone failed; fix PROJECT_GIT_URL or clone from the Hub"
    fi
  fi
fi

# SDK install runs in the background so the dashboard is reachable immediately on first boot.
# Queued builds wait for it (state in $ANDROID_HOME/.bootstrap_state, log in $DATA_DIR/bootstrap.log).
if [ "${SDK_AUTO_INSTALL:-true}" = "true" ]; then
  ( /opt/runner/scripts/bootstrap-sdk.sh 2>&1 | tee "$DATA_DIR/bootstrap.log" ) &
elif [ "$(cat "$ANDROID_HOME/.bootstrap_state" 2>/dev/null)" = "running" ]; then
  rm -f "$ANDROID_HOME/.bootstrap_state" # stale marker from an interrupted install
fi

exec node /opt/runner/src/server.js
