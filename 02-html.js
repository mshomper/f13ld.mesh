/* ============================================================
   F13LD.mesh · 02-html.js
   HTML escaping for any text that comes from a recipe, a file name,
   or an error message and is placed into markup (v0.8.1).
   ============================================================ */
'use strict';

// Escape a value for use as HTML text or a quoted attribute value.
// null/undefined become '' so callers can pass optional fields directly.
function esc(v){
  if(v==null) return '';
  return String(v)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}
