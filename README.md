# Android Remote Runner

Self-hosted web app for an **OCI Ampere ARM64 (aarch64) Ubuntu VM**. It builds Kotlin / Jetpack Compose
apps with Gradle, installs them on a **physical phone over ADB through a ZeroTier/WireGuard tunnel**,
streams build logs and filtered `logcat` live, and sends failures to **9Router** (instant analysis)
and **Hermes Agent** (deep investigation).

[![CI](https://github.com/venturazz/vendroid/actions/workflows/ci.yml/badge.svg)](https://github.com/venturazz/vendroid/actions/workflows/ci.yml)
CI builds a real Compose app on GitHub's arm64 runners, both in Docker and through the systemd installer,
against a pinned AGP 8 stack and the latest AGP/Gradle/Kotlin (rechecked weekly).

**Stack:** Node.js 20+ using only the standard library (no npm dependencies), vanilla HTML/CSS/JS
dashboard served by the same process. One codebase, two deployment modes; only environment variables differ.

## Quick start

**Coolify / Docker Compose**: deploy this repo with the Docker Compose build pack, give the `edge`
service a domain (`https://runner.example.com:3080`), set `DEFAULT_PACKAGE_NAME`,
`DEFAULT_DEVICE_ADDRESS` and `PROJECT_GIT_URL`, and deploy. The dashboard password is printed in the
`runner` logs on first start (or set `AUTH_PASSWORD`).

**Plain Ubuntu (systemd)**:
```bash
git clone https://github.com/venturazz/vendroid && cd vendroid
sudo PROJECT_GIT_URL=https://github.com/you/your-app.git bash runner/scripts/setup-ubuntu-arm64.sh
```
It prints the password at the end. Put Caddy or Nginx in front (`deploy/proxy/`).

Full instructions, phone pairing and troubleshooting: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.

## What you get

- **Build & Deploy in one click** (or `Ctrl+Enter`): optional `git pull`, Gradle build, install, launch, and the
  Logcat tab opens filtered to your app. One build runs at a time and the rest queue. Cancel kills the whole Gradle process group.
- **Push-to-deploy**: a GitHub/Gitea/GitLab webhook builds and installs every push (optional, `GIT_WEBHOOK_SECRET`).
- **Phone stays connected**: the runner re-runs `adb connect` on `DEFAULT_DEVICE_ADDRESS` whenever the tunnel or
  phone drops (with back-off), and the ADB key persists so the phone stays authorized after redeploys.
- **Logcat**: level/tag/keyword/package filters, pause/resume, export, automatic crash detection with a browser
  notification, **Triage Crash (9Router)** and **Investigate (Hermes)**.
- **Build console**: live log with replay after refresh, timer, commit info, log download,
  **Analyze Error (9Router)**, **Investigate (Hermes)**, and optional auto-notify Hermes on failure.
- **Device screen**: screenshot with auto-refresh and save, Install latest / any APK from history, Launch, Force stop, Clear data.
- **Signed release builds** without touching the project: set `RELEASE_KEYSTORE_*`.
- Desktop notifications when a build finishes. The dashboard remembers your toggles and filters.
- First boot needs no configuration: the password is generated, the SDK and aarch64 build tools install in the
  background, and queued builds wait for them.

## ARM64 toolchain

Google ships `aapt2`, `aidl` and `zipalign` for x86_64 only. The runner points AGP at Google's own `aapt2`, run under
box64 (installed by the image and the setup script), through `android.aapt2FromMavenOverride` in a managed block of
`$GRADLE_USER_HOME/gradle.properties`. The other build tools are swapped for native aarch64 builds. Your project needs no
changes, and every APK is checked for a manifest and resource table before it can reach the phone. Details and
alternatives: runbook §7. Gradle is capped at `-Xmx4096m -XX:+UseG1GC`, the Kotlin daemon at `-Xmx3072m`, with 3 workers.

## Layout

```
.
├── .env.example               # every setting, shared by systemd and Docker/Coolify
├── docker-compose.yml         # runner (host network) + edge (bridge, Coolify-routable)
├── deploy/
│   ├── systemd/android-runner.service
│   ├── ecosystem.config.cjs   # pm2 alternative
│   └── proxy/{Caddyfile,nginx.conf}
├── docs/RUNBOOK.md
├── .github/{workflows/ci.yml,ci/}   # arm64 end-to-end CI
└── runner/
    ├── Dockerfile.arm64
    ├── scripts/{setup-ubuntu-arm64.sh,bootstrap-sdk.sh,docker-entrypoint.sh}
    ├── src/
    │   ├── server.js     routes, auth gate, static UI, TCP + Unix-socket listeners
    │   ├── builds.js     single-worker queue, state machine, ring buffer, persistence, signing
    │   ├── adb.js        devices, actions, screenshot, filtered logcat
    │   ├── watchdog.js   tunnel ADB auto-reconnect
    │   ├── ai.js         9Router + Hermes + log slicing
    │   ├── webhook.js    git push webhook verification
    │   ├── edge.js       TCP -> Unix socket relay for Coolify
    │   └── auth.js config.js validate.js exec.js http.js sse.js health.js gradleProps.js
    ├── public/           login page + dashboard
    └── test/             node:test unit + integration suite (npm test)
```

## API

Every route requires the session cookie or `Authorization: Bearer $API_TOKEN`, except `/healthz`,
`/api/auth/*` and the webhook, which checks its signature.

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` `{password}` · `POST /api/auth/logout` | session cookie (HttpOnly, SameSite=Strict, Secure behind HTTPS) |
| `GET /api/health/env` | aarch64, Java, `$ANDROID_HOME`, adb, aapt2, SDK bootstrap, disk, RAM |
| `GET /api/config` · `GET /api/ai/status` | defaults and feature flags · 9Router / Hermes reachability |
| `POST /api/builds` `{task, gitPullBeforeBuild, autoInstallAfterBuild, autoLaunchAfterInstall, autoNotifyHermes, deviceSerial?, packageName?}` | enqueue `assembleDebug`, `assembleRelease` or `clean assembleDebug` |
| `GET /api/builds` · `GET /api/builds/:id` · `POST /api/builds/:id/cancel` | history · one build · cancel |
| `GET /api/builds/:id/stream` | SSE `line` / `state` / `end`, replays the ring buffer, honors `Last-Event-ID` |
| `GET /api/builds/:id/apk` · `GET /api/builds/:id/log` | artifact and full log download |
| `GET /api/devices` | parsed `adb devices -l` + auto-reconnect status |
| `POST /api/devices/connect` / `disconnect` `{target:"ip:port"}` | tunnel ADB |
| `POST /api/devices/action` `{serial, action: install\|launch\|stop\|clear, packageName?, buildId?}` | allowlisted actions |
| `GET /api/devices/screenshot?serial=` | PNG from `exec-out screencap -p` |
| `POST /api/adb/restart` `{mode: reconnect\|restart-server, serial?}` | ADB helper |
| `GET /api/logcat/stream?serial=&level=&tag=&q=&package=` · `POST /api/logcat/clear` | SSE `lines` batches · `logcat -c` |
| `POST /api/ai/analyze` `{mode: build_error\|logcat_crash, jobId? \| text?}` | 9Router root cause / affected / fix steps |
| `POST /api/ai/hermes-investigate` `{jobId?, errorTail?, crashSnippet?, packageName?, deviceSerial?}` | Hermes webhook |
| `POST /api/hooks/git` | push-to-deploy (GitHub/Gitea `X-Hub-Signature-256`, GitLab `X-Gitlab-Token`) |

## Security model

- Every subprocess is `spawn(cmd, argv[], {shell:false})`. Tasks, serials, `<ip>:<port>`, package names, levels and
  build ids are checked against strict allowlists/regexes first. Logcat tag/keyword filters run in JavaScript and never
  reach a process. AI output is displayed, never executed.
- Gradle and adb run without the runner's secrets in their environment. Release-signing passwords are written into the
  0600 `gradle.properties` only for the duration of a release build.
- Password login with constant-time comparison and 10 failures / 15 min per IP, HMAC-signed expiring cookie, `Origin`
  check on state-changing requests, a strict CSP (no inline script or style), and `X-Frame-Options: DENY`.
- 9Router, Hermes and the runner's own TCP port stay on `127.0.0.1`. Only the reverse proxy / Coolify edge is public.

Anyone who can sign in can run the configured project's Gradle build, which is code execution on the VM. Use a
strong password, and keep unrelated secrets out of the runner user's reach.

## Development

```bash
cd runner && npm test        # 22 unit + integration tests, fake adb/gradlew/9Router/Hermes, ~5 s
```
