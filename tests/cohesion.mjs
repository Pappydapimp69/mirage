// cohesion.mjs — the call, the chain, and the ping.
//
// Three systems that replace "the party follows you". Each has a specific way
// of going wrong that a naive test would miss, and each is named below.
//
// Run: node tests/cohesion.mjs

import {
  createRun, tick, callCompanion, isAnswering, groupWith, pingInterval, updatePing, isReturning,
  CALL_COOLDOWN, CALL_PERSONAL, LINK_RANGE, PING_EVERY, PING_STRETCH, beginHallucinating, HALLUCINATION,
} from "../src/state.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };
const run = () => createRun({ seed: 31, difficulty: "standard" });

// --- CALL: the cooldowns ----------------------------------------------------
check("a call spends both cadences", () => {
  const sim = run();
  const r = callCompanion(sim, "c1");
  assert(r.ok, `the first call was refused: ${r.reason}`);
  assert(sim.player.callReadyAt > sim.time, "the global cadence was not spent");
  assert(sim.companions[0].answerReadyAt > sim.time, "the personal cadence was not spent");
});

check("a second call to anyone is refused until the global cadence recharges", () => {
  const sim = run();
  callCompanion(sim, "c1");
  eq(callCompanion(sim, "c2").ok, false, "a second call landed immediately");
  sim.time += CALL_COOLDOWN + 0.1;
  assert(callCompanion(sim, "c2").ok, "a different companion was still refused after the global cadence");
});

check("the same companion stays unavailable much longer than the global cadence", () => {
  const sim = run();
  callCompanion(sim, "c1");
  sim.time += CALL_COOLDOWN + 0.1;
  eq(callCompanion(sim, "c1").ok, false, "the same companion answered again after only the global cadence");
  sim.time += CALL_PERSONAL;
  assert(callCompanion(sim, "c1").ok, "the same companion never became available again");
});

// THE bug opticon#E15 names: a refused use that still burns the cooldown means
// the player loses their next real call to a press that did nothing.
check("a refused call is free", () => {
  const sim = run();
  callCompanion(sim, "c1");
  const readyAt = sim.player.callReadyAt;
  callCompanion(sim, "c2"); // refused — recharging
  callCompanion(sim, "zzz"); // refused — no such companion
  eq(sim.player.callReadyAt, readyAt, "a refused call pushed the cooldown out");
});

// --- CALL: the leak ---------------------------------------------------------
// The whole point. A call that will not be answered must be indistinguishable
// from one that will, at the moment of the press.
check("a call that will not be answered looks identical to one that will", () => {
  const lucid = run();
  const lucidRes = callCompanion(lucid, "c1");
  const lucidEv = lucid.events.filter((e) => e.kind === "call").pop();

  const gone = run();
  beginHallucinating(gone, gone.companions[0], HALLUCINATION.PHANTOM_MARKER);
  const goneRes = callCompanion(gone, "c1");
  const goneEv = gone.events.filter((e) => e.kind === "call").pop();

  eq(goneRes.ok, lucidRes.ok, "the return value differs when nobody will answer");
  assert(lucidEv && goneEv, "no call event was emitted");
  eq(goneEv.text, lucidEv.text, "the call SAYS something different when nobody will answer — that is the meter, on screen");
  eq(goneEv.kind, lucidEv.kind, "a different event kind is emitted when nobody will answer");
  // ...and the difference is only in whether anybody actually comes.
  eq(isAnswering(lucid, lucid.companions[0]), true, "a lucid companion did not start answering");
  eq(isAnswering(gone, gone.companions[0]), false, "a gone companion answered anyway");
});

check("no call event ever carries a failure string", () => {
  const sim = run();
  beginHallucinating(sim, sim.companions[0], HALLUCINATION.PHANTOM_MARKER);
  callCompanion(sim, "c1");
  for (const ev of sim.events.filter((e) => e.kind === "call")) {
    assert(!/no answer|nobody|too far|cannot|can't|fail/i.test(ev.text), `a call reported failure: "${ev.text}"`);
  }
});

// --- the chain --------------------------------------------------------------
check("a chain holds through people, not to the lead", () => {
  const at = (id, x) => ({ id, x, z: 0 });
  const line = [at("you", 0), at("c1", LINK_RANGE - 1), at("c2", (LINK_RANGE - 1) * 2), at("c3", (LINK_RANGE - 1) * 3)];
  const g = groupWith(line, "you");
  eq(g.size, 4, "a spaced-out line broke, though every neighbour is in range");
  assert(Math.abs(line[3].x) > LINK_RANGE * 2, "the test's far end is not actually far from the lead");
});

check("the chain breaks at the gap, and only past it", () => {
  const at = (id, x) => ({ id, x, z: 0 });
  const line = [at("you", 0), at("c1", 19), at("c2", 38), at("c3", 38 + LINK_RANGE + 5), at("c4", 38 + LINK_RANGE + 6)];
  const g = groupWith(line, "you");
  assert(g.has("c2"), "the near side of the gap dropped out");
  assert(!g.has("c3") && !g.has("c4"), "the far side of the gap is still counted as with the group");
});

// The mechanic. Cohesion over PERCEIVED members means a phantom is a valid link.
check("a phantom companion holds a chain the real party has already broken", () => {
  const at = (id, x) => ({ id, x, z: 0 });
  // The gap must be wider than one link but narrower than two, or no single
  // phantom could bridge it and the fixture would prove nothing either way.
  const gap = LINK_RANGE * 1.8;
  const real = [at("you", 0), at("c1", gap)];
  eq(groupWith(real, "you").size, 1, "the real party is not actually broken in this fixture");
  const believed = [...real, at("ph-c0", gap / 2)]; // the sixth, who is not there
  const g = groupWith(believed, "you");
  assert(g.has("c1"), "the phantom did not bridge the gap — the anchor mechanic is not working");
  eq(g.size, 3, "the believed chain is not intact");
});

// --- the ping ---------------------------------------------------------------
check("the ping interval stretches as a mind declines", () => {
  const steady = pingInterval({ lucidity: 100 });
  const gone = pingInterval({ lucidity: 0 });
  eq(steady, PING_EVERY, "a clear mind's interval is not the base interval");
  assert(gone > steady * 2, `a failing mind's interval (${gone}) barely stretched from ${steady}`);
  assert(Math.abs(gone - PING_EVERY * PING_STRETCH) < 0.001, "the stretch does not reach its stated maximum");
});

// dog#E41: a balanced pull/push freezes the crowd at a fixed radius forever.
// The impulse must EXPIRE, or a pinged companion never stops returning.
check("a ping expires instead of holding", () => {
  const sim = run();
  const ch = sim.companions[0];
  ch.x = sim.player.x + 100; ch.z = sim.player.z;
  ch.pingAt = 0;
  updatePing(sim, ch);
  assert(isReturning(sim, ch), "a distant companion was never pinged");
  sim.time += 60;
  assert(!isReturning(sim, ch), "the ping never expired — it is a leash, not an impulse");
});

check("a companion inside the ping range is left alone", () => {
  const sim = run();
  const ch = sim.companions[0];
  ch.x = sim.player.x + 2; ch.z = sim.player.z;
  ch.pingAt = 0;
  updatePing(sim, ch);
  assert(!isReturning(sim, ch), "somebody standing next to the lead was told to come back");
});

check("a mind that is gone does not answer the ping", () => {
  const sim = run();
  const ch = sim.companions[0];
  ch.x = sim.player.x + 100; ch.z = sim.player.z;
  beginHallucinating(sim, ch, HALLUCINATION.PHANTOM_MARKER);
  ch.pingAt = 0;
  updatePing(sim, ch);
  assert(!isReturning(sim, ch), "a hallucinating companion still walks obediently back — the drift tell is gone");
});

// --- cohesion is not a shield (a resolved tension, kept resolved) -----------
check("nothing in cohesion touches lucidity", () => {
  const sim = run();
  const ch = sim.companions[0];
  ch.lucidity = 50;
  const before = ch.lucidity;
  updatePing(sim, ch);
  groupWith(sim.party, sim.player.id);
  callCompanion(sim, ch.id);
  eq(ch.lucidity, before, "a cohesion call changed somebody's lucidity — cohesion is acting as a shield again");
});

check("none of it draws from the rng", () => {
  // Constant roll count: these run every tick, so a draw here would re-perturb
  // every other mind and surface later as a resumed run diverging.
  const sim = run();
  const before = sim.rng.snapshot();
  groupWith(sim.party, sim.player.id);
  for (const c of sim.companions) updatePing(sim, c);
  callCompanion(sim, "c1");
  eq(sim.rng.snapshot(), before, "cohesion consumed rng draws");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log("  ✗ " + f);
if (failures.length) process.exit(1);
console.log("mirage cohesion: OK");
