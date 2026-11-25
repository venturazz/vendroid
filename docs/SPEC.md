# Android Remote Runner: specification (as built)

Version 1.1, branch `feat/android-remote-runner`. This document describes what exists today. Each item has an ID
(e.g. `B-3`) so changes can be requested precisely ("change B-3 to …", "remove D-6", "add a new P-section").

## 0. Scope

| In scope (built) | Not built yet |
|---|---|
| One Android project (one git repo) | Multiple projects |
| One build at a time, with a queue | Uploading APKs not built here |
| Physical phone(s) over ADB through a ZeroTier/WireGuard tunnel | Managing apps already installed on the phone |
| Live build log and logcat | AI that writes or changes code |
| AI *analysis* of build errors and crashes (9Router), hand-off to Hermes | Multiple user accounts / roles |
| Push-to-deploy webhook, signed release builds | Emulators |
| Single password login | |

## 1. Platform and deployment

| ID | Item | Current behaviour |
|---|---|---|
| P-1 | Target host | OCI Ampere aarch64, Ubuntu 22.04/24.04, 4 OCPU / 24 GB |
| P-2 | Backend | Node.js 20+, standard library only (no npm dependencies) |
| P-3 | Frontend | Plain HTML/CSS/JS, served by the backend, dark theme |
| P-4 | Mode A: Coolify / Docker Compose | `runner` service (host network) + `edge` relay (bridge network, the one Coolify routes the domain to) |
| P-5 | Mode B: systemd | `setup-ubuntu-arm64.sh` installs everything; Caddy or Nginx in front for HTTPS |
| P-6 | Port | 3080, bound to 127.0.0.1 (never public) |
| P-7 | Persistent data | Android SDK, Gradle cache, ADB key (`~/.android`), build history/logs/APKs, project checkout |
| P-8 | Java | JDK 17 runs Gradle; JDK 21 installed for projects that need it (`JAVA_VERSION=21`) |
| P-9 | ARM64 build tools | box64 runs Google's own x86_64 `aapt2`; `aidl`/`zipalign`/`aapt` are swapped for native aarch64 builds |
| P-10 | First boot | Dashboard available immediately; SDK installs in the background; builds wait for it |

## 2. Access and security

| ID | Item | Current behaviour |
|---|---|---|
| S-1 | Login | One shared password. Auto-generated if `AUTH_PASSWORD` is empty (printed in logs) |
| S-2 | Session | HttpOnly, SameSite=Strict cookie; Secure behind HTTPS; valid 7 days (`SESSION_TTL_HOURS=168`) |
| S-3 | Brute force | 10 failed logins per IP, then a 15-minute lock |
| S-4 | API token | Optional `API_TOKEN` (16+ characters) for scripts: `Authorization: Bearer …` |
| S-5 | Command safety | Only fixed commands run; every input (task, device, package, level) is checked against an allowlist; no shell |
| S-6 | Secrets | Never passed to Gradle/adb; signing passwords exist only during a release build |
| S-7 | Browser protection | Origin check on changes, strict CSP, no framing |
| S-8 | AI services | 9Router and Hermes are called only on their configured 127.0.0.1 URLs |

## 3. Builds

| ID | Item | Current behaviour |
|---|---|---|
| B-1 | Tasks | `assembleDebug`, `assembleRelease`, `clean assembleDebug` (fixed list) |
| B-2 | Options per build | Git Pull, Auto-Install, Auto-Launch, Auto-Notify Hermes, Open Logcat after launch |
| B-3 | States | queued → pulling → building → installing → launching → succeeded / failed / cancelled |
| B-4 | Concurrency | One build at a time; others queue |
| B-5 | Cancel | Stops the whole Gradle process tree |
| B-6 | Resource limits | Gradle `-Xmx4096m -XX:+UseG1GC`, Kotlin daemon `-Xmx3072m`, 3 workers, 45-minute timeout |
| B-7 | APK check | APK must contain `AndroidManifest.xml` and `resources.arsc`, otherwise the build fails before install |
| B-8 | Release signing | Optional keystore via `RELEASE_KEYSTORE_*`; without it release APKs are unsigned and are not auto-installed |
| B-9 | History | Last 30 builds kept (`MAX_BUILD_HISTORY`) with log, APK, commit, duration, trigger (manual / webhook / api) |
| B-10 | Restart | A build interrupted by a restart is marked failed |
| B-11 | Push-to-deploy | GitHub / Gitea / GitLab webhook → pull, build `AUTO_BUILD_TASK`, install, launch. Pushes during a queued webhook build are merged |
| B-12 | Live log | Streamed live; the last 5,000 lines replay after a page refresh |

## 4. Device (phone)

| ID | Item | Current behaviour |
|---|---|---|
| D-1 | Connection | `<tunnel_ip>:<port>` via ADB over TCP; Connect / Disconnect / Reconnect / Restart ADB |
| D-2 | Auto-reconnect | Every 20 s for `DEFAULT_DEVICE_ADDRESS`, backing off to 5 minutes when unreachable; paused after a manual disconnect |
| D-3 | Device list | serial, state, model, product, transport |
| D-4 | Actions | Install latest APK (or any APK from history), Launch, Force Stop, Clear App Data (with confirmation) |
| D-5 | Screenshot | Capture, optional auto-refresh every 3 s, save as PNG |
| D-6 | App target | One default package (`DEFAULT_PACKAGE_NAME`), changeable in the sidebar |

## 5. Logcat

| ID | Item | Current behaviour |
|---|---|---|
| L-1 | Stream | Live, starting from the last 200 lines on the phone |
| L-2 | Filters | Minimum level V/D/I/W/E, tag, keyword, package (filters by the app's process id when it is running) |
| L-3 | Controls | Start/Stop, Pause/Resume, Clear (also clears the phone buffer), Export `.log`, autoscroll |
| L-4 | Crash detection | `FATAL EXCEPTION`, `ANR in`, `Fatal signal` → red tab badge, toast, desktop notification |
| L-5 | Capacity | Browser keeps the last 20,000 lines for export/AI, shows the last 5,000 |

## 6. AI

| ID | Item | Current behaviour |
|---|---|---|
| A-1 | Analyze Error (9Router) | Sends the relevant part of a failed build log (Kotlin errors + "What went wrong", max 12,000 chars) |
| A-2 | Triage Crash (9Router) | Sends the last crash stack trace from logcat |
| A-3 | AI answer format | Root cause, affected files/classes, numbered fix steps, confidence |
| A-4 | Model settings | `NINE_ROUTER_MODEL` (default `auto`), temperature 0.2, max 1,200 tokens, 90 s timeout |
| A-5 | Investigate (Hermes) | Sends `{event, jobId, projectPath, packageName, deviceSerial, errorTail, crashSnippet, timestamp}` with `X-Webhook-Secret` |
| A-6 | Auto-notify Hermes | Optional per build: failed builds are sent automatically |
| A-7 | Limits | AI only explains; it cannot change code or run commands |

## 7. Dashboard

| ID | Area | Contents |
|---|---|---|
| U-1 | Top bar | Environment badge (click for a detailed check table), AI status, device status, device address + Connect / Reconnect / Restart ADB, Logout |
| U-2 | Sidebar | Variant, package, build option toggles, Build & Deploy, Cancel, history (APK download, Install, Re-run) |
| U-3 | Tab: Build Console | State, timer, commit, live log, Download log, Analyze Error, Investigate |
| U-4 | Tab: Device Logcat | Filters, controls, live log, Triage Crash, Investigate |
| U-5 | Tab: Device Screen & Actions | Screenshot, auto-refresh, Save PNG, Install / Launch / Force Stop / Clear Data |
| U-6 | Convenience | `Ctrl+Enter` builds; settings remembered in the browser; desktop notification when a build ends; title flashes when the tab is in the background |
| U-7 | Layout | Desktop first; stacks into one column on phones |

## 8. Settings (environment variables)

All optional. Full list with comments: `.env.example`.

| Group | Variables |
|---|---|
| Most used | `AUTH_PASSWORD`, `DEFAULT_PACKAGE_NAME`, `DEFAULT_DEVICE_ADDRESS`, `PROJECT_GIT_URL`, `PROJECT_GIT_BRANCH` |
| AI | `NINE_ROUTER_URL`, `NINE_ROUTER_API_KEY`, `NINE_ROUTER_MODEL`, `HERMES_WEBHOOK_URL`, `HERMES_WEBHOOK_SECRET` |
| Push-to-deploy | `GIT_WEBHOOK_SECRET`, `AUTO_BUILD_BRANCH`, `AUTO_BUILD_TASK`, `AUTO_BUILD_INSTALL`, `AUTO_BUILD_LAUNCH`, `AUTO_BUILD_NOTIFY_HERMES` |
| Signing | `RELEASE_KEYSTORE_PATH`, `RELEASE_KEYSTORE_PASSWORD`, `RELEASE_KEY_ALIAS`, `RELEASE_KEY_PASSWORD` |
| Limits | `GRADLE_JVM_ARGS`, `KOTLIN_DAEMON_JVM_ARGS`, `GRADLE_MAX_WORKERS`, `BUILD_TIMEOUT_MIN`, `MAX_BUILD_HISTORY` |
| Toolchain | `SDK_PACKAGES`, `AAPT2_MODE`, `AAPT2_BINARY`, `JAVA_VERSION`, `APP_MODULE`, `INSTALL_BOX64` (image build) |
| Server | `PORT`, `API_TOKEN`, `SESSION_TTL_HOURS`, `TRUST_PROXY`, `ADB_AUTO_RECONNECT`, `ADB_RECONNECT_INTERVAL_SEC` |

## 9. API

Listed in `README.md` → API. Every dashboard action is available as a REST call; live data uses Server-Sent Events.

## 10. Quality checks

| ID | Check | Where |
|---|---|---|
| Q-1 | 22 unit + integration tests with fake adb / Gradle / 9Router / Hermes | `npm test`, every push |
| Q-2 | Dashboard driven in a real browser, fails on any error; screenshots saved | CI |
| Q-3 | Real Compose app built on arm64 in Docker: AGP 8.7 and latest AGP 9.5 / compileSdk 37.2, debug + signed release, verified with SDK tools | CI, every push + weekly |
| Q-4 | Same on a fresh systemd install | CI |
| Q-5 | Not covered by CI | A real phone over a tunnel, a real Coolify instance |
