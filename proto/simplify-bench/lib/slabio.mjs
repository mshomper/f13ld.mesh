// proto/simplify-bench/lib/slabio.mjs - compact binary store for raw slab meshes (gzip).
// File = gzip( 'SLB1' | u32 jsonLength | json (padded to 8) | arrays, each padded to 8 bytes ).
// json = { meta, slabs:[ { La, Lb, evals, fieldMs, marchMs, counts:{pos,idx,seamV,seamK,nbrA,nbrB} } ] }
// Arrays per slab in this order: pos f32, idx u32, seamV u32, seamK f64, nbrA f64, nbrB f64.
// Works in Node (zlib) and, for the page, from an already-unzipped ArrayBuffer via parseSlabs().
import fs from 'node:fs';
import zlib from 'node:zlib';

const FIELDS = [['pos', Float32Array], ['idx', Uint32Array], ['seamV', Uint32Array], ['seamK', Float64Array], ['nbrA', Float64Array], ['nbrB', Float64Array]];
const pad8 = n => (n + 7) & ~7;

export function packSlabs(meta, slabs) {
  const infos = slabs.map(s => ({ La: s.La, Lb: s.Lb, evals: s.evals || 0, fieldMs: s.fieldMs || 0, marchMs: s.marchMs || 0,
    counts: Object.fromEntries(FIELDS.map(([k]) => [k, s[k] ? s[k].length : 0])) }));
  const json = Buffer.from(JSON.stringify({ meta, slabs: infos }), 'utf8');
  let size = 8 + pad8(json.length);
  for (const s of slabs) for (const [k, T] of FIELDS) size += pad8((s[k] ? s[k].length : 0) * T.BYTES_PER_ELEMENT);
  const buf = Buffer.alloc(size);
  buf.write('SLB1', 0, 'latin1'); buf.writeUInt32LE(json.length, 4); json.copy(buf, 8);
  let o = 8 + pad8(json.length);
  for (const s of slabs) for (const [k, T] of FIELDS) {
    const a = s[k]; if (!a || !a.length) continue;
    Buffer.from(a.buffer, a.byteOffset, a.byteLength).copy(buf, o); o += pad8(a.byteLength);
  }
  return buf;
}
export function writeSlabs(file, meta, slabs) { fs.writeFileSync(file, zlib.gzipSync(packSlabs(meta, slabs), { level: 9 })); }

// buf: Uint8Array of the unzipped file
export function parseSlabs(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== 'SLB1') throw new Error('not a slab file');
  const jl = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + jl)));
  let o = 8 + pad8(jl);
  const slabs = head.slabs.map(info => {
    const s = { La: info.La, Lb: info.Lb, evals: info.evals, fieldMs: info.fieldMs, marchMs: info.marchMs };
    for (const [k, T] of FIELDS) {
      const n = info.counts[k], bytes = n * T.BYTES_PER_ELEMENT;
      const out = new T(n);
      if (n) new Uint8Array(out.buffer).set(buf.subarray(o, o + bytes));   // copy: keeps alignment
      s[k] = out; o += pad8(bytes);
    }
    return s;
  });
  return { meta: head.meta, slabs };
}
export function readSlabs(file) { const b = zlib.gunzipSync(fs.readFileSync(file)); return parseSlabs(new Uint8Array(b.buffer, b.byteOffset, b.byteLength)); }
