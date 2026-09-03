// camp.mjs — the authored map has to earn what the generator gave for free.
//
// generateWorld guarantees connectivity with an explicit repair pass and a
// validate() that re-derives it from scratch. buildCamp() opts out of all of
// that by placing cells by hand, so every guarantee it needs is asserted here
// instead. A cabin wall one cell too long seals a pocket and nothing complains.
//
// Run: node tests/camp.mjs

import { buildCamp, longestWalk, CAMP_SEED } from "../src/camp.js";
import { createRun, tick } from "../src/state.js";
import { generateWorld, validate, floodFill, GRID, CELL } from "../src/world.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };

// --- the shape contract -----------------------------------------------------
// save.js, render.js, state.js and party.js all take a world without caring
// where it came from. A missing or mistyped field surfaces far away as a NaN
// position or an invisible floor, so it is pinned here against the real thing.
check("the camp returns exactly the shape generateWorld does", () => {
  const camp = buildCamp();
  const basin = generateWorld(12345);
  for (const key of Object.keys(basin)) {
    assert(key in camp, `the camp is missing "${key}", which every basin has`);
    eq(typeof camp[key], typeof basin[key], `the camp's "${key}" is the wrong type`);
  }
  eq(camp.blocked.length, basin.blocked.length, "the camp's grid is a different size");
  eq(camp.grid, GRID, "the camp reports the wrong grid size");
  eq(camp.cell, CELL, "the camp reports the wrong cell size");
  eq(typeof camp.heightAt(3, 4), "number", "the camp's heightAt does not return a number");
});

check("the camp seed is reserved and cannot collide with a real one", () => {
  assert(CAMP_SEED < 0, "the camp sentinel is not negative — a hashed seed could collide with it");
});

// --- connectivity, the thing hand-placement throws away ---------------------
check("every open cell in the camp is reachable from spawn", () => {
  const camp = buildCamp();
  const reach = floodFill(camp.blocked, camp.camp.cx, camp.camp.cz);
  let open = 0, reached = 0, stranded = [];
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) {
      const i = cz * GRID + cx;
      if (camp.blocked[i]) continue;
      open++;
      if (reach[i]) reached++;
      else if (stranded.length < 6) stranded.push(`${cx},${cz}`);
    }
  }
  eq(reached, open, `${open - reached} open cells are sealed off (e.g. ${stranded.join(" ")}) — a cabin or the treeline pinched the map shut`);
});

check("the camp passes the same validate() a basin does", () => {
  const v = validate(buildCamp());
  assert(v.ok, `unreachable features: ${v.unreachable.join(", ")}`);
  eq(v.reachableFraction, 1, "some walkable ground is stranded");
});

// --- what the objectives actually require -----------------------------------
check("the trainer is reachable, and standing at him is a real walk", () => {
  const camp = buildCamp();
  const reach = floodFill(camp.blocked, camp.camp.cx, camp.camp.cz);
  assert(reach[camp.trainer.cz * GRID + camp.trainer.cx], "the trainer is standing somewhere you cannot walk to");
  const d = Math.hypot(camp.trainer.x - camp.spawn.x, camp.trainer.z - camp.spawn.z);
  assert(d >= 30, `the walk to the trainer is only ${d.toFixed(1)}m — objective 1 wants a real crossing`);
});

check("both pylons exist, are reachable, and start mossed", () => {
  const camp = buildCamp();
  const reach = floodFill(camp.blocked, camp.camp.cx, camp.camp.cz);
  assert(camp.pylons.length >= 2, `only ${camp.pylons.length} pylon(s) in camp`);
  for (const p of camp.pylons) {
    assert(reach[p.cz * GRID + p.cx], `pylon ${p.id} is unreachable`);
    assert(p.mossed === true, `pylon ${p.id} does not start mossed — it is live before its objective`);
    assert(p.spent === false, `pylon ${p.id} starts spent`);
  }
});

// The pylons used to be required to sit ON the walk to the trainer, so a player
// met one early. That was reversed deliberately: tripping over the thing makes
// "there is something out here under the moss" a lie, and finding one should
// take wandering. What still has to hold is that they are FINDABLE — off the
// path, but inside the camp, reachable, and not so far that the objective
// becomes a search of the whole map.
check("the pylons are off the path but still findable", () => {
  const camp = buildCamp();
  const reach = floodFill(camp.blocked, camp.camp.cx, camp.camp.cz);
  const pathCells = [];
  for (let cz = 0; cz < GRID; cz++) {
    for (let cx = 0; cx < GRID; cx++) if (camp.cellKind[cz * GRID + cx] === 4) pathCells.push({ cx, cz });
  }
  assert(pathCells.length > 0, "the camp has no path to be off of");
  for (const p of camp.pylons) {
    assert(reach[p.cz * GRID + p.cx], `pylon ${p.id} is unreachable`);
    const d = Math.min(...pathCells.map((c) => Math.hypot(c.cx - p.cx, c.cz - p.cz)));
    assert(d >= 4, `pylon ${p.id} is ${d.toFixed(1)} cells from the path — you would trip over it`);
    assert(d <= 16, `pylon ${p.id} is ${d.toFixed(1)} cells from any path — that is a search, not a find`);
  }
});

check("the camp is big enough to have somewhere to wander", () => {
  // The owner asked for four times the area. Asserted against the real count so
  // a later edit that quietly shrinks it fails here.
  const camp = buildCamp();
  let open = 0;
  for (let i = 0; i < camp.blocked.length; i++) if (!camp.blocked[i]) open++;
  assert(open >= 1400, `only ${open} open cells — the camp has shrunk back toward its original ~775`);
});

check("the camp carries nothing an objective has not opened", () => {
  const camp = buildCamp();
  eq(camp.items.length, 0, "an item exists in camp before its objective opens");
  eq(camp.monoliths.length, 0, "the camp has survey markers");
});

// --- the camp is not accidentally winnable ----------------------------------
// The basin's extraction check asks whether every marker has been logged. With
// no markers that is trivially true, so the camp — which has none by design —
// was won by standing still, and the tutorial ended three seconds in with an
// extraction screen. Nothing caught it: no test had ever run the win check
// against a map with an empty objective list.
check("standing in the camp does not win or lose the run", () => {
  const world = buildCamp();
  const sim = createRun({ seed: CAMP_SEED, world, difficulty: "gentle", level: 1, campaignLength: 1 });
  sim.noDrain = true;
  sim.player.x = world.spawn.x;
  sim.player.z = world.spawn.z;
  for (let i = 0; i < 90 * 30; i++) tick(sim, 1 / 30);
  eq(sim.status, "playing", `the camp ended itself after 90s with ending "${sim.ending}"`);
});

check("a map with no markers is never extractable", () => {
  // The general form of the same bug, asserted against the rule rather than
  // against the camp — a basin that generated no markers must not be winnable
  // by walking home either.
  const world = buildCamp();
  const sim = createRun({ seed: CAMP_SEED, world, difficulty: "gentle", level: 1, campaignLength: 1 });
  sim.noDrain = true;
  eq(sim.monoliths.length, 0, "fixture expects a map with no markers");
  // Put the whole party on the extraction point, which is the winning position.
  for (const c of sim.party) { c.x = world.camp.x; c.z = world.camp.z; }
  for (let i = 0; i < 60; i++) tick(sim, 1 / 30);
  eq(sim.status, "playing", "the whole party standing on camp extracted from a map with nothing to survey");
});

// --- it is the SAME map every time ------------------------------------------
check("the camp is byte-identical across builds", () => {
  const a = buildCamp(), b = buildCamp();
  eq(Buffer.from(a.blocked).toString("hex"), Buffer.from(b.blocked).toString("hex"), "the camp's geometry differs between builds");
  eq(JSON.stringify(a.pylons), JSON.stringify(b.pylons), "the camp's pylons moved between builds");
  eq(a.heightAt(7, 9), b.heightAt(7, 9), "the camp's floor differs between builds");
});

check("the camp is smaller than a basin but not cramped", () => {
  const camp = buildCamp();
  let open = 0;
  for (let i = 0; i < camp.blocked.length; i++) if (!camp.blocked[i]) open++;
  const basinOpen = (() => { const b = generateWorld(4242); let n = 0; for (let i = 0; i < b.blocked.length; i++) if (!b.blocked[i]) n++; return n; })();
  assert(open < basinOpen, `the camp (${open} cells) is not smaller than a basin (${basinOpen})`);
  assert(open > 300, `the camp is only ${open} cells — too cramped to wander`);
  assert(longestWalk(camp) >= 30, `the longest walk in camp is ${longestWalk(camp).toFixed(1)}m`);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log("  ✗ " + f);
if (failures.length) process.exit(1);
console.log("mirage camp: OK");
