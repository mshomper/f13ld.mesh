/* ============================================================
   F13LD.mesh · 51-summaries.js
   Per-family recipe summary cards.
   ============================================================ */
'use strict';

// ── Summary renderers ─────────────────────────────────────────────────────
function card(l,v,u){if(v==null)return'';return`<div class="mc"><div class="mc-lbl">${esc(l)}</div><div class="mc-val">${esc(v)}${u?`<span class="mc-unit">${esc(u)}</span>`:''}</div></div>`;}
function hchip(l,v,u){if(v==null)return'';return`<div class="hchip">${esc(l)} <b>${esc(v)}</b>${u?`<small> ${esc(u)}</small>`:''}</div>`;}
function homoSection(h){if(!h)return'';return`<hr class="div"><div class="sec-lbl">homogenization &middot;${esc(h.method||'MIL-HS')}&middot;${esc(h.grid||'?')}³</div><div class="homo-row">${hchip('VF',h.volume_fraction!=null?h.volume_fraction.toFixed(1):null,'%')}${hchip('Ex',h.Ex_GPa!=null?h.Ex_GPa.toFixed(2):null,'GPa')}${hchip('Ey',h.Ey_GPa!=null?h.Ey_GPa.toFixed(2):null,'GPa')}${hchip('Ez',h.Ez_GPa!=null?h.Ez_GPa.toFixed(2):null,'GPa')}${hchip('Gxy',h.Gxy_GPa!=null?h.Gxy_GPa.toFixed(2):null,'GPa')}${hchip('A',h.anisotropy!=null?h.anisotropy.toFixed(2):null,'')}${hchip('νeff',h.nu_eff!=null?h.nu_eff.toFixed(3):null,'')}</div>`;}
// v0.8.3: remembered across panel re-renders (was reset to 10 mm every time).
let exportDomainMm=10;
function exportPanel(){
  const q=currentExportQual||'low';
  return`<hr class="div">
<div class="sec-lbl">export 3mf</div>
<div class="exp-row">
  <span class="exp-label">domain size</span>
  <input type="number" id="expDomainMm" class="exp-num" value="${exportDomainMm}" min="1" max="100" step="1" oninput="exportDomainMm=Math.max(1,Math.min(100,parseFloat(this.value)||10));updateExportEstimate()">
  <span class="exp-unit">mm</span>
</div>
<div class="qual-strip" style="margin-bottom:8px">
    <button class="qual-btn${q==='draft'?' active':''}" id="qDraft" onclick="setQual('draft')"><span class="qlbl">Draft</span><span class="ql" id="qlDraft">—</span></button>
    <button class="qual-btn${q==='low'?' active':''}" id="qLow" onclick="setQual('low')"><span class="qlbl">Low</span><span class="ql" id="qlLow">—</span></button>
    <button class="qual-btn${q==='med'?' active':''}" id="qMed" onclick="setQual('med')"><span class="qlbl">Med</span><span class="ql" id="qlMed">—</span></button>
    <button class="qual-btn${q==='high'?' active':''}" id="qHigh" onclick="setQual('high')"><span class="qlbl">High</span><span class="ql" id="qlHigh">—</span></button>
    <button class="qual-btn${q==='ultra'?' active':''}" id="qUltra" onclick="setQual('ultra')"><span class="qlbl">Ultra</span><span class="ql" id="qlUltra">—</span></button>
  </div>
<button id="expBtn" onclick="triggerExport()">Export 3MF</button>
<div id="expEstimate"></div>

<div id="expElapsed"></div>
<div id="expReport"></div>`;}
function buildNoiseSummary(r){const s=r.json.surface,g=r.json.geometry||{},h=r.json.homogenization;const hs=s.scale_x!=null&&(s.scale_x!==1||s.scale_y!==1||s.scale_z!==1);return`<div class="sec-lbl">noise scaffold</div><div class="meta-grid">${card('noise type',(s.noise_type||'simplex').toUpperCase())}${card('frequency',s.frequency)}${card('topology',g.mode)}${card('wall thickness',g.wall_thickness)}${card('cell scale',g.cell_scale)}${card('center',s.center)}${card('half-width',s.half_width)}${hs?card('axis scale',`${s.scale_x}·${s.scale_y}·${s.scale_z}`):''}${s.octaves!=null?card('octaves',s.octaves):''}${s.lacunarity!=null?card('lacunarity',s.lacunarity):''}${s.distance_metric?card('distance metric',s.distance_metric):''}${s.jitter!=null?card('jitter',s.jitter):''}${s.vein_turbulence!=null?card('vein turb',s.vein_turbulence):''}${s.vein_frequency!=null?card('vein freq',s.vein_frequency):''}${s.seed?card('seed',s.seed):''}</div>${exportPanel()}`;}
function buildTPMSSummary(r){const s=r.json.surface,g=r.json.geometry||{},h=r.json.homogenization;const nOn=Array.isArray(s.terms)?s.terms.filter(t=>t.on).length:'?';const ps=g.phase_shift;
  // Anisotropic-tiling spec v1.0: show per-axis cell scale when the recipe
  // ships cell_scale_x/y/z and they aren't all equal; fall back to scalar.
  const cx=g.cell_scale_x,cy=g.cell_scale_y,cz=g.cell_scale_z;
  const hasPerAxis=(cx!=null||cy!=null||cz!=null);
  const aniso=hasPerAxis&&!(cx===cy&&cy===cz);
  const cellLbl=aniso?`${cx??g.cell_scale}·${cy??g.cell_scale}·${cz??g.cell_scale}`:g.cell_scale;
  return`<div class="sec-lbl">tpms scaffold</div><div class="meta-grid">${card('preset',(s.preset||'custom').toUpperCase())}${card('mode',g.mode)}${card('active terms',nOn)}${card('cell scale',cellLbl)}${card('wall thickness',g.wall_thickness)}${g.shell_normalize?card('shell-normalize','on'):''}${card('pipe radius',g.pipe_radius)}${g.pi_normalize?card('pi-normalize','on'):''}${card('offset',g.offset)}${ps?card('phase shift',`${ps.x}·${ps.y}·${ps.z}`):''}${g.mode==='pi-tpms'?card('field B',r.json.surface_b?String(r.json.surface_b.preset||r.json.surface_b.label||'custom').toUpperCase():'same as A'):''}${(g.mode==='pi-tpms'&&g.field_b_freq>1)?card('B frequency',g.field_b_freq+'×'):''}${card('gradient',g.gradient?.enabled?'on':'off')}</div>${exportPanel()}`;}
function buildGrainSummary(r){const f=r.json.field,g=r.json.geometry||{},h=r.json.homogenization;
  if(f.type==='reactiondiffusion'){
    // v0.5.0-rc15: system-aware labels. Wire fields rd_F / rd_k mean F/k for
    // Gray-Scott but a/b for Brusselator and Schnakenberg (handoff §1).
    const sys = f.rd_system || 'grayscott';
    const sysLabel = sys==='brusselator' ? 'brusselator'
                   : sys==='schnakenberg' ? 'schnakenberg'
                   :                        'gray-scott';
    const isGS = (sys==='grayscott');
    const p1Label = isGS ? 'feed rate F' : 'param a';
    const p2Label = isGS ? 'kill rate k' : 'param b';
    return`<div class="sec-lbl">grain scaffold &middot; reaction-diffusion (${sysLabel})</div>
    <div class="meta-grid">
    ${card('activator diffusion (Du)',f.rd_Du!=null?f.rd_Du.toFixed(2):'—')}
    ${card('inhibitor diffusion (Dv)',f.rd_Dv!=null?f.rd_Dv.toFixed(2):(isGS?(f.rd_Du!=null?(f.rd_Du*0.5).toFixed(2)+' (derived)':'—'):'—'))}
    ${card(p1Label,f.rd_F!=null?f.rd_F.toFixed(3):'—')}
    ${card(p2Label,f.rd_k!=null?f.rd_k.toFixed(3):'—')}
    ${card('sim steps',f.rd_steps)}
    ${card('tile factor',f.rd_tile)}
    ${card('RNG seed',f.rng_seed)}
    ${card('topology',g.topology)}
    ${card('center',g.center)}
    ${card('half-width',g.half_width)}
    </div>${exportPanel()}`;
  }
  const dir=f.principal_direction?`[${f.principal_direction.map(v=>parseFloat(v.toFixed(2))).join(', ')}]`:f.dir_mode||'—';
  return`<div class="sec-lbl">grain scaffold &middot;${esc(r.subtype)}</div><div class="meta-grid">${card('field type',(f.type||'—').toUpperCase())}${card('N waves',f.n_waves)}${card('κ',f.kappa)}${card('frequency',f.frequency)}${card('direction',dir)}${card('dir mode',f.dir_mode)}${card('topology',g.topology)}${card('center',g.center)}${card('half-width',g.half_width)}${card('RNG seed',f.rng_seed)}</div>${exportPanel()}`;}
// v0.5.0-rc16: Beam-family summary. Uses MPa engineering_constants & Zener
// from the F13LD.beam JSON (different schema than the noise/tpms/grain
// homogenization block, so cannot reuse homoSection).
function buildBeamSummary(r){
  const j=r.json,g=j.geometry||{},m=j.metrics||{},h=j.homogenization||{};
  const ec=h.engineering_constants_MPa||{},nu=h.poisson_ratios||{},an=h.anisotropy||{};
  const topoName=(j.topology&&j.topology.name)||(j.cell&&j.cell.name)||'custom';
  const beamCount=(j.topology&&j.topology.beam_count)||(j.cell&&j.cell.beam_count)||(j.beams?j.beams.length:'?');
  const isCustom=j.meta&&j.meta.tool==='beam-builder';
  const toGPa=v=>v!=null?(v/1000).toFixed(2):null;
  // v0.5.0-rc22: anisotropic schema display.
  // - scale_xyz [sx,sy,sz] mm shows per-axis cell dims when present;
  //   omits the scalar "cell" line in that case to avoid redundancy.
  // - radius_x/y/z (mm) shows per-axis radii when distinct; otherwise scalar.
  // - node_smoothing_k and node_ball_radius shown only when > 0.
  // v0.5.0-rc25: accept cell_scale_x/y/z as scale_xyz fallback (sweep beam
  // recipes use this field name; see schema notes in buildBeamSDF).
  let sxyz=null;
  if(Array.isArray(g.scale_xyz)&&g.scale_xyz.length===3&&isFinite(g.scale_xyz[0])){
    sxyz=g.scale_xyz;
  } else if(typeof g.cell_scale_x==='number'&&typeof g.cell_scale_y==='number'&&typeof g.cell_scale_z==='number'){
    sxyz=[g.cell_scale_x, g.cell_scale_y, g.cell_scale_z];
  }
  const hasScaleXYZ=sxyz!==null;
  const aniso=hasScaleXYZ&&!(Math.abs(sxyz[0]-sxyz[1])<1e-9&&Math.abs(sxyz[1]-sxyz[2])<1e-9);
  const cellRow=hasScaleXYZ
    ? (aniso
        ? card('cell',`${sxyz[0].toFixed(3)}·${sxyz[1].toFixed(3)}·${sxyz[2].toFixed(3)}`,'mm')
        : card('cell',sxyz[0].toFixed(3),'mm'))
    : (g.cell!=null?card('cell',g.cell,'mm'):'');
  const hasRadXYZ=(typeof g.radius_x==='number');
  const radAniso=hasRadXYZ&&(g.radius_y!=null||g.radius_z!=null)&&
    !(Math.abs((g.radius_y??g.radius_x)-g.radius_x)<1e-9&&Math.abs((g.radius_z??g.radius_x)-g.radius_x)<1e-9);
  const radRow=hasRadXYZ
    ? (radAniso
        ? card('beam radius',`${g.radius_x.toFixed(4)}·${(g.radius_y??g.radius_x).toFixed(4)}·${(g.radius_z??g.radius_x).toFixed(4)}`,'mm')
        : card('beam radius',g.radius_x.toFixed(4),'mm'))
    : card('beam radius',g.radius);
  const sminRow=(typeof g.node_smoothing_k==='number'&&g.node_smoothing_k>0)
    ? card('node smoothing',g.node_smoothing_k.toFixed(4),'mm') : '';
  const ballRow=(typeof g.node_ball_radius==='number'&&g.node_ball_radius>0)
    ? card('node ball',g.node_ball_radius.toFixed(4),'mm') : '';
  const homoBlock=(ec.Ex!=null||an.zener_A!=null)?
    `<hr class="div"><div class="sec-lbl">homogenization &middot; DSM-PBC frame</div>
     <div class="homo-row">${hchip('VF',m.relative_density_pct!=null?m.relative_density_pct.toFixed(1):null,'%')}${hchip('Ex',toGPa(ec.Ex),'GPa')}${hchip('Ey',toGPa(ec.Ey),'GPa')}${hchip('Ez',toGPa(ec.Ez),'GPa')}${hchip('Gxy',toGPa(ec.Gxy),'GPa')}${hchip('A',an.zener_A!=null?an.zener_A.toFixed(2):null,'')}${hchip('νxy',nu.nuxy!=null?nu.nuxy.toFixed(3):null,'')}</div>`
    :'';
  return`<div class="sec-lbl">beam scaffold &middot; ${isCustom?'custom':'preset'}</div>
    <div class="meta-grid">
    ${card('topology',topoName.toUpperCase())}
    ${card('beam count',beamCount)}
    ${radRow}
    ${cellRow}
    ${sminRow}
    ${ballRow}
    ${card('relative density',m.relative_density_pct!=null?m.relative_density_pct.toFixed(2):'—','%')}
    ${an.zener_label?card('anisotropy',an.zener_label):''}
    </div>${homoBlock}${exportPanel()}`;
}
function buildBundleSummary(r){
  const j=r.json, surf=j.surface||{}, g=j.geometry||{}, h=j.homogenization;
  const p=bundleParamsFromJSON(j);
  const Pxy=bundleXYPeriod(p), Lz=bundleZPeriod(p), sc=bundleSuperCellXY(p,Lz);
  const aspect=Lz/Pxy;
  const structNames={0:'BUNDLE',1:'HELICOID',2:'BRAID',3:'WEAVE'};
  const topoLbl=surf.topology||(p.topoMode?'sheet':'solid');
  let rows='';
  if(p.structure===0){
    rows=card('beam shape',(g.beam_shape||'circle'))+card('beam radius',g.beam_radius)+card('beams/side',g.beams_per_side)+card('spacing',g.beam_spacing)+card('column gap',g.column_gap)+card('twist rate',g.twist_rate)+(p.twistMode?card('twist mode','alternating'):'')+(p.warpMode?card('warp',['off','shear','helical'][p.warpMode]||'on'):'');
  } else if(p.structure===1){
    rows=card('pitch',g.pitch)+card('thickness',g.thickness)+card('inner R',g.inner_radius)+card('outer R',g.outer_radius)+card('starts',g.starts)+card('column gap',g.column_gap)+((p.hColHand||p.hZHand)?card('handedness','alternating'):'');
  } else if(p.structure===2){
    rows=card('strands',g.strand_count)+card('braid R',g.braid_radius)+card('fiber R',g.fiber_radius)+card('pitch',g.pitch)+card('column gap',g.column_gap)+(p.bColHand?card('handedness','alternating'):'');
  } else {
    rows=card('weave pitch',g.weave_pitch)+card('amplitude',g.weave_amplitude)+card('fiber R',g.fiber_radius)+card('layer gap',g.weave_layer_gap);
  }
  const cellLbl=(sc.Kx===1&&sc.Ky===1)?'1×1':(sc.Kx+'×'+sc.Ky);
  const cellRow=card('tile cell',cellLbl+' · Z '+aspect.toFixed(2)+'×');
  const rampNote=(Math.abs(p.zRampX)>1e-9||Math.abs(p.zRampY)>1e-9)?card('z-ramp','on · seams at borders'):'';
  return`<div class="sec-lbl">bundle scaffold &middot; ${structNames[p.structure]}</div>
    <div class="meta-grid">
    ${card('topology',topoLbl)}
    ${rows}
    ${surf.iso_offset?card('iso offset',surf.iso_offset):''}
    ${p.topoMode?card('sheet width',surf.sheet_width):''}
    ${cellRow}
    ${rampNote}
    </div>${homoSection(h)}${exportPanel()}`;
}
function buildWaveSummary(r){const f=r.json.field||{},h=r.json.homogenization;const nModes=Array.isArray(f.modes)?f.modes.length:0;const phase=f.phase||(f.signFlip?'B':'A');return `<div class="sec-lbl">wave scaffold</div><div class="meta-grid">${card('symmetry',(f.symmetry||'pure'))}${card('topology',f.mode||'solid')}${card('modes',nModes)}${card('iso',f.iso)}${f.mode==='sheet'?card('thickness',f.thickness):''}${card('phase',phase)}${card('cell scale',f.cellScale)}</div>${homoSection(h)}${exportPanel()}`;}
function renderSummary(r){if(r.family==='noise')return buildNoiseSummary(r);if(r.family==='tpms')return buildTPMSSummary(r);if(r.family==='grain')return buildGrainSummary(r);if(r.family==='beam')return buildBeamSummary(r);if(r.family==='bundle')return buildBundleSummary(r);if(r.family==='wave')return buildWaveSummary(r);}
