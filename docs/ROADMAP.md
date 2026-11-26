# Vendroid roadmap

Status: **proposal, v1 (2026-11-25)**. Phases are ordered by dependency and value. Each item has an ID so it can be
moved, cut or re-scoped ("move AG-4 to phase 3", "drop DS-5"). Sizes: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ several weeks
of focused work (rough guides, not promises).

Rules every phase follows:
- **Tested on ARM64 in CI.** Real builds on GitHub arm64 runners, both deployment modes (Coolify/Docker and systemd), plus the browser test.
- **The AI never runs shell commands.** Models and agents only edit files and call Vendroid's fixed tools. Every change shows a
  diff and can be undone.
- **No vendor lock-in.** Any OpenAI-compatible endpoint works; 9Router stays the default.
- **Docs updated in the same change:** `SPEC.md` (IDs), `RUNBOOK.md`, `.env.example`.

---

## Phase 0 — Field test what exists (you + me) · S

Before building on top, run the current release on the real server and phone.

| ID | Item | Done when |
|---|---|---|
| FT-1 | Redeploy on Coolify; HTTPS on the `edge` domain | Dashboard loads over HTTPS, live logs stream |
| FT-2 | Phone over ZeroTier: pair, connect, auto-reconnect after phone reboot | Device badge stays green; Run installs and launches |
| FT-3 | 9Router: Analyze Error and one AI edit on a real project | Diff applies and the app builds |
| FT-4 | Hermes: add Vendroid as an MCP server; Hermes runs `start_build` + `screenshot` | Hermes reports the build result and a screenshot |
| FT-5 | Publish: upload key + signed AAB uploaded to an internal test track by hand | Play Console accepts the bundle |
| FT-6 | Fix everything found in FT-1…5 | Issues closed |

---

## Phase 1 — AI providers (OpenAI-compatible) · M

The foundation for every later AI feature. Today there is one provider (9Router, set by env vars).

| ID | Item | Details |
|---|---|---|
| AI-1 | **Provider registry** | Add any number of OpenAI-compatible providers: 9Router, OpenAI, OpenRouter, Ollama, LM Studio, vLLM, Groq, DeepSeek, Together, Azure OpenAI, or any base URL + key. Env vars still work and appear as the default provider |
| AI-2 | **Settings → AI** in the browser | Add/edit/delete providers without redeploying; keys stored encrypted at rest (AES-GCM, key in DATA_DIR) and never sent back to the browser |
| AI-3 | **Model per role** | Separate choice for *Chat/edits*, *Fast analysis* (Analyze Error, Triage Crash), *Agent* (tool calling), *Vision* (screenshots/mockups), with a model picker filled from `GET /v1/models` |
| AI-4 | **Connection test** | "Test" sends a tiny prompt, then shows latency and whether streaming, tool calling and image input work |
| AI-5 | **Fallback chain** | If the primary model fails or times out, the next one is tried; shown in the answer header |
| AI-6 | **Usage meter** | Tokens and estimated cost per message, project and day (from `usage` in responses); optional daily limit |
| AI-7 | **Tool calling** | OpenAI `tools` / `tool_calls` support in the chat engine, using the same tool set as MCP (needed for Phase 2) |
| AI-8 | **Project rules** | Per-project `VENDROID.md` (like AGENTS.md): conventions, architecture and "don't touch" notes, always sent as context |

Done when the AI panel works with three different providers (e.g. 9Router, OpenRouter, local Ollama) and switching models takes no redeploy.

---

## Phase 2 — Built-in agent loop · M

Turns "propose edits" into "finish the job": the assistant can build, read errors and iterate.

| ID | Item | Details |
|---|---|---|
| AG-1 | **Agent mode** in the AI panel | The model plans, then uses tools: read/search files, apply edits, build, read build errors, logcat and screenshots. A live timeline shows each step |
| AG-2 | **Fix-until-green** | "Make it build": build → error → fix → rebuild, up to N iterations (default 5), then one combined diff to review |
| AG-3 | **Checkpoints** | Automatic snapshot (git stash-like commit on a hidden ref) before every AI or agent change; timeline with one-click restore |
| AG-4 | **Approval levels** | *Ask before each edit* / *Auto-apply edits, ask before install* / *Full auto* per project |
| AG-5 | **Budgets & stop** | Max steps, tokens and minutes per task; Stop button; interrupted tasks leave a checkpoint |
| AG-6 | **Run & verify** | After a green build the agent installs, launches, takes a screenshot and reads logcat for crashes before saying "done" |
| AG-7 | **Background tasks** | Agent tasks keep running when the browser closes; status in the Hub card and a notification when finished |

Done when "add a settings screen with a dark-mode switch" goes from prompt to a running app on the phone without manual fixes,
on both templates.

---

## Phase 3 — Build an app from a prompt · L

The headline feature. Builds on Phases 1 and 2.

| ID | Item | Details |
|---|---|---|
| PA-1 | **"New app from a prompt"** in the Hub | Describe the app (any language, e.g. Indonesian) → the AI drafts an **app spec** |
| PA-2 | **Editable app spec** | Screens, navigation graph, data model, local/remote data, permissions, theme colours, minSdk, Compose or Views. You review and edit it before any code is written; it's stored as `vendroid/spec.json` + a readable `SPEC.md` in the project |
| PA-3 | **Scaffold + generate** | Template → architecture (MVVM, Navigation, Hilt optional) → screens one by one, each built and verified by the agent loop (AG-2) |
| PA-4 | **From a picture** | Upload a sketch, mockup or screenshot; a vision model turns it into a screen (Compose or XML) |
| PA-5 | **Feature wizards** | "Add screen" (list, detail, form, login, settings, onboarding, tabs), "Add feature" (Room database, Retrofit API client, DataStore settings, camera, location, notifications, Firebase Auth/Firestore/Crashlytics, AdMob, in-app billing). Each is generated code you review like any AI change |
| PA-6 | **Iterate by talking** | "Make the list cards rounder", "add a search bar", with the current phone screenshot attached automatically |
| PA-7 | **Starter gallery** | Ready specs to fork: to-do, notes, expense tracker, shop catalogue, news reader, chat UI, quiz, habit tracker |
| PA-8 | **Play-ready by default** | Generated apps pass the Publish checklist (target API, permissions declared only when used, R8, upload key prompt) |

Done when a one-paragraph prompt produces a multi-screen app that builds, runs on the phone and passes the Play checklist.

---

## Phase 4 — OpenCode integration · M

Use [OpenCode](https://opencode.ai) as an optional agent engine next to the built-in agent and Hermes.

| ID | Item | Details |
|---|---|---|
| OC-1 | **OpenCode service** | `opencode serve` as an optional service: a Docker Compose service (profile `opencode`) or a systemd unit, bound to 127.0.0.1:4096, protected with `OPENCODE_SERVER_PASSWORD`, sharing the workspace volume |
| OC-2 | **Vendroid tools inside OpenCode** | Vendroid's MCP server is registered in OpenCode's config automatically, so OpenCode can build, install, take screenshots and read logcat (its own file and edit tools work on the same workspace) |
| OC-3 | **Engine picker** | The AI panel offers *Built-in*, *OpenCode* and *Hermes*. OpenCode sessions are created per project, prompts are sent through its HTTP API, and its event stream is shown live (messages, tool calls, file diffs) |
| OC-4 | **Providers & models** | Use OpenCode's own provider setup, or push the Phase 1 providers into it, with one place to manage keys |
| OC-5 | **Permissions bridge** | OpenCode's permission prompts (edit, bash) appear as approve/deny buttons in Vendroid; bash is denied by default |
| OC-6 | **Session history** | List, resume and share OpenCode sessions per project; diffs land in Source Control like any other change |

Done when an OpenCode session started from Vendroid edits a project, builds it through Vendroid's MCP tools, and its
changes show up in the editor and git panel.

---

## Phase 5 — Phone in the browser · M

| ID | Item | Details |
|---|---|---|
| PH-1 | **Live screen mirroring** | scrcpy server over ADB (H.264) decoded in the browser with WebCodecs; fallback to fast screenshots |
| PH-2 | **Touch & keys** | Click/drag = tap/swipe, keyboard typing, Back/Home/Recents, rotate, volume |
| PH-3 | **Record** | MP4/GIF capture for bug reports and store videos |
| PH-4 | **"Ask about this screen"** | Send the current frame to the AI ("why is this text cut off?") |
| PH-5 | **App manager** | Installed apps on the phone: version, size, launch, stop, clear, uninstall, pull APK into a project |
| PH-6 | **Multiple phones** | Pick the target per run; install on all connected phones at once |

---

## Phase 6 — Code intelligence · M

| ID | Item | Details |
|---|---|---|
| CI-1 | **Kotlin language server** | Live errors and warnings, completion, hover, go-to-definition, find usages, rename (JetBrains `kotlin-lsp` or `kotlin-language-server`, with memory caps) |
| CI-2 | **Android Lint panel** | Run lint, list issues per file with "Fix with AI" |
| CI-3 | **Formatting** | ktlint/ktfmt on save (optional) |
| CI-4 | **Gradle helpers** | Dependency search (Maven Central/Google), add to the version catalog, "updates available", vulnerable versions flagged |
| CI-5 | **Problems view** | Build errors, lint and LSP diagnostics in one list, clickable. *Done for build errors (Kotlin, javac, AAPT) plus instant XML/JSON/bracket checks; lint and LSP feed into the same list later* |

---

## Phase 7 — Ship it · M

| ID | Item | Details |
|---|---|---|
| SH-1 | **Upload to Google Play** | Google Play Developer API with a service account: upload the signed .aab, choose a track (internal, closed, open, production), staged rollout %, one click from Publish |
| SH-2 | **Release notes** | AI-drafted "What's new" from commits since the last release, translated per store language |
| SH-3 | **Store listing kit** | AI description (short/full), framed phone screenshots from the device, feature graphic and 512×512 icon |
| SH-4 | **Privacy & Data safety drafts** | Generated from the app's permissions and libraries (ads, analytics, Firebase, …), for you to review and host |
| SH-5 | **Tester link + QR** | Signed APK download page (expiring link) so testers can install without Play |
| SH-6 | **Release history** | What was uploaded to which track, with versionCode, notes and the commit |

---

## Phase 8 — Design & resources · M

| ID | Item | Details |
|---|---|---|
| DS-1 | **App icon generator** | From an image, emoji or text: adaptive launcher icon (foreground/background/monochrome) + Play icon |
| DS-2 | **Theme generator** | Material 3 colour scheme from a seed colour or logo, light/dark, written to the theme files |
| DS-3 | **Translations** | `strings.xml` → other languages with AI, keeping placeholders; missing-translation report |
| DS-4 | **Compose @Preview rendering** | Previews rendered on the server (Roborazzi/Paparazzi-style JVM rendering) and shown next to the editor |
| DS-5 | **Vector & image import** | SVG → VectorDrawable, image → WebP in the right density folders |

---

## Phase 9 — Quality & speed · M

| ID | Item | Details |
|---|---|---|
| QS-1 | **Faster rebuilds** | Warm Gradle daemon per active project, configuration cache, build-time breakdown |
| QS-2 | **Test runner** | Unit tests and instrumented tests on the phone, results tree, failures linked to code, "Fix with AI" |
| QS-3 | **Crash inbox** | Crashes from logcat grouped by stack trace across sessions, with count and last seen |
| QS-4 | **Size analyzer** | APK/AAB breakdown (dex, resources, native, assets) and diff against the previous release |
| QS-5 | **Startup & performance** | Cold start time (`am start -W`), memory, frame stats per build |

---

## Phase 10 — Team & platform · M

| ID | Item | Details |
|---|---|---|
| TP-1 | **Users & roles** | Multiple accounts (owner, developer, viewer), per-project access, audit log |
| TP-2 | **Notifications** | Telegram / Discord / email / webhook on build finished, crash, agent task done |
| TP-3 | **Project export/import** | Zip download/upload, backup of DATA_DIR (keys, history) with restore |
| TP-4 | **Indonesian UI** | Interface translation (English + Bahasa Indonesia first) |
| TP-5 | **Tablet/phone-friendly IDE** | Installable PWA, touch-friendly layout for working from a tablet |
| TP-6 | **Resource limits per project** | Disk quota, build time limits, cleanup of old caches |

---

## Suggested order and dependencies

```
Phase 0 ─► Phase 1 ─► Phase 2 ─► Phase 3 ─────► Phase 7
                 │          └─► Phase 4 (OpenCode, parallel to 3)
                 └─► Phase 5 (phone mirroring, independent) ─► PA-6, PH-4
Phase 6, 8, 9, 10: independent; slot in by need
```

- **Next up:** Phase 0, then Phase 1. Every AI feature after that depends on the provider registry and tool calling.
- **Quick wins** that can ride along with any phase: DS-1 icon generator, DS-3 translations, SH-5 tester link, QS-1 faster rebuilds.
- Phases 3 and 4 both produce "agent" UX. Building Phase 2 first means the OpenCode and Hermes engines plug into the
  same timeline, diff and checkpoint UI instead of three separate ones.

## Open questions for you

1. **Phase 3 architecture default:** plain MVVM + Navigation (simpler), or MVVM + Hilt + Room by default (more "production")?
2. **Agent autonomy default (AG-4):** ask before each edit, or auto-apply edits and ask only before installing?
3. **OpenCode location:** run it inside the Vendroid stack (recommended: shares the workspace volume), or connect to an
   OpenCode server you already run?
4. **Play upload (SH-1):** will you create a Google Cloud service account with access to your Play Console account?
