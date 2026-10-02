/* ============================================================
   F13LD.mesh · 50-recipe-router.js
   routeRecipe — JSON recipe → {family, json} detection.
   ============================================================ */
'use strict';

// ── Recipe router ─────────────────────────────────────────────────────────
function routeRecipe(json){
  // v0.5.0-rc23: F13LD.sweep emits a unified meta.tool='f13ld.sweep' across
  // ALL families (tpms, beam, grain, noise), so meta.tool cannot be used as
  // a family discriminator for sweep recipes. Sweep does emit a top-level
  // `family` field, which we now check first. Falls through to the legacy
  // structural detection (surface.type / field.type / meta.tool='beam') for
  // recipes from older tools that don't set the family field.
  //
  // Order of detection:
  //   1. json.family set → trust it (sweep & future modern emitters)
  //   2. meta.tool === 'beam' or 'beam-builder' → legacy F13LD.beam
  //   3. field.type / surface.type → legacy TPMS / grain / noise
  //   4. structural fallback → beams[]+geometry → beam (last resort)
  const verStr = (json.meta&&(json.meta.tool_version||json.meta.version))||'(unknown)';
  const toolStr = (json.meta&&json.meta.tool)||'?';

  // ── 1. Explicit family field ─────────────────────────────────────────
  if(typeof json.family === 'string'){
    const fam=json.family;
    if(fam==='beam'){
      if(!Array.isArray(json.beams)||json.beams.length===0){
        throw new Error('Beam recipe is missing beams[] array (meta.tool='+toolStr+', v'+verStr+'). Re-export with the beam endpoint list included.');
      }
      const sub=(json.topology&&json.topology.name)||(json.cell&&json.cell.name)||'custom';
      return{family:'beam',subtype:sub,json};
    }
    if(fam==='tpms'){
      const sub=(json.surface&&json.surface.preset)||(json.geometry&&json.geometry.mode)||'custom';
      return{family:'tpms',subtype:sub,json};
    }
    if(fam==='grain'){
      const ft=(json.field&&json.field.type)||'unknown';
      return{family:'grain',subtype:ft,json};
    }
    if(fam==='noise'){
      const nt=(json.surface&&json.surface.noise_type)||'simplex';
      return{family:'noise',subtype:nt,json};
    }
    if(fam==='bundle'){
      const sn=(json.surface&&json.surface.structure)||(json.meta&&json.meta.preset)||'bundle';
      return{family:'bundle',subtype:sn,json};
    }
    if(fam==='wave'){
      const sub=(json.field&&json.field.symmetry)||'pure';
      return{family:'wave',subtype:sub,json};
    }
    // Unknown family value — fall through to legacy detection rather than
    // hard-erroring, so an unfamiliar family doesn't lock out otherwise
    // valid recipes.
  }

  // ── 2. Legacy F13LD.beam tool (predates sweep) ────────────────────────
  if(json.meta&&(json.meta.tool==='beam'||json.meta.tool==='beam-builder')){
    if(!Array.isArray(json.beams)||json.beams.length===0){
      throw new Error('Beam recipe is missing beams[] array (meta.tool='+toolStr+', v'+verStr+'). Re-export from F13LD.beam v0.2.1 or newer — preset exports now include the beam endpoint list.');
    }
    const sub=(json.topology&&json.topology.name)||(json.cell&&json.cell.name)||'custom';
    return{family:'beam',subtype:sub,json};
  }

  // ── 2b. Legacy F13LD.bundle (ihb surface; predates the family field) ──
  if((json.meta&&json.meta.tool==='bundle-builder')||(json.surface&&json.surface.type==='ihb')){
    const sn=(json.surface&&json.surface.structure)||(json.meta&&json.meta.preset)||'bundle';
    return{family:'bundle',subtype:sn,json};
  }

  // ── 3. Legacy structural detection ───────────────────────────────────
  if(json.field&&json.field.type){const ft=json.field.type;if(['spinodoid','gaussian','hyperuniform','reactiondiffusion'].includes(ft))return{family:'grain',subtype:ft,json};}
  if(json.surface&&json.surface.type){const st=json.surface.type;if(st==='noise')return{family:'noise',subtype:json.surface.noise_type||'simplex',json};if(st==='terms'||st==='raw_preset')return{family:'tpms',subtype:json.surface.preset||json.geometry?.mode||'custom',json};}
  // -- 3b. F13LD.wave -- cymatic standing-wave field (field.modes array) --
  if(json.field&&Array.isArray(json.field.modes)){const sub=(json.field.symmetry)||'wave';return{family:'wave',subtype:sub,json};}

  // ── 4. Structural beam fallback — last resort ────────────────────────
  // Only reached when no family field, no known meta.tool, no field.type,
  // no surface.type. If beams[] is well-formed AND geometry looks lattice-y,
  // accept as beam. This future-proofs against any tool that emits beams
  // without setting family or a known meta.tool.
  if(Array.isArray(json.beams) && json.beams.length>0){
    const b0=json.beams[0];
    if(Array.isArray(b0) && b0.length>=6 && typeof b0[0]==='number' && typeof b0[5]==='number'){
      const g=json.geometry||{};
      const hasLatticeGeom = (Array.isArray(g.scale_xyz)&&g.scale_xyz.length===3)
        || (typeof g.cell==='number'&&g.cell>0)
        || (typeof g.radius==='number'&&g.radius>0);
      if(hasLatticeGeom){
        const sub=(json.topology&&json.topology.name)||(json.cell&&json.cell.name)||'custom';
        return{family:'beam',subtype:sub,json};
      }
    }
  }

  throw new Error('Unrecognized recipe format — expected top-level "family" field, surface.type ("noise"/"terms"), field.type ("spinodoid"/"gaussian"/"hyperuniform"), or meta.tool ("beam"/"beam-builder").');
}

// ── Recipe validation (v0.8.1) ─────────────────────────────────────────────
// Catches recipes that would otherwise crash the summary panel or silently
// fall back to a different geometry in the worker. Throws an Error with a
// plain message naming the missing or unknown field; callers show it.
const KNOWN_NOISE_TYPES=['simplex','cellular','fbm','ridged','billow','foam','strut','veined','curl','warp'];
function validateRecipe(r){
  const j=r.json, isObj=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
  const need=(cond,msg)=>{ if(!cond) throw new Error(msg); };
  const fam=FAMILY_LABEL[r.family]||r.family;
  if(j.geometry!==undefined) need(isObj(j.geometry), fam+' recipe: "geometry" must be an object.');
  if(r.family==='tpms'){
    need(isObj(j.surface), 'TPMS recipe is missing its "surface" block.');
    if(j.surface.type==='raw_preset') need(typeof j.surface.preset==='string', 'TPMS raw preset recipe is missing "surface.preset".');
    else need(Array.isArray(j.surface.terms), 'TPMS recipe is missing its "surface.terms" list.');
  } else if(r.family==='noise'){
    need(isObj(j.surface), 'Noise recipe is missing its "surface" block.');
    const nt=j.surface.noise_type;
    need(nt==null||KNOWN_NOISE_TYPES.includes(nt), 'Unknown noise type "'+nt+'". Supported: '+KNOWN_NOISE_TYPES.join(', ')+'.');
  } else if(r.family==='grain'){
    need(isObj(j.field), 'Grain recipe is missing its "field" block.');
  } else if(r.family==='wave'){
    need(isObj(j.field)&&Array.isArray(j.field.modes), 'Wave recipe is missing its "field.modes" list.');
  }
  r.subtype=String(r.subtype==null?'':r.subtype);
  return r;
}

// One entry point for every recipe source (file drop, file pick, ?r=, ?queue=).
// Returns the routed + validated recipe, or throws with a readable message.
function parseRecipe(json, sourceLabel){
  if(!json||typeof json!=='object'||Array.isArray(json))
    throw new Error((sourceLabel?sourceLabel+': ':'')+'recipe must be a JSON object.');
  try{ return validateRecipe(routeRecipe(json)); }
  catch(e){ throw new Error((sourceLabel?sourceLabel+': ':'')+(e.message||e)); }
}
