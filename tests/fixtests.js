// Targeted browser tests for the v0.8.1 safety + crash fixes.
// Usage: node fixtests.js <oldDir> <newDir> [filter]
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const H = fs.readFileSync(__dirname + '/harness.js', 'utf8');
const NM = path.join(__dirname, 'node_modules');
eval(H.slice(H.indexOf('const MIME'), H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g, 'var $1'));
const [OLD, NEW, FILTER] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(__dirname + '/recipes.json', 'utf8'));

async function open(root, query, cores = 8) {
  const site = root === OLD ? 'old.test' : 'new.test';
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), cores);
  await ctx.route('**/*', async route => {
    const url = route.request().url(); const u = new URL(url);
    if (u.host === site) { const p = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname); const f = path.join(root, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type }); return route.abort();
  });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text().split('\n')[0]); });
  await page.goto(`http://${site}/index.html${query || ''}`);
  await page.waitForTimeout(2000);
  page.close2 = () => browser.close();
  return page;
}
const q = r => '?r=' + encodeURIComponent(JSON.stringify(r));
const state = page => page.evaluate(() => ({
  err: (document.getElementById('errorBox').style.display !== 'none') ? document.getElementById('errorBox').textContent : '',
  overlay: !document.getElementById('computeOverlay').classList.contains('hidden'),
  co: document.getElementById('coMain').textContent + ' / ' + document.getElementById('coSub').textContent,
  badge: (document.getElementById('typeBadge') || {}).textContent,
  tri: (document.getElementById('triPill') || {}).textContent,
  report: ((document.getElementById('expReport') || {}).textContent || '').trim(),
  bodies: document.querySelectorAll('.shapeCard[data-body-id]').length,
  chips: document.querySelectorAll('.libraryChip').length,
  libRow: (document.getElementById('recipeLibraryRow') || {}).style?.display,
  summary: ((document.getElementById('summaryContent') || {}).innerText || '').slice(0, 120),
}));
async function waitIdle(page, ms = 120000) {
  await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: ms }).catch(() => {});
  await page.waitForTimeout(500);
}
async function exportOnce(page, qual = 'draft', timeout = 300000) {
  await page.evaluate(q => window.setQual(q), qual);
  const dl = page.waitForEvent('download', { timeout }).then(d => ({ ok: true, name: d.suggestedFilename() })).catch(e => ({ ok: false, err: e.message.split('\n')[0] }));
  const err = page.waitForSelector('.exp-err', { timeout }).then(async h => ({ ok: false, err: await h.textContent() })).catch(() => new Promise(() => {}));
  page.evaluate(() => window.triggerExport()).catch(e => { page.errors.push(e.message); });
  return Promise.race([dl, err]);
}
async function addBody(page, file, cellMm) {
  await page.setInputFiles('#shapeInput', file);
  await page.waitForSelector('.shapeCard[data-body-id]', { timeout: 180000 });
  await waitIdle(page, 180000);
  await page.click('.libraryChip'); await page.waitForTimeout(800);
  if (cellMm) await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); i.value = v; window.onCellSizeInput(); }, cellMm);
  await waitIdle(page);
}

const T = {};
T['C1 escaped recipe text'] = async () => {
  const evil = { family: 'wave', field: { symmetry: '<img src=x onerror="window.__pwned=1">', mode: 'solid', iso: 0, modes: [{ n: 1, m: 1, p: 1, A: 1, phi: 0 }] }, geometry: { mode: 'solid' } };
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q(evil)); await waitIdle(p);
    out[lbl] = await p.evaluate(() => ({ pwned: !!window.__pwned, img: document.querySelectorAll('#summaryContent img').length,
      shown: (document.getElementById('summaryContent').innerText || '').includes('<img') }));
    await p.close2();
  }
  return { pass: !out.new.pwned && out.new.img === 0 && out.new.shown, detail: out };
};
T['C2 percent sign in link recipe'] = async () => {
  const r = JSON.parse(JSON.stringify(R['tpms-gyroid-sheet'].recipe)); r.meta = { name: '50% density gyroid', tool: 'tpms' };
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q(r)); await waitIdle(p); out[lbl] = await state(p); await p.close2();
  }
  return { pass: /TPMS/.test(out.new.badge || '') && !out.new.err, detail: { old: out.old.badge + ' | ' + out.old.co, new: out.new.badge + ' | ' + out.new.tri } };
};
T['C3 malformed recipe shows a message'] = async () => {
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q({ family: 'tpms' })); await waitIdle(p, 10000); out[lbl] = (await state(p)).err || '(no message)'; await p.close2();
  }
  return { pass: /surface/.test(out.new), detail: out };
};
T['C5 unknown noise type is rejected'] = async () => {
  const r = { family: 'noise', surface: { type: 'noise', noise_type: 'perlinX', frequency: .3 }, geometry: { mode: 'sheet' } };
  const p = await open(NEW, q(r)); await waitIdle(p, 10000); const s = await state(p); await p.close2();
  return { pass: /Unknown noise type "perlinX"/.test(s.err), detail: s.err };
};
T['B1 hyperuniform shape export on 2 cores'] = async () => {
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q(R['shape-hyperuniform'].recipe), 2);
    await addBody(p, path.join(__dirname, 'fixtures', 'body.stl'), 3);
    out[lbl] = await exportOnce(p, 'draft', lbl === 'old' ? 60000 : 300000); out[lbl].errs = p.errors.filter(e => /not defined/.test(e)).slice(0, 1); await p.close2();
  }
  return { pass: out.new.ok, detail: out };
};
T['B2 warped bundle preview finishes'] = async () => {
  const r = JSON.parse(JSON.stringify(R['bundle-twist'].recipe)); r.geometry.warp_mode = 1; r.geometry.warp_amp = 0.1; r.geometry.warp_freq = 1;
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q(r)); await waitIdle(p, 60000); out[lbl] = await state(p); await p.close2();
  }
  return { pass: !out.new.overlay && /preview/.test(out.new.tri), detail: { old: (out.old.overlay ? 'STUCK: ' : '') + out.old.co, new: out.new.tri } };
};
T['B3 large OBJ body imports'] = async () => {
  const out = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe));
    await p.setInputFiles('#shapeInput', path.join(__dirname, 'fixtures', 'bigsphere.obj'));
    await p.waitForSelector('.shapeCard[data-body-id], .sc-status.err', { timeout: 240000 }).catch(() => {});
    await waitIdle(p, 240000);
    out[lbl] = await p.evaluate(() => ({ body: document.querySelectorAll('.shapeCard[data-body-id]').length, err: (document.querySelector('.sc-status.err') || {}).textContent || '' }));
    await p.close2();
  }
  return { pass: out.new.body === 1 && !out.new.err, detail: out };
};
T['B4 second export while one runs'] = async () => {
  const p = await open(NEW, q(R['shape-tpms'].recipe));
  await addBody(p, path.join(__dirname, 'fixtures', 'body.stl'), 3);
  await p.evaluate(() => window.setQual('low'));
  const dl = p.waitForEvent('download', { timeout: 300000 }).then(() => true).catch(() => false);
  p.evaluate(() => window.triggerExport()).catch(e => p.errors.push(e.message)); await p.waitForTimeout(1500);
  p.evaluate(() => window.triggerExport()).catch(e => p.errors.push(e.message)); await p.waitForTimeout(500);
  const msg = (await state(p)).report;
  const got = await dl; await p.waitForTimeout(500);
  const after = await p.evaluate(() => ({ disabled: document.getElementById('expBtn').disabled, text: document.getElementById('expBtn').textContent }));
  await p.close2();
  return { pass: /already running/.test(msg) && got && !after.disabled, detail: { msg, downloaded: got, after } };
};
T['B6 cancel then export again'] = async () => {
  const p = await open(NEW, q(R['shape-tpms'].recipe));
  await addBody(p, path.join(__dirname, 'fixtures', 'body.stl'), 3);
  await p.evaluate(() => window.setQual('high'));
  p.evaluate(() => window.triggerExport()).catch(e => p.errors.push(e.message)); await p.waitForTimeout(2500);
  const during = (await state(p)).co;
  await p.evaluate(() => window.cancelMesh()); await p.waitForTimeout(1000);
  const afterCancel = await state(p);
  const second = await exportOnce(p, 'draft');
  await p.close2();
  return { pass: !afterCancel.overlay && second.ok, detail: { during, afterCancel: afterCancel.report || '(clean)', second } };
};
T['D4 removing last recipe keeps bodies'] = async () => {
  const p = await open(NEW, q(R['shape-tpms'].recipe));
  await addBody(p, path.join(__dirname, 'fixtures', 'body.stl'), 3);
  await p.click('.libraryChip .lc-x'); await p.waitForTimeout(1500);
  const s = await state(p);
  const solid = await exportOnce(p, 'draft');
  await p.close2();
  return { pass: s.bodies === 1 && s.chips === 0 && s.libRow === 'flex' && /no recipe loaded/i.test(s.summary) && solid.ok, detail: { bodies: s.bodies, libRow: s.libRow, summary: s.summary.slice(0, 40), solidExport: solid } };
};
T['C4 grain kappa 0 = isotropic'] = async () => {
  const base = JSON.parse(JSON.stringify(R['grain-spinodoid'].recipe)); base.field.kappa = 6;
  const k0 = JSON.parse(JSON.stringify(base)); k0.field.kappa = 0;
  const res = {};
  for (const [lbl, root] of [['old', OLD], ['new', NEW]]) {
    for (const [k, r] of [['k6', base], ['k0', k0]]) {
      const p = await open(root, q(r)); await waitIdle(p);
      await p.evaluate(() => window.setQual('draft'));
      const d = p.waitForEvent('download', { timeout: 240000 });
      p.evaluate(() => window.triggerExport()).catch(e => p.errors.push(e.message));
      const dd = await d; const { unzipSync, strFromU8 } = require('fflate'); const z = unzipSync(fs.readFileSync(await dd.path())); const m = strFromU8(z[Object.keys(z).find(x => x.endsWith('.model'))]).replace(/<metadata[^>]*>[^<]*<\/metadata>/g, ''); res[lbl + k] = (m.match(/<triangle /g) || []).length + ':' + require('crypto').createHash('md5').update(m).digest('hex').slice(0, 8); await p.close2();
    }
  }
  return { pass: res.oldk0 === res.oldk6 && res.newk0 !== res.newk6 && res.newk6 === res.oldk6, detail: res };
};

(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(T)) {
    if (FILTER && !name.includes(FILTER)) continue;
    try { const r = await fn(); if (!r.pass) fail++; console.log((r.pass ? 'PASS  ' : 'FAIL  ') + name + '\n      ' + JSON.stringify(r.detail).slice(0, 400)); }
    catch (e) { fail++; console.log('ERROR ' + name + ': ' + e.message.split('\n')[0]); }
  }
  console.log(fail ? fail + ' FAILED' : 'ALL PASS');
})();
