// Energía Vital — minimal static server (Node, no deps)
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt':  'text/plain; charset=utf-8'
};

const HEADERS_BASE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function safeJoin(root, target) {
  const resolved = path.normalize(path.join(root, target));
  if (!resolved.startsWith(root)) return null;
  return resolved;
}

const server = http.createServer((req, res) => {
  let pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
  if (pathname === '/') pathname = '/index.html';

  const filePath = safeJoin(ROOT, pathname);
  if (!filePath) {
    res.writeHead(400, HEADERS_BASE);
    res.end('Bad Request');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback: serve index.html for unknown routes
      const fallback = path.join(ROOT, 'index.html');
      fs.readFile(fallback, (e2, data) => {
        if (e2) { res.writeHead(404, HEADERS_BASE); res.end('Not Found'); return; }
        res.writeHead(200, { ...HEADERS_BASE, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(data);
      });
      return;
    }

    fs.readFile(filePath, (e3, data) => {
      if (e3) { res.writeHead(500, HEADERS_BASE); res.end('Server Error'); return; }
      const ext = path.extname(filePath).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const cache = (ext === '.html' || ext === '.json')
        ? 'no-cache'
        : 'public, max-age=86400';
      res.writeHead(200, { ...HEADERS_BASE, 'Content-Type': type, 'Cache-Control': cache });
      res.end(data);
    });
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Energía Vital running on http://0.0.0.0:${PORT}`);
});
