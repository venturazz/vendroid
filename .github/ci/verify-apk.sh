#!/usr/bin/env bash
# Verifies APKs with the SDK's own tools (run where ANDROID_HOME and the aarch64 aapt2 live).
#   verify-apk.sh <apk> <expected-package> [expect-signed-by-CN]
set -euo pipefail
APK="$1"; PKG="$2"; CN="${3:-}"
SDK="${ANDROID_HOME:-/opt/android-sdk}"
AAPT2="$(cat "$SDK/.aapt2_path")"
BT="$(find "$SDK/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n1)"
# apkanalyzer (Java) reads every resource format, including AGP 9's R8-optimized release resources.
APKANALYZER="$SDK/cmdline-tools/latest/bin/apkanalyzer"
app_id="$("$APKANALYZER" manifest application-id "$APK")"
echo "application-id: $app_id  min-sdk: $("$APKANALYZER" manifest min-sdk "$APK")  target-sdk: $("$APKANALYZER" manifest target-sdk "$APK")"
[ "$app_id" = "$PKG" ] || { echo "unexpected package $app_id"; exit 1; }
if badging="$("$AAPT2" dump badging "$APK" 2>&1)"; then sed -n 1p <<< "$badging"; else echo "note: aapt2 dump cannot parse this APK's resource format (expected for R8-optimized resources)"; fi
certs="$("$BT/apksigner" verify --print-certs "$APK")"
sed -n 1,2p <<< "$certs"
if [ -n "$CN" ]; then grep -q "CN=$CN" <<< "$certs" || { echo "not signed by CN=$CN"; exit 1; }; fi
echo "verified $APK"
