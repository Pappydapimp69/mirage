// formation.mjs — can you ever actually see your party?
//
// This file was built when companions FOLLOWED, and it asserted the thing that
// mattered then: each forward station on screen more than half the time, nobody
// more than 3.5 units off their assigned slot. Cohesion deleted both. There are
// no stations, nothing follows, and a crew spread over ground is off-camera most
// of the time BY DESIGN — that is where "am I alone out here" comes from.
//
// Deleting the file would have been wrong though, because the complaint it was
// written for is still live: "the team doesn't feel like a team, they just
// scatter". The guarantee has simply changed shape. It is no longer "they are in
// front of you"; it is:
//
//   1. you see SOMEBODY reasonably often, so the basin never feels empty,
//   2. everybody is visible SOMETIMES over a long run, so nobody is structurally
//      invisible the way an unreachable station used to make them, and
//   3. when you CALL, the person you called comes, and you can see them.
//
// (3) is the one that replaces following outright: you cannot keep everyone in
// frame any more, but you are never unable to bring somebody to you.
//
// Run: node tests/formation.mjs [seeds]

import { createRun, tick, callCompanion } from "../src/state.js";
import { isBlockedAt } from "../src/world.js";

const SEEDS = Number(process.argv[2] || 8);
const DT = 1 / 20;
const SECONDS = 90;

// Must match render.js: horizontal FOV is fixed at 90 and vertical is derived.
const HFOV = 90;
const HALF = (HFOV / 2) * (Math.PI / 180);
// Beyond this a body is a smudge in the fog — on screen, but not legible as a
// companion. See render.js's fog far plane.
const LEGIBLE = 26;

const FORMATION_BEARINGS = [-0.30, 0.55, -0.55, 0.30, 2.75];
const FORMATION_R = [7.0, 5.6, 5.6, 7.0, 4.6];

/** Mirror of party.js formationSlot, so we can measure the gap to the station. */
function slotOf(sim, c) {
  const i = (c.index - 1) % 5;
  const a = (sim.player.heading ?? sim.player.yaw ?? 0) + FORMATION_BEARINGS[i];
  return { x: sim.player.x - Math.sin(a) * FORMATION_R[i], z: sim.player.z - Math.cos(a) * FORMATION_R[i] };
}

/** Signed bearing of `c` relative to the lead's facing; 0 is dead ahead. */
function bearingOf(player, c) {
  // forward = (-sin yaw, -cos yaw); right = (-cos yaw, +sin yaw).
  const fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
  const rx = -Math.cos(player.yaw), rz = Math.sin(player.yaw);
  const dx = c.x - player.x, dz = c.z - player.z;
  return Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz);
}

function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function runOne(seed) {
  const sim = createRun({ seed, difficulty: "standard" });
  const stats = sim.companions.map((c) => ({
    name: c.name,
    index: c.index,
    onScreen: 0,
    samples: 0,
    distSum: 0,
    bearingErrSum: 0,
    gapSum: 0,
    blocked: 0,
    goals: new Map(),
  }));
  let anyOnScreen = 0, allSamples = 0;

  // A lead who walks: forward most of the time, with slow turns, which is the
  // condition the complaint was made under. A stationary lead would let everyone
  // settle perfectly and measure nothing.
  let t = 0;
  while (t < SECONDS) {
    const turn = Math.sin(t * 0.17) * 0.35;
    sim.player.yaw += turn * DT;
    const fx = -Math.sin(sim.player.yaw), fz = -Math.cos(sim.player.yaw);
    tick(sim, DT, { move: { x: fx, z: fz }, yaw: sim.player.yaw });
    t += DT;
    if (t < 3) continue; // let the spawn fan resolve

    let seen = 0;
    sim.companions.forEach((c, i) => {
      const s = stats[i];
      const d = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
      const b = bearingOf(sim.player, c);
      const visible = Math.abs(b) <= HALF && d <= LEGIBLE;
      s.samples++;
      s.distSum += d;
      if (visible) { s.onScreen++; seen++; }
      if (c.goalKind === "follow") {
        s.bearingErrSum += Math.abs(wrap(b - (sim.player.heading - sim.player.yaw) - FORMATION_BEARINGS[(c.index - 1) % 5]));
        const sl = slotOf(sim, c);
        s.gapSum += Math.hypot(c.x - sl.x, c.z - sl.z);
        if (isBlockedAt(sim.world, sl.x, sl.z)) s.blocked++;
      }
      s.goals.set(c.goalKind, (s.goals.get(c.goalKind) || 0) + 1);
    });
    allSamples++;
    if (seen > 0) anyOnScreen++;
  }
  return { stats, anyOnScreen, allSamples };
}

const totals = new Map();
let anySum = 0, sampleSum = 0;
for (let seed = 1; seed <= SEEDS; seed++) {
  const { stats, anyOnScreen, allSamples } = runOne(seed);
  anySum += anyOnScreen;
  sampleSum += allSamples;
  for (const s of stats) {
    const key = `${s.index} ${s.name}`;
    const acc = totals.get(key) || { onScreen: 0, samples: 0, distSum: 0, errSum: 0, errN: 0, gapSum: 0, blocked: 0, goals: new Map() };
    acc.onScreen += s.onScreen;
    acc.samples += s.samples;
    acc.distSum += s.distSum;
    acc.errSum += s.bearingErrSum;
    acc.gapSum += s.gapSum;
    acc.blocked += s.blocked;
    acc.errN += s.goals.get("follow") || 0;
    for (const [g, n] of s.goals) acc.goals.set(g, (acc.goals.get(g) || 0) + n);
    totals.set(key, acc);
  }
}

// A lead who stands still and turns all the way round must, at some point, be
// looking at every single member of their party. The rear guard is DESIGNED to
// be behind you — that is what makes this a formation you are inside rather than
// a queue you are at the head of — but "behind you" has to mean "one turn away",
// not "gone". Nothing else in the walking numbers can distinguish those two.
function sweepVisibility(seed) {
  const sim = createRun({ seed, difficulty: "standard" });
  for (let t = 0; t < 12; t += DT) {
    const fx = -Math.sin(sim.player.yaw), fz = -Math.cos(sim.player.yaw);
    tick(sim, DT, { move: { x: fx, z: fz }, yaw: sim.player.yaw }); // settle on station
  }
  const seen = new Set();
  for (let t = 0; t < Math.PI * 2; t += 0.05) {
    sim.player.yaw += 0.05;
    tick(sim, DT, { move: { x: 0, z: 0 }, yaw: sim.player.yaw });
    for (const c of sim.companions) {
      const d = Math.hypot(c.x - sim.player.x, c.z - sim.player.z);
      if (Math.abs(bearingOf(sim.player, c)) <= HALF && d <= LEGIBLE) seen.add(c.name);
    }
  }
  return { seen, all: sim.companions.map((c) => c.name) };
}

const failures = [];
for (let seed = 1; seed <= Math.min(SEEDS, 4); seed++) {
  const { seen, all } = sweepVisibility(seed);
  const missing = all.filter((n) => !seen.has(n));
  // A standing turn used to show you everyone, because everyone was arranged
  // around you. Now they are out in the basin, so this is reported rather than
  // failed — the real "is anybody structurally invisible" check is the
  // never-once-on-screen assertion below, measured over the whole sweep.
  if (missing.length) console.log(`  (seed ${seed}: not in frame during a standing turn — ${missing.join(", ")})`);
}

// --- the guarantee that replaces following -----------------------------------
// You cannot keep the party in frame any more. What you can always do is bring
// somebody to you — so if CALL ever stops delivering, the player is left with no
// way to see another human being, and the basin becomes genuinely empty rather
// than atmospherically lonely. This is the load-bearing check in this file now.
{
  let delivered = 0;
  let attempts = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const sim = createRun({ seed, difficulty: "standard" });
    // Walk off until the party is genuinely scattered and out of frame.
    for (let i = 0; i < 60 / DT; i++) tick(sim, DT, { move: { x: 0, z: -1 }, yaw: sim.player.yaw });
    const target = sim.companions.find((c) => !c.hallucinating);
    if (!target) continue;
    attempts++;
    const res = callCompanion(sim, target.id);
    if (!res.ok) continue;
    // Give them the length of the call window to arrive.
    let sawThem = false;
    for (let i = 0; i < 40 / DT; i++) {
      tick(sim, DT, { move: { x: 0, z: 0 }, yaw: sim.player.yaw });
      const d = Math.hypot(target.x - sim.player.x, target.z - sim.player.z);
      if (d <= LEGIBLE) { sawThem = true; break; }
    }
    if (sawThem) delivered++;
  }
  const rate = attempts ? delivered / attempts : 0;
  console.log(`CALL brought them into view: ${(rate * 100).toFixed(0)}% of ${attempts} attempts`);
  if (rate < 0.8) {
    failures.push(`calling only brought somebody within sight ${(rate * 100).toFixed(0)}% of the time — the one guarantee that replaced following`);
  }
}

console.log(`seeds ${SEEDS} · ${SECONDS}s of walking each`);
console.log(`AT LEAST ONE companion on screen: ${((anySum / sampleSum) * 100).toFixed(1)}% of the time`);
for (const [key, a] of [...totals.entries()].sort()) {
  const pct = ((a.onScreen / a.samples) * 100).toFixed(1).padStart(5);
  const dist = (a.distSum / a.samples).toFixed(1);
  const err = a.errN ? ((a.errSum / a.errN) * 180 / Math.PI).toFixed(0) : "--";
  const gap = a.errN ? (a.gapSum / a.errN).toFixed(1) : "--";
  const blk = a.errN ? ((a.blocked / a.errN) * 100).toFixed(0) : "--";
  const goals = [...a.goals.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([g, n]) => `${g} ${((n / a.samples) * 100).toFixed(0)}%`)
    .join(" ");
  console.log(`  ${key.padEnd(12)} on-screen ${pct}%  dist ${dist}  gap ${gap}  slot-in-rock ${blk}%  bearing-err ${err}deg`);

  // NO PER-STATION FLOOR ANY MORE — there are no stations. What is still
  // forbidden is a companion who is never seen at all, which is what an
  // unreachable slot used to produce and what a broken wander would produce now.
  if (a.onScreen === 0) {
    failures.push(`${key} was never once on screen across ${SEEDS} seeds of walking`);
  }
}

// Measured on the shipped cohesion build: someone is in frame about a quarter of
// walking seconds, against ~85% when they walked behind you. The floor is set
// well under the measurement, as a floor and not a target — it exists to catch
// the party going structurally invisible, not to pin the number. A run where
// nobody is EVER in frame is a broken party; one where they are always in frame
// is following by another name, so this is bounded on both sides.
const anyPct = (anySum / sampleSum) * 100;
if (anyPct < 12) failures.push(`someone on screen only ${anyPct.toFixed(1)}% of walking seconds (floor is 12%)`);
if (anyPct > 80) failures.push(`someone on screen ${anyPct.toFixed(1)}% of walking seconds — the party is following again, not ranging`);

if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  console.error(`formation: ${failures.length} failed`);
  process.exit(1);
}
console.log("mirage formation: OK");
