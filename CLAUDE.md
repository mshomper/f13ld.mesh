# F13LD.mesh — instructions for Claude

## Commits and pull requests
- Do not add session links (e.g. `Claude-Session: https://claude.ai/...`) to commit messages, pull request descriptions or any file in this repo.
- `Co-Authored-By: Claude …` trailers are fine.

## Code layout
- Numbered classic scripts share one global scope and load in numeric order (see README → Project structure). Top-level code that runs at load time may only use things defined in the same or a lower-numbered file.
- Worker code lives in `worker/`. Bump `F13LD_MESH_VERSION` in `01-config.js` and the header label in `index.html` on every release.
- Serve over http(s) to test; `file://` does not work.

## Testing
- `tests/` holds a dev-only browser harness (see `tests/README.md`). Before merging any change, run `tests/harness.js <old build> <new build>`: open-cube exports for families the change doesn't touch should stay byte-identical.
- Latest session recap and next steps: `docs/SESSION_RECAP_2026-10-02.md`. Findings history: `docs/REVIEW_v0.8.0.md`.
