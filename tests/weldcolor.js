// Weld colour, in the browser: a gyroid weld of parts A + B and a solid part C.
// Selecting the weld shows a 17-button colour row (16 swatches + reset);
// picking a swatch sets the weld colour, every member's part-list swatch and
// the weld preview's base colour follow; a member's part editor shows the
// "Shown in Weld X's colour" hint instead of swatches; with C selected the
// members' shells take the weld colour; reset restores the default; a part that
// leaves the weld gets its own colour row back.
//
//   node weldcolor.js <build>     (CORES=n, default 6)
const fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const NM = path.join(__dirname, 'node_modules');
const _H = fs.readFileSync(path.join(__dirname, 'harness.js'), 'utf8');
eval(_H.slice(_H.indexOf('// UI-ADAPTERS-BEGIN'), _H.indexOf('// UI-ADAPTERS-END')));
const [BUILD] = process.argv.slice(2);
const CORES = +(process.env.CORES || 6);
const MIME = { js: 'application/javascript', mjs: 'application/javascript', html: 'text/html', css: 'text/css', wasm: 'application/wasm', json: 'application/json' };
const mime = p => MIME[p.split('.').pop()] || 'application/octet-stream';
const ENTRY = { 'fflate': 'esm/browser.js', 'meshoptimizer': 'index.js', 'manifold-3d': 'manifold.js' };
function cdn(url) {
  const u = new URL(url);
  if (u.host === 'esm.sh') {
    if (u.pathname.startsWith('/three@0.158.0')) return { body: fs.readFileSync(NM + '/three/build/three.module.js'), type: MIME.js };
    if (u.pathname.startsWith('/three-mesh-bvh@0.7.8')) {
      let s = fs.readFileSync(NM + '/three-mesh-bvh/build/index.module.js', 'utf8');
      return { body: s.replace(/from\s*['"]three['"]/g, "from 'https://esm.sh/three@0.158.0'"), type: MIME.js };
    }
  }
  if (u.host === 'cdn.jsdelivr.net') {
    const m = u.pathname.match(/^\/npm\/((?:@[^/]+\/)?[^@/]+)@[^/]+\/(.*)$/);
    if (m) { let rest = m[2]; if (rest === '+esm') rest = ENTRY[m[1]]; const f = path.join(NM, m[1], rest); if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: mime(f) }; }
  }
  return null;
}
function boxStl(file, lo, hi) {
  const P = []; for (let c = 0; c < 8; c++) P.push([c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const T = [[0,2,1],[1,2,3],[4,5,6],[5,7,6],[0,1,4],[1,5,4],[2,6,3],[3,6,7],[0,4,2],[2,4,6],[1,3,5],[3,7,5]];
  let s = 'solid box\n';
  for (const t of T) { s += ' facet normal 0 0 0\n  outer loop\n'; for (const i of t) s += `   vertex ${P[i].join(' ')}\n`; s += '  endloop\n endfacet\n'; }
  fs.writeFileSync(file, s + 'endsolid box\n');
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wcolor-'));
const STL = { A: path.join(TMP, 'a.stl'), B: path.join(TMP, 'b.stl'), C: path.join(TMP, 'c.stl') };
boxStl(STL.A, [0, 0, 0], [20, 16, 10]); boxStl(STL.B, [18, 0, 0], [38, 16, 10]); boxStl(STL.C, [50, 0, 0], [64, 12, 10]);
const RECIPE = JSON.parse(fs.readFileSync(path.join(__dirname, 'recipes.json'), 'utf8'))['tpms-gyroid-sheet'].recipe;

const sel = (page, id) => page.evaluate(id => (window.railSelectPart || window.switchActiveBody)(id), id);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 700 } });
  const site = 'build.test';
  await ctx.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host === site) { let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(BUILD, p);
      return fs.existsSync(f) ? route.fulfill({ body: fs.readFileSync(f), contentType: mime(f) }) : route.fulfill({ status: 404, body: '' }); }
    if (u.host.startsWith('fonts.')) return route.fulfill({ body: '', contentType: 'text/css' });
    const hit = cdn(route.request().url()); if (hit) return route.fulfill({ body: hit.body, contentType: hit.type, headers: { 'access-control-allow-origin': '*' } });
    return route.abort();
  });
  await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), CORES);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('worker', w => w.on('console', m => { if (m.type() === 'error') errors.push('worker: ' + m.text()); }));
  await page.goto(`http://${site}/index.html?r=` + encodeURIComponent(JSON.stringify(RECIPE)));
  await page.waitForTimeout(1500);
  const idle = async () => { await page.waitForTimeout(450); await page.waitForFunction(() => document.getElementById('computeOverlay').classList.contains('hidden') && !(window.rm && rm.isHeld && rm.isHeld()) && window.F13LD_previewBake.workers().jobs === 0, null, { timeout: 300000 }).catch(() => {}); await page.waitForTimeout(400); };
  for (const k of ['A', 'B', 'C']) {
    const n = await uiBodyCount(page);
    await page.setInputFiles('#shapeInput', STL[k]);
    await page.waitForFunction(([n, S]) => document.querySelectorAll(S).length > n, [n, UI_BODY], { timeout: 180000 });
    await idle();
  }
  const ids = await page.evaluate(() => window.F13LD_weld.bodyIds());
  for (const i of [0, 1]) { await sel(page, ids[i]); await idle(); await uiAssignRecipe(page); await idle(); }
  await sel(page, ids[0]); await idle();
  await page.evaluate(([a, b]) => window.F13LD_weld.group([a, b], 0.6), [ids[0], ids[1]]); await idle();
  let fails = 0;
  const check = (ok, label, extra) => { console.log((ok ? 'ok    ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!ok) fails++; };
  const [A, B, C] = ids;
  const gid = await page.evaluate(([a]) => bodyGroup.get(a), [A]);
  const rgb = h => 'rgb(' + [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
  const nearC = (c, h) => !!c && [1, 3, 5].every((i, k) => Math.abs(c[k] - parseInt(h.slice(i, i + 2), 16) / 255) < 0.01);
  const ui = () => page.evaluate(([a, b, c, gid]) => {
    const ed = document.getElementById('railEditor');
    const sw = id => { const e = document.querySelector('.rl-part[data-body-id="' + id + '"] .rl-fsw'); return e ? getComputedStyle(e).backgroundColor : null; };
    // v0.14.0: each part's colour as drawn, from the scene member table.
    const gm = {}; const scd = F13LD_scene.scene(); if (scd) for (const m of scd.members) if (m.bodyId) gm[m.bodyId] = Array.from(m.color || []);
    const g = weldGroups.get(gid);
    return { wc: g ? weldGroupColor(gid) : null, hex: g ? g.colorHex : undefined, letter: g ? weldGroupLetter(gid) : '',
      nW: ed.querySelectorAll('[data-act="wcolor"]').length, nP: ed.querySelectorAll('[data-act="color"]').length,
      onHex: (ed.querySelector('[data-act="wcolor"].on, [data-act="color"].on') || {}).dataset?.hex,
      text: ed.innerText, goWeld: ed.querySelectorAll('[data-act="goWeld"]').length,
      swA: sw(a), swB: sw(b), swC: sw(c), tile: (() => { const e = document.querySelector('.rl-whead[data-gid="' + gid + '"] .rl-wtile i'); return e ? getComputedStyle(e).backgroundColor : null; })(),
      base: gm[a] || null, asm: true, ghosts: gm, selW: railSelWeld };
  }, [A, B, C, gid]);

  const def = await page.evaluate(gid => weldGroupColor(gid), gid);
  check(/^#[0-9a-f]{6}$/i.test(def) && (await page.evaluate(gid => weldGroups.get(gid).colorHex, gid)) === null, 'new weld: colorHex null, default colour ' + def);
  await page.evaluate(gid => railSelectWeld(gid), gid); await idle();
  let s = await ui();
  check(s.nW === 17 && s.nP === 0, 'weld editor: 17 colour buttons', s.nW + ' / ' + s.nP);
  check(s.onHex === '', 'weld editor: reset marked when no colour set', String(s.onHex));
  check(!/[←-⯿\u{1F300}-\u{1FAFF}]/u.test(s.text), 'weld editor: no glyph icons');

  const PICK = '#ef4444';
  await page.click('#railEditor [data-act="wcolor"][data-hex="' + PICK + '"]'); await idle();
  s = await ui();
  check(s.wc === PICK && s.hex === PICK, 'swatch sets the weld colour', s.wc);
  check(s.nW === 17 && s.onHex === PICK, 'weld editor redraws with the picked swatch on', String(s.onHex));
  check(s.swA === rgb(PICK) && s.swB === rgb(PICK), 'member part-list swatches show the weld colour', s.swA + ' ' + s.swB);
  check(s.tile === rgb(PICK), 'weld card tile shows the weld colour', s.tile);
  check(s.swC !== rgb(PICK), 'loose part C keeps its own colour', s.swC);
  check(s.asm && nearC(s.base, PICK), 'weld preview base colour follows', JSON.stringify(s.base));

  await sel(page, A); await idle();
  s = await ui();
  check(s.nW === 0 && s.nP === 0, 'member part editor: no swatches', s.nW + ' / ' + s.nP);
  check(s.text.includes("Shown in Weld " + s.letter + "'s colour"), 'member part editor: "Shown in Weld ' + s.letter + '\'s colour" hint');
  check(s.goWeld === 2, 'member part editor: Edit weld button on the colour row', String(s.goWeld));
  check(s.asm && nearC(s.base, PICK), 'member selected: weld still drawn in its colour', JSON.stringify(s.base));
  await page.click('#railEditor .rl-erow:has(.rl-fsw-dot) [data-act="goWeld"]'); await idle();
  s = await ui();
  check(s.selW === gid && s.nW === 17, 'Edit weld opens the weld editor');

  await sel(page, C); await idle();
  s = await ui();
  check(nearC(s.ghosts[A], PICK) && nearC(s.ghosts[B], PICK), 'C selected: member shells in the weld colour', JSON.stringify([s.ghosts[A], s.ghosts[B]]));

  await page.evaluate(gid => railSelectWeld(gid), gid); await idle();
  await page.click('#railEditor [data-act="wcolor"][data-hex=""]'); await idle();
  s = await ui();
  check(s.wc === def && s.hex === null, 'reset restores the default colour', s.wc);
  check(s.swA === rgb(def) && s.swB === rgb(def) && s.onHex === '', 'reset: swatches back to default, reset marked');
  check(s.asm && nearC(s.base, def), 'reset: weld preview base colour back to default', JSON.stringify(s.base));

  // A member's own colour is kept and returns when it leaves the weld.
  const OWN = '#3b82f6';
  await page.evaluate(([a, h]) => setBodyColor(a, h), [A, OWN]); await idle();
  s = await ui();
  check(s.swA === rgb(def), 'own colour of a member is overridden by the weld', s.swA);
  await page.evaluate(a => { railSelectPart(a); weldDetach(a); }, A); await idle();
  s = await ui();
  check(s.nP === 17 && s.onHex === OWN && s.swA === rgb(OWN), 'left the weld: own colour row and colour return', s.nP + ' ' + s.onHex + ' ' + s.swA);

  check(errors.length === 0, 'no console errors', errors.slice(0, 4).join(' | '));
  await browser.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
