/* proto/simplify-bench/cand/a.js - candidate A: today's wrapper with meshoptimizer 1.1.1's Regularize flag
   (every other flag and check unchanged). Evaluated after worker/m35-slab-cleanup.js. Not used: Permissive
   (relaxes the locked / seam classification), Prune (deletes small pieces: could remove intended disconnected
   regions), RegularizeLight (not in 1.1.1). Licence: MIT (F13LD.mesh). */
'use strict';
var _safeSimplifyToday=safeSimplify;
safeSimplify=function(pos, idx, tol, open, flags, shared, seed, noRing){
  return _safeSimplifyToday(pos, idx, tol, open, (flags||[]).concat(['Regularize']), shared, seed, noRing);
};
