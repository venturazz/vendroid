#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_PROJECT_PATH="${ANDROID_PROJECT_PATH:-/workspace/android-project}"
export DATA_DIR="${DATA_DIR:-/data}"

# Gradle runs on this JDK; the other installed JDKs stay available for Gradle toolchains.
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME="/usr/lib/jvm/java-${JAVA_VERSION:-17}-openjdk-$(dpkg --print-architecture)"
  export JAVA_HOME
fi
export PATH="$JAVA_HOME/bin:$PATH"

mkdir -p "$ANDROID_PROJECT_PATH" "$DATA_DIR" /root/.android
chmod 700 /root/.android

# Optional: clone the Android project on first start (HTTPS URL; may embed a read-only token).
if [ -n "${PROJECT_GIT_URL:-}" ] && [ ! -d "$ANDROID_PROJECT_PATH/.git" ] && [ -z "$(ls -A "$ANDROID_PROJECT_PATH")" ]; then
  echo "[entrypoint] cloning project (branch ${PROJECT_GIT_BRANCH:-main}) into $ANDROID_PROJECT_PATH"
  git clone --branch "${PROJECT_GIT_BRANCH:-main}" -- "$PROJECT_GIT_URL" "$ANDROID_PROJECT_PATH" \
    || echo "[entrypoint] WARNING: clone failed; fix PROJECT_GIT_URL and redeploy"
fi

# SDK install runs in the background so the dashboard is reachable immediately on first boot.
# Queued builds wait for it (state in $ANDROID_HOME/.bootstrap_state, log in $DATA_DIR/bootstrap.log).
if [ "${SDK_AUTO_INSTALL:-true}" = "true" ]; then
  ( /opt/runner/scripts/bootstrap-sdk.sh 2>&1 | tee "$DATA_DIR/bootstrap.log" ) &
elif [ "$(cat "$ANDROID_HOME/.bootstrap_state" 2>/dev/null)" = "running" ]; then
  rm -f "$ANDROID_HOME/.bootstrap_state" # stale marker from an interrupted install
fi

exec node /opt/runner/src/server.js
