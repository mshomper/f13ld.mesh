// F13LD.mesh · tests/serve.js — serve one build to a Playwright context from a
// real local server (127.0.0.1, free port).
//
// Why not ctx.route with a made-up host (the old way): a request made by a
// worker that was started from another worker never reaches ctx.route in
// current Chromium, so the made-up host can't be found and the worker fails to
// load. The mesh worker starts field-bake-worker.js that way (multi-core field,
// m33; slab mesher, m36), so every export big enough to use the pool quietly
// fell back to one core and the classic mesher. A real server has no such gap.
//
// The same gap applies to the CDN: a nested worker's import of a CDN package
// would go to the internet. So every https://cdn.jsdelivr.net/… and
// https://esm.sh/… URL in served scripts and pages is pointed at
// /__cdn/<host>/… on this server, which answers from the packages in
// tests/node_modules through the caller's cdn(url). Files on disk are not
// touched, and nothing is fetched from outside.
//
//   const site = await serveBuild(ctx, root, cdn, mime, misses);
//   await page.goto(site.origin + '/index.html');   …   site.close();
// cdn(url) → {body, type} | null, mime(path) → content type, misses: array that
// collects anything asked for and not served (optional).
'use strict';
const fs = require('fs'), path = require('path'), http = require('http');

async function serveBuild(ctx, root, cdn, mime, misses) {
  misses = misses || [];
  let origin = '';
  const rootAbs = path.resolve(root);
  const local = (body, type) => /javascript|html/.test(type)
    ? Buffer.from(String(body).replace(/https:\/\/(cdn\.jsdelivr\.net|esm\.sh)\//g, (m, h) => origin + '/__cdn/' + h + '/'))
    : body;
  const server = http.createServer((q, r) => {
    let p;
    try { p = decodeURIComponent(q.url.split('?')[0]); } catch (e) { r.writeHead(400); return r.end(); }
    if (p === '/') p = '/index.html';
    if (p.startsWith('/__cdn/')) {
      const hit = cdn('https://' + p.slice(7));
      if (hit) { r.writeHead(200, { 'content-type': hit.type, 'cache-control': 'no-store' }); return r.end(local(hit.body, hit.type)); }
      misses.push('https://' + p.slice(7)); r.writeHead(404); return r.end();
    }
    const f = path.join(rootAbs, p);
    if (f.startsWith(rootAbs) && fs.existsSync(f) && fs.statSync(f).isFile()) { const t = mime(f); r.writeHead(200, { 'content-type': t, 'cache-control': 'no-store' }); return r.end(local(fs.readFileSync(f), t)); }
    misses.push(origin + q.url); r.writeHead(404); r.end();
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const host = '127.0.0.1:' + server.address().port;
  origin = 'http://' + host;
  // Page-level requests still pass through the context: fonts are answered
  // empty, anything else outside this server is refused (and listed).
  await ctx.route('**/*', async route => {
    const url = route.request().url(); let u;
    try { u = new URL(url); } catch (e) { return route.abort(); }
    if (u.host === host) return route.continue();
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url);
    if (hit) return route.fulfill({ body: local(hit.body, hit.type), contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    misses.push(url); return route.abort();
  });
  return { origin, host, misses, close: () => new Promise(k => { server.closeAllConnections && server.closeAllConnections(); server.close(() => k()); }) };
}
module.exports = { serveBuild };
