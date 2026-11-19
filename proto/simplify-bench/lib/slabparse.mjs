// proto/simplify-bench/lib/slabparse.mjs - read the raw slab file format (see slabio.mjs) from an unzipped Uint8Array.
// Browser-safe: no node imports. Also parses a dropped STL / OBJ into one slab with no seam.
export const FIELDS = [['pos', Float32Array], ['idx', Uint32Array], ['seamV', Uint32Array], ['seamK', Float64Array], ['nbrA', Float64Array], ['nbrB', Float64Array]];
export const pad8 = n => (n + 7) & ~7;

export function parseSlabs(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'SLB1') throw new Error('not a slab file');
  const jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + jl)));
  let o = 8 + pad8(jl);
  const slabs = head.slabs.map(info => {
    const s = { La: info.La, Lb: info.Lb, evals: info.evals, fieldMs: info.fieldMs, marchMs: info.marchMs };
    for (const [k, T] of FIELDS) {
      const n = info.counts[k], bytes = n * T.BYTES_PER_ELEMENT, out = new T(n);
      if (n) new Uint8Array(out.buffer).set(buf.subarray(o, o + bytes));   // copy: keeps alignment
      s[k] = out; o += pad8(bytes);
    }
    return s;
  });
  return { meta: head.meta, slabs };
}

// Weld vertices by exact position (STL has none shared); returns {pos, idx}
function weld(tri) {
  const map = new Map(), pos = [], idx = new Uint32Array(tri.length / 3);
  for (let i = 0; i < tri.length; i += 3) {
    const k = tri[i] + ',' + tri[i + 1] + ',' + tri[i + 2]; let id = map.get(k);
    if (id === undefined) { id = pos.length / 3; map.set(k, id); pos.push(tri[i], tri[i + 1], tri[i + 2]); }
    idx[i / 3] = id;
  }
  return { pos: Float32Array.from(pos), idx };
}
// buf: Uint8Array of an STL (binary or ASCII) or OBJ file. Returns one slab (no seam) and meta guessed from its size.
export function parseMeshFile(buf, name = '', edgeMm = 0.1) {
  const lower = name.toLowerCase(); let pos, idx;
  const text = () => new TextDecoder().decode(buf);
  if (lower.endsWith('.obj')) {
    const v = [], f = [];
    for (const line of text().split(/\r?\n/)) {
      const p = line.trim().split(/\s+/);
      if (p[0] === 'v') v.push(+p[1], +p[2], +p[3]);
      else if (p[0] === 'f') { const ids = p.slice(1).map(x => parseInt(x, 10) - 1); for (let i = 1; i + 1 < ids.length; i++) f.push(ids[0], ids[i], ids[i + 1]); }
    }
    const w = weld(Float32Array.from(f.flatMap(i => [v[3 * i], v[3 * i + 1], v[3 * i + 2]]))); pos = w.pos; idx = w.idx;
  } else {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), n = buf.byteLength >= 84 ? dv.getUint32(80, true) : -1;
    let tri;
    if (n >= 0 && 84 + 50 * n === buf.byteLength) { tri = new Float32Array(n * 9); for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) tri[9 * t + k] = dv.getFloat32(84 + 50 * t + 12 + 4 * k, true); }
    else { const a = []; for (const m of text().matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)) a.push(+m[1], +m[2], +m[3]); tri = Float32Array.from(a); }
    const w = weld(tri); pos = w.pos; idx = w.idx;
  }
  if (!idx.length) throw new Error('no triangles found');
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], pos[i + k]); mx[k] = Math.max(mx[k], pos[i + k]); }
  const edge = edgeMm;
  const meta = { case: name, family: 'dropped mesh', qual: 'file', edgeWorld: edge, edgeMm: edge, domainMm: 10, tol: 0.15 * edge, grid: [0, 0, 0], gridMin: mn, gridMax: mx, slabs: 1, workersAssumed: 1, built: 'dropped file (one slab, no seam)', rawTris: idx.length / 3 };
  return { meta, slabs: [{ La: 0, Lb: 1, pos, idx, seamV: new Uint32Array(0), seamK: new Float64Array(0), nbrA: new Float64Array(0), nbrB: new Float64Array(0), evals: 0, fieldMs: 0, marchMs: 0 }] };
}
