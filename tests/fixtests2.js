// Browser tests for the v0.8.3 leftover-bug fixes and quick wins.
// Usage: node fixtests2.js <oldDir> <newDir> [filter]
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const H = fs.readFileSync(__dirname + '/harness.js', 'utf8');
const NM = path.join(__dirname, 'node_modules');
eval(H.slice(H.indexOf('const MIME'), H.indexOf('async function run')).replace(/\bconst (MIME|mime|ENTRY)\b/g, 'var $1'));
const [OLD, NEW, FILTER] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(__dirname + '/recipes.json', 'utf8'));
const F = f => path.join(__dirname, 'fixtures', f);

async function open(root, query) {
  const site = root === OLD ? 'old.test' : 'new.test';
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8 }));
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
  await page.goto(`http://${site}/index.html${query || ''}`);
  await page.waitForTimeout(1500);
  page.close2 = () => browser.close();
  return page;
}
const q = r => '?r=' + encodeURIComponent(JSON.stringify(r));
async function idle(page, ms = 120000) {
  await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: ms }).catch(() => {});
  await page.waitForTimeout(400);
}
async function addBody(page, file) {
  const n = await page.evaluate(() => document.querySelectorAll('.shapeCard[data-body-id]').length);
  await page.setInputFiles('#shapeInput', file);
  await page.waitForFunction(n => document.querySelectorAll('.shapeCard[data-body-id]').length > n, n, { timeout: 180000 });
  await idle(page, 180000);
}
async function both(fn) { const out = {}; for (const [lbl, root] of [['old', OLD], ['new', NEW]]) out[lbl] = await fn(root); return out; }

const T = {};
T['B7 out-of-order preview keeps the right field range'] = async () => {
  fs.writeFileSync(F('recipeB.json'), JSON.stringify(R['grain-spinodoid'].recipe));
  const out = await both(async root => {
    const p = await open(root, q(R['noise-ridged-half'].recipe)); await idle(p);
    // slow preview of recipe A, then load recipe B while it runs
    p.evaluate(() => triggerPreview('ultra')); await p.waitForTimeout(300);
    await p.setInputFiles('#fileInput', F('recipeB.json'));
    await p.waitForTimeout(500); await idle(p, 180000); await p.waitForTimeout(4000); await idle(p, 180000);
    const got = await p.evaluate(() => ({ fam: currentRecipe.family, min: currentRecipe._previewFieldMin, max: currentRecipe._previewFieldMax }));
    // reference: B's own range from a clean bake at the same quality
    await p.evaluate(() => { delete currentRecipe._previewFieldMin; delete currentRecipe._previewFieldMax; return triggerPreview('low'); });
    await idle(p);
    const ref = await p.evaluate(() => ({ min: currentRecipe._previewFieldMin, max: currentRecipe._previewFieldMax }));
    await p.close2();
    return { fam: got.fam, rangeMatchesOwnBake: Math.abs(got.min - ref.min) < 1e-6 && Math.abs(got.max - ref.max) < 1e-6, got: [got.min, got.max].map(v => +(+v).toFixed(3)), own: [ref.min, ref.max].map(v => +(+v).toFixed(3)) };
  });
  return { pass: out.new.rangeMatchesOwnBake, detail: out };
};
T['B8 open-cube export respects voxel cap'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['noise-simplex-sheet'].recipe)); await idle(p);
    await p.evaluate(() => { const el = document.getElementById('expDomainMm'); el.value = 100; el.dispatchEvent(new Event('input')); window.setQual('low');
      window.__msgs = []; const op = Worker.prototype.postMessage; Worker.prototype.postMessage = function (m, t) { if (m && m.mode === 'export') window.__msgs.push(m.edgeWorld); return op.call(this, m, t); }; });
    const est = await p.evaluate(() => document.getElementById('expEstimate').textContent);
    p.evaluate(() => window.triggerExport()).catch(() => {}); await p.waitForTimeout(1500);
    const edge = await p.evaluate(() => window.__msgs[0]);
    await p.evaluate(() => window.cancelMesh()); await p.close2();
    return { voxels: edge ? Math.round(Math.pow(10 / edge, 3) / 1e6) + 'M' : '?', estimate: est.trim().slice(0, 60) };
  });
  return { pass: parseInt(out.new.voxels) <= 40, detail: out };
};
T['D1 removing a solid active body restores the cube preview'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await addBody(p, F('body.stl'));
    await p.click('.shapeCard[data-body-id] .sc-x'); await p.waitForTimeout(800); await idle(p);
    const r = await p.evaluate(() => ({ solid: rm._solidMode, bodies: document.querySelectorAll('.shapeCard[data-body-id]').length }));
    await p.close2(); return r;
  });
  return { pass: out.new.solid === 0 && out.new.bodies === 0, detail: out };
};
T['D2 adding a body keeps the camera'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await addBody(p, F('body.stl'));
    await p.evaluate(() => { rm.camZoom = 7.5; rm.panX = 0.3; });
    await addBody(p, F('box50n.stl'));
    const r = await p.evaluate(() => ({ zoom: +rm.camZoom.toFixed(2), panX: +rm.panX.toFixed(3), panPerZoom: +(rm.panX / rm.camZoom).toFixed(4) }));
    await p.close2(); return r;
  });
  // framing is kept when pan/zoom stays at 0.3/7.5 = 0.04 (both scale with the wider view)
  return { pass: Math.abs(out.new.panPerZoom - 0.04) < 1e-3, detail: out };
};
T['D3 a new body starts with its own structure settings'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await addBody(p, F('body.stl'));
    await p.evaluate(() => { document.getElementById('sxRotX').value = 30; window.onStructXformInput(); }); await p.waitForTimeout(500);
    await addBody(p, F('box50n.stl'));
    const ids = await p.evaluate(() => [...window.__f13ld_modeA.bodies.keys()]);
    await p.click(`.shapeCard[data-body-id="${ids[1]}"] .sc-name`); await p.waitForTimeout(800); await idle(p);
    const r = await p.evaluate(() => ({ active2: window.__f13ld_modeA.activeBodyId, rotX: structureTransform.rotXDeg, input: document.getElementById('sxRotX').value }));
    await p.close2(); return { rotX: r.rotX, input: r.input };
  });
  return { pass: out.new.rotX === 0 && +out.new.input === 0, detail: out };
};
T['D5 two body files dropped back-to-back both import'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await p.setInputFiles('#shapeInput', F('body.stl'));
    await p.waitForTimeout(150);
    await p.setInputFiles('#shapeInput', F('box50n.stl'));
    await p.waitForTimeout(3000);
    await p.waitForFunction(() => document.querySelectorAll('.shapeCard[data-body-id]').length >= 2, null, { timeout: 60000 }).catch(() => {});
    await idle(p);
    const r = await p.evaluate(() => ({ bodies: window.__f13ld_modeA.bodies.size, cards: document.querySelectorAll('.shapeCard[data-body-id]').length, pendingErr: !!document.querySelector('.sc-status.err') }));
    r.errors = p.errors.slice(0, 2); await p.close2(); return r;
  });
  return { pass: out.new.bodies === 2 && out.new.cards === 2 && !out.new.errors.length, detail: out };
};
T['D6 structure edit keeps the selected preview quality'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['noise-ridged-half'].recipe)); await idle(p);
    await addBody(p, F('body.stl'));
    await p.click('.libraryChip'); await idle(p);
    await p.click('#btnMed'); await idle(p);
    await p.evaluate(() => { document.getElementById('sxRotZ').value = 20; window.onStructXformInput(); });
    await p.waitForTimeout(800); await idle(p);
    const r = await p.evaluate(() => rm._quality); await p.close2(); return { quality: String(r) };
  });
  return { pass: out.new.quality === 'med', detail: out };
};
T['QW domain size survives a panel re-render'] = async () => {
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await p.fill('#expDomainMm', '25'); await p.dispatchEvent('#expDomainMm', 'input');
    await p.evaluate(() => reloadActiveRecipeIntoPreview()); await idle(p);
    const v = await p.evaluate(() => document.getElementById('expDomainMm').value); await p.close2(); return { domain: v };
  });
  return { pass: out.new.domain === '25', detail: out };
};
T['QW solid export: report shown, safe filename'] = async () => {
  fs.copyFileSync(F('box50n.stl'), F('my part #1 (v2).stl'));
  const out = await both(async root => {
    const p = await open(root, q(R['tpms-gyroid-sheet'].recipe)); await idle(p);
    await addBody(p, F('my part #1 (v2).stl'));
    const dl = p.waitForEvent('download', { timeout: 60000 });
    p.evaluate(() => window.triggerExport()).catch(() => {});
    const d = await dl; await p.waitForTimeout(500);
    const rep = await p.evaluate(() => document.getElementById('expReport').textContent.trim());
    await p.close2(); return { file: d.suggestedFilename().replace(/_\d{8}-\d{4}/, '_<time>'), report: rep.slice(0, 60) };
  });
  return { pass: /^my_part_1_v2_solid_/.test(out.new.file) && /solid body/.test(out.new.report), detail: out };
};

(async () => {
  let fail = 0;
  for (const [name, fn] of Object.entries(T)) {
    if (FILTER && !name.includes(FILTER)) continue;
    try { const r = await fn(); if (!r.pass) fail++; console.log((r.pass ? 'PASS  ' : 'FAIL  ') + name + '\n      ' + JSON.stringify(r.detail).slice(0, 420)); }
    catch (e) { fail++; console.log('ERROR ' + name + ': ' + e.message.split('\n')[0]); }
  }
  console.log(fail ? fail + ' FAILED' : 'ALL PASS');
})();
