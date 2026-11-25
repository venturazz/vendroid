#!/usr/bin/env bash
set -euo pipefail
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
export ANDROID_PROJECT_PATH="${ANDROID_PROJECT_PATH:-/workspace/android-project}"

mkdir -p "$ANDROID_PROJECT_PATH" "${DATA_DIR:-/data}" /root/.android

# Optional: clone the Android project on first start (HTTPS URL; may embed a read-only token).
if [ -n "${PROJECT_GIT_URL:-}" ] && [ ! -d "$ANDROID_PROJECT_PATH/.git" ] && [ -z "$(ls -A "$ANDROID_PROJECT_PATH")" ]; then
  echo "[entrypoint] cloning project into $ANDROID_PROJECT_PATH"
  git clone --branch "${PROJECT_GIT_BRANCH:-main}" -- "$PROJECT_GIT_URL" "$ANDROID_PROJECT_PATH"
fi

if [ "${SDK_AUTO_INSTALL:-true}" = "true" ]; then
  /opt/runner/scripts/bootstrap-sdk.sh || echo "[entrypoint] SDK bootstrap failed; /api/health/env will report it"
fi

exec node /opt/runner/src/server.js
