# Vendroid: specification (as built)

Version 2.0, branch `feat/android-remote-runner`. Each item has an ID, so you can request a change precisely
("change E-4", "remove G-6", "add a new H-section"). Items marked *(v1)* are unchanged from version 1.

## 0. Scope

| Built | Not built (yet) |
|---|---|
| Many Android projects (Project Hub), templates, clone | Uploading/managing APKs not built here; managing other apps on the phone |
| Browser editor, explorer, search, git | Visual layout designer / Compose preview rendering |
| AI that proposes and applies code edits (9Router); Hermes via MCP/REST | Multiple user accounts / roles |
| Build → install → launch on a physical phone over a VPN tunnel | Emulators |

## 1. Platform and deployment

| ID | Item | Behaviour |
|---|---|---|
| P-1 | Host | OCI Ampere aarch64, Ubuntu 22.04/24.04, 4 OCPU / 24 GB *(v1)* |
| P-2 | Backend | Node.js 20+, standard library only |
| P-3 | Frontend | ES modules + vendored CodeMirror 6 bundle (built by `editor/` in CI, committed) |
| P-4 | Coolify / Compose | `runner` (host network) + `edge` relay (Coolify-routable) *(v1)* |
| P-5 | systemd | `setup-ubuntu-arm64.sh`, Caddy/Nginx in front *(v1)* |
| P-6 | Workspace | `WORKSPACES_DIR`: Docker `/workspace` (volume), systemd `/var/lib/android-runner/workspaces`; one folder per project |
| P-7 | Persistence | SDK, Gradle cache, ADB key, build history/APKs, AI chat history, projects *(extends v1)* |
| P-8 | ARM64 toolchain | box64 + Google's aapt2; native aarch64 aidl/zipalign; APK sanity check *(v1)* |

## 2. Access and security

| ID | Item | Behaviour |
|---|---|---|
| S-1 | Login | One password (auto-generated if unset), 7-day session, throttling *(v1)* |
| S-2 | Agent token | Bearer token for MCP/REST; `MCP_TOKEN`/`API_TOKEN` or generated; shown and rotatable in Settings |
| S-3 | Files | Confined to the project; no `..`, `.git/` or symlink escape; 2 MB read / 5 MB write limit |
| S-4 | Git | Hooks off, `ext::` off, https only (file:// only in tests), token via `GIT_ASKPASS` |
| S-5 | AI/agent edits | File edits only; never `.git`, `build/`, `.gradle`, wrapper jar, keystores, `local.properties` |
| S-6 | Commands | Fixed argv, allowlisted inputs, no shell *(v1)* |

## 3. Project Hub (H)

| ID | Item | Behaviour |
|---|---|---|
| H-1 | List | Cards: name, package, Compose/Views, version, git, last build state and age, APK download |
| H-2 | New project | Name, package (suggested), template **Compose** or **XML Views**, minSdk 21-36 |
| H-3 | Template stack | AGP 9.5.2, Gradle 9.9.2 (official wrapper, checksum-verified), Kotlin 2.4.21, compileSdk 37.2, targetSdk 37, JDK 17; Compose BOM 2026.11.01 / AppCompat 1.8.0, Material 1.14.0, ConstraintLayout 2.2.2. Pinned in `runner/templates/versions.json` |
| H-4 | First commit | `git init -b main` + "Create … from the … template" |
| H-5 | Clone | HTTPS URL + optional branch; private repos via `GIT_TOKEN` |
| H-6 | Auto-discovery | Any folder in the workspace appears as a project |
| H-7 | Rename / delete | Rename = display name; delete removes the folder after typing the id |
| H-8 | Detection | Module, applicationId, version, min/targetSdk and UI toolkit read from the Gradle files |

## 4. Editor (E)

| ID | Item | Behaviour |
|---|---|---|
| E-1 | Explorer | Lazy tree, build/hidden folders toggle, git colours, follows the active tab |
| E-2 | File ops | New file/folder, rename/move (F2), delete (Del), copy path, add to AI context |
| E-3 | Tabs | Multi-tab, dirty marker, middle-click close, restored per project |
| E-4 | Languages | Kotlin, Java, XML, Gradle (kts and Groovy), JSON, properties/ProGuard, YAML, TOML, Markdown, shell |
| E-5 | Editing | Search/replace, bracket matching, auto-close, folding, autocomplete (words), multi-cursor |
| E-6 | Save | `Ctrl+S`; conflict check (asks before overwriting changes made by AI/git/Hermes); open tabs reload after external changes |
| E-7 | Quick open / search | `Ctrl+P` fuzzy file open; `Ctrl+Shift+F` project text search |
| E-8 | Fallback | Plain textarea if the editor bundle fails to load |

## 5. Source control (G)

| ID | Item | Behaviour |
|---|---|---|
| G-1 | Status | Branch, ahead/behind, changed files with status letters; badge on the activity bar |
| G-2 | Diff | Per file, in a read-only diff tab |
| G-3 | Commit | All changes, `Ctrl+Enter` in the message box; identity from `GIT_USER_NAME`/`GIT_USER_EMAIL` |
| G-4 | Pull / push | Pull fast-forward only; push sets upstream on first push |
| G-5 | Branches | Switch or create |
| G-6 | Discard | Restore a file (deletes it if untracked) |

## 6. AI assistant (A)

| ID | Item | Behaviour |
|---|---|---|
| A-1 | Chat | Per-project conversation (last 40 messages kept), streamed answers, Stop button |
| A-2 | Context | Project summary + file tree + open file + selection + added files + build script/manifest + optional last build error (budget `AI_CODE_CONTEXT_CHARS`, default 120k) |
| A-3 | Edits | SEARCH/REPLACE blocks → diffs; tolerant of indentation; failed blocks listed, never half-applied per block |
| A-4 | Apply | Per file, all, or **Apply & Run**; refuses if the file changed since the proposal |
| A-5 | Undo | Restores the previous content (or deletes created files) |
| A-6 | Fix with AI | From a failed build or a logcat crash |
| A-7 | Send to Hermes | Webhook `event: agent_task` with project, task, files, error |
| A-8 | Analysis | Analyze Error / Triage Crash (root cause, affected, fix steps) *(v1)* |
| A-9 | Model | `NINE_ROUTER_MODEL`, temperature 0.2, `AI_CODE_MAX_TOKENS` (8000) |

## 7. Build & run (B)

| ID | Item | Behaviour |
|---|---|---|
| B-1 | Run | ▶ Run / `Ctrl+Enter` / F5: save all → build → install → launch → open Logcat |
| B-2 | Build only | ⚒ Build |
| B-3 | Variants | `assembleDebug`, `assembleRelease`, `clean assembleDebug` *(v1)* |
| B-4 | Queue | One build at a time across projects; top-bar pill shows which project is building |
| B-5 | Options | Git pull before build, open Logcat after launch, notify Hermes on failure (remembered) |
| B-6 | History | Last 30 builds per project, with log, APK, commit and trigger (manual/api/agent/webhook) |
| B-7 | Push-to-deploy | Webhook matched to the project by repository URL or `?project=` *(extends v1)* |
| B-8 | Signing / limits / timeout | `RELEASE_KEYSTORE_*`, 4 GB Gradle + 3 GB Kotlin, 3 workers, 45 min *(v1)* |

## 8. Bottom panel (L), scoped to the active project

| ID | Item | Behaviour |
|---|---|---|
| L-1 | Build Output | Build history select, live log, timer, commit, APK/log download, clickable compiler errors |
| L-2 | Logcat | Level/tag/keyword filters, "this app" (pid filter), pause, clear, export, crash detection |
| L-3 | Device | On-demand screenshot (+ auto-refresh), install latest, launch, force stop, clear data |
| L-4 | Layout | Resizable, collapsible (`Ctrl+\``), last tab remembered |

## 9. Phone (D) *(v1)*

Connect by tunnel address, auto-reconnect with back-off, Reconnect / Restart ADB, device badge.

## 10. Agent API (M)

| ID | Item | Behaviour |
|---|---|---|
| M-1 | MCP | `POST /mcp`, Streamable HTTP (stateless JSON), protocol 2024-11-05 … 2025-11-25 |
| M-2 | REST | `GET /api/agent/tools`, `POST /api/agent/tools/<name>`; the token also works on the normal REST API |
| M-3 | Tools | list_projects, project_info, list_files, read_file, search_code, write_file, apply_edits, undo_edits, git_status, git_diff, git_commit, git_pull, git_push, start_build (waitSeconds ≤ 900), get_build, list_builds, cancel_build, analyze_build_error, list_devices, connect_device, device_action, screenshot (image), logcat |
| M-4 | Read-only mode | `MCP_ALLOW_WRITE=false` hides/blocks write tools |
| M-5 | Reachability | Host: `127.0.0.1:3080/mcp`; containers: `https://<domain>/mcp` or the `edge` container on a shared network |

## 11. Shortcuts

`Ctrl+Enter`/F5 run · `Ctrl+S` save · `Ctrl+P` quick open · `Ctrl+Shift+F` search · `Ctrl+Shift+E` explorer ·
`Ctrl+Shift+G` git · `Ctrl+I` AI · `` Ctrl+` `` bottom panel · editor: `Ctrl+F` find, `Ctrl+/` comment, `Alt+↑/↓` move line.

## 12. Quality checks

| ID | Check | Where |
|---|---|---|
| Q-1 | 36 unit + integration tests (v1 API, v2 IDE API, MCP) | `npm test`, every push |
| Q-2 | IDE driven in Chromium: create project, edit, save, commit, AI apply, run, logcat, screenshot | CI |
| Q-3 | Real builds on arm64 in Docker: AGP 8.7 sample + latest AGP; both templates; signed release | CI + weekly |
| Q-4 | Same on a fresh systemd install, including a template build | CI |
| Q-5 | Template Gradle wrapper matches the official checksum | CI |
| Q-6 | Not covered | Real phone over a tunnel, a real Coolify instance, a real 9Router model, a real Hermes Agent |
