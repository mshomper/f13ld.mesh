/* ============================================================
   F13LD.mesh · loaders/ld-link.js
   ?r=<recipe JSON> — the URL handoff every design tool uses.
   (Moved verbatim from 99-init.js in v0.9.0.)
   ============================================================ */
'use strict';
// v0.8.1: URLSearchParams already decodes the value once. Decoding again broke
// any recipe containing a "%" character; that second decode is now only a
// fallback for links that were double-encoded.
registerLoader({
  id: 'link', priority: 20,
  matches(p){ return p.has('r') && !p.has('queue'); },
  load(p){
    const raw=p.get('r');
    let json;
    try{ json=JSON.parse(raw); }
    catch(e1){
      try{ json=JSON.parse(decodeURIComponent(raw)); }
      catch(e2){ setTimeout(()=>showError('Could not read the recipe in this link — '+e1.message),0); return; }
    }
    setTimeout(()=>{
      try{ openRecipe(parseRecipe(json,'Link recipe')); }
      catch(e){ showError(e.message); }
    },0);
  },
});
