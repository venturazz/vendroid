#!/usr/bin/env bash
# Verifies APKs with the SDK's own tools (run where ANDROID_HOME and the aarch64 aapt2 live).
#   verify-apk.sh <apk> <expected-package> [expect-signed-by-CN]
set -euo pipefail
APK="$1"; PKG="$2"; CN="${3:-}"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
AAPT2="$(cat "$SDK/.aapt2_path")"
BT="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n1)"
badging="$("$AAPT2" dump badging "$APK")"
sed -n 1,3p <<< "$badging"
grep -q "package: name='$PKG'" <<< "$badging" || { echo "unexpected package"; exit 1; }
certs="$("$BT/apksigner" verify --print-certs "$APK")"
sed -n 1,2p <<< "$certs"
if [ -n "$CN" ]; then grep -q "CN=$CN" <<< "$certs" || { echo "not signed by CN=$CN"; exit 1; }; fi
echo "verified $APK"
