# Blueprint — the basin at twice the area

**Ask:** double the basin map, the step after doubling the camp (0.14.0).
Twice the AREA again: `GRID` 46 -> 65 (46*sqrt2 = 65.05), 2116 -> 4225 cells.

**Why this one is cheap and the camp was not.** The camp is authored, so every
cabin and path cell had to be re-placed by hand. A basin is generated, so the
grid is already a parameter of the generator — and 0.14.0's per-world-grid work
means `world.grid` is now the thing every consumer reads. This is a constant and
the density numbers tuned against it, nothing more.

**The density constants that must move with it, or the basin gets emptier
rather than bigger.**
- `clusters = 26` rock blobs -> 52. Count scales with AREA; blob length is a
  shape and does not.
- `r < 3` ridges -> 6, same reason. Their LENGTH stays: a ridge's job is to
  break a sightline, and sightlines are in world units, which do not change.
- `minSep = 6` between features -> 8, and the camp exclusion 9 -> 13. Both scale
  with the LINEAR factor (sqrt2), not the area.
- `campSeed` ranges are absolute offsets from the SW corner; scaled likewise.
- height field `LN = 12` -> 17, or the same twelve lattice cells stretch over
  twice the ground and the basin floor smooths out.

**What deliberately does NOT move.** MONOLITH/PYLON/ITEM/TREE/STONE counts, and
every constant in `state.js` — `TIME_LIMIT`, `LUCIDITY_GRACE`, the radii. Those
are the difficulty model, and the open balance question is the owner's to
decide. `MONOLITH_NAMES` caps monoliths at 8 anyway.

**Ripples predicted.**
1. Every seed generates a DIFFERENT world, so any save in the wild would resume
   into a basin that no longer matches its stored positions. `SAVE_VERSION`
   4 -> 5; `deserializeRun` already discards a payload whose version differs.
2. `tests/camp.mjs` "the camp is larger than a basin, deliberately" was written
   yesterday and is about to be false again — a 65-grid basin (~3400 open cells)
   is bigger than the 63-grid camp (3235). That RESOLVES the tension filed with
   0.14.0 rather than contradicting it, and the assertion goes back to what it
   was for the camp's whole life.
3. Difficulty moves whether or not a difficulty constant is touched: the basin
   is 169m across instead of 120m, against an unchanged `TIME_LIMIT = 780`.
   Measure `tests/balance.mjs` on the same seeds before and after and REPORT the
   delta; do not tune it back.

**Verify.** Pure suite after each step. `validate()` reachability and the repair
pass's `repairs` count across many seeds — a bigger grid with the same corridor
carver is where connectivity would quietly degrade. Balance on the same seed
count before and after. Browser tier once at the end.
