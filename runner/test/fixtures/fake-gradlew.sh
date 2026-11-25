#!/bin/sh
# Test double for ./gradlew. Controlled by marker files next to it.
D="$(cd "$(dirname "$0")" && pwd)"
echo "fake gradle: $*"
echo "leaked-secrets: $(env | grep -cE '^(AUTH_PASSWORD|NINE_ROUTER_API_KEY|HERMES_WEBHOOK_SECRET|RELEASE_KEYSTORE_PASSWORD)=')"
echo "signing-env: $(env | grep -c 'injected.signing')"
echo "signing-props: $(grep -c '^android.injected.signing' "$GRADLE_USER_HOME/gradle.properties")"
if [ -f "$D/FAIL" ]; then
  echo "e: file:///app/src/main/java/Main.kt:3:1 Unresolved reference: foo"
  echo "* What went wrong:"
  echo "Execution failed for task ':app:compileDebugKotlin'."
  exit 1
fi
[ -f "$D/SLOW" ] && sleep 30
variant=debug
case "$*" in *assembleRelease*) variant=release ;; esac
mkdir -p "$D/app/build/outputs/apk/$variant"
# Real (tiny) ZIPs: a valid APK layout, or one missing the manifest when BROKEN exists.
GOOD_APK='UEsDBBQAAAAAAFMYeV1o8gHhAQAAAAEAAAATAAAAQW5kcm9pZE1hbmlmZXN0LnhtbG1QSwMEFAAAAAAAUxh5XZ3/CWwBAAAAAQAAAA4AAAByZXNvdXJjZXMuYXJzY3JQSwMEFAAAAAAAUxh5XcxK3ZgBAAAAAQAAAAsAAABjbGFzc2VzLmRleGRQSwECFAMUAAAAAABTGHldaPIB4QEAAAABAAAAEwAAAAAAAAAAAAAAgAEAAAAAQW5kcm9pZE1hbmlmZXN0LnhtbFBLAQIUAxQAAAAAAFMYeV2d/wlsAQAAAAEAAAAOAAAAAAAAAAAAAACAATIAAAByZXNvdXJjZXMuYXJzY1BLAQIUAxQAAAAAAFMYeV3MSt2YAQAAAAEAAAALAAAAAAAAAAAAAACAAV8AAABjbGFzc2VzLmRleFBLBQYAAAAAAwADALYAAACJAAAAAAA='
BAD_APK='UEsDBBQAAAAAAFMYeV3MSt2YAQAAAAEAAAALAAAAY2xhc3Nlcy5kZXhkUEsBAhQDFAAAAAAAUxh5XcxK3ZgBAAAAAQAAAAsAAAAAAAAAAAAAAIABAAAAAGNsYXNzZXMuZGV4UEsFBgAAAAABAAEAOQAAACoAAAAAAA=='
if [ -f "$D/BROKEN" ]; then b64="$BAD_APK"; else b64="$GOOD_APK"; fi
printf '%s' "$b64" | base64 -d > "$D/app/build/outputs/apk/$variant/app-$variant.apk"
echo "BUILD SUCCESSFUL in 1s"
