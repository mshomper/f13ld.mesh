/* ============================================================================
   F13LD.mesh · 59-mesh-widgets.js — UI refresh stage 3: the liquid widgets the wire (58-f13ui-wire.js CONFIG)
   does not mount by itself. Pattern: the template README, "Controls the app rebuilds" (TPMS mountTermToggles).

   Every widget drives the app through its NATIVE control (set the value and dispatch input / change, or click the
   native button), so the app's own handlers run and exports stay byte-identical. The app reaches the widget through a
   value / checked override on the native element (mirrorValue) or a MutationObserver on the native button.

   The mounts are the kit wire's F13UI.mount.* (slider, select, segmented, toggle, mirror); progress goes through F13UI.run.*.
   Mounted here (after the wire has mounted: F13UI.ready):
     - view menu: 5 toggles over #viewOptsPanel input[data-vo] (the view-menu reset moves .checked: mirrored);
     - section flip toggle (#secFlip, aria-pressed);
     - rail editor (#railEditor, rebuilt by innerHTML): dropdowns (weld with, recipe, add to weld), sliders (skin,
       wall offset, rotation x3, shift x3, trim inset, fillet, anchor depth, grade), segmented (fill, join rule, shade),
       toggles (trim to nodes, show joins). renderRailEditor is wrapped: after a rebuild the old widgets are destroyed
       and the new rows mounted;
     - Part prep (#ppBox, rebuilt by ppRerender): process and material dropdowns, part axis up segmented, tilt x2,
       overhang limit, standoff and plate opacity sliders;
     - the Export 3MF progress button is fed from the footer progress strip (#pgFill);
     - help: (i) buttons are re-placed after each render (F13Help.refresh), "show" for a control that is not drawn says why.
   The wire mounts the static ones (view tabs, export quality, domain size, mesher / loose pieces / simplify dropdowns,
   section radio and position, rail and tab bar, Export 3MF).
   ========================================================================== */
(function(){
  'use strict';
  const UI=window.F13UI=window.F13UI||{};
  // the wire's own message path ("This control is hidden in the current mode", notes): mesh's toast
  UI.message=function(t){ if(typeof meshToast==='function') meshToast(t); };

  // What the app rebuilds by innerHTML is wrapped here, at load, whether or not the widgets mount: the help (i) buttons
  // must follow every rebuild (also without WebGL). The widget mounts are added to `hooks` once the wire has mounted.
  const hooks={editor:null,prep:null};
  const help=ids=>{ if(window.F13Help) try{ window.F13Help.refresh(ids); }catch(e){ console.error(e); } };
  function wrap(name,after,before){
    const f=window[name];if(typeof f!=='function')return;
    window[name]=function(){
      const ctx=before?before():null;
      const r=f.apply(this,arguments);
      try{after(ctx);}catch(e){console.error(e);}
      return r;
    };
  }
  wrap('renderRailEditor',ed=>{                                          // only a rebuild replaces the editor's children
    const h=document.getElementById('railEditor');if(!h||h.firstElementChild===ed)return;
    help();if(hooks.editor)hooks.editor();
  },()=>{const h=document.getElementById('railEditor');return h?h.firstElementChild:null;});
  wrap('renderRailRecipes',()=>help(['recipes']));
  wrap('renderRailParts',()=>help(['parts']));
  wrap('ppRerender',()=>{help();if(hooks.prep)hooks.prep();});

  UI.ready(function(W){
    const $=id=>document.getElementById(id);
    const css=getComputedStyle(document.documentElement);
    function tok(name,fb){
      const m=css.getPropertyValue(name).match(/oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      return m?{L:+m[1],C:+m[2],h:+m[3]}:fb;
    }
    const ACC=tok('--accent',Liquid.ACCENTS.lime);
    const fire=(el,type)=>el.dispatchEvent(new Event(type,{bubbles:true}));

    const M=UI.mount;                                                    // the kit wire's mount helpers (slider, select, segmented, toggle, mirror)

    // widgets of rebuilt rows: destroyed once their host leaves the DOM (a rebuild removes it)
    const live=new Set();
    function reg(m){ live.add(m); return m; }
    function sweep(){
      for(const m of [...live]) if(!m.host.isConnected){ live.delete(m); setTimeout(()=>{ try{ m.destroy(); }catch(e){} },0); }
    }

    // ---- the kit wire's mount helpers over native controls (state stays in the native; each returns {host,w,destroy}) ----
    // slider cfg: box (receives the widget as first child), row (for the label and (i)), labelEl (the row's <label>), label,
    // min/max/step (else the input's own), detents (array or fn(inp)), fmt (decimals) or format(v)
    const mountSlider=(inp,cfg)=>M.slider(inp,cfg);
    const mountSelect=(sel,o)=>M.select(sel,{ariaLabel:(o&&o.ariaLabel)||sel.getAttribute('aria-label')||''});
    const mountSeg=(group,btns,o)=>M.segmented(group,btns,o);        // a disabled button dims its option; no button on = nothing selected
    const mountToggle=(btn,o)=>M.toggle(btn,o);                      // aria-pressed

    // ---- view menu: 5 checkboxes → label-first toggles ---------------------------------------------------------
    (function viewMenu(){
      const panel=$('viewOptsPanel');if(!panel)return;
      panel.querySelectorAll('input[data-vo]').forEach(cb=>{
        const row=cb.closest('label')||cb,host=document.createElement('div');
        host.className='f13w-tg f13w-tg-menu';row.before(host);row.setAttribute('data-native','toggle');
        let quiet=fn=>fn();
        const w=Liquid.ui.toggle(host,{size:'sm',accent:ACC,checked:cb.checked,label:row.textContent.trim(),labelFirst:true,
          onChange:v=>{quiet(()=>{cb.checked=v;});fire(cb,'change');}});
        quiet=M.mirror(cb,HTMLInputElement.prototype,v=>w.set(!!v),'checked');   // the menu's reset (and any caller) writes .checked
      });
    })();

    // ---- section plane: flip toggle, position readout follows the axis ----------------------------------------
    (function section(){
      const flip=$('secFlip');
      if(flip)mountToggle(flip,{label:'Flip',ariaLabel:'Flip cut side',cls:'f13w-tg-flip'});
      const refresh=()=>setTimeout(()=>{const w=W.sliders&&W.sliders.secPos;if(w)w.configure({});},0);   // re-run the mm readout
      document.querySelectorAll('#secAxis button[data-ax]').forEach(b=>b.addEventListener('click',refresh));
      ['vtab-section'].forEach(id=>{const t=$(id);if(t)t.addEventListener('click',refresh);});
      // the help (i) for the section plane sits on the clip label the wire made
      const lbl=document.querySelector('#w-clip .clip-lbl'),i=document.querySelector('#secPanel .sp-t .f13h-i');
      if(lbl&&i)lbl.appendChild(i);
    })();

    // ---- export quality: the edge length of the chosen tier under the control ----------------------------------
    (function qualityNote(){
      const row=$('grp-quality'),chips=$('qualChips');if(!row||!chips)return;
      const hint=row.querySelector('.dr-hint');if(!hint)return;
      const base=hint.textContent;
      const upd=()=>{
        const q=(typeof currentExportQual!=='undefined')?currentExportQual:'low',e=$('ql'+q.charAt(0).toUpperCase()+q.slice(1));
        const t=e?e.textContent.trim():'';
        const s=t&&t!=='—'?'Triangle edge length of the exported mesh: '+t+'.':base;
        if(hint.textContent!==s)hint.textContent=s;
      };
      new MutationObserver(upd).observe(chips,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['class','aria-pressed']});
      upd();
    })();

    // ---- rail editor ---------------------------------------------------------------------------------------------
    // per-slider options by data-k; rotation / tilt detents at 0 and +-90
    const ROT=[-90,0,90];
    const SL={
      skin:{fmt:2},isoOffsetMm:{fmt:2,detents:[0]},
      rotXDeg:{fmt:0,detents:ROT},rotYDeg:{fmt:0,detents:ROT},rotZDeg:{fmt:0,detents:ROT},
      spatialOffsetMmX:{fmt:2,detents:[0]},spatialOffsetMmY:{fmt:2,detents:[0]},spatialOffsetMmZ:{fmt:2,detents:[0]},
      inset:{fmt:1},'w.fillet':{fmt:2},'w.anchor':{fmt:1},'w.grade':{fmt:1}
    };
    function mountEditor(){
      const ed=$('railEditor');if(!ed||!ed.firstElementChild)return;
      ed.querySelectorAll('select[data-sel]:not([data-native])').forEach(sel=>reg(mountSelect(sel)));
      ed.querySelectorAll('.rl-erow').forEach(row=>{
        const boxes=[...row.querySelectorAll(':scope>.rl-sl')].filter(b=>!b.dataset.w&&b.querySelector('input[type=range]'));
        const one=boxes.length===1&&row.querySelectorAll(':scope>.rl-sl').length===1;
        boxes.forEach(box=>{
          const inp=box.querySelector('input[type=range]'),c=SL[inp.dataset.k]||{},sym=box.querySelector(':scope>span');
          box.dataset.w='1';
          const target=one?row:box;target.classList.add(one?'f13w-sl1':'f13w-sl');
          reg(mountSlider(inp,{box:target,row,labelEl:one?row.querySelector(':scope>label'):null,
            label:sym?sym.textContent.trim():(inp.getAttribute('aria-label')||''),fmt:c.fmt,detents:c.detents}));
        });
      });
      ed.querySelectorAll('.rl-seg[data-seg]:not([data-native])').forEach(seg=>{
        const row=seg.closest('.rl-erow'),l=row&&row.querySelector(':scope>label');
        reg(mountSeg(seg,[...seg.querySelectorAll('button')],{ariaLabel:l?l.textContent.trim():''}));
      });
      ed.querySelectorAll('.rl-hseg:not([data-native])').forEach(seg=>
        reg(mountSeg(seg,[...seg.querySelectorAll('button')],{ariaLabel:'Shade',on:b=>b.getAttribute('aria-pressed')==='true'})));
      ed.querySelectorAll('.rl-sw:not([data-native])').forEach(b=>reg(mountToggle(b,{})));
    }

    // ---- Part prep -----------------------------------------------------------------------------------------------
    const PP={
      tiltX:{min:-180,max:180,step:5,fmt:0,detents:ROT},tiltY:{min:-180,max:180,step:5,fmt:0,detents:ROT},
      crit:{fmt:0},standoff:{fmt:1},plate:{fmt:0}
    };
    function mountPrep(){
      const pb=$('ppBox');if(!pb)return;
      pb.querySelectorAll('select:not([data-native])').forEach(sel=>reg(mountSelect(sel)));
      const up=pb.querySelector('#ppUp:not([data-native])');
      if(up)reg(mountSeg(up,[...up.querySelectorAll('button')],{ariaLabel:'Part axis facing up',on:b=>b.getAttribute('aria-pressed')==='true'}));
      pb.querySelectorAll('[data-pp-row]:not([data-w])').forEach(row=>{       // one slider per row: overhang, standoff, plate opacity
        const inp=row.querySelector('input'),c=PP[row.dataset.ppRow]||{};if(!inp)return;
        row.dataset.w='1';
        reg(mountSlider(inp,{box:row,row,labelEl:row.querySelector(':scope>label'),fmt:c.fmt}));
      });
      pb.querySelectorAll('.pp-sl:not([data-w])').forEach(box=>{                 // tilt X / Y inside one row
        const inp=box.querySelector('input'),c=PP[box.dataset.pp]||{},sym=box.querySelector(':scope>span');
        box.dataset.w='1';box.classList.add('f13w-sl');
        reg(mountSlider(inp,{box,row:box,label:sym?sym.textContent.trim():'',min:c.min,max:c.max,step:c.step,fmt:c.fmt,detents:c.detents}));
      });
    }

    // ---- after what the app rebuilds by innerHTML (the wrappers above call these) ---------------------------------
    hooks.editor=()=>{sweep();mountEditor();};
    hooks.prep=()=>{sweep();mountPrep();};

    // first pass: whatever exists now (a recipe loaded before the wire mounted, Part prep built by dockEnsure)
    sweep();help();mountEditor();mountPrep();

    // ---- Export 3MF progress: the footer progress strip feeds the progress button ---------------------------
    (function runProgress(){
      const pg=$('pgFill'),rb=$('expBtn');if(!pg||!W.run||!rb)return;
      new MutationObserver(()=>{const p=parseFloat(pg.style.width);if(p>0)UI.run.progress(Math.min(1,p/100));}).observe(pg,{attributes:true,attributeFilter:['style']});
      // one bar (Matt, click test): the strip row is hidden under html.f13w (f13ui.css); its stage text and time left
      // become the button's label, and its Cancel sits beside the button while an export runs
      const st=$('pgStage'),eta=$('pgEta'),cx=$('pgCancel'),dock=$('dock'),prog=$('progRow');
      let exporting=false;
      const relabel=()=>{
        if(!exporting||!st)return;
        const s=(st.querySelector('b')||st).textContent.trim()||'Working',e=eta?eta.textContent.trim():'';
        UI.run.label(e?s+' · '+e:s);
      };
      if(st)new MutationObserver(relabel).observe(st,{childList:true,characterData:true,subtree:true});
      if(eta)new MutationObserver(relabel).observe(eta,{childList:true,characterData:true,subtree:true});
      const placeCancel=on=>{
        if(!cx||!dock||!prog)return;
        if(on)dock.appendChild(cx);else prog.appendChild(cx);
        cx.classList.toggle('pg-cancel-dock',on);
      };
      let cancelled=false;
      const cm=window.cancelMesh;
      if(typeof cm==='function')window.cancelMesh=function(){cancelled=true;return cm.apply(this,arguments);};
      const de=window.dockExportState;
      if(typeof de==='function')window.dockExportState=function(on){
        if(on)cancelled=false;
        const r=de.apply(this,arguments);
        exporting=!!on;placeCancel(exporting);
        if(on)setTimeout(relabel,0);
        if(!on)setTimeout(()=>{                                            // done: flood and pop on success, drain on a refusal / failure / cancel
          const ok=!cancelled&&!document.querySelector('#expReport .exp-err');
          UI.run.done(ok);                                                // flood and pop, or drain (a refusal never touches the button)
        },0);
        return r;
      };
    })();

    // ---- help "show": the kit says the note for a control that is not drawn; mesh only opens the Transform fold first ---
    const baseReveal=UI.revealControl;
    UI.revealControl=function(sel,id){
      const t=(sel==null&&id!=null)?(UI.helpTargets||{})[id]:sel,spec=t&&typeof t==='object'&&!t.nodeType?t.sel:t;
      const els=typeof spec==='string'?spec.split(',').map(s=>document.querySelector(s.trim())).filter(Boolean):(spec?[spec]:[]);
      // a control inside the closed Transform fold: open it first (and remember it, as a tap on its header would)
      if(window.railXformOpen&&els.some(e=>e.closest&&e.closest('.rl-xf:not(.open)')))window.railXformOpen(true);
      return baseReveal.call(this,sel,id);
    };
    UI.revealControl.f13wire=true;
  });
})();
