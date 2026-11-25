# Vendroid

A self-hosted **browser IDE for Android apps**, running on an **OCI Ampere ARM64 (aarch64) Ubuntu VM**.
You create or clone Kotlin projects, edit them in the browser with an AI assistant that writes real code,
build them with Gradle on the server, and run them on **your physical phone over a ZeroTier/WireGuard tunnel**.
The live build log, filtered logcat and phone screenshots appear in the same window. **Hermes Agent** can
do all of this too, through an MCP (or REST) endpoint.

[![CI](https://github.com/venturazz/vendroid/actions/workflows/ci.yml/badge.svg)](https://github.com/venturazz/vendroid/actions/workflows/ci.yml)
CI builds real apps on GitHub's arm64 runners in both deployment modes: both project templates, a pinned AGP 8
stack and the latest AGP/Gradle/Kotlin (rechecked weekly). It also drives the IDE in a real browser.

**Stack:** Node.js 20+ using only the standard library (no runtime npm dependencies). The UI is plain ES modules
plus a vendored CodeMirror 6 bundle (`editor/` builds it). One codebase, two deployment modes (systemd or Coolify/Docker Compose).

## Quick start

**Coolify / Docker Compose:** deploy this repo with the Docker Compose build pack and give the `edge` service a
domain (`https://ide.example.com:3080`). Optionally set `DEFAULT_DEVICE_ADDRESS`, `GIT_TOKEN` and the 9Router/Hermes
keys. The password is printed in the `runner` logs on first start.

**Plain Ubuntu (systemd):**
```bash
git clone https://github.com/venturazz/vendroid && cd vendroid
sudo bash runner/scripts/setup-ubuntu-arm64.sh   # prints the password; then put Caddy/Nginx in front (deploy/proxy/)
```

Then open the dashboard and click **New Project** or **Clone from Git**. Details: **[docs/RUNBOOK.md](docs/RUNBOOK.md)**.
Full feature list with IDs: **[docs/SPEC.md](docs/SPEC.md)**.

## Features

**Project Hub**
- One card per project: package, UI toolkit, version, last build, APK download.
- **New Project** from a verified template: Jetpack Compose (Material 3) or XML Views (AppCompat, Material, ViewBinding,
  ConstraintLayout). You choose the name, package and minSdk. The project gets a git repository with a first commit.
- **Clone from Git** over HTTPS. Private repos work with `GIT_TOKEN`. Any folder in `WORKSPACES_DIR` is picked up automatically.

**Editor**
- File Explorer: lazy tree, git colors, new/rename/delete, right-click → "Add to AI context".
- Multi-tab CodeMirror editor with Kotlin, Java, XML, Gradle (Kotlin and Groovy DSL), JSON, properties, YAML, TOML and
  Markdown highlighting. Includes search/replace, bracket matching, folding and autocomplete.
- `Ctrl+P` quick open, `Ctrl+Shift+F` project search.
- Saves are conflict-safe: if the AI, git or Hermes changed a file while it was open, you're asked before it's overwritten.

**Source Control**
- Status with per-file diff, commit (all or selected), pull (fast-forward), push (sets upstream).
- Branch switch/create, discard changes, recent commits.

**AI assistant (9Router)**
- A chat panel that sees the project structure, the open file, a selection, files you add, and optionally the last build error.
- Answers stream in. Proposed changes appear as **diffs** with **Apply**, **Apply all** and **▶ Apply & Run**, plus **Undo**.
- **Fix with AI** from a failed build or a logcat crash.
- **Send to Hermes** hands bigger tasks to Hermes Agent.

**Run on the phone**
- **▶ Run** (`Ctrl+Enter`) saves, builds, installs, launches, and opens logcat filtered to the app.
- One build runs at a time across all projects; the rest queue.

**Bottom panel (per project)**
- Build Output: live log, history, compiler errors clickable to the file and line, Analyze Error (9Router), Fix with AI, Investigate (Hermes).
- Logcat: level/tag/keyword/"this app" filters, crash detection.
- Device: on-demand screenshot and app actions.

**Publish to Google Play**
- A readiness checklist against Play's current rules: target API 36, unique application id, version code, signed
  `.aab`, 16 KB page-size support of native libraries, no debuggable release, restricted permissions, and a size limit.
- One-click fixes: set targetSdk, bump the version, and generate or import a per-project upload key (with backup and SHA fingerprints).
- **Build signed AAB** produces a bundle ready to upload.

**Agents**
- `POST /mcp` (MCP Streamable HTTP) and `/api/agent/tools/*` (REST) with a bearer token.
- 24 tools (incl. `play_check`): projects, files, search, edits (with undo), git, builds (blocking wait), devices, install/launch/stop/clear,
  screenshot (image), logcat, 9Router analysis.

**Kept from v1:** the ARM64 toolchain (box64 + Google's aapt2, native aarch64 build tools), resource caps, ADB tunnel
auto-reconnect, push-to-deploy webhooks (now matched to the right project), signed release builds, password auth,
Coolify edge relay, persistent volumes.

## Layout

```
.
├── .env.example                 # every setting (systemd and Docker/Coolify)
├── docker-compose.yml           # runner (host network) + edge (bridge, Coolify-routable)
├── deploy/{systemd,proxy}/      # unit file, Caddy/Nginx (SSE-safe)
├── docs/{RUNBOOK,SPEC}.md
├── editor/                      # builds runner/public/vendor/codemirror.bundle.js (dev only)
├── .github/{workflows,ci}/      # arm64 end-to-end CI, tooling (bundle + versions)
└── runner/
    ├── Dockerfile.arm64
    ├── scripts/                 # setup-ubuntu-arm64.sh, bootstrap-sdk.sh, docker-entrypoint.sh, git-askpass.sh
    ├── templates/               # compose/, views/, common/, wrapper/ (Gradle 9.9.2), versions.json
    ├── src/
    │   ├── server.js            # bootstrap, auth gate, static files, listeners
    │   ├── routes/              # core, builds, devices, projects (files+git), ai, agent (MCP/REST)
    │   ├── projects.js files.js git.js           # Project Hub, safe file access, git
    │   ├── aicode.js diff.js                     # AI edits: context, streaming, SEARCH/REPLACE, apply/undo
    │   ├── agent.js mcp.js                       # agent tools + MCP JSON-RPC
    │   ├── builds.js adb.js watchdog.js          # queue, ADB, auto-reconnect
    │   └── ai.js webhook.js auth.js config.js validate.js exec.js http.js sse.js health.js gradleProps.js apkcheck.js edge.js
    ├── public/                  # login + IDE (app/index.html, app/js/*.js, app/style.css, vendor/)
    └── test/                    # unit, integration (v1 API), ide (v2), ui/smoke.mjs (browser, CI)
```

## Security model

- Every subprocess is `spawn(cmd, argv[], {shell:false})`. Tasks, devices, packages, branches, clone URLs (`https://`
  only), project ids and file paths are validated first.
- File access is confined to the project: no `..`, no `.git/`, and symlinks can't escape it. Git runs with hooks
  disabled, only the `https` transport allowed (no `ext::`), and tokens passed through `GIT_ASKPASS`.
- The AI and agents can only propose or apply **file edits** and call the fixed tools. Model output is never executed.
  Build tooling, `.git`, keystores and the Gradle wrapper jar are off-limits to AI edits.
- Login: one password, with constant-time comparison and throttling, an HMAC-signed session cookie and an `Origin` check.
- Agents: a separate bearer token (MCP requires it; a session cookie isn't enough).
- Gradle and adb never see the runner's secrets. 9Router, Hermes and the runner's TCP port stay on `127.0.0.1`.

Anyone who can sign in, and any agent holding the token, can change code and run Gradle builds, which means running
code on the VM. Treat the password and token like SSH keys.

## Development

```bash
cd runner && npm test     # 39 unit + integration tests (fake adb/gradlew/9Router/Hermes), ~10 s
```
The browser test (`test/ui/smoke.mjs`) and the real ARM64 builds run in CI.
