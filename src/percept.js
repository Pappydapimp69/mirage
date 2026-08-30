// percept.js — the only module in MIRAGE that is allowed to lie.
//
// state.js keeps an honest record of the basin. This file answers a different
// question: what does the LEAD believe is in front of them right now? While the
// player is lucid the two agree exactly. Once the player's meter hits zero, the
// perceived world diverges from the real one — and because the renderer and HUD
// draw from HERE and never from the sim directly, the screen itself becomes an
// unreliable narrator.
//
// Keeping the deceit in one pure module is what makes it testable: a test can
// assert "a hallucinating lead is shown a marker the sim does not contain"
// without booting a browser.

import { HALLUCINATION, BAND, bandOf, ITEM_INFO, LUCIDITY_GRACE, CORROBORATE_RADIUS,
  LINK_RANGE, PING_RANGE,
} from "./state.js?v=mirage-0.13.2";
import { ITEM_KINDS } from "./world.js?v=mirage-0.13.2";

const PHANTOM_NAMES = ["the Sixth Stone", "the Watching Slab", "the Other Cairn", "the Hollow Tooth"];
const PHANTOM_COMPANIONS = ["ODEN", "MARIS", "THE SEVENTH"];

/**
 * `eye` is the character this perception belongs to — the mind whose senses
 * these are. It defaults to null and is resolved to `sim.player` lazily by
 * eyeOf() below, so every existing single-player caller keeps working
 * unchanged. Couch co-op passes a real character: a second human is a
 * possessed companion with their OWN lucidity meter, so they hallucinate
 * independently, and the whole point of the mode is that two players are
 * shown different worlds and have to talk about it.
 */
export function createPercept(eye = null) {
  return {
    eye,
    active: false, // is this percept's OWN mind hallucinating
    kind: null,
    since: 0,
    intensity: 0, // 0..1, ramps in and out so the shift is felt, not flicked
    phantomMonoliths: [],
    phantomCompanions: [],
    phantomPylons: [],
    deadPylonsLookLive: new Set(),
    compassOffset: 0,
    swayPhase: 0,
    whisper: null,
    // Entries this mind believes it has crossed out. A strike attempted while
    // hallucinating is refused by the rules but must LOOK like it worked (see
    // logMarker), so the belief is recorded here and the record is not. Unlike
    // the phantom* fields this deliberately SURVIVES recovery: the false
    // confidence that the record was cleaned is the lasting damage, and coming
    // back to your senses does not hand you a list of what you got wrong.
    believedStruck: new Set(),
    // World-item misidentification, keyed by the item's own id so it stays
    // stable for as long as this hallucination episode lasts (cleared on
    // recovery, same lifetime as the other phantom* fields).
    itemLabels: new Map(),
    // Camera-turn tracking for shiftOneUnseenPhantom: the eye's own yaw last
    // tick (null until the first tick has run) and radians turned since the
    // last drift check.
    lastYaw: null,
    turnAccum: 0,
    // Which real companion (if any) is currently showing as a monster, and
    // when that flicker ends. See updateMonsterFlicker.
    monsterId: null,
    monsterUntil: 0,

    // ---- WRONG_WAY: a compass whose error GROWS while you hold a line -------
    // compassOffset (above) is the value everything else reads. It is now a
    // derived total: the fixed error seeded at onset, plus whatever the walk
    // has added since. See updateCompassDrift.
    compassBase: 0,
    compassDrift: 0,
    headingAnchor: null, // the yaw the current straight leg started on
    walkRun: 0, // units walked on that leg
    stillTime: 0, // seconds since the eye last really moved
    lastX: null,
    lastZ: null,
    compassSnaps: 0, // how many times the needle has settled (tests read this)
    lastSnapAt: -Infinity,
    lastSnapSize: 0, // radians the needle jumped on the last settle

    // ---- FALSE_ANCHOR: relief that keeps its distance ----------------------
    reliefRecedes: 0, // how many times the phantom pylon has backed off

    // ---- CHORUS: agreement that escalates, and answers you didn't ask for --
    chorusVoices: [], // companion ids, shuffled once at onset
    chorusIndex: 0,
    chorusLines: 0,
    chorusLast: -Infinity,

    // ---- DOUBLED_PARTY: the sixth body fills a real gap --------------------
    // Where each companion was standing, relative to the eye's own facing,
    // the last time they were in formation — so the phantom can take a slot
    // that a real person has actually vacated.
    slotMemory: new Map(),
    ghostOf: null, // whose place the phantom is currently holding, if anyone
    ghostSwaps: 0,
  };
}

/**
 * The mind a percept belongs to. Falls back to `sim.player` when no eye was
 * given, which is what keeps every single-player call site (and the whole
 * existing test suite) working without passing an eye through.
 */
function eyeOf(percept, sim) {
  return percept.eye || sim.player;
}

/**
 * Should the world currently be shown straight, regardless of the underlying
 * hallucinating flag? A Lens buys a temporary truth window WITHOUT curing
 * anything — the meter and `hallucinating` stay exactly as they are, only the
 * SCREEN stops lying for a while. Kept separate from `percept.active` itself so
 * the onset/offset edge-detection in updatePercept still tracks the real
 * mechanical state, not the temporary reprieve.
 */
export function isClear(percept, sim) {
  return sim.time < (eyeOf(percept, sim).lensUntil || 0);
}

// Build the specific lie once, at onset, so it is stable while it lasts. A
// hallucination that re-randomises every frame reads as a graphics bug; one that
// holds still reads as a place.
function seedHallucination(percept, sim) {
  const rng = sim.rng;
  const self = eyeOf(percept, sim); // phantoms are placed around THIS mind, not always the lead
  percept.phantomMonoliths = [];
  percept.phantomCompanions = [];
  percept.phantomPylons = [];
  percept.deadPylonsLookLive = new Set();
  percept.compassOffset = 0;
  // Every ACTION-TIED accumulator resets with the episode. A hallucination is
  // a fresh lie each time it lands: the compass starts at its seeded error
  // with nothing banked, the relief has not backed off yet, the chorus has
  // not spoken, and no slot has been taken over.
  percept.compassBase = 0;
  percept.compassDrift = 0;
  percept.headingAnchor = null;
  percept.walkRun = 0;
  percept.stillTime = 0;
  percept.compassSnaps = 0;
  percept.lastSnapAt = -Infinity;
  percept.lastSnapSize = 0;
  percept.reliefRecedes = 0;
  percept.chorusVoices = [];
  percept.chorusIndex = 0;
  percept.chorusLines = 0;
  percept.chorusLast = -Infinity;
  percept.slotMemory = new Map();
  percept.ghostOf = null;
  percept.ghostSwaps = 0;

  switch (percept.kind) {
    case HALLUCINATION.PHANTOM_MARKER: {
      // One or two monoliths that do not exist, placed just off the lead's path
      // so they are found the way a real one would be.
      const n = rng.int(1, 2);
      for (let i = 0; i < n; i++) {
        const a = rng.float(0, Math.PI * 2);
        const r = rng.float(14, 30);
        percept.phantomMonoliths.push({
          id: `ph-m${i}`,
          name: rng.pick(PHANTOM_NAMES),
          x: self.x + Math.cos(a) * r,
          z: self.z + Math.sin(a) * r,
          phantom: true,
        });
      }
      break;
    }
    case HALLUCINATION.DOUBLED_PARTY: {
      // A companion you do not have, walking the formation slot nobody filled.
      percept.phantomCompanions.push({
        id: "ph-c0",
        name: rng.pick(PHANTOM_COMPANIONS),
        role: "—",
        x: self.x - 3,
        z: self.z - 3,
        phantom: true,
        slot: rng.float(0, Math.PI * 2),
      });
      break;
    }
    case HALLUCINATION.FALSE_ANCHOR: {
      // A pylon that isn't, and every spent pylon reading as full. This one is
      // cruel: relief is exactly what you are looking for by the time it lands.
      const a = rng.float(0, Math.PI * 2);
      percept.phantomPylons.push({
        id: "ph-p0",
        x: self.x + Math.cos(a) * rng.float(12, 24),
        z: self.z + Math.sin(a) * rng.float(12, 24),
        phantom: true,
        charge: 100,
      });
      for (const p of sim.pylons) if (p.spent) percept.deadPylonsLookLive.add(p.id);
      break;
    }
    case HALLUCINATION.WRONG_WAY:
      // The error the episode OPENS with. Narrowed from the old 1.1–2.4 band
      // because the error is no longer static: updateCompassDrift adds up to
      // COMPASS.driftMax on top of this while you hold a heading, and the two
      // together have to stay a plausible bearing rather than wrapping past
      // "exactly backwards". 1.15–1.8 rad is a solidly wrong quarter turn
      // (66°–103°) that grows to at most ~178° if you commit to a straight
      // line — starts arguable, ends damning. Same two draws as before.
      percept.compassBase = rng.pick([-1, 1]) * rng.float(1.15, 1.8); // radians
      percept.compassOffset = percept.compassBase;
      break;
    case HALLUCINATION.CHORUS:
      percept.whisper = "agreement";
      // Who speaks, and in what order. Drawn ONCE here (shuffled is a fixed
      // four draws for five companions) so the per-line pick downstream needs
      // no rng at all — chorusEcho fires from the HUD's event pump, which is
      // not a place that should be consuming the sim's stream at all.
      percept.chorusVoices = rng.shuffled(sim.companions.map((c) => c.id));
      break;
    default:
      break;
  }
}

/**
 * Signed angle from `b` to `a`, wrapped to (-π, π]. The building block for
 * "is this bearing currently on screen."
 */
function angularDelta(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Is a point at world-space offset (dx, dz) within `halfAngle` of dead-centre
 * for a head facing `yaw`? Three's camera looks down -Z, so after a yaw
 * rotation θ the forward basis is (-sinθ, -cosθ) (same derivation main.js's
 * own movement-rotation comment uses) — inverted here to recover the bearing
 * a target sits at, then compared against facing.
 */
function inView(yaw, dx, dz, halfAngle) {
  if (dx === 0 && dz === 0) return true;
  const bearing = Math.atan2(-dx, -dz);
  return Math.abs(angularDelta(bearing, yaw)) <= halfAngle;
}

// A camera turn of this many radians (~63°) between checks is what lets one
// unseen phantom drift — see the comment at the call site below for why this
// is gated on TURNING rather than on elapsed time.
const TURN_SHIFT_ANGLE = 1.1;
// Generous vs. the renderer's actual 72° FOV (half = 0.63 rad): near-peripheral
// counts as "seen" too, so nothing visibly pops right at the screen edge.
const VIEW_HALF_ANGLE = 0.85;

/**
 * Nudge ONE currently-unwatched phantom monolith/pylon to a new nearby spot.
 * Never touches anything on screen right now, and never touches sim truth —
 * only percept's own phantom lists. A hallucination that holds still reads as
 * a place (seedHallucination's own rule); this is the exception that proves
 * it: a place can still be wrong about what's behind you.
 */
function shiftOneUnseenPhantom(percept, sim, p) {
  const candidates = [];
  for (const m of percept.phantomMonoliths) if (!inView(p.yaw, m.x - p.x, m.z - p.z, VIEW_HALF_ANGLE)) candidates.push(m);
  for (const ph of percept.phantomPylons) if (!inView(p.yaw, ph.x - p.x, ph.z - p.z, VIEW_HALF_ANGLE)) candidates.push(ph);
  if (!candidates.length) return;
  const rng = sim.rng;
  const target = rng.pick(candidates);
  const a = rng.float(0, Math.PI * 2);
  const r = rng.float(12, 28);
  target.x = p.x + Math.cos(a) * r;
  target.z = p.z + Math.sin(a) * r;
}

// How often a monster-flicker attempt is rolled, per second of hallucinating.
//
// SIZED TO THE OBSERVED TRIGGER RATE, NOT TO WHAT SOUNDS REASONABLE. The
// original 0.07/s read as "rare enough to be at times" on paper and was
// "never" in play, because it was rated against a hallucination episode that
// does not exist. Three gates multiply, and each one was measured:
//
//   * episode length — recorded runs put the MEDIAN lead-hallucination at ~7
//     seconds. You go under, you get to a pylon or burn a dose. The rate was
//     implicitly sized for a minute-long episode nobody has.
//   * distance — companions hold formation BEHIND the lead and lag further as
//     they fray, so the recorded nearest-companion distance while the lead is
//     under has a MEDIAN of ~22 units. The old 20-unit gate sat just inside
//     that median, so it was shut more often than open.
//   * facing — and the formation is behind you by construction, so an
//     unbiased pick spent most of its rolls on a body at the player's back.
//
// Measured end to end on the shipped code, same seeds and same player
// behaviour, the player sees a monster in an 8s episode 8% -> 45% of the time,
// in a 20s episode 37% -> 85%, in a 60s episode 78% -> 100%, and the median
// wait for the first one drops from 23.6s to 8.6s. The on-screen duty cycle
// goes 0.5% -> 3.9%: about one second in twenty-five of a hallucination has a
// monster in it, for half a second to a second and a quarter at a time. That
// is "briefly, at times," and it is nothing like a strobe.
//
// Re-measure before changing any of these. The only number that matters is how
// often a real player actually SEES one, and it is not derivable from the rate.
const MONSTER_CHANCE_PER_SEC = 0.32;
// Only a companion actually nearby can wear it. Widened from 20 to clear the
// measured ~22-unit median above; 26 still sits inside the fog's legible range
// at full distortion (density 0.032, ~40% transmittance at 26 units), so a
// flicker at the edge of the gate is a dark shape you can still read.
const MONSTER_SIGHT = 26;
// Long enough to survive a glance and a head-turn, short enough to leave you
// unsure you saw it. The old 0.35s floor could begin and end between two
// looks at the same body.
const MONSTER_MIN_DUR = 0.5;
const MONSTER_MAX_DUR = 1.25;

/**
 * Briefly make ONE nearby real companion read as a monster instead of
 * themselves — the same kind of lie perceivedWorldItems already tells about a
 * carried item's kind, aimed at a person instead: the position and behaviour
 * underneath are entirely real, only the shown identity is wrong for a beat.
 *
 * The pick is restricted to a companion who is currently ON SCREEN. A lie
 * nobody is looking at is not a lie anyone is told, and the formation puts the
 * party behind the lead by construction — an unbiased pick spent four rolls in
 * five on a body at the player's back, where it changed nothing except to fire
 * main.js's audio sting for a monster the player could not see. Restricting the
 * pool moved the OBSERVED rate (flickers the player is actually looking at)
 * from 0.5% of hallucinating time to 3.9% while cutting total flickers, and it
 * made the sting mean something: it now always arrives with something visible.
 *
 * The trade is deliberate — you can no longer wheel around and find a companion
 * already mid-flicker; the change always happens under your eye instead. That
 * is the better beat anyway, and shiftOneUnseenPhantom already owns the
 * "the world was different behind you" half of this idea.
 *
 * Costs no extra rng draw: it narrows the pool `pick` reads, it does not roll
 * again. VIEW_HALF_ANGLE (0.85) is deliberately NARROWER than the renderer's
 * real horizontal half-FOV (~0.94 at 16:9), so anything this calls on-screen
 * genuinely is, with margin — no flicker is spent right at the screen edge.
 */
function updateMonsterFlicker(percept, sim, p, dt, lying) {
  if (!lying) { percept.monsterId = null; return; }
  if (percept.monsterId !== null && sim.time < percept.monsterUntil) return; // mid-flicker, hold
  percept.monsterId = null; // any prior flicker has ended
  if (!sim.rng.chance(MONSTER_CHANCE_PER_SEC * dt)) return;
  const near = sim.companions.filter((c) => Math.hypot(c.x - p.x, c.z - p.z) <= MONSTER_SIGHT);
  if (!near.length) return;
  const onScreen = near.filter((c) => inView(p.yaw, c.x - p.x, c.z - p.z, VIEW_HALF_ANGLE));
  if (!onScreen.length) return;
  percept.monsterId = sim.rng.pick(onScreen).id;
  percept.monsterUntil = sim.time + sim.rng.float(MONSTER_MIN_DUR, MONSTER_MAX_DUR);
}

export const MONSTER_TUNING = Object.freeze({
  chancePerSec: MONSTER_CHANCE_PER_SEC,
  sight: MONSTER_SIGHT,
  minDur: MONSTER_MIN_DUR,
  maxDur: MONSTER_MAX_DUR,
});

// ===========================================================================
// The other four kinds, made reactive.
//
// PHANTOM_MARKER already answers the player (shiftOneUnseenPhantom keys off
// accumulated camera turn) and the monster flicker keys off where the party
// actually is on screen. The remaining four each set ONE value at onset and
// then held it for the whole episode: a fixed compass error, a fixed phantom
// pylon, one canned agreement, one companion holding station. Correct, stable,
// and inert — you learn the lie in three seconds and it never asks you
// anything again.
//
// Each now has a twist tied to a verb the player actually performs, and every
// one is sized the same way the monster flicker was: by the rate at which a
// player PERCEIVES it, asserted from both sides (a floor so it isn't
// invisible, a ceiling so it isn't a strobe). See tests/kinds.test.mjs — the
// numbers in the comments below are measured there, not guessed.
//
// None of these consumes an rng draw per tick. Every draw any of them needs is
// taken once, at onset, in seedHallucination — so no path's roll count depends
// on how the player moved (Brain: waiting-city#E9/E17).
// ===========================================================================

// ---- WRONG_WAY ------------------------------------------------------------
// The old lie was a constant: north is 90° off, forever, and the moment you
// notice you can simply subtract it. This one is a constant PLUS a function of
// what you just did — hold a heading and the error grows behind your back; the
// needle only ever admits it when you stop.
//
// THE PERCEIVABLE EVENT IS NOT THE DRIFT, IT IS THE SETTLE, and it is not
// measured in radians. The HUD compass is eight letters, so an error that
// grows by half a radian changes nothing a player can see. The snap threshold
// is therefore one full octant (2π/8 = 0.785 rad), which guarantees the letter
// changes when the needle settles: whatever the reading was, it is a different
// compass point now, and you were standing still when it moved.
const COMPASS_HEADING_ARC = 0.45; // yaw drift that ends the current straight leg (~26°) and restarts the commit
const COMPASS_WALK_SPEED = 1.0; // units/sec below which the eye counts as stopped (walk is 4.3)
// ...and STOPPED means stopped, head included. Gating the settle on feet alone
// let the needle release itself in the middle of a 180° sweep, where a compass
// letter changing is the least remarkable thing on screen: the settle fired at
// the tuned rate and only 1.9 of 4.1 per minute were witnessable as anomalies.
// Requiring a still head as well moves the release into the beat where the
// player is holding position and looking at something.
const COMPASS_STILL_TURN = 0.02; // radians per tick (~0.6 rad/s) that still counts as holding a heading
// A leg has to be COMMITTED before it costs anything. The first few units on a
// new heading buy nothing at all, so a player picking their way around rocks,
// weaving, or repeatedly changing their mind accumulates no error whatever —
// the lie is specifically the price of holding a line, which is the one thing a
// lost person does when they decide they know where they are going.
const COMPASS_COMMIT = 5; // units on one heading before the error starts growing
// Sized from the walk, not from taste: one committed leg — about four seconds
// at the 4.3 u/s walk, ~17 units, of which ~12 count — has to be worth just
// over one compass point, so that a player who picks a direction, holds it,
// and then stops to get their bearings sees the bearing change. Below that the
// settle is real and fires and nobody ever witnesses one (measured: at
// 0.022/unit only 13% of twenty-second episodes settled at all, and the first
// settle landed around t=22s — well past the ~7s median episode this game
// actually has).
const COMPASS_DRIFT_PER_UNIT = 0.07; // radians of extra error per committed unit walked
// Capped so that the worst case — the widest seeded error plus the whole
// drift — stays just under π. The compass can end up reading almost exactly
// backwards; it must never wrap through and start reading correct again.
const COMPASS_DRIFT_MAX = 1.3;
const COMPASS_SNAP_MIN = Math.PI / 4 + 0.02; // a settle must cross a whole compass point to be seen
const COMPASS_SETTLE_TIME = 0.4; // seconds stopped before the needle settles

// ---- FALSE_ANCHOR ---------------------------------------------------------
// The relief that stays twenty units away. The phantom pylon NEVER moves while
// you are looking at it (same rule shiftOneUnseenPhantom obeys, and the same
// reason: a marker that jumps on screen reads as a graphics bug, not a place).
// It backs off only once you have closed inside RELIEF_HOLD and then let it
// out of your view — so an approach that never breaks eye contact really does
// arrive, and the punchline is standing inside a pylon that gives nothing
// back. Looking around on the way, which is what a frightened player does,
// costs you the ground you just made up.
const RELIEF_HOLD = 16; // close inside this and the recede is armed
const RELIEF_DISTANCE = 20; // where it reappears, on the SAME bearing

// ---- CHORUS ---------------------------------------------------------------
// Agreement is only frightening if it is agreement with something. The canned
// check-in reply stays, but the chorus now answers the player's OWN VERBS —
// you log a marker that isn't there and a voice tells you it saw it too — and
// it escalates: one voice, then a certain voice, then the whole party at once
// answering a question you asked somebody else.
//
// Gated hard, because a feedback channel that fires on every event stops
// carrying information and starts destroying it (Brain: brain-builder#E6). One
// line per CHORUS_GAP seconds at most, only for events that are a DECISION
// (surveying, taking, using, spending) and never for the world merely being
// noticed, and the check-in reply shares the same clock so the two can't stack.
const CHORUS_GAP = 9; // seconds between chorus lines, all sources
const CHORUS_DEEPEN_AFTER = 25; // seconds into the episode before it gains a tier
const CHORUS_EARNED = new Set([
  "log", "logFalse", "pickup", "pickupFalse", "itemUsed", "itemPhantom",
  "dose", "craft", "drop", "dropPhantom", "gather",
]);

// ---- DOUBLED_PARTY --------------------------------------------------------
// The sixth companion used to walk a slot nobody had ever filled, which is
// exactly the version you can count: five of us, plus one. Now it fills a slot
// somebody has VACATED — the one who just went under, or the one who wandered
// out of formation while you weren't watching — so the shape of the party
// stays intact precisely when it has stopped being intact. The gap you should
// have noticed is the gap that gets covered.
// These three are scaled to COHESION RANGE, not to a formation.
//
// They were originally 14 / 10 / 9, tuned when the party walked in the lead's
// pocket and "their slot" meant a station 5-7m away. Cohesion replaced that:
// a companion is with the group if they are within LINK_RANGE of ANYONE, so in
// ordinary play they range much further and the old SLOT_MEMORY_DIST of 9 meant
// almost nobody was ever close enough to have a remembered place at all. The
// phantom then had no gap to fill and fell back to orbiting, which is the
// hallucination's weakest form — and nothing errored, the tell just quietly
// stopped happening.
//
// Anchored to LINK_RANGE so the two systems cannot drift apart again: you are
// remembered while you are linked, you have left when you are past the ping's
// reach, and you reclaim your place by coming properly back inside the link.
const VACANCY_DIST = PING_RANGE; // beyond this (or gone) a companion has left their place
const VACANCY_RETURN = LINK_RANGE * 0.75; // ...and must come back inside this to reclaim it (hysteresis)
const SLOT_MEMORY_DIST = LINK_RANGE; // how close a companion must be for their place to be remembered
const GHOST_EASE = 1.1; // how fast the phantom slides into a slot — a drift, never a cut
// ...and hard-capped at a real companion's own walking pace (party.js
// WALK_SPEED). An ease alone is smooth but not necessarily PLAUSIBLE: a
// handover across a ten-unit gap starts at over twelve units a second, which
// is faster than anything alive in the basin and reads as a figure snapping
// into place. Capped, the sixth body always looks like a person walking over.
const GHOST_MAX_SPEED = 4.6;

export const KIND_TUNING = Object.freeze({
  compass: Object.freeze({
    headingArc: COMPASS_HEADING_ARC,
    commit: COMPASS_COMMIT,
    driftPerUnit: COMPASS_DRIFT_PER_UNIT,
    driftMax: COMPASS_DRIFT_MAX,
    snapMin: COMPASS_SNAP_MIN,
    settleTime: COMPASS_SETTLE_TIME,
  }),
  relief: Object.freeze({ hold: RELIEF_HOLD, distance: RELIEF_DISTANCE }),
  chorus: Object.freeze({ gap: CHORUS_GAP, deepenAfter: CHORUS_DEEPEN_AFTER }),
  doubled: Object.freeze({ vacancy: VACANCY_DIST, reclaim: VACANCY_RETURN, ease: GHOST_EASE }),
});

/**
 * WRONG_WAY's twist. Grow the compass error while the eye walks a consistent
 * heading; release it, all at once, the moment the eye stops.
 *
 * The consistency test is on the ANCHOR, not on a per-tick difference: the leg
 * ends when the current yaw has departed far enough from the yaw the leg began
 * on. Summing per-tick turn instead would measure total activity rather than
 * committed direction, and a slow weave down a straight corridor would read
 * the same as a deliberate change of course (Brain: dog#E42 — sum the signed
 * quantity against an anchor, never abs() each step).
 *
 * Reads the eye's position; writes only percept's own fields.
 */
function updateCompassDrift(percept, sim, p, dt, lying, turned) {
  if (!lying || percept.kind !== HALLUCINATION.WRONG_WAY) {
    percept.lastX = p.x;
    percept.lastZ = p.z;
    return;
  }
  const moved = percept.lastX === null ? 0 : Math.hypot(p.x - percept.lastX, p.z - percept.lastZ);
  percept.lastX = p.x;
  percept.lastZ = p.z;

  if (percept.headingAnchor === null) percept.headingAnchor = p.yaw;
  if (Math.abs(angularDelta(p.yaw, percept.headingAnchor)) > COMPASS_HEADING_ARC) {
    // A real change of course. The leg ends; the error already banked STAYS —
    // turning is not a confession, only stopping is.
    percept.headingAnchor = p.yaw;
    percept.walkRun = 0;
  }

  if (moved / Math.max(dt, 1e-6) > COMPASS_WALK_SPEED || turned > COMPASS_STILL_TURN) {
    percept.stillTime = 0;
    percept.walkRun += moved;
    if (percept.walkRun > COMPASS_COMMIT) {
      percept.compassDrift = Math.min(COMPASS_DRIFT_MAX, percept.compassDrift + moved * COMPASS_DRIFT_PER_UNIT);
    }
  } else {
    percept.stillTime += dt;
    if (percept.stillTime >= COMPASS_SETTLE_TIME && percept.compassDrift >= COMPASS_SNAP_MIN) {
      // The settle. A compass that moves while its owner is standing still is
      // the one thing about this that a player can actually catch, so it is
      // the thing that is sized: never smaller than a whole compass point.
      percept.lastSnapSize = percept.compassDrift;
      percept.lastSnapAt = sim.time;
      percept.compassSnaps += 1;
      percept.compassDrift = 0;
      percept.walkRun = 0;
    }
  }
  percept.compassOffset = percept.compassBase + Math.sign(percept.compassBase) * percept.compassDrift;
}

/**
 * FALSE_ANCHOR's twist. Push the phantom pylon back out to RELIEF_DISTANCE on
 * its own bearing, but ONLY while it is off screen and only once the eye has
 * closed inside RELIEF_HOLD. Bearing is preserved exactly, so it is always
 * still "over there, where it was" when you look back — just further.
 *
 * Also folds in pylons that die DURING the episode: FALSE_ANCHOR's other half
 * used to be a set frozen at onset, so a pylon the player drained themselves
 * (by camping it, which is the whole reason it dies) honestly went dark on
 * screen mid-hallucination. Now the screen keeps insisting, which is the
 * cruellest version and costs nothing: you stand in the light and never
 * come back.
 */
function updateFalseAnchor(percept, sim, p, lying) {
  if (!lying || percept.kind !== HALLUCINATION.FALSE_ANCHOR) return;
  for (const pl of sim.pylons) if (pl.spent) percept.deadPylonsLookLive.add(pl.id);

  const ph = percept.phantomPylons[0];
  if (!ph) return;
  const dx = ph.x - p.x;
  const dz = ph.z - p.z;
  const d = Math.hypot(dx, dz);
  if (d >= RELIEF_HOLD) return;
  if (inView(p.yaw, dx, dz, VIEW_HALF_ANGLE)) return; // never moves under the eye
  const a = d > 1e-6 ? Math.atan2(dz, dx) : 0;
  ph.x = p.x + Math.cos(a) * RELIEF_DISTANCE;
  ph.z = p.z + Math.sin(a) * RELIEF_DISTANCE;
  percept.reliefRecedes += 1;
}

/**
 * How loud the chorus currently is: 0 one voice, 1 a certain voice, 2 all of
 * them. Escalates on three axes, none of which is a number the player is ever
 * shown — how long you have been under, how much of the party has gone with
 * you, and how much the chorus has already said. Pure; safe to call from a
 * render path.
 */
export function chorusTier(percept, sim) {
  if (!percept.active || percept.kind !== HALLUCINATION.CHORUS) return -1;
  const gone = sim.party.filter((c) => c.hallucinating).length;
  const t = (percept.chorusLines >= 2 ? 1 : 0)
    + (gone >= 3 ? 1 : 0)
    + (sim.time - percept.since >= CHORUS_DEEPEN_AFTER ? 1 : 0);
  return Math.min(2, t);
}

/**
 * The next name(s) in the rotation. Deterministic — the shuffle already
 * happened at onset — but BIASED toward a voice that could not possibly be
 * speaking: somebody too far off to be heard, or somebody who has gone
 * themselves. That bias is the whole tell. An agreement from the person
 * standing at your elbow is merely eerie; an agreement in HALDER's voice while
 * HALDER is forty units away with his back to you is a thing you can check,
 * and checking it is the only way a player ever catches this kind at all.
 *
 * Falls back to the plain rotation when the party really is all around you,
 * which is exactly when the chorus should just be unsettling instead.
 */
function chorusNames(percept, sim, count) {
  const roster = percept.chorusVoices
    .map((id) => sim.companions.find((x) => x.id === id))
    .filter(Boolean);
  if (!roster.length) return [];
  const ordered = [];
  for (let i = 0; i < roster.length; i++) ordered.push(roster[(percept.chorusIndex + i) % roster.length]);
  const impossible = ordered.filter((c) => chorusVoiceIsImpossible(sim, percept, c.id));
  const pool = impossible.length >= count ? impossible : impossible.concat(ordered.filter((c) => !impossible.includes(c)));
  const out = pool.slice(0, count);
  percept.chorusIndex = (percept.chorusIndex + Math.max(1, out.length)) % roster.length;
  return out;
}

// Deliberately short lists, indexed rather than drawn, so no two consecutive
// lines repeat and no rng is consumed on a presentation path.
const CHORUS_ASSENT = [
  "Yes. That's the one.",
  "Good. That's what we came for.",
  "Mm. Same as I had it.",
];
const CHORUS_CERTAIN = [
  "We all saw it. Don't second-guess it.",
  "That's confirmed. Keep going.",
  "It's written the same in mine.",
];
const CHORUS_ALL = [
  "All of us have it. Don't stop.",
  "Nobody disagrees. Nobody has disagreed all day.",
  "We're all saying it. Listen.",
];
// The bite. These fire on the events where the player got NOTHING — an entry
// written at nothing, a hand closing on air, an item that was never there —
// and the chorus congratulates them anyway. Agreement with something you did
// not do is the version you can almost catch.
const CHORUS_WRONG = [
  "That's the one we needed. Good.",
  "There. That's the fourth. We're nearly done.",
  "I had my hand on it too. Same thing.",
];
const CHORUS_HOLLOW = new Set(["logFalse", "pickupFalse", "itemPhantom", "dropPhantom"]);

/**
 * The chorus answering a thing the PLAYER just did. Call once per sim event
 * (hud.js's event pump does); returns a line to speak, or null.
 *
 * This is the action tie: CHORUS used to be reachable only by asking for a
 * check-in, which a player under can go a whole episode without doing. Now
 * every decision you make is met, and the meeting escalates.
 *
 * Mutates only percept's own bookkeeping — never `sim`, never `ev`.
 */
export function chorusEcho(percept, sim, ev) {
  if (!ev || !percept.active || percept.kind !== HALLUCINATION.CHORUS) return null;
  if (isClear(percept, sim)) return null;
  if (!CHORUS_EARNED.has(ev.kind)) return null;
  if (sim.time - percept.chorusLast < CHORUS_GAP) return null;

  const tier = chorusTier(percept, sim);
  const speakers = chorusNames(percept, sim, tier >= 2 ? 2 : 1);
  if (!speakers.length) return null;
  const i = percept.chorusLines;
  const hollow = CHORUS_HOLLOW.has(ev.kind);
  const table = hollow ? CHORUS_WRONG : tier >= 2 ? CHORUS_ALL : tier >= 1 ? CHORUS_CERTAIN : CHORUS_ASSENT;
  const who = speakers.map((c) => c.name).join(" and ");

  percept.chorusLast = sim.time;
  percept.chorusLines += 1;
  return {
    text: `${who}: ${table[i % table.length]}`,
    voices: speakers.map((c) => c.id),
    tier,
    hollow,
  };
}

/**
 * Is a voice the chorus just used one the player could plausibly catch? True
 * when the named companion is too far away to have said it, or is themselves
 * gone — the tell that makes the agreement checkable rather than merely
 * ominous. Exposed for tests and for anything that wants to score the lie.
 */
export function chorusVoiceIsImpossible(sim, percept, id) {
  const c = sim.companions.find((x) => x.id === id);
  if (!c) return true;
  const self = eyeOf(percept, sim);
  return c.hallucinating || Math.hypot(c.x - self.x, c.z - self.z) > CORROBORATE_RADIUS;
}

/**
 * DOUBLED_PARTY's twist. Remember where each companion stands in formation
 * (relative to the eye's own facing, so the slot turns with the lead the way a
 * real one does), then park the phantom in a slot a real companion has
 * VACATED — gone under, or simply strayed.
 *
 * The handover is hysteretic on purpose: once the phantom has taken a slot it
 * keeps it until that companion comes properly back inside VACANCY_RETURN, so
 * somebody hovering right at the edge of formation cannot make the sixth body
 * flicker between two places. And the move itself is an ease, never a cut — a
 * phantom that teleports into a gap is a glitch; one that drifts into it over
 * a couple of seconds is a person catching up.
 */
function updateDoubledParty(percept, sim, p, dt, lying) {
  const ph = percept.phantomCompanions[0];
  if (!ph) return;
  if (!lying || percept.kind !== HALLUCINATION.DOUBLED_PARTY) {
    percept.ghostOf = null;
    return;
  }

  // Remember where each companion IS, in the eye's own frame.
  //
  // SEEDED ON THE FIRST FRAME OF THE EPISODE, for everybody, whatever the
  // distance. This used to record only companions already inside
  // SLOT_MEMORY_DIST, which was right when the party walked in formation and
  // wrong the moment cohesion replaced following: a wandering crew is rarely
  // stably inside that radius, so almost nobody ever HAD a remembered place to
  // vacate, and the phantom fell back to orbiting — the hallucination's weakest
  // form — in most episodes. Measured at 13% takeover before this, against 90%
  // when the party walked behind you.
  //
  // Seeding is also the more honest model: the lead has been looking at these
  // people all along. They know roughly where everyone was when the light
  // went. Distant ones are clamped inward so the phantom stands somewhere the
  // lead could actually see rather than eighty metres out in the fog.
  for (const c of sim.companions) {
    const dx = c.x - p.x;
    const dz = c.z - p.z;
    const r = Math.hypot(dx, dz);
    if (r < 1e-6) continue;
    const fresh = !percept.slotMemory.has(c.id);
    if (c.hallucinating && !fresh) continue;
    if (!fresh && r > SLOT_MEMORY_DIST) continue;
    percept.slotMemory.set(c.id, {
      r: Math.min(r, SLOT_MEMORY_DIST),
      bearing: angularDelta(Math.atan2(dz, dx), p.yaw),
    });
  }

  // Does the current occupant still count as away? (hysteresis: they have to
  // come properly back, not just brush the threshold)
  const held = percept.ghostOf && sim.companions.find((c) => c.id === percept.ghostOf);
  if (held) {
    const back = !held.hallucinating && Math.hypot(held.x - p.x, held.z - p.z) <= VACANCY_RETURN;
    if (back) percept.ghostOf = null;
    // PREEMPTION. The pick used to be sticky: whoever was first found missing
    // held the phantom's attention until they personally walked back. That was
    // fine when the only way to be missing was to break, and wrong the moment
    // cohesion let people wander legitimately far — a stroller claimed the slot
    // in the first second of an episode and still held it minutes later, so the
    // companion who actually came apart was never the one impersonated. The
    // phantom stood over a real absence the whole time and told the wrong lie.
    // Measured at 30% of episodes impersonating a stroller instead of the mind
    // that broke, with the takeover itself running the entire episode.
    else if (!held.hallucinating && sim.companions.some((c) => c.hallucinating && percept.slotMemory.has(c.id))) {
      percept.ghostOf = null;
    }
  } else {
    percept.ghostOf = null;
  }

  if (!percept.ghostOf) {
    // The freshest gap: among everyone who has left a remembered slot, the one
    // still NEAREST is the one who most recently walked out of it. Picking by
    // distance rather than by roster order keeps the choice deterministic
    // without pinning it to c1 forever.
    // A MIND THAT HAS COME APART OUTRANKS ONE THAT MERELY WANDERED OFF.
    //
    // Both leave a gap, but they are not the same gap. Someone who broke is the
    // gap that matters — the phantom standing in their place is what makes the
    // roster's one confident line a lie about a specific person. Before
    // cohesion this never came up, because a following party had nobody
    // casually beyond the vacancy distance; now people are out there all the
    // time, and picking purely by nearest meant a stroller was impersonated
    // instead of the person who had just stopped making sense, in about a
    // third of episodes. Distance still breaks ties within each group.
    let best = null;
    let bestD = Infinity;
    let bestBroken = false;
    for (const c of sim.companions) {
      if (!percept.slotMemory.has(c.id)) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (!c.hallucinating && d <= VACANCY_DIST) continue;
      const broken = !!c.hallucinating;
      if (best && bestBroken && !broken) continue;        // never demote a broken pick
      if (best && !bestBroken && broken) { bestD = Infinity; } // a broken one always wins
      if (d < bestD) { bestD = d; best = c; bestBroken = broken; }
    }
    if (best) {
      percept.ghostOf = best.id;
      percept.ghostSwaps += 1;
    }
  }

  const slot = percept.ghostOf ? percept.slotMemory.get(percept.ghostOf) : null;
  let tx;
  let tz;
  if (slot) {
    const a = p.yaw + slot.bearing;
    tx = p.x + Math.cos(a) * slot.r;
    tz = p.z + Math.sin(a) * slot.r;
  } else {
    // Nobody missing: the old behaviour, a sixth body keeping its own station.
    ph.slot += dt * 0.15;
    tx = p.x + Math.sin(ph.slot) * 5.2;
    tz = p.z + Math.cos(ph.slot) * 5.2;
  }
  const ex = (tx - ph.x) * Math.min(1, dt * GHOST_EASE);
  const ez = (tz - ph.z) * Math.min(1, dt * GHOST_EASE);
  const step = Math.hypot(ex, ez);
  const cap = GHOST_MAX_SPEED * dt;
  const scale = step > cap ? cap / step : 1;
  ph.x += ex * scale;
  ph.z += ez * scale;
}

/** Advance the perceived world. Call once per tick, after state.tick. */
export function updatePercept(percept, sim, dt) {
  const p = eyeOf(percept, sim);
  // Set only on the tick a hallucination begins — the same beat
  // seedHallucination gets to place its phantoms before anything else reacts
  // to them. The monster flicker gets one tick's grace too: it must not fire
  // on the very frame the screen starts lying.
  let justOnset = false;
  if (p.hallucinating && !percept.active) {
    percept.active = true;
    justOnset = true;
    percept.kind = p.hallucination;
    percept.since = sim.time;
    seedHallucination(percept, sim);
  } else if (!p.hallucinating && percept.active) {
    percept.active = false;
    percept.kind = null;
    percept.whisper = null;
    percept.itemLabels.clear();
    percept.monsterId = null;
    // The reactive accumulators die with the episode too. Leaving compassDrift
    // banked here would let a lead who walked a long straight line, recovered,
    // and went under again cash in the FIRST episode's committed heading on
    // the second one's opening tick — the same "credit banked while lucid"
    // bug the camera-turn drift already has a regression test for.
    percept.compassDrift = 0;
    percept.compassOffset = 0;
    percept.walkRun = 0;
    percept.stillTime = 0;
    percept.headingAnchor = null;
    percept.ghostOf = null;
    percept.slotMemory.clear();
  }
  // Computed AFTER the transition above, not before: on the exact tick
  // recovery happens, `percept.active` just flipped false, and the turn/
  // monster logic below must see that immediately rather than re-arming
  // off a stale "was still hallucinating a moment ago" read.
  const lying = percept.active && !isClear(percept, sim);

  const target = percept.active ? 1 : 0;
  // Ramp in over ~2.5s, out over ~1.2s.
  const rate = target > percept.intensity ? 0.4 : 0.85;
  percept.intensity += Math.sign(target - percept.intensity) * Math.min(Math.abs(target - percept.intensity), rate * dt);
  percept.swayPhase += dt * (0.6 + percept.intensity * 1.8);

  // Turning the camera is what takes a phantom OUT of view in the first
  // place, so gating drift on ACCUMULATED TURN — not elapsed time — ties the
  // environment changing directly to the player's own action: sweep your
  // view around and the half of the world you just left may not be where you
  // left it. Whatever is on screen right now never moves.
  const turned = percept.lastYaw === null ? 0 : Math.abs(angularDelta(p.yaw, percept.lastYaw));
  if (percept.lastYaw !== null && lying) percept.turnAccum += turned;
  percept.lastYaw = p.yaw;
  if (!lying) percept.turnAccum = 0;
  while (lying && percept.turnAccum >= TURN_SHIFT_ANGLE) {
    percept.turnAccum -= TURN_SHIFT_ANGLE;
    shiftOneUnseenPhantom(percept, sim, p);
  }

  updateMonsterFlicker(percept, sim, p, dt, lying && !justOnset);

  // The other four kinds' action ties. Each is a no-op unless its own kind is
  // the one running, and none of them draws from sim.rng — see the block
  // comment above KIND_TUNING.
  updateCompassDrift(percept, sim, p, dt, lying, turned);
  updateFalseAnchor(percept, sim, p, lying);
  updateDoubledParty(percept, sim, p, dt, lying);
  return percept;
}

/**
 * How badly the presentation should be distorted, 0..1. Drives fog colour, camera
 * sway, and the audio bed. Below zero-lucidity there is a small pre-echo so the
 * lead gets *some* warning about themselves — the player's own tells. A Lens
 * window overrides all of this back to zero: the screen goes honest, full stop.
 */
export function distortion(percept, sim) {
  if (isClear(percept, sim)) return 0;
  // A carried-over mind can walk into a new basin already low, or even mid-
  // hallucination (state.js's own carryOver comment: that's deliberate — a
  // worn-down party stays worn down). But the grace window's whole point is
  // an orientation beat with nothing to react to yet, so the visible
  // distortion itself is withheld here even though the underlying state
  // isn't — same asymmetry as tickLucidity's grace check, applied to what
  // the screen shows rather than what the meter does.
  if (sim.time < LUCIDITY_GRACE) return 0;
  const l = eyeOf(percept, sim).lucidity;
  const pre = l <= 0 ? 0 : l < 14 ? 0.3 : l < 36 ? 0.15 : l < 62 ? 0.05 : 0;
  return Math.max(pre, percept.intensity);
}

/** Markers as the lead sees them: the real ones, plus any that aren't. */
export function perceivedMonoliths(percept, sim) {
  const real = sim.monoliths.map((m) => ({ ...m, phantom: false }));
  const lying = percept.active && !isClear(percept, sim);
  return lying ? [...real, ...percept.phantomMonoliths] : real;
}

/** Pylons as the lead sees them — including spent ones reading as charged. */
export function perceivedPylons(percept, sim) {
  const lying = percept.active && !isClear(percept, sim);
  const real = sim.pylons.map((p) => ({
    ...p,
    phantom: false,
    looksLive: !p.spent || (lying && percept.deadPylonsLookLive.has(p.id)),
  }));
  return lying ? [...real, ...percept.phantomPylons.map((p) => ({ ...p, looksLive: true }))] : real;
}

/** Companions as the lead sees them, phantoms included. */
export function perceivedCompanions(percept, sim) {
  const lying = percept.active && !isClear(percept, sim);
  const real = sim.companions.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    x: c.x,
    z: c.z,
    // Which way they are actually pointed. The renderer turns a lucid
    // companion to face the lead (they are with you); a gone one is drawn on
    // their own heading instead, which is what "not with us" looks like from
    // twenty metres away with no meter to read.
    facing: c.facing || 0,
    hallucinating: c.hallucinating,
    goalKind: c.goalKind,
    phantom: false,
    // A brief lie about WHO this is, never about where they are or what
    // they're doing — see updateMonsterFlicker. Only ever true for a real
    // companion; a phantom is already fully fake and gains nothing from it.
    monstrous: lying && c.id === percept.monsterId,
  }));
  return lying ? [...real, ...percept.phantomCompanions] : real;
}

/** The heading the lead thinks they are facing. */
export function perceivedYaw(percept, sim) {
  const lying = percept.active && !isClear(percept, sim);
  return eyeOf(percept, sim).yaw + (lying ? percept.compassOffset : 0);
}

/**
 * World items as the lead sees them. Never a phantom OBJECT — a fake pickup is
 * resolved at pickup time (see state.js pickupItem), not rendered as a fake
 * thing sitting in the world — but a REAL item's displayed kind can still be
 * wrong: assigned once per item id per hallucination episode (lazy, so it
 * settles the moment it's first seen rather than reassigning every frame) and
 * cleared on recovery. Drawn from the full kind list, truth included — a
 * hallucinating lead is lied to about MOST things, not everything; sometimes
 * what you see is exactly what is there, and you have no way to tell which.
 */
export function perceivedWorldItems(percept, sim) {
  const lying = percept.active && !isClear(percept, sim);
  return sim.items
    .filter((it) => it.discovered && !it.taken)
    .map((it) => {
      if (!lying) return { ...it, shownKind: it.itemKind, misidentified: false };
      if (!percept.itemLabels.has(it.id)) percept.itemLabels.set(it.id, sim.rng.pick(ITEM_KINDS));
      const shownKind = percept.itemLabels.get(it.id);
      return { ...it, shownKind, misidentified: shownKind !== it.itemKind };
    });
}

/**
 * Carried items as the lead sees them. A phantom slot's claimed kind is baked
 * in permanently at pickup time (state.js) and always shown as-is — that
 * deception already happened and does not un-happen on recovery. A REAL slot
 * gets the same live per-episode mislabeling as a world item, keyed by the
 * slot's own id, drawn from every displayable kind INCLUDING its own true
 * one — a hallucinating lead usually sees the wrong item, but not always, and
 * has no way to tell which case they're in until they use it (see state.js
 * useItem and main.js's reveal-on-use check).
 */
export function perceivedInventory(percept, sim) {
  const lying = percept.active && !isClear(percept, sim);
  return sim.inventory.map((slot, index) => {
    if (!slot.real) {
      return { index, real: false, shownKind: slot.claimedKind, label: ITEM_INFO[slot.claimedKind].label, misidentified: false };
    }
    if (!lying) return { index, real: true, shownKind: slot.kind, label: ITEM_INFO[slot.kind].label, misidentified: false };
    if (!percept.itemLabels.has(slot.id)) {
      // Crafted kinds included — a hallucinating lead can believe they're
      // holding an Ember they never crafted. World items stay restricted to
      // ITEM_KINDS (see perceivedWorldItems): a crafted item has no ground
      // mesh to mistake it for, so that lie only makes sense once something
      // is already in hand.
      percept.itemLabels.set(slot.id, sim.rng.pick(Object.keys(ITEM_INFO)));
    }
    const shownKind = percept.itemLabels.get(slot.id);
    return { index, real: true, shownKind, label: ITEM_INFO[shownKind].label, misidentified: shownKind !== slot.kind };
  });
}

/**
 * What THIS percept's own mind currently believes each carried slot is, in
 * inventory order — literally the labels its item bar is showing this frame.
 *
 * This is the bridge that lets state.js's craftItem work off belief without
 * state.js ever importing this module (the dependency stays one-way, so the
 * sim remains testable headless): main.js reads it here and passes it in.
 * Because it is derived from perceivedInventory itself, a craft can never
 * disagree with what that player was looking at when they pressed the key.
 * In couch co-op the inventory is shared but each player has their own
 * percept, so the two can genuinely disagree about the same slot.
 */
export function believedKinds(percept, sim) {
  return perceivedInventory(percept, sim).map((s) => s.shownKind);
}

/**
 * Filter a check-in through the LISTENER's state. The speaker already shaded it
 * in state.checkIn; this is the second filter, and the reason a report is never
 * evidence on its own.
 */
export function filterReport(percept, sim, report) {
  if (!report) return null;
  if (!percept.active) return report;
  const rng = sim.rng;
  if (percept.kind === HALLUCINATION.CHORUS) {
    // Everyone agrees with you. Everyone is fine. Nothing needs doing — and
    // the deeper in you are, the less it stays a reply to the person you
    // actually asked. Three tiers, no rng (the rotation was shuffled at
    // onset), and it shares chorusEcho's clock so a check-in and an action
    // echo can never land on top of each other.
    const tier = chorusTier(percept, sim);
    percept.chorusLast = sim.time;
    percept.chorusLines += 1;
    if (tier >= 2) {
      // Someone else answers. You asked HALDER; NKEM replies, in the first
      // person, as though the question had been put to the room — and the HUD
      // prints the name the report carries, so the wrong name is right there
      // on screen to be caught.
      const other = chorusNames(percept, sim, 1).find((c) => c.id !== report.who);
      if (other) {
        return {
          ...report,
          name: other.name,
          claim: BAND.STEADY,
          text: "We're all fine. All of us. You keep asking.",
          filtered: true,
        };
      }
    }
    return {
      ...report,
      claim: BAND.STEADY,
      text: tier >= 1 ? "Fine. We're all fine — nobody's arguing." : "…fine. We're all fine. Keep going.",
      filtered: true,
    };
  }
  if (rng.chance(0.6)) {
    const bands = [BAND.STEADY, BAND.UNSETTLED, BAND.FRAYING, BAND.BRITTLE];
    return { ...report, claim: rng.pick(bands), text: garble(report.text, rng), filtered: true };
  }
  return { ...report, filtered: true };
}

function garble(text, rng) {
  const words = text.split(" ");
  if (words.length < 3) return text;
  const i = rng.int(0, words.length - 2);
  return words.slice(0, i).concat(["—"], words.slice(i + 1)).join(" ");
}

/**
 * What the roster should show for a companion. Deliberately NOT a number: a
 * qualitative read the lead has formed from behaviour, degraded by the lead's
 * own state. The literal `lucidity` value never reaches the HUD.
 */
export function rosterRead(percept, sim, companion) {
  // "unknown" rather than a literal "?" so it is a usable CSS class and a
  // greppable value; the player-facing text is the note.
  if (percept.active) {
    // DOUBLED_PARTY's second surface, and the reason it is worth putting the
    // phantom in a real person's slot rather than a spare one: the roster
    // reads THE PHANTOM. A hallucinating lead can't tell anything about
    // anyone — except the one person whose place is currently filled by
    // something that looks perfectly steady, because there IS a body in that
    // slot walking with the party.
    //
    // Exactly one row is ever allowed to lie this way (ghostOf is a single
    // id): a confident line that appeared next to every name would be noise,
    // and it is the asymmetry against five "you can't tell"s that makes this
    // one legible at all (Brain: brain-builder#E6 — float ONE headline
    // marker, don't stack them).
    if (percept.kind === HALLUCINATION.DOUBLED_PARTY
      && companion.id === percept.ghostOf
      && !isClear(percept, sim)) {
      // "keeping up", not "steady". The roster note is a behavioural read, but
      // "steady" is also verbatim the name of a lucidity BAND — the one piece
      // of vocabulary the game never shows — and a player who learns the band
      // names elsewhere would be reading the meter straight off the roster.
      return { tag: "ok", note: "keeping up", uncertain: false, doubled: true };
    }
    return { tag: "unknown", note: "you can't tell", uncertain: true };
  }
  const band = bandOf(companion.lucidity);
  const self = eyeOf(percept, sim);
  const lagging = Math.hypot(companion.x - self.x, companion.z - self.z) > 9;
  if (companion.hallucinating) return { tag: "gone", note: "not with us", uncertain: false };
  if (companion.goalKind === "pylon") return { tag: "breaking off", note: "heading for a pylon", uncertain: false };
  if (band === BAND.BRITTLE) return { tag: "bad", note: "shaking", uncertain: false };
  if (lagging) return { tag: "lagging", note: "falling behind", uncertain: false };
  // Below BRITTLE and lagging deliberately: an errand is a benign read and
  // must never bury the one tell that means "this mind is about to go" — a
  // brittle companion who happens to be mid-fetch (no known pylon to break
  // for) still needs to show as brittle, not as "off running an errand".
  if (companion.goalKind === "fetch") return { tag: "fetching", note: "gone to fetch something", uncertain: false };
  if (companion.goalKind === "deliver") return { tag: "fetching", note: "bringing something back", uncertain: false };
  // A Tether's effect is otherwise invisible math (a reduced drain rate) — this
  // is the one place it becomes something the lead can actually see, and only
  // when nothing more urgent (brittle, lagging) is already competing for the
  // same line.
  if (companion.steadyUntil > sim.time) return { tag: "steadied", note: "steadier, for now", uncertain: false };
  if (band === BAND.FRAYING) return { tag: "off", note: "talking to the ridge", uncertain: false };
  if (band === BAND.UNSETTLED) return { tag: "quiet", note: "quieter than usual", uncertain: false };
  return { tag: "ok", note: "keeping up", uncertain: false };
}
