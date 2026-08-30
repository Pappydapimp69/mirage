// save.js — persist a run so the basin is still there tomorrow.
//
// The world itself is NOT saved: it is a pure function of the seed
// (world.js/generateWorld), so a resume regenerates it identically and this
// file only carries the MUTABLE delta — who is where, what has been logged,
// what has been taken, and how far gone everybody is.
//
// Two rules from earlier projects shape this file (Brain retrieval, see the
// comments at each site):
//
//   * The rng is restored from its RAW STATE WORD, not by replaying draws
//     (the-game-prologue#E1). Restoring the word is O(1) and exact; replaying
//     is O(N) and silently forks the moment any code path's draw count moves.
//
//   * A resume rebuilds through the REAL constructor (createRun) and then
//     applies the snapshot over it — never a half-built world from partial
//     options (dbh#E4, wrong-sky#E2). And an ended run is never saved, so a
//     "Resume" can't drop you back onto the frame you already lost.

import { createRun } from "./state.js?v=mirage-0.13.1";
import { buildCamp, CAMP_SEED } from "./camp.js?v=mirage-0.13.1";

export const SAVE_KEY = "mirage:run";
// Bumped whenever the shape below changes incompatibly. A save from an older
// schema is discarded rather than half-read: a partially-applied snapshot is
// far worse than starting fresh, because it looks like it worked.
//
// v2: `stats` gained falseCrafts/phantomsRevealed for the crafting deception.
// Stats are restored by spread, so a v1 snapshot would come back MISSING those
// two keys, and the first `sim.stats.falseCrafts += 1` would write NaN — which
// then rides silently into the debrief. Adding a counter to a serialised bag of
// counters is a schema change even though nothing was renamed or removed.
// v4: the camp is a world, not a seed. The camp's map cannot be regenerated
// from a seed — it is authored — so a save taken on it now rebuilds through
// buildCamp(). Before this, resuming a camp run silently handed the player a
// BASIN generated from the sentinel seed, with their camp positions pasted onto
// it. The tutorial autosaves every five seconds, so any player who quit part
// way through the walk in and pressed Resume got that.
//
// v3: cohesion. Following was replaced by a chain, a periodic ping and a CALL
// verb, all of which keep per-character deadlines (wanderUntil, pingAt/Until,
// summonBy/Until, the two call cadences). `wanderUntil` gates three rng draws,
// so a v2 snapshot restored without it re-rolls on a different tick and the
// resumed run silently forks — which is precisely how the divergence test
// caught it.
export const SAVE_VERSION = 4;

const store = () => (typeof localStorage === "undefined" ? null : localStorage);

/** Per-character mutable state. Traits ride along so a resumed party keeps its personalities. */
function packCharacter(c) {
  return {
    id: c.id,
    x: c.x, z: c.z, yaw: c.yaw,
    // The lead's smoothed direction of travel, which anchors the whole party's
    // formation (see updateLeadHeading in state.js). Derived, but NOT free to
    // drop: resuming without it re-anchors the formation to the resumed yaw, the
    // party walks somewhere slightly different, and a companion who reaches a
    // pylon a tick sooner shifts every subsequent rng draw. A resumed run has to
    // be the SAME run, not a similar one.
    heading: c.heading,
    lucidity: c.lucidity,
    hallucinating: c.hallucinating,
    hallucination: c.hallucination,
    scars: c.scars,
    recoverProgress: c.recoverProgress,
    goneTime: c.goneTime,
    steadyUntil: c.steadyUntil,
    lensUntil: c.lensUntil,
    givenUpPylons: c.givenUpPylons,
    pylonWaitFor: c.pylonWaitFor,
    pylonWaitUntil: c.pylonWaitUntil,
    decayPausedUntil: c.decayPausedUntil,
    microUntil: c.microUntil,
    microCooldownUntil: c.microCooldownUntil,
    vouchUntil: c.vouchUntil,
    // Rolled once per campaign — must survive or a resumed party reshuffles
    // its personalities, and every behavioural tell the player has learned to
    // read (who breaks early, who lags, who talks) silently changes hands.
    drain: c.drain, stoic: c.stoic, chatty: c.chatty, wander: c.wander, selfCare: c.selfCare,
    aliveTime: c.aliveTime,
    goalKind: c.goalKind,
    // `label` rides along: a hallucinated goal carries the NAME of the marker a
    // gone mind believes it is walking to, and dropping it changed what they
    // said they were doing.
    goal: c.goal ? { x: c.goal.x, z: c.goal.z, label: c.goal.label ?? null } : null,
    fetchItemId: c.fetchItemId ?? null,
    // These three are THROTTLE COUNTDOWNS, and dropping them was a real bug
    // the divergence test caught: they decide WHICH TICK chatter and
    // repathing fire on, both of which draw from sim.rng. Restoring a run
    // with them reset produced byte-identical positions and meters — and a
    // silently different rng stream position, which only surfaces minutes
    // later as a different basin. Anything that gates an rng draw is save
    // state, however cosmetic the thing it gates looks.
    remarkCooldown: c.remarkCooldown ?? 0,
    repathTimer: c.repathTimer ?? 0,
    facing: c.facing ?? 0,
    // Cohesion state. Same rule as the throttle countdowns above, and it broke
    // the divergence test the same way: `wanderUntil` decides WHICH TICK a
    // companion draws three rng values to pick somewhere new to stroll, so a
    // resume with it reset re-rolls on a different tick and every other mind
    // sharing that tick shifts. The call cadences and the ping deadlines gate
    // movement rather than draws, but they decide where somebody IS, which
    // decides what they encounter, which decides everything downstream.
    wanderGoal: c.wanderGoal ? { x: c.wanderGoal.x, z: c.wanderGoal.z } : null,
    wanderUntil: c.wanderUntil ?? 0,
    pingAt: c.pingAt ?? 0,
    pingUntil: c.pingUntil ?? 0,
    summonBy: c.summonBy ?? null,
    summonUntil: c.summonUntil ?? 0,
    answerReadyAt: c.answerReadyAt ?? 0,
    callReadyAt: c.callReadyAt ?? 0,
    // Two latches that were never saved and never noticed, because until
    // cohesion they were only ever set on paths a resumed run happened to
    // re-enter immediately. `goneAnnounced` is the load-bearing one: it gates
    // `remarkCooldown = 0`, which gates an rng draw.
    goneAnnounced: !!c.goneAnnounced,
    wasAway: c.wasAway ?? null,
    // THE LOST-DRIFT STATE. `lostSince` is the worst offender this file has
    // held: the dwell test is `sim.time - c.lostSince < LOST_DWELL`, and with
    // it dropped that reads `sim.time - undefined`, which is NaN, and NaN < x
    // is false — so a resumed hallucinating mind skipped its entire dwell,
    // took a different branch, and drew a different number of rng values. A
    // missing number that silently becomes NaN does not throw and does not
    // fail a round-trip check; it just quietly changes what happens next.
    lostSince: c.lostSince ?? null,
    lostStallUntil: c.lostStallUntil ?? 0,
    // Only used to keep a gone mind from repeating itself, but it changes
    // which line `pick` lands on, so two runs disagree about what was said.
    lastGoneLine: c.lastGoneLine ?? null,
    // Saved rather than recomputed for the same reason: a null path re-paths
    // on a different tick than a live one, which moves the draws again.
    // GRID CELLS (cx, cz), not world coordinates. This mapped x/z for a while,
    // which silently wrote {x: undefined, z: undefined} for every node: on
    // resume, stepToward aimed at cellToWorld(undefined, undefined) = NaN, the
    // move came out NaN, collision refused it, and the companion stood wedged
    // until the next repath. It never threw and it never failed a round-trip
    // check, because both sides agreed on the same corrupted array.
    path: c.path ? c.path.map((n) => ({ cx: n.cx, cz: n.cz })) : null,
    inventory: c.inventory ? c.inventory.map((s) => ({ ...s })) : [],
    known: c.known
      ? { pylons: [...c.known.pylons], monoliths: [...c.known.monoliths] }
      : null,
  };
}

function applyCharacter(c, s) {
  c.x = s.x; c.z = s.z; c.yaw = s.yaw;
  if (typeof s.heading === "number") c.heading = s.heading;
  c.lucidity = s.lucidity;
  c.hallucinating = s.hallucinating;
  c.hallucination = s.hallucination;
  c.scars = s.scars;
  c.recoverProgress = s.recoverProgress;
  c.goneTime = s.goneTime;
  c.steadyUntil = s.steadyUntil;
  c.lensUntil = s.lensUntil;
  c.givenUpPylons = s.givenUpPylons || {};
  c.pylonWaitFor = s.pylonWaitFor ?? null;
  c.pylonWaitUntil = s.pylonWaitUntil ?? 0;
  c.decayPausedUntil = s.decayPausedUntil || 0;
  c.microUntil = s.microUntil || 0;
  c.microCooldownUntil = s.microCooldownUntil || 0;
  c.vouchUntil = s.vouchUntil || 0;
  // `goalKind` and `goal` are NOT companion-only. A hallucinating LEAD is
  // driven by the same lost-drift code as a companion — they get a goalKind of
  // "hallucinating" and a drift goal — and leaving them out of the restore
  // meant a resumed lead re-entered that branch from scratch and drew three
  // fresh rng values the original had already spent. Every other mind sharing
  // that tick then shifted, and the run forked. They were inside the
  // !isPlayer guard because they were assumed to be party-AI state; they are
  // hallucination state, which the lead very much has.
  c.goalKind = s.goalKind;
  c.goal = s.goal ? { x: s.goal.x, z: s.goal.z, label: s.goal.label ?? null } : null;
  // Same reasoning as goalKind: the lead hallucinates too, so the lost-drift
  // clock is not companion-only state.
  c.lostSince = s.lostSince ?? null;
  c.lostStallUntil = s.lostStallUntil ?? 0;
  if (!c.isPlayer) {
    c.drain = s.drain; c.stoic = s.stoic; c.chatty = s.chatty;
    c.wander = s.wander; c.selfCare = s.selfCare;
    c.aliveTime = s.aliveTime;
    c.fetchItemId = s.fetchItemId ?? null;
    c.inventory = s.inventory ? s.inventory.map((slot) => ({ ...slot })) : [];
    if (s.known) c.known = { pylons: new Set(s.known.pylons), monoliths: new Set(s.known.monoliths) };
    c.remarkCooldown = s.remarkCooldown ?? 0;
    c.repathTimer = s.repathTimer ?? 0;
    c.facing = s.facing ?? 0;
    c.path = s.path ? s.path.map((n) => ({ cx: n.cx, cz: n.cz })) : null;
    c.wanderGoal = s.wanderGoal ? { x: s.wanderGoal.x, z: s.wanderGoal.z } : null;
    c.wanderUntil = s.wanderUntil ?? 0;
    c.pingAt = s.pingAt ?? 0;
    c.pingUntil = s.pingUntil ?? 0;
    c.summonBy = s.summonBy ?? null;
    c.summonUntil = s.summonUntil ?? 0;
    c.answerReadyAt = s.answerReadyAt ?? 0;
    c.goneAnnounced = !!s.goneAnnounced;
    c.wasAway = s.wasAway ?? null;
    c.lastGoneLine = s.lastGoneLine ?? null;
  }
  // The lead calls; companions answer. `callReadyAt` is therefore the ONLY one
  // of these that belongs to the player too, and it sits outside the
  // !isPlayer guard for that reason.
  c.callReadyAt = s.callReadyAt ?? 0;
}

/** Flags for world features, keyed by id — positions come back from the seed. */
const packFlags = (arr, keys) =>
  arr.map((o) => {
    const out = { id: o.id };
    for (const k of keys) out[k] = o[k];
    return out;
  });

function applyFlags(arr, saved, keys) {
  if (!saved) return;
  const byId = new Map(saved.map((s) => [s.id, s]));
  for (const o of arr) {
    const s = byId.get(o.id);
    if (!s) continue;
    for (const k of keys) o[k] = s[k];
  }
}

/** A JSON-safe snapshot of everything a resume needs. */
export function serializeRun(sim) {
  return {
    v: SAVE_VERSION,
    savedAt: null, // stamped by saveRun — the sim itself never reads a clock
    seed: sim.seed,
    difficulty: sim.difficulty,
    level: sim.level,
    campaignLength: sim.campaignLength,
    time: sim.time,
    status: sim.status,
    // The generator's raw state word (see rng.js snapshot/restore).
    rng: sim.rng.snapshot(),
    party: sim.party.map(packCharacter),
    // Saved WHOLE, not as flags: a planted Stake appends a pylon that exists
    // in no seed-generated world, so rebuilding from world.pylons alone would
    // silently un-plant it.
    // `spent` is the pylon's whole state now — charge is vestigial — and the
    // prime is live coordination in flight: two people have to act inside
    // PRIME_WINDOW, so a resume that forgot who had already set hands on what
    // would silently cancel a confirmation the players had already made.
    pylons: sim.pylons.map((p) => ({
      id: p.id, x: p.x, z: p.z,
      spent: !!p.spent, primedBy: p.primedBy || [], primedAt: p.primedAt ?? -1e9,
    })),
    monoliths: packFlags(sim.monoliths, ["logged", "discovered", "foundBy"]),
    items: packFlags(sim.items, ["discovered", "taken"]),
    trees: packFlags(sim.trees, ["discovered", "chopped"]),
    stones: packFlags(sim.stones, ["discovered", "mined"]),
    inventory: sim.inventory.map((s) => ({ ...s })),
    wood: sim.wood,
    stone: sim.stone,
    slotSeq: sim.slotSeq,
    doses: sim.doses,
    logEntries: sim.logEntries.map((e) => ({ ...e })),
    stats: { ...sim.stats },
    dissolveTimer: sim.dissolveTimer,
    gatherHold: { ...sim.gatherHold },
    // Same class of field as the per-companion countdowns above: sightTimer
    // gates discover(), which draws from sim.rng, so leaving it out silently
    // re-phases every sighting roll after a resume.
    sightTimer: sim.sightTimer ?? 0,
    lastDt: sim.lastDt ?? 0,
    // Camp-only flags. Not cosmetic: `noDrain` decides whether a whole class of
    // per-tick rng draws happens at all, and the other three decide which verbs
    // the prompt resolver will even offer.
    noDrain: !!sim.noDrain,
    canClearMoss: !!sim.canClearMoss,
    callUnlocked: sim.callUnlocked !== false,
    reachedTrainer: !!sim.reachedTrainer,
  };
}

/**
 * Rebuild a sim from a snapshot. Goes through the real createRun first so the
 * world, the party objects and every default are constructed exactly as a
 * fresh run would build them, THEN overlays the saved delta — rather than
 * hand-assembling a sim that only resembles one (Brain: dbh#E4, wrong-sky#E2).
 */
export function deserializeRun(data) {
  if (!data || data.v !== SAVE_VERSION) return null;
  // THE CAMP IS NOT A SEED. Every basin is a pure function of its seed and
  // regenerates exactly; the camp is hand-placed and regenerates as nothing at
  // all. Passing the sentinel through to generateWorld produced a perfectly
  // valid BASIN and pasted the saved camp positions onto it — no error, no
  // warning, just a resume into somewhere the player had never been. The seed
  // is the routing key because it is already in every payload at every version,
  // which is exactly what camp.js said the sentinel was for.
  const camp = data.seed === CAMP_SEED;
  const world = camp ? buildCamp() : null;
  const sim = createRun({
    seed: data.seed,
    difficulty: data.difficulty,
    level: data.level,
    campaignLength: data.campaignLength,
    world,
  });
  if (camp) {
    sim.trainer = world.trainer;
    sim.noDrain = !!data.noDrain;
    sim.canClearMoss = !!data.canClearMoss;
    sim.callUnlocked = data.callUnlocked !== false;
    sim.reachedTrainer = !!data.reachedTrainer;
  }

  const byId = new Map(sim.party.map((c) => [c.id, c]));
  for (const s of data.party) {
    const c = byId.get(s.id);
    if (c) applyCharacter(c, s);
  }

  // Replace wholesale (a Stake may have added one that no seed produces).
  sim.pylons.length = 0;
  // Tolerate saves written before `spent` existed, where a flat pylon was one
  // with no charge left.
  for (const p of data.pylons) {
    sim.pylons.push({ ...p, spent: p.spent ?? (p.charge !== undefined ? p.charge <= 0 : false) });
  }

  applyFlags(sim.monoliths, data.monoliths, ["logged", "discovered", "foundBy"]);
  applyFlags(sim.items, data.items, ["discovered", "taken"]);
  applyFlags(sim.trees, data.trees, ["discovered", "chopped"]);
  applyFlags(sim.stones, data.stones, ["discovered", "mined"]);

  sim.inventory = data.inventory.map((s) => ({ ...s }));
  sim.wood = data.wood;
  sim.stone = data.stone;
  sim.slotSeq = data.slotSeq;
  sim.doses = data.doses;
  sim.logEntries = data.logEntries.map((e) => ({ ...e }));
  sim.stats = { ...data.stats };
  sim.dissolveTimer = data.dissolveTimer;
  sim.gatherHold = { ...data.gatherHold };
  sim.time = data.time;
  sim.status = data.status;
  sim.sightTimer = data.sightTimer ?? 0;
  sim.lastDt = data.lastDt ?? 0;

  // LAST, deliberately: createRun above consumed draws off the fresh stream
  // (traits, world gen). Restoring the word after all of that is what puts the
  // resumed run back on the exact stream position it was saved at.
  sim.rng.restore(data.rng);

  // Couch co-op is intentionally not restored: a resume comes up solo and a
  // second player re-joins with a pad press through the normal join path. The
  // alternative — reviving a slot for a controller that may not be plugged in
  // — is a companion nobody is driving, which reads as a frozen party member
  // rather than a lost slot (Brain: COUCH-MULTIPLAYER/input).
  return sim;
}

/**
 * Write a snapshot. Refuses an ended run outright: saving a lost/won board
 * means "Resume" hands the player back the frame they already lost, which is
 * the exact trap wrong-sky#E2 records (never autosave an ended world).
 */
export function saveRun(sim, now = null) {
  const ls = store();
  if (!ls || !sim || sim.status !== "playing") return false;
  try {
    const data = serializeRun(sim);
    data.savedAt = now;
    ls.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    // A full quota, a private-mode container, a serialisation surprise — none
    // of them are worth killing the frame over. Play continues unsaved.
    return false;
  }
}

export function loadSave() {
  const ls = store();
  if (!ls) return null;
  try {
    const raw = ls.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.v !== SAVE_VERSION) {
      // A stale schema is cleared rather than left to rot: leaving it would
      // keep offering a Resume button that can only ever fail.
      ls.removeItem(SAVE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearSave() {
  const ls = store();
  if (!ls) return;
  try { ls.removeItem(SAVE_KEY); } catch { /* nothing sensible to do */ }
}

export const hasSave = () => loadSave() !== null;

/**
 * A one-line description for the Resume button. Deliberately says nothing
 * about anyone's lucidity — the meters are invisible, and a save slot is not
 * a loophole for showing them.
 */
export function describeSave(data) {
  if (!data) return null;
  const walking = data.party.filter((c) => c.id !== "you").length;
  return {
    level: data.level,
    campaignLength: data.campaignLength,
    difficulty: data.difficulty,
    seed: data.seed,
    minutes: Math.floor(data.time / 60),
    seconds: Math.floor(data.time % 60),
    party: walking,
  };
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
// A SEPARATE key from the run slot, deliberately. Preferences outlive runs:
// finish() clears the run save, and a player who just lost a campaign should
// not also find their volume back at default. Keeping them in one blob would
// tie the lifetime of "how loud is this" to the lifetime of "where was I",
// which are unrelated questions.
export const SETTINGS_KEY = "mirage:settings";

// Tutorial progress lives HERE, in the settings payload, not as its own
// localStorage key — brain: dog#E64, where a "seen once ever" bit kept outside
// the save payload became a cross-slot leak the moment the game grew slots.
// Settings rather than the run payload because progress has to survive
// clearSave(), which every new run calls.
const DEFAULT_SETTINGS = { volume: 0.7, muted: false, difficulty: "standard", coop: "solo", fov: 78, tutorial: { done: [], current: 0 } };

/**
 * A defaults object nobody can corrupt. `{ ...DEFAULT_SETTINGS }` is a SHALLOW
 * copy, so every caller taking the no-key path used to receive the SAME nested
 * `tutorial` object — pushing a completed stage into it mutated the module-level
 * default for the rest of the session, and the next "fresh" load came back
 * already carrying it. Worse, it hid a real bug: mid-stage progress appeared to
 * persist across frames purely because every frame was handed that one aliased
 * object, and stopped the moment a settings key existed to parse instead.
 */
const freshSettings = () => ({ ...DEFAULT_SETTINGS, tutorial: { done: [], current: 0 } });

/** Preferences, with unknown/corrupt values replaced by defaults rather than trusted. */
export function loadSettings() {
  const ls = store();
  if (!ls) return freshSettings();
  try {
    const raw = ls.getItem(SETTINGS_KEY);
    if (!raw) return freshSettings();
    const d = JSON.parse(raw) || {};
    return {
      // Clamped and whitelisted on the way IN: a hand-edited or
      // partially-written localStorage entry should degrade to a playable
      // default, never to a muted game with an out-of-range gain that looks
      // like broken audio.
      volume: typeof d.volume === "number" && d.volume >= 0 && d.volume <= 1 ? d.volume : DEFAULT_SETTINGS.volume,
      muted: typeof d.muted === "boolean" ? d.muted : DEFAULT_SETTINGS.muted,
      difficulty: ["gentle", "standard", "bleak"].includes(d.difficulty) ? d.difficulty : DEFAULT_SETTINGS.difficulty,
      tutorial: {
        done: Array.isArray(d.tutorial?.done) ? d.tutorial.done.filter((x) => typeof x === "string") : [],
        current: Number.isFinite(d.tutorial?.current) ? d.tutorial.current : 0,
      },
      coop: ["solo", "couch"].includes(d.coop) ? d.coop : DEFAULT_SETTINGS.coop,
      fov: typeof d.fov === "number" && d.fov >= 70 && d.fov <= 110 ? d.fov : DEFAULT_SETTINGS.fov,
    };
  } catch {
    return freshSettings();
  }
}

/** Merge and persist. Partial updates are the normal case (one control moved). */
export function saveSettings(patch) {
  const ls = store();
  if (!ls) return false;
  try {
    const next = { ...loadSettings(), ...patch };
    ls.setItem(SETTINGS_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
