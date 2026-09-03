// Save/resume tests. Pure Node, no browser, no localStorage — the serialise /
// deserialise pair is exercised directly, and a tiny in-memory localStorage
// stand-in covers the storage wrapper.
//
// The assertion that matters most is DIVERGENCE-FREE RESUME: a restored run,
// ticked forward, must produce the same state as the original run ticked
// forward by the same amount. Field-by-field equality at t=0 is necessary but
// nowhere near sufficient — it passes happily while the rng stream is off by
// one draw, which only shows up minutes later as a different basin.

import { createRun, tick, LUCIDITY_GRACE, FULL_DRAIN_AT, beginHallucinating, pickupItem, gatherResource } from "../src/state.js";
import { makeRng } from "../src/rng.js";
import { buildCamp, CAMP_SEED } from "../src/camp.js";
import {
  serializeRun, deserializeRun, saveRun, loadSave, clearSave, hasSave,
  describeSave, SAVE_KEY, SAVE_VERSION, loadSettings, saveSettings, SETTINGS_KEY,
} from "../src/save.js";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg} — got ${a}, expected ${b}`); }

/** Step the sim in small slices; tick() clamps dt to 0.1 internally. */
function advance(sim, seconds, input = {}) {
  for (let t = 0; t < seconds; t += 1 / 30) tick(sim, 1 / 30, input);
  return sim;
}

/** A compact fingerprint of everything a divergence would show up in. */
function fingerprint(sim) {
  return JSON.stringify({
    time: sim.time.toFixed(3),
    rng: sim.rng.snapshot(),
    party: sim.party.map((c) => [
      c.id, c.x.toFixed(4), c.z.toFixed(4), c.lucidity.toFixed(4),
      c.hallucinating, c.hallucination, c.goalKind, c.scars,
    ]),
    pylons: sim.pylons.map((p) => [p.id, !!p.spent, (p.primedBy || []).join("|"), p.primedAt ?? -1e9]),
    monoliths: sim.monoliths.map((m) => [m.id, m.logged, m.discovered]),
    items: sim.items.map((i) => [i.id, i.discovered, i.taken]),
    wood: sim.wood, stone: sim.stone, doses: sim.doses,
    inventory: sim.inventory.map((s) => [s.real, s.kind, s.claimedKind]),
    status: sim.status,
  });
}

// ---------------------------------------------------------------------------
// rng state words
// ---------------------------------------------------------------------------
check("rng snapshot/restore reproduces the exact stream", () => {
  const a = makeRng(12345);
  for (let i = 0; i < 50; i++) a();
  const word = a.snapshot();
  const nextFive = [a(), a(), a(), a(), a()];

  const b = makeRng(999); // deliberately a DIFFERENT seed
  b.restore(word);
  for (let i = 0; i < 5; i++) {
    eq(b(), nextFive[i], `restored stream diverged at draw ${i}`);
  }
});

check("rng restore preserves a zero state word instead of coercing it", () => {
  const r = makeRng(1);
  r.restore(0);
  eq(r.snapshot(), 0, "a legitimate mid-stream 0 was rewritten");
  // And it must still produce a usable stream rather than jamming.
  const v = r();
  assert(v >= 0 && v < 1, `a restored-from-0 generator produced ${v}`);
});

// ---------------------------------------------------------------------------
// round trip
// ---------------------------------------------------------------------------
check("a fresh run round-trips through serialise/deserialise unchanged", () => {
  const sim = createRun({ seed: 4242, difficulty: "standard", level: 1, campaignLength: 3 });
  const restored = deserializeRun(serializeRun(sim));
  eq(fingerprint(restored), fingerprint(sim), "a fresh run did not round-trip");
});

// A saved value that round-trips into the SAME wrong thing on both sides passes
// every equality check there is. This one has to look at the contents.
check("a saved path comes back as walkable grid cells, not undefined", () => {
  // Formation followers walk straight lines and rarely hold a path at all, so
  // the state this is about only appears on a LONG errand: drop everyone into
  // the pylon-seeking band and let them route across the basin.
  let sim = null;
  for (let seed = 1; seed <= 12 && !sim; seed++) {
    const s = createRun({ seed, difficulty: "standard" });
    s.time = FULL_DRAIN_AT;
    advance(s, 1, { move: { x: 1, z: -0.6 }, yaw: 0.2 }); // lets party.js build c.known
    for (const c of s.companions) {
      c.lucidity = 12; // brittle: everyone breaks for a remembered pylon
      for (const p of s.pylons) c.known.pylons.add(p.id);
    }
    advance(s, 20, { move: { x: 1, z: -0.6 }, yaw: 0.2 });
    if (s.companions.some((c) => c.path && c.path.length)) sim = s;
  }
  assert(sim, "no companion was ever mid-path — this test cannot see anything");

  const restored = deserializeRun(serializeRun(sim));
  for (const c of restored.companions) {
    if (!c.path) continue;
    for (const n of c.path) {
      assert(
        Number.isFinite(n.cx) && Number.isFinite(n.cz),
        `restored path node is not a grid cell: ${JSON.stringify(n)}`,
      );
    }
  }
});

check("a run mid-flight round-trips, INCLUDING the rng stream position", () => {
  const sim = createRun({ seed: 77, difficulty: "standard", level: 1, campaignLength: 3 });
  sim.time = FULL_DRAIN_AT; // past grace so drain and its rng draws are live
  advance(sim, 40, { move: { x: 0.4, z: -1 }, yaw: 0.3 });

  const restored = deserializeRun(serializeRun(sim));
  eq(fingerprint(restored), fingerprint(sim), "mid-flight state did not round-trip");

  // The real test: run BOTH forward and require they stay identical. A saved
  // rng position that is off by even one draw passes the equality above and
  // fails here.
  advance(sim, 30, { move: { x: 0, z: -1 }, yaw: 0.3 });
  advance(restored, 30, { move: { x: 0, z: -1 }, yaw: 0.3 });
  eq(fingerprint(restored), fingerprint(sim), "a resumed run diverged from the original after 30s");
});

check("a resumed run diverges from one resumed WITHOUT the rng word — the guard works", () => {
  const sim = createRun({ seed: 31, difficulty: "bleak", level: 1, campaignLength: 3 });
  sim.time = FULL_DRAIN_AT;
  advance(sim, 45, { move: { x: 1, z: -1 }, yaw: 0 });

  const data = serializeRun(sim);
  const good = deserializeRun(data);
  const bad = deserializeRun({ ...data, rng: (data.rng ^ 0x9e3779b9) >>> 0 }); // wrong stream position

  advance(sim, 40);
  advance(good, 40);
  advance(bad, 40);

  eq(fingerprint(good), fingerprint(sim), "the correctly-restored run should track the original");
  assert(
    fingerprint(bad) !== fingerprint(sim),
    "a run restored with the WRONG rng word stayed identical — this test can no longer detect stream drift",
  );
});

check("carried progress survives: logs, gathers, pickups, doses, scars, planted pylons", () => {
  const sim = createRun({ seed: 808, difficulty: "standard", level: 2, campaignLength: 3 });
  sim.time = FULL_DRAIN_AT;

  // Log a marker, take an item, chop a tree, spend a dose, scar a companion.
  const m = sim.monoliths[0];
  m.discovered = true; m.logged = true;
  sim.logEntries.push({ id: m.id, name: m.name, real: true, at: sim.time });
  const it = sim.items.find((i) => !i.taken);
  it.discovered = true;
  sim.player.x = it.x; sim.player.z = it.z;
  pickupItem(sim);
  const t = sim.trees[0];
  t.discovered = true;
  sim.player.x = t.x; sim.player.z = t.z;
  gatherResource(sim);
  sim.doses = 1;
  sim.companions[2].scars = 2;
  // A planted Stake: a pylon that exists in no seed-generated world.
  sim.pylons.push({ id: "stake-test", x: 5, z: 5, spent: false, primedBy: [], primedAt: -1e9 });

  const restored = deserializeRun(serializeRun(sim));
  eq(restored.logEntries.length, 1, "log entry lost");
  eq(restored.monoliths.find((x) => x.id === m.id).logged, true, "logged flag lost");
  eq(restored.items.find((x) => x.id === it.id).taken, true, "taken flag lost");
  eq(restored.inventory.length, sim.inventory.length, "inventory lost");
  eq(restored.trees[0].chopped, true, "chopped flag lost");
  eq(restored.wood, sim.wood, "wood lost");
  eq(restored.doses, 1, "doses lost");
  eq(restored.companions[2].scars, 2, "scars lost");
  eq(restored.level, 2, "campaign level lost");
  assert(restored.pylons.some((p) => p.id === "stake-test"), "a planted Stake did not survive the save");
});

check("companion identity survives — traits, memory and errands", () => {
  const sim = createRun({ seed: 616, difficulty: "standard" });
  const c = sim.companions[1];
  c.known = { pylons: new Set(["p0", "p2"]), monoliths: new Set(["m3"]) };
  c.fetchItemId = "i2";
  c.goalKind = "fetch";
  c.goal = { x: 12.5, z: -3.25 };
  const traits = { drain: c.drain, stoic: c.stoic, chatty: c.chatty, wander: c.wander, selfCare: c.selfCare };

  const r = deserializeRun(serializeRun(sim)).companions[1];
  for (const [k, v] of Object.entries(traits)) eq(r[k], v, `trait ${k} was reshuffled by a resume`);
  assert(r.known.pylons.has("p0") && r.known.pylons.has("p2"), "remembered pylons lost");
  assert(r.known.monoliths.has("m3"), "remembered monoliths lost");
  eq(r.fetchItemId, "i2", "in-flight errand lost");
  eq(r.goalKind, "fetch", "goal kind lost");
  eq(r.goal.x, 12.5, "goal position lost");
});

check("a hallucinating mind resumes still hallucinating, with the same kind", () => {
  const sim = createRun({ seed: 505 });
  const c = sim.companions[0];
  beginHallucinating(sim, c);
  const kind = c.hallucination;
  assert(kind, "test setup: no hallucination kind was assigned");

  const r = deserializeRun(serializeRun(sim)).companions[0];
  eq(r.hallucinating, true, "a gone companion came back lucid — the resume healed them");
  eq(r.hallucination, kind, "the hallucination kind changed across a resume");
});

// ---------------------------------------------------------------------------
// storage wrapper + the ended-run rule
// ---------------------------------------------------------------------------
function withFakeStorage(fn) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  try { return fn(map); } finally { delete globalThis.localStorage; }
}

check("saveRun/loadSave/clearSave round-trip through storage", () => {
  withFakeStorage(() => {
    const sim = createRun({ seed: 21, difficulty: "gentle" });
    sim.time = FULL_DRAIN_AT;
    advance(sim, 20);
    assert(saveRun(sim, 1234), "saveRun reported failure");
    assert(hasSave(), "hasSave did not see the save");
    const restored = deserializeRun(loadSave());
    eq(fingerprint(restored), fingerprint(sim), "a storage round-trip diverged");
    clearSave();
    assert(!hasSave(), "clearSave left the slot behind");
  });
});

check("an ENDED run is never saved — Resume must not hand back a lost frame", () => {
  withFakeStorage(() => {
    const sim = createRun({ seed: 22 });
    for (const status of ["lost", "won", "levelComplete"]) {
      sim.status = status;
      eq(saveRun(sim, 1), false, `a '${status}' run was written to the save slot`);
      eq(hasSave(), false, `a '${status}' run left something in the save slot`);
    }
    sim.status = "playing";
    assert(saveRun(sim, 1), "a live run should still save");
  });
});

check("a save from an older schema is discarded, not half-applied", () => {
  withFakeStorage((map) => {
    const sim = createRun({ seed: 23 });
    saveRun(sim, 1);
    const stored = JSON.parse(map.get(SAVE_KEY));
    map.set(SAVE_KEY, JSON.stringify({ ...stored, v: SAVE_VERSION - 1 }));
    eq(loadSave(), null, "an old-schema save was returned instead of discarded");
    eq(map.has(SAVE_KEY), false, "an old-schema save was left in storage to keep failing");
  });
});

check("a corrupt save reads as absent rather than throwing", () => {
  withFakeStorage((map) => {
    map.set(SAVE_KEY, "{not json at all");
    eq(loadSave(), null, "corrupt JSON should read as no-save");
    assert(!hasSave(), "corrupt JSON should not count as a save");
  });
});

check("missing localStorage degrades to 'no save' instead of crashing", () => {
  const sim = createRun({ seed: 24 });
  eq(saveRun(sim, 1), false, "saveRun should report failure with no storage");
  eq(loadSave(), null, "loadSave should return null with no storage");
  clearSave(); // must not throw
});

check("deserializeRun refuses junk", () => {
  eq(deserializeRun(null), null, "null should not deserialise");
  eq(deserializeRun({ v: 999 }), null, "a future schema should not deserialise");
});

check("describeSave reports progress without ever leaking a meter", () => {
  const sim = createRun({ seed: 25, level: 2, campaignLength: 3 });
  sim.time = 125;
  const d = describeSave(serializeRun(sim));
  eq(d.level, 2, "level");
  eq(d.campaignLength, 3, "campaign length");
  eq(d.minutes, 2, "minutes");
  eq(d.seconds, 5, "seconds");
  const asText = JSON.stringify(d);
  assert(!/lucidity/i.test(asText), "describeSave leaked a lucidity value onto the title screen");
});

// ---------------------------------------------------------------------------
// preferences — separate lifetime from the run
// ---------------------------------------------------------------------------
check("preferences survive a run being cleared", () => {
  withFakeStorage(() => {
    saveSettings({ volume: 0.35, difficulty: "bleak" });
    const sim = createRun({ seed: 91 });
    saveRun(sim, 1);
    clearSave(); // what finish() does when a run ends
    const s = loadSettings();
    eq(s.volume, 0.35, "losing a run reset the volume");
    eq(s.difficulty, "bleak", "losing a run reset the pressure preference");
    eq(hasSave(), false, "the run slot should still be gone");
  });
});

check("saveSettings merges rather than replacing", () => {
  withFakeStorage(() => {
    saveSettings({ volume: 0.35 });
    saveSettings({ difficulty: "gentle" });
    const s = loadSettings();
    eq(s.volume, 0.35, "a later partial write clobbered an unrelated preference");
    eq(s.difficulty, "gentle", "the later write did not land");
  });
});

check("out-of-range or junk preferences degrade to defaults, not to a broken game", () => {
  withFakeStorage((map) => {
    map.set(SETTINGS_KEY, JSON.stringify({ volume: 45, muted: "yes", difficulty: "impossible", coop: "hive" }));
    const s = loadSettings();
    eq(s.volume, 0.7, "an out-of-range volume should fall back, not deafen or mute");
    eq(s.muted, false, "a non-boolean muted should fall back");
    eq(s.difficulty, "standard", "an unknown difficulty should fall back");
    eq(s.coop, "solo", "an unknown party mode should fall back");
  });
});

check("corrupt or absent preference storage reads as defaults", () => {
  withFakeStorage((map) => {
    map.set(SETTINGS_KEY, "{{{not json");
    eq(loadSettings().volume, 0.7, "corrupt preferences should read as defaults");
  });
  // And with no storage at all (the Node default here).
  eq(loadSettings().difficulty, "standard", "missing storage should read as defaults");
  eq(saveSettings({ volume: 0.1 }), false, "saveSettings should report failure with no storage");
});

// --- the camp is not a seed ----------------------------------------------

check("a run saved on the camp resumes ON THE CAMP", () => {
  // Every BASIN is a pure function of its seed and this file is built on that.
  // The camp is the exception: it is authored, and the sentinel seed
  // regenerates as a perfectly valid basin instead. A resume therefore used to
  // drop the player into a randomly generated map with their camp positions
  // pasted on — no error anywhere, and nothing here looked, because every other
  // test in this file uses a basin. The tutorial autosaves every five seconds,
  // so quitting part way through the walk in and pressing Resume got exactly
  // that.
  const world = buildCamp();
  const sim = createRun({ seed: CAMP_SEED, world });
  const back = deserializeRun(serializeRun(sim));
  assert(back, "a camp save did not restore at all");
  eq(back.world.blocked.length, world.blocked.length, "grid size changed");
  let same = true;
  for (let i = 0; i < world.blocked.length; i++) if (back.world.blocked[i] !== world.blocked[i]) { same = false; break; }
  assert(same, "the resumed world is not the camp — a basin was generated from the sentinel seed");
  assert(back.world.trainer && back.trainer, "the resumed camp lost the trainer");
});

check("the camp's own flags survive, because they gate draws and verbs", () => {
  const world = buildCamp();
  const sim = createRun({ seed: CAMP_SEED, world });
  sim.noDrain = true;
  sim.canClearMoss = true;
  sim.callUnlocked = false;
  sim.reachedTrainer = true;
  const back = deserializeRun(serializeRun(sim));
  eq(back.noDrain, true, "noDrain did not survive — a whole class of per-tick draws would restart");
  eq(back.canClearMoss, true, "canClearMoss did not survive — the moss becomes immovable again");
  eq(back.callUnlocked, false, "callUnlocked did not survive — a verb the tutorial has not taught comes back unlocked");
  eq(back.reachedTrainer, true, "reachedTrainer did not survive — objective one reopens");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("mirage save: OK");
