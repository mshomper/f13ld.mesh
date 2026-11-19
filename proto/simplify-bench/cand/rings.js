/* proto/simplify-bench/cand/rings.js - one-line experiment: today's safeSimplify, but the tear lock starts at 3-4
   rings instead of 1 (SAFE_SIMPLIFY_RINGS in m35 is [1,1,2,2,3,3,4,6,8,10,12,12]), so fewer whole-slab retries
   are needed. Output changes. Evaluate after worker/m35-slab-cleanup.js. Licence: MIT (F13LD.mesh). */
'use strict';
SAFE_SIMPLIFY_RINGS=[3,3,4,4,6,8,10,12,12,12,12,12];
