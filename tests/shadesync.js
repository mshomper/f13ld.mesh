// Shared-block sync check (dev only).
// Usage: node shadesync.js <file-or-folder> [<file-or-folder> …]
// Every F13LD tool carries byte-identical copies of two blocks:
//   F13LD-SHADE  (GLSL viewer shading)   — all tools, incl. this repo's 19-f13-shade.js
//   F13LD-VIEW   (◐ view menu JS)         — the single-file tools and F13LD.lab
// Pass this repo plus the other tool checkouts (folders are scanned for
// .js/.html files); the script reports which copies differ from the first one.
// Example: node shadesync.js .. ../../f13ld.tpms ../../f13ld.noise ../../f13ld.lab
const fs = require('fs'), path = require('path');
const BLOCKS = [
  { name: 'F13LD-SHADE', start: '// ==== F13LD-SHADE v', end: '// ==== /F13LD-SHADE ====' },
  { name: 'F13LD-VIEW',  start: '// ==== F13LD-VIEW v',  end: '// ==== /F13LD-VIEW ====' },
];
function files(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return [p];
  return fs.readdirSync(p).flatMap(n => {
    if (n === 'node_modules' || n.startsWith('.')) return [];
    const q = path.join(p, n);
    return fs.statSync(q).isDirectory() ? files(q) : (/\.(js|html)$/.test(n) ? [q] : []);
  });
}
const all = process.argv.slice(2).flatMap(files).filter(f => !f.endsWith('shadesync.js'));
let bad = 0;
for (const b of BLOCKS) {
  const found = [];
  for (const f of all) {
    const t = fs.readFileSync(f, 'utf8');
    let i = t.indexOf(b.start);
    while (i >= 0) {
      const j = t.indexOf(b.end, i);
      if (j < 0) { console.log(`${b.name}: unterminated block in ${f}`); bad++; break; }
      found.push({ f, text: t.slice(i, j + b.end.length) });
      i = t.indexOf(b.start, j);
    }
  }
  if (!found.length) { console.log(`${b.name}: no copies found`); continue; }
  const ref = found[0].text;
  for (const c of found) {
    const same = c.text === ref;
    if (!same) bad++;
    console.log(`${same ? 'same ' : 'DIFF '} ${b.name}  ${c.f}`);
  }
}
console.log(bad ? `${bad} problem(s)` : 'all copies identical');
process.exit(bad ? 1 : 0);
