// Side-by-side harness: original single-file F13LD.mesh vs split v0.8.0.
// Usage: node harness.js <origDir> <newDir> [filter]
// Both sites are served from disk under fake origins; CDN URLs are fulfilled
// from locally installed npm packages at the exact pinned versions.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { unzipSync, strFromU8 } = require('fflate');
const NM = path.join(__dirname, 'node_modules');
const [ORIG, NEW, FILTER] = process.argv.slice(2);

const MIME = { js: 'application/javascript', mjs: 'application/javascript', html: 'text/html',
  css: 'text/css', wasm: 'application/wasm', json: 'application/json', stl: 'model/stl' };
const mime = p => MIME[p.split('.').pop()] || 'application/octet-stream';
const ENTRY = { 'fflate': 'esm/browser.js', 'meshoptimizer': 'index.js', 'manifold-3d': 'manifold.js' };

function cdn(url) {
  const u = new URL(url);
  if (u.host === 'esm.sh') {
    if (u.pathname.startsWith('/three@0.158.0'))
      return { body: fs.readFileSync(NM + '/three/build/three.module.js'), type: MIME.js };
    if (u.pathname.startsWith('/three-mesh-bvh@0.7.8')) {
      let s = fs.readFileSync(NM + '/three-mesh-bvh/build/index.module.js', 'utf8');
      s = s.replace(/from\s*['"]three['"]/g, "from 'https://esm.sh/three@0.158.0'");
      return { body: s, type: MIME.js };
    }
  }
  if (u.host === 'cdn.jsdelivr.net') {
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (m) {
      const pkg = m[1]; let rest = m[2];
      if (rest === '+esm') rest = ENTRY[pkg];
      const f = path.join(NM, pkg, rest);
      if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: mime(f) };
    }
  }
  return null;
}

// UI-ADAPTERS-BEGIN
// The v0.12.0 UI (left rail, dock, Configure drawer) and the older bottom-strip
// UI (v0.11.x and before) are both driven through these helpers, so one test
// run can open either build. The page decides: #railParts exists => rail UI.
// The other test files eval this block (or the whole top of this file) too.
var UI_BODY = '.rl-part[data-body-id], .shapeCard[data-body-id]';   // one row / card per body
var UI_RECIPE = '.rl-rc[data-recipe-id], .libraryChip';              // one card / chip per recipe
var UI_ERR = '.rl-pending.err, .sc-status.err';                      // a failed import
async function uiIsRail(page) { return page.evaluate(() => !!document.getElementById('railParts')); }
async function uiBodyCount(page) { return page.evaluate(s => document.querySelectorAll(s).length, UI_BODY); }
// Give the first recipe to the active body (old UI: click the first library chip;
// rail UI: a recipe card only opens a popover, so use the function behind its
// "Use on <part>" button).
async function uiAssignRecipe(page) {
  if (await uiIsRail(page)) await page.evaluate(() => assignRecipeToBody(activeBodyId, recipeOrder[0]));
  else await page.click('.libraryChip');
}
// Remove the first recipe (old: chip x; rail: card x).
async function uiRemoveRecipe(page) {
  await page.click((await uiIsRail(page)) ? '.rl-rc .rl-rx' : '.libraryChip .lc-x');
}
// Make a body the active one by clicking its card / part row.
async function uiSelectBody(page, id) {
  await page.click((await uiIsRail(page)) ? `.rl-part[data-body-id="${id}"] .rl-nm` : `.shapeCard[data-body-id="${id}"] .sc-name`);
}
// Remove the first body. The rail has no remove button on a part row, so the
// rail branch calls the function the old card's x button called.
async function uiRemoveBody(page) {
  if (await uiIsRail(page)) await page.evaluate(() => window.clearImportedShape(activeBodyId));
  else await page.click('.shapeCard[data-body-id] .sc-x');
}
// Open the Configure drawer on a tab ('prep' | 'exp'); no-op on the old UI,
// where the same controls were always on screen.
async function uiOpenDrawer(page, tab) {
  if (!(await uiIsRail(page))) return;
  if (!(await page.evaluate(() => document.getElementById('drawer').classList.contains('open')))) await page.click('#cfgBtn');
  if (tab) await page.click(`#drawer .dr-tab[data-p="${tab}"]`);
}
// Cell size of the active body. Rail: type in the editor's number box (the same
// path as the slider); falls back to the hidden legacy input when the editor has
// no cell box (solid body).
async function uiSetCell(page, mm) {
  if (await uiIsRail(page)) {
    const sel = '#railEditor .rl-num[data-k="cell"]';
    if (await page.$(sel)) { await page.fill(sel, String(mm)); await page.waitForTimeout(500); return; }
  }
  await page.evaluate(v => { const i = document.getElementById('shapeCellSizeMm'); if (i) { i.value = v; window.onCellSizeInput && window.onCellSizeInput(); } }, mm);
}
// Structure rotation / shift / wall offset of the active body, key as in
// structureTransform ('rotXDeg', 'rotYDeg', 'rotZDeg', 'spatialOffsetMmX' …, 'isoOffsetMm').
// Same fallback as uiSetCell. Both paths end in onStructXformInput.
var UI_XFORM_INPUT = { rotXDeg: 'sxRotX', rotYDeg: 'sxRotY', rotZDeg: 'sxRotZ', spatialOffsetMmX: 'sxOffX', spatialOffsetMmY: 'sxOffY', spatialOffsetMmZ: 'sxOffZ', isoOffsetMm: 'sxIso' };
async function uiSetXform(page, key, v) {
  if (await uiIsRail(page)) {
    const sel = `#railEditor .rl-num[data-k="${key}"]`;
    if (await page.$(sel)) { await page.fill(sel, String(v)); await page.waitForTimeout(300); return; }
  }
  await page.evaluate(([id, val]) => { document.getElementById(id).value = val; window.onStructXformInput(); }, [UI_XFORM_INPUT[key], v]);
}
// UI-ADAPTERS-END

async function run(site, root, recipe, opts) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const misses = [];
  await ctx.route('**/*', async route => {
    const url = route.request().url(); const u = new URL(url);
    if (u.host === site) {
      let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
      const f = path.join(root, p);
      if (fs.existsSync(f)) return route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) });
      misses.push(url); return route.fulfill({ status: 404, body: '' });
    }
    if (u.host === 'fonts.googleapis.com' || u.host === 'fonts.gstatic.com') return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(url);
    if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    misses.push(url); return route.abort();
  });
  if (opts.cores) await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), opts.cores);
  const page = await ctx.newPage();
  const errors = [], logs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { const t = m.text(); if (m.type() === 'error') errors.push('console: ' + t); else logs.push(t); });
  page.on('worker', w => w.on('console', m => { if (m.type() === 'error') errors.push('worker: ' + m.text()); }));
  const q = recipe ? '?r=' + encodeURIComponent(JSON.stringify(recipe)) : '';
  await page.goto(`http://${site}/index.html${q}`);
  await page.waitForTimeout(1500);
  const result = { errors, misses, logs };
  if (opts.shape) {
    await page.setInputFiles('#shapeInput', opts.shape);
    await page.waitForSelector(UI_BODY, { timeout: 120000 });
    await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden'), null, { timeout: 120000 }).catch(() => {});
    await page.waitForTimeout(800);
    await uiAssignRecipe(page);                // assign recipe to the (solid-by-default) body
    await page.waitForTimeout(800);
    result.assigned = await page.evaluate(() => { const m = window.__f13ld_modeA; return m ? [...m.assignments.values()].join(',') : '?'; });
  }
  if (opts.cellMm != null) await uiSetCell(page, opts.cellMm);
  // let the preview settle
  await page.waitForFunction(() => document.getElementById('computeOverlay') ? document.getElementById('computeOverlay').classList.contains('hidden') : true, null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1000);
  result.preview = await page.evaluate(() => ({
    tri: (document.getElementById('triPill') || {}).textContent || '',
    err: (document.getElementById('errorBox') || {}).textContent || '',
    summary: ((document.getElementById('recipeView') || {}).innerText || '').slice(0, 200),
  }));
  if (opts.export !== false) {
    await page.evaluate(q => window.setQual && window.setQual(q), process.env.QUAL || 'draft');
    const dl = page.waitForEvent('download', { timeout: 540000 });
    page.evaluate(() => window.triggerExport()).catch(e => errors.push('triggerExport: ' + String(e.message).split('\n')[0]));
    try {
      const err = page.waitForSelector('.exp-err', { timeout: 540000 }).then(async h => { throw new Error('export error shown: ' + (await h.textContent())); });
      const d = await Promise.race([dl, err]); const p = await d.path();
      const z = unzipSync(fs.readFileSync(p));
      const model = Object.keys(z).find(k => k.endsWith('.model'));
      let xml = strFromU8(z[model]);
      xml = xml.replace(/<metadata[^>]*>[^<]*<\/metadata>/g, '');   // drop dates/names
      result.file = d.suggestedFilename().replace(/_\d{4}-?\d\d-?\d\d.*$/, '');
      result.model = xml;
      result.tris = (xml.match(/<triangle /g) || []).length;
      result.verts = (xml.match(/<vertex /g) || []).length;
      result.report = await page.evaluate(() => ((document.querySelector('.exp-report') || {}).innerText || '').replace(/\s+/g, ' '));
    } catch (e) {
      result.exportErr = String(e.message || e).slice(0, 200);
      result.box = await page.evaluate(() => (document.getElementById('errorBox') || {}).textContent || '');
    }
  }
  await browser.close();
  return result;
}

const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'));
(async () => {
  let fail = 0;
  for (const [name, spec] of Object.entries(R)) {
    if (FILTER && !name.includes(FILTER)) continue;
    const opts = { cores: spec.cores || (process.env.CORES ? +process.env.CORES : undefined), shape: spec.shape && path.join(__dirname, 'fixtures', spec.shape), cellMm: spec.cellMm, export: spec.export };
    const a = await run('orig.test', ORIG, spec.recipe, opts);
    const b = await run('new.test', NEW, spec.recipe, opts);
    const same = a.model !== undefined && a.model === b.model;
    const ok = same && !b.errors.length && !b.misses.length && a.errors.length === b.errors.length;
    if (!ok) fail++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} tris ${a.tris}/${b.tris}  verts ${a.verts}/${b.verts}  identical=${same}`);
    for (const [lbl, r] of [['orig', a], ['new', b]]) {
      if (r.errors.length) console.log(`   ${lbl} errors:`, r.errors.slice(0, 4));
      if (r.misses.length) console.log(`   ${lbl} unserved:`, r.misses.slice(0, 4));
      if (r.exportErr) console.log(`   ${lbl} export:`, r.exportErr, r.box);
      if (r.preview && r.preview.err) console.log(`   ${lbl} errorBox:`, r.preview.err);
      if (process.env.VERBOSE) { console.log(`   ${lbl} report:`, r.report || ''); for (const l of r.logs) if (l.includes('[export][field]')) console.log(`   ${lbl}`, l); }
    }
  }
  console.log(fail ? `${fail} FAILED` : 'ALL PASS');
})();
