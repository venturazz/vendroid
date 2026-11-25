#!/usr/bin/env bash
# Verifies APKs with the SDK's own tools (run where ANDROID_HOME and the aarch64 aapt2 live).
#   verify-apk.sh <apk> <expected-package> [expect-signed-by-CN]
set -euo pipefail
APK="$1"; PKG="$2"; CN="${3:-}"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
AAPT2="$(cat "$SDK/.aapt2_path")"
BT="$(ls -d "$SDK"/build-tools/*/ | sort -V | tail -n1)"
"$AAPT2" dump badging "$APK" | head -n 3
"$AAPT2" dump badging "$APK" | grep -q "package: name='$PKG'" || { echo "unexpected package"; exit 1; }
"$BT/apksigner" verify --print-certs "$APK" | tee /tmp/certs.txt | head -n 3
if [ -n "$CN" ]; then grep -q "CN=$CN" /tmp/certs.txt || { echo "not signed by CN=$CN"; exit 1; }; fi
echo "verified $APK"
