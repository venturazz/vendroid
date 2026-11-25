# Runbook

1. [Prerequisites](#1-prerequisites)
2. [Deploy on Coolify / Docker Compose](#2-deploy-on-coolify--docker-compose)
3. [Deploy as a normal Linux service (systemd)](#3-deploy-as-a-normal-linux-service-systemd)
4. [Connect the phone over ZeroTier / WireGuard](#4-connect-the-phone-over-zerotier--wireguard)
5. [Verify builds, 9Router and Hermes](#5-verify-builds-9router-and-hermes)
6. [Optional: push-to-deploy, release signing, API token](#6-optional-features)
7. [ARM64 aapt2 details](#7-arm64-aapt2-details)
8. [Troubleshooting](#8-troubleshooting)

## 1. Prerequisites

- OCI Ampere A1 VM with Ubuntu 22.04/24.04 `aarch64` (4 OCPU / 24 GB is plenty) and a DNS name for the dashboard.
- 80/443 reachable (OCI security list and the VM firewall). **Never open 3080, 20128 or 8644.**
- 9Router on `127.0.0.1:20128` and Hermes Agent on `127.0.0.1:8644` on the same VM.
- Your Android project in a Git repository (any AGP 8.x/9.x project with `gradlew`).

## 2. Deploy on Coolify / Docker Compose

How it is wired:

```
Internet ─► Coolify proxy ─► edge (bridge network, :3080) ─► Unix socket ─► runner (host network)
                                                                              ├─ 127.0.0.1:20128 9Router
                                                                              ├─ 127.0.0.1:8644  Hermes
                                                                              └─ zt*/wg0 ─► phone :5555
```

`runner` uses the host network so it reaches the phone through the host's tunnel interface and the loopback-only AI
services, the same as a systemd install. Coolify cannot route a domain to a host-network container, so the small
`edge` service relays each connection byte-for-byte into the runner's Unix socket. SSE is never buffered.

**Coolify**

1. *+ New Resource → Public/Private Repository →* this repo, *Build Pack: Docker Compose*, file `docker-compose.yml`.
2. *Domains:* set the `edge` service to `https://runner.example.com:3080`. The `:3080` is the container port; visitors
   use plain `https://runner.example.com`. Leave `runner` without a domain.
3. *Environment Variables* (everything else has defaults):
   | Variable | Example |
   |---|---|
   | `DEFAULT_PACKAGE_NAME` | `com.example.myapp` |
   | `DEFAULT_DEVICE_ADDRESS` | `10.147.17.50:5555` |
   | `PROJECT_GIT_URL` | `https://github.com/you/app.git` (private: `https://<token>@github.com/you/app.git`) |
   | `AUTH_PASSWORD` | optional. If empty, a password is generated and shown in the `runner` logs |
   | `NINE_ROUTER_API_KEY`, `NINE_ROUTER_MODEL`, `HERMES_WEBHOOK_SECRET` | your values |
4. *Deploy.* The dashboard is up within seconds. On first start the runner installs the Android SDK and aarch64 build
   tools into a volume (about 2 to 4 minutes, visible in the logs). Builds queued meanwhile wait for it.
5. Sign in. The password is in the `runner` logs (`AUTH_PASSWORD not set. Dashboard password: …`) unless you set one.

**Plain Docker Compose** (no Coolify): `cp .env.example .env`, edit, `docker compose up -d --build`. The runner listens
on `127.0.0.1:3080`. Put the host's Caddy/Nginx in front (section 3, step 4).

Persistent volumes (kept across redeploys): `android-sdk`, `gradle-home`, `android-keys` (ADB RSA key, so the phone
stays authorized), `runner-data` (history, logs, APKs, generated password), `project` (checkout).

## 3. Deploy as a normal Linux service (systemd)

1. Install (idempotent; re-run it to upgrade):
   ```bash
   git clone https://github.com/venturazz/vendroid && cd vendroid
   sudo PROJECT_GIT_URL=https://github.com/you/app.git bash runner/scripts/setup-ubuntu-arm64.sh
   ```
   It installs JDK 17 + 21, Node 22, adb, box64, the SDK and aarch64 tools. It also creates the `android-runner` user and
   `/etc/android-runner.env`, starts the service, and prints the password.
2. Edit `/etc/android-runner.env` (`DEFAULT_PACKAGE_NAME`, `DEFAULT_DEVICE_ADDRESS`, AI keys), then
   `sudo systemctl restart android-runner`.
3. Logs: `journalctl -u android-runner -f`.
4. HTTPS:
   - **Caddy**: copy `deploy/proxy/Caddyfile` to `/etc/caddy/Caddyfile`, set the hostname, `sudo systemctl reload caddy`.
     `flush_interval -1` keeps SSE live.
   - **Nginx**: `deploy/proxy/nginx.conf` (`proxy_buffering off`, `gzip off`, 1 h timeouts) and `certbot --nginx -d …`.
5. pm2 instead of systemd: `deploy/ecosystem.config.cjs`. Keep a single instance, because the build lock is in-process.

## 4. Connect the phone over ZeroTier / WireGuard

SSH is for administering the VM. ADB only travels inside the tunnel.

1. **Tunnel**
   - ZeroTier: on the VM run `curl -s https://install.zerotier.com | sudo bash && sudo zerotier-cli join <network-id>`.
     Install the ZeroTier app on the phone, join the same network, authorize both in ZeroTier Central, and note the
     phone's managed IP.
   - WireGuard: give the phone a peer with a fixed tunnel IP and `PersistentKeepalive = 25`.
   - On the phone, exclude the VPN app from battery optimization so the tunnel survives screen-off.
2. **ADB over TCP** (one of):
   - Android 11+ *Wireless debugging*: pair once from the VM
     (`adb pair <phone_ip>:<pairing_port>`, or `docker compose exec runner adb pair …`) with the code shown on the phone,
     then use the **IP address & port** shown on the Wireless debugging screen. That port changes when wireless
     debugging is toggled or the phone reboots; update `DEFAULT_DEVICE_ADDRESS` or type it into the top bar.
   - USB once: `adb tcpip 5555` gives a fixed port, which resets on phone reboot.
3. **Check reachability from the VM**: `nc -vz <phone_ip> 5555`.
4. **Connect**: set `DEFAULT_DEVICE_ADDRESS` (the runner connects and keeps reconnecting on its own) or type
   `<phone_ip>:5555` in the top bar and click **Connect**. On the phone accept **Allow USB debugging?** and tick
   **Always allow from this computer**. The key lives in the persisted `~/.android`.
5. The device badge turns green. `unauthorized` means the phone prompt hasn't been accepted. `offline` means click
   **Reconnect**; if that doesn't help, **Restart ADB**. Manually disconnecting pauses auto-reconnect until you connect again.

## 5. Verify builds, 9Router and Hermes

In the dashboard:
1. Click **env** in the top bar: every row should be green (aarch64, Java, SDK, adb, aapt2, project).
2. **Build & Deploy** (`Ctrl+Enter`) with Auto-Install and Auto-Launch on. Lines must stream live. If they arrive in one burst
   at the end, a proxy is buffering (see section 3, step 4). The app launches and the Logcat tab opens filtered to it.
3. Break the code (an unresolved reference), build again, then **Analyze Error (9Router)**. A 502 message names the
   problem (`unreachable`, HTTP status, or an empty completion), usually the URL, key or model.
4. **Investigate (Hermes)**: Hermes receives `POST $HERMES_WEBHOOK_URL` with header `X-Webhook-Secret` and body
   `{event, jobId, projectPath, packageName, deviceSerial, errorTail, crashSnippet, timestamp}`.

From a shell (works for automation too):
```bash
H=https://runner.example.com
curl -c jar -H 'Content-Type: application/json' -d '{"password":"…"}' $H/api/auth/login
curl -b jar $H/api/health/env | jq '.ok, .checks'
curl -b jar -H 'Content-Type: application/json' -d '{"task":"assembleDebug","autoInstallAfterBuild":true,"autoLaunchAfterInstall":true}' $H/api/builds
curl -N -b jar $H/api/builds/<id>/stream
curl -b jar $H/api/ai/status
```

## 6. Optional features

**Push-to-deploy.** Set `GIT_WEBHOOK_SECRET` (and `AUTO_BUILD_BRANCH=main` to limit branches). In GitHub, open
*Settings → Webhooks → Add*, set the payload URL to `https://runner.example.com/api/hooks/git`, content type `application/json`,
and the same secret, with *Just the push event*. GitLab uses the *Secret token* field; Gitea/Forgejo work the same way as GitHub. Each push runs `git pull`, builds
`AUTO_BUILD_TASK`, and installs and launches on the default device. Pushes that arrive while a webhook build is already
queued are merged into it.

**Signed release builds.** Put the keystore where the runner can read it (Docker: e.g. `/data/release.jks` via
`docker compose cp release.jks runner:/data/`; systemd: `/var/lib/android-runner/release.jks`, owned by `android-runner`) and
set `RELEASE_KEYSTORE_PATH`, `RELEASE_KEYSTORE_PASSWORD`, `RELEASE_KEY_ALIAS` and, if different, `RELEASE_KEY_PASSWORD`.
The runner uses AGP's injected-signing properties, the mechanism Android Studio uses, so the project needs no
`signingConfig`. Without them `assembleRelease` produces an unsigned APK and auto-install is skipped.

**Scripts / CI.** Set `API_TOKEN` (16+ characters) and call any endpoint with `Authorization: Bearer $API_TOKEN`.

## 7. ARM64 aapt2 details

Google ships `aapt2`, `aidl` and `zipalign` for x86_64 only. `bootstrap-sdk.sh` sets things up, and with `AAPT2_MODE=auto` it uses the first option that works:

| Mode | What it does | Notes |
|---|---|---|
| `path` | uses your `AAPT2_BINARY` | for a custom aarch64 build |
| `box64` (default when box64 is installed) | runs **Google's own** x86_64 `aapt2` from the newest installed `build-tools` under box64, so the format always matches your SDK/AGP | the Docker image and the setup script install box64 (pinned `v0.4.4`, a one-time compile of about 5 minutes). Opt out with `INSTALL_BOX64=false` / `BUILD_BOX64=0` |
| `prebuilt` | static aarch64 AOSP build-tools 35.0.2 (SHA-256 pinned) | no emulation, but **too old for AGP 9 release builds** |
| `apt` | `/usr/bin/aapt2` from a distro package | offline hosts |

In every mode, `aidl`, `zipalign`, `aapt`, `dexdump` and `split-select` inside each installed `build-tools/*` are swapped for
native aarch64 builds (originals kept as `*.x86_64`).

The chosen path is stored in `$ANDROID_HOME/.aapt2_path`. The runner writes it as `android.aapt2FromMavenOverride`
into `$GRADLE_USER_HOME/gradle.properties`, which outranks the project's own file, and also passes it as `-P`.

After every build the runner checks that the APK contains `AndroidManifest.xml` and `resources.arsc`. An aapt2 that is
too old can make Gradle report success while writing a package without them. The runner fails such a build with a
clear message instead of installing it.

CI builds a Compose app on arm64 against a pinned AGP 8 stack and against the latest AGP/Gradle/Kotlin/compileSdk every
week, so an incompatible AGP release shows up there first.

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| Log arrives all at once | Proxy buffering. Caddy `flush_interval -1`, Nginx `proxy_buffering off; gzip off`. |
| `AAPT2 … Daemon startup failed` / `Syntax error: "(" unexpected` | aapt2 can't run: check **env → aapt2**, then re-run bootstrap (`docker compose restart runner` or the setup script). |
| Build fails with “APK is missing AndroidManifest.xml…” | aapt2 too old for your AGP: make sure box64 is installed and `AAPT2_MODE=auto` or `box64`, then restart. |
| `SDK location not found` / missing platform | Add it to `SDK_PACKAGES` (e.g. `platforms;android-36`) and restart. Licenses are pre-accepted, so AGP can also download it. |
| `Unsupported class file major version` | The project needs another JDK: Docker `JAVA_VERSION=21`, systemd `JAVA_HOME=/usr/lib/jvm/java-21-openjdk-arm64`. |
| `git pull` fails | Private repo: put a read-only token in the remote URL (`git -C <project> remote set-url origin https://<token>@github.com/…`). |
| Device `unauthorized` | Accept the prompt on the phone. If it never appears, revoke USB debugging authorizations on the phone and reconnect. |
| Device keeps going `offline` | Tunnel sleeps: exclude the VPN app from battery optimization; for WireGuard set `PersistentKeepalive = 25`. |
| Forgot the generated password | Docker: `docker compose exec runner cat /data/initial_password`; systemd: `sudo grep AUTH_PASSWORD /etc/android-runner.env`. |
| Out of memory | Lower `GRADLE_JVM_ARGS` / `GRADLE_MAX_WORKERS`. Defaults use about 8 GB at peak. |

A runner restart during a build marks that build `failed` (“Interrupted by runner restart”). History, APKs and logs
are kept for the last `MAX_BUILD_HISTORY` (30) builds.
