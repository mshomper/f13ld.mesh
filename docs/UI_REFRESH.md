# F13LD.mesh — UI refresh log

| Stage | Date | Branch | Commit | Checks | Open decisions |
|---|---|---|---|---|---|
| 1. Audit | 2026-11-26 | `ui-refresh` | see `git log` ("stage 1 audit") | 17 screenshots 1440/1024/700/390; no horizontal scroll; 0 page errors; 135 controls mapped | none, all answered below. See `docs/UI_AUDIT.md` |

## Decisions (Matt, 2026-11-26)

Shared with wave 1 (answered once for all tools): render quality automatic, with no manual preview quality; bake fixed, erring precise; low-res preview while dragging only if it doesn't slow things; clear analysis results when the design changes; add missing help cards; hit areas never overlap; slider-head value and (i) stay ~28 px tall.

This tool:
- **Accent:** `oklch(0.80 0.13 345.7)` = `#f99ad0`, from brand stroke `#6B0A4C`. The selected-part outline stays lime.
- **Layout as proposed:** controls stay on the left with sections 01 Design / 02 Prep / 03 Export. The Configure drawer and the dock tags go. Export 3MF sits in a footer under every section. The inspector stays on the right at 1280 px and wider, and goes into Export as Results below that. Phone: viewer on top, bottom sheet with a Design / Prep / Export tab bar.
- **Exports stay byte-identical to main.** The preview bake is fixed at today's High, but the export's field range (`recipe._previewFieldMin/Max`) must not change because of it. Take it from its own fixed bake that matches what main produces, or otherwise prove identical bytes with the harness.
