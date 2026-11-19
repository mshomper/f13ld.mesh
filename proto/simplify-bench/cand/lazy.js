/* proto/simplify-bench/cand/lazy.js - B1a-lazy: evaluate after cand/fast.js. Skips the up-front closed check of the
   input; it runs only if the first meshopt result reports a tear or a changed seam edge. Same output as today whenever
   the input is closed (m34 raw slabs are); an open input is still returned unsimplified and flagged unsafe. */
'use strict';
B1A_LAZY=true;
