// Model Context Protocol server (Streamable HTTP transport, stateless, JSON responses).
// POST /mcp with JSON-RPC 2.0. Auth: Authorization: Bearer <MCP token>.
const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'vendroid', title: 'Vendroid Android IDE', version: '2.0.0' };

const INSTRUCTIONS = `Vendroid builds Android apps on an ARM64 server and controls a physical phone over ADB.
Typical loop: list_projects (or create_project / clone_project) -> read_file/search_code -> apply_edits ->
start_build (install/launch, waitSeconds) -> logcat / screenshot -> fix -> git_commit. Builds are serialized; start_build
with waitSeconds blocks until done. For HTML/JS games and web apps use create_project template=webview and edit
app/src/main/assets/www/. delete_project moves to a 7-day trash (restore_project).`;

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** Handle one JSON-RPC message. Returns a response object, or null for notifications. */
async function handleOne(msg, tools) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid Request');
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined || id === null;
  try {
    let result;
    switch (method) {
      case 'initialize': {
        const want = params.protocolVersion;
        result = {
          protocolVersion: SUPPORTED.includes(want) ? want : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: tools.list() };
        break;
      case 'tools/call': {
        if (typeof params.name !== 'string') return rpcError(id, -32602, 'params.name is required');
        try {
          const { image, value, mime, meta } = await tools.call(params.name, params.arguments || {});
          if (image) {
            result = { content: [
              { type: 'image', data: Buffer.from(value).toString('base64'), mimeType: mime || 'image/png' },
              ...(meta ? [{ type: 'text', text: JSON.stringify(meta) }] : []),
            ] };
          } else {
            const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            result = { content: [{ type: 'text', text }] };
          }
        } catch (e) {
          // Tool errors are results (the model should see them), not protocol errors.
          result = { content: [{ type: 'text', text: e.message || String(e) }], isError: true };
        }
        break;
      }
      default:
        if (method.startsWith('notifications/')) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
    return isNotification ? null : { jsonrpc: '2.0', id, result };
  } catch (e) {
    return isNotification ? null : rpcError(id, -32603, e.message || 'Internal error');
  }
}

/** @returns {{status:number, body:any}} body null => 202 Accepted (notifications only) */
export async function handleMcp(payload, tools) {
  if (Array.isArray(payload)) {
    if (!payload.length) return { status: 400, body: rpcError(null, -32600, 'Empty batch') };
    const out = (await Promise.all(payload.map((m) => handleOne(m, tools)))).filter(Boolean);
    return out.length ? { status: 200, body: out } : { status: 202, body: null };
  }
  const r = await handleOne(payload, tools);
  return r ? { status: 200, body: r } : { status: 202, body: null };
}
