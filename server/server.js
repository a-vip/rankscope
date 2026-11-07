'use strict';
/**
 * RankScope local / Node host server.
 *   node server/server.js            -> http://localhost:8787
 * Serves ./public statically and answers /api/ with the same contract as api/index.php.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { handle, loadEnv } = require('./proxy');

loadEnv(path.join(__dirname, '..', '.env'));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
}

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Access-Control-Allow-Origin': process.env.CORS_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'X-Access-Token',
  });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res, pathname) {
  // Never expose backend internals (PHP source, cache, config) from the static root.
  if (/^\/api\//i.test(pathname) && pathname !== '/api/sources.json') { res.writeHead(404); return res.end('Not found'); }
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  if (p === '/api' || p === '/api/' || p === '/api/index.php') {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'Method not allowed' });
    const query = Object.fromEntries(url.searchParams.entries());
    const out = await handle(query, { ip: clientIp(req), token: req.headers['x-access-token'] || '' });
    return sendJson(res, out.code, out.json);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, p);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`RankScope running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  });
}

module.exports = { server };
