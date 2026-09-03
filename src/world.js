// world.js — procedural generation of THE BASIN, the area the party explores.
// Pure: no DOM, no Three. Runs identically in the browser and in Node tests.
//
// The area is a square grid of cells. A cell is either open ground or blocked
// (rock spires, collapsed ridges). Movement is CONTINUOUS — the grid is only the
// collision and pathfinding substrate; the renderer draws a heightfield over it.
//
// Placed features:
//   * CAMP       — where the party starts and where it must return (extraction).
//   * MONOLITH x6 — the survey markers. Finding and logging all of them is the goal.
//   * PYLON  x5  — lucid anchors. Standing near a live pylon restores lucidity to
//                  everyone in range. They are the only renewable relief in the area.
//   * ITEM   x6  — small pickups (see state.js ITEM_INFO for what each kind does).
//                  World placement only knows their KIND string, not their effect —
//                  that split keeps this module free of any game-mechanical import.
//
// CONNECTIVITY IS NOT A BYPRODUCT — IT IS ITS OWN PASS.
// Carving with local rules (scatter rock clusters, respect a minimum spacing)
// says nothing about whether the walkable region is globally connected; a
// generator can satisfy every local constraint and still strand a monolith
// behind a ring of spires, which is an unwinnable run. So generation runs an
// explicit repair pass: flood-fill from CAMP, and for any feature not in that
// component, carve a corridor to it and re-fill. `validate()` then re-derives
// reachability from scratch and is asserted in the test suite — the fixup is
// verified, not trusted.

import { makeRng } from "./rng.js?v=mirage-0.13.2";

export const CELL = 2.6; // world units per grid cell
export const GRID = 46; // cells per side
export const MONOLITH_COUNT = 6;
export const PYLON_COUNT = 5;
export const ITEM_COUNT = 6;
// Kind strings only — state.js ITEM_INFO owns what each one actually does.
// "husk" is a real, honestly-placed dud: it spawns and is picked up exactly
// like the other three, it just does nothing when used (see state.js
// ITEM_INFO/useItem) — trash mixed into the same pool, not a hallucination.
export const ITEM_KINDS = Object.freeze(["flare", "tether", "lens", "husk"]);
// Raw-material nodes: chop a tree for wood, mine a deposit for stone. Unlike
// ITEM, these carry no `itemKind` — a tree is always a tree, a deposit always
// stone. There is no deception layer for these at all (see state.js/percept.js
// comments): only carried/crafted ITEMS are ever subject to the lie.
export const TREE_COUNT = 5;
export const STONE_COUNT = 5;

export const FEATURE = Object.freeze({
  CAMP: "camp",
  MONOLITH: "monolith",
  PYLON: "pylon",
  ITEM: "item",
  TREE: "tree",
  STONE: "stone",
});

// Survey markers get names, not numbers — a companion has to be able to say
// "the leaning one" and mean something, and a hallucinating one has to be able
// to name a marker that does not exist.
const MONOLITH_NAMES = [
  "the Leaning Slab",
  "the Split Tooth",
  "the Drowned Arch",
  "the Cairn",
  "the Ribcage",
  "the Nail",
  "the Waiting Stone",
  "the Black Mouth",
];

/** Grid <-> world helpers. Cell (0,0) is the NW corner; the grid is centred on the origin. */
export function cellToWorld(cx, cz) {
  return { x: (cx - GRID / 2 + 0.5) * CELL, z: (cz - GRID / 2 + 0.5) * CELL };
}
export function worldToCell(x, z) {
  return { cx: Math.floor(x / CELL + GRID / 2), cz: Math.floor(z / CELL + GRID / 2) };
}

const inBounds = (cx, cz) => cx >= 0 && cz >= 0 && cx < GRID && cz < GRID;

// Cheap seeded value noise — enough for a rolling basin floor. Sampled by the
// renderer for terrain height and by the sim for "how deep in the fog are you".
function makeHeightField(rng) {
  const lattice = [];
  const LN = 12; // lattice resolution
  for (let i = 0; i <= LN; i++) {
    lattice.push([]);
    for (let j = 0; j <= LN; j++) lattice[i].push(rng());
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  // Height at a fractional cell coordinate, in world units.
  return function heightAt(cx, cz) {
    const u = Math.min(Math.max(cx / GRID, 0), 0.999) * LN;
    const v = Math.min(Math.max(cz / GRID, 0), 0.999) * LN;
    const i = Math.floor(u), j = Math.floor(v);
    const fu = smooth(u - i), fv = smooth(v - j);
    const a = lattice[i][j], b = lattice[i + 1][j];
    const c = lattice[i][j + 1], d = lattice[i + 1][j + 1];
    const top = a + (b - a) * fu;
    const bot = c + (d - c) * fu;
    const h = top + (bot - top) * fv;
    // Bowl bias: the basin dips toward the middle, so the rim reads as a rim.
    const dx = cx / GRID - 0.5, dz = cz / GRID - 0.5;
    const rim = Math.sqrt(dx * dx + dz * dz) * 2; // 0 centre .. ~1.41 corner
    return (h - 0.5) * 2.2 + rim * rim * 3.4;
  };
}

function blockedGrid(rng) {
  const blocked = new Uint8Array(GRID * GRID);
  const at = (cx, cz) => cz * GRID + cx;

  // Hard rim so the player cannot walk out of the area.
  for (let i = 0; i < GRID; i++) {
    blocked[at(i, 0)] = 1;
    blocked[at(i, GRID - 1)] = 1;
    blocked[at(0, i)] = 1;
    blocked[at(GRID - 1, i)] = 1;
  }

  // Rock clusters: random-walk blobs. Local rule only — connectivity comes later.
  const clusters = 26;
  for (let c = 0; c < clusters; c++) {
    let cx = rng.int(3, GRID - 4);
    let cz = rng.int(3, GRID - 4);
    const len = rng.int(6, 26);
    for (let s = 0; s < len; s++) {
      if (inBounds(cx, cz)) blocked[at(cx, cz)] = 1;
      const d = rng.int(0, 3);
      cx += d === 0 ? 1 : d === 1 ? -1 : 0;
      cz += d === 2 ? 1 : d === 3 ? -1 : 0;
      cx = Math.min(Math.max(cx, 2), GRID - 3);
      cz = Math.min(Math.max(cz, 2), GRID - 3);
    }
  }

  // A couple of long ridges to break sightlines and make the area feel authored.
  for (let r = 0; r < 3; r++) {
    const horiz = rng.chance(0.5);
    const fixed = rng.int(6, GRID - 7);
    const from = rng.int(3, GRID - 14);
    const len = rng.int(9, 18);
    const gapAt = from + rng.int(2, len - 3); // leave one pass, usually
    for (let k = 0; k < len; k++) {
      const p = from + k;
      if (p === gapAt) continue;
      const cx = horiz ? p : fixed;
      const cz = horiz ? fixed : p;
      if (inBounds(cx, cz)) blocked[at(cx, cz)] = 1;
    }
  }
  return blocked;
}

/** Flood fill from a cell; returns a Uint8Array marking the reachable component. */
export function floodFill(blocked, startCx, startCz) {
  const seen = new Uint8Array(GRID * GRID);
  if (!inBounds(startCx, startCz) || blocked[startCz * GRID + startCx]) return seen;
  const queue = [startCz * GRID + startCx];
  seen[queue[0]] = 1;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const cx = idx % GRID, cz = (idx - cx) / GRID;
    const nbrs = [[cx + 1, cz], [cx - 1, cz], [cx, cz + 1], [cx, cz - 1]];
    for (const [nx, nz] of nbrs) {
      if (!inBounds(nx, nz)) continue;
      const ni = nz * GRID + nx;
      if (seen[ni] || blocked[ni]) continue;
      seen[ni] = 1;
      queue.push(ni);
    }
  }
  return seen;
}

// Carve an L-shaped corridor between two cells, clearing whatever it crosses.
// This is the repair primitive: it cannot fail, which is the point — a fixup
// pass that can itself fail to connect is not a fixup pass.
function carveCorridor(blocked, ax, az, bx, bz) {
  const clear = (cx, cz) => {
    if (cx > 0 && cz > 0 && cx < GRID - 1 && cz < GRID - 1) blocked[cz * GRID + cx] = 0;
  };
  let x = ax, z = az;
  while (x !== bx) {
    clear(x, z);
    clear(x, z + 1); // 2 cells wide so a 6-strong party is not single-file
    x += bx > x ? 1 : -1;
  }
  while (z !== bz) {
    clear(x, z);
    clear(x + 1, z);
    z += bz > z ? 1 : -1;
  }
  clear(bx, bz);
}

function openNear(blocked, cx, cz) {
  // Nearest open cell to (cx,cz) by expanding ring search.
  for (let r = 0; r < GRID; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const nx = cx + dx, nz = cz + dz;
        if (inBounds(nx, nz) && !blocked[nz * GRID + nx]) return { cx: nx, cz: nz };
      }
    }
  }
  return { cx: Math.floor(GRID / 2), cz: Math.floor(GRID / 2) };
}

/**
 * Generate an area. Returns a plain data object — no live references, so a
 * world can be serialised, diffed in tests, or handed to a worker.
 */
export function generateWorld(seed = 1) {
  const rng = makeRng(seed);
  const blocked = blockedGrid(rng);
  const heightAt = makeHeightField(rng);

  // CAMP sits off-centre so "return to camp" is a real navigation problem
  // rather than "walk to the middle".
  const campSeed = { cx: rng.int(6, 14), cz: rng.int(GRID - 15, GRID - 7) };
  const camp = openNear(blocked, campSeed.cx, campSeed.cz);
  // Clear a small yard around camp. The party spawns in a fan behind the lead and
  // the opening shot looks out across the basin; a spire pressed against the
  // camera on frame one is a bad first impression and can wedge a companion.
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const nx = camp.cx + dx, nz = camp.cz + dz;
      if (nx > 0 && nz > 0 && nx < GRID - 1 && nz < GRID - 1) blocked[nz * GRID + nx] = 0;
    }
  }

  // Scatter features with a minimum separation, biased away from CAMP so the
  // party has to actually travel.
  const picks = [];
  const minSep = 6;
  const farEnough = (c) =>
    picks.every((p) => Math.hypot(p.cx - c.cx, p.cz - c.cz) >= minSep) &&
    Math.hypot(camp.cx - c.cx, camp.cz - c.cz) >= 9;
  let guard = 0;
  const totalPicks = MONOLITH_COUNT + PYLON_COUNT + ITEM_COUNT + TREE_COUNT + STONE_COUNT;
  while (picks.length < totalPicks && guard++ < 6000) {
    const c = openNear(blocked, rng.int(2, GRID - 3), rng.int(2, GRID - 3));
    if (farEnough(c)) picks.push(c);
  }
  // If the spacing loop ran dry (dense seed), top up without the separation rule
  // rather than shipping a world missing its objectives.
  while (picks.length < totalPicks) {
    picks.push(openNear(blocked, rng.int(2, GRID - 3), rng.int(2, GRID - 3)));
  }

  const names = rng.shuffled(MONOLITH_NAMES);
  const monoliths = picks.slice(0, MONOLITH_COUNT).map((c, i) => ({
    id: `m${i}`,
    kind: FEATURE.MONOLITH,
    name: names[i],
    cx: c.cx,
    cz: c.cz,
    ...cellToWorld(c.cx, c.cz),
  }));
  const pylons = picks.slice(MONOLITH_COUNT, MONOLITH_COUNT + PYLON_COUNT).map((c, i) => ({
    id: `p${i}`,
    kind: FEATURE.PYLON,
    cx: c.cx,
    cz: c.cz,
    ...cellToWorld(c.cx, c.cz),
  }));
  // Item kinds: a guaranteed one of each, then a random remainder, then a
  // shuffle. Cycling `i % 3` guaranteed coverage but made every basin on every
  // seed the identical 2/2/2 mix — only the positions ever changed, so the
  // craft space was decided before you walked in. Seeding the remainder keeps
  // coverage (a world where the dice never deal a Lens is a worse world, not a
  // harder one) while letting a basin actually lean.
  //
  // The draw count here is CONSTANT — (ITEM_COUNT - kinds) remainder draws plus
  // (ITEM_COUNT - 1) shuffle swaps, on every seed, with no branch that skips a
  // roll. A pool whose roll count varies with its own contents desyncs every
  // later consumer of the same stream (Brain: waiting-city#E9/E17 —
  // constant-roll-count discipline; the desync shows up somewhere unrelated).
  const bag = ITEM_KINDS.slice(0, Math.min(ITEM_KINDS.length, ITEM_COUNT));
  for (let i = bag.length; i < ITEM_COUNT; i++) bag.push(rng.pick(ITEM_KINDS));
  for (let i = bag.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const items = picks.slice(MONOLITH_COUNT + PYLON_COUNT, MONOLITH_COUNT + PYLON_COUNT + ITEM_COUNT).map((c, i) => ({
    id: `i${i}`,
    kind: FEATURE.ITEM,
    itemKind: bag[i],
    cx: c.cx,
    cz: c.cz,
    ...cellToWorld(c.cx, c.cz),
  }));
  const treeStart = MONOLITH_COUNT + PYLON_COUNT + ITEM_COUNT;
  const trees = picks.slice(treeStart, treeStart + TREE_COUNT).map((c, i) => ({
    id: `t${i}`,
    kind: FEATURE.TREE,
    cx: c.cx,
    cz: c.cz,
    ...cellToWorld(c.cx, c.cz),
  }));
  const stoneStart = treeStart + TREE_COUNT;
  const stones = picks.slice(stoneStart, stoneStart + STONE_COUNT).map((c, i) => ({
    id: `st${i}`,
    kind: FEATURE.STONE,
    cx: c.cx,
    cz: c.cz,
    ...cellToWorld(c.cx, c.cz),
  }));

  // ---- CONNECTIVITY REPAIR PASS (explicit, then re-verified) ----------------
  // Flood from CAMP; anything unreachable gets a carved corridor from the
  // nearest reachable cell. Repeat until the fill covers every feature.
  const features = [...monoliths, ...pylons, ...items, ...trees, ...stones];
  let repairs = 0;
  for (let pass = 0; pass < 12; pass++) {
    const reach = floodFill(blocked, camp.cx, camp.cz);
    const orphans = features.filter((f) => !reach[f.cz * GRID + f.cx]);
    if (orphans.length === 0) break;
    for (const f of orphans) {
      // Nearest cell that IS in CAMP's component, then carve to the orphan.
      let best = null, bestD = Infinity;
      for (let cz = 1; cz < GRID - 1; cz++) {
        for (let cx = 1; cx < GRID - 1; cx++) {
          if (!reach[cz * GRID + cx]) continue;
          const d = Math.hypot(cx - f.cx, cz - f.cz);
          if (d < bestD) { bestD = d; best = { cx, cz }; }
        }
      }
      if (!best) best = camp;
      carveCorridor(blocked, best.cx, best.cz, f.cx, f.cz);
      repairs++;
    }
  }
  // Features stand ON their cell; make sure the cell itself and a ring around it
  // are walkable so a marker is never wedged inside a spire.
  for (const f of features) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = f.cx + dx, nz = f.cz + dz;
        if (nx > 0 && nz > 0 && nx < GRID - 1 && nz < GRID - 1) blocked[nz * GRID + nx] = 0;
      }
    }
  }

  return {
    seed,
    grid: GRID,
    cell: CELL,
    blocked,
    heightAt,
    camp: { id: "camp", kind: FEATURE.CAMP, cx: camp.cx, cz: camp.cz, ...cellToWorld(camp.cx, camp.cz) },
    monoliths,
    pylons,
    items,
    trees,
    stones,
    repairs, // how many corridors the fixup pass had to carve (diagnostic)
  };
}

/** True if a world-space point is inside a blocked cell (or out of bounds). */
export function isBlockedAt(world, x, z) {
  const { cx, cz } = worldToCell(x, z);
  if (!inBounds(cx, cz)) return true;
  return !!world.blocked[cz * GRID + cx];
}

/**
 * Slide a body from `pos` by (dx,dz) with axis-separated collision, so grazing a
 * spire slides along it instead of stopping dead. Returns the new position.
 */
export function moveWithCollision(world, pos, dx, dz, radius = 0.55) {
  const tryAxis = (x, z, nx, nz) => {
    // Sample the body's leading edge, not just its centre.
    const sx = nx + Math.sign(nx - x) * radius;
    const sz = nz + Math.sign(nz - z) * radius;
    if (isBlockedAt(world, sx, nz) || isBlockedAt(world, nx, sz) || isBlockedAt(world, nx, nz)) return null;
    return { x: nx, z: nz };
  };
  let out = { x: pos.x, z: pos.z };
  const stepX = tryAxis(out.x, out.z, out.x + dx, out.z);
  if (stepX) out = stepX;
  const stepZ = tryAxis(out.x, out.z, out.x, out.z + dz);
  if (stepZ) out = stepZ;
  return out;
}

/**
 * Re-derive reachability from scratch. Asserted by the test suite: the repair
 * pass above is verified, not trusted.
 * Returns { ok, unreachable: [featureId] }.
 */
export function validate(world) {
  const reach = floodFill(world.blocked, world.camp.cx, world.camp.cz);
  const unreachable = [];
  for (const f of [...world.monoliths, ...world.pylons, ...world.items, ...world.trees, ...world.stones]) {
    if (!reach[f.cz * GRID + f.cx]) unreachable.push(f.id);
  }
  let open = 0;
  for (let i = 0; i < world.blocked.length; i++) if (!world.blocked[i]) open++;
  let reached = 0;
  for (let i = 0; i < reach.length; i++) if (reach[i]) reached++;
  return {
    ok: unreachable.length === 0,
    unreachable,
    openCells: open,
    reachableCells: reached,
    // Fraction of walkable ground the party can actually get to. Not a pass/fail
    // gate (pockets behind spires are fine scenery) but a smell test: a world
    // where most of the floor is stranded is a bad world even if the objectives
    // happen to be reachable.
    reachableFraction: open ? reached / open : 0,
  };
}

// Scratch buffers for findPath. Reused rather than reallocated: the companions
// repath several times a second each, and two fresh typed arrays per call is
// avoidable garbage in the long-run simulations. Safe because findPath is
// synchronous, single-threaded, and never re-entrant.
const PATH_PREV = new Int32Array(GRID * GRID);
const PATH_SEEN = new Uint8Array(GRID * GRID);

/** Grid path (BFS) between two cells, as an array of {cx,cz}. Used by NPC AI. */
export function findPath(world, from, to) {
  const startIdx = from.cz * GRID + from.cx;
  const goalIdx = to.cz * GRID + to.cx;
  if (startIdx === goalIdx) return [];
  const prev = PATH_PREV.fill(-1);
  const seen = PATH_SEEN.fill(0);
  if (!inBounds(from.cx, from.cz) || world.blocked[startIdx]) return null;
  const queue = [startIdx];
  seen[startIdx] = 1;
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    if (idx === goalIdx) break;
    const cx = idx % GRID, cz = (idx - cx) / GRID;
    for (const [nx, nz] of [[cx + 1, cz], [cx - 1, cz], [cx, cz + 1], [cx, cz - 1]]) {
      if (!inBounds(nx, nz)) continue;
      const ni = nz * GRID + nx;
      if (seen[ni] || world.blocked[ni]) continue;
      seen[ni] = 1;
      prev[ni] = idx;
      queue.push(ni);
    }
  }
  if (!seen[goalIdx]) return null;
  const path = [];
  for (let idx = goalIdx; idx !== -1 && idx !== startIdx; idx = prev[idx]) {
    const cx = idx % GRID;
    path.push({ cx, cz: (idx - cx) / GRID });
  }
  return path.reverse();
}
