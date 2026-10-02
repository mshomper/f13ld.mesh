# F13LD.mesh — dev test harness

Dev-only. Nothing here is loaded by the app or served to users.

Every test runs the real app in headless Chromium. CDN requests are answered from the locally installed npm packages, at the exact versions the app pins, so tests run offline and old and new builds load identical libraries.

## Setup

```
cd tests
npm install            # same pinned versions as the app's CDN imports, plus playwright
python3 fixtures/make_bigsphere.py   # only needed for the large-OBJ import test
```

Chromium must be available to Playwright (`PLAYWRIGHT_BROWSERS_PATH`).

## Comparing two builds

Most scripts take two folders: an older build and a newer one. Each is a plain copy of the repo, e.g. a `git worktree` or an exported tag.

| Script | What it checks |
|---|---|
| `harness.js <old> <new> [filter]` | Exports every case in `recipes.json` (all families + shape mode) at Draft from both builds; compares 3MF mesh data byte for byte. Main regression check. |
| `fixtests.js <old> <new> [filter]` | v0.8.1 safety/crash fixes (escaping, `%` links, bad recipes, 2-core hyperuniform, warped bundle, large OBJ, overlapping exports, cancel, keep bodies, κ = 0). |
| `fixtests2.js <old> <new> [filter]` | v0.8.3 fixes (stale preview range, cube voxel cap, body removal/import/camera, structure settings, preview quality, domain size, solid export). |

## Single-build checks

| Script | What it checks |
|---|---|
| `measure.js <build> <label> [draft,med,…]` | Exports a fully solid fill clipped to a 50 × 14 × 6 mm box and a Ø20 × 20 mm cylinder; reports size error per side and radial error. Set `ONLY=box` or `ONLY=cyl` to run one. |
| `importtest.js <build> <label>` | STL with real normals welds watertight; inch-unit, moved 3MF lands in mm at the right place. |
| `a6test.js <build> <label>` | Thin-strut beam in shape mode exports (coarse pass fallback). |
| `fieldtest.js <build> <label>` | Loads the worker SDF code in Node; checks preview-vs-export agreement for hyperuniform/RD, RD tile seam, weld hyperuniform tiling. |
| `radtest.js <build>` | Trim-to-nodes strut radius vs measured radius. |
| `loadorder.js <build>` | Static check that no load-time code uses something from a later-numbered file. |

## Notes

- Shape-mode cases report 8 cores (`"cores"` in `recipes.json`) so the worker-pool paths run.
- Imported bodies default to Solid; tests click the recipe chip to assign it before exporting.
- The thin-strut beam case is left out of `recipes.json`, because older builds fail it by design (finding A6).
