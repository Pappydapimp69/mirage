// tutorial.js — the walk in.
//
// Seven short stages that teach one verb each and, between them, teach the
// thing the verbs are for: that what you are shown and what you are told are
// both claims. Pure logic; no DOM, no Three.
//
// SHAPE (brain: the-game-prologue#E15). This is a passive OBSERVER over the
// events real play already emits, not a tutorial mode with its own sandbox,
// locked inputs or intercepted commands. The player is playing the real game
// from the first frame; the overlay only notices. There is no duplicate
// "tutorial version" of any verb and no mode to exit, so a verb cannot behave
// one way here and another way afterwards.
//
// The tradeoff that shape imposes, taken deliberately: because the teaching
// steps ride the SAME event stream as ordinary play, every step must be pinned
// NARROWLY — to a specific entity id, never to a bare event kind — or ordinary
// play satisfies a teaching step by accident. That discipline is permanent, and
// `tests/tutorial.mjs` enforces it rather than trusting the authoring.

/**
 * A stage is a POST-PROCESS over a normally generated world, never bespoke
 * geometry. `generateWorld` takes a seed and nothing else, and everything that
 * guarantees a basin is walkable — reachability, spire placement, the camp —
 * lives inside it. Authoring terrain by hand would mean re-earning all of that;
 * pruning and repositioning entities in an already-valid world earns it for
 * free.
 *
 * `verb` is what the stage teaches. `clears` names the higher-priority verbs
 * whose targets must be removed from the teaching site — see the note on
 * starvation below.
 */

// The single-action prompt resolver in hud.js answers exactly one question:
// what can happen right now. Its priority order is
//
//     pylon -> pickup -> gather -> survey -> strike
//
// which means a teaching step is silently unreachable if anything ABOVE its
// verb is simultaneously valid where the player is standing. A step pinned to
// "survey this marker" never fires while an item lies in reach; a step pinned
// to "pick this up" never fires inside a pylon radius. Neither system errors —
// the prompt simply shows something else forever.
//
// (brain: sandbox-resolver-starves-tutorial#E1, and #E2's warning that there is
// one such candidate PER pipeline layer, so an endpoint-only "the input fired"
// check would pass while the tutorial never does.)
export const VERB_PRIORITY = Object.freeze(["pylon", "pickup", "gather", "survey", "strike"]);

/** Verbs that outrank `verb`, i.e. the ones a stage must clear from its site. */
export function outranks(verb) {
  const i = VERB_PRIORITY.indexOf(verb);
  return i <= 0 ? [] : VERB_PRIORITY.slice(0, i);
}

/**
 * THE WALK IN — seven objectives, ONE session, ONE map.
 *
 * These used to be seven separate runs: each `startStage` built a fresh basin,
 * wiped it, placed one thing and tore it down again on completion. Nothing
 * persisted and nowhere was anywhere. Now the player spawns into the camp once
 * and the objectives open in sequence around them, in a place that does not
 * change.
 *
 * `opens` is what the objective makes exist or makes possible. Two different
 * gates, deliberately (brain: wrong-sky#E8):
 *
 *   EXISTENCE-GATED — the items. An item lying on the ground before its
 *   objective is an out-of-order pickup, which is exactly the accident the
 *   pinning discipline exists to prevent. They do not spawn until asked for.
 *
 *   EFFECT-GATED — the pylons. They stand in the camp from the first frame
 *   under moss: findable, rememberable, and inert with a reason you can read.
 *   A player who wanders early meets one and learns where it is, which is worth
 *   more than not meeting it at all.
 */
export const OBJECTIVES = Object.freeze([
  {
    id: "walk-in",
    title: "The walk in",
    verb: "move",
    brief: "You are late. The trainer is waiting at the far end of the path — walk over to him.",
    // A PLACE, not a distance. "Cover 30m" is satisfied by pacing in a circle
    // and teaches nothing; walking the length of the camp to a person who is
    // waiting for you teaches the map and introduces the man in one action.
    step: { id: "reachedTrainer", on: "reachTrainer", target: "trainer" },
    debrief: "Everyone else finished this yesterday. They are around here somewhere.",
  },
  {
    id: "ground",
    title: "What the ground gives",
    verb: "pickup",
    brief: "He has put something down for you. Take it.",
    opens: { items: [{ id: "tut-item-a", kind: "flare", near: "trainer", dx: 3, dz: 2 }] },
    step: { id: "tookItem", on: "pickup", target: "tut-item-a" },
    line: { who: 5, text: "A flare, I think. Good for a dark stretch." },
    debrief: "Everything you know about that flare, you know because someone told you.",
  },
  {
    id: "craft",
    title: "Two things become one",
    verb: "craft",
    brief: "There is a second piece by his feet. Two of those make something better — combine them.",
    opens: { items: [{ id: "tut-item-b", kind: "tether", near: "trainer", dx: -2, dz: 3 }] },
    step: { id: "crafted", on: "craft", targetKind: "ember", target: null, kindPinned: true },
    debrief: "A recipe is a claim about two objects. Hold on to that.",
  },
  {
    id: "hands",
    title: "Hands",
    verb: "give",
    brief: "Pick IREN out on the roster, then hand it to her.",
    step: { id: "gave", on: "offerUsed", target: "c2" },
    debrief: "Things change hands. The person handing one to you believes something about it.",
  },
  {
    id: "pylon",
    title: "The pylon takes two",
    verb: "pylon",
    // TWO BEATS, ONE LESSON. Find the thing under the moss and clear it; then
    // the trainer asks whether you are sure it is really there, and the answer
    // is another pair of eyes. Teaching CALL here rather than in its own
    // objective is the difference between learning a verb and needing one.
    brief: "There is something out here under the moss. Find it and clear it off.",
    opens: { canClearMoss: true },
    step: { id: "firedPylon", on: "draw", target: null, kindPinned: true },
    beats: [
      {
        on: "unmoss",
        say: "TRAINER: A pylon. Or it looks like one. Are you sure it is there? Call someone over and find out.",
        opens: { call: true },
      },
    ],
    debrief: "It only ever fires once, and it always takes two. One pair of hands is a claim.",
  },
  {
    id: "ask",
    title: "Ask them",
    verb: "checkin",
    brief: "Check in on HALDER, then on NKEM. Their numbers are beside their names.",
    step: { id: "askedBoth", on: "report", target: ["c3", "c4"] },
    debrief: "One of them told you what they wanted to be true. An answer is evidence, not fact.",
  },
  {
    id: "first-lie",
    title: "The first lie",
    verb: "survey",
    brief: "Something has gone wrong with the light. There is a marker out there — go and survey it.",
    opens: { leadUnder: true },
    step: { id: "metTheLie", on: "logFalse", target: null, kindPinned: true },
    debrief: "It was never there. Someone standing with you would have said so.",
  },
]);

/** Kept as the old name so nothing downstream has to care that these are objectives now. */
export const STAGES = OBJECTIVES;

/** Every verb a stage teaches, for the coverage assertion. */
export const TAUGHT_VERBS = Object.freeze(STAGES.map((s) => s.verb));

/**
 * A fresh progress record. Lives INSIDE the save payload — never as its own
 * localStorage key.
 *
 * brain: dog#E64. A "seen once ever" bit kept as a raw key outside the save
 * payload becomes a cross-slot leak the moment a game grows more than one slot:
 * finishing the gated content in ANY slot disables it for every future new game
 * in every slot. This repo already keeps two raw keys, so a third would have
 * been the third chance to make that mistake.
 */
export function freshProgress() {
  return { done: [], current: 0 };
}

export const stageById = (id) => STAGES.find((s) => s.id === id) || null;
export const isComplete = (progress) => (progress?.done?.length || 0) >= STAGES.length;

/**
 * Watch one frame's events and mark the active stage's step done.
 *
 * READ-ONLY with respect to `sim`. It never intercepts a command, never
 * rewrites one, and never emits — the simulation runs identically whether or
 * not this is watching, which is what makes a non-tutorial run byte-identical
 * with this module present.
 *
 * `events` MUST be main.js's merged frame stream. `sim.events` alone is not the
 * event stream: `tick()` wipes it on its first line for its own internal emits,
 * so every verb this tutorial teaches — pickup, craft, offer, draw, report —
 * would be invisible to an observer reading it. That is the same silent
 * starvation as the resolver case, one layer further out.
 */
export function observe(progress, stage, events, sim, scratch) {
  if (!progress || !stage || progress.done.includes(stage.id)) return false;
  const want = stage.step;
  for (const ev of events || []) {
    if (ev.kind !== want.on) continue;
    // PINNED. A bare `ev.kind` match is what lets ordinary play tick a teaching
    // step off by accident, so every step names the exact entity it is about.
    if (want.target !== null) {
      const id = ev.id ?? ev.who ?? ev.itemId ?? ev.name;
      const targets = Array.isArray(want.target) ? want.target : [want.target];
      if (!targets.includes(id)) continue;
      // A MULTI-TARGET step spans frames, so the half-finished tally needs a
      // home that outlives one call. It must be `scratch` — an object the
      // CALLER guarantees is the same one next frame — and never `progress`:
      // `progress` comes back from loadSettings(), which re-parses localStorage
      // and rebuilds the object every single frame, so anything written there
      // mid-stage is thrown away before the next event arrives. The only
      // multi-target stage in the tutorial ("ask HALDER, then NKEM") could
      // therefore never complete in real play, while a unit test that reused
      // one `progress` object across calls saw it pass.
      if (Array.isArray(want.target)) {
        if (!scratch) throw new Error(`observe: stage "${stage.id}" is multi-target and needs a scratch object`);
        scratch.seen = scratch.seen || [];
        if (!scratch.seen.includes(id)) scratch.seen.push(id);
        if (scratch.seen.length < want.target.length) continue;
      }
    }
    progress.done.push(stage.id);
    if (scratch) scratch.seen = [];
    return true;
  }
  return false;
}

/**
 * Words that must never reach a player during a stage. The meter is the one
 * fact this game withholds, and a tutorial is exactly where a well-meaning
 * caption leaks it — "your sanity is dropping", "VOSS is hallucinating". Once a
 * player has been told the number exists, every later run is played against it.
 *
 * Checked against every authored string in this file by tests/tutorial.mjs.
 */
export const FORBIDDEN = Object.freeze([
  "lucidity", "sanity", "hallucinat", "meter", "bar", "percent", "%",
  "steady", "unsettled", "fraying", "brittle",
]);

export function leaks(text) {
  const low = String(text || "").toLowerCase();
  return FORBIDDEN.filter((w) => low.includes(w));
}

// ---------------------------------------------------------------------------
// Stage construction
// ---------------------------------------------------------------------------

/**
 * Shape a normally generated basin into one stage.
 *
 * POST-PROCESS, never bespoke geometry: `generateWorld` owns reachability,
 * spire placement and the camp, and re-earning any of that by hand would be a
 * new class of bug for no gain. Everything below only prunes, moves and flags
 * entities in a world that is already known-good.
 *
 * Two rules every stage obeys:
 *
 * 1. CLEAR WHAT OUTRANKS. The prompt resolver surfaces exactly one verb, so
 *    anything above the taught verb must be removed from the teaching site or
 *    the step is unreachable and nothing errors. `siteVerb` below is the same
 *    ladder, and tests/tutorial.mjs asserts it agrees with hud.js's real order.
 * 2. THE CLOCK STAYS OFF. `sim.time` starts at 0, inside the calm window, so no
 *    stage is secretly a race and no meter moves while someone is learning to
 *    press a button. The one stage that needs a mind to go under puts it there
 *    directly rather than by waiting.
 */
export function openObjective(sim, obj) {
  if (!obj || !obj.opens) return sim;
  const o = obj.opens;

  if (o.items) {
    for (const spec of o.items) {
      if (sim.items.some((it) => it.id === spec.id)) continue;
      const anchor = spec.near === "trainer" && sim.trainer ? sim.trainer : sim.player;
      sim.items.push({
        id: spec.id,
        x: anchor.x + (spec.dx || 0),
        z: anchor.z + (spec.dz || 0),
        itemKind: spec.kind,
        discovered: true,
        taken: false,
      });
    }
  }
  if (o.canClearMoss) sim.canClearMoss = true;
  if (o.call) sim.callUnlocked = true;
  if (o.leadUnder) {
    // CLEAR WHAT OUTRANKS THIS VERB. The prompt resolver surfaces exactly one
    // thing, and its order is pylon -> pickup -> gather -> survey -> strike.
    // This objective teaches SURVEY, and the camp is small enough that a
    // phantom seeded 14-30m out routinely lands inside the radius of a pylon
    // or a still-mossed one — and then the press goes to that instead, forever,
    // with nothing erroring. Exactly the starvation VERB_PRIORITY exists to
    // name. The lesson those pylons had to teach is already over, so they are
    // spent and their moss is gone: nothing above `survey` is left in reach.
    for (const p of sim.pylons) { p.spent = true; p.mossed = false; }
    for (const it of sim.items) it.taken = true;

    // The lead goes under here, on purpose, with nobody close enough to refuse
    // the entry. Survivable and reversible: the objective ends the moment the
    // false entry is written, and the camp does not drain anybody, so this is
    // the one and only time a mind slips during the walk in.
    const lead = sim.player;
    lead.lucidity = 0;
    lead.hallucinating = true;
    lead.hallucination = "phantomMarker";
    lead.microUntil = 0;
    for (const c of sim.companions) { c.x = lead.x + 300; c.z = lead.z + 300; }
  }
  return sim;
}

/**
 * Has the lead reached the trainer? Emits once, the first time.
 *
 * The objective is a PLACE, so something has to notice arrival. Kept here
 * rather than in state.js because the trainer only exists in the camp, and
 * state.js should not grow a concept that only one map has.
 */
export const TRAINER_RADIUS = 4.5;
export function checkTrainer(sim, emit) {
  if (!sim.trainer || sim.reachedTrainer) return false;
  if (Math.hypot(sim.player.x - sim.trainer.x, sim.player.z - sim.trainer.z) > TRAINER_RADIUS) return false;
  sim.reachedTrainer = true;
  emit(sim, "reachTrainer", "TRAINER: There you are. Right — from the top.", { id: "trainer" });
  return true;
}

/**
 * Which verb the prompt resolver would surface for `actor` right now.
 *
 * The same ladder as hud.js's `paintPrompt`, expressed over rules primitives so
 * a stage's reachability can be asserted without a DOM. It is not a second
 * source of truth: tests/tutorial.mjs parses the real order out of hud.js and
 * fails if the two ever disagree, which is what makes this safe to rely on.
 */
export function siteVerb(sim, actor, helpers) {
  const { pylonAt, nearestItem, gatherTarget, nearestMarker } = helpers;
  if (pylonAt(sim, actor)) return "pylon";
  if (nearestItem(sim, actor)) return "pickup";
  if (gatherTarget(sim, actor)) return "gather";
  if (nearestMarker(sim, actor)) return "survey";
  return null;
}

/** The line shown while a stage is running. Never names the hidden meter. */
export const objectiveText = (stage) => (stage ? stage.brief : "");
