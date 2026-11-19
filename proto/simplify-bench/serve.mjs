// proto/simplify-bench/serve.mjs - tiny static server for the repo root, so index.html can fetch ../../worker/*.js.
//   node proto/simplify-bench/serve.mjs [port]      then open http://localhost:8091/proto/simplify-bench/
// (The single-file page needs no server: double-click proto/simplify-bench/simplify-bench-single.html.)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), port = +process.argv[2] || 8091;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.slb': 'application/octet-stream', '.md': 'text/plain' };
http.createServer((req, res) => {
  const p = path.normalize(path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} at http://localhost:${port}/proto/simplify-bench/`));
