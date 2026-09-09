// camp.js — THE CAMP: the one authored map in the game.
//
// Every basin comes from `generateWorld(seed)`. This does not. The camp is
// hand-placed and identical every single time: the same path, the same cabins,
// the same trees, the same two pylons in the same two spots. A player who
// learns where something is here is right forever, which is the whole point —
// this is the place you know before you go somewhere you don't.
//
// WHY AUTHORED, AND WHAT IT COSTS.
// `generateWorld` owns reachability: it scatters rock with local rules, then
// runs an explicit repair pass (flood-fill from camp, carve a corridor to
// anything stranded, re-fill) and `validate()` re-derives the result from
// scratch. Placing cells by hand opts out of every one of those guarantees. A
// cabin wall one cell too long seals a pocket and nothing complains. So this
// module earns them back the only honest way: `buildCamp()` returns the exact
// same shape `generateWorld` does, and `tests/camp.mjs` runs the SAME
// `validate()` over it, plus a check the generator never needed — that a
// continuous 30m walk exists, because objective 1 requires one.
//
// The shape contract is load-bearing. save.js, render.js, state.js and party.js
// all consume a world without caring where it came from, and the moment this
// returns something subtly different — a missing `heightAt`, a `blocked` of the
// wrong length — the failure surfaces somewhere far away as a NaN position or
// an invisible floor. The returned object is asserted field-for-field in tests.

import { CELL, FEATURE, cellToWorld, floodFill, gridOf } from "./world.js?v=mirage-0.14.0";

/**
 * The reserved seed that means "this is the camp, not a basin".
 *
 * save.js rebuilds a run by regenerating the world from `sim.seed` — the world
 * is a pure function of the seed and is never serialised. That is exactly
 * right for a basin and impossible for an authored map, so the camp needs a
 * seed value that `deserializeRun` can recognise and route to `buildCamp()`
 * instead of `generateWorld()`. A sentinel is used rather than a separate
 * `sim.isCamp` flag because the seed is ALREADY in every save payload, at
 * every version, and a flag would need a migration to be trusted on read.
 *
 * Negative, so it can never collide with a hashed player-entered seed.
 */
export const CAMP_SEED = -1;

/**
 * What a cell IS, not just whether you can walk through it.
 *
 * `blocked` is enough for the simulation — collision and pathfinding only ask
 * "can I be here". It is NOT enough for the renderer, which draws one thing per
 * blocked cell: a dark rock spire. Under that rule the camp's cabins rendered as
 * rock, its treeline rendered as rock, and its dirt path rendered as nothing at
 * all, so the whole map read as a rocky clearing. Every geometry test passed
 * while the place looked like scenery from a different game.
 *
 * Basins do not set this. A world without `cellKind` falls back to the spire
 * renderer exactly as before, so nothing about the basin changes.
 */
export const CELL_KIND = Object.freeze({
  NONE: 0,
  CABIN: 1,
  TREELINE: 2,   // the dense perimeter wall
  WOOD: 3,       // the thin wood inside the bounds
  PATH: 4,       // walkable, but drawn as dirt rather than grass
});

/**
 * The camp's own grid, in cells per side. NOT the basin's `GRID`.
 *
 * The camp used to live inside a basin-sized 46 with `MARGIN = 3`, which is as
 * large as a centred square can be there — so the only way to grow it further
 * was to stop sharing the number. Every world already carried `world.grid`;
 * nothing read it. It does now (world.js), and this is the camp's answer.
 *
 * TWICE THE AREA, again. 41x41 playable cells (1681) -> 58x58 (3364). The
 * enlargement adds GROUND, not bigger buildings: the cabins and the path keep
 * the size they had and the positions scale about the centre, so the camp reads
 * as the same place with room in it rather than as the same map zoomed in.
 *
 * One consequence, deliberate and new: the camp is now LARGER than a basin
 * (~3100 open cells against a basin's ~1700). It was smaller for its whole
 * life, and `tests/camp.mjs` asserted that. See the test for what replaced it.
 */
export const CAMP_GRID = 63;

const at = (cx, cz) => cz * CAMP_GRID + cx;
const inBounds = (cx, cz) => cx >= 0 && cz >= 0 && cx < CAMP_GRID && cz < CAMP_GRID;

// Everything outside MARGIN is dense trees: the map boundary, and absolute.
const MARGIN = 3;                            // cells of forest wall on every side
const LO = MARGIN, HI = CAMP_GRID - MARGIN;  // inclusive playable bounds

/**
 * A flat-ish floor. The basin's heightfield bowls toward the middle so the rim
 * reads as a rim; a camp should read as level ground somebody chose to build
 * on, so this is nearly flat with a very slight roll to keep it from looking
 * like a tabletop. Deterministic — no rng at all, since the camp never varies.
 */
function campHeight(cx, cz) {
  const u = (cx / CAMP_GRID - 0.5) * Math.PI * 2;
  const v = (cz / CAMP_GRID - 0.5) * Math.PI * 2;
  return Math.sin(u * 0.7) * 0.32 + Math.cos(v * 0.6) * 0.28;
}

/** Fill a solid rectangle of cells (inclusive bounds). */
function fillRect(blocked, x0, z0, x1, z1) {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (inBounds(cx, cz)) blocked[at(cx, cz)] = 1;
    }
  }
}

/** Clear a solid rectangle of cells (inclusive bounds). */
function clearRect(blocked, x0, z0, x1, z1) {
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (inBounds(cx, cz)) blocked[at(cx, cz)] = 0;
    }
  }
}

// The three cabins, as cell rectangles. Each is solid; the yard around them is
// cleared afterwards so no cabin can ever pinch the path against another.
// Deliberately NOT flush with the path — a gap you can walk behind reads as a
// place rather than as scenery.
const CABINS = Object.freeze([
  { x0: 17, z0: 22, x1: 22, z1: 26 },
  { x0: 37, z0: 19, x1: 42, z1: 23 },
  { x0: 28, z0: 37, x1: 34, z1: 41 },
]);

// The dirt path: a spine running the length of the camp with one branch. Stored
// as cleared corridors, 3 cells wide, so it survives the tree pass.
// Widths are PINNED at 3 cells while the ends scale: a path that got wider with
// the map would read as a road, and the yard rules below assume a corridor.
const PATH = Object.freeze([
  { x0: 7, z0: 30, x1: 56, z1: 32 },    // the spine, west to east, most of the map
  { x0: 30, z0: 33, x1: 32, z1: 46 },   // south branch toward the third cabin
  { x0: 41, z0: 16, x1: 43, z1: 30 },   // north branch, out toward the trees
]);

// The thin wood — sparse trees you can walk through, somewhere to wander before
// an objective opens. A fixed pattern, not noise: every cell here is authored
// so the map is genuinely identical run to run.
// The first three clusters are the original hand-placed cells, moved with the
// map. The fourth block is those same cells REFLECTED through the camp's centre
// to fill the ground the enlargement added — density has to hold (the same 35
// cells over twice the area reads as a clearing), and a lattice fill reads as an
// orchard. Reflection reuses the hand that placed the originals. Cells that
// landed on the path, a cabin yard, the spawn, the trainer or a pylon were
// dropped, which is why it is 24 and not another 35.
const THIN_WOOD = Object.freeze([
  [41, 37], [46, 39], [40, 43], [49, 43], [43, 47], [39, 49], [50, 34], [53, 40],
  [47, 47], [51, 46], [44, 51], [40, 53], [54, 36], [50, 51],
  [16, 39], [20, 41], [13, 44], [22, 46], [17, 49], [12, 36], [23, 37],
  [10, 41], [14, 50], [19, 53], [9, 47], [13, 54], [22, 51], [7, 39],
  [27, 10], [33, 9], [24, 13], [37, 12], [30, 14], [22, 10], [40, 9],
  // reflected through the centre, into the ground the enlargement added
  [14, 20], [20, 16], [10, 23], [16, 16], [12, 17], [19, 12], [9, 27], [13, 12],
  [47, 24], [50, 19], [46, 14], [51, 27], [53, 22], [49, 13], [44, 10], [54, 16],
  [50, 9], [41, 12], [56, 24], [36, 53], [30, 54], [26, 51], [33, 49], [23, 54],
]);

/**
 * Build the camp. Same return shape as `generateWorld`, field for field.
 *
 * `spawn` and `trainer` are camp-only additions the basin has no concept of —
 * consumers that do not know about them ignore them, and `validate()` does not
 * look at them.
 */
export function buildCamp() {
  const blocked = new Uint8Array(CAMP_GRID * CAMP_GRID);
  const cellKind = new Uint8Array(CAMP_GRID * CAMP_GRID);
  const mark = (cx, cz, kind) => { if (inBounds(cx, cz)) cellKind[at(cx, cz)] = kind; };

  // 1. Forest wall. Everything outside the playable square is solid trees. This
  //    is the map boundary and it is absolute — there is no way out of camp.
  for (let cz = 0; cz < CAMP_GRID; cz++) {
    for (let cx = 0; cx < CAMP_GRID; cx++) {
      if (cx < LO || cx > HI || cz < LO || cz > HI) { blocked[at(cx, cz)] = 1; cellKind[at(cx, cz)] = CELL_KIND.TREELINE; }
    }
  }

  // 2. Cabins, then the path carved back through them. Order matters: the path
  //    is cut LAST so a cabin can never sit across it, which is the single
  //    easiest way to seal the map by hand.
  for (const c of CABINS) {
    fillRect(blocked, c.x0, c.z0, c.x1, c.z1);
    for (let cz = c.z0; cz <= c.z1; cz++) for (let cx = c.x0; cx <= c.x1; cx++) mark(cx, cz, CELL_KIND.CABIN);
  }
  for (const [cx, cz] of THIN_WOOD) if (inBounds(cx, cz)) { blocked[at(cx, cz)] = 1; mark(cx, cz, CELL_KIND.WOOD); }
  for (const p of PATH) {
    clearRect(blocked, p.x0, p.z0, p.x1, p.z1);
    for (let cz = p.z0; cz <= p.z1; cz++) for (let cx = p.x0; cx <= p.x1; cx++) mark(cx, cz, CELL_KIND.PATH);
  }

  // 3. A cleared yard around every cabin, so you can always walk all the way
  //    around one and nothing pinches shut against the forest wall.
  for (const c of CABINS) {
    for (let cz = c.z0 - 1; cz <= c.z1 + 1; cz++) {
      for (let cx = c.x0 - 1; cx <= c.x1 + 1; cx++) {
        const edge = cx < c.x0 || cx > c.x1 || cz < c.z0 || cz > c.z1;
        if (edge && inBounds(cx, cz) && cx >= LO && cx <= HI && cz >= LO && cz <= HI) {
          blocked[at(cx, cz)] = 0;
          // Clear the KIND too. A cell that stops being solid but keeps its
          // cabin tag would draw a cabin you can walk through.
          if (cellKind[at(cx, cz)] === CELL_KIND.CABIN) cellKind[at(cx, cz)] = CELL_KIND.NONE;
        }
      }
    }
  }

  // Both pinned to the spine's centre row (30..32), not scaled independently —
  // a rounding that put either on the path's edge would stand them in a hedge.
  const spawnCell = { cx: 9, cz: 31 };    // west end of the path
  const trainerCell = { cx: 54, cz: 31 }; // east end — objective 1 is a real walk
  for (const c of [spawnCell, trainerCell]) {
    clearRect(blocked, c.cx - 1, c.cz - 1, c.cx + 1, c.cz + 1);
    for (let cz = c.cz - 1; cz <= c.cz + 1; cz++) {
      for (let cx = c.cx - 1; cx <= c.cx + 1; cx++) {
        if (inBounds(cx, cz) && cellKind[at(cx, cz)] === CELL_KIND.CABIN) cellKind[at(cx, cz)] = CELL_KIND.NONE;
      }
    }
  }

  const place = (id, kind, cx, cz, extra = {}) => ({
    id, kind, cx, cz, ...cellToWorld(cx, cz, CAMP_GRID), ...extra,
  });

  // TWO pylons, both mossed. One stands on the path where anyone walking to the
  // trainer passes it; one is off in the thin wood for a player who wanders.
  // Whichever they meet first, they meet it BEFORE the objective that needs it,
  // which is the entire reason it is present-but-inert rather than absent.
  // OFF IN THE TREES, both of them, and well away from the path spine. They
  // sat at the centre of the camp before, which made "there is something out
  // here under the moss" a lie — you tripped over it walking to the trainer.
  // Finding one should take wandering.
  const pylons = [
    place("p0", FEATURE.PYLON, 49, 46, { spent: false, mossed: true, primedBy: [], primedAt: -1e9 }),
    place("p1", FEATURE.PYLON, 13, 47, { spent: false, mossed: true, primedBy: [], primedAt: -1e9 }),
  ];

  return {
    seed: CAMP_SEED,
    grid: CAMP_GRID,
    cell: CELL,
    blocked,
    cellKind,
    heightAt: campHeight,
    camp: { id: "camp", kind: FEATURE.CAMP, ...spawnCell, ...cellToWorld(spawnCell.cx, spawnCell.cz, CAMP_GRID) },
    // A camp has no survey markers and no raw materials. The tutorial spawns
    // exactly what each objective needs and nothing else, so these are empty by
    // design rather than by omission — an item lying around before its
    // objective is the out-of-order pickup the pinning discipline exists to
    // prevent (brain: wrong-sky#E8 — objective-critical targets stay
    // existence-gated; only the pylons are effect-gated).
    monoliths: [],
    pylons,
    items: [],
    trees: [],
    stones: [],
    repairs: 0,
    // Camp-only. Ignored by every consumer that does not know about them.
    spawn: { ...spawnCell, ...cellToWorld(spawnCell.cx, spawnCell.cz, CAMP_GRID) },
    trainer: { ...trainerCell, ...cellToWorld(trainerCell.cx, trainerCell.cz, CAMP_GRID) },
  };
}

/**
 * The longest straight walk available along the path, in world units.
 *
 * Objective 1 asks the player to walk the length of the camp to the trainer. If
 * an edit to the cabins or the path ever shortens that below what the objective
 * expects, the objective becomes unreachable and NOTHING errors — the same
 * silent starvation the tutorial has produced twice already. So the distance is
 * measured from the real grid rather than assumed, and asserted in tests.
 */
export function longestWalk(world) {
  const grid = gridOf(world);
  const reach = floodFill(world.blocked, world.camp.cx, world.camp.cz);
  let best = 0;
  for (let cz = 0; cz < grid; cz++) {
    for (let cx = 0; cx < grid; cx++) {
      if (!reach[cz * grid + cx]) continue;
      const d = Math.hypot(cx - world.camp.cx, cz - world.camp.cz) * CELL;
      if (d > best) best = d;
    }
  }
  return best;
}
