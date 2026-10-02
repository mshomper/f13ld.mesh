# Session recap — 2026-10-01 → 10-02

## Shipped (all merged to main, live on GitHub Pages)

| Version | What | Details |
|---|---|---|
| v0.8.0 | Split the 8,591-line `index.html` into numbered files (F13LD.lab layout) and worker files per family | `docs/REVIEW_v0.8.0.md` §1 |
| v0.8.1 | Safety and crash fixes; grain zero values match F13LD.grain; removing the last recipe keeps bodies | §7 |
| v0.8.2 | Geometry accuracy: shape-clipped exports at CAD size, RD seams, HU/RD preview match, weld HU, trim radius, coarse pass, 3MF transforms/units, welding | §8 |
| v0.8.3 | Leftover state bugs and quick wins | §9 |

Every release was checked with the harness in `tests/` (see `tests/README.md`). Open-cube exports for unaffected families stayed byte-identical through all four releases.

## Decisions made

- The split follows F13LD.lab: numbered classic scripts sharing one global scope, plus one ES module (`00-libs.js`) for CDN libraries. The page needs http(s).
- Grain: κ = 0 means isotropic; an orthotropic weight of 0 means none on that axis (as F13LD.grain does).
- Removing the last recipe keeps bodies (as solid).
- Shape-clipped exports changed size by up to ~0.4 mm per side in v0.8.2 to match CAD (approved).
- three.js stays on two pinned CDN sources (jsdelivr for the page, esm.sh for the shape worker). Reasoning is in §9.

## Next: plug-in restructure (review §4), tested with Matt's new design tool

Goal: adding a design tool or recipe loader is one family file plus one worker SDF file, with no edits scattered across the app.

### 1. Family registry
New folder `families/`: `fam-tpms.js`, `fam-beam.js`, `fam-grain.js`, `fam-noise.js`, `fam-bundle.js`, `fam-wave.js`, loaded before `40-…`. Each calls:

```js
registerFamily({
  id, label, color,
  detect(json)             -> subtype | null,      // replaces the routeRecipe branches
  validate(json)           -> throws on bad input,  // replaces validateRecipe branches
  summary(recipe)          -> html (escaped),       // replaces build*Summary
  isPeriodic(recipe),                               // replaces recipeIsPeriodic
  bakeBounds(recipe)       -> {wMin,wMax,S?},       // replaces the compute*BakeBounds chain
  stochastic,                                       // raw normalized bake + slab-parallel
  maxExportVoxels,
  thinnestFeatureMm(recipe, cellMm),
  wallFraction(recipe),                             // for the estimates
  defaultCellMm(recipe),                            // beam's geometry.cell
  options: { trimToNodes },
});
```

The places that branch on family today are all listed in the three reviewer reports (summarised in review §4). Each becomes a registry lookup.

### 2. Worker side
`worker/m2x-sdf-<family>.js` calls `registerSDF(id, buildFn)`. `buildSDF` in `m30` looks the family up, and the worker's raw-bake branch asks the registry whether the family is stochastic. `mesh-worker.js` keeps one `importScripts` list.

### 3. Shared files
New folder `shared/`, loaded by the page (script tag) and by workers (`importScripts`):
- bundle cell helpers (`43-bundle-cells.js` ↔ `m23`),
- hyperuniform kernel helpers (`hu-bake-worker.js` ↔ `m11`/`m22`),
- `grainParamsFromField` (worker) ↔ the main-thread `huParams` builder in `61-export.js`.

### 4. Loader pipeline
`registerLoader({id, matches(params), load()})` for `?r=`, `?queue=`, file drop/pick, all feeding `parseRecipe` → `openRecipe`. Future sources (e.g. `?vault=`) are one file.

### Verification plan
1. Restructure the six existing families onto the registry with no behavior change. `tests/harness.js` must report all cases byte-identical to v0.8.3, and `fixtests*.js` must still pass.
2. Add Matt's new tool as a seventh family using only `families/fam-<new>.js` + `worker/m2x-sdf-<new>.js` (+ two script-list lines). Any other edit it needs is a gap in the registry, to be fixed in the registry itself.
3. Add a recipe for the new tool to `tests/recipes.json`.

### What the new session needs from Matt
- The new design tool: repo name or file, and one or two exported recipe JSONs.
- Its SDF/field math, if it isn't already in the tool's source.
- How its recipes identify themselves (a `family` value?) and which geometry modes it supports (sheet / solid / half…).

## Update — v0.9.0 and v0.9.1 (same day)

| Version | What | PR |
|---|---|---|
| v0.9.0 | Family, worker SDF and loader registries (steps 1, 2, 4 above). Harness: all 14 cases byte-identical to v0.8.3. | #6 |
| v0.9.1 | F13LD.foam as the seventh family (`fam-foam.js` + `m25-sdf-foam.js`, one script line each — no registry gaps) and the `#r=` loader. Existing cases byte-identical to v0.9.0. | #7 |

Decisions: mesh accepts **periodic foams only** (F13LD.foam refuses the handoff otherwise); foam links use `#r=` because recipes carry every seed position; the `FoamSeeds` generator is shared byte-for-byte with F13LD.foam (`tests/foamseeds.js`).

Still open: step 3 (`shared/` de-duplication), deferred on purpose. Foam stiffness estimate is next on the F13LD.foam side.
