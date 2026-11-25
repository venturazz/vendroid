# Android Remote Runner

Self-hosted web app that builds Kotlin / Jetpack Compose projects with Gradle on an **OCI Ampere
ARM64 (aarch64) Ubuntu VM**, installs the APK on a **physical phone over ADB-over-TCP through a
ZeroTier/WireGuard tunnel**, streams build logs and filtered `logcat` live, and sends failures to
**9Router** (fast analysis) and **Hermes Agent** (deep investigation).

**Backend: Node.js 20+ on the built-in `node:http` module, with no npm dependencies.** The frontend is
plain HTML, CSS and ES modules, served by the same process. One codebase runs under systemd/pm2 or
in Docker Compose / Coolify. Only environment variables differ.

## Layout

```
.
├── .env.example                  # shared by systemd (EnvironmentFile) and Docker Compose / Coolify
├── docker-compose.yml            # Coolify-ready, network_mode: host, persistent volumes
├── docker-compose.bridge.yml     # optional bridge-network override
├── deploy/
│   ├── systemd/android-runner.service
│   ├── ecosystem.config.cjs      # pm2 alternative
│   └── proxy/{Caddyfile,nginx.conf}   # HTTPS + SSE-safe reverse proxy
├── docs/RUNBOOK.md               # deploy, phone tunnel, verification
└── runner/
    ├── Dockerfile.arm64
    ├── package.json
    ├── scripts/{setup-ubuntu-arm64.sh,bootstrap-sdk.sh,docker-entrypoint.sh}
    ├── src/
    │   ├── server.js             # routes, auth gate, static UI
    │   ├── config.js  validate.js  exec.js  http.js  sse.js  auth.js
    │   ├── builds.js             # single-worker queue, state machine, ring buffer, persistence
    │   ├── adb.js                # devices, actions, screenshot, filtered logcat
    │   ├── ai.js                 # 9Router + Hermes + log slicing
    │   ├── health.js  gradleProps.js
    └── public/{login.*, app/{index.html,app.js,style.css}}
```

## API (all require a session cookie or `Authorization: Bearer $API_TOKEN`, except `/healthz`, `/api/auth/*`)

| Method & path | Purpose |
|---|---|
| `POST /api/auth/login` `{password}` / `POST /api/auth/logout` | session cookie (HttpOnly, SameSite=Strict) |
| `GET /api/health/env` | aarch64, java, `$ANDROID_HOME`, adb, aapt2, disk, RAM |
| `GET /api/ai/status` | reachability of 9Router and Hermes |
| `POST /api/builds` `{task, gitPullBeforeBuild, autoInstallAfterBuild, autoLaunchAfterInstall, autoNotifyHermes}` | enqueue (`assembleDebug`, `assembleRelease`, `clean assembleDebug`) |
| `GET /api/builds`, `GET /api/builds/:id` | history / one build |
| `POST /api/builds/:id/cancel` | kill the build's process group |
| `GET /api/builds/:id/apk` | download APK artifact |
| `GET /api/builds/:id/stream` | SSE: `line`, `state`, `end` (replays ring buffer; honors `Last-Event-ID`) |
| `GET /api/devices` | parsed `adb devices -l` |
| `POST /api/devices/connect` / `disconnect` `{target:"ip:port"}` | tunnel ADB connect |
| `POST /api/devices/action` `{serial, action: install\|launch\|stop\|clear, packageName?, buildId?}` | allowlisted actions |
| `GET /api/devices/screenshot?serial=` | PNG via `exec-out screencap -p` |
| `POST /api/adb/restart` `{mode: reconnect\|restart-server, serial?}` | ADB helper |
| `GET /api/logcat/stream?serial=&level=&tag=&q=&package=` | SSE `lines` batches |
| `POST /api/logcat/clear` `{serial}` | `logcat -c` |
| `POST /api/ai/analyze` `{mode: build_error\|logcat_crash, jobId? \| text?}` | 9Router |
| `POST /api/ai/hermes-investigate` `{jobId?, errorTail?, crashSnippet?, packageName?, deviceSerial?}` | Hermes webhook |

## Security model

- Every subprocess is `spawn(cmd, argv[], {shell:false})`. `task`, serials, `<ip>:<port>`, package names, levels
  and build ids are matched against strict allowlists/regexes first. Log filters (tag/keyword) are applied in
  JavaScript and never reach a process argument. AI output is never executed.
- Gradle and adb children get an environment with `AUTH_PASSWORD`, `API_TOKEN`, `SESSION_SECRET`,
  `NINE_ROUTER_API_KEY` and `HERMES_WEBHOOK_SECRET` removed, because project build scripts are arbitrary code.
- Password login (constant-time compare, 10 failures per 15 min per IP), HMAC-signed expiring cookie,
  `Origin` check on state-changing requests, CSP with no inline script/style.
- 9Router and Hermes are only ever called at the configured loopback URLs.

Anyone who can sign in can run the Gradle build of the configured project, which is arbitrary code
execution on the VM. Treat the password accordingly and keep the VM's other secrets out of reach of the
runner user.

See **[docs/RUNBOOK.md](docs/RUNBOOK.md)** for deployment.
