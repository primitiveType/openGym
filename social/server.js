import http from 'node:http';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createSocial } from './app.js';

/** Bound the body before handing it to the federation library, including chunked uploads. */
export function listen(app, { host = '127.0.0.1', port = 3100, maxBody = 5 * 1024 * 1024 } = {}) {
  const rates = new Map();
  const server = http.createServer(async (req, res) => {
    try {
      const key = req.socket.remoteAddress, now = Date.now();
      const rate = rates.get(key);
      const bucket = !rate || now - rate.at > 60000 ? { at: now, n: 0 } : rate;
      rates.set(key, bucket);
      if (++bucket.n > 300) { res.writeHead(429, { 'Retry-After': '60' }); res.end(); return; }
      if (rates.size > 10000) for (const [k, v] of rates) if (now - v.at > 60000) rates.delete(k);
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) { res.writeHead(413); res.end(); return; }
        chunks.push(chunk);
      }
      // Host and forwarded headers never select the canonical identity or request URL.
      const target = new URL(req.url, app.origin);
      if (target.origin !== app.origin || target.username || target.password) { res.writeHead(400); res.end(); return; }
      const request = new Request(target, { method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}) });
      const response = await app.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end();
      console.error('Social HTTP error', e.message);
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 20000;
  return new Promise(resolve => server.listen(port, host, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const token = fs.readFileSync(process.env.SOCIAL_TOKEN_FILE || '/run/secrets/opengym_social', 'utf8').trim();
  const domains = value => String(value || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  const app = createSocial({ origin: process.env.SOCIAL_ORIGIN, token, dataDir: process.env.DATA_DIR || '/data', paused: process.env.SOCIAL_PAUSED === '1',
    allowedDomains: domains(process.env.SOCIAL_ALLOWED_DOMAINS), blockedDomains: domains(process.env.SOCIAL_BLOCKED_DOMAINS) });
  const server = await listen(app, { host: '0.0.0.0', port: +(process.env.PORT || 3100) });
  const timer = setInterval(() => app.pump().catch(e => console.error('Social queue', e.message)), 1000);
  const stop = () => { clearInterval(timer); server.close(() => { app.close(); process.exit(0); }); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
