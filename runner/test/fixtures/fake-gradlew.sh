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
printf 'PK-fake-%s' "$variant" > "$D/app/build/outputs/apk/$variant/app-$variant.apk"
echo "BUILD SUCCESSFUL in 1s"
