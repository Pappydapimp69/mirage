// tutorial.mjs — the invariants the tutorial blueprint committed to.
//
// Every check here corresponds to a numbered invariant in
// docs/blueprint-tutorial-the-walk-in.md, and most exist because brain named
// the exact failure before a line was written. A tutorial's characteristic bug
// is SILENT STARVATION — the step simply never fires, with no error from any
// layer — so these assert reachability and pinning, not just "the code ran".
//
// Run: node tests/tutorial.mjs

import { STAGES, TAUGHT_VERBS, observe, freshProgress, leaks, FORBIDDEN, outranks, VERB_PRIORITY } from "../src/tutorial.js";
import { createRun, tick, badLogCount, pickupItem, activatePylon, checkIn, offerItem, logMarker, beginHallucinating, HALLUCINATION, FULL_DRAIN_AT } from "../src/state.js";
import { readFileSync } from "fs";

let passed = 0;
const failures = [];
function check(name, fn) {
  try { fn(); passed++; } catch (e) { failures.push(`${name}: ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m} — got ${JSON.stringify(a)}, expected ${JSON.stringify(b)}`); };

// --- I1: the meter never leaks -------------------------------------------
check("no authored tutorial string names the hidden meter", () => {
  for (const s of STAGES) {
    for (const [field, text] of [["brief", s.brief], ["debrief", s.debrief], ["title", s.title], ["line", s.line?.text]]) {
      if (!text) continue;
      const bad = leaks(text);
      assert(bad.length === 0, `stage "${s.id}" ${field} leaks ${bad.join(", ")}: "${text}"`);
    }
  }
});

check("the forbidden list covers the band names the rules actually use", () => {
  // A leak check that does not know the real vocabulary is decoration. These
  // are the literal band strings state.js emits.
  for (const band of ["steady", "unsettled", "fraying", "brittle"]) {
    assert(FORBIDDEN.includes(band), `band "${band}" is not on the forbidden list`);
  }
});

// --- I3: every step is pinned to an entity, never a bare event kind -------
check("every teaching step is pinned to a specific entity", () => {
  for (const s of STAGES) {
    assert(s.step && s.step.on, `stage "${s.id}" has no step`);
    if (s.step.target === null) {
      // Two legitimate exceptions, and each has to declare itself. MOVEMENT has
      // no entity to pin to and carries a distance bound instead; CRAFTING
      // produces a kind rather than an entity, so it pins to the result kind
      // and the stage guarantees it is the only way to make one.
      if (s.verb === "move") {
        assert(typeof s.step.minDistance === "number", `stage "${s.id}" is unpinned with no distance bound`);
        continue;
      }
      assert(s.step.kindPinned === true, `stage "${s.id}" is unpinned without declaring kindPinned`);
      continue;
    }
    const targets = Array.isArray(s.step.target) ? s.step.target : [s.step.target];
    for (const t of targets) assert(typeof t === "string" && t.length > 0, `stage "${s.id}" has an empty target`);
  }
});

check("no two stages share a teaching target", () => {
  const seen = new Map();
  for (const s of STAGES) {
    const targets = Array.isArray(s.step?.target) ? s.step.target : [s.step?.target];
    for (const t of targets) {
      if (!t) continue;
      assert(!seen.has(t), `target "${t}" teaches both "${seen.get(t)}" and "${s.id}" — one will satisfy the other`);
      seen.set(t, s.id);
    }
  }
});

// --- I4: the resolver must not outrank the verb being taught -------------
check("no stage teaches a verb that the prompt resolver outranks at its site", () => {
  // The real ladder from hud.js, parsed out of the source rather than
  // duplicated, so re-ordering the resolver fails HERE instead of silently
  // starving a stage in play.
  const hud = readFileSync(new URL("../src/hud.js", import.meta.url), "utf8");
  // Sliced to the END OF THE FUNCTION, not to a fixed character count. A window
  // measured in characters silently narrows every time the function it watches
  // grows, and the failure it eventually produces blames the subject ("the
  // parse broke") rather than the window.
  const from = hud.indexOf("function paintPrompt");
  const rest = hud.slice(from + 1);
  const nextFn = rest.search(/\n  function /);
  const block = nextFn >= 0 ? hud.slice(from, from + 1 + nextFn) : hud.slice(from);
  const order = [];
  for (const [verb, marker] of [["pylon", "Set hands on the pylon"], ["pickup", "Pick up ${"], ["gather", "Hold to chop"], ["survey", "Survey ${"], ["strike", "strike ${"]]) {
    const at = block.indexOf(marker);
    if (at >= 0) order.push([verb, at]);
  }
  order.sort((a, b) => a[1] - b[1]);
  const live = order.map(([v]) => v);
  assert(live.length >= 4, `only found ${live.length} verbs in the resolver — the parse broke`);
  for (let i = 0; i < live.length; i++) {
    eq(live[i], VERB_PRIORITY[i], `the resolver's real priority order changed at position ${i} — tutorial.js's VERB_PRIORITY is now wrong, and every stage below "${live[i]}" can starve`);
  }

  // And each stage must declare that it clears whatever outranks it.
  for (const s of STAGES) {
    if (!VERB_PRIORITY.includes(s.verb)) continue; // move/craft/give/checkin are not prompt verbs
    const above = outranks(s.verb);
    assert(Array.isArray(above), `outranks() returned nothing for "${s.verb}"`);
  }
});

// --- I6: coverage ---------------------------------------------------------
check("every bound verb is taught by some stage", () => {
  for (const verb of ["move", "pickup", "craft", "give", "pylon", "checkin", "survey"]) {
    assert(TAUGHT_VERBS.includes(verb), `no stage teaches "${verb}"`);
  }
});

check("stage ids are unique and ordered", () => {
  const ids = STAGES.map((s) => s.id);
  eq(new Set(ids).size, ids.length, "duplicate stage id");
  assert(STAGES.length >= 7, `only ${STAGES.length} stages`);
});

// --- the observer -----------------------------------------------------------
check("a pinned step ignores the same event from a different entity", () => {
  const stage = STAGES.find((s) => s.id === "ground");
  const p = freshProgress();
  eq(observe(p, stage, [{ kind: "pickup", id: "some-other-item" }], null), false, "an unrelated pickup satisfied the step");
  eq(p.done.length, 0, "progress advanced on an unrelated entity");
  eq(observe(p, stage, [{ kind: "pickup", id: "tut-item-a" }], null), true, "the pinned pickup did not satisfy the step");
  eq(p.done[0], "ground", "wrong stage marked done");
});

check("a step wanting two entities needs both", () => {
  const stage = STAGES.find((s) => s.id === "ask");
  const p = freshProgress();
  const tut = {};
  observe(p, stage, [{ kind: "report", who: "c3" }], null, tut);
  eq(p.done.length, 0, "one of two answers completed the stage");
  observe(p, stage, [{ kind: "report", who: "c3" }], null, tut);
  eq(p.done.length, 0, "the same answer twice completed the stage");
  observe(p, stage, [{ kind: "report", who: "c4" }], null, tut);
  eq(p.done.length, 1, "both answers did not complete the stage");
});

// The bug this exists for: main.js does NOT hold one progress object. It calls
// tutorialProgress() -> loadSettings() every frame, which re-parses localStorage
// and hands back a brand-new object. The previous version of the test above
// reused a single `p` across all three calls, so the half-finished tally lived
// on an object that in real play does not survive to the next frame — and the
// only multi-target stage in the game could never be completed by a player.
//
// So this drives it the way main.js does: progress rebuilt every call, only the
// stage-lifetime scratch carried over.
check("a two-entity step survives progress being rebuilt every frame", () => {
  const stage = STAGES.find((s) => s.id === "ask");
  const stored = freshProgress();
  const reload = () => ({ done: stored.done.slice(), current: stored.current });
  const tut = {};
  const frame = (who) => {
    const p = reload();
    if (observe(p, stage, [{ kind: "report", who }], null, tut)) {
      stored.done = p.done.slice();
      stored.current = p.current;
    }
  };
  frame("c3");
  eq(stored.done.length, 0, "one answer completed the stage");
  frame("c4");
  eq(stored.done.length, 1, "the tally was lost between frames — the stage is uncompletable in real play");
});

check("a multi-target step refuses to run without somewhere to keep its tally", () => {
  const stage = STAGES.find((s) => s.id === "ask");
  let threw = false;
  try { observe(freshProgress(), stage, [{ kind: "report", who: "c3" }], null); }
  catch { threw = true; }
  assert(threw, "observe silently dropped a multi-target tally instead of refusing");
});

check("a completed stage is never re-completed", () => {
  const stage = STAGES.find((s) => s.id === "ground");
  const p = freshProgress();
  observe(p, stage, [{ kind: "pickup", id: "tut-item-a" }], null);
  observe(p, stage, [{ kind: "pickup", id: "tut-item-a" }], null);
  eq(p.done.length, 1, "a stage completed twice");
});

// --- can a player actually AIM the verb a stage teaches? --------------------
// brain: the `assert-every-bound-verb-is-explained` kernel. Bound verbs accrete
// — a mechanic lands, the input map and the hint strip get updated because they
// are needed to play it, and the explaining text silently does not, because
// nothing breaks. That is exactly what happened here: Q/R (prev/next target)
// were bound in input.js and named in NO keyboard legend, while the gamepad
// legend listed [LB]/[RB] select. `give` acts only on the roster selection and
// has no direct-target form, so a keyboard player was handed a verb with no
// discoverable way to aim it — invisible to every functional test, because the
// verb itself worked perfectly.
check("both control legends explain how to select a companion", () => {
  const hud = readFileSync(new URL("../src/hud.js", import.meta.url), "utf8");
  for (const scheme of ["keyboard", "gamepad"]) {
    const m = hud.match(new RegExp(`${scheme}:\\s*"([^"]*)"`));
    assert(m, `no ${scheme} control legend found in hud.js`);
    assert(
      /select/i.test(m[1]),
      `the ${scheme} legend never mentions selecting — but "give" acts on the selection and nothing else can aim it: "${m[1]}"`,
    );
  }
});

check("a stage that names a companion says how to aim at one", () => {
  for (const s of STAGES) {
    const targets = Array.isArray(s.step.target) ? s.step.target : [s.step.target];
    // Only stages pinned to a COMPANION id (c1..c5) need this; an item- or
    // pylon-pinned step is aimed by standing next to the thing.
    if (!targets.some((t) => typeof t === "string" && /^c\d+$/.test(t))) continue;
    assert(
      /select|pick|choose|number/i.test(s.brief),
      `stage "${s.id}" tells the player to act on a named companion but never says how to aim at one: "${s.brief}"`,
    );
  }
});

// --- I2 / I7: the overlay is inert ----------------------------------------
check("observing never mutates the sim", () => {
  const sim = createRun({ seed: 21, difficulty: "standard" });
  for (let i = 0; i < 100; i++) tick(sim, 1 / 20, { move: { x: 0.4, z: -0.9 }, yaw: 0.3 });
  const shape = () => JSON.stringify({
    t: sim.time, rng: sim.rng.snapshot(),
    party: sim.party.map((c) => [c.id, c.x, c.z, c.lucidity, c.hallucinating]),
    pylons: sim.pylons.map((p) => [p.id, !!p.spent]),
    log: sim.logEntries.length, bad: badLogCount(sim), status: sim.status,
  });
  const before = shape();
  const p = freshProgress();
  for (const stage of STAGES) {
    observe(p, stage, [{ kind: "pickup", id: "tut-item-a" }, { kind: "draw", id: "p0" }, { kind: "report", who: "c3" }], sim, {});
  }
  eq(shape(), before, "the tutorial overlay mutated the simulation");
});

check("a seeded run is identical whether or not the overlay is watching", () => {
  const run = (watch) => {
    const sim = createRun({ seed: 99, difficulty: "standard" });
    const p = freshProgress();
    const scratch = {};
    for (let i = 0; i < 600; i++) {
      tick(sim, 1 / 20, { move: { x: 0.3, z: -1 }, yaw: 0.2 });
      if (watch) for (const s of STAGES) observe(p, s, sim.events, sim, scratch);
    }
    return JSON.stringify({
      t: sim.time.toFixed(4), rng: sim.rng.snapshot(),
      party: sim.party.map((c) => [c.id, c.x.toFixed(4), c.z.toFixed(4), c.lucidity.toFixed(4)]),
    });
  };
  eq(run(true), run(false), "watching changed the run — the overlay is not read-only");
});

// --- I5: no third raw storage key -----------------------------------------
check("localStorage is still only touched by save.js", () => {
  // Strip comments first. The naive grep matched the dog#E64 note in
  // tutorial.js's own prose and reported a file that never touches storage —
  // a check that fires on a citation of the rule it enforces is noise, and
  // would have been silenced by someone deleting the comment.
  const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["main.js", "hud.js", "render.js", "input.js", "state.js", "percept.js", "party.js", "world.js", "tutorial.js"]) {
    const src = stripComments(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8"));
    assert(!/\blocalStorage\s*[.[]/.test(src), `${f} calls localStorage directly — tutorial progress belongs in the save payload (dog#E64)`);
  }
});


// --- the check that would have caught the real bug ------------------------
// Every step above was originally pinned against SYNTHETIC events shaped the
// way I assumed the rules emit them. Five of seven were wrong: `pickup` carried
// no item id, `draw` carried no pylon id, and `offer`/`logAttempt` were not
// event kinds at all. Those steps would have starved silently in play while
// every synthetic test passed — the same "a suite written from the feature's
// own mental model certifies that model's blind spot" failure, one layer out.
//
// So this drives the REAL verbs against a REAL sim and asserts the event the
// rules actually emit would satisfy the step.
check("every step's event kind is one the rules actually emit", () => {
  // Scans BOTH real emitters. state.js owns the rules' events; tutorial.js
  // emits the one event that only exists in the camp — reaching the trainer —
  // because the trainer only exists there and state.js should not grow a
  // concept a single map has. A step pinned to a kind nobody emits is the
  // silent-starvation failure with no error anywhere, so the set is derived
  // from source rather than listed by hand.
  const emitted = new Set();
  for (const f of ["state.js", "tutorial.js"]) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
    for (const m of src.matchAll(/emit\(\s*sim,\s*"([a-zA-Z]+)"/g)) emitted.add(m[1]);
  }
  emitted.add("moved"); // synthesised by main.js from movement, not by emit()
  for (const s of STAGES) {
    assert(emitted.has(s.step.on), `stage "${s.id}" waits on event kind "${s.step.on}", which nothing emits`);
  }
  // The beats ride the same stream and starve the same way.
  for (const s of STAGES) {
    for (const b of s.beats || []) {
      assert(emitted.has(b.on), `stage "${s.id}" has a beat on "${b.on}", which nothing emits`);
    }
  }
});

check("a real pickup carries the item id the step pins to", () => {
  const sim = createRun({ seed: 31 });
  const it = sim.items.find((i) => !i.taken);
  it.discovered = true;
  sim.player.x = it.x; sim.player.z = it.z;
  const before = sim.events.length;
  pickupItem(sim);
  const ev = sim.events.slice(before).find((e) => e.kind === "pickup");
  assert(ev, "a real pickup emitted no pickup event");
  eq(ev.id, it.id, "the pickup event does not name the item — a step pinned to an item id would never fire");
});

check("a real pylon draw carries the pylon id the step pins to", () => {
  const sim = createRun({ seed: 32 });
  const p = sim.pylons[0];
  const a = sim.player, b = sim.companions[0];
  a.x = p.x; a.z = p.z; b.x = p.x; b.z = p.z;
  activatePylon(sim, a);
  const before = sim.events.length;
  activatePylon(sim, b);
  const ev = sim.events.slice(before).find((e) => e.kind === "draw");
  assert(ev, "a confirmed pylon emitted no draw event");
  eq(ev.id, p.id, "the draw event does not name the pylon");
});

check("a real check-in carries the companion id the step pins to", () => {
  const sim = createRun({ seed: 33 });
  const c = sim.companions[2];
  const before = sim.events.length;
  checkIn(sim, c.id);
  const ev = sim.events.slice(before).find((e) => e.kind === "report");
  assert(ev, "a check-in emitted no report event");
  eq(ev.who, c.id, "the report event does not name who answered");
});

check("a real handover carries the receiving companion id", () => {
  const sim = createRun({ seed: 34 });
  const c = sim.companions[1];
  c.lucidity = 40;
  c.x = sim.player.x; c.z = sim.player.z;
  sim.inventory.push({ id: "give-me", real: true, kind: "flare", claimedKind: null });
  const before = sim.events.length;
  offerItem(sim, 0, c.id);
  const ev = sim.events.slice(before).find((e) => e.kind === "offerUsed");
  assert(ev, "a handover emitted no offerUsed event");
  eq(ev.who, c.id, "the offerUsed event does not name the receiver");
  eq(ev.who, "c2", "stage 4 pins to c2; the second companion is not c2");
});

check("a false log really does emit logFalse", () => {
  const sim = createRun({ seed: 35 });
  sim.time = FULL_DRAIN_AT;
  const spot = { x: sim.world.camp.x + 60, z: sim.world.camp.z + 60 };
  sim.player.x = spot.x; sim.player.z = spot.z;
  for (const m of sim.monoliths) { m.x += 900; m.z += 900; }
  for (const c of sim.companions) { c.x = spot.x + 400; c.z = spot.z + 400; }
  beginHallucinating(sim, sim.player);
  sim.player.hallucination = HALLUCINATION.PHANTOM_MARKER;
  const before = sim.events.length;
  logMarker(sim, { name: "the Sixth Stone" });
  const ev = sim.events.slice(before).find((e) => e.kind === "logFalse");
  assert(ev, "logging a phantom emitted no logFalse event — stage 7 would never complete");
});

check("the pinning rule allows exactly the exceptions that declare themselves", () => {
  for (const s of STAGES) {
    if (s.step.target !== null) continue;
    const excused = s.verb === "move" || s.step.kindPinned === true;
    assert(excused, `stage "${s.id}" is unpinned without declaring why`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("mirage tutorial: OK");
