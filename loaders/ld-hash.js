/* ============================================================
   F13LD.mesh · loaders/ld-hash.js
   #r=<recipe JSON> — same as ?r=, but after "#". The fragment never leaves
   the browser, so there's no server limit on its length. F13LD.foam uses it
   because its recipes carry every seed position (up to ~28 KB).
   ============================================================ */
'use strict';
registerLoader({
  id: 'hash', priority: 15,
  matches(p, loc){ return /^#r=/.test(loc.hash||'') && !p.get('queue'); },
  load(p, loc){
    const raw=loc.hash.slice(3);
    let json;
    try{ json=JSON.parse(decodeURIComponent(raw)); }
    catch(e1){
      try{ json=JSON.parse(raw); }
      catch(e2){ setTimeout(()=>showError('Could not read the recipe in this link — '+e1.message),0); return; }
    }
    setTimeout(()=>{
      try{ openRecipe(parseRecipe(json,'Link recipe')); }
      catch(e){ showError(e.message); }
    },0);
  },
});
