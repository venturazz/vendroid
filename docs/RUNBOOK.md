# Runbook

## 0. Prerequisites

- OCI Ampere A1 VM, Ubuntu 22.04/24.04 `aarch64`, DNS name pointing at it, ports 80/443 open (OCI security list **and** `ufw`/iptables). **Do not open 3080, 20128 or 8644.**
- 9Router on `127.0.0.1:20128`, Hermes Agent on `127.0.0.1:8644` (already running on the VM).
- An Android project with a Gradle wrapper (`gradlew`).

## 1. ARM64 `aapt2` strategy

Google ships `aapt2` (in `build-tools` and in the Maven artifact AGP downloads) as x86_64 only. The runner
makes Gradle use a working aarch64 one through `android.aapt2FromMavenOverride`:

1. `runner/scripts/bootstrap-sdk.sh` finds a working `aapt2` and records its path in `$ANDROID_HOME/.aapt2_path`.
   Order in `AAPT2_MODE=auto`: `AAPT2_BINARY` if set, then `/usr/bin/aapt2` from the `aapt` apt package (if your Ubuntu release packages it), then a **box64** wrapper around the SDK's x86_64 `aapt2`.
2. At startup the runner writes `android.aapt2FromMavenOverride=<that path>` plus the memory caps into
   `$GRADLE_USER_HOME/gradle.properties` (a managed block). User-home properties outrank the project's
   own `gradle.properties`, so the project repo needs no changes. The same override is also passed as `-P` on every build.
3. `GET /api/health/env` runs `aapt2 version`. `aapt2.ok:false` means builds will fail at resource linking.

Choosing a mode: `AAPT2_MODE=apt` (native, fastest), `box64` (set `BUILD_BOX64=1` for the setup script or
`INSTALL_BOX64=true` for Docker), or `path` with `AAPT2_BINARY=/path/to/native/aapt2` (e.g. a community
aarch64 build). The `aapt2` version must be compatible with your Android Gradle Plugin version; if linking
fails with an unknown-flag error, use a newer aapt2.

`adb` is the distro's native arm64 build (`adb` package). Google's `platform-tools` is not installed.

## 2. Deployment A: normal Linux service (systemd + Caddy/Nginx)

```bash
git clone <this repo> && cd <repo>
sudo bash runner/scripts/setup-ubuntu-arm64.sh            # add BUILD_BOX64=1 if you want box64
sudoedit /etc/android-runner.env                          # package, phone address, AI keys, AUTH_PASSWORD
sudo -u android-runner git clone <your-android-repo> /srv/android-project
sudo systemctl restart android-runner && journalctl -u android-runner -f
```

The service listens on `127.0.0.1:3080` (`HOST=127.0.0.1` in the env file). Add HTTPS with one of:

- Caddy: put `deploy/proxy/Caddyfile` in `/etc/caddy/Caddyfile` (edit the hostname), `sudo systemctl reload caddy`. `flush_interval -1` is what keeps SSE live.
- Nginx: `deploy/proxy/nginx.conf` (`proxy_buffering off`, `gzip off`, 1 h read timeout), then `certbot --nginx`.

Set `TRUST_PROXY=true` in the env file when the proxy overwrites `X-Forwarded-For`.
pm2 instead of systemd: `deploy/ecosystem.config.cjs` (keep one instance).

## 3. Deployment B: Docker Compose / Coolify

```bash
cp .env.example .env     # set AUTH_PASSWORD, DEFAULT_*, NINE_ROUTER_*, HERMES_*; set PROJECT_GIT_URL to auto-clone
docker compose up -d --build
```

First start downloads the Android SDK into the `android-sdk` volume (a few minutes); later starts skip it.
Persisted volumes: `android-sdk`, `gradle-home` (`/root/.gradle`), `android-keys` (`/root/.android`, the ADB RSA keys), `runner-data` (history, logs, APKs, session secret), `project`.

**Coolify:** New Resource → Docker Compose (from this repo) → paste/enter the variables from `.env.example` in the Environment tab (`AUTH_PASSWORD` is mandatory; compose fails fast without it) → Deploy.

### Networking: `network_mode: host` vs bridge

| | host (default) | bridge (`docker-compose.bridge.yml`) |
|---|---|---|
| 9Router / Hermes on host `127.0.0.1` | reachable | **not reachable**; they must also listen on the docker gateway IP (e.g. `172.17.0.1`), still not public |
| ADB to phone's tunnel IP | direct via the host's ZeroTier/WireGuard interface | works through host NAT/routing (outbound only) |
| Coolify domain/Traefik routing | Traefik cannot route by label to a host-network container; either proxy with the host Caddy/Nginx to `127.0.0.1:3080` (set `RUNNER_BIND_HOST=127.0.0.1`), or bind `0.0.0.0` and block 3080 in the firewall | works with Coolify's domain feature |

Host mode is the default because it keeps both AI services loopback-only without changes. If you want Coolify's built-in HTTPS routing, use host mode with the host reverse proxy above, or switch to bridge mode and accept the extra listener on the docker gateway. I could not exercise Coolify itself from the build sandbox, so check this part on your server.

## 4. Connecting the phone over ZeroTier / WireGuard

SSH is for administering the VM. ADB reaches the phone only through the tunnel.

1. **Tunnel:** install ZeroTier (`curl -s https://install.zerotier.com | sudo bash; sudo zerotier-cli join <network-id>`) on the VM and in the phone's ZeroTier app, authorize both in ZeroTier Central, and note the phone's managed IP (e.g. `10.147.17.50`). For WireGuard, use a `wg0` peer for the phone with a fixed tunnel IP and `PersistentKeepalive = 25`. Do not use a phone that sleeps its VPN aggressively: disable battery optimization for the VPN app.
2. **Enable ADB over TCP** (one of):
   - Plug in once by USB: `adb tcpip 5555` (resets on phone reboot).
   - Android 11+ Wireless debugging: pair once from the VM with `adb pair <ip>:<pair_port>` (code from the phone), then use the **connect port shown on the Wireless debugging screen** (it changes after toggling/rebooting; update `DEFAULT_DEVICE_ADDRESS`).
3. **Reachability check from the VM (or `docker exec`):** `nc -vz <phone_tunnel_ip> 5555`.
4. In the dashboard type `<phone_tunnel_ip>:5555` → **Connect**. Accept **Allow USB debugging → Always allow** on the phone. The key is stored in `~/.android` (`/root/.android` in Docker, `/var/lib/android-runner/.android` under systemd), which is why that path is persisted.
5. If the device shows `offline` or `unauthorized`: **Reconnect**, then **Restart ADB**.

## 5. Verify end to end

```bash
H=https://runner.example.com
curl -c jar -H 'Content-Type: application/json' -d '{"password":"…"}' $H/api/auth/login
curl -b jar $H/api/health/env | jq '.ok,.checks,.aapt2'            # all true; aarch64 true
curl -b jar $H/api/ai/status                                        # both reachable
curl -b jar -H 'Content-Type: application/json' -d '{"target":"10.147.17.50:5555"}' $H/api/devices/connect
curl -b jar $H/api/devices
curl -N -b jar -H 'Content-Type: application/json' -X POST \
  -d '{"task":"assembleDebug","autoInstallAfterBuild":true,"autoLaunchAfterInstall":true}' $H/api/builds   # note the id
curl -N -b jar $H/api/builds/<id>/stream                            # lines must arrive live, not in one burst
```

- **SSE through the proxy:** if the build log appears all at once, the proxy is buffering (see the Caddy/Nginx snippets).
- **9Router:** break the build (e.g. an unresolved reference), click **Analyze Error (9Router)**, or `POST /api/ai/analyze {"mode":"build_error","jobId":"<id>"}`. A `502` with "9Router unreachable/returned …" means a wrong `NINE_ROUTER_URL`, key or model.
- **Hermes:** `POST /api/ai/hermes-investigate {"jobId":"<id>"}` or tick **Auto-Notify Hermes** on a failing build. The webhook receives `X-Webhook-Secret: $HERMES_WEBHOOK_SECRET` and the JSON `{event, jobId, projectPath, packageName, deviceSerial, errorTail, crashSnippet, timestamp}`.
- **Concurrency:** queue two builds; the second stays `queued` until the first finishes. **Cancel** kills the whole Gradle process group.

## 6. Operations

- Memory: Gradle JVM `-Xmx4096m -XX:+UseG1GC`, Kotlin daemon `-Xmx3072m`, `--no-daemon`, max 3 workers; override with `GRADLE_JVM_ARGS`, `KOTLIN_DAEMON_JVM_ARGS`, `GRADLE_MAX_WORKERS`.
- Release builds are unsigned unless your project configures signing; install of an unsigned APK fails by design.
- Upgrade: systemd → re-run the setup script, `systemctl restart android-runner`. Docker → `docker compose up -d --build`. State survives in volumes / `/var/lib/android-runner`.
- A runner restart during a build marks that build `failed` (“Interrupted by runner restart”).
