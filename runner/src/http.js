// Minimal router / body parser / static file server on node:http (no dependencies).
import fs from 'node:fs';
import path from 'node:path';
import { HttpError } from './validate.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:([A-Za-z]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    this.routes.push({ method, re, keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  match(method, pathname) {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        return { route: r, params };
      }
    }
    return null;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sendJson(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

export function readJson(req, limit = 1024 * 1024, { allowArray = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return resolve({});
    const ct = req.headers['content-type'] || '';
    const len = Number(req.headers['content-length'] || 0);
    if (len === 0 && !req.headers['transfer-encoding']) return resolve({});
    if (!ct.toLowerCase().startsWith('application/json')) {
      return reject(new HttpError(415, 'Content-Type must be application/json'));
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || (Array.isArray(v) && !allowArray)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, allowArray ? 'Body must be JSON' : 'Body must be a JSON object'));
      }
    });
    req.on('error', reject);
  });
}

export function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Serve a file from `root` (path-traversal safe). Returns false if not found. */
export function serveStatic(res, root, relPath) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + relPath));
  if (full !== root && !full.startsWith(root + path.sep)) return false;
  let st;
  try { st = fs.statSync(full); } catch { return false; }
  if (!st.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
  return true;
}
