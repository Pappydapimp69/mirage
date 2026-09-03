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

import { CELL, GRID, FEATURE, cellToWorld, floodFill } from "./world.js?v=mirage-0.13.2";

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

const at = (cx, cz) => cz * GRID + cx;
const inBounds = (cx, cz) => cx >= 0 && cz >= 0 && cx < GRID && cz < GRID;

// The camp occupies a centred square smaller than a full basin — big enough to
// wander and get slightly turned around in, small enough that the treeline is
// always somewhere you could walk to. Everything outside MARGIN is dense trees.
// FOUR TIMES THE AREA. The camp was a 28x28-cell square inside a 46-cell grid,
// which walked end to end in well under a minute and left the cabins crowding
// each other. Halving the margin roughly doubles each side, so the playable
// area goes from ~784 cells to ~1600 — four times the ground, and enough of it
// that a pylon can be genuinely off in the trees rather than underfoot.
const MARGIN = 3;                       // cells of forest wall on every side
const LO = MARGIN, HI = GRID - MARGIN;  // inclusive playable bounds

/**
 * A flat-ish floor. The basin's heightfield bowls toward the middle so the rim
 * reads as a rim; a camp should read as level ground somebody chose to build
 * on, so this is nearly flat with a very slight roll to keep it from looking
 * like a tabletop. Deterministic — no rng at all, since the camp never varies.
 */
function campHeight(cx, cz) {
  const u = (cx / GRID - 0.5) * Math.PI * 2;
  const v = (cz / GRID - 0.5) * Math.PI * 2;
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
  { x0: 13, z0: 16, x1: 18, z1: 20 },
  { x0: 27, z0: 14, x1: 32, z1: 18 },
  { x0: 20, z0: 27, x1: 26, z1: 31 },
]);

// The dirt path: a spine running the length of the camp with one branch. Stored
// as cleared corridors, 3 cells wide, so it survives the tree pass.
const PATH = Object.freeze([
  { x0: 6, z0: 22, x1: 40, z1: 24 },    // the spine, west to east, most of the map
  { x0: 22, z0: 24, x1: 24, z1: 33 },   // south branch toward the third cabin
  { x0: 30, z0: 12, x1: 32, z1: 22 },   // north branch, out toward the trees
]);

// The thin wood — sparse trees you can walk through, somewhere to wander before
// an objective opens. A fixed pattern, not noise: every cell here is authored
// so the map is genuinely identical run to run.
const THIN_WOOD = Object.freeze([
  [30, 27], [33, 28], [29, 31], [35, 31], [31, 34], [28, 35], [36, 25], [38, 29],
  [34, 34], [37, 33], [32, 37], [29, 38], [39, 26], [36, 37],
  [12, 28], [15, 30], [10, 32], [16, 33], [13, 35], [9, 26], [17, 27],
  [8, 30], [11, 36], [14, 38], [7, 34], [10, 39], [16, 37], [6, 28],
  [20, 8], [24, 7], [18, 10], [27, 9], [22, 11], [16, 8], [29, 7],
]);

/**
 * Build the camp. Same return shape as `generateWorld`, field for field.
 *
 * `spawn` and `trainer` are camp-only additions the basin has no concept of —
 * consumers that do not know about them ignore them, and `validate()` does not
 * look at them.
 */
export function buildCamp() {
  const blocked = new Uint8Array(GRID * GRID);
  const cellKind = new Uint8Array(GRID * GRID);
  const mark = (cx, cz, kind) => { if (inBounds(cx, cz)) cellKind[at(cx, cz)] = kind; };

  // 1. Forest wall. Everything outside the playable square is solid trees. This
  //    is the map boundary and it is absolute — there is no way out of camp.
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) {
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

  const spawnCell = { cx: 7, cz: 23 };    // west end of the path
  const trainerCell = { cx: 39, cz: 23 }; // east end — objective 1 is a real walk
  for (const c of [spawnCell, trainerCell]) {
    clearRect(blocked, c.cx - 1, c.cz - 1, c.cx + 1, c.cz + 1);
    for (let cz = c.cz - 1; cz <= c.cz + 1; cz++) {
      for (let cx = c.cx - 1; cx <= c.cx + 1; cx++) {
        if (inBounds(cx, cz) && cellKind[at(cx, cz)] === CELL_KIND.CABIN) cellKind[at(cx, cz)] = CELL_KIND.NONE;
      }
    }
  }

  const place = (id, kind, cx, cz, extra = {}) => ({
    id, kind, cx, cz, ...cellToWorld(cx, cz), ...extra,
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
    place("p0", FEATURE.PYLON, 35, 33, { spent: false, mossed: true, primedBy: [], primedAt: -1e9 }),
    place("p1", FEATURE.PYLON, 10, 34, { spent: false, mossed: true, primedBy: [], primedAt: -1e9 }),
  ];

  return {
    seed: CAMP_SEED,
    grid: GRID,
    cell: CELL,
    blocked,
    cellKind,
    heightAt: campHeight,
    camp: { id: "camp", kind: FEATURE.CAMP, ...spawnCell, ...cellToWorld(spawnCell.cx, spawnCell.cz) },
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
    spawn: { ...spawnCell, ...cellToWorld(spawnCell.cx, spawnCell.cz) },
    trainer: { ...trainerCell, ...cellToWorld(trainerCell.cx, trainerCell.cz) },
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
  const reach = floodFill(world.blocked, world.camp.cx, world.camp.cz);
  let best = 0;
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) {
      if (!reach[at(cx, cz)]) continue;
      const d = Math.hypot(cx - world.camp.cx, cz - world.camp.cz) * CELL;
      if (d > best) best = d;
    }
  }
  return best;
}
