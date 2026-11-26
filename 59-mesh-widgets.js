/* ============================================================================
   F13LD.mesh · 59-mesh-widgets.js — UI refresh stage 3: the liquid widgets the wire (58-f13ui-wire.js CONFIG)
   does not mount by itself. Pattern: the template README, "Controls the app rebuilds" (TPMS mountTermToggles).

   Every widget drives the app through its NATIVE control (set the value and dispatch input / change, or click the
   native button), so the app's own handlers run and exports stay byte-identical. The app reaches the widget through a
   value / checked override on the native element (mirrorValue) or a MutationObserver on the native button.

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
    const decimals=s=>{const t=String(s);return t.indexOf('.')<0?0:t.split('.')[1].length;};

    // native.value / native.checked written by the app → widget (the template's mirrorValue, for either property)
    function mirror(el,proto,prop,onWrite){
      const d=Object.getOwnPropertyDescriptor(proto,prop);let q=false;
      Object.defineProperty(el,prop,{configurable:true,enumerable:true,
        get(){return d.get.call(this);},
        set(v){d.set.call(this,v);if(!q)onWrite(d.get.call(this));}});
      return fn=>{q=true;try{fn();}finally{q=false;}};
    }

    // widgets of rebuilt rows: destroyed once their host leaves the DOM (a rebuild removes it)
    const live=new Set();
    function reg(m){ live.add(m); return m; }
    function sweep(){
      for(const m of [...live]) if(!m.host.isConnected){ live.delete(m); setTimeout(()=>{ try{ m.destroy(); }catch(e){} },0); }
    }

    // ---- slider over a native number / range input -------------------------------------------------------------
    // cfg: box (element that receives the widget as its first child), row (for the label and (i)), labelEl (the row's
    // <label>, moved into the widget head), label (text when there is no labelEl), min/max/step (else the input's own),
    // detents (array or fn(inp)), fmt (decimals) or format(v)
    function mountSlider(inp,cfg){
      const host=document.createElement('div');host.className='f13w-slider';cfg.box.insertBefore(host,cfg.box.firstChild);
      const rng=()=>({min:cfg.min!=null?cfg.min:+inp.min,max:cfg.max!=null?cfg.max:+inp.max,step:cfg.step!=null?cfg.step:(+inp.step||0)});
      const det=()=>typeof cfg.detents==='function'?cfg.detents(inp):(cfg.detents||[]);
      const r0=rng(),dec=cfg.fmt!=null?cfg.fmt:decimals(inp.step||'0.01');
      let quiet=fn=>fn();
      const w=Liquid.ui.slider(host,{min:r0.min,max:r0.max,step:r0.step,value:+inp.value,
        label:cfg.labelEl?cfg.labelEl.textContent.trim():(cfg.label||''),accent:ACC,unit:cfg.unit||'',
        format:cfg.format||(v=>(+v).toFixed(dec)),detents:det(),
        onInput:v=>push(v,false),onChange:v=>push(v,true)});
      function push(v,commit){
        quiet(()=>{inp.value=v;fire(inp,'input');if(commit)fire(inp,'change');});
        if(commit&&+inp.value!==w.get())w.set(+inp.value);                // show what the app accepted
      }
      quiet=mirror(inp,HTMLInputElement.prototype,'value',v=>w.set(+v));
      if(cfg.labelEl){                                                     // the row's own <label> becomes the widget label (the (i) goes with it)
        const lab=cfg.labelEl,ks=host.querySelector('.lq-sl-label'),wrap=document.createElement('span');
        wrap.className='f13w-lab';
        if(lab.id){
          host.querySelectorAll('[aria-labelledby~="'+ks.id+'"]').forEach(e=>e.setAttribute('aria-labelledby',e.getAttribute('aria-labelledby').split(/\s+/).map(t=>t===ks.id?lab.id:t).join(' ')));
        }else lab.id=ks.id;
        ks.removeAttribute('id');lab.removeAttribute('for');
        wrap.appendChild(lab);ks.replaceWith(wrap);
        if(cfg.row)[...cfg.row.children].forEach(c=>{if(c!==host&&c!==lab&&c.matches&&c.matches('button[class*="f13h-"]'))wrap.appendChild(c);});
      }
      // the app re-ranging the native input (shift sliders follow the cell size / recipe period) re-ranges the widget
      const mo=new MutationObserver(()=>{w.setRange({...rng(),detents:det()});w.set(+inp.value);});
      mo.observe(inp,{attributes:true,attributeFilter:['min','max','step']});
      return {host,w,destroy(){mo.disconnect();w.destroy();}};
    }

    // ---- native <select> → dropdown (state stays in the select) ------------------------------------------------
    function groupsOf(sel){
      const out=[];let loose=null;
      [...sel.children].forEach(c=>{
        const opt=o=>({value:o.value,label:o.textContent,disabled:o.disabled});
        if(c.tagName==='OPTGROUP'){loose=null;out.push({label:c.label,options:[...c.querySelectorAll('option')].map(opt)});}
        else if(c.tagName==='OPTION'){if(!loose){loose={label:'',options:[]};out.push(loose);}loose.options.push(opt(c));}
      });
      return out;
    }
    function mountSelect(sel,o){
      const host=document.createElement('div');host.className='f13w-dd';
      sel.setAttribute('data-native','select');sel.after(host);
      let quiet=fn=>fn();
      const gs0=groupsOf(sel);
      const w=Liquid.ui.dropdown(host,{groups:gs0,value:sel.value,accent:ACC,ariaLabel:(o&&o.ariaLabel)||sel.getAttribute('aria-label')||'',
        onChange:v=>{quiet(()=>{sel.value=v;});fire(sel,'change');}});
      quiet=mirror(sel,HTMLSelectElement.prototype,'value',v=>w.set(v));
      let seen=JSON.stringify(gs0);
      const mo=new MutationObserver(()=>{const gs=groupsOf(sel),k=JSON.stringify(gs);if(k===seen)return;seen=k;w.setOptions(gs,{value:sel.value});});
      mo.observe(sel,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','label','value']});
      return {host,w,destroy(){mo.disconnect();w.destroy();}};
    }

    // ---- native button group → segmented (clicks the native button, so the app's handler runs) --------------------
    function mountSeg(group,btns,o){
      const host=document.createElement('div');host.className='f13w-seg';
      group.before(host);group.setAttribute('data-native','seg');
      const on=o.on||(b=>b.classList.contains('on'));
      const idx=()=>btns.findIndex(on);
      const w=Liquid.ui.segmented(host,{options:btns.map((b,i)=>({value:i,label:(b.textContent||'').trim()||b.getAttribute('aria-label')||String(i)})),
        value:Math.max(0,idx()),accent:ACC,ariaLabel:o.ariaLabel||'',
        onChange:v=>{const b=btns[v];if(b&&!b.disabled)b.click();setTimeout(sync,0);}});   // a disabled option: the pill returns to the real choice
      function sync(){
        if(!host.isConnected)return;
        const i=idx();if(i>=0)w.set(i);
        host.classList.toggle('f13w-idle',i<0);                          // nothing chosen (an unset colour): dim, no pretend choice
        host.querySelectorAll('.lq-seg-opt').forEach((x,j)=>{if(btns[j])x.toggleAttribute('data-off',!!btns[j].disabled);});
      }
      const mos=btns.map(b=>{const m=new MutationObserver(sync);m.observe(b,{attributes:true,attributeFilter:['class','aria-pressed','disabled']});return m;});
      sync();
      return {host,w,destroy(){mos.forEach(m=>m.disconnect());w.destroy();}};
    }

    // ---- native switch button (aria-pressed) → toggle ------------------------------------------------------------
    function mountToggle(btn,o){
      const host=document.createElement('div');host.className='f13w-tg f13w-tg-sw'+(o.cls?' '+o.cls:'');
      btn.before(host);btn.setAttribute('data-native','toggle');
      const on=()=>btn.getAttribute('aria-pressed')==='true';
      const w=Liquid.ui.toggle(host,{size:'sm',accent:ACC,checked:on(),label:o.label||'',ariaLabel:o.ariaLabel||btn.getAttribute('aria-label')||'',
        onChange:v=>{if(on()!==v)btn.click();}});
      const mo=new MutationObserver(()=>w.set(on()));
      mo.observe(btn,{attributes:true,attributeFilter:['aria-pressed']});
      return {host,w,destroy(){mo.disconnect();w.destroy();}};
    }

    // ---- view menu: 5 checkboxes → label-first toggles ---------------------------------------------------------
    (function viewMenu(){
      const panel=$('viewOptsPanel');if(!panel)return;
      panel.querySelectorAll('input[data-vo]').forEach(cb=>{
        const row=cb.closest('label')||cb,host=document.createElement('div');
        host.className='f13w-tg f13w-tg-menu';row.before(host);row.setAttribute('data-native','toggle');
        let quiet=fn=>fn();
        const w=Liquid.ui.toggle(host,{size:'sm',accent:ACC,checked:cb.checked,label:row.textContent.trim(),labelFirst:true,
          onChange:v=>{quiet(()=>{cb.checked=v;});fire(cb,'change');}});
        quiet=mirror(cb,HTMLInputElement.prototype,'checked',v=>w.set(!!v));   // the menu's reset (and any caller) writes .checked
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
      new MutationObserver(()=>{const p=parseFloat(pg.style.width);if(p>0)W.run.setProgress(Math.min(1,p/100));}).observe(pg,{attributes:true,attributeFilter:['style']});
      // one bar (Matt, click test): the strip row is hidden under html.f13w (f13ui.css); its stage text and time left
      // become the button's label, and its Cancel sits beside the button while an export runs
      const st=$('pgStage'),eta=$('pgEta'),cx=$('pgCancel'),dock=$('dock'),prog=$('progRow');
      let exporting=false;
      const relabel=()=>{
        if(!exporting||!st)return;
        const s=(st.querySelector('b')||st).textContent.trim()||'Working',e=eta?eta.textContent.trim():'';
        W.run.setLabel(e?s+' · '+e:s);
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
          W.run.setProgress(ok?1:null);
          rb.disabled=true;rb.disabled=false;                             // lets the wire's watcher clear its busy state (a refusal never touches the button)
        },0);
        return r;
      };
    })();

    // ---- help "show": a control that is not drawn (no part selected, another fill / rule) says why ---------
    const baseReveal=UI.revealControl;
    UI.revealControl=function(sel,id){
      const t=(sel==null&&id!=null)?(UI.helpTargets||{})[id]:sel,spec=t&&typeof t==='object'&&!t.nodeType?t.sel:t;
      const els=typeof spec==='string'?spec.split(',').map(s=>document.querySelector(s.trim())).filter(Boolean):(spec?[spec]:[]);
      if(!els.length){UI.message((t&&t.note)||'This control is not shown right now.');return false;}
      // a control inside the closed Transform fold: open it first (and remember it, as a tap on its header would)
      if(window.railXformOpen&&els.some(e=>e.closest&&e.closest('.rl-xf:not(.open)')))window.railXformOpen(true);
      return baseReveal.call(this,sel,id);
    };
    UI.revealControl.f13wire=true;
  });
})();
