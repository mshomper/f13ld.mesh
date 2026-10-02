/* ============================================================
   F13LD.mesh · loaders/ld-queue.js
   ?queue=<code> — load a saved F13LD.queue collection. Stocks the recipe
   library with up to MAX_RECIPES items. Takes priority over ?r=.
   (Moved verbatim from 99-init.js in v0.9.0.)
   ============================================================ */
'use strict';
// v0.8.1: every item is checked before anything is added; unreadable items are
// skipped and reported instead of stopping the load part-way with no message.
registerLoader({
  id: 'queue', priority: 10,
  matches(p){ return !!p.get('queue'); },
  load(p){
    const code=p.get('queue');
    const URL='https://axinljpecycnvfncyhfs.supabase.co/rest/v1/rpc/queue_fetch';
    const KEY='sb_publishable_DAlrNLqbUZiwkaA6wPSMIw_YUNY85LX';
    fetch(URL,{method:'POST',headers:{apikey:KEY,Authorization:'Bearer '+KEY,'Content-Type':'application/json'},body:JSON.stringify({p_code:code})})
      .then(r=>r.ok?r.json():Promise.reject(new Error('HTTP '+r.status)))
      .then(res=>{
        const items=(res&&res.items)||[];
        if(!items.length){showError('Queue "'+code+'" is empty or not found.');return;}
        const good=[], bad=[];
        items.forEach((it,i)=>{
          try{ good.push(parseRecipe(it&&it.recipe,'Queue item '+(i+1))); }
          catch(e){ bad.push(e.message); }
        });
        if(!good.length){showError('None of the recipes in queue "'+code+'" could be read. '+bad[0]);return;}
        const load=good.slice(0, Math.max(0, MAX_RECIPES-recipes.size));
        if(!load.length){showError('Recipe library is full — clear a recipe before loading a queue.');return;}
        setTimeout(()=>{
          for(let i=0;i<load.length-1;i++) setActiveRecipe(load[i]);
          openRecipe(load[load.length-1]);
          const notes=[];
          if(good.length>load.length) notes.push('Loaded '+load.length+' of '+good.length+' — limit is '+MAX_RECIPES+'.');
          if(bad.length) notes.push(bad.length+' item'+(bad.length>1?'s':'')+' skipped (unreadable).');
          if(notes.length) showCapToast(notes.join(' '));
          if(bad.length) console.warn('[queue] skipped items:',bad);
        },0);
      })
      .catch(e=>showError('Could not load queue — '+e.message));
  },
});
