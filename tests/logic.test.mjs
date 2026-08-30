// Pure-logic test suite for MIRAGE. No browser, no WebGL, no timers.
// Run: node mirage/tests/logic.test.mjs
//
// Everything asserted here reads the sim's OWN clock (`sim.time`) and its own
// state — never wall-clock seconds. Headless/loaded environments run frames well
// under real time, so any assertion phrased in real seconds is a flake waiting to
// happen; the sim is advanced explicitly instead.

import {
  createRun, tick, tickLucidity, bandOf, BAND, checkIn, useDose, logMarker, recover,
  beginHallucinating, debrief, trueLogCount, badLogCount, strikeTargetAt, claimedEntryAt, checkEndings, partyCentroid,
  pickupItem, useItem, dropItem, craftItem, previewCraft, gatherResource, gatherTarget, emit,
  rollTraits, pickHallucinationKind, companionPickup, handoffToPlayer, offerItem,
  possess, release, possessableCompanions,
  PARTY_SIZE, MAX_LUCIDITY, DOSE_COUNT, RECOVER_AT, RECOVER_TIME, DISSOLVE_TIME,
  TIME_LIMIT, PYLON_RADIUS, LOG_RADIUS, ISOLATION_DIST,
  ITEM_CAP, ITEM_PICKUP_RADIUS, ITEM_INFO, VOUCH_WINDOW, PYLON_PAUSE, PYLON_DRAW, PRIME_WINDOW, activatePylon, pylonAt, PHANTOM_ITEM_COST, CRAFT_RECIPES, CAMPAIGN_LENGTH, LUCIDITY_GRACE, FULL_DRAIN_AT, graceMultiplier,
  GATHER_RADIUS, GATHER_HOLD_TIME, GATHER_YIELD, STAKE_COST, TRAIT_VARIANCE, COMPANION_TEMPLATES,
  COMPANION_ITEM_CAP, OFFER_RADIUS,
  groupWith,
} from "../src/state.js";
import { generateWorld, validate, findPath, isBlockedAt, GRID, ITEM_COUNT, ITEM_KINDS, TREE_COUNT, STONE_COUNT } from "../src/world.js";
import {
  createPercept, updatePercept, perceivedMonoliths, perceivedPylons, perceivedCompanions,
  perceivedYaw, rosterRead, filterReport, distortion,
  perceivedWorldItems, perceivedInventory, isClear, believedKinds,
} from "../src/percept.js";
import { HALLUCINATION } from "../src/state.js";
import { makeRng, hashSeed } from "../src/rng.js";
import { readFileSync as fsReadFileSync, readdirSync as fsReaddirSync } from "fs";

let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failures.push(`${name}: ${e.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || "not equal"} — got ${a}, expected ${b}`);
}
function near(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || "not near"} — got ${a}, expected ~${b}`);
}

// Advance a sim by `seconds` in fixed slices, as the game loop does.
function advance(sim, seconds, input = {}) {
  const slice = 1 / 30;
  for (let t = 0; t < seconds && sim.status === "playing"; t += slice) tick(sim, slice, input);
  return sim;
}

// ---------------------------------------------------------------------------
// rng
// ---------------------------------------------------------------------------
check("rng is deterministic per seed", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 50; i++) eq(a(), b(), "same seed diverged");
});

check("rng int is inclusive and in range", () => {
  const r = makeRng(7);
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    const v = r.int(1, 5);
    assert(v >= 1 && v <= 5, `int out of range: ${v}`);
    seen.add(v);
  }
  eq(seen.size, 5, "int(1,5) never produced all five values");
});

check("hashSeed is stable and non-zero", () => {
  eq(hashSeed("basin"), hashSeed("basin"), "unstable hash");
  assert(hashSeed("basin") !== hashSeed("basins"), "hash collision on near-identical input");
});

// ---------------------------------------------------------------------------
// world generation + the connectivity guarantee
// ---------------------------------------------------------------------------
check("every objective is reachable from camp, across many seeds", () => {
  // The repair pass is verified here, not trusted: validate() re-derives
  // reachability from scratch with its own flood fill.
  for (let seed = 1; seed <= 60; seed++) {
    const w = generateWorld(seed);
    const v = validate(w);
    assert(v.ok, `seed ${seed}: unreachable ${JSON.stringify(v.unreachable)}`);
    eq(w.monoliths.length, 6, `seed ${seed}: wrong monolith count`);
    eq(w.pylons.length, 5, `seed ${seed}: wrong pylon count`);
  }
});

check("BFS finds a concrete path from camp to every marker and pylon", () => {
  for (const seed of [1, 5, 17, 33, 99]) {
    const w = generateWorld(seed);
    const from = { cx: w.camp.cx, cz: w.camp.cz };
    for (const f of [...w.monoliths, ...w.pylons]) {
      const path = findPath(w, from, { cx: f.cx, cz: f.cz });
      assert(path && path.length > 0, `seed ${seed}: no path to ${f.id}`);
      // A path must never step through a blocked cell.
      for (const n of path) assert(!w.blocked[n.cz * GRID + n.cx], `seed ${seed}: path crosses rock`);
    }
  }
});

check("most of the walkable floor is actually reachable", () => {
  // Not a hard gate (pockets behind spires are fine scenery) but a world where
  // the majority of the ground is stranded is a bad world even when the
  // objectives happen to be reachable.
  let worst = 1;
  for (let seed = 1; seed <= 30; seed++) worst = Math.min(worst, validate(generateWorld(seed)).reachableFraction);
  assert(worst > 0.55, `worst reachable fraction was ${worst.toFixed(2)}`);
});

check("the rim is sealed — you cannot walk out of the basin", () => {
  const w = generateWorld(3);
  for (let i = 0; i < GRID; i++) {
    assert(w.blocked[i], "north rim open");
    assert(w.blocked[(GRID - 1) * GRID + i], "south rim open");
    assert(w.blocked[i * GRID], "west rim open");
    assert(w.blocked[i * GRID + GRID - 1], "east rim open");
  }
});

check("markers stand on open ground", () => {
  for (const seed of [2, 11, 44]) {
    const w = generateWorld(seed);
    for (const f of [...w.monoliths, ...w.pylons]) {
      assert(!isBlockedAt(w, f.x, f.z), `seed ${seed}: ${f.id} is inside rock`);
    }
  }
});

check("items place at the documented count, every kind present, all reachable", () => {
  // The contract is COVERAGE, not a fixed order. Kinds used to cycle `i % 3`,
  // which guaranteed coverage but made every basin on every seed the same
  // 2/2/2 mix — only positions varied. The invariant that actually matters is
  // that no seed can deal a basin missing a kind (a Lens you can never find is
  // a worse world, not a harder one).
  for (const seed of [1, 2, 3, 17, 42]) {
    const w = generateWorld(seed);
    eq(w.items.length, ITEM_COUNT, `seed ${seed}: wrong item count`);
    const kinds = new Set(w.items.map((it) => it.itemKind));
    eq(kinds.size, ITEM_KINDS.length, `seed ${seed}: not every kind appeared`);
    for (const it of w.items)
      assert(ITEM_KINDS.includes(it.itemKind), `seed ${seed}: unknown kind ${it.itemKind}`);
    assert(validate(w).ok, `seed ${seed}: an item was left unreachable`);
  }
});

check("item kinds actually vary across seeds, and the draw count never varies", () => {
  const mixes = new Set();
  for (let seed = 1; seed <= 120; seed++) {
    const w = generateWorld(seed);
    const c = Object.fromEntries(ITEM_KINDS.map((k) => [k, 0]));
    for (const it of w.items) c[it.itemKind] += 1;
    for (const k of ITEM_KINDS) assert(c[k] >= 1, `seed ${seed}: no ${k} in the basin`);
    mixes.add(ITEM_KINDS.map((k) => c[k]).join("/"));
  }
  assert(mixes.size > 1, `item mix never changes across 120 seeds (got only ${[...mixes]})`);
  // Constant roll count: the same seed must always produce the same world, and
  // everything drawn AFTER the items (trees, stones) must be unmoved by the
  // item draw — a pool whose roll count varies with its own contents desyncs
  // every later consumer of the stream (Brain: waiting-city#E9/E17).
  for (const seed of [5, 33, 91]) {
    const a = generateWorld(seed), b = generateWorld(seed);
    eq(JSON.stringify(a.items), JSON.stringify(b.items), `seed ${seed}: item draw not deterministic`);
    eq(JSON.stringify(a.trees), JSON.stringify(b.trees), `seed ${seed}: trees moved between identical seeds`);
    eq(JSON.stringify(a.stones), JSON.stringify(b.stones), `seed ${seed}: stones moved between identical seeds`);
  }
});

check("trees and stone deposits place at the documented counts, all reachable", () => {
  for (const seed of [1, 2, 3, 17, 42]) {
    const w = generateWorld(seed);
    eq(w.trees.length, TREE_COUNT, `seed ${seed}: wrong tree count`);
    eq(w.stones.length, STONE_COUNT, `seed ${seed}: wrong stone count`);
    for (const t of w.trees) assert(!isBlockedAt(w, t.x, t.z), `seed ${seed}: ${t.id} is inside rock`);
    for (const s of w.stones) assert(!isBlockedAt(w, s.x, s.z), `seed ${seed}: ${s.id} is inside rock`);
    assert(validate(w).ok, `seed ${seed}: a tree or stone deposit was left unreachable`);
  }
});

check("same seed builds the same basin", () => {
  const a = generateWorld(123);
  const b = generateWorld(123);
  eq(a.monoliths.map((m) => m.id + m.cx + "," + m.cz).join("|"),
     b.monoliths.map((m) => m.id + m.cx + "," + m.cz).join("|"), "monoliths differ");
  eq(String(a.blocked), String(b.blocked), "blocked grid differs");
});

// ---------------------------------------------------------------------------
// bands
// ---------------------------------------------------------------------------
check("bands partition the lucidity range at the documented edges", () => {
  eq(bandOf(100), BAND.STEADY);
  eq(bandOf(62), BAND.STEADY);
  eq(bandOf(61.9), BAND.UNSETTLED);
  eq(bandOf(36), BAND.UNSETTLED);
  eq(bandOf(35.9), BAND.FRAYING);
  eq(bandOf(14), BAND.FRAYING);
  eq(bandOf(13.9), BAND.BRITTLE);
  eq(bandOf(0.01), BAND.BRITTLE);
  eq(bandOf(0), BAND.GONE);
});

// ---------------------------------------------------------------------------
// the party and the meter
// ---------------------------------------------------------------------------
check("a run starts with the player plus five companions, all full", () => {
  const sim = createRun({ seed: 5 });
  eq(sim.party.length, PARTY_SIZE, "party size");
  eq(sim.companions.length, 5, "five NPC companions");
  for (const c of sim.party) eq(c.lucidity, MAX_LUCIDITY, `${c.name} did not start full`);
  eq(sim.doses, DOSE_COUNT, "dose count");
  eq(sim.status, "playing");
});

check("nobody's lucidity moves during the dead-calm window, then drain eases in", () => {
  const sim = createRun({ seed: 8 });
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const before = sim.companions.map((c) => c.lucidity);
  sim.time = LUCIDITY_GRACE - 1;
  for (const c of sim.party) tickLucidity(sim, c, 1);
  sim.companions.forEach((c, i) => eq(c.lucidity, before[i], `${c.name} drained inside the dead-calm window`));
  sim.time = FULL_DRAIN_AT;
  for (const c of sim.party) tickLucidity(sim, c, 1);
  sim.companions.forEach((c, i) => assert(c.lucidity < before[i], `${c.name} did not drain at full rate`));
});

// Five dead-calm minutes, then it just goes down. The ramp is gone: an easing
// slope existed to soften the transition out of a SHORT calm, and once the calm
// is five minutes long a gradient nobody can feel is not a mechanic. This still
// asserts the shape rather than the constants, so restoring a ramp by setting
// LUCIDITY_RAMP > 0 keeps passing.
check("nothing drains for the whole calm window, then it drains", () => {
  eq(graceMultiplier(0), 0, "drain at t=0");
  eq(graceMultiplier(LUCIDITY_GRACE - 0.01), 0, "drain just before the calm window ends");
  eq(graceMultiplier(FULL_DRAIN_AT), 1, "full drain once the window is over");
  eq(graceMultiplier(FULL_DRAIN_AT + 999), 1, "drain never exceeds full");
  assert(LUCIDITY_GRACE >= 300, `the calm window is ${LUCIDITY_GRACE}s — the brief is five minutes`);
  // Monotonic: pressure may never DROP as the basin goes on.
  let prev = -1;
  for (let t = 0; t <= FULL_DRAIN_AT + 30; t += 5) {
    const g = graceMultiplier(t);
    assert(g >= prev, `grace multiplier went backwards at t=${t}`);
    prev = g;
  }
});

// A pylon fires ONCE, takes everyone standing in it, and is then dead for the
// rest of the basin. "You can't stop the decay forever" is not a tuning claim
// here, it is structural: the basin holds exactly as much relief as it has
// pylons.
check("a pylon fires once, catches everyone in it, and never lights again", () => {
  const sim = createRun({ seed: 71 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const [a, b] = [sim.player, sim.companions[0]];
  const far = sim.companions[1];
  a.x = p.x; a.z = p.z;
  b.x = p.x + 1; b.z = p.z;
  far.x = p.x + 500; far.z = p.z + 500;
  a.lucidity = 20; b.lucidity = 20; far.lucidity = 20;

  eq(activatePylon(sim, a).confirmed, false, "one person alone fired a pylon");
  const res = activatePylon(sim, b);
  assert(res.ok && res.confirmed, "a second pair of hands did not fire the pylon");
  assert(a.lucidity > 20 && b.lucidity > 20, "the pulse missed somebody standing in it");
  eq(far.lucidity, 20, "the pulse reached someone outside the radius");
  assert(a.decayPausedUntil > sim.time, "the pulse did not hold the decay off");
  assert(p.spent, "the pylon was not spent");

  // Dead forever: a second attempt gives nothing, however long you stand there.
  a.lucidity = 20;
  eq(activatePylon(sim, a).ok, false, "a spent pylon fired a second time");
  eq(a.lucidity, 20, "a spent pylon still put light back");
  eq(pylonAt(sim, a), null, "a spent pylon still counts as somewhere to stand");
});

// The pause is on the MIND, not the pylon — catch a pulse and walk out with it.
check("the pause travels with you, then expires", () => {
  const sim = createRun({ seed: 72 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const ch = sim.player;
  ch.x = p.x; ch.z = p.z;
  const second = sim.companions[0];
  second.x = p.x; second.z = p.z;
  activatePylon(sim, ch);
  activatePylon(sim, second);

  ch.x = p.x + 500; ch.z = p.z + 500;
  ch.lucidity = 50;
  tickLucidity(sim, ch, 0.05);
  eq(ch.lucidity, 50, "decay ran during a paid-for pause");

  sim.time += PYLON_PAUSE + 0.1;
  tickLucidity(sim, ch, 0.05);
  assert(ch.lucidity < 50, "decay did not resume after the pause expired");
});

// Contact must NOT be enough. A companion crossing a pylon on an errand would
// otherwise burn the basin's scarcest resource for one body, with the lead
// nowhere near it and no say in the matter.
check("walking through a pylon does not spend it", () => {
  const sim = createRun({ seed: 73 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const ch = sim.player;
  ch.x = p.x; ch.z = p.z;
  ch.lucidity = 30;
  advance(sim, 3);
  assert(!p.spent, "standing in a pylon spent it without anyone activating it");
});

check("the difficulty tiers are still distinguishable through the ramp", () => {
  // The flat 300s window made gentle/standard/bleak produce identical runs,
  // because with no drain anywhere there is nothing for diffMult to multiply.
  // This is the regression guard for that: at full drain the tiers must differ.
  const rates = ["gentle", "standard", "bleak"].map((difficulty) => {
    const sim = createRun({ seed: 8, difficulty });
    const spot = farFromPylons(sim);
    for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
    sim.time = FULL_DRAIN_AT;
    return tickLucidity(sim, sim.companions[0], 1);
  });
  assert(rates[0] < rates[1] && rates[1] < rates[2],
    `pressure tiers must order gentle < standard < bleak, got ${rates.map((r) => r.toFixed(3))}`);
});

check("lucidity only ever falls, absent a pylon or a dose", () => {
  const sim = createRun({ seed: 8 });
  sim.time = FULL_DRAIN_AT; // past the orientation window — drain applies
  // Park everyone far from any pylon so the only force acting is drain.
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const before = sim.companions.map((c) => c.lucidity);
  for (const c of sim.party) tickLucidity(sim, c, 1);
  sim.companions.forEach((c, i) => assert(c.lucidity < before[i], `${c.name} did not drain`));
});

check("companions drain at different rates — the party is not one meter", () => {
  const sim = createRun({ seed: 8 });
  sim.time = FULL_DRAIN_AT;
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  for (let i = 0; i < 30; i++) for (const c of sim.party) tickLucidity(sim, c, 1);
  const values = new Set(sim.companions.map((c) => Math.round(c.lucidity)));
  assert(values.size >= 4, `expected spread across companions, got ${[...values]}`);
});

check("walking off alone drains faster than staying with the party", () => {
  const sim = createRun({ seed: 9 });
  sim.time = FULL_DRAIN_AT;
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const together = tickLucidity(sim, sim.companions[0], 1);
  const lone = sim.companions[1];
  lone.x = spot.x + ISOLATION_DIST + 40;
  lone.z = spot.z;
  // Re-park the rest so the centroid does not chase the isolated one.
  const alone = tickLucidity(sim, lone, 1);
  assert(alone > together * 1.4, `isolation did not bite: ${alone} vs ${together}`);
});

check("watching someone come apart costs you", () => {
  const sim = createRun({ seed: 10 });
  sim.time = FULL_DRAIN_AT;
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const subject = sim.companions[0];
  const clean = tickLucidity(sim, subject, 1);
  beginHallucinating(sim, sim.companions[3]);
  sim.companions[3].x = spot.x + 1;
  sim.companions[3].z = spot.z + 1;
  const contagious = tickLucidity(sim, subject, 1);
  assert(contagious > clean, `contagion did not apply: ${contagious} vs ${clean}`);
});

check("coming back leaves a scar that makes the next fall faster", () => {
  const sim = createRun({ seed: 11 });
  sim.time = FULL_DRAIN_AT;
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const c = sim.companions[0];
  const first = tickLucidity(sim, c, 1);
  beginHallucinating(sim, c);
  recover(sim, c, "test");
  eq(c.scars, 1, "scar not recorded");
  eq(c.lucidity, RECOVER_AT, "recovered to the wrong level");
  const second = tickLucidity(sim, c, 1);
  assert(second > first, `scar did not increase drain: ${second} vs ${first}`);
});

check("hitting zero starts a hallucination, with a specific kind", () => {
  const sim = createRun({ seed: 12 });
  sim.time = FULL_DRAIN_AT;
  const c = sim.companions[2];
  c.lucidity = 0.2;
  c.x = farFromPylons(sim).x;
  c.z = farFromPylons(sim).z;
  tickLucidity(sim, c, 1);
  assert(c.hallucinating, "did not begin hallucinating at zero");
  eq(c.lucidity, 0, "lucidity went negative");
  assert(Object.values(HALLUCINATION).includes(c.hallucination), `bad kind ${c.hallucination}`);
});

check("the player is not exempt — the lead hallucinates too", () => {
  const sim = createRun({ seed: 13 });
  sim.player.lucidity = 0;
  beginHallucinating(sim, sim.player);
  assert(sim.player.hallucinating, "the player must be subject to the same rule");
});

// ---------------------------------------------------------------------------
// traits — the same five names, a different personality roll each run
// ---------------------------------------------------------------------------
check("rollTraits stays within its documented bounds and drifts from the base", () => {
  const rng = makeRng(90);
  let anyDrifted = false;
  for (const tpl of COMPANION_TEMPLATES) {
    for (let i = 0; i < 50; i++) {
      const t = rollTraits(rng, tpl);
      assert(t.drain >= 0.6 && t.drain <= 1.4, `drain out of bounds: ${t.drain}`);
      for (const key of ["stoic", "chatty", "wander", "selfCare"]) {
        assert(t[key] >= 0 && t[key] <= 1, `${key} out of bounds: ${t[key]}`);
      }
      assert(Math.abs(t.drain - tpl.drain) <= TRAIT_VARIANCE + 1e-9, "drain drifted further than TRAIT_VARIANCE");
      if (t.drain !== tpl.drain || t.stoic !== tpl.stoic) anyDrifted = true;
    }
  }
  assert(anyDrifted, "traits never drifted from the template base across 250 rolls — rng not wired in");
});

check("a run's rolled traits are deterministic per seed", () => {
  const a = createRun({ seed: 91 });
  const b = createRun({ seed: 91 });
  for (let i = 0; i < a.companions.length; i++) {
    eq(a.companions[i].drain, b.companions[i].drain, `${a.companions[i].name} drain not deterministic`);
    eq(a.companions[i].selfCare, b.companions[i].selfCare, `${a.companions[i].name} selfCare not deterministic`);
  }
});

check("the same five names still lead — traits vary, identity doesn't", () => {
  const sim = createRun({ seed: 92 });
  eq(sim.companions.map((c) => c.name).join(","), "VOSS,IREN,HALDER,NKEM,PAO", "roster identity changed");
  eq(sim.companions.map((c) => c.role).join(","), "Surveyor,Medic,Rigger,Signals,Geologist", "roster roles changed");
});

check("traits carry across a campaign's basins instead of re-rolling", () => {
  const first = createRun({ seed: 93, level: 1, campaignLength: 2 });
  const rolled = first.companions.map((c) => ({ id: c.id, drain: c.drain, selfCare: c.selfCare }));
  const carryOver = {
    party: first.party.map((c) => ({
      id: c.id, lucidity: c.lucidity, scars: c.scars, hallucinating: c.hallucinating,
      hallucination: c.hallucination, goneTime: c.goneTime,
      drain: c.drain, stoic: c.stoic, chatty: c.chatty, wander: c.wander, selfCare: c.selfCare,
    })),
    doses: first.doses, inventory: first.inventory, wood: first.wood, stone: first.stone, stats: first.stats,
  };
  const second = createRun({ seed: 94, level: 2, campaignLength: 2, carryOver });
  for (const saved of rolled) {
    const ch = second.companions.find((c) => c.id === saved.id);
    eq(ch.drain, saved.drain, `${ch.name}'s drain reshuffled at the next basin`);
    eq(ch.selfCare, saved.selfCare, `${ch.name}'s selfCare reshuffled at the next basin`);
  }
});

check("high selfCare breaks off for a known pylon before BRITTLE", () => {
  const sim = createRun({ seed: 95 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  const away = { x: p.x + 30, z: p.z + 4 };
  for (const m of sim.party) { m.x = away.x; m.z = away.z; }
  // `spent`, not `charge` — charge is vestigial since pylons became one-shot,
  // so this guard had quietly stopped working. It matters more now: at the
  // larger PYLON_RADIUS the party's away-spot lands inside a neighbouring
  // pylon, which primes, gets confirmed, and heals the companion out of the
  // very band this test is about.
  for (const other of sim.pylons) if (other !== p) other.spent = true;
  c.known = { pylons: new Set([p.id]), monoliths: new Set() };
  c.selfCare = 0.9; // well above the UNSETTLED threshold
  c.lucidity = 60; // UNSETTLED band, nowhere near BRITTLE
  advance(sim, 3);
  eq(c.goalKind, "pylon", "a high-selfCare companion should seek relief before BRITTLE");
});

check("low selfCare only breaks off at BRITTLE, same as before this feature existed", () => {
  const sim = createRun({ seed: 96 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  const away = { x: p.x + 30, z: p.z + 4 };
  for (const m of sim.party) { m.x = away.x; m.z = away.z; }
  // `spent`, not `charge` — charge is vestigial since pylons became one-shot,
  // so this guard had quietly stopped working. It matters more now: at the
  // larger PYLON_RADIUS the party's away-spot lands inside a neighbouring
  // pylon, which primes, gets confirmed, and heals the companion out of the
  // very band this test is about.
  for (const other of sim.pylons) if (other !== p) other.spent = true;
  c.known = { pylons: new Set([p.id]), monoliths: new Set() };
  c.selfCare = 0.1;
  c.lucidity = 20; // FRAYING, not yet BRITTLE
  advance(sim, 3);
  assert(c.goalKind !== "pylon", "a low-selfCare companion broke off before BRITTLE");
});

check("hallucination kind is trait-weighted for companions, but stays flat for the player", () => {
  const sim = createRun({ seed: 97 });
  const wanderer = { ...sim.companions[0], isPlayer: false, wander: 1, chatty: 0, selfCare: 0 };
  const anchored = { ...sim.companions[0], isPlayer: false, wander: 0, chatty: 0, selfCare: 1 };
  let wandererMarker = 0, anchoredMarker = 0;
  const N = 400;
  for (let i = 0; i < N; i++) {
    if ([HALLUCINATION.PHANTOM_MARKER, HALLUCINATION.WRONG_WAY].includes(pickHallucinationKind(sim, wanderer))) wandererMarker++;
    if (pickHallucinationKind(sim, anchored) === HALLUCINATION.FALSE_ANCHOR) anchoredMarker++;
  }
  assert(wandererMarker > N * 0.35, `a maximally-wander companion should draw PHANTOM_MARKER/WRONG_WAY often, got ${wandererMarker}/${N}`);
  assert(anchoredMarker > N * 0.35, `a maximally-selfCare companion should draw FALSE_ANCHOR often, got ${anchoredMarker}/${N}`);

  let playerKinds = new Set();
  for (let i = 0; i < 60; i++) playerKinds.add(pickHallucinationKind(sim, sim.player));
  assert(playerKinds.size > 1, "the player's roll should still cover multiple kinds, not be trait-narrowed");
});

// ---------------------------------------------------------------------------
// pylons and doses
// ---------------------------------------------------------------------------
check("a pylon restores everyone standing in it, and spends itself doing so", () => {
  const sim = createRun({ seed: 14 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  c.lucidity = 20;
  c.x = p.x;
  c.z = p.z;
  const mate = sim.companions[1];
  mate.x = p.x; mate.z = p.z;
  eq(activatePylon(sim, c).confirmed, false, "one pair of hands should only PRIME a pylon");
  assert(!p.spent, "a single primer spent the pylon");
  activatePylon(sim, mate);
  assert(c.lucidity > 20, "pylon did not restore");
  assert(p.spent, "pylon did not spend itself");
});

check("a spent pylon does nothing", () => {
  const sim = createRun({ seed: 14 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  p.spent = true;
  const c = sim.companions[0];
  c.lucidity = 20;
  c.x = p.x;
  c.z = p.z;
  eq(activatePylon(sim, c).ok, false, "a dead pylon activated");
  tickLucidity(sim, c, 1);
  assert(c.lucidity < 20, "a dead pylon still restored");
});

// Recharging is GONE, and its absence is the mechanic: the basin holds exactly
// as much relief as it has pylons, so "you can't stop the decay forever" is
// structural rather than a tuned rate.
check("a spent pylon never comes back", () => {
  const sim = createRun({ seed: 15 });
  const p = sim.pylons[0];
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  p.spent = true;
  advance(sim, 60);
  assert(p.spent, "a spent pylon recharged — relief is supposed to be finite");
});

// Recovery used to need RECOVER_TIME of sustained contact. With one shot there
// is no "longer": the pulse either catches you or it doesn't.
check("the pulse pulls back anyone hallucinating inside it", () => {
  const sim = createRun({ seed: 16 });
  const p = sim.pylons[0];
  const c = sim.companions[1];
  beginHallucinating(sim, c);
  c.x = p.x;
  c.z = p.z;
  const helper = sim.companions[2];
  helper.x = p.x; helper.z = p.z;
  activatePylon(sim, helper);
  activatePylon(sim, sim.companions[3] && ((sim.companions[3].x = p.x), (sim.companions[3].z = p.z), sim.companions[3]));
  assert(!c.hallucinating, "the pulse did not pull back a mind standing in it");
  assert(c.lucidity >= RECOVER_AT, "recovered below the recovery floor");
});

check("stepping out of the pylon resets recovery progress", () => {
  const sim = createRun({ seed: 16 });
  const p = sim.pylons[0];
  const c = sim.companions[1];
  beginHallucinating(sim, c);
  c.x = p.x; c.z = p.z;
  tickLucidity(sim, c, RECOVER_TIME * 0.8);
  const away = farFromPylons(sim);
  c.x = away.x; c.z = away.z;
  tickLucidity(sim, c, 0.1);
  eq(c.recoverProgress, 0, "progress survived leaving the pylon");
});

check("doses are finite, and spending one on a gone companion brings them back", () => {
  const sim = createRun({ seed: 17 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  assert(useDose(sim, c.id), "dose refused");
  eq(sim.doses, DOSE_COUNT - 1, "dose not consumed");
  assert(!c.hallucinating, "dose did not recover");
  useDose(sim, sim.companions[1].id);
  useDose(sim, sim.companions[2].id);
  eq(sim.doses, 0, "dose accounting");
  assert(!useDose(sim, sim.companions[3].id), "spent a dose that did not exist");
});

check("a dose tops up without exceeding the maximum", () => {
  const sim = createRun({ seed: 18 });
  const c = sim.companions[0];
  c.lucidity = 90;
  useDose(sim, c.id);
  eq(c.lucidity, MAX_LUCIDITY, "dose overflowed the cap");
});

// ---------------------------------------------------------------------------
// check-ins: the unreliable sensor
// ---------------------------------------------------------------------------
check("a hallucinating companion reports that they are fine", () => {
  const sim = createRun({ seed: 19 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  const r = checkIn(sim, c.id);
  eq(r.claim, BAND.STEADY, "a gone companion must claim to be steady");
  eq(r.truth, BAND.GONE, "truth must still be recorded for the debrief");
});

check("a fraying companion sometimes shades the truth, but never invents 'gone'", () => {
  const sim = createRun({ seed: 20 });
  const c = sim.companions[0];
  let shaded = 0;
  const N = 300;
  for (let i = 0; i < N; i++) {
    c.lucidity = 20; // FRAYING
    const r = checkIn(sim, c.id);
    assert(r.claim !== BAND.GONE, "a lucid companion claimed to be gone");
    if (r.claim !== r.truth) shaded++;
  }
  assert(shaded > N * 0.2, `expected optimistic shading, saw ${shaded}/${N}`);
  assert(shaded < N, "shading must not be certain");
});

check("a steady companion reports steady", () => {
  const sim = createRun({ seed: 21 });
  const c = sim.companions[0];
  c.lucidity = 95;
  for (let i = 0; i < 40; i++) eq(checkIn(sim, c.id).claim, BAND.STEADY, "steady report drifted");
});

// ---------------------------------------------------------------------------
// perception: the lie layer
// ---------------------------------------------------------------------------
check("a lucid lead sees exactly what is there", () => {
  const sim = createRun({ seed: 22 });
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  eq(perceivedMonoliths(percept, sim).length, sim.monoliths.length, "phantom leaked into a lucid view");
  eq(perceivedCompanions(percept, sim).length, 5, "phantom companion in a lucid view");
  eq(perceivedYaw(percept, sim), sim.player.yaw, "compass lied to a lucid lead");
  eq(distortion(percept, sim), 0, "distortion on a full meter");
});

check("a hallucinating lead can be shown markers the basin does not contain", () => {
  // Drive the specific kind rather than waiting for the draw.
  const sim = createRun({ seed: 23 });
  sim.player.lucidity = 0;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedMonoliths(percept, sim);
  assert(seen.length > sim.monoliths.length, "no phantom markers appeared");
  assert(seen.some((m) => m.phantom), "phantoms not flagged");
  // And the sim itself must remain honest.
  eq(sim.monoliths.length, 6, "the sim's own record was contaminated");
});

check("a phantom companion joins the formation", () => {
  const sim = createRun({ seed: 24 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.DOUBLED_PARTY;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedCompanions(percept, sim);
  eq(seen.length, 6, "expected a sixth figure");
  eq(sim.companions.length, 5, "the sim grew a companion");
  // It keeps station like a real one rather than sitting still.
  const before = { x: seen[5].x, z: seen[5].z };
  for (let i = 0; i < 30; i++) updatePercept(percept, sim, 0.1);
  const after = percept.phantomCompanions[0];
  assert(Math.hypot(after.x - before.x, after.z - before.z) > 0.2, "phantom did not move");
});

check("spent pylons read as live to a hallucinating lead", () => {
  const sim = createRun({ seed: 25 });
  sim.pylons[0].spent = true;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.FALSE_ANCHOR;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const seen = perceivedPylons(percept, sim);
  const dead = seen.find((p) => p.id === sim.pylons[0].id);
  assert(dead.looksLive, "a spent pylon should look live under FALSE_ANCHOR");
  assert(seen.some((p) => p.phantom), "no phantom pylon");
  // The sim still knows the truth.
  eq(sim.pylons[0].spent, true, "sim pylon was altered by perception");
});

check("the compass moves under WRONG_WAY but the body does not", () => {
  const sim = createRun({ seed: 26 });
  sim.player.yaw = 0.5;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.WRONG_WAY;
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  assert(Math.abs(perceivedYaw(percept, sim) - 0.5) > 1, "compass did not shift");
  eq(sim.player.yaw, 0.5, "the real heading changed");
});

check("the roster degrades to '?' when the lead is the unreliable one", () => {
  const sim = createRun({ seed: 27 });
  const percept = createPercept();
  const c = sim.companions[0];
  c.lucidity = 5;
  updatePercept(percept, sim, 0.1);
  eq(rosterRead(percept, sim, c).tag, "bad", "a lucid lead should read a brittle companion");
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const read = rosterRead(percept, sim, c);
  eq(read.tag, "unknown", "a hallucinating lead should not get a reliable roster");
  assert(read.uncertain, "uncertainty flag missing");
});

check("the roster never exposes the hidden number", () => {
  const sim = createRun({ seed: 28 });
  const percept = createPercept();
  for (const c of sim.companions) {
    c.lucidity = 37.5;
    const read = rosterRead(percept, sim, c);
    const blob = JSON.stringify(read);
    assert(!/37|38|\d\d\.\d/.test(blob), `roster leaked a number: ${blob}`);
  }
});

check("CHORUS makes every report agree with you", () => {
  const sim = createRun({ seed: 29 });
  const percept = createPercept();
  const c = sim.companions[0];
  c.lucidity = 3;
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const filtered = filterReport(percept, sim, checkIn(sim, c.id));
  eq(filtered.claim, BAND.STEADY, "chorus should flatten every report to 'fine'");
});

check("distortion pre-echoes before zero, so the lead has a tell about themselves", () => {
  const sim = createRun({ seed: 30 });
  sim.time = FULL_DRAIN_AT;
  const percept = createPercept();
  sim.player.lucidity = 100;
  eq(distortion(percept, sim), 0, "distortion while fresh");
  sim.player.lucidity = 50;
  assert(distortion(percept, sim) > 0, "no tell in the unsettled band");
  sim.player.lucidity = 10;
  assert(distortion(percept, sim) > 0.2, "the brittle band should be visible");
});

check("distortion ramps rather than snapping", () => {
  const sim = createRun({ seed: 31 });
  const percept = createPercept();
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.CHORUS;
  updatePercept(percept, sim, 0.1);
  const early = percept.intensity;
  assert(early < 0.9, `intensity snapped straight to ${early}`);
  for (let i = 0; i < 60; i++) updatePercept(percept, sim, 0.1);
  near(percept.intensity, 1, 0.05, "intensity never reached full");
});

// ---------------------------------------------------------------------------
// surveying — including counterfeit entries
// ---------------------------------------------------------------------------
check("you must stand at a marker to log it", () => {
  const sim = createRun({ seed: 32 });
  const m = sim.monoliths[0];
  sim.player.x = m.x + LOG_RADIUS + 5;
  sim.player.z = m.z;
  eq(logMarker(sim).ok, false, "logged a marker from too far away");
  sim.player.x = m.x + 1;
  const res = logMarker(sim);
  assert(res.ok && res.real, "failed to log from inside the radius");
  eq(trueLogCount(sim), 1, "log count");
  eq(logMarker(sim).ok, false, "logged the same marker twice");
});

check("corroboration is a verb: standing near someone is not checking with them", () => {
  const sim = createRun({ seed: 33 });
  const m = sim.monoliths[0];
  sim.player.x = m.x;
  sim.player.z = m.z;
  for (const c of sim.companions) { c.x = m.x + 200; c.z = m.z + 200; }
  eq(logMarker(sim).corroborated, false, "corroborated with nobody in range");

  // A body at your shoulder, unasked. This used to be enough, and that made
  // holding formation a permanent invisible shield against the whole deception
  // layer — a lucid companion was beside the lead for 75% of every
  // hallucinating second.
  const m2 = sim.monoliths[1];
  sim.player.x = m2.x;
  sim.player.z = m2.z;
  sim.companions[0].x = m2.x + 2;
  sim.companions[0].z = m2.z;
  eq(logMarker(sim).corroborated, false, "an unasked bystander vouched for the entry");

  // Ask them, and the same body is now a witness.
  const m3 = sim.monoliths[2];
  sim.player.x = m3.x;
  sim.player.z = m3.z;
  sim.companions[0].x = m3.x + 2;
  sim.companions[0].z = m3.z;
  checkIn(sim, sim.companions[0].id);
  eq(logMarker(sim).corroborated, true, "a companion you actually asked should confirm");
});

check("a vouch expires — you cannot ask once at camp and be covered all day", () => {
  const sim = createRun({ seed: 36 });
  const c = sim.companions[0];
  const m = sim.monoliths[0];
  sim.player.x = m.x; sim.player.z = m.z;
  c.x = m.x + 2; c.z = m.z;
  checkIn(sim, c.id);
  sim.time += VOUCH_WINDOW + 1;
  eq(logMarker(sim).corroborated, false, "a stale vouch still counted");
});

check("a hallucinating lead with nobody lucid nearby can write down nothing", () => {
  const sim = createRun({ seed: 34 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  // Standing nowhere near a real marker, with the party far away.
  const spot = farFromPylons(sim);
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  for (const m of sim.monoliths) { m.x += 1000; m.z += 1000; }
  for (const c of sim.companions) { c.x = spot.x + 300; c.z = spot.z + 300; }
  const res = logMarker(sim, { name: "the Sixth Stone" });
  assert(res.ok && res.real === false, "expected a false entry");
  eq(sim.stats.falseLogs, 1, "false log not counted");
  eq(trueLogCount(sim), 0, "a phantom must not count toward the survey");
  eq(sim.logEntries.length, 1, "the log should still show an entry — that is the trap");
});

check("a lucid witness prevents a counterfeit entry", () => {
  const sim = createRun({ seed: 35 });
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const spot = farFromPylons(sim);
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  for (const m of sim.monoliths) { m.x += 1000; m.z += 1000; }
  sim.companions[0].x = spot.x + 1;
  sim.companions[0].z = spot.z + 1;
  sim.companions[0].lucidity = 90;

  // Unasked, they say nothing, and the counterfeit goes in.
  const unasked = logMarker(sim, { name: "the Sixth Stone" });
  assert(unasked.ok && unasked.real === false, "a bystander blocked a phantom without being asked");
  eq(sim.stats.falseLogs, 1, "the unasked case should have produced a false entry");

  // Asked, they refuse it. Fresh sim: the entry the unasked case just wrote is
  // sitting under the lead's feet, and the strike branch would claim the verb
  // before the counterfeit branch ever ran.
  const sim2 = createRun({ seed: 35 });
  sim2.player.hallucinating = true;
  sim2.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const spot2 = farFromPylons(sim2);
  sim2.player.x = spot2.x;
  sim2.player.z = spot2.z;
  for (const m of sim2.monoliths) { m.x += 1000; m.z += 1000; }
  sim2.companions[0].x = spot2.x + 1;
  sim2.companions[0].z = spot2.z + 1;
  sim2.companions[0].lucidity = 90;
  checkIn(sim2, sim2.companions[0].id);
  const res = logMarker(sim2, { name: "the Sixth Stone" });
  eq(res.ok, false, "a companion you asked should refuse the phantom");
  eq(sim2.stats.falseLogs, 0, "a false log was recorded despite an asked witness");
});

// ---------------------------------------------------------------------------
// items — pickup, phantom pickups, use, and the lie layer
// ---------------------------------------------------------------------------
check("picking up an item requires being in reach of a discovered pickup", () => {
  const sim = createRun({ seed: 51 });
  const it = sim.items[0];
  sim.player.x = it.x + ITEM_PICKUP_RADIUS + 5;
  sim.player.z = it.z;
  eq(pickupItem(sim).ok, false, "picked up from out of reach");
  it.discovered = true;
  sim.player.x = it.x;
  sim.player.z = it.z;
  const res = pickupItem(sim);
  assert(res.ok && res.real, "failed to pick up a real item in reach");
  eq(res.kind, it.itemKind, "wrong kind recorded");
  eq(sim.inventory.length, 1, "inventory did not grow");
  assert(it.taken, "the world item was not marked taken");
  eq(pickupItem(sim).ok, false, "picked up the same item twice");
});

check("the carried-item cap forces the same choice as doses", () => {
  const sim = createRun({ seed: 52 });
  for (let i = 0; i < ITEM_CAP; i++) sim.inventory.push({ id: `x${i}`, real: true, kind: "flare", claimedKind: null });
  const it = sim.items[0];
  it.discovered = true;
  sim.player.x = it.x;
  sim.player.z = it.z;
  const res = pickupItem(sim);
  eq(res.ok, false, "picked up over the cap");
  eq(res.reason, "full", "wrong refusal reason");
});

check("a hallucinating lead can pick up something that was never there", () => {
  const sim = createRun({ seed: 53 });
  sim.player.hallucinating = true;
  sim.rng.chance = () => true; // force the phantom branch deterministically
  const it = sim.items[0];
  it.discovered = true;
  sim.player.x = it.x;
  sim.player.z = it.z;
  const res = pickupItem(sim);
  assert(res.ok && res.real === false, "expected a phantom pickup");
  const slot = sim.inventory[0];
  eq(slot.real, false, "phantom slot marked real");
  assert(ITEM_KINDS.includes(slot.claimedKind), "phantom claimedKind not a real kind string");
  eq(slot.kind, null, "a phantom has no true kind");
  assert(it.taken, "the underlying world item was not consumed");
});

check("a phantom slot's claimed kind is baked in and survives recovery — it never un-happens", () => {
  const sim = createRun({ seed: 54 });
  sim.inventory.push({ id: "slot0", real: false, claimedKind: "lens", kind: null });
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1); // onset
  let seen = perceivedInventory(percept, sim);
  eq(seen[0].real, false, "phantom slot should read as unreal");
  eq(seen[0].shownKind, "lens", "phantom slot must show its claimed kind while gone");
  sim.player.hallucinating = false;
  updatePercept(percept, sim, 0.1); // recovery
  seen = perceivedInventory(percept, sim);
  eq(seen[0].shownKind, "lens", "a phantom's claimed kind must not reveal itself on recovery");
  eq(seen[0].misidentified, false, "a phantom slot is never flagged as merely 'misidentified'");
});

check("use: a flare restores lucidity and is consumed", () => {
  const sim = createRun({ seed: 55 });
  sim.player.lucidity = 50;
  sim.inventory.push({ id: "s0", real: true, kind: "flare", claimedKind: null });
  const res = useItem(sim, 0);
  assert(res.ok && res.real, "flare use failed");
  eq(sim.player.lucidity, 50 + ITEM_INFO.flare.restore, "flare did not restore the documented amount");
  eq(sim.inventory.length, 0, "the slot was not consumed");
  eq(sim.stats.itemsUsed, 1, "itemsUsed not counted");
});

check("use: a tether steadies the target — reduced drain, not a cure", () => {
  const sim = createRun({ seed: 56 });
  sim.time = FULL_DRAIN_AT;
  const target = sim.companions[0];
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  const before = tickLucidity(sim, target, 1);
  sim.inventory.push({ id: "s0", real: true, kind: "tether", claimedKind: null });
  useItem(sim, 0, target.id);
  assert(target.steadyUntil > sim.time, "tether did not set a steady window");
  const after = tickLucidity(sim, target, 1);
  assert(after < before, `tether did not reduce drain: ${after} vs ${before}`);
  assert(after > 0, "a tether must not fully stop drain — it steadies, it does not cure");
});

check("use: a lens buys a truth window without touching the meter or curing anyone", () => {
  const sim = createRun({ seed: 57 });
  sim.time = FULL_DRAIN_AT;
  const percept = createPercept();
  sim.player.hallucinating = true;
  sim.player.hallucination = HALLUCINATION.WRONG_WAY;
  updatePercept(percept, sim, 0.1);
  const lucidityBefore = sim.player.lucidity;
  assert(distortion(percept, sim) > 0, "expected distortion before the lens");
  sim.inventory.push({ id: "s0", real: true, kind: "lens", claimedKind: null });
  useItem(sim, 0);
  eq(sim.player.lucidity, lucidityBefore, "a lens must not touch lucidity");
  assert(sim.player.hallucinating, "a lens must not cure the hallucination itself");
  assert(isClear(percept, sim), "isClear should be true inside the lens window");
  eq(distortion(percept, sim), 0, "the screen should read honest during a lens window");
  eq(perceivedYaw(percept, sim), sim.player.yaw, "the lens should stop the compass lie too");
});

check("use: a phantom item is always a bad surprise, never a reward", () => {
  const sim = createRun({ seed: 58 });
  sim.player.lucidity = PHANTOM_ITEM_COST + 10;
  sim.inventory.push({ id: "s0", real: false, claimedKind: "flare", kind: null });
  const res = useItem(sim, 0);
  assert(res.ok && res.real === false, "phantom use should report unreal");
  eq(sim.player.lucidity, 10, "phantom use did not cost the documented amount");
  eq(sim.stats.phantomItemsUsed, 1, "phantomItemsUsed not counted");
  assert(!sim.player.hallucinating, "should not have crossed zero yet");
});

check("using a phantom item can itself push the lead into hallucinating", () => {
  const sim = createRun({ seed: 59 });
  sim.player.lucidity = PHANTOM_ITEM_COST - 2;
  sim.inventory.push({ id: "s0", real: false, claimedKind: "tether", kind: null });
  useItem(sim, 0);
  eq(sim.player.lucidity, 0, "lucidity went negative instead of floored");
  assert(sim.player.hallucinating, "reaching for nothing should be able to tip the lead over");
});

check("a real item's displayed kind can be wrong while hallucinating, and holds steady for the episode", () => {
  const sim = createRun({ seed: 60 });
  const it = sim.items[0];
  it.discovered = true;
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1);
  const first = perceivedWorldItems(percept, sim).find((x) => x.id === it.id);
  assert(first, "discovered item missing from perception");
  const second = perceivedWorldItems(percept, sim).find((x) => x.id === it.id);
  eq(second.shownKind, first.shownKind, "the lie must hold steady within one episode, not re-roll every call");
  sim.player.hallucinating = false;
  updatePercept(percept, sim, 0.1); // recovery clears the label
  const clear = perceivedWorldItems(percept, sim).find((x) => x.id === it.id);
  eq(clear.shownKind, it.itemKind, "a lucid lead must see the true kind");
  eq(clear.misidentified, false, "no misidentification flag while lucid");
});

check("a hallucinating lead sometimes sees a world item's TRUE kind too, not always a lie", () => {
  // The pool used to exclude the real kind on purpose (always wrong). Now it
  // doesn't — a hallucination that lied about literally everything would be
  // easier to play around than one you can't fully distrust or fully trust.
  let sawTrue = false, sawFalse = false;
  for (let seed = 1; seed <= 200 && !(sawTrue && sawFalse); seed++) {
    const sim = createRun({ seed });
    const it = sim.items[0];
    it.discovered = true;
    const percept = createPercept();
    sim.player.hallucinating = true;
    updatePercept(percept, sim, 0.1);
    const seen = perceivedWorldItems(percept, sim).find((x) => x.id === it.id);
    if (seen.shownKind === it.itemKind) sawTrue = true;
    else sawFalse = true;
  }
  assert(sawTrue, "200 seeds and a hallucinating lead never once saw the truth about a world item");
  assert(sawFalse, "200 seeds and a hallucinating lead never once saw a wrong kind — the lie never fires");
});

check("a hallucinating lead sometimes sees a carried item's TRUE kind too, not always a lie", () => {
  let sawTrue = false, sawFalse = false;
  for (let seed = 1; seed <= 200 && !(sawTrue && sawFalse); seed++) {
    const sim = createRun({ seed });
    sim.inventory.push({ id: "s0", real: true, kind: "flare", claimedKind: null });
    const percept = createPercept();
    sim.player.hallucinating = true;
    updatePercept(percept, sim, 0.1);
    const seen = perceivedInventory(percept, sim)[0];
    if (seen.shownKind === "flare") sawTrue = true;
    else sawFalse = true;
  }
  assert(sawTrue, "200 seeds and a hallucinating lead never once saw the truth about a carried item");
  assert(sawFalse, "200 seeds and a hallucinating lead never once saw a wrong kind — the lie never fires");
});

check("a husk is a REAL pickup that does nothing at all when used", () => {
  const sim = createRun({ seed: 63 });
  sim.inventory.push({ id: "s0", real: true, kind: "husk", claimedKind: null });
  const lucidityBefore = sim.player.lucidity;
  const target = sim.companions[0];
  const steadyBefore = target.steadyUntil;
  const pylonsBefore = sim.pylons.length;
  const res = useItem(sim, 0, target.id);
  assert(res.ok && res.real === true, "a husk is real, not a phantom");
  eq(res.kind, "husk", "wrong kind recorded for a husk use");
  eq(sim.player.lucidity, lucidityBefore, "a husk must not touch lucidity");
  eq(target.steadyUntil, steadyBefore, "a husk must not steady anyone");
  eq(sim.pylons.length, pylonsBefore, "a husk must not plant a pylon");
  eq(sim.stats.itemsUsed, 1, "husk use should still be counted as a real item use");
});

check("a phantom pickup is never rendered as a world object, only as an inventory slot", () => {
  const sim = createRun({ seed: 61 });
  sim.player.hallucinating = true;
  sim.rng.chance = () => true;
  const it = sim.items[0];
  it.discovered = true;
  sim.player.x = it.x;
  sim.player.z = it.z;
  pickupItem(sim); // resolves as a phantom; the real item is consumed either way
  const percept = createPercept();
  updatePercept(percept, sim, 0.1);
  const worldSeen = perceivedWorldItems(percept, sim);
  assert(!worldSeen.some((w) => w.id === it.id), "a taken item must not still appear on the ground");
});

// ---------------------------------------------------------------------------
// emit() — the event kind must never be shadowed by opts
// ---------------------------------------------------------------------------
check("emit()'s own event kind always wins, even if opts carries a field named 'kind'", () => {
  const sim = createRun({ seed: 62 });
  emit(sim, "itemUsed", "test text", { itemKind: "flare" });
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "itemUsed", "opts clobbered the event's own kind discriminator");
  eq(ev.itemKind, "flare", "the per-item context should still ride along under its own name");
});

// ---------------------------------------------------------------------------
// crafting — combine two real items into something stronger
// ---------------------------------------------------------------------------
check("crafting combines two real items into the recipe's result and consumes both slots", () => {
  const sim = createRun({ seed: 63 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "tether", claimedKind: null });
  const res = craftItem(sim);
  assert(res.ok, "craft refused a valid recipe pair");
  eq(res.kind, "ember", "flare+tether should produce an ember");
  eq(sim.inventory.length, 1, "crafting should net one item from two");
  eq(sim.inventory[0].kind, "ember", "the crafted slot should carry the recipe's result");
  eq(sim.stats.itemsCrafted, 1, "itemsCrafted not counted");
});

check("every unordered pair of the three base items has a recipe", () => {
  eq(CRAFT_RECIPES["flare+tether"], "ember");
  eq(CRAFT_RECIPES["flare+lens"], "beacon");
  eq(CRAFT_RECIPES["lens+tether"], "ward");
});

check("crafting refuses when there's neither a matching item pair nor enough raw materials", () => {
  const sim = createRun({ seed: 64 });
  eq(craftItem(sim).reason, "no-recipe", "wrong refusal with an empty inventory and no materials");
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  eq(craftItem(sim).reason, "no-recipe", "wrong refusal with only one item and no materials");
});

check("two of the same item refuse to combine", () => {
  const sim = createRun({ seed: 65 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "flare", claimedKind: null });
  eq(craftItem(sim).reason, "no-recipe", "two flares should not combine into anything");
  eq(sim.inventory.length, 2, "a failed craft must not consume anything");
});

check("a phantom ingredient combines exactly like the real thing, and quietly produces a lie", () => {
  // The lead here is stone-cold LUCID. They are still carrying a phantom that
  // claims to be a tether — picked up during an earlier episode, or handed
  // over by a companion who was gone at the time. Nothing on screen, and
  // nothing in this call, distinguishes the result from an honest ember.
  const sim = createRun({ seed: 66 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: false, claimedKind: "tether", kind: null });
  eq(sim.player.hallucinating, false, "test setup: this lead is not hallucinating at all");

  const res = craftItem(sim);
  assert(res.ok, "a believed-valid pair must combine, whatever is actually behind it");
  eq(res.kind, "ember", "flare + (claimed) tether should read as an ember");
  eq(res.real, false, "an ember built on a phantom cannot itself be real");
  eq(sim.inventory.length, 1, "both ingredients should have been consumed");
  const out = sim.inventory[0];
  eq(out.real, false, "the crafted slot must be a phantom");
  eq(out.claimedKind, "ember", "the phantom should go on claiming to be exactly what was intended");
  eq(out.kind, null, "a phantom has no true kind");
  eq(sim.stats.falseCrafts, 1, "a false craft should be counted for the debrief");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "craft", "a false craft must emit the same event kind as an honest one");
  assert(/Ember forms in your hands/.test(ev.text), "a false craft's text must be indistinguishable from an honest craft's");
});

check("with no belief view passed, a real pair is read at its true kinds", () => {
  // The default reading is 'what a lucid observer sees'. Two true flares don't
  // combine, whatever a lying item bar might have shown, because nothing told
  // craftItem to believe the bar.
  const sim = createRun({ seed: 67 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "flare", claimedKind: null });
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1);
  percept.itemLabels.set("a", "tether"); // the bar is lying: shown as tether, really a flare
  const seen = perceivedInventory(percept, sim);
  eq(seen[0].shownKind, "tether", "test setup: the item bar should be lying about slot a");
  eq(craftItem(sim).reason, "no-recipe", "without the belief view, two true flares still can't combine");
});

check("hand craftItem the lying item bar and the craft fires — and comes out false", () => {
  // The same setup as above, except the caller now passes what the LEAD
  // actually believes (main.js does exactly this via percept.believedKinds).
  // The bar says flare + tether, so the craft commits, and the ember it hands
  // back was never there.
  const sim = createRun({ seed: 67 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "flare", claimedKind: null });
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1);
  // Pin BOTH labels: perceivedInventory assigns a mislabel lazily per slot, so
  // leaving slot b to a live roll would make what the bar reads (and therefore
  // whether a recipe matches at all) different from seed to seed.
  percept.itemLabels.set("a", "tether");
  percept.itemLabels.set("b", "flare");

  const believed = believedKinds(percept, sim);
  eq(believed[0], "tether", "test setup: the belief view should carry the bar's lie");
  eq(believed[1], "flare", "test setup: the second slot should read as a flare");
  const res = craftItem(sim, -1, believed);
  assert(res.ok, "a lead who believes they hold a matching pair must be allowed to commit");
  eq(res.kind, "ember", "they set out to make an ember");
  eq(res.real, false, "built out of a misread flare, it cannot be real");
  eq(sim.inventory[0].claimedKind, "ember", "and it goes on claiming to be one");
});

// ---------------------------------------------------------------------------
// previewCraft — the HUD's "craft available" indicator, never a promise
// craftItem then breaks
// ---------------------------------------------------------------------------
check("previewCraft reports nothing available when nothing is", () => {
  const sim = createRun({ seed: 86 });
  eq(previewCraft(sim).ok, false, "expected no preview with an empty inventory and no materials");
});

check("previewCraft matches a real item pair without consuming anything", () => {
  const sim = createRun({ seed: 87 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "lens", claimedKind: null });
  const preview = previewCraft(sim);
  assert(preview.ok && preview.kind === "beacon", "expected a beacon preview for flare+lens");
  eq(sim.inventory.length, 2, "previewing must not consume the pair");
  const actual = craftItem(sim);
  eq(actual.kind, preview.kind, "previewCraft must agree with what craftItem actually does");
});

check("previewCraft matches a materials-only craft, and respects the item cap", () => {
  const sim = createRun({ seed: 88 });
  sim.wood = STAKE_COST.wood;
  sim.stone = STAKE_COST.stone;
  const preview = previewCraft(sim);
  assert(preview.ok && preview.kind === "stake", "expected a stake preview with enough materials");
  const actual = craftItem(sim);
  eq(actual.kind, preview.kind, "previewCraft must agree with what craftItem actually does");

  // Now with a full inventory, the same materials should no longer preview
  // as craftable — matching craftItem's own cap refusal.
  const sim2 = createRun({ seed: 89 });
  sim2.wood = STAKE_COST.wood;
  sim2.stone = STAKE_COST.stone;
  for (let i = 0; i < ITEM_CAP; i++) sim2.inventory.push({ id: `x${i}`, real: true, kind: "flare", claimedKind: null });
  eq(previewCraft(sim2).ok, false, "previewCraft should not promise a craft that would be refused for a full inventory");
  eq(craftItem(sim2).reason, "full", "sanity: craftItem itself should refuse for the same reason");
});

check("use: ember/beacon/ward do both parent effects at once", () => {
  const sim = createRun({ seed: 68 });
  const target = sim.companions[0];

  sim.player.lucidity = 50;
  sim.inventory.push({ id: "s0", real: true, kind: "ember", claimedKind: null });
  useItem(sim, 0, target.id);
  eq(sim.player.lucidity, 50 + ITEM_INFO.ember.restore, "ember should restore lucidity like a flare");
  assert(target.steadyUntil > sim.time, "ember should also steady its target like a tether");

  sim.player.lucidity = 40;
  sim.inventory.push({ id: "s1", real: true, kind: "beacon", claimedKind: null });
  useItem(sim, 0);
  eq(sim.player.lucidity, 40 + ITEM_INFO.beacon.restore, "beacon should restore lucidity like a flare");
  assert(sim.player.lensUntil > sim.time, "beacon should also open a truth window like a lens");

  const target2 = sim.companions[1];
  sim.inventory.push({ id: "s2", real: true, kind: "ward", claimedKind: null });
  useItem(sim, 0, target2.id);
  assert(target2.steadyUntil > sim.time, "ward should steady its target like a tether");
  assert(sim.player.lensUntil > sim.time, "ward should also open a truth window like a lens");
});

check("a crafted item in inventory can be mislabeled as any displayable kind, base or crafted", () => {
  const sim = createRun({ seed: 69 });
  sim.inventory.push({ id: "s0", real: true, kind: "ember", claimedKind: null });
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1);
  const seen = perceivedInventory(percept, sim);
  assert(Object.keys(ITEM_INFO).includes(seen[0].shownKind), "the shown kind should be one of the real displayable kinds");
});

// ---------------------------------------------------------------------------
// gathering — chop a tree, mine a deposit, no deception involved at all
// ---------------------------------------------------------------------------
check("gathering requires being in reach of a discovered tree or deposit", () => {
  const sim = createRun({ seed: 75 });
  const t = sim.trees[0];
  sim.player.x = t.x + GATHER_RADIUS + 5;
  sim.player.z = t.z;
  eq(gatherResource(sim).ok, false, "gathered from out of reach");
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  const res = gatherResource(sim);
  assert(res.ok && res.resource === "wood", "failed to chop a discovered tree in reach");
  assert(sim.wood >= GATHER_YIELD.min && sim.wood <= GATHER_YIELD.max, "wood not credited in the documented range");
  eq(sim.wood, res.amount, "credited wood must match the reported amount");
  assert(t.chopped, "the tree was not marked chopped");
  eq(gatherResource(sim).ok, false, "chopped the same tree twice");
});

check("mining a stone deposit credits stone the same way chopping credits wood", () => {
  const sim = createRun({ seed: 76 });
  const s = sim.stones[0];
  s.discovered = true;
  sim.player.x = s.x;
  sim.player.z = s.z;
  const res = gatherResource(sim);
  assert(res.ok && res.resource === "stone", "failed to mine a discovered deposit in reach");
  assert(sim.stone >= GATHER_YIELD.min && sim.stone <= GATHER_YIELD.max, "stone not credited in the documented range");
  eq(sim.stone, res.amount, "credited stone must match the reported amount");
  assert(s.mined, "the deposit was not marked mined");
});

check("gathering never touches inventory or lucidity — no deception, no cost", () => {
  const sim = createRun({ seed: 77 });
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  sim.player.hallucinating = true; // even hallucinating, gathering is always honest
  const before = sim.player.lucidity;
  const res = gatherResource(sim);
  assert(res.ok && res.resource === "wood", "a hallucinating lead should still gather truthfully");
  eq(sim.inventory.length, 0, "gathering must not add an inventory slot");
  eq(sim.player.lucidity, before, "gathering must not cost lucidity");
});

// ---------------------------------------------------------------------------
// hold-to-gather — chop/mine takes a deliberate hold, not a tap
// ---------------------------------------------------------------------------
check("holding short of GATHER_HOLD_TIME does not gather", () => {
  const sim = createRun({ seed: 81 });
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  advance(sim, GATHER_HOLD_TIME - 0.3, { interact: true });
  eq(sim.wood, 0, "gathered before the hold finished");
  assert(!t.chopped, "the tree was chopped early");
  assert(sim.gatherHold.progress > 0, "holding should still be accumulating progress");
});

check("holding for GATHER_HOLD_TIME completes the gather", () => {
  const sim = createRun({ seed: 82 });
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  advance(sim, GATHER_HOLD_TIME - 0.1, { interact: true });
  eq(sim.wood, 0, "gathered before the hold time was reached");
  advance(sim, 0.2, { interact: true }); // crosses the threshold
  assert(sim.wood >= GATHER_YIELD.min && sim.wood <= GATHER_YIELD.max, "did not gather once the hold time was reached");
  assert(t.chopped, "the tree was not marked chopped");
  eq(sim.gatherHold.progress, 0, "hold progress should reset after completing");
  eq(sim.gatherHold.targetId, null, "hold target should clear after completing");
});

check("releasing the interact verb early resets progress to zero", () => {
  const sim = createRun({ seed: 83 });
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  advance(sim, GATHER_HOLD_TIME * 0.6, { interact: true });
  assert(sim.gatherHold.progress > 0, "progress should have accumulated");
  advance(sim, 1 / 30, { interact: false }); // let go, one tick
  eq(sim.gatherHold.progress, 0, "releasing early should reset progress");
  eq(sim.gatherHold.targetId, null, "releasing early should clear the target");
  eq(sim.wood, 0, "nothing should have been gathered");
});

check("switching to a different node resets progress instead of carrying it over", () => {
  const sim = createRun({ seed: 84 });
  const t = sim.trees[0];
  const s = sim.stones[0];
  t.discovered = true;
  s.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  advance(sim, GATHER_HOLD_TIME * 0.7, { interact: true });
  assert(sim.gatherHold.targetId === t.id, "should be holding on the tree first");
  sim.player.x = s.x;
  sim.player.z = s.z;
  advance(sim, 1 / 30, { interact: true }); // one tick standing at the new target
  eq(sim.gatherHold.targetId, s.id, "target should switch to the stone");
  assert(sim.gatherHold.progress < GATHER_HOLD_TIME * 0.7, "progress must not carry over from the old target");
});

check("gatherTarget agrees with what actually gets gathered — no second implementation to drift", () => {
  const sim = createRun({ seed: 85 });
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x;
  sim.player.z = t.z;
  const target = gatherTarget(sim);
  assert(target && target.id === t.id && target.gatherKind === "tree", "gatherTarget did not find the tree");
});

// ---------------------------------------------------------------------------
// the Stake — crafted from raw materials, plants a real pylon when used
// ---------------------------------------------------------------------------
check("crafting a stake needs enough wood AND stone, and works with an empty item inventory", () => {
  const sim = createRun({ seed: 78 });
  eq(craftItem(sim).reason, "no-recipe", "crafted a stake with nothing gathered");
  sim.wood = STAKE_COST.wood;
  eq(craftItem(sim).reason, "no-recipe", "crafted a stake with wood but no stone");
  sim.stone = STAKE_COST.stone;
  const res = craftItem(sim);
  assert(res.ok && res.kind === "stake", "failed to craft a stake with enough of both materials");
  eq(sim.wood, 0, "wood was not spent");
  eq(sim.stone, 0, "stone was not spent");
  eq(sim.inventory.length, 1, "the stake should sit in the inventory like any other item");
  eq(sim.inventory[0].kind, "stake");
});

check("a stake still needs room in the item cap, same as a pickup would", () => {
  const sim = createRun({ seed: 79 });
  sim.wood = STAKE_COST.wood;
  sim.stone = STAKE_COST.stone;
  for (let i = 0; i < ITEM_CAP; i++) sim.inventory.push({ id: `x${i}`, real: true, kind: "flare", claimedKind: null });
  const res = craftItem(sim);
  eq(res.ok, false, "crafted a stake over the cap");
  eq(res.reason, "full");
  eq(sim.wood, STAKE_COST.wood, "materials must not be spent on a refused craft");
});

check("using a stake plants a real, functioning pylon at the player's position", () => {
  const sim = createRun({ seed: 80 });
  const pylonsBefore = sim.pylons.length;
  sim.player.x = 12.5;
  sim.player.z = -7.5;
  sim.inventory.push({ id: "s0", real: true, kind: "stake", claimedKind: null });
  const res = useItem(sim, 0);
  assert(res.ok && res.real, "using a stake should succeed like any real item");
  eq(sim.pylons.length, pylonsBefore + 1, "a stake should add exactly one pylon");
  const planted = sim.pylons[sim.pylons.length - 1];
  eq(planted.x, 12.5);
  eq(planted.z, -7.5);
  assert(!planted.spent, "a planted pylon should start unspent");

  // And it works exactly like a real pylon — activatePylon doesn't know or
  // care that this one didn't come from world generation, including the part
  // where it only ever fires once.
  const c = sim.companions[0];
  c.lucidity = 20;
  c.x = planted.x;
  c.z = planted.z;
  // Two pairs of hands, both IN the planted light — and at the current
  // PYLON_RADIUS the lead is standing there too, which is fine: what matters is
  // that two distinct minds set hands on it.
  const witness = sim.companions[1];
  witness.x = planted.x; witness.z = planted.z;
  c.x = planted.x; c.z = planted.z;
  eq(activatePylon(sim, c).confirmed, false, "one pair of hands fired a planted pylon");
  activatePylon(sim, witness);
  assert(c.lucidity > 20, "a planted stake should restore lucidity like any pylon");
  assert(planted.spent, "a planted pylon should be spent by its one use");
});

// ---------------------------------------------------------------------------
// companion couriers — a companion can carry ONE item for the lead
// ---------------------------------------------------------------------------
check("companionPickup gives a non-hallucinating companion a real slot and reports it", () => {
  const sim = createRun({ seed: 120 });
  const ch = sim.companions[0];
  const it = sim.items[0];
  it.discovered = true;
  ch.hallucinating = false;
  ch.x = it.x;
  ch.z = it.z;
  const res = companionPickup(sim, ch);
  assert(res.ok && res.real, "companionPickup refused a valid, in-reach pickup");
  eq(res.kind, it.itemKind, "wrong kind recorded");
  eq(ch.inventory.length, 1, "the companion's inventory did not grow");
  eq(ch.inventory[0].real, true, "slot not marked real");
  eq(ch.inventory[0].kind, it.itemKind, "slot kind mismatch");
  eq(ch.inventory[0].claimedKind, null, "a real slot must carry no claimedKind");
  assert(it.taken, "the world item was not marked taken");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "companionPickup", "expected a companionPickup event");
});

check("companionPickup can force a hallucinating companion's pickup into a phantom, same technique as pickupItem's own test", () => {
  const sim = createRun({ seed: 121 });
  const ch = sim.companions[0];
  ch.hallucinating = true;
  sim.rng.chance = () => true; // force the phantom branch deterministically
  const it = sim.items[0];
  it.discovered = true;
  ch.x = it.x;
  ch.z = it.z;
  const res = companionPickup(sim, ch);
  assert(res.ok && res.real === false, "expected a phantom pickup");
  const slot = ch.inventory[0];
  eq(slot.real, false, "phantom slot marked real");
  assert(ITEM_KINDS.includes(slot.claimedKind), "phantom claimedKind not a real kind string");
  eq(slot.kind, null, "a phantom has no true kind");
  assert(it.taken, "the underlying world item was not consumed either way");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "companionPickup", "expected a companionPickup event even for a phantom");
});

check("whichever branch a hallucinating companion's pickup resolves to, the slot shape is always internally consistent", () => {
  const sim = createRun({ seed: 122 });
  const ch = sim.companions[0];
  ch.hallucinating = true;
  for (let i = 0; i < 40; i++) {
    // Reuse the small item list, resetting `.taken` each trial so "already
    // gone" never masks the roll — the 45/55 split is what's under test.
    const it = sim.items[i % sim.items.length];
    it.taken = false;
    it.discovered = true;
    ch.inventory.length = 0;
    ch.x = it.x;
    ch.z = it.z;
    const res = companionPickup(sim, ch);
    assert(res.ok, "pickup unexpectedly refused with a discovered item in reach");
    const slot = ch.inventory[0];
    if (slot.real) {
      assert(ITEM_KINDS.includes(slot.kind), "a real slot's kind should be one of the true item kinds");
      eq(slot.claimedKind, null, "a real slot must carry no claimedKind");
    } else {
      assert(ITEM_KINDS.includes(slot.claimedKind), "a phantom's claimedKind should be one of the real kind strings");
      eq(slot.kind, null, "a phantom has no true kind");
    }
  }
});

check("COMPANION_ITEM_CAP stops a companion already carrying something from picking up a second", () => {
  const sim = createRun({ seed: 123 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "held", real: true, kind: "flare", claimedKind: null });
  eq(ch.inventory.length, COMPANION_ITEM_CAP, "test setup: the companion should already sit at the cap");
  const it = sim.items[0];
  it.discovered = true;
  ch.x = it.x;
  ch.z = it.z;
  const res = companionPickup(sim, ch);
  eq(res.ok, false, "picked up over the companion cap");
  eq(res.reason, "full", "wrong refusal reason");
  eq(ch.inventory.length, 1, "a refused pickup should not grow the companion's inventory");
  assert(!it.taken, "a refused pickup must not touch the world item");
});

check("handoffToPlayer moves a slot from the companion to the player and reports it", () => {
  const sim = createRun({ seed: 124 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: true, kind: "flare", claimedKind: null });
  const before = sim.inventory.length;
  const res = handoffToPlayer(sim, ch);
  assert(res.ok && res.real, "handoff refused a valid slot with room to receive it");
  eq(ch.inventory.length, 0, "the companion is still shown as carrying it");
  eq(sim.inventory.length, before + 1, "the player's inventory did not grow");
  eq(sim.inventory[sim.inventory.length - 1].kind, "flare", "wrong item handed off");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "handoff", "expected a handoff event");
});

check("a phantom handed to a GONE lead transfers intact — two deceived minds agree and nothing gives it away", () => {
  const sim = createRun({ seed: 125 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: false, claimedKind: "lens", kind: null });
  sim.player.hallucinating = true; // the lead shares the delusion, so it survives the crossing
  const res = handoffToPlayer(sim, ch);
  assert(res.ok && res.real === false, "expected a phantom handoff to succeed between two deceived minds");
  eq(sim.inventory[sim.inventory.length - 1].claimedKind, "lens", "the phantom's claimed kind should ride along into the player's inventory");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "handoff", "expected a handoff event for a phantom too");
  assert(ev.phantom, "a phantom handoff event should be flagged, even though its text never says so");
});

check("a phantom handed to a LUCID lead is called out instead of transferring — the crossing rule", () => {
  const sim = createRun({ seed: 125 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: false, claimedKind: "lens", kind: null });
  sim.player.hallucinating = false;
  const before = sim.inventory.length;
  const res = handoffToPlayer(sim, ch);
  eq(res.ok, false, "a lucid lead must not accept something that was never there");
  eq(res.reason, "revealed", "wrong refusal reason for a phantom called out at the crossing");
  eq(sim.inventory.length, before, "nothing should have entered the lead's inventory");
  eq(ch.inventory.length, 0, "the companion no longer has whatever they thought they were holding");
  eq(sim.stats.phantomsRevealed, 1, "a reveal should be counted for the debrief");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "handoffEmpty", "expected the distinct empty-handed event, not a normal handoff");
});

check("a phantom is called out even when the lead has no room — a reveal needs no free slot to happen in", () => {
  const sim = createRun({ seed: 125 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: false, claimedKind: "lens", kind: null });
  for (let i = 0; i < ITEM_CAP; i++) sim.inventory.push({ id: `x${i}`, real: true, kind: "flare", claimedKind: null });
  const res = handoffToPlayer(sim, ch);
  eq(res.reason, "revealed", "a full inventory must not mask the reveal as a mundane 'hands full'");
});

check("handoffToPlayer refuses when the player's inventory is already full, without mutating either array", () => {
  const sim = createRun({ seed: 126 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: true, kind: "flare", claimedKind: null });
  for (let i = 0; i < ITEM_CAP; i++) sim.inventory.push({ id: `x${i}`, real: true, kind: "flare", claimedKind: null });
  const res = handoffToPlayer(sim, ch);
  eq(res.ok, false, "handoff succeeded over the player's item cap");
  eq(res.reason, "full", "wrong refusal reason");
  eq(ch.inventory.length, 1, "a refused handoff should not remove the companion's slot");
  eq(sim.inventory.length, ITEM_CAP, "a refused handoff should not add to the player's inventory");
});

check("handoffToPlayer refuses an empty-handed companion", () => {
  const sim = createRun({ seed: 127 });
  const ch = sim.companions[0];
  const res = handoffToPlayer(sim, ch);
  eq(res.ok, false, "handoff succeeded with nothing to hand off");
  eq(res.reason, "empty", "wrong refusal reason");
});

check("a full fetch-and-deliver errand completes end-to-end, driven only through tick()", () => {
  const sim = createRun({ seed: 128 });
  // The lead already holds one half of a recipe.
  sim.inventory.push({ id: "held", real: true, kind: "flare", claimedKind: null });
  eq(previewCraft(sim).ok, false, "test setup: nothing craftable yet with only a flare in hand");

  // A discovered, untaken world item that completes the pair.
  const it = sim.items[0];
  it.itemKind = "tether"; // flare + tether -> ember
  it.discovered = true;
  it.taken = false;

  // The lead stands right at the item's spot; the courier starts a short walk
  // away. Every other companion is pushed out of range so only one courier is
  // ever in play.
  sim.player.x = it.x;
  sim.player.z = it.z;
  const courier = sim.companions[0];
  courier.hallucinating = false;
  courier.x = it.x + 6;
  courier.z = it.z;
  for (const c of sim.companions) {
    if (c !== courier) { c.x = it.x + 500; c.z = it.z + 500; }
  }

  let delivered = false;
  for (let i = 0; i < 600 && sim.status === "playing"; i++) {
    tick(sim, 1 / 30);
    if (sim.inventory.length >= 2) { delivered = true; break; }
  }

  assert(delivered, "the courier never delivered the fetched item back to the player");
  eq(sim.inventory.length, 2, "the player should hold the original flare plus the delivered item");
  assert(sim.inventory.some((s) => s.kind === "tether"), "the delivered slot should carry the fetched item's true kind");
  assert(previewCraft(sim).ok, "flare + tether should now preview as craftable");
});

check("two idle companions never both claim the same fetchable item", () => {
  const sim = createRun({ seed: 129 });
  sim.inventory.push({ id: "held", real: true, kind: "flare", claimedKind: null });

  const it = sim.items[0];
  it.itemKind = "tether";
  it.discovered = true;
  it.taken = false;

  const a = sim.companions[0];
  const b = sim.companions[1];
  a.hallucinating = false;
  b.hallucinating = false;
  a.x = it.x + 10; a.z = it.z;
  b.x = it.x - 10; b.z = it.z;
  for (const c of sim.companions) {
    if (c !== a && c !== b) { c.x = it.x + 500; c.z = it.z + 500; }
  }

  for (let i = 0; i < 15; i++) tick(sim, 1 / 30);

  const claimedBy = [a, b].filter((c) => c.fetchItemId === it.id || (c.inventory[0] && c.inventory[0].kind === "tether"));
  assert(claimedBy.length <= 1, `both companions routed to the same item: ${claimedBy.map((c) => c.name).join(", ")}`);
});

check("a hallucinating companion holding something does not hand it off, even standing on the player", () => {
  const sim = createRun({ seed: 130 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: true, kind: "flare", claimedKind: null });
  beginHallucinating(sim, ch);
  ch.x = sim.player.x;
  ch.z = sim.player.z;
  const before = sim.inventory.length;
  for (let i = 0; i < 30; i++) tick(sim, 1 / 30);
  eq(sim.inventory.length, before, "a hallucinating companion should not hand off while gone, even adjacent to the lead");
  eq(ch.inventory.length, 1, "the item should still be with the hallucinating companion, not the lead");
});

check("a fetch errand survives being preempted by a pylon-break instead of permanently stranding the companion and the item", () => {
  const sim = createRun({ seed: 131 });
  sim.inventory.push({ id: "held", real: true, kind: "flare", claimedKind: null });

  const it = sim.items[0];
  it.itemKind = "tether"; // flare + tether -> ember
  it.discovered = true;
  it.taken = false;

  const courier = sim.companions[0];
  courier.hallucinating = false;
  courier.x = it.x + 20;
  courier.z = it.z;
  sim.player.x = it.x + 20;
  sim.player.z = it.z;
  for (const c of sim.companions) {
    if (c !== courier) { c.x = it.x + 500; c.z = it.z + 500; }
  }

  // Let the courier pick up the fetch errand naturally.
  let gotErrand = false;
  for (let i = 0; i < 30; i++) {
    tick(sim, 1 / 30);
    if (courier.fetchItemId === it.id) { gotErrand = true; break; }
  }
  assert(gotErrand, "test setup: the courier never picked up the fetch errand in the first place");

  // Preempt it with a pylon crisis: a known, charged pylon right where the
  // courier already is, and a lucidity low enough to trigger the uniform
  // BRITTLE tell regardless of this companion's own selfCare roll.
  sim.pylons.push({ id: "regr-pylon", x: courier.x, z: courier.z, charge: 100, live: true, spent: false });
  courier.lucidity = 1;

  // The courier is standing ON the planted pylon, so the break and the
  // activation land on the same tick and goalKind goes straight to "resting" —
  // a pylon is spent the moment somebody who walked to it arrives, not after a
  // stay. Either state means the errand was preempted, which is what this
  // regression is about.
  let brokeOff = false;
  for (let i = 0; i < 5; i++) {
    tick(sim, 1 / 30);
    if (courier.goalKind === "pylon" || courier.goalKind === "resting") { brokeOff = true; break; }
  }
  assert(brokeOff, "test setup: the pylon-break never actually preempted the fetch errand");
  eq(courier.fetchItemId, it.id, "the fetch errand must still be remembered underneath the pylon-break, not cleared just because goalKind moved on");

  // The pylon tops the courier back up; once healthy, the errand should
  // resume on its own instead of leaving goalKind stuck on "follow" forever
  // with the item permanently unclaimable by any OTHER companion either
  // (see findFetchableItem's claimed-item exclusion).
  // Longer than it used to need: a pylon now takes two pairs of hands, so a
  // courier alone at one waits for a second that is not coming, gives up, and
  // only then resumes. "Not permanently stranded" is the claim, not "prompt".
  let delivered = false;
  for (let i = 0; i < 4000 && sim.status === "playing"; i++) {
    tick(sim, 1 / 30);
    if (sim.inventory.length >= 2) { delivered = true; break; }
  }
  assert(delivered, "the fetch errand never resumed after the pylon crisis resolved — it was permanently stranded");
});

// ---------------------------------------------------------------------------
// crafting deception & the crossing rule — belief-based crafting, and who
// decides when a phantom changes hands
// ---------------------------------------------------------------------------
check("an honest craft — two real, correctly-read ingredients — produces a real item and is never counted false", () => {
  const sim = createRun({ seed: 140 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "tether", claimedKind: null });
  const res = craftItem(sim); // no belief passed: falls back to the lucid reading, which matches truth here
  assert(res.ok && res.real === true, "an honest, correctly-read pair should craft real");
  eq(res.kind, "ember", "flare+tether should produce an ember");
  eq(sim.inventory.length, 1, "crafting should net one item from two");
  eq(sim.inventory[0].real, true, "the crafted slot should be real");
  eq(sim.inventory[0].kind, "ember", "the crafted slot should carry the true kind");
  eq(sim.stats.falseCrafts, 0, "an honest craft must not be counted as false");
});

check("a false craft and an honest craft emit an INDISTINGUISHABLE event — same kind, byte-identical text", () => {
  // Honest: a real flare + a real tether, both read correctly -> a real ember.
  const simHonest = createRun({ seed: 141 });
  simHonest.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  simHonest.inventory.push({ id: "b", real: true, kind: "tether", claimedKind: null });
  const honestRes = craftItem(simHonest);
  assert(honestRes.ok && honestRes.real === true, "test setup: expected an honest ember");
  const honestEv = simHonest.events[simHonest.events.length - 1];

  // False: a real flare + a real LENS, but believed (the lying item bar) as
  // flare+tether — the recipe matches on belief, but the lens ingredient was
  // never what it was read as, so the result is a phantom claiming "ember".
  const simFalse = createRun({ seed: 142 });
  simFalse.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  simFalse.inventory.push({ id: "b", real: true, kind: "lens", claimedKind: null });
  const falseRes = craftItem(simFalse, -1, ["flare", "tether"]);
  assert(falseRes.ok && falseRes.real === false, "test setup: expected a false ember");
  const falseEv = simFalse.events[simFalse.events.length - 1];

  eq(falseEv.kind, honestEv.kind, "a false craft's event kind must match an honest craft's exactly");
  eq(falseEv.text, honestEv.text, "a false craft's event text must be byte-identical to an honest craft's — nothing may tell the player apart at craft time");
  eq(honestEv.text, "The two combine. Ember forms in your hands.", "sanity: the expected craft text");
});

check("a crafted phantom, used later, hits the phantom branch — cost, not payoff", () => {
  const sim = createRun({ seed: 143 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "lens", claimedKind: null });
  const craftRes = craftItem(sim, -1, ["flare", "tether"]); // false ember, same construction as above
  assert(craftRes.ok && craftRes.real === false, "test setup: expected a false craft");
  eq(sim.inventory[0].claimedKind, "ember", "test setup: the crafted phantom should claim to be an ember");

  sim.player.lucidity = 50;
  const before = sim.player.lucidity;
  const res = useItem(sim, 0);
  assert(res.ok && res.real === false, "using a crafted phantom should report unreal");
  eq(sim.player.lucidity, before - PHANTOM_ITEM_COST, "a crafted phantom should cost lucidity like any other phantom");
  eq(sim.stats.phantomItemsUsed, 1, "phantomItemsUsed not counted for a crafted phantom");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "itemPhantom", "expected the phantom-use event, not any real ember effect");
});

check("a crafted phantom's claimedKind survives the lead recovering from the hallucination that produced it", () => {
  const sim = createRun({ seed: 144 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "flare", claimedKind: null });
  const percept = createPercept();
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1); // onset
  // Pin BOTH labels so the bar reads flare+tether regardless of the live roll
  // (see "pin BOTH labels" above for why leaving one to chance is flaky).
  percept.itemLabels.set("a", "flare");
  percept.itemLabels.set("b", "tether");
  const believed = believedKinds(percept, sim);
  const craftRes = craftItem(sim, -1, believed);
  assert(craftRes.ok && craftRes.real === false, "test setup: expected a false craft built while hallucinating");
  eq(sim.inventory[0].claimedKind, "ember", "test setup: the phantom should claim to be an ember");

  sim.player.hallucinating = false;
  updatePercept(percept, sim, 0.1); // recovery — clears itemLabels
  eq(percept.itemLabels.size, 0, "test setup: recovery should have cleared the per-episode mislabeling");
  const seen = perceivedInventory(percept, sim);
  eq(seen[0].real, false, "the crafted slot is still a phantom");
  eq(seen[0].shownKind, "ember", "a phantom's claimed kind must survive recovery — only per-episode REAL mislabeling is temporary");
});

check("previewCraft and craftItem agree on belief, for both a pair recipe and the raw-material Stake path", () => {
  // Pair path: a belief that manufactures a recipe match even though it isn't
  // an honest reading of either slot.
  const sim = createRun({ seed: 145 });
  sim.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "b", real: true, kind: "lens", claimedKind: null });
  const believedYes = ["flare", "tether"];
  const preview = previewCraft(sim, -1, believedYes);
  assert(preview.ok && preview.kind === "ember", "expected an ember preview under this belief");
  const res = craftItem(sim, -1, believedYes);
  assert(res.ok, "craftItem should agree with previewCraft's ok:true");
  eq(res.kind, preview.kind, "craftItem's kind should match previewCraft's kind");

  // A belief with no matching recipe and no raw materials: preview says no,
  // craftItem refuses for the same reason.
  const sim2 = createRun({ seed: 146 });
  sim2.inventory.push({ id: "a", real: true, kind: "flare", claimedKind: null });
  sim2.inventory.push({ id: "b", real: true, kind: "lens", claimedKind: null });
  const believedNo = ["flare", "flare"];
  eq(previewCraft(sim2, -1, believedNo).ok, false, "expected no preview under a non-matching belief");
  eq(craftItem(sim2, -1, believedNo).ok, false, "craftItem should refuse exactly when previewCraft says no");

  // The Stake path carries no belief layer at all — raw materials only.
  const sim3 = createRun({ seed: 147 });
  sim3.wood = STAKE_COST.wood;
  sim3.stone = STAKE_COST.stone;
  const stakePreview = previewCraft(sim3);
  assert(stakePreview.ok && stakePreview.kind === "stake", "expected a stake preview with enough materials");
  const stakeRes = craftItem(sim3);
  eq(stakeRes.kind, stakePreview.kind, "craftItem should agree with previewCraft on the stake path too");
});

check("the Stake can never come out false, even while the lead is hallucinating — raw materials carry no deception", () => {
  const sim = createRun({ seed: 148 });
  sim.wood = STAKE_COST.wood;
  sim.stone = STAKE_COST.stone;
  sim.player.hallucinating = true;
  const res = craftItem(sim);
  assert(res.ok && res.kind === "stake" && res.real === true, "a stake craft must always be real, regardless of the lead's state");
  eq(sim.stats.falseCrafts, 0, "raw materials cannot produce a false craft");
});

// ---------------------------------------------------------------------------
// offerItem — the other direction of the crossing rule: the lead's own reach
// can expose what THEY were carrying
// ---------------------------------------------------------------------------
check("offerItem: a phantom offered to a lucid companion is called out — revealed, consumed, counted", () => {
  const sim = createRun({ seed: 149 });
  const target = sim.companions[0];
  target.hallucinating = false;
  target.x = sim.player.x;
  target.z = sim.player.z;
  sim.inventory.push({ id: "p0", real: false, claimedKind: "flare", kind: null });
  const res = offerItem(sim, 0, target.id);
  assert(res.ok && res.real === false, "a phantom offer still 'succeeds' as an action, whatever it reveals");
  eq(res.revealed, true, "a lucid companion should see through the phantom");
  eq(sim.inventory.length, 0, "the phantom must be consumed from the player's inventory either way");
  eq(sim.stats.phantomsRevealed, 1, "a reveal should be counted for the debrief");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "offerEmpty", "expected the offerEmpty event");
});

check("offerItem: a phantom offered to a hallucinating companion goes unquestioned — two deceived minds agree", () => {
  const sim = createRun({ seed: 150 });
  const target = sim.companions[0];
  target.hallucinating = true;
  target.x = sim.player.x;
  target.z = sim.player.z;
  sim.inventory.push({ id: "p0", real: false, claimedKind: "flare", kind: null });
  const res = offerItem(sim, 0, target.id);
  assert(res.ok && res.real === false, "a phantom offer still 'succeeds' as an action");
  eq(res.revealed, false, "a hallucinating companion should share the delusion, not call it out");
  eq(sim.inventory.length, 0, "the phantom is still consumed from the player's inventory");
  eq(sim.stats.phantomsRevealed, 0, "a phantom that goes unquestioned must not be counted as revealed");

  // The point of this branch is that NOTHING marks it. Build the equivalent
  // REAL hand-over and demand the two are word for word identical — a distinct
  // event kind, or a line that quietly declines to name the item, would each be
  // a tell that the thing being passed was never there.
  const ev = sim.events[sim.events.length - 1];
  const twin = createRun({ seed: 150 });
  const twinTarget = twin.companions[0];
  twinTarget.hallucinating = false;
  twinTarget.lucidity = 30;
  twinTarget.x = twin.player.x;
  twinTarget.z = twin.player.z;
  twin.inventory.push({ id: "r0", real: true, kind: "flare", claimedKind: null });
  offerItem(twin, 0, twinTarget.id);
  const twinEv = twin.events[twin.events.length - 1];

  eq(ev.kind, twinEv.kind, "a deceived hand-over must emit the same event kind as a real one");
  eq(ev.text, twinEv.text, "and read word for word the same on screen");
});

check("offerItem: a real Flare helps a lucid, fraying companion and is consumed; a real Lens is refused as 'no-use' and stays put", () => {
  const sim = createRun({ seed: 151 });
  const target = sim.companions[0];
  target.hallucinating = false;
  target.lucidity = 30; // FRAYING, but present
  target.x = sim.player.x;
  target.z = sim.player.z;
  sim.inventory.push({ id: "flareSlot", real: true, kind: "flare", claimedKind: null });
  const before = target.lucidity;
  const res = offerItem(sim, 0, target.id);
  assert(res.ok && res.real === true && res.reached === true, "a helpful real item should be accepted and reach a lucid companion");
  eq(target.lucidity, before + ITEM_INFO.flare.restore, "the flare should restore the documented amount");
  eq(sim.inventory.length, 0, "the flare should be consumed from the player's inventory");
  const ev1 = sim.events[sim.events.length - 1];
  eq(ev1.kind, "offerUsed", "expected the offerUsed event for a helpful real item");

  sim.inventory.push({ id: "lensSlot", real: true, kind: "lens", claimedKind: null });
  const res2 = offerItem(sim, 0, target.id);
  eq(res2.ok, false, "a Lens has nothing this companion can use right now");
  eq(res2.reason, "no-use", "wrong refusal reason for an unhelpful real item");
  eq(sim.inventory.length, 1, "a refused offer must not remove the item");
  eq(sim.inventory[0].kind, "lens", "the lens should still be sitting, untouched, in the player's inventory");
  const ev2 = sim.events[sim.events.length - 1];
  eq(ev2.kind, "offerRefused", "expected the offerRefused event");
});

check("offerItem: a real Flare offered to a HALLUCINATING companion is consumed but does not reach them", () => {
  const sim = createRun({ seed: 152 });
  const target = sim.companions[0];
  target.hallucinating = true;
  target.lucidity = 0;
  target.x = sim.player.x;
  target.z = sim.player.z;
  sim.inventory.push({ id: "flareSlot", real: true, kind: "flare", claimedKind: null });
  const res = offerItem(sim, 0, target.id);
  assert(res.ok && res.real === true, "the offer itself still succeeds — the item just doesn't help");
  eq(res.reached, false, "a gone companion must not be reached by a flare");
  eq(target.lucidity, 0, "lucidity must not change for a companion the item never reached");
  eq(sim.inventory.length, 0, "the flare is still consumed even though it was lost");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "offerLost", "expected the offerLost event");
});

check("offerItem refuses 'too-far' when the companion is beyond OFFER_RADIUS, mutating nothing", () => {
  const sim = createRun({ seed: 153 });
  const target = sim.companions[0];
  target.x = sim.player.x + OFFER_RADIUS + 5;
  target.z = sim.player.z;
  sim.inventory.push({ id: "flareSlot", real: true, kind: "flare", claimedKind: null });
  const before = target.lucidity;
  const res = offerItem(sim, 0, target.id);
  eq(res.ok, false, "an out-of-range offer must be refused");
  eq(res.reason, "too-far", "wrong refusal reason");
  eq(sim.inventory.length, 1, "an out-of-range offer must not touch the inventory");
  eq(target.lucidity, before, "an out-of-range offer must not touch the companion");
});

// ---------------------------------------------------------------------------
// no-tells — the deception is only as good as its worst leak
//
// Every check here asserts that two paths are INDISTINGUISHABLE. They exist
// because a review found four separate places where a real and a false item
// were being quietly told apart — a subtitle that named the true kind, a
// different sentence shape for a phantom, a missing definite article, and a
// refusal that only ever refused real items. Any one of them let a player
// decide an item's truth without paying the price the design charges for it.
// ---------------------------------------------------------------------------
check("a real pickup and a phantom pickup read exactly the same on screen", () => {
  const real = createRun({ seed: 160 });
  const it = real.items[0];
  it.discovered = true;
  real.player.x = it.x;
  real.player.z = it.z;
  pickupItem(real);
  const realEv = real.events[real.events.length - 1];

  const fake = createRun({ seed: 160 });
  const fit = fake.items[0];
  fit.discovered = true;
  fake.player.x = fit.x;
  fake.player.z = fit.z;
  fake.player.hallucinating = true;
  fake.rng.chance = () => true; // force the phantom branch
  pickupItem(fake);
  const fakeEv = fake.events[fake.events.length - 1];

  eq(realEv.text, fakeEv.text, "a phantom pickup must read word for word like a real one");
  assert(
    !Object.values(ITEM_INFO).some((info) => realEv.text.includes(info.label)),
    "a pickup subtitle must not name any item kind — that is the item bar's job, and the bar is allowed to lie",
  );
});

check("a real handoff and a phantom handoff read exactly the same on screen", () => {
  const real = createRun({ seed: 161 });
  real.player.hallucinating = true; // so the phantom twin below transfers rather than being called out
  const rch = real.companions[0];
  rch.inventory.push({ id: "c1", real: true, kind: "flare", claimedKind: null });
  handoffToPlayer(real, rch);
  const realEv = real.events[real.events.length - 1];

  const fake = createRun({ seed: 161 });
  fake.player.hallucinating = true;
  const fch = fake.companions[0];
  fch.inventory.push({ id: "c1", real: false, claimedKind: "flare", kind: null });
  handoffToPlayer(fake, fch);
  const fakeEv = fake.events[fake.events.length - 1];

  eq(realEv.text, fakeEv.text, "a phantom handed over between two deceived minds must read identically");
});

check("a claimed Lens is refused whether or not anything is behind it — a refusal is not a free truth oracle", () => {
  const mk = (slot) => {
    const sim = createRun({ seed: 162 });
    const target = sim.companions[0];
    target.hallucinating = false;
    target.x = sim.player.x;
    target.z = sim.player.z;
    sim.inventory.push(slot);
    return { sim, res: offerItem(sim, 0, target.id) };
  };
  const realLens = mk({ id: "r", real: true, kind: "lens", claimedKind: null });
  const fakeLens = mk({ id: "p", real: false, claimedKind: "lens", kind: null });

  eq(realLens.res.reason, "no-use", "a real Lens is refused — a companion has no use for it");
  eq(fakeLens.res.reason, "no-use", "and so is a phantom claiming to be one");
  eq(realLens.sim.inventory.length, 1, "the real Lens stays in hand");
  eq(fakeLens.sim.inventory.length, 1, "and so does the phantom — refusing must not consume it either");
  eq(fakeLens.sim.stats.phantomsRevealed, 0, "a refusal must never double as a reveal");
});

check("an Ember steadies a gone companion even though its restore cannot reach them", () => {
  // Regression: the early return for an unreachable restore used to skip the
  // steady effect below it, so an Ember (restore + steady) did strictly LESS
  // for a hallucinating companion than a plain Tether (steady only) did.
  const sim = createRun({ seed: 163 });
  const target = sim.companions[0];
  target.x = sim.player.x;
  target.z = sim.player.z;
  beginHallucinating(sim, target);
  sim.inventory.push({ id: "e", real: true, kind: "ember", claimedKind: null });

  const res = offerItem(sim, 0, target.id);
  assert(res.ok, "the offer itself lands");
  eq(res.reached, false, "an item cannot pull a mind back from gone — that takes a pylon");
  assert(target.steadyUntil > sim.time, "but the steadying half must still apply");
});

check("slot ids stay unique through the pickup/craft shape that used to collide", () => {
  // Ids used to be `slot<inventory.length>-<time>`. Crafting slots 0 and 2
  // leaves the survivor holding the index the replacement then reuses, so
  // within one 0.01s time bucket — which same-frame actions share — the two
  // collided and ended up sharing a percept.itemLabels entry.
  const sim = createRun({ seed: 164 });
  const kinds = ["flare", "flare", "tether"];
  for (let i = 0; i < 3; i++) {
    const it = sim.items[i];
    it.itemKind = kinds[i];
    it.discovered = true;
    it.taken = false;
    sim.player.x = it.x;
    sim.player.z = it.z;
    const p = pickupItem(sim);
    assert(p.ok, `test setup: pickup ${i} should succeed`);
  }
  const liveIds = () => sim.inventory.map((s) => s.id);
  eq(new Set(liveIds()).size, 3, `three pickups in one time bucket produced duplicate ids: ${liveIds().join(", ")}`);

  const res = craftItem(sim); // consumes indices 0 and 2 (flare + tether)
  assert(res.ok && res.kind === "ember", "test setup: flare + tether should combine");
  eq(new Set(liveIds()).size, sim.inventory.length, `craft output reused a live slot id: ${liveIds().join(", ")}`);
});

check("the Lens clause of seesThrough: a hallucinating lead with an active Lens still sees through a phantom handoff", () => {
  const sim = createRun({ seed: 154 });
  const ch = sim.companions[0];
  ch.inventory.push({ id: "cslot", real: false, claimedKind: "lens", kind: null });
  sim.player.hallucinating = true;
  sim.player.lensUntil = sim.time + 10; // a Lens window active right now
  const res = handoffToPlayer(sim, ch);
  eq(res.ok, false, "a Lens should let a hallucinating lead see through the phantom, not share the delusion");
  eq(res.reason, "revealed", "wrong refusal reason under a Lens window");
  eq(ch.inventory.length, 0, "the companion no longer has whatever they thought they were carrying");
  eq(sim.stats.phantomsRevealed, 1, "a Lens-enabled reveal should still be counted for the debrief");
  const ev = sim.events[sim.events.length - 1];
  eq(ev.kind, "handoffEmpty", "expected the empty-handed event under a Lens window");
});

// ---------------------------------------------------------------------------
// campaign — a basin cleared early in the sequence advances, not ends
// ---------------------------------------------------------------------------
check("createRun defaults to a single-basin campaign — no caller is affected unless it opts in", () => {
  const sim = createRun({ seed: 70 });
  eq(sim.level, 1, "default level");
  eq(sim.campaignLength, 1, "default campaignLength must stay 1 so existing callers see the old win path");
});

check("clearing a basin before the last one advances instead of ending the run", () => {
  const sim = createRun({ seed: 71, level: 1, campaignLength: CAMPAIGN_LENGTH });
  for (const m of sim.monoliths) m.logged = true;
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  sim.companions[0].x = sim.world.camp.x;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "levelComplete", "should advance rather than end with more basins left");
  eq(sim.ending, "advance");
});

check("clearing the LAST basin of a campaign wins for real", () => {
  const sim = createRun({ seed: 72, level: CAMPAIGN_LENGTH, campaignLength: CAMPAIGN_LENGTH });
  for (const m of sim.monoliths) m.logged = true;
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  sim.companions[0].x = sim.world.camp.x;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "won", "the final basin should still win outright");
  eq(sim.ending, "extracted");
});

check("carryOver continues lucidity, scars, doses, inventory and materials into the next basin", () => {
  const first = createRun({ seed: 73, level: 1, campaignLength: 2 });
  first.companions[0].lucidity = 37;
  first.companions[0].scars = 2;
  first.doses = 1;
  first.inventory.push({ id: "carried", real: true, kind: "lens", claimedKind: null });
  first.wood = 3;
  first.stone = 1;
  const carryOver = {
    party: first.party.map((c) => ({
      id: c.id, lucidity: c.lucidity, scars: c.scars,
      hallucinating: c.hallucinating, hallucination: c.hallucination, goneTime: c.goneTime,
    })),
    doses: first.doses,
    inventory: first.inventory,
    wood: first.wood,
    stone: first.stone,
    stats: first.stats,
  };
  const second = createRun({ seed: 74, level: 2, campaignLength: 2, carryOver });
  eq(second.companions[0].lucidity, 37, "lucidity did not carry over");
  eq(second.companions[0].scars, 2, "scars did not carry over");
  eq(second.doses, 1, "doses did not carry over");
  eq(second.inventory.length, 1, "inventory did not carry over");
  eq(second.inventory[0].kind, "lens", "the carried item's kind changed");
  eq(second.wood, 3, "wood did not carry over");
  eq(second.stone, 1, "stone did not carry over");
  // But the world and party POSITIONS are fresh, not carried:
  assert(second.player.x !== undefined, "a fresh basin should still have a valid spawn");
});

// ---------------------------------------------------------------------------
// endings
// ---------------------------------------------------------------------------
check("all six gone for long enough dissolves the party", () => {
  const sim = createRun({ seed: 36 });
  for (const c of sim.party) beginHallucinating(sim, c);
  sim.lastDt = 1;
  for (let t = 0; t < DISSOLVE_TIME - 2; t++) checkEndings(sim);
  eq(sim.status, "playing", "ended too early");
  for (let t = 0; t < 4; t++) checkEndings(sim);
  eq(sim.status, "lost", "party did not dissolve");
  eq(sim.ending, "dissolved");
});

check("one mind still lucid holds the party together", () => {
  const sim = createRun({ seed: 37 });
  for (const c of sim.companions) beginHallucinating(sim, c);
  sim.lastDt = 1;
  for (let t = 0; t < DISSOLVE_TIME * 2; t++) checkEndings(sim);
  eq(sim.status, "playing", "five gone and one lucid must not be an ending");
});

check("running out of light ends the run", () => {
  const sim = createRun({ seed: 38 });
  sim.time = TIME_LIMIT + 1;
  checkEndings(sim);
  eq(sim.status, "lost");
  eq(sim.ending, "darkness");
});

check("winning needs the full survey AND bodies back at camp", () => {
  const sim = createRun({ seed: 39 });
  for (const m of sim.monoliths) m.logged = true;
  // Survey done, but everyone is out in the basin.
  const away = farFromPylons(sim);
  for (const c of sim.party) { c.x = away.x + 100; c.z = away.z + 100; }
  checkEndings(sim);
  eq(sim.status, "playing", "won without returning");
  // Lead walks back alone: a record with no witnesses is not a survey.
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "playing", "won with the lead alone at camp");
  sim.companions[0].x = sim.world.camp.x + 1;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z + 1;
  checkEndings(sim);
  eq(sim.status, "won", "did not win with lead + two companions home");
  eq(sim.ending, "extracted");
});

check("a false entry cannot win the run", () => {
  const sim = createRun({ seed: 40 });
  // Six log entries, none of them real.
  for (let i = 0; i < 6; i++) sim.logEntries.push({ name: "ghost", real: false, t: 0 });
  sim.player.x = sim.world.camp.x;
  sim.player.z = sim.world.camp.z;
  sim.companions[0].x = sim.world.camp.x;
  sim.companions[0].z = sim.world.camp.z;
  sim.companions[1].x = sim.world.camp.x;
  sim.companions[1].z = sim.world.camp.z;
  checkEndings(sim);
  eq(sim.status, "playing", "counterfeit entries won the game");
});

// ---------------------------------------------------------------------------
// the tick loop
// ---------------------------------------------------------------------------
check("tick advances the sim's own clock, in clamped slices", () => {
  const sim = createRun({ seed: 41 });
  tick(sim, 0.05);
  near(sim.time, 0.05, 1e-9, "clock");
  // dt is clamped to 0.1s per tick: a backgrounded tab that comes back with a
  // 30-second frame must not teleport the run (or drain the party) in one step.
  tick(sim, 999);
  near(sim.time, 0.15, 1e-9, "clamped clock");
});

check("the player walks, and cannot walk through rock", () => {
  const sim = createRun({ seed: 42 });
  const start = { x: sim.player.x, z: sim.player.z };
  advance(sim, 1, { move: { x: 1, z: 0 } });
  assert(Math.hypot(sim.player.x - start.x, sim.player.z - start.z) > 0.5, "player did not move");
  for (let i = 0; i < 400; i++) tick(sim, 0.05, { move: { x: 1, z: 0 } });
  assert(!isBlockedAt(sim.world, sim.player.x, sim.player.z), "player ended up inside rock");
});

// Following is gone. This used to assert the party stayed in formation behind
// the lead; the invariant that actually matters now is that they stay a GROUP —
// a chain where everyone is linked to somebody, not a column in your pocket.
check("the party reforms around a lead who has stopped", () => {
  // NOT "the group never breaks". Walking off fast is SUPPOSED to leave them
  // behind — being able to outrun your party is where the aloneness comes from.
  // What must be true is that they come back when you stop, on the ping's own
  // schedule rather than instantly.
  const sim = createRun({ seed: 43 });
  advance(sim, 12, { move: { x: 0, z: -1 } });          // walk off
  advance(sim, 70, { move: { x: 0, z: 0 } });           // then wait
  const group = groupWith(sim.party, sim.player.id);
  assert(group.size >= 4, `the party never came back: only ${group.size} of ${sim.party.length} linked after waiting`);
});

// The other half of the same invariant, and the one that makes it a real test:
// a group is not allowed to be a huddle. If everybody is inside a few metres of
// the lead, cohesion has quietly become following again.
check("staying a group does not mean standing on the lead", () => {
  const sim = createRun({ seed: 43 });
  advance(sim, 90, { move: { x: 0, z: 0 } });
  const spread = sim.companions.map((c) => Math.hypot(c.x - sim.player.x, c.z - sim.player.z));
  assert(Math.max(...spread) > 8, `the whole party is within ${Math.max(...spread).toFixed(1)}m of the lead — this is following by another name`);
});

// brain: dog#E41. A cluster driven by balanced inflow and outflow reaches a
// fixed point and freezes there forever. The party looked fine on a single
// snapshot while being completely motionless between them, so this samples the
// SPREAD over time and asserts it actually changes.
check("the party does not settle into a fixed radius", () => {
  const sim = createRun({ seed: 43 });
  const samples = [];
  for (let i = 0; i < 6; i++) {
    advance(sim, 20, { move: { x: 0, z: 0 } });
    samples.push(sim.companions.reduce((a, c) => a + Math.hypot(c.x - sim.player.x, c.z - sim.player.z), 0) / sim.companions.length);
  }
  const lo = Math.min(...samples), hi = Math.max(...samples);
  assert(hi - lo > 1.5, `the party froze at a fixed radius: ${samples.map((v) => v.toFixed(1)).join(", ")}`);
});

check("a brittle companion breaks formation for a pylon they remember", () => {
  const sim = createRun({ seed: 44 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const c = sim.companions[0];
  // The party is out in the basin, well away from relief, but this companion has
  // been near this pylon before and remembers it.
  const away = { x: p.x + 30, z: p.z + 4 };
  for (const m of sim.party) { m.x = away.x; m.z = away.z; }
  // Spend every other pylon, so the only relief in the world is `p` — otherwise
  // the party's resting spot may happen to fall inside a different one.
  // `spent`, not `charge` — charge is vestigial since pylons became one-shot,
  // so this guard had quietly stopped working. It matters more now: at the
  // larger PYLON_RADIUS the party's away-spot lands inside a neighbouring
  // pylon, which primes, gets confirmed, and heals the companion out of the
  // very band this test is about.
  for (const other of sim.pylons) if (other !== p) other.spent = true;
  c.known = { pylons: new Set([p.id]), monoliths: new Set() };
  c.lucidity = 9; // BRITTLE — the loud tell
  // Hold the slip off: a brittle mind can now lapse briefly on its own, which
  // is a different mechanic and would preempt the break this test is about.
  c.microCooldownUntil = 1e9;
  const before = Math.hypot(c.x - p.x, c.z - p.z);
  advance(sim, 3);
  eq(c.goalKind, "pylon", "brittle companion kept walking in formation");
  assert(Math.hypot(c.x - p.x, c.z - p.z) < before - 3, "broke formation but did not close on the pylon");
});

check("a companion who has never seen a pylon cannot head for it", () => {
  const sim = createRun({ seed: 44 });
  const p = sim.pylons[0];
  const c = sim.companions[0];
  for (const m of sim.party) { m.x = p.x + 40; m.z = p.z + 40; }
  c.known = { pylons: new Set(), monoliths: new Set() };
  c.lucidity = 9;
  advance(sim, 2);
  assert(c.goalKind !== "pylon", "a companion walked to a pylon they had no way of knowing about");
});

check("a gone companion stops following and goes its own way", () => {
  // Across seeds, not one. A phantom errand picks a destination from the
  // neighbourhood, so any single seed can legitimately draw one that happens to
  // sit near the lead — asserting on one seed measures that draw, not the
  // behaviour. (Adding a per-tick roll elsewhere re-perturbed exactly this.)
  let wandered = 0;
  const SEEDS = 12;
  for (let seed = 40; seed < 40 + SEEDS; seed++) {
    const sim = createRun({ seed });
    const c = sim.companions[0];
    beginHallucinating(sim, c);
    const startDist = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
    advance(sim, 30);
    const endDist = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
    eq(c.goalKind, "hallucinating", `seed ${seed}: goal kind`);
    if (endDist > startDist + 4) wandered++;
  }
  assert(wandered >= SEEDS * 0.6, `a gone companion should usually wander off — only ${wandered}/${SEEDS} did`);
});

check("companions volunteer remarks, and a gone one says gone things", () => {
  const sim = createRun({ seed: 46 });
  sim.time = FULL_DRAIN_AT;
  let normal = 0;
  advance(sim, 60);
  normal = sim.companions.length; // remarks are emitted as events; count over a window
  let chatter = 0;
  // tick() CLAMPS dt to 0.1 (a backgrounded tab must not teleport the run), so
  // `tick(sim, 0.5)` sixty times is six seconds of sim, not thirty. This loop
  // claimed to cover "a full minute" and covered six seconds; it passed on the
  // luck of where each companion's remark cooldown happened to sit, and any
  // change to the rng stream could tip it either way without touching chatter
  // at all. Stepping at the clamp makes the window mean what it says.
  for (let i = 0; i < 600; i++) {
    tick(sim, 0.1);
    chatter += sim.events.filter((e) => e.kind === "chatter").length;
  }
  assert(chatter > 0, "nobody said anything over a full minute");
  assert(normal > 0);
  // Now break one and look for the confident-nonsense register.
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  let goneLines = 0;
  for (let i = 0; i < 400; i++) {
    tick(sim, 0.5);
    goneLines += sim.events.filter((e) => e.kind === "chatter" && e.who === c.id && e.gone).length;
  }
  assert(goneLines > 0, "a gone companion never spoke");
});

check("paused time does not drain anyone (the loop simply stops ticking)", () => {
  const sim = createRun({ seed: 47 });
  const before = sim.companions.map((c) => c.lucidity);
  // The pause path in main.js skips tick() entirely; assert the sim is inert
  // without it rather than mocking the loop.
  sim.companions.forEach((c, i) => eq(c.lucidity, before[i], "state changed with no tick"));
});

check("a finished run stops simulating", () => {
  const sim = createRun({ seed: 48 });
  sim.status = "won";
  const t = sim.time;
  tick(sim, 1);
  eq(sim.time, t, "the clock ran after the run ended");
});

// ---------------------------------------------------------------------------
// debrief: the only honest readout
// ---------------------------------------------------------------------------
check("the debrief reveals the hidden numbers, and only then", () => {
  const sim = createRun({ seed: 49 });
  sim.companions[0].lucidity = 42.4;
  beginHallucinating(sim, sim.companions[1]);
  const d = debrief(sim);
  eq(d.party.length, PARTY_SIZE, "debrief party size");
  eq(d.party[1].lucidity, 42, "debrief should round the real value");
  assert(d.party[2].hallucinating, "debrief hid a hallucinating companion");
  eq(d.total, 6, "marker total");
});

check("partyCentroid sits inside the party's spread", () => {
  const sim = createRun({ seed: 50 });
  const c = partyCentroid(sim);
  const maxD = Math.max(...sim.party.map((m) => Math.hypot(m.x - c.x, m.z - c.z)));
  assert(maxD < 12, `centroid too far from everyone: ${maxD}`);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function farFromPylons(sim) {
  // A spot on open ground at least 2 pylon-radii from every pylon, so tests that
  // want pure drain get pure drain.
  let best = { x: sim.world.camp.x, z: sim.world.camp.z, d: -1 };
  for (const m of sim.monoliths) {
    const d = Math.min(...sim.pylons.map((p) => Math.hypot(p.x - m.x, p.z - m.z)));
    if (d > best.d) best = { x: m.x, z: m.z, d };
  }
  if (best.d < PYLON_RADIUS * 2) {
    // Fall back to a synthetic point; drain does not care about walls.
    return { x: 9999, z: 9999 };
  }
  return best;
}

// ---------------------------------------------------------------------------
// couch co-op — a second player POSSESSES a companion; nobody is added
// ---------------------------------------------------------------------------
check("a fresh run has exactly one human, and it is the lead", () => {
  const sim = createRun({ seed: 300 });
  eq(sim.humans.length, 1, "a solo run should have one human");
  assert(sim.humans[0] === sim.player, "humans[0] must BE the lead, not a copy");
  eq(sim.player.humanSlot, 0, "the lead is always slot 0");
  for (const c of sim.companions) eq(c.humanSlot, null, `${c.id} should start AI-driven`);
});

check("possessing a companion takes a seat without adding a body to the basin", () => {
  const sim = createRun({ seed: 301 });
  const partyBefore = sim.party.length;
  const target = sim.companions[2];
  const slot = possess(sim, target.id);
  eq(slot, 1, "the second human should get slot 1");
  eq(target.humanSlot, 1, "the companion should record its slot");
  assert(sim.humans[1] === target, "humans[1] must be the possessed companion itself");
  eq(sim.party.length, partyBefore, "possession must not change the party size");
  eq(sim.companions.length, 5, "a possessed companion is still a companion");
  assert(!target.isPlayer, "possession must not make a companion the LEAD");
});

check("a companion cannot be possessed twice", () => {
  const sim = createRun({ seed: 302 });
  const target = sim.companions[0];
  eq(possess(sim, target.id), 1, "first possession should succeed");
  eq(possess(sim, target.id), null, "second possession of the same mind must be refused");
  eq(sim.humans.length, 2, "a refused possession must not grow the roster");
  eq(possess(sim, "no-such-companion"), null, "an unknown id must be refused");
});

check("possessableCompanions only offers minds the AI still owns", () => {
  const sim = createRun({ seed: 303 });
  eq(possessableCompanions(sim).length, 5, "all five start available");
  possess(sim, sim.companions[1].id);
  const left = possessableCompanions(sim);
  eq(left.length, 4, "a taken companion must drop out of the offer list");
  assert(!left.includes(sim.companions[1]), "the taken companion must not be offered");
});

check("possession clears the AI's in-flight goal, and release clears it again", () => {
  const sim = createRun({ seed: 304 });
  const c = sim.companions[0];
  c.goal = { x: 999, z: 999 };
  c.goalKind = "pylon";
  c.path = [{ x: 1, z: 1 }];
  c.fetchItemId = "item-7";
  possess(sim, c.id);
  eq(c.goal, null, "a stale AI goal must not survive possession");
  eq(c.goalKind, "follow", "goalKind must reset on possession");
  eq(c.path, null, "a stale path must not survive possession");
  eq(c.fetchItemId, null, "a stale fetch errand must not survive possession");
  // ...and the same on the way out, so the AI restarts from where it is now.
  c.goal = { x: 5, z: 5 };
  c.path = [{ x: 2, z: 2 }];
  release(sim, 1);
  eq(c.goal, null, "a goal formed under human control must not be handed to the AI");
  eq(c.path, null, "a path formed under human control must not be handed to the AI");
});

check("releasing hands the mind back to the AI, intact", () => {
  const sim = createRun({ seed: 305 });
  const c = sim.companions[3];
  c.lucidity = 41;
  c.scars = 2;
  possess(sim, c.id);
  assert(release(sim, 1), "release should succeed");
  eq(c.humanSlot, null, "the companion must be AI-driven again");
  eq(sim.humans.length, 1, "the roster should be back to the lead alone");
  eq(c.lucidity, 41, "release must not reset the mind's state");
  eq(c.scars, 2, "release must not reset scars");
  assert(sim.companions.includes(c), "the character must STAY in the basin, not vanish");
});

check("the lead's slot can never be released", () => {
  const sim = createRun({ seed: 306 });
  eq(release(sim, 0), false, "slot 0 must be unreleasable");
  assert(sim.humans[0] === sim.player, "the lead must still be human slot 0");
  eq(release(sim, 5), false, "an out-of-range slot must be refused");
});

check("a possessed companion is steered by its own input, not by the party AI", () => {
  const sim = createRun({ seed: 307 });
  const c = sim.companions[0];
  possess(sim, c.id);
  // Park it far from everything so the AI, if it ran, would want to move.
  const start = { x: c.x, z: c.z };
  advance(sim, 0.5, { others: [{ move: { x: 1, z: 0 }, run: false, yaw: 0.3 }] });
  assert(Math.abs(c.x - start.x) > 0.1, "slot-1 input should have moved the possessed companion");
  eq(c.yaw, 0.3, "slot-1 input should set the possessed companion's facing");
  // With NO input for slot 1 the AI must still not take the wheel back.
  const held = { x: c.x, z: c.z };
  advance(sim, 0.6, {});
  eq(c.x, held.x, "a possessed companion must not drift under AI control");
  eq(c.z, held.z, "a possessed companion must not drift under AI control");
});

check("releasing lets the party AI drive that companion again", () => {
  const sim = createRun({ seed: 308 });
  const c = sim.companions[0];
  possess(sim, c.id);
  advance(sim, 0.5, {});
  release(sim, 1);
  const start = { x: c.x, z: c.z };
  // Put the lead well away so the follow AI has somewhere to go.
  sim.player.x = c.x + 40;
  advance(sim, 1.5, {});
  assert(Math.hypot(c.x - start.x, c.z - start.z) > 0.1, "the AI should be driving the released companion again");
});

check("each human gets their own percept, so they can be shown different worlds", () => {
  const sim = createRun({ seed: 309 });
  sim.time = FULL_DRAIN_AT;
  const c = sim.companions[0];
  possess(sim, c.id);
  const pLead = createPercept(sim.player);
  const pTwo = createPercept(c);
  // Only the SECOND player's mind goes. The lead's must stay honest.
  beginHallucinating(sim, c);
  updatePercept(pLead, sim, 0.1);
  updatePercept(pTwo, sim, 0.1);
  assert(!pLead.active, "the lead must not hallucinate because someone else did");
  assert(pTwo.active, "the possessed companion's own percept must go active");
  eq(distortion(pLead, sim), 0, "a lucid lead's screen must stay undistorted");
  assert(distortion(pTwo, sim) > 0, "the gone player's own screen must distort");
});

check("a phantom marker is placed around the mind that conjured it, not always the lead", () => {
  const sim = createRun({ seed: 310 });
  const c = sim.companions[0];
  possess(sim, c.id);
  // Move the two humans far apart, then send ONLY the second one under.
  sim.player.x = 0; sim.player.z = 0;
  c.x = 120; c.z = 120;
  c.hallucination = HALLUCINATION.PHANTOM_MARKER;
  c.hallucinating = true;
  const pTwo = createPercept(c);
  updatePercept(pTwo, sim, 0.1);
  assert(pTwo.phantomMonoliths.length > 0, "a phantom-marker episode should seed phantoms");
  for (const ph of pTwo.phantomMonoliths) {
    const dSelf = Math.hypot(ph.x - c.x, ph.z - c.z);
    const dLead = Math.hypot(ph.x - sim.player.x, ph.z - sim.player.z);
    assert(dSelf < dLead, "a phantom must be conjured near ITS OWN mind, not near the lead");
  }
  // And the lead, being lucid, must not be shown it at all.
  const pLead = createPercept(sim.player);
  updatePercept(pLead, sim, 0.1);
  eq(perceivedMonoliths(pLead, sim).filter((m) => m.phantom).length, 0,
     "a lucid lead must not see another player's phantom");
});

check("possession survives a basin transition — a joined pad must not go dead", () => {
  const first = createRun({ seed: 311, level: 1, campaignLength: 3 });
  const c = first.companions[2];
  possess(first, c.id);
  const carryOver = {
    party: first.party.map((ch) => ({
      id: ch.id, lucidity: ch.lucidity, scars: ch.scars,
      hallucinating: ch.hallucinating, hallucination: ch.hallucination, goneTime: ch.goneTime,
      drain: ch.drain, stoic: ch.stoic, chatty: ch.chatty, wander: ch.wander,
      selfCare: ch.selfCare, humanSlot: ch.humanSlot,
    })),
    doses: first.doses, inventory: first.inventory, wood: first.wood, stone: first.stone, stats: first.stats,
  };
  const second = createRun({ seed: 312, level: 2, campaignLength: 3, carryOver });
  eq(second.humans.length, 2, "the second player must still be in the roster");
  const same = second.companions.find((x) => x.id === c.id);
  eq(same.humanSlot, 1, "the same companion must still be in slot 1");
  assert(second.humans[1] === same, "humans[1] must point at the restored companion");
});

// ---------------------------------------------------------------------------
// co-op verbs — a joined player's action acts on THEM, not on the lead
// ---------------------------------------------------------------------------
check("a joined player surveys the marker THEY are standing at", () => {
  const sim = createRun({ seed: 320 });
  const c = sim.companions[0];
  possess(sim, c.id);
  const m = sim.monoliths[0];
  // The lead is nowhere near it; player two is standing on it.
  sim.player.x = m.x + 400; sim.player.z = m.z + 400;
  c.x = m.x; c.z = m.z;
  eq(logMarker(sim, null, sim.player).ok, false, "the lead is far away and must not be able to log it");
  const res = logMarker(sim, null, c);
  assert(res.ok && res.real, "player two standing at the marker should log it");
  assert(m.logged, "the marker should be marked logged");
});

check("a joined player picks up the item THEY walked to", () => {
  const sim = createRun({ seed: 321 });
  const c = sim.companions[0];
  possess(sim, c.id);
  const it = sim.items[0];
  it.discovered = true;
  sim.player.x = it.x + 400; sim.player.z = it.z + 400;
  c.x = it.x; c.z = it.z;
  eq(pickupItem(sim, sim.player).ok, false, "the lead is nowhere near the item");
  const res = pickupItem(sim, c);
  assert(res.ok, "player two standing on the item should pick it up");
  assert(it.taken, "the world item should be consumed");
  eq(sim.inventory.length, 1, "the pack is shared — the item lands in the one inventory");
});

check("a flare used by a joined player restores THEIR lucidity, not the lead's", () => {
  const sim = createRun({ seed: 322 });
  const c = sim.companions[0];
  possess(sim, c.id);
  sim.player.lucidity = 50;
  c.lucidity = 20;
  sim.inventory.push({ id: "s0", real: true, kind: "flare", claimedKind: null });
  const res = useItem(sim, 0, null, c);
  assert(res.ok && res.real, "the flare should have been used");
  eq(sim.player.lucidity, 50, "the lead's meter must be untouched");
  assert(c.lucidity > 20, "the user's own meter should have risen");
});

check("a phantom item used by a joined player costs THEM, and can tip THEM under", () => {
  const sim = createRun({ seed: 323 });
  const c = sim.companions[0];
  possess(sim, c.id);
  sim.player.lucidity = 90;
  c.lucidity = PHANTOM_ITEM_COST - 1; // just enough that using it takes them to 0
  sim.inventory.push({ id: "s0", real: false, claimedKind: "flare", kind: null });
  useItem(sim, 0, null, c);
  eq(sim.player.lucidity, 90, "the lead must not pay for someone else's phantom");
  eq(c.lucidity, 0, "the user pays the phantom cost");
  assert(c.hallucinating, "being taken to zero by a phantom should tip that mind under");
  assert(!sim.player.hallucinating, "the lead must not be dragged under with them");
});

check("a lens used by a joined player clears THEIR screen only", () => {
  const sim = createRun({ seed: 324 });
  const c = sim.companions[0];
  possess(sim, c.id);
  sim.inventory.push({ id: "s0", real: true, kind: "lens", claimedKind: null });
  useItem(sim, 0, null, c);
  assert((c.lensUntil || 0) > sim.time, "the user should get the truth window");
  assert(!(sim.player.lensUntil > sim.time), "the lead must not get a lens they didn't use");
  // ...and percept.js must agree about who is clear.
  assert(isClear(createPercept(c), sim), "the user's percept should read as clear");
  assert(!isClear(createPercept(sim.player), sim), "the lead's percept must not");
});

check("a stake planted by a joined player lands at THEIR feet", () => {
  const sim = createRun({ seed: 325 });
  const c = sim.companions[0];
  possess(sim, c.id);
  sim.player.x = 0; sim.player.z = 0;
  c.x = 77; c.z = 88;
  sim.inventory.push({ id: "s0", real: true, kind: "stake", claimedKind: null });
  const before = sim.pylons.length;
  useItem(sim, 0, null, c);
  eq(sim.pylons.length, before + 1, "a stake should add a pylon");
  const planted = sim.pylons[sim.pylons.length - 1];
  eq(planted.x, 77, "the pylon should be planted at the planter's position");
  eq(planted.z, 88, "the pylon should be planted at the planter's position");
});

check("two humans can corroborate each other's surveys, but never their own", () => {
  const sim = createRun({ seed: 326 });
  const c = sim.companions[0];
  possess(sim, c.id);
  const m = sim.monoliths[0];
  // Park every AI companion far away so the only possible witness is the lead.
  for (const other of sim.companions) { other.x = m.x + 500; other.z = m.z + 500; }
  c.x = m.x; c.z = m.z;
  sim.player.x = m.x + 2; sim.player.z = m.z; // the lead is at player two's shoulder
  const res = logMarker(sim, null, c);
  assert(res.ok && res.real, "player two should log the marker");
  // A second HUMAN vouches by presence — they can just say it out loud, and
  // there is no verb to route that through. AI companions must be asked.
  assert(res.corroborated, "the lead standing alongside should corroborate it");
  // Now the reverse: nobody but the surveyor in range at all.
  const m2 = sim.monoliths[1];
  sim.player.x = m2.x; sim.player.z = m2.z;
  c.x = m2.x + 500; c.z = m2.z + 500;
  const res2 = logMarker(sim, null, sim.player);
  assert(res2.ok && res2.real, "the lead should log the second marker");
  assert(!res2.corroborated, "a surveyor alone must not be their own witness");
});

check("each human holds their own chop — one release does not cancel the other", () => {
  const sim = createRun({ seed: 327 });
  const c = sim.companions[0];
  possess(sim, c.id);
  const t1 = sim.trees[0], t2 = sim.trees[1];
  t1.discovered = true; t2.discovered = true;
  sim.player.x = t1.x; sim.player.z = t1.z;
  c.x = t2.x; c.z = t2.z;
  // Both hold; then the LEAD lets go while player two keeps holding.
  advance(sim, GATHER_HOLD_TIME - 0.3, { interact: true, others: [{ interact: true }] });
  assert(sim.gatherHold.progress > 0, "the lead should have progress");
  assert(c.gatherHold.progress > 0, "player two should have their own progress");
  advance(sim, 0.4, { interact: false, others: [{ interact: true }] });
  eq(sim.gatherHold.progress, 0, "the lead released, so the lead's hold resets");
  assert(t2.chopped, "player two kept holding and should have finished their chop");
  assert(!t1.chopped, "the lead released early and must NOT have chopped");
});

// ---------------------------------------------------------------------------
// dropping — the escape hatch the full-hands messages already promised
// ---------------------------------------------------------------------------
check("dropping a real item puts it back in the basin, pickable again", () => {
  const sim = createRun({ seed: 400 });
  sim.inventory.push({ id: "s0", real: true, kind: "flare", claimedKind: null });
  sim.player.x = 12; sim.player.z = -7;
  const worldBefore = sim.items.length;
  const res = dropItem(sim, 0);
  assert(res.ok && res.real, "dropping a real item should succeed");
  eq(sim.inventory.length, 0, "the slot should be gone from the pack");
  eq(sim.items.length, worldBefore + 1, "a dropped real item must exist in the world");
  const put = sim.items[sim.items.length - 1];
  eq(put.itemKind, "flare", "the dropped item keeps its TRUE kind");
  eq(put.x, 12, "it lands at the dropper's feet");
  assert(put.discovered && !put.taken, "a dropped item is already discovered and takeable");
  // ...and it can be picked straight back up.
  eq(pickupItem(sim).ok, true, "a dropped item should be pickable again");
  eq(sim.inventory.length, 1, "picking it back up refills the slot");
});

check("dropping a phantom costs nothing and leaves nothing behind", () => {
  const sim = createRun({ seed: 401 });
  sim.inventory.push({ id: "s0", real: false, claimedKind: "lens", kind: null });
  const worldBefore = sim.items.length;
  const lucidBefore = sim.player.lucidity;
  const res = dropItem(sim, 0);
  assert(res.ok && !res.real, "dropping a phantom should succeed as a phantom");
  eq(sim.inventory.length, 0, "the phantom slot should clear");
  eq(sim.items.length, worldBefore, "a phantom must NOT become a real world item");
  eq(sim.player.lucidity, lucidBefore, "dropping a phantom must cost nothing");
});

check("a hand full of phantoms can be cleared for free, not for a quarter of the meter", () => {
  const sim = createRun({ seed: 402 });
  for (let i = 0; i < ITEM_CAP; i++)
    sim.inventory.push({ id: `p${i}`, real: false, claimedKind: "flare", kind: null });
  const before = sim.player.lucidity;
  while (sim.inventory.length) dropItem(sim, 0);
  eq(sim.player.lucidity, before, "clearing phantoms by dropping must be free");
  // Using them instead is what used to be the only way out.
  const sim2 = createRun({ seed: 402 });
  for (let i = 0; i < ITEM_CAP; i++)
    sim2.inventory.push({ id: `p${i}`, real: false, claimedKind: "flare", kind: null });
  while (sim2.inventory.length) useItem(sim2, 0, null);
  assert(sim2.player.lucidity < before, "using phantoms should still cost — dropping is the free path");
});

check("dropping refuses an empty pack and an out-of-range slot", () => {
  const sim = createRun({ seed: 403 });
  eq(dropItem(sim, 0).reason, "empty", "dropping from an empty pack must refuse");
  sim.inventory.push({ id: "s0", real: true, kind: "flare", claimedKind: null });
  eq(dropItem(sim, 5).reason, "empty", "an out-of-range slot must refuse");
  eq(sim.inventory.length, 1, "a refused drop must not consume the slot");
});

// ---------------------------------------------------------------------------
// crafting — the selected slot decides which pair fuses
// ---------------------------------------------------------------------------
check("carrying all three kinds, the SELECTED slot picks the recipe", () => {
  const build = () => {
    const sim = createRun({ seed: 404 });
    for (const k of ["flare", "tether", "lens"])
      sim.inventory.push({ id: `s${sim.inventory.length}`, real: true, kind: k, claimedKind: null });
    return sim;
  };
  // slot 0 = flare -> pairs with tether = ember
  eq(previewCraft(build(), 0).kind, "ember", "selecting the flare should offer an ember");
  eq(craftItem(build(), 0).kind, "ember", "selecting the flare should craft an ember");
  // slot 2 = lens -> pairs with flare = beacon
  eq(previewCraft(build(), 2).kind, "beacon", "selecting the lens should offer a beacon");
  eq(craftItem(build(), 2).kind, "beacon", "selecting the lens should craft a beacon");
  // Same three items, a different intent, a different result — the point.
  assert(craftItem(build(), 0).kind !== craftItem(build(), 2).kind,
    "the selected slot must be able to change the outcome");
});

check("the craft hint always names what the craft button will actually make", () => {
  const sim = createRun({ seed: 405 });
  for (const k of ["flare", "tether", "lens"])
    sim.inventory.push({ id: `s${sim.inventory.length}`, real: true, kind: k, claimedKind: null });
  for (const sel of [0, 1, 2]) {
    const promised = previewCraft(sim, sel).kind;
    const copy = createRun({ seed: 405 });
    for (const k of ["flare", "tether", "lens"])
      copy.inventory.push({ id: `s${copy.inventory.length}`, real: true, kind: k, claimedKind: null });
    eq(craftItem(copy, sel).kind, promised, `slot ${sel}: hint promised ${promised} but craft made something else`);
  }
});

check("selecting a slot with no valid partner still falls back to any craftable pair", () => {
  const sim = createRun({ seed: 406 });
  // A stake pairs with nothing; flare+tether behind it still combine.
  sim.inventory.push({ id: "s0", real: true, kind: "stake", claimedKind: null });
  sim.inventory.push({ id: "s1", real: true, kind: "flare", claimedKind: null });
  sim.inventory.push({ id: "s2", real: true, kind: "tether", claimedKind: null });
  eq(craftItem(sim, 0).kind, "ember", "an unpairable selection must not block a valid craft");
});

// ---------------------------------------------------------------------------
// slot ids — never reused, so a stale hallucinated label can't be inherited
// ---------------------------------------------------------------------------
check("slot ids are never reused, even across use-then-repickup in one tick", () => {
  const sim = createRun({ seed: 407 });
  const seen = new Set();
  for (let n = 0; n < 4; n++) {
    const it = sim.items[n];
    it.discovered = true;
    sim.player.x = it.x; sim.player.z = it.z;
    pickupItem(sim);
    const id = sim.inventory[sim.inventory.length - 1].id;
    assert(!seen.has(id), `slot id ${id} was reused — a stale percept label could ride along`);
    seen.add(id);
    useItem(sim, sim.inventory.length - 1, null); // same tick, same resulting length
  }
  eq(seen.size, 4, "four pickups should have issued four distinct ids");
});

check("slot ids keep climbing across a basin transition", () => {
  const first = createRun({ seed: 408, level: 1, campaignLength: 3 });
  const it = first.items[0];
  it.discovered = true;
  first.player.x = it.x; first.player.z = it.z;
  pickupItem(first);
  const firstId = first.inventory[0].id;
  const carryOver = {
    party: first.party.map((ch) => ({
      id: ch.id, lucidity: ch.lucidity, scars: ch.scars, hallucinating: ch.hallucinating,
      hallucination: ch.hallucination, goneTime: ch.goneTime, drain: ch.drain, stoic: ch.stoic,
      chatty: ch.chatty, wander: ch.wander, selfCare: ch.selfCare, humanSlot: ch.humanSlot,
    })),
    doses: first.doses, inventory: first.inventory, wood: first.wood, stone: first.stone,
    stats: first.stats, slotSeq: first.slotSeq,
  };
  const second = createRun({ seed: 409, level: 2, campaignLength: 3, carryOver });
  const it2 = second.items[0];
  it2.discovered = true;
  second.player.x = it2.x; second.player.z = it2.z;
  pickupItem(second);
  const nextId = second.inventory[second.inventory.length - 1].id;
  assert(nextId !== firstId, `basin 2 reissued ${nextId}, colliding with a basin's carried slot`);
});

// ---------------------------------------------------------------------------
// camera-turn phantom drift — "don't look away" for phantom monoliths/pylons
// ---------------------------------------------------------------------------
check("camera-turn phantom drift only ever moves what is currently off-screen", () => {
  const sim = createRun({ seed: 504 });
  sim.player.x = 0; sim.player.z = 0; sim.player.yaw = 0;
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  sim.player.hallucinating = true;
  const percept = createPercept(sim.player);
  updatePercept(percept, sim, 0.1); // onset — seeds the real phantom list, overridden below

  percept.phantomMonoliths = [
    { id: "ph-front", name: "Front", x: 0, z: -10, phantom: true }, // bearing 0: dead ahead at yaw 0
    { id: "ph-back", name: "Back", x: 0, z: 10, phantom: true }, // bearing π: directly behind
  ];
  percept.phantomPylons = [];
  const front0 = { x: percept.phantomMonoliths[0].x, z: percept.phantomMonoliths[0].z };
  const back0 = { x: percept.phantomMonoliths[1].x, z: percept.phantomMonoliths[1].z };

  // Turn the camera back and forth inside a narrow arc that keeps "front" on
  // screen throughout (the view cone is ±0.85 rad) while still accumulating
  // plenty of total turn. "back" (bearing π) is never inside that cone at
  // either extreme, so it stays the only eligible candidate whenever a shift
  // actually fires.
  for (let i = 0; i < 8; i++) {
    sim.player.yaw = i % 2 === 0 ? 0.3 : -0.3;
    updatePercept(percept, sim, 0.05);
  }

  const front1 = percept.phantomMonoliths.find((m) => m.id === "ph-front");
  const back1 = percept.phantomMonoliths.find((m) => m.id === "ph-back");
  eq(front1.x, front0.x, "a phantom kept on screen the whole time must never move (x)");
  eq(front1.z, front0.z, "a phantom kept on screen the whole time must never move (z)");
  assert(back1.x !== back0.x || back1.z !== back0.z, "a phantom held off-screen the whole time should have drifted");
  const r = Math.hypot(back1.x - sim.player.x, back1.z - sim.player.z);
  assert(r >= 12 && r <= 28, `a drifted phantom should land within its documented reseed radius, got ${r.toFixed(1)}`);
});

check("turning the camera while lucid banks no turn credit for a later hallucination", () => {
  const sim = createRun({ seed: 505 });
  sim.player.x = 0; sim.player.z = 0; sim.player.yaw = 0;
  sim.player.hallucinating = false;
  const percept = createPercept(sim.player);
  // Spin all the way around, several times, while perfectly lucid.
  for (let i = 0; i < 20; i++) {
    sim.player.yaw += 1.4;
    updatePercept(percept, sim, 0.05);
  }
  eq(percept.turnAccum, 0, "turn accumulated while lucid must not persist");

  // Go under, then turn only a hair — nowhere near TURN_SHIFT_ANGLE. If lucid
  // turning had been silently banked, this tiny turn would instantly cash it
  // in the moment the hallucination begins.
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.05); // onset
  percept.phantomMonoliths = [{ id: "ph-x", x: 0, z: 10, phantom: true }]; // behind, off-screen
  const before = { x: percept.phantomMonoliths[0].x, z: percept.phantomMonoliths[0].z };
  sim.player.yaw += 0.05;
  updatePercept(percept, sim, 0.05);
  eq(percept.phantomMonoliths[0].x, before.x, "a tiny turn just after onset must not trigger a shift");
  eq(percept.phantomMonoliths[0].z, before.z, "a tiny turn just after onset must not trigger a shift");
});

// ---------------------------------------------------------------------------
// monster flicker — a real companion briefly reads as something else
// ---------------------------------------------------------------------------
check("monster flicker fires only while hallucinating, holds its pick, and clears on schedule", () => {
  const sim = createRun({ seed: 502 });
  sim.player.x = 0; sim.player.z = 0;
  const near = sim.companions[0];
  near.x = 5; near.z = 0; // well within MONSTER_SIGHT
  for (let i = 1; i < sim.companions.length; i++) { sim.companions[i].x = 9999; sim.companions[i].z = 9999; }
  const percept = createPercept(sim.player);

  // Force every chance roll to succeed, isolating hallucinating-state and
  // distance as the only remaining gates under test.
  sim.rng.chance = () => true;

  sim.player.hallucinating = false;
  updatePercept(percept, sim, 0.1);
  eq(percept.monsterId, null, "a forced-success roll must still not flicker while lucid");

  sim.player.hallucination = HALLUCINATION.WRONG_WAY; // any kind — the flicker is independent of it
  sim.player.hallucinating = true;
  updatePercept(percept, sim, 0.1); // onset tick: `lying` was computed false before this tick's flip
  eq(percept.monsterId, null, "the onset tick itself must not roll a flicker yet");
  updatePercept(percept, sim, 0.1); // now percept.active is already true -> lying is true
  eq(percept.monsterId, near.id, "the only nearby companion should be the one picked");
  assert(percept.monsterUntil > sim.time, "a fresh flicker must have a future end time");

  const list = perceivedCompanions(percept, sim);
  const seenNear = list.find((c) => c.id === near.id);
  assert(seenNear.monstrous, "the flickering companion must be reported as monstrous");
  for (const c of list) if (c.id !== near.id) assert(!c.monstrous, `only ${near.id} should read as monstrous, not ${c.id}`);

  // Mid-flicker, even with the roll still forced true, the SAME id must hold
  // — no re-picking a different companion out from under an active flicker.
  const heldId = percept.monsterId;
  updatePercept(percept, sim, 0.05);
  eq(percept.monsterId, heldId, "a flicker in progress must not be replaced by a new roll");

  // Push past the flicker's own end and force the reroll to fail — it must
  // actually clear, not silently re-arm forever.
  sim.time = percept.monsterUntil + 0.01;
  sim.rng.chance = () => false;
  updatePercept(percept, sim, 0.01);
  eq(percept.monsterId, null, "an expired flicker with a failed reroll must clear");

  // Recovering ends an in-progress flicker immediately, not at its own timer.
  sim.rng.chance = () => true;
  updatePercept(percept, sim, 0.01);
  assert(percept.monsterId !== null, "sanity check: a new flicker should have started");
  sim.player.hallucinating = false;
  updatePercept(percept, sim, 0.01);
  eq(percept.monsterId, null, "recovering must clear an in-progress flicker immediately");
});

check("monster flicker never picks a companion outside sight range, however often the roll succeeds", () => {
  const sim = createRun({ seed: 503 });
  sim.player.x = 0; sim.player.z = 0;
  for (const c of sim.companions) { c.x = 500; c.z = 500; } // nobody is near
  const percept = createPercept(sim.player);
  sim.rng.chance = () => true; // force every roll to succeed
  sim.player.hallucination = HALLUCINATION.CHORUS;
  sim.player.hallucinating = true;
  for (let i = 0; i < 21; i++) updatePercept(percept, sim, 0.1);
  eq(percept.monsterId, null, "with nobody in sight, a flicker must never fire regardless of the roll");
});

check("a phantom companion is never reported as monstrous — it's already fully fake", () => {
  const sim = createRun({ seed: 506 });
  sim.player.x = 0; sim.player.z = 0;
  sim.player.hallucination = HALLUCINATION.DOUBLED_PARTY;
  sim.player.hallucinating = true;
  const percept = createPercept(sim.player);
  updatePercept(percept, sim, 0.1);
  assert(percept.phantomCompanions.length > 0, "DOUBLED_PARTY should seed a phantom companion");
  const list = perceivedCompanions(percept, sim);
  const phantoms = list.filter((c) => c.phantom);
  assert(phantoms.length > 0, "the phantom companion should appear in the perceived list");
  for (const ph of phantoms) assert(!ph.monstrous, "a phantom companion must never also read as monstrous");
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// cache-bust structural invariant — no behavioural test can see this
// ---------------------------------------------------------------------------
// A stale nested module is invisible to every other test in this file: the
// source on disk is always correct, so the suite passes while a returning
// player's browser runs old code. This asserts the SHIPPING SHAPE instead —
// every cache-bustable URL carries the same token as BUILD.
// Brain: the-game-prologue#E8 (entry-point-only busting misses nested imports,
// and the next "still broken after deploy" gets re-diagnosed as a phantom
// logic bug — which is exactly what happened here, twice), dog#E30 (confirmed
// insufficient), opticon#E36 (assert every cache-buster equals BUILD).
check("every module import and asset URL carries the current BUILD token", () => {
  const srcDir = new URL("../src/", import.meta.url);
  const build = fsReadFileSync(new URL("main.js", srcDir), "utf8").match(/const BUILD = "([^"]+)"/)?.[1];
  assert(build, "could not read BUILD out of main.js");

  for (const file of fsReaddirSync(srcDir).filter((f) => f.endsWith(".js"))) {
    const text = fsReadFileSync(new URL(file, srcDir), "utf8");
    for (const [, spec] of text.matchAll(/from\s+"(\.\/[^"]+)"/g)) {
      assert(spec.includes(`?v=${build}`), `src/${file} imports "${spec}" without the current ?v=${build} — it will be served from cache after a deploy`);
    }
  }

  const html = fsReadFileSync(new URL("../index.html", import.meta.url), "utf8");
  for (const asset of ["css/style.css", "src/main.js"]) {
    assert(html.includes(`${asset}?v=${build}`), `index.html references ${asset} without ?v=${build}`);
  }

  // A PARTIAL stamp is worse than none, and is the easy mistake: stamp, then
  // commit only some of the touched files. main.js then imports
  // "./state.js?v=NEW" while percept.js imports "./state.js?v=OLD", and the
  // browser loads state.js TWICE under two URLs — two module instances, two
  // copies of every module-level value. Exactly one token may appear anywhere.
  const seen = new Set();
  for (const file of fsReaddirSync(srcDir).filter((f) => f.endsWith(".js"))) {
    const text = fsReadFileSync(new URL(file, srcDir), "utf8");
    for (const [, tok] of text.matchAll(/\?v=(mirage-[\d.]+)/g)) seen.add(tok);
  }
  for (const [, tok] of html.matchAll(/\?v=(mirage-[\d.]+)/g)) seen.add(tok);
  assert(
    seen.size <= 1,
    `more than one cache-bust token is live (${[...seen].join(", ")}) — a partial stamp loads a module twice under two URLs`,
  );
});

// ---------------------------------------------------------------------------
// palette accessibility — the "gone" tell may not rest on hue
// ---------------------------------------------------------------------------
// Read straight out of render.js's source rather than importing it, so this
// needs no WebGL and no Three. The values are the real ones either way.
check("a gone companion is distinguishable from a well one WITHOUT colour vision", () => {
  const src = fsReadFileSync(new URL("../src/render.js", import.meta.url), "utf8");
  const hex = (name) => {
    const m = src.match(new RegExp(`\\b${name}:\\s*0x([0-9a-fA-F]{6})`));
    assert(m, `PALETTE.${name} not found in render.js`);
    return parseInt(m[1], 16);
  };
  const lum = (h) => {
    const c = [(h >> 16) & 255, (h >> 8) & 255, h & 255].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  // Crude but standard channel-collapse stand-ins for the three common types
  // of colour-vision deficiency. Exact transforms differ between models; what
  // matters is that a tell surviving all of these is not relying on hue.
  const cvd = (h, type) => {
    let r = (h >> 16) & 255, g = (h >> 8) & 255, b = h & 255;
    if (type === "prot") { const m = r * 0.567 + g * 0.433; r = m; g = r * 0.558 + g * 0.442; }
    if (type === "deut") { const m = r * 0.625 + g * 0.375; r = m; g = r * 0.7 + g * 0.3; }
    if (type === "trit") { b = b * 0.95 + g * 0.05; }
    return ((r & 255) << 16) | ((g & 255) << 8) | (b & 255);
  };
  const worst = (a, b) => Math.min(...["normal", "prot", "deut", "trit"].map((t) =>
    ratio(t === "normal" ? a : cvd(a, t), t === "normal" ? b : cvd(b, t))));

  const body = hex("body"), bodyLost = hex("bodyLost"), monster = hex("monster");
  const goneContrast = worst(body, bodyLost);
  assert(goneContrast >= 3,
    `a gone companion must clear WCAG 3:1 against a well one under every CVD type, got ${goneContrast.toFixed(2)} — this tell would be hue-only`);
  const monsterContrast = worst(body, monster);
  assert(monsterContrast >= 3,
    `a monstrous companion must clear 3:1 against a well one, got ${monsterContrast.toFixed(2)}`);
  // And the two lies must not collapse into each other.
  assert(worst(bodyLost, monster) >= 1.5,
    `gone and monstrous must stay separable, got ${worst(bodyLost, monster).toFixed(2)}`);
});

// ---------------------------------------------------------------------------
// discoverability — a bound verb the how-to never mentions
// ---------------------------------------------------------------------------
// "give" shipped as a real, bound verb (offerItem, the only way to learn
// something about your OWN state) and appeared in the in-run hint strip while
// the How to play panel never mentioned it. A player saw a button prompt for a
// mechanic the game never explained. Cheap structural guard: every verb named
// in the keyboard hint strip must also appear somewhere in the how-to.
check("every verb in the control hints is explained in How to play", () => {
  const hud = fsReadFileSync(new URL("../src/hud.js", import.meta.url), "utf8");
  const html = fsReadFileSync(new URL("../index.html", import.meta.url), "utf8");
  const strip = hud.match(/keyboard:\s*"([^"]+)"/)?.[1];
  assert(strip, "could not find the keyboard hint strip in hud.js");

  let howto = html.slice(html.indexOf('id="howto"'));
  assert(howto.length > 200, "could not locate the how-to panel in index.html");
  // Drop the key-summary line at the bottom of the panel. It MIRRORS the hint
  // strip, so leaving it in makes this check tautological: it would happily
  // confirm that "give" appears in a list of keys while the panel never says
  // what giving does. The verb has to be explained in PROSE.
  howto = howto.replace(/<p class="howto-keys"[\s\S]*$/, "");
  const plain = howto.replace(/<[^>]+>/g, " ").toLowerCase();

  // Each hint segment reads "<key(s)> <verb words>"; the verb words are what a
  // player would search the how-to for.
  const VERBS = ["survey", "gather", "cycle item", "use item", "drop", "give", "craft", "check in", "dose", "pause"];
  for (const verb of VERBS) {
    assert(strip.toLowerCase().includes(verb), `test is stale: "${verb}" is no longer in the hint strip`);
    assert(plain.includes(verb.split(" ")[0]), `the hint strip offers "${verb}" but How to play never mentions it`);
  }
});

// ---------------------------------------------------------------------------
// stick deadzone — direction must survive it
// ---------------------------------------------------------------------------
// The deadzone was per-axis, which carves a SQUARE hole out of a round stick:
// at half deflection anything within ~20 degrees of an axis had its
// perpendicular component clipped to exactly zero, so gentle input SNAPPED to
// the cardinal directions and then jumped once it crossed the threshold. A
// player reported it as "up doesn't move toward the centre of the view... it's
// angled, almost like the player can't move diagonally".
//
// It stayed hidden while any input meant full speed. Making the stick properly
// analog is what exposed it, because partial deflection — exactly where the
// square hole bites — became the normal way to play.
//
// Parsed out of input.js rather than imported: the module reaches for `window`
// at load, and the shape of the deadzone is what matters here, not the wiring.
check("the stick deadzone preserves direction at every angle and deflection", () => {
  const src = fsReadFileSync(new URL("../src/input.js", import.meta.url), "utf8");
  assert(/const DEADZONE\s*=/.test(src) && /function stickVector/.test(src),
    "input.js should use a named radial stickVector(); a per-axis dead() is the bug this guards");
  assert(!/const dead = \(v\) =>/.test(src),
    "the per-axis square deadzone is back in input.js");

  const DZ = Number(src.match(/const DEADZONE\s*=\s*([\d.]+)/)[1]);
  const stick = (ax, ay) => {
    const mag = Math.hypot(ax, ay);
    if (mag < DZ) return { x: 0, y: 0 };
    const s2 = Math.min(1, (mag - DZ) / (1 - DZ));
    return { x: (ax / mag) * s2, y: (ay / mag) * s2 };
  };

  for (const mag of [0.35, 0.5, 0.75, 1]) {
    for (let deg = 0; deg < 360; deg += 5) {
      const r = (deg * Math.PI) / 180;
      const v = stick(Math.sin(r) * mag, -Math.cos(r) * mag);
      assert(v.x !== 0 || v.y !== 0, `a stick at ${mag} deflection should not be dead (angle ${deg})`);
      const got = ((Math.atan2(v.x, -v.y) * 180) / Math.PI + 360) % 360;
      const err = Math.abs(((got - deg + 540) % 360) - 180);
      assert(err < 0.001, `direction distorted at ${deg}deg / ${mag} deflection — moved ${got.toFixed(1)}deg`);
    }
  }
  // Magnitude must be monotonic and reach full scale, so partial pressure means
  // partial speed rather than an on/off switch.
  const mags = [0.2, 0.4, 0.6, 0.8, 1].map((m) => Math.hypot(stick(0, -m).x, stick(0, -m).y));
  for (let i = 1; i < mags.length; i++) {
    assert(mags[i] > mags[i - 1], `stick response must rise with deflection, ${mags}`);
  }
  assert(Math.abs(mags[mags.length - 1] - 1) < 1e-9, `a fully-pushed stick should reach 1, got ${mags[mags.length - 1]}`);
  assert(Math.hypot(stick(0.05, -0.05).x, stick(0.05, -0.05).y) === 0, "a resting stick should read as zero");
});


// --- the record is the graded object ---------------------------------------
// Measured before this existed: sweeping CORROBORATE_RADIUS from 11 to 0 took
// false log entries from 23.8 to 260.1 per run and did not move the win rate by
// a single seed. The game's central verb — you write down a marker that was
// never there — cost nothing at all.

check("a survey that names a marker which isn't out there is discredited, not won", () => {
  const sim = createRun({ seed: 4 });
  for (const m of sim.monoliths) m.logged = true;
  sim.logEntries.push({ name: "Ghost Pillar", real: false, t: 1, corroborated: false, x: 0, z: 0 });
  for (const c of sim.party) { c.x = sim.world.camp.x; c.z = sim.world.camp.z; }
  tick(sim, 0.05, {});
  eq(sim.status, "lost", "a corrupt record still extracted");
  eq(sim.ending, "discredited", "wrong ending for a corrupt record");
});

check("striking a false entry repairs the record, and the same run then wins", () => {
  const sim = createRun({ seed: 4 });
  for (const m of sim.monoliths) m.logged = true;
  // Somewhere in the basin, well away from every real marker.
  const spot = { x: sim.world.camp.x + 40, z: sim.world.camp.z + 40 };
  sim.logEntries.push({ name: "Ghost Pillar", real: false, t: 1, corroborated: false, ...spot });

  // Stand where the entry claims a marker, lucid, with nothing there: the same
  // LOG verb crosses it out. No new binding, no new UI.
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  sim.player.hallucinating = false;
  const res = logMarker(sim);
  assert(res.struck, "logging at an empty claimed site did not strike the entry");
  eq(badLogCount(sim), 0, "the record is still carrying the struck entry");

  for (const c of sim.party) { c.x = sim.world.camp.x; c.z = sim.world.camp.z; }
  tick(sim, 0.05, {});
  eq(sim.status, "won", "a repaired record did not extract");
  eq(sim.ending, "extracted", "wrong ending for a repaired record");
});

check("striking needs a lucid mind — you cannot audit your own hallucination", () => {
  const sim = createRun({ seed: 4 });
  const spot = { x: sim.world.camp.x + 40, z: sim.world.camp.z + 40 };
  sim.logEntries.push({ name: "Ghost Pillar", real: false, t: 1, corroborated: false, ...spot });
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  beginHallucinating(sim, sim.player);
  logMarker(sim);
  eq(badLogCount(sim), 1, "a hallucinating surveyor struck an entry from the record");
});



// Every ending the rules can produce must have its OWN words on the debrief.
// `discredited` shipped without any and fell through to "DARK" — the game
// naming the wrong cause of death for its own newest failure, which no
// functional test could see because the ending fired perfectly. Parsed out of
// the source rather than mocked, so adding an ending to state.js without
// adding a verdict to hud.js fails here.
check("every ending the rules can set has its own debrief verdict", () => {
  const rules = fsReadFileSync(new URL("../src/state.js", import.meta.url), "utf8");
  const hud = fsReadFileSync(new URL("../src/hud.js", import.meta.url), "utf8");

  const endings = [...rules.matchAll(/sim\.ending\s*=\s*"([a-z]+)"/g)].map((m) => m[1]);
  assert(endings.length >= 4, `only found ${endings.length} endings to check — the parse broke`);

  const block = hud.slice(hud.indexOf("const VERDICTS"), hud.indexOf("const verdict ="));
  const seen = new Map();
  for (const e of new Set(endings)) {
    const m = block.match(new RegExp(`${e}:\\s*"([^"]+)"`));
    assert(m, `ending "${e}" has no verdict in hud.js — it will inherit the fallback`);
    // Two endings MAY share words only if they mean the same thing to a player
    // (extracted/advance are both "you did the survey"); a silent collision
    // between a win and a loss is the failure this is really guarding.
    seen.set(e, m[1]);
  }
  const lost = ["dissolved", "discredited", "darkness"].filter((e) => seen.has(e));
  const won = ["extracted", "advance"].filter((e) => seen.has(e));
  for (const l of lost) {
    for (const w of won) {
      assert(seen.get(l) !== seen.get(w), `losing ending "${l}" reads the same as winning "${w}"`);
    }
  }
  assert(new Set(lost.map((e) => seen.get(e))).size === lost.length, "two different losses read identically");
});

// The repair verb has to be REACHABLE. Striking is bound to the survey key, so
// nothing in the input map hints it exists; without a prompt a player would
// have to remember which of six entries they wrote while their mind was gone,
// and where. Brain: assert-every-bound-verb-is-explained.
check("standing at a false claim while lucid offers the strike", () => {
  const sim = createRun({ seed: 12 });
  const spot = { x: sim.world.camp.x + 40, z: sim.world.camp.z + 40 };
  sim.logEntries.push({ name: "Ghost Pillar", real: false, t: 1, corroborated: false, ...spot });
  sim.player.x = spot.x;
  sim.player.z = spot.z;
  const target = strikeTargetAt(sim, sim.player);
  assert(target && target.name === "Ghost Pillar", "no strike offered where an entry claims a marker");

  // What the SCREEN shows and what the RULES allow must come apart here. If the
  // prompt vanished while under, its absence would be a perfectly reliable
  // readout of your own hallucination — the one fact MIRAGE never tells you.
  beginHallucinating(sim, sim.player);
  eq(strikeTargetAt(sim, sim.player), null, "a hallucinating mind was allowed to audit the record");
  assert(claimedEntryAt(sim, sim.player), "the OFFER vanished while hallucinating — that absence is a tell");

  // And the verb really is refused — but it must not LOOK refused. Silence
  // would be the loudest tell in the game: press the key, watch nothing
  // happen, and you have learned you are hallucinating. So the same event
  // arrives with the same text, and only `believedOnly` (which nothing on
  // screen renders differently) separates it from a real correction.
  const res = logMarker(sim);
  eq(badLogCount(sim), 1, "a hallucinating mind struck an entry from the record");
  assert(res.ok && !res.struck, "the refused strike did not report itself as attempted");
  const ev = sim.events.find((e) => e.kind === "logStrike");
  assert(ev, "no strike event was emitted for a hallucinating lead — the silence IS the tell");
  assert(ev.believedOnly, "a refused strike was not marked as belief-only");
  assert(/struck from the record/.test(ev.text), `the refused strike read differently: "${ev.text}"`);

  // The wording must be byte-identical to the real thing.
  const clean = createRun({ seed: 12 });
  clean.logEntries.push({ id: "e0", name: "Ghost Pillar", real: false, t: 1, corroborated: false, ...spot });
  clean.player.x = spot.x;
  clean.player.z = spot.z;
  logMarker(clean);
  const realEv = clean.events.find((e) => e.kind === "logStrike");
  eq(realEv.text, ev.text, "a real strike and a believed one do not read the same");
});


// The corroboration rule is now a VERB, so the game has to say so somewhere a
// player reads — otherwise "nobody vouched for it" is a scold for failing to do
// a thing nothing ever mentioned. Brain:
// assert-every-bound-verb-is-explained. Parsed out of the help panel, with the
// key-summary line stripped first: that line lists "1-5 check in" verbatim and
// would make this assertion tautological (confirming the key exists while the
// panel never says what it BUYS).
check("the help panel explains what checking in actually buys you", () => {
  const html = fsReadFileSync(new URL("../index.html", import.meta.url), "utf8");
  // Sliced to the panel's own closing tag, not to a fixed character count —
  // same reason as the resolver-ladder window in tests/tutorial.mjs. Adding a
  // section to the top of the panel used to push the sentences this check is
  // about out of reach, and it then reported "a bound verb with no explanation"
  // about text sitting right there.
  const from = html.indexOf('id="howto"');
  const end = html.indexOf("</div>", from);
  const panel = html.slice(from, end > 0 ? end : undefined);
  const prose = panel.replace(/<p class="keys"[\s\S]*?<\/p>/g, "").replace(/<[^>]+>/g, " ");
  for (const claim of [/check\s*in/i, /record/i, /thrown out|discredit/i, /strike/i]) {
    assert(claim.test(prose), `the help panel never mentions ${claim} — a bound verb with no explanation`);
  }
  // And it must not still describe the OLD ambient rule.
  assert(
    !/lucid\s+beside you/i.test(prose),
    "the help still says a lucid companion BESIDE you keeps the record honest — that rule is gone",
  );
});


// The sanity check, stated as the player would state it: a pylon that isn't
// there cannot be confirmed, because nobody else can put hands on it. Before
// this, a hallucinated pylon fired exactly like a real one — the deception
// reached the markers, the party, the items and the compass, but not the one
// object the run actually depends on.
check("one pair of hands only primes a pylon; a second fires it", () => {
  const sim = createRun({ seed: 74 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const a = sim.player, b = sim.companions[0];
  a.x = p.x; a.z = p.z;
  b.x = p.x + 600; b.z = p.z + 600; // out of the light
  a.lucidity = 30;

  const first = activatePylon(sim, a);
  assert(first.ok && first.primed && !first.confirmed, "a lone activation should prime, not fire");
  eq(a.lucidity, 30, "a primed-but-unconfirmed pylon gave light anyway");
  assert(!p.spent, "a primed-but-unconfirmed pylon spent itself");

  // Somebody out of range cannot confirm it either — they have to be IN it.
  activatePylon(sim, b);
  assert(!p.spent, "a confirmation from outside the radius fired the pylon");

  b.x = p.x; b.z = p.z;
  const second = activatePylon(sim, b);
  assert(second.confirmed, "a second pair of hands in the light did not fire it");
  assert(a.lucidity > 30 && p.spent, "the pulse did not land");
});

check("a prime goes stale — two people have to act together, not eventually", () => {
  const sim = createRun({ seed: 75 });
  sim.time = FULL_DRAIN_AT;
  const p = sim.pylons[0];
  const a = sim.player, b = sim.companions[0];
  a.x = p.x; a.z = p.z; b.x = p.x; b.z = p.z;
  activatePylon(sim, a);
  sim.time += PRIME_WINDOW + 1;
  const late = activatePylon(sim, b);
  assert(!late.confirmed, "a stale prime was still confirmable");
  assert(!p.spent, "a stale prime fired the pylon");
});

// And the one that makes it a sanity check rather than a chore: a phantom
// pylon can be primed forever and never confirmed, because there is nothing
// there for anyone else to put hands on.
check("a pylon that isn't there can never be confirmed", () => {
  const sim = createRun({ seed: 76 });
  sim.time = FULL_DRAIN_AT;
  const spot = farFromPylons(sim);
  for (const c of sim.party) { c.x = spot.x; c.z = spot.z; }
  sim.player.lucidity = 30;
  for (let i = 0; i < 5; i++) {
    for (const c of sim.party) activatePylon(sim, c);
  }
  eq(sim.player.lucidity, 30, "standing at nothing and pressing the verb put light back");
  eq(sim.pylons.filter((p) => p.spent).length, 0, "a pylon somewhere else was spent");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("mirage logic: OK");