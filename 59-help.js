/* ============================================================================
   F13LD.mesh · 59-help.js — the shared F13LD help system (field guide drawer, (i) buttons, "show").
   Engine: the modular drop-in used by wave / tpms / grain / noise (F13LD.noise index.html #f13h-script),
   CSS in help.css. Mesh changes against that engine:
     - classic numbered script (deferred), config in this file;
     - the rail editor, rail cards and Part prep are rebuilt by innerHTML, so placement is repeatable:
       F13Help.refresh([ids]) places every (i) that is missing (a rebuilt row lost its own), and 59-mesh-widgets.js
       calls it after each render;
     - an anchor row may list several selectors (the first that exists wins); `before` places an (i) before an element;
     - ROW_SEL also matches the editor's .rl-erow rows (they carry .sc-group as well).
   "Show" (the wire, F13UI.revealControl) reads F13UI.helpTargets below at call time.
   ========================================================================== */
(function(){
  "use strict";

  /* ============ PER-TOOL CONFIG ======================================== */
  var TUTORIAL_URL = 'https://tutorial.f13ld.app/mesh';
  var TOOL_TITLE   = 'mesh';
  var ROW_SEL      = '.sc-group';
  var INTRO = 'F13LD.mesh turns design recipes into printable parts. Add a part, fill it with a recipe, weld parts together, set the print orientation and export a watertight 3MF. The preview is never cut by Section, and nothing here changes the exported mesh except the settings under Export.';

  var SECTIONS = [
    { title:'View', items:[
      { id:'view', label:'view · Design / Print / Section',
        what:'Design shows the parts. Print puts them on the build plate and colours faces by overhang. Section cuts them open.',
        see:'The view menu beside the tabs sets shadows, occlusion, lighting, cut faces and edges.',
        why:'Preview only. The exported file does not change.' },
      { id:'section', label:'section plane · X / Y / Z', anchor:{into:'#secPanel .sp-t'},
        what:'Cuts the preview with a plane across X, Y or Z. Position slides the plane through the part; flip swaps the cut side.',
        see:'Cut faces show the inside of the lattice.',
        why:'A look inside before you export. The export is never cut.' },
      { id:'renderq', label:'render quality · automatic',
        what:'The preview picks its own detail. There is no quality switch.',
        see:'The view sharpens when you stop moving it.',
        why:'Export quality is separate: it is set under Export.' }
    ]},
    { title:'Design · recipes and parts', items:[
      { id:'recipes', label:'recipes', range:'up to 8', anchor:{before:'#railRecipes .rl-ch .rl-r'},
        what:'The recipe files you have opened: noise, TPMS, wave, grain, beam, bundle or foam. Add one with Add recipe or the Open recipe button.',
        see:'Tap a card for its details. Drag a card onto a part to fill the part with it.',
        why:'A recipe is the lattice. A part is the shape it fills.' },
      { id:'parts', label:'parts', range:'up to 8', anchor:{before:'#railParts .rl-ch .rl-r'},
        what:'The shapes you added (STL, OBJ, 3MF, STEP, IGES). The selected part is the one the editor and Export act on.',
        see:'The eye cycles solid, ghost and hidden. Press and hold a row to tick several.',
        why:'Hidden parts are not exported.' },
      { id:'weld', label:'weld', anchor:{row:'#railEditor .rl-eb>.rl-erow:first-child'},
        what:'Joins parts into one body. Drag a part onto another, tick two or more and press Weld, or use Weld with in the part editor. Take out leaves a weld.',
        see:'A weld card groups its members. Edit weld opens the weld settings.',
        why:'A weld exports as one watertight part.' }
    ]},
    { title:'Design · part editor', items:[
      { id:'fill', label:'fill', anchor:{row:'#railEditor [data-act=fill]'},
        what:'Solid exports the part as imported. Lattice fills it with the recipe. Lattice + skin adds a solid shell of the skin thickness.',
        see:'The controls below change with the fill.',
        why:'Solid for faces that mount or seal, lattice for the body.' },
      { id:'recipe', label:'recipe', anchor:{row:'#railEditor [data-sel=recipe]'},
        what:'Which opened recipe fills this part.',
        see:'The preview changes to that lattice.',
        why:'Re-fill a part with another recipe without importing it again.' },
      { id:'skin', label:'skin thickness', range:'0.1 – 2 mm', anchor:{row:'#railEditor [data-k=skin]'},
        what:'Thickness of the solid shell around the part (Lattice + skin).',
        see:'A thicker skin hides more of the lattice at the surface.',
        why:'A closed outer surface for sealing, finish or handling.' },
      { id:'cell', label:'cell size', range:'mm', anchor:{row:'#railEditor .rl-num[data-k=cell]'},
        what:'Edge length of one lattice cell, in mm.',
        see:'Smaller cells give a finer structure and a longer export. Any value above 0.05 mm applies.',
        why:'The scale of the lattice against the part.' },
      { id:'wall', label:'wall offset', range:'−2 – 2 mm', anchor:{row:'#railEditor [data-k=isoOffsetMm]'},
        what:'Moves the lattice surface in or out by this many mm.',
        see:'Positive thickens the walls, negative thins them.',
        why:'A fine density adjustment without changing the recipe.' },
      { id:'rotation', label:'rotation', range:'−180 – 180°', anchor:{row:'#railEditor [data-k=rotXDeg]'},
        what:'Rotates the lattice about X, Y and Z inside the part.',
        see:'The structure turns; the part stays.',
        why:'Lines struts or sheets up with the load direction.' },
      { id:'shift', label:'shift', range:'± one period', anchor:{row:'#railEditor [data-k=spatialOffsetMmX]'},
        what:'Slides the lattice along X, Y and Z, up to one structural period each way.',
        see:'The pattern moves; the part stays.',
        why:'Chooses where the part cuts through the cells.' },
      { id:'trim', label:'trim to nodes', anchor:{row:'#railEditor [data-act=trim]'},
        what:'Beam recipes only: ends struts at their nodes where the part cuts them. Inset sets how far, as a multiple of the strut.',
        see:'Cleaner strut ends at the part surface.',
        why:'Avoids stubs and thin slivers on the outside.' },
      { id:'colour', label:'viewport colour', anchor:{row:'#railEditor .rl-hue-w'},
        what:'The colour the part is drawn in. Drag the hue, pick Light, Mid or Deep, or reset to the default.',
        see:'The part and its card change colour. A weld member takes the weld’s colour.',
        why:'Tells parts apart in the preview. It is not exported.' }
    ]},
    { title:'Design · weld editor', items:[
      { id:'fillet', label:'fillet radius', range:'0 – 1.5 mm', anchor:{row:'#railEditor [data-k="w.fillet"]'},
        what:'Radius of the blend where welded parts meet.',
        see:'The joint rounds off; 0 is a sharp union.',
        why:'Smooth joints print better and carry load with less stress concentration.' },
      { id:'joinrule', label:'join rule · Union / Anchor / Graded', anchor:{row:'#railEditor [data-act=rule]'},
        what:'Union is a plain union with the fillet. Anchor runs the lattice into the solid part. Graded thickens the lattice walls toward the solid.',
        see:'Anchor and Graded need one solid part and one lattice part in the weld.',
        why:'The lattice bonds through the joint instead of touching at a face.' },
      { id:'anchor', label:'anchor depth', range:'0 – 2 mm', anchor:{row:'#railEditor [data-k="w.anchor"]'},
        what:'How far the lattice runs into the solid part (Anchor).',
        see:'A deeper anchor grips more of the solid.',
        why:'Sets the bond between lattice and solid.' },
      { id:'grade', label:'grade over', range:'0.2 – 5 mm', anchor:{row:'#railEditor [data-k="w.grade"]'},
        what:'The distance over which the lattice walls thicken toward the solid (Graded).',
        see:'A longer grade blends more slowly.',
        why:'Spreads stress from the solid into the lattice.' },
      { id:'joins', label:'show joins', anchor:{row:'#railEditor [data-act=joins]'},
        what:'Tints the lattice where two or more parts of the weld meet.',
        see:'The join band shows in the Mesh colour.',
        why:'Check where the weld acts before exporting. Preview only.' }
    ]},
    { title:'Prep', items:[
      { id:'process', label:'process', anchor:{row:'#ppProc'},
        what:'The print process: metal powder bed (laser or electron beam), polymer powder bed, resin vat or filament extrusion.',
        see:'The material list, the default overhang limit and whether supports apply change with the process.',
        why:'Prep numbers (mass, support area) depend on how the part is printed.' },
      { id:'material', label:'material', anchor:{row:'#ppMat'},
        what:'The material and condition, with its density. Custom density takes a value from a data sheet.',
        see:'Sets the density used for mass in the Estimate and Measured cards.',
        why:'Mass assumes fully dense material at this density.' },
      { id:'axisup', label:'part axis facing up', range:'±X ±Y ±Z', anchor:{row:'#ppUp'},
        what:'Which part axis points up on the build plate.',
        see:'The Print view and the support numbers follow. The export is rotated to match.',
        why:'Orientation sets build height and where supports go.' },
      { id:'tilt', label:'tilt', range:'−180 – 180°', anchor:{row:'[data-pp=tiltX]'},
        what:'Tilts the part about X and Y after the axis is up.',
        see:'The Print view and the support numbers update.',
        why:'A small tilt can remove supports. At 0° and +Z the export keeps its design position.' },
      { id:'overhang', label:'overhang limit', range:'0 – 89°', anchor:{row:'#grp-crit'},
        what:'A downward face tilted less than this from the plate needs support.',
        see:'Faces below the limit show red in the Print view, faces within 10° of it amber.',
        why:'Set it from your printer and material. Process defaults are 30–45°.' },
      { id:'standoff', label:'standoff', range:'0 – 50 mm', anchor:{row:'#grp-standoff'},
        what:'Gap between the plate and the part, filled with support.',
        see:'Changes the view and the support numbers. The export is not moved.',
        why:'Room to cut the part off the plate.' },
      { id:'plate', label:'plate opacity', range:'0 – 100 %', anchor:{row:'#grp-plate'},
        what:'How see-through the build plate is in the Print view.',
        see:'Lower shows parts that sit below the plate line.',
        why:'View only.' }
    ]},
    { title:'Export', items:[
      { id:'quality', label:'quality · Draft – Ultra', anchor:{row:'#grp-quality'},
        what:'Triangle edge length of the exported mesh.',
        see:'Finer quality gives a smoother surface, a bigger file and a longer export. The Estimate shows the cost.',
        why:'Draft to check, High or Ultra to print.' },
      { id:'domain', label:'domain size', range:'1 – 100 mm', anchor:{row:'#grp-domain'},
        what:'Edge of the exported cube when no part is loaded (open cube): one design cell.',
        see:'Only shows for the open cube. With a part loaded the part sets the size.',
        why:'Sets the size of a bare lattice sample.' },
      { id:'mesher', label:'mesher · Auto / Slab / Classic', anchor:{row:'#grp-mesher'},
        what:'Auto meshes with Classic and switches to Slab when Classic runs out of memory or its mesh comes out torn. Slab splits the part into layers and meshes them on every core. Welds follow this setting too.',
        see:'The Measured card names the mesher that ran.',
        why:'Slab is faster and uses less memory on large parts.' },
      { id:'loose', label:'loose pieces', anchor:{row:'#grp-loose'},
        what:'Remove specks drops loose pieces under 10 mesh cells left over from meshing. Keep all keeps everything. Largest piece only keeps the biggest piece and the cavities inside it.',
        see:'Woven or separate regions and sealed cavities are always kept, except under Largest piece only. A warning shows when the mesh has many pieces.',
        why:'Specks are meshing leftovers; separate grains can be by design.' },
      { id:'simplify', label:'simplify · Standard / Fast', anchor:{row:'#grp-checks'},
        what:'While the slab mesher simplifies, it checks that the mesh has not torn open. Fast does those checks a quicker way and gives the same mesh. Standard is the older, slower way, kept for comparison.',
        see:'On test parts, simplify took about a fifth to a half less time. The classic mesher is not affected.',
        why:'Leave it on Fast unless you are comparing results.' }
    ]},
    { title:'Results', items:[
      { id:'estimate', label:'estimate', anchor:{before:'#inspEst .ic-fold'},
        what:'Volume filled, porosity, part volume, mass and build size, estimated from the preview and the Prep settings.',
        see:'Updates as you change the design or the orientation. The footer line above Export shows triangles, time and cores.',
        why:'Check the part before you export. Exact numbers come after the export.' },
      { id:'measured', label:'measured · last export', anchor:{before:'#inspMeas .ic-fold'},
        what:'Numbers taken from the exported triangle mesh: volume, mass, surface area, pieces, support area and plate contact, plus the print report.',
        see:'Fills after an export. It describes that export, so it can lag behind later edits.',
        why:'These are the file you got, not the preview.' },
      { id:'homo', label:'homogenization', anchor:{before:'#inspHomo .ic-fold'},
        what:'Effective stiffness the design tool computed for the recipe.',
        see:'Shows for a recipe that carries it.',
        why:'The numbers are for the recipe as designed. Wall offset, rotation and skin change the lattice away from it.' }
    ]}
  ];
  /* ============ END PER-TOOL CONFIG ==================================== */

  function el(tag, cls, html){ var n=document.createElement(tag); if(cls) n.className=cls; if(html!=null) n.innerHTML=html; return n; }

  var scrim, drawer, trigger;

  function line(tag, txt, kind){
    var l = el('div','f13h-line'+(kind?(' '+kind):''));
    l.appendChild(el('span','f13h-tag',tag));
    l.appendChild(el('span',null,txt));
    return l;
  }

  function build(){
    scrim = el('div','f13h-scrim');
    drawer = el('div','f13h-drawer');

    var head = el('div','f13h-head');
    head.appendChild(el('h2', null, 'F13LD.<b>'+TOOL_TITLE+'</b><span>field guide</span>'));
    var tut = document.createElement('a');
    tut.className='f13h-tut'; tut.href=TUTORIAL_URL; tut.target='_blank'; tut.rel='noopener';
    /* drawn arrow (no glyph characters in the UI) */
    tut.innerHTML='Tutorial<svg class="ic sm" viewBox="0 0 16 16" aria-hidden="true" style="display:inline-block;vertical-align:-2px;margin-left:3px"><path d="M5 11l6-6M6 5h5v5"/></svg>';
    head.appendChild(tut);
    var close = el('button','f13h-close','×'); close.setAttribute('aria-label','Close');
    close.addEventListener('click', closeDrawer);
    head.appendChild(close);
    drawer.appendChild(head);

    var body = el('div','f13h-body');
    body.appendChild(el('div','f13h-intro', INTRO));
    SECTIONS.forEach(function(sec){
      body.appendChild(el('div','f13h-section-t', sec.title));
      sec.items.forEach(function(it){
        var card = el('div','f13h-card'); card.id='f13h-card-'+it.id;
        var h = el('div','f13h-card-h');
        h.appendChild(el('span','f13h-name', it.label));
        if(it.range) h.appendChild(el('span','f13h-range', it.range));
        card.appendChild(h);
        if(it.what) card.appendChild(line('sets',  it.what));
        if(it.see)  card.appendChild(line('shows', it.see));
        if(it.why)  card.appendChild(line('means', it.why, 'means'));
        body.appendChild(card);
      });
    });
    drawer.appendChild(body);

    document.body.appendChild(scrim);
    document.body.appendChild(drawer);
    scrim.addEventListener('click', closeDrawer);
  }

  /* keep the drawer tucked under the header's right edge (handles centered layouts) */
  function alignDrawer(){
    if(!drawer) return;
    var h = document.querySelector('.f13ld-header') || document.getElementById('hdr');
    if(!h) return;
    var r = h.getBoundingClientRect();
    drawer.style.right = Math.max(0, Math.round(window.innerWidth - r.right)) + 'px';
  }

  function openDrawer(id){
    alignDrawer();
    scrim.classList.add('open');
    drawer.classList.add('open');
    if(trigger) trigger.classList.add('active');
    if(id){
      setTimeout(function(){
        var c = document.getElementById('f13h-card-'+id);
        if(!c) return;
        c.scrollIntoView({block:'center', behavior:'smooth'});
        c.classList.add('flash');
        setTimeout(function(){ c.classList.remove('flash'); }, 1500);
      }, 90);
    }
  }
  function closeDrawer(){
    scrim.classList.remove('open');
    drawer.classList.remove('open');
    if(trigger) trigger.classList.remove('active');
  }

  function makeI(id){
    var b = el('button','f13h-i','i'); b.type='button';
    b.setAttribute('aria-label','About this control');
    b.setAttribute('data-h', id);
    b.addEventListener('click', function(e){ e.preventDefault(); e.stopPropagation(); openDrawer(id); });
    return b;
  }

  /* first element of a comma-separated selector list that exists */
  function first(sel){
    var parts = sel.split(','), i, e;
    for(i=0;i<parts.length;i++){ e = document.querySelector(parts[i].trim()); if(e) return e; }
    return null;
  }

  /* resolve the <label> for a control row, tolerant of different markups */
  function rowLabel(sel){
    var elx = first(sel); if(!elx) return null;
    var c = elx.closest(ROW_SEL);
    if(c){ var l = c.querySelector('label'); if(l) return l; }
    var lw = elx.closest('label'); if(lw) return lw;   /* label-wrapped input */
    return null;
  }

  function placed(id){ return !!document.querySelector('button.f13h-i[data-h="'+id+'"]'); }

  /* place an inline "i" using one of: row | into | after | before */
  function place(item){
    var a = item.anchor; if(!a || placed(item.id)) return;
    if(a.into){ var t = first(a.into); if(t) t.appendChild(makeI(item.id)); return; }
    if(a.before){ var bf = first(a.before); if(bf && bf.parentNode) bf.parentNode.insertBefore(makeI(item.id), bf); return; }
    if(a.after){ var x = first(a.after);
      if(x && x.parentNode) x.parentNode.insertBefore(makeI(item.id), x.nextSibling); return; }
    if(a.row){ var l = rowLabel(a.row); if(!l) return;
      if(l.id){ l.parentNode.insertBefore(makeI(item.id), l.nextSibling); }  /* a label with an id: the app / wire addresses it, so the (i) is a sibling */
      else { l.appendChild(makeI(item.id)); }
      return; }
  }

  /* place every (i) that is missing; ids narrows it to some cards (a render of one region) */
  function refresh(ids){
    SECTIONS.forEach(function(sec){ sec.items.forEach(function(it){
      if(ids && ids.indexOf(it.id) < 0) return;
      place(it);
    }); });
  }

  function init(){
    build();
    var fhRight = document.querySelector('.fh-right');
    if(fhRight){
      trigger = el('button','f13h-trigger','?');
      trigger.type='button';
      trigger.title='Help · control guide';
      trigger.setAttribute('aria-label','Help');
      trigger.addEventListener('click', function(){
        if(drawer.classList.contains('open')) closeDrawer(); else openDrawer(null);
      });
      fhRight.insertBefore(trigger, fhRight.firstChild);
    }
    refresh();
    alignDrawer();
    window.addEventListener('resize', alignDrawer);
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeDrawer(); });
  }

  window.F13Help = {
    refresh: refresh,
    open: function(id){ if(drawer) openDrawer(id||null); },
    close: function(){ if(drawer) closeDrawer(); },
    cards: function(){ var n=[]; SECTIONS.forEach(function(s){ s.items.forEach(function(i){ n.push(i.id); }); }); return n; },
    count: function(){ return document.querySelectorAll('button.f13h-i').length; }
  };

  /* ---- help "show": the wire (F13UI.revealControl) reads these at call time. id → selector, "a, b" (first drawn
     candidate), or {sel, note}. `note` is what a control that is not drawn right now says (a part editor that is closed,
     a row for another fill / rule / process). ---- */
  var NEED_PART = 'Select a part to see this control.';
  var NEED_LATTICE = 'Fill the selected part with a lattice to see this control.';
  var NEED_WELD = 'Select a weld to see this control.';
  var T = function(sel, note){ return note ? {sel:sel, note:note} : sel; };
  var UI = window.F13UI = window.F13UI || {};
  UI.helpTargets = {
    view:'#w-view, #vsTabs',
    section:T('#w-clip, #secAxis', 'The section controls show in the Section tab.'),
    recipes:'#railRecipes .rl-card',
    parts:'#railParts .rl-card',
    weld:T('#railEditor [data-sel=weldWith], #railEditor [data-act=goWeld], #railEditor .rl-mlist', 'Select a part to see its weld control.'),
    fill:T('#railEditor [data-act=fill]', NEED_PART),
    recipe:T('#railEditor [data-sel=recipe]', 'Fill the selected part with a lattice to choose its recipe.'),
    skin:T('#railEditor [data-k=skin]', 'Skin thickness shows when the selected part is Lattice + skin.'),
    cell:T('#railEditor .rl-num[data-k=cell]', NEED_LATTICE),
    wall:T('#railEditor [data-k=isoOffsetMm]', NEED_LATTICE),
    rotation:T('#railEditor [data-k=rotXDeg]', NEED_LATTICE),
    shift:T('#railEditor [data-k=spatialOffsetMmX]', NEED_LATTICE),
    trim:T('#railEditor [data-act=trim]', 'Trim to nodes shows for a beam recipe on the selected part.'),
    colour:T('#railEditor .rl-hue-w', NEED_PART),
    fillet:T('#railEditor [data-k="w.fillet"]', NEED_WELD),
    joinrule:T('#railEditor [data-act=rule]', NEED_WELD),
    anchor:T('#railEditor [data-k="w.anchor"]', 'Anchor depth shows when the weld’s join rule is Anchor.'),
    grade:T('#railEditor [data-k="w.grade"]', 'Grade over shows when the weld’s join rule is Graded.'),
    joins:T('#railEditor [data-act=joins]', NEED_WELD),
    process:'#ppProc',
    material:'#ppMat',
    axisup:'#ppUp',
    tilt:'[data-pp=tiltX]',
    overhang:T('#grp-crit', 'Overhang limit shows for a process that needs supports.'),
    standoff:T('#grp-standoff', 'Standoff shows for a process that needs supports.'),
    plate:T('#grp-plate', 'Plate opacity shows in the Print view.'),
    quality:'#grp-quality',
    domain:T('#grp-domain', 'Domain size shows for the open cube, with no part loaded.'),
    mesher:'#grp-mesher',
    loose:'#grp-loose',
    simplify:'#grp-checks',
    estimate:'#inspEst',
    measured:'#inspMeas',
    homo:T('#inspHomo', 'Homogenization shows for a recipe that carries it.')
  };

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
