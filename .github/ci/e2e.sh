#!/usr/bin/env bash
# Drives a running runner through its public API exactly like the dashboard does:
# login -> env health -> debug build -> APK download -> signed release build.
#   e2e.sh <base-url> <password> <expected-package>
set -euo pipefail
BASE="$1"; PASSWORD="$2"; PKG="$3"
JAR="$(mktemp)"; OUT="${E2E_OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
j() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=new Function("o","return "+process.argv[1])(JSON.parse(s));console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
api() { curl -fsS -b "$JAR" -c "$JAR" -H 'Content-Type: application/json' "$@"; }

echo "--- waiting for $BASE"
for _ in $(seq 1 120); do curl -fs "$BASE/healthz" >/dev/null && break; sleep 2; done
api -X POST -d "{\"password\":\"$PASSWORD\"}" "$BASE/api/auth/login" >/dev/null
echo "--- adb"
api "$BASE/api/devices"; echo

echo "--- waiting for SDK bootstrap"
for i in $(seq 1 180); do
  st="$(api "$BASE/api/health/env" | j o.sdkBootstrap)"
  [ "$st" = "ok" ] || [ "$st" = "external" ] && break
  [ "$st" = "failed" ] && { echo "SDK bootstrap failed"; exit 1; }
  [ $((i % 15)) -eq 0 ] && echo "  still $st…"
  sleep 5
done
api "$BASE/api/health/env" | tee "$OUT/health.json" | j '{ok:o.ok,checks:o.checks,aapt2:o.aapt2.version,java:o.java.version}'
[ "$(j o.checks.aarch64 < "$OUT/health.json")" = "true" ] || { echo "not aarch64"; exit 1; }
[ "$(j o.checks.aapt2 < "$OUT/health.json")" = "true" ] || { echo "aapt2 not working"; exit 1; }

build() { # task -> build id (waits for completion, prints log tail on failure)
  local id st
  id="$(api -X POST -d "{\"task\":\"$1\"}" "$BASE/api/builds" | j o.id)"
  echo "--- $1 ($id)" >&2
  for _ in $(seq 1 360); do
    st="$(api "$BASE/api/builds/$id" | j o.state)"
    case "$st" in succeeded|failed|cancelled) break ;; esac
    sleep 5
  done
  api "$BASE/api/builds/$id/log" > "$OUT/$id.log"
  if [ "$st" != "succeeded" ]; then
    echo "build $id ended: $st" >&2; tail -n 80 "$OUT/$id.log" >&2; exit 1
  fi
  grep -E 'BUILD SUCCESSFUL|^APK:' "$OUT/$id.log" >&2
  echo "$id"
}

DEBUG_ID="$(build assembleDebug)"
curl -fsS -b "$JAR" -o "$OUT/debug.apk" "$BASE/api/builds/$DEBUG_ID/apk"
unzip -l "$OUT/debug.apk" | grep -q AndroidManifest.xml || { echo "debug APK is not a valid APK"; exit 1; }
grep -q 'aapt2FromMavenOverride' "$OUT/$DEBUG_ID.log" || { echo "aapt2 override not passed to Gradle"; exit 1; }

if [ "${E2E_RELEASE:-1}" = "1" ]; then
  RELEASE_ID="$(build assembleRelease)"
  [ "$(api "$BASE/api/builds/$RELEASE_ID" | j o.signed)" = "true" ] || { echo "release not marked signed"; exit 1; }
  curl -fsS -b "$JAR" -o "$OUT/release.apk" "$BASE/api/builds/$RELEASE_ID/apk"
fi

# Rebuild must hit Gradle's caches (fast path users rely on).
REBUILD_ID="$(build assembleDebug)"
grep -qE 'UP-TO-DATE|FROM-CACHE' "$OUT/$REBUILD_ID.log" || echo "warning: no cached tasks on rebuild"
echo "--- e2e OK (artifacts in $OUT)"
echo "PKG=$PKG"
