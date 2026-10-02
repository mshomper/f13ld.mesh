/* ============================================================
   F13LD.mesh · 62-threemf.js
   Minimal 3MF writer.
   ============================================================ */
'use strict';

async function buildMinimal3MF(vertProps,triVerts,scale){
  const nV=vertProps.length/3,nT=triVerts.length/3;
  // ── Pre-flight validation ──────────────────────────────────────────────
  // A single NaN or Infinity in positions becomes x="NaN" in the XML, which
  // triggers Lib3MF Error 5 ("Cannot convert to UTF16") in nTopology and any
  // other lib3mf-based importer. Out-of-range indices (past vertex count)
  // cause equally catastrophic downstream failures. Scan the whole mesh once
  // up front; fail loudly with a diagnostic rather than writing a corrupt
  // 3MF that only reveals the problem on re-import.
  let badPos=0,badIdx=0;
  for(let i=0;i<vertProps.length;i++){
    if(!Number.isFinite(vertProps[i])){badPos++;}
  }
  for(let i=0;i<triVerts.length;i++){
    if(triVerts[i]>=nV||triVerts[i]<0){badIdx++;}
  }
  if(badPos>0){
    throw new Error('Export aborted: '+badPos+' non-finite position value(s) detected (NaN or Infinity). Mesh is invalid.');
  }
  if(badIdx>0){
    throw new Error('Export aborted: '+badIdx+' out-of-range triangle index value(s) detected (vertex count = '+nV+'). Mesh is invalid.');
  }
  // ── Chunked byte serialization (v0.5.1-rc4.0c) ──────────────────────────
  // Previously vx/tx accumulated the entire mesh as two giant JS strings, then
  // encoded once. V8 caps strings at ~536M chars; a dense near-floor export
  // (millions of verts+tris) overruns that and throws "Invalid string length".
  // Instead we encode in small batches: build ~CHUNK elements into a short
  // string, encode to bytes, collect the byte arrays, and concatenate at the
  // end. Each intermediate string stays tiny; the final Uint8Array has no such
  // limit. Output XML is byte-identical to the old path — nTop pipeline
  // unaffected. Also fixes the same latent limit on the solid-body fast path
  // and any future export-all per-body serialization.
  const enc=new TextEncoder();
  const CHUNK=16384; // elements per intermediate string (keeps each well under cap)
  const headBytes=enc.encode(
    '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" '+
    'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>'+
    '<object id="1" type="model"><mesh><vertices>'
  );
  const midBytes=enc.encode('</vertices><triangles>');
  const tailBytes=enc.encode('</triangles></mesh></object></resources><build><item objectid="1"/></build></model>');
  const parts=[headBytes];
  let buf='';
  for(let i=0;i<nV;i++){
    buf+=`<vertex x="${(vertProps[i*3]*scale).toFixed(6)}" y="${(vertProps[i*3+1]*scale).toFixed(6)}" z="${(vertProps[i*3+2]*scale).toFixed(6)}"/>`;
    if((i&(CHUNK-1))===(CHUNK-1)){ parts.push(enc.encode(buf)); buf=''; }
  }
  if(buf){ parts.push(enc.encode(buf)); buf=''; }
  parts.push(midBytes);
  // v0.8.3: the 3MF core spec requires three distinct vertex indices per
  // triangle; zero-area triangles with a repeated index are skipped.
  let degenerate=0;
  for(let i=0;i<nT;i++){
    const a=triVerts[i*3], b=triVerts[i*3+1], c=triVerts[i*3+2];
    if(a===b||b===c||a===c){ degenerate++; continue; }
    buf+=`<triangle v1="${a}" v2="${b}" v3="${c}"/>`;
    if((i&(CHUNK-1))===(CHUNK-1)){ parts.push(enc.encode(buf)); buf=''; }
  }
  if(degenerate) console.warn('[3MF] skipped '+degenerate+' degenerate triangle(s)');
  if(buf){ parts.push(enc.encode(buf)); buf=''; }
  parts.push(tailBytes);
  // Concatenate all byte chunks into one model buffer.
  let modelLen=0; for(const p of parts) modelLen+=p.length;
  const modelBytes=new Uint8Array(modelLen);
  let off=0; for(const p of parts){ modelBytes.set(p,off); off+=p.length; }
  const ct=`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const rels=`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  const zipped=fflate.zipSync({'[Content_Types].xml':enc.encode(ct),'_rels/.rels':enc.encode(rels),'3D/3dmodel.model':modelBytes});
  return new Blob([zipped],{type:'model/3mf'});
}

// v0.8.3: one download path for every export. Revoking the object URL right
// after click() can cancel the download in Firefox/Safari, so revoke later.
function downloadBlob(blob, filename){
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 10000);
}
// Filename-safe text from recipe strings (preset names, file names).
function safeFilePart(v){
  return String(v==null?'':v).replace(/[^A-Za-z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,60)||'x';
}
