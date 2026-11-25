import { sendJson } from '../http.js';
import * as auth from '../auth.js';
import { config } from '../config.js';
import { handleMcp, SERVER_INFO } from '../mcp.js';
import { HttpError } from '../validate.js';

export function register(router, { agentTools }) {
  const requireToken = (req) => {
    if (req.authKind !== 'token') throw new HttpError(401, 'Bearer token required (Settings → Agents in the dashboard)');
  };

  // MCP Streamable HTTP (stateless). GET would open a server->client stream, which we don't offer.
  router.post('/mcp', async (req, res, { body }) => {
    requireToken(req);
    const r = await handleMcp(body, agentTools);
    if (r.status === 202) { res.writeHead(202); return res.end(); }
    sendJson(res, r.status, r.body);
  }, { jsonAny: true });
  router.get('/mcp', (req, res) => sendJson(res, 405, { error: 'Use POST (stateless Streamable HTTP)' }, { Allow: 'POST' }), { public: true });

  // REST mirror of the MCP tools.
  router.get('/api/agent/tools', (req, res) => sendJson(res, 200, { tools: agentTools.list() }));
  router.post('/api/agent/tools/:name', async (req, res, { params, body }) => {
    requireToken(req);
    const { image, value } = await agentTools.call(params.name, body);
    if (image) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': value.length });
      return res.end(value);
    }
    sendJson(res, 200, { result: value });
  });

  // Dashboard: how to connect Hermes (session only, shows the token).
  router.get('/api/agent/info', (req, res) => {
    if (req.authKind !== 'session') throw new HttpError(403, 'Open this from the dashboard');
    sendJson(res, 200, {
      token: auth.getAgentToken(),
      tokenSource: config.mcpToken ? 'MCP_TOKEN' : config.apiToken ? 'API_TOKEN' : 'generated',
      localUrl: `http://127.0.0.1:${config.port}/mcp`,
      server: SERVER_INFO,
      writeTools: config.mcpAllowWrite,
      hermes: { url: config.hermesWebhookUrl, secretConfigured: !!config.hermesWebhookSecret },
    });
  });
  router.post('/api/agent/rotate', (req, res) => {
    if (req.authKind !== 'session') throw new HttpError(403, 'Open this from the dashboard');
    try { sendJson(res, 200, { token: auth.rotateAgentToken() }); } catch (e) { throw new HttpError(e.status || 500, e.message); }
  });
}
