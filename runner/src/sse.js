// Server-Sent Events helper. Headers disable proxy buffering (nginx, Caddy, Traefik/Coolify).
export function openSse(req, res) {
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  req.socket.setTimeout(0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  let closed = false;
  const hb = setInterval(() => !closed && res.write(': hb\n\n'), 15_000);
  const closeHandlers = [];
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    closeHandlers.forEach((f) => { try { f(); } catch { /* ignore */ } });
  };
  req.on('close', close);
  return {
    get closed() { return closed; },
    send(event, data, id) {
      if (closed) return;
      let msg = '';
      if (id !== undefined) msg += `id: ${id}\n`;
      msg += `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      res.write(msg);
    },
    onClose(fn) { closeHandlers.push(fn); },
    end() {
      if (!closed) res.end();
      close();
    },
  };
}
