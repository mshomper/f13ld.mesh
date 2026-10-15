# F13LD.mesh — instructions for Claude

## Commits and pull requests
- Do not add session links (e.g. `Claude-Session: https://claude.ai/...`) to commit messages, pull request descriptions or any file in this repo.
- `Co-Authored-By: Claude …` trailers are fine.

## Code layout
- Numbered classic scripts share one global scope and load in numeric order (see README → Project structure). Top-level code that runs at load time may only use things defined in the same or a lower-numbered file.
- Worker code lives in `worker/`. Bump `F13LD_MESH_VERSION` in `01-config.js` and the header label in `index.html` on every release.
- Serve over http(s) to test; `file://` does not work.

## Testing
- Long or core-heavy checks are Matt's to run on his machine with `tests/regress.html` (bench page, opened from the branch via raw.githack); don't spend session time running them headless.
- `tests/` holds a dev-only browser harness (see `tests/README.md`). Before merging any change, run `tests/harness.js <old build> <new build>`: open-cube exports for families the change doesn't touch should stay byte-identical.
- v0.9.10 hyperuniform speed: `worker/m11-grain-fields.js` `buildHUIndex` bins HU kernels (cached on the kernel array as `_huIdx` / `_huIdxP`) for `evalHUField` and `evalHUFieldPeriodic`; terms below e^-40 after the blend root are skipped, same rule as F13LD.lab v0.29.2. Harness `hyperuniform` exports byte-identical; shape-mode `evalHUFieldMM` (own hash) unchanged.
- v0.10.0 part prep: `52-materials.js` (densities copied from F13LD.lab `15c-materials.js`) and `53-part-prep.js` (panel, live estimate, exact stats, build orientation, print report). Build orientation at +Z / no tilt must leave the 3MF byte-identical; `tests/partprep.js <build>` checks the numbers.
- v0.11.0 speed: single-body exports (open cube and shape-clipped) pre-bake the field on all but one core from inside the mesh worker (`worker/m33-field-pool.js` → `field-bake-worker.js`); both build the field through `worker/m32-export-field.js`, so any change to the shape-clipped field goes there. TPMS term lists are built once into a function (`compileTermsList`, `m20`), bit-identical to the old loop. Check with `QUAL=med CORES=3 VERBOSE=1 node tests/harness.js <old> <new>` (every point `cached`, `direct` 0, identical) and `tests/fieldbake.js`.
- Latest session recap: `docs/SESSION_RECAP_2026-10-15b.md` (v0.11.0 multi-core field bake); before it `docs/SESSION_RECAP_2026-10-15.md` (v0.10.0 part prep); before it `docs/SESSION_RECAP_2026-10-14.md` (v0.9.10 hyperuniform kernel index); before it `docs/SESSION_RECAP_2026-10-11.md` (v0.9.9 noise revision 2, `surface.noise_rev`; revision 1 recipes must keep printing exactly as before); before it `docs/SESSION_RECAP_2026-10-10.md` (v0.9.8 wave cell stretch, `field.stretch`); before that `docs/SESSION_RECAP_2026-10-08.md` (v0.9.7 grain generator). Next steps: `docs/SESSION_RECAP_2026-10-04.md` (previous: `docs/SESSION_RECAP_2026-10-02.md`). Findings history: `docs/REVIEW_v0.8.0.md`.
