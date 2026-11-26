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
# ---- v2: projects from templates, built for real on this machine
if [ "${E2E_TEMPLATES:-0}" = "1" ]; then
  for tpl in compose views webview; do
    pid="$(api -X POST -d "{\"name\":\"CI ${tpl}\",\"packageName\":\"dev.ci.${tpl}\",\"template\":\"${tpl}\"}" "$BASE/api/projects" | j o.id)"
    echo "--- template $tpl -> project $pid" >&2
    bid="$(api -X POST -d '{"task":"assembleDebug"}' "$BASE/api/projects/$pid/builds" | j o.id)"
    for _ in $(seq 1 360); do
      st="$(api "$BASE/api/builds/$bid" | j o.state)"
      case "$st" in succeeded|failed|cancelled) break ;; esac
      sleep 5
    done
    api "$BASE/api/builds/$bid/log" > "$OUT/template-$tpl.log"
    if [ "$st" != "succeeded" ]; then echo "template $tpl build: $st" >&2; tail -n 100 "$OUT/template-$tpl.log" >&2; exit 1; fi
    grep -E 'BUILD SUCCESSFUL|^APK:' "$OUT/template-$tpl.log" >&2
    curl -fsS -b "$JAR" -o "$OUT/template-$tpl.apk" "$BASE/api/builds/$bid/apk"
  done
fi

# ---- Google Play: upload key -> signed bundleRelease -> readiness checks on the real .aab
if [ "${E2E_TEMPLATES:-0}" = "1" ]; then
  echo "--- Play: upload key + signed AAB for ci-compose" >&2
  api -X POST -d '{"name":"Vendroid CI","country":"ID"}' "$BASE/api/projects/ci-compose/signing/generate" | j '{alias:o.alias,owner:o.owner}'
  bid="$(api -X POST -d '{"task":"bundleRelease"}' "$BASE/api/projects/ci-compose/builds" | j o.id)"
  for _ in $(seq 1 360); do
    st="$(api "$BASE/api/builds/$bid" | j o.state)"
    case "$st" in succeeded|failed|cancelled) break ;; esac
    sleep 5
  done
  api "$BASE/api/builds/$bid/log" > "$OUT/template-compose-aab.log"
  if [ "$st" != "succeeded" ]; then echo "bundleRelease: $st" >&2; tail -n 100 "$OUT/template-compose-aab.log" >&2; exit 1; fi
  [ "$(api "$BASE/api/builds/$bid" | j o.signed)" = "true" ] || { echo "bundle not signed"; exit 1; }
  curl -fsS -b "$JAR" -o "$OUT/template-compose.aab" "$BASE/api/builds/$bid/apk"
  unzip -l "$OUT/template-compose.aab" | grep -q 'base/manifest/AndroidManifest.xml' || { echo "not an app bundle"; exit 1; }
  unzip -l "$OUT/template-compose.aab" | grep -qE 'META-INF/[A-Z0-9_]+\.(RSA|SF)' || { echo "bundle has no signature"; exit 1; }
  api "$BASE/api/projects/ci-compose/play" > "$OUT/play.json"
  j 'o.checks.map(c=>c.status.padEnd(5)+" "+c.title+": "+c.detail.split("\n")[0]).join("\n")' < "$OUT/play.json"
  for id in target-sdk signing bundle page-size debuggable; do
    st="$(j "o.checks.find(c=>c.id==='$id').status" < "$OUT/play.json")"
    [ "$st" = "pass" ] || { echo "Play check $id: $st"; exit 1; }
  done
fi

# ---- v2: MCP endpoint answers with the agent token
TOKEN="$(api "$BASE/api/agent/info" | j o.token)"
tools="$(curl -fsS -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$BASE/mcp" | j 'o.result.tools.length')"
echo "--- MCP tools: $tools"
[ "$tools" -ge 32 ] || { echo "MCP tools/list failed"; exit 1; }

echo "--- e2e OK (artifacts in $OUT)"
echo "PKG=$PKG"
