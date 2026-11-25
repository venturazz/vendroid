// Edge relay for Docker / Coolify.
//
// The runner container uses `network_mode: host` so it can reach the phone through the host's
// ZeroTier/WireGuard interface and the loopback-only 9Router / Hermes services. Coolify's Traefik
// cannot route to host-network containers, so this relay runs as a second, bridge-network service
// that Traefik *can* route to, and pipes every TCP connection byte-for-byte into the runner's Unix
// socket (shared volume). Raw piping means SSE frames are never buffered or re-encoded.
import net from 'node:net';

const port = Number(process.env.PORT) || 3080;
const socketPath = process.env.RUNNER_SOCKET || '/run/runner/runner.sock';

const server = net.createServer((client) => {
  client.setNoDelay(true);
  client.setKeepAlive(true, 30_000);
  const upstream = net.connect(socketPath);
  upstream.setNoDelay(true);
  const fail = () => {
    if (!client.destroyed) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: 34\r\n\r\nRunner is starting, retry shortly\n');
    }
    upstream.destroy();
  };
  upstream.once('error', fail);
  upstream.once('connect', () => {
    upstream.removeListener('error', fail);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  });
});

server.on('error', (e) => {
  console.error('[edge] listen error:', e.message);
  process.exit(1);
});
server.listen(port, '0.0.0.0', () => console.log(`[edge] 0.0.0.0:${port} -> unix:${socketPath}`));

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
