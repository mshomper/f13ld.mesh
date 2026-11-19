// Headless smoke test of the page on a software GPU (Chrome or Edge, SwiftShader / WARP). Plain Node
// (global WebSocket, Node 22+), no packages. It starts the browser itself, opens the page with
// ?auto=compare64, waits for the page title to turn DONE, prints the page log and the log block,
// then stops the browser it started. Prints no speed worth quoting: a software GPU says nothing.
//   node proto/gpu-bake/smoke.mjs [file|url] [seconds] [browser.exe]
//   file = the single file opened from disk (default); url = e.g. http://localhost:8091/ (run serve.mjs first)
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const what = process.argv[2] || 'file';
const seconds = +(process.argv[3] || 150);
const exe = process.argv[4] || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const target = (what === 'file' ? pathToFileURL(path.join(here, 'gpu-bake-single.html')).href : what.replace(/\/?$/, '/')) + '?auto=compare64';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gpubake-smoke-'));
const port = 9333 + Math.floor(Math.random() * 500);

const child = spawn(exe, [...(process.env.SMOKE_HEADFUL ? ['--window-position=-32000,-32000', '--window-size=900,700'] : ['--headless=new']), `--remote-debugging-port=${port}`, '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--no-first-run', `--user-data-dir=${profile}`,
  ...(process.env.SMOKE_FLAGS ? process.env.SMOKE_FLAGS.split(' ') : []), 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : undefined; };

let code = 1;
try {
  let tab = null;
  for (let i = 0; i < 60 && !tab; i++) {
    await sleep(500);
    try { const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); tab = list.find(t => t.type === 'page'); } catch (_) { /* not up yet */ }
  }
  if (!tab) throw new Error('browser did not start');
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const events = [];
  ws.onmessage = m => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)({ result: d.result, error: d.error }); pending.delete(d.id); }
    else if (d.method === 'Runtime.exceptionThrown') events.push('exception: ' + ((d.params.exceptionDetails.exception && d.params.exceptionDetails.exception.description) || d.params.exceptionDetails.text));
    else if (d.method === 'Log.entryAdded' && d.params.entry.level !== 'info') events.push(d.params.entry.level + ': ' + d.params.entry.text + ' ' + (d.params.entry.url || ''));
  };
  globalThis.__events = events;
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Page.navigate', { url: target });
  const t0 = Date.now(); let title = '';
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(1000);
    title = await evalJs('document.title');
    if (typeof title === 'string' && title.startsWith('DONE')) break;
  }
  const out = await evalJs("document.getElementById('out').innerText");
  const report = await evalJs("document.getElementById('report').value");
  const status = await evalJs("document.getElementById('status').textContent");
  console.log(`page title: ${title} | status: ${status} | ${((Date.now() - t0) / 1000).toFixed(0)} s | target ${target}`);
  console.log('--- page log ---\n' + out + '\n--- log block ---\n' + report);
  if (events.length) console.log('--- browser errors ---\n' + events.slice(0, 10).join('\n'));
  code = (typeof title === 'string' && title.startsWith('DONE')) ? 0 : 3;
} catch (e) { console.error('smoke failed: ' + e.message); }
try { ws && ws.close(); } catch (_) { /* ignore */ }
child.kill();
await sleep(500);
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* browser still releasing files; temp folder */ }
process.exit(code);
