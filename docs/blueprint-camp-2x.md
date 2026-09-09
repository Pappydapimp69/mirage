# Blueprint — the camp at twice the area

**Ask:** the camp map should be twice the size. Read as twice the AREA (the
file's own precedent: the last enlargement doubled each side and called it
"FOUR TIMES THE AREA"). Playable ground 41x41 cells -> 58x58, 1681 -> 3364.

**The obstacle.** `GRID = 46` is a module constant in `world.js` that every
consumer imports directly. `world.grid` and `world.cell` already exist in the
returned shape and NOTHING reads them — one truth, two homes, the second one
dead. The camp is already at `MARGIN = 3` inside that 46, so it cannot grow
without a grid of its own.

**Change.**
1. `world.js` — `GRID` becomes explicitly the BASIN grid. `cellToWorld` /
   `worldToCell` / `inBounds` take `grid` as a REQUIRED argument (guarded, so a
   missed call site throws instead of quietly placing things on the wrong map).
   `floodFill` derives its stride from `blocked.length`. `isBlockedAt`,
   `moveWithCollision`, `validate`, `findPath` read `world.grid` — the field
   stops being decorative. `findPath`'s module-level scratch buffers grow to fit
   the world they are handed, or a 63-grid silently truncates every path.
2. `camp.js` — `CAMP_GRID = 63`. The authored table is re-placed by scaling
   positions about the playable centre while KEEPING object sizes: cabins and
   path widths do not grow, the ground between them does. Thin wood keeps its
   density (35 -> 59 cells) by reflecting the authored cells through the centre,
   not by lattice — a lattice reads as an orchard.
3. `render.js`, `party.js`, `tests/*` — read `world.grid`, never the import.

**Ripples predicted.** `tests/camp.mjs` asserts `camp.blocked.length ===
basin.blocked.length` and `camp.grid === GRID`; both encode "same grid", not the
shape contract, and both must change. It also asserts the camp is SMALLER than a
basin (1581 open vs ~1701) — at twice the area the camp is bigger than a basin,
so that assertion is now backwards and the intent it guards has to be restated.

**Verify.** Pure suite after each step; negative-control the new grid guard by
dropping the argument at a real call site and watching it throw; browser suite
once at the end.
