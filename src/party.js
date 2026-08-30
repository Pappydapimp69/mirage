// party.js — the five companions: how they walk, what they want, what they say.
// Pure logic; no DOM, no Three. (This module and state.js import each other, but
// only ever dereference each other's bindings inside function bodies, which ESM
// resolves fine — nothing here runs at module-evaluation time.)
//
// The companions ARE the UI. Their meters are invisible, so everything you can
// know about them arrives through behaviour: who breaks formation for a pylon,
// who lags, who starts narrating things that aren't there. Each rule below exists
// to make an internal number legible from the outside without printing it.

import { findPath, worldToCell, cellToWorld, moveWithCollision, isBlockedAt, CELL, GRID } from "./world.js?v=mirage-0.13.2";
import {
  BAND,
  bandOf,
  PYLON_RADIUS,
  emit,
  ITEM_PICKUP_RADIUS,
  ITEM_CAP,
  CRAFT_RECIPES,
  recipeKey,
  companionPickup,
  handoffToPlayer,
  activatePylon,
  updatePing, isAnswering, isReturning,
  PRIME_WINDOW,
} from "./state.js?v=mirage-0.13.2";

// Higher band = worse. Lets a per-companion trait move the pylon-seeking
// trigger EARLIER than the uniform BRITTLE tell everyone else gets, without
// needing its own separate band scale.
// Keyed by literal band strings, not `BAND.*` — see the note on `LINES`
// below: a top-level dereference of BAND here hits the circular-import
// temporal dead zone and throws before the game starts.
const BAND_SEVERITY = { steady: 0, unsettled: 1, fraying: 2, brittle: 3, gone: 4 };

/**
 * How early THIS companion breaks off for a known pylon. Everyone still only
 * acts on a band they've actually crossed — selfCare doesn't invent urgency,
 * it just lowers how much urgency they need before they act on it. A low-
 * selfCare companion is not careless; they're only as proactive as the loud,
 * uniform tell every companion already has (BRITTLE).
 */
function seekThresholdBand(c) {
  if (c.selfCare >= 0.66) return BAND.UNSETTLED;
  if (c.selfCare >= 0.33) return BAND.FRAYING;
  return BAND.BRITTLE;
}

const FOLLOW_SLACK = 0.9; // don't jitter inside this band
const WALK_SPEED = 4.6; // a touch faster than the player's walk, so they can catch up
const LOST_SPEED = 3.1; // a hallucinating companion moves with unhurried certainty

// --- why a follower needs a gear the leader doesn't have ---------------------
// Holding a station that MOVES WITH the lead is not the same problem as walking
// to a fixed point, and a flat WALK_SPEED silently only solves the second one.
// The lead walks at 4.3 and runs at 7.4; a companion capped at 4.6 has 0.3 units
// per second of surplus, so a slot that is 12 units away takes forty seconds to
// reach and any sprint or corner re-opens the gap faster than that.
//
// Measured with the flat speed, across 6 seeds x 90s of walking: the four
// FORWARD slots sat a mean of 60-89 DEGREES off their assigned bearing — beside
// or behind the lead, permanently chasing — while the rear guard, whose station
// is the one that falls into your lap for free, held to 11 degrees. That is the
// mechanical cause of "they just scatter and do their own thing": the formation
// was never wrong, it was simply never REACHED.
const CATCHUP_MAX = 9.2; // enough headroom to hold station through a lead's sprint

// --- and why holding station must not be free --------------------------------
// Giving everyone that gear cost the game its pressure: over 24 seeds the party
// went from 118 companion-seconds-lost per reckless run to 4, and the two runs
// that ended in the dark stopped happening. Almost all of MIRAGE's difficulty
// was, without anyone designing it that way, a side effect of followers being
// mechanically unable to keep up.
//
// So the gear is conditional. A steady mind holds its station; a fraying one
// stops CLOSING and then stops KEEPING PACE, because base speed drops under the
// lead's 4.3 walk. The party still strings out and people still get lost — but
// now that only happens to people who are coming apart, which is a thing you can
// watch happen to a specific named companion, rather than a flat tax on everyone
// from the first second of the run.
//
// The old formulation multiplied one flat speed by a `drag` factor, which could
// not express this: it scaled the ability to keep pace and the ability to close
// a gap together, so tuning either one moved the other.
const GRIP = {
  steady:    { base: 4.7, gain: 1.7 },
  unsettled: { base: 4.4, gain: 1.1 },
  fraying:   { base: 3.9, gain: 0.5 },
  brittle:   { base: 3.3, gain: 0.25 },
};
function followSpeed(gap, band) {
  const g = GRIP[band] || GRIP.steady;
  return Math.min(CATCHUP_MAX, g.base + gap * g.gain);
}
const KNOWN_PYLON_DIST = 24; // how close they must have been to remember a pylon
const SEEK_PYLON_DIST = 70; // and how far they will then travel back to one
const REPATH_INTERVAL = 0.9; // seconds between path recomputes
const SEEK_ITEM_DIST = 55; // how far an idle companion will travel on a fetch errand
const PYLON_RETRY = 90;

// Ambient wandering, the default state of anybody nobody is talking to.
const WANDER_NEAR = 4;        // never pick somewhere they are already standing
const WANDER_SPREAD = 14;     // ...scaled by the companion's own `wander` trait
const WANDER_DWELL_MIN = 4;   // seconds before choosing somewhere new
const WANDER_DWELL_MAX = 11; // seconds before a companion will try an abandoned pylon again

// --- what "gone" looks like from the outside ---------------------------------
// A companion's hallucination is only a tell if the lead can SEE it. The
// original phantom errand sent them at a uniformly-random cell anywhere in the
// basin the instant their meter hit zero, and recorded runs showed the cost:
// the MEDIAN distance from the lead while a companion was hallucinating was
// ~48 units, and only ~10% of all gone-seconds had them both inside legible
// range and on screen. The player's report — "nobody else seemed to
// hallucinate" — was literally true as a perceptual claim: it was happening
// off-screen, over the ridge, every time.
//
// Nothing below makes them easier to recover or less lost. It only puts the
// first part of the episode where it can be witnessed.
const LOST_DWELL = 7; // seconds of standing/turning before they commit to an errand
const LOST_DWELL_DRIFT = 2.6; // how far they'll shuffle during that dwell
const LOST_STALL_MIN = 2.5; // pause on arriving somewhere, before inventing the next place
const LOST_STALL_MAX = 6.0;
const LOST_GOAL_NEAR = 16; // phantom errands stay in the neighbourhood...
const LOST_GOAL_FAR = 42; // ...instead of crossing the whole basin in one leg

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function ensureMemory(c) {
  if (!c.known) c.known = { pylons: new Set(), monoliths: new Set() };
  if (typeof c.remarkCooldown !== "number") c.remarkCooldown = 4 + c.index * 1.7;
  if (typeof c.repathTimer !== "number") c.repathTimer = 0;
}

/** Walk a character toward a world point, pathfinding around spires when needed. */
function stepToward(sim, c, target, speed, dt) {
  const straight = dist(c, target) < 9 && !blockedBetween(sim, c, target);
  if (straight) {
    c.path = null;
  } else {
    c.repathTimer -= dt;
    // `null` means "no path computed yet"; an EMPTY array means "computed, and
    // there was nothing to walk" (already in the goal cell, or no route). Those
    // must not be conflated: treating empty as uncomputed re-ran a full BFS for
    // every companion on every tick, which dominated the whole simulation cost.
    if (c.path === null || c.repathTimer <= 0) {
      const from = worldToCell(c.x, c.z);
      const to = worldToCell(target.x, target.z);
      c.path = findPath(sim.world, from, to) || [];
      c.repathTimer = REPATH_INTERVAL;
    }
  }

  let aim = target;
  if (c.path && c.path.length) {
    const node = c.path[0];
    aim = cellToWorld(node.cx, node.cz);
    if (dist(c, aim) < CELL * 0.6) c.path.shift();
  }

  const dx = aim.x - c.x;
  const dz = aim.z - c.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const move = Math.min(speed * dt, len);
  const next = moveWithCollision(sim.world, c, (dx / len) * move, (dz / len) * move);
  // Stuck against geometry with a stale path: re-derive soon, but NOT this frame.
  // Zeroing the timer here meant a companion wedged against a spire ran a full
  // grid BFS on every single tick, which was ~8× the cost of the entire rest of
  // the simulation. A fifth of a second of patience is invisible in play.
  if (Math.abs(next.x - c.x) < 1e-4 && Math.abs(next.z - c.z) < 1e-4) {
    c.repathTimer = Math.min(c.repathTimer, 0.2);
  }
  c.x = next.x;
  c.z = next.z;
  c.facing = Math.atan2(dx, dz);
}

// Sample a few points along the segment; good enough for "can I just walk there".
function blockedBetween(sim, a, b) {
  const steps = Math.ceil(dist(a, b) / (CELL * 0.5));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (isBlockedAt(sim.world, a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return true;
  }
  return false;
}

/**
 * A loose fan BEHIND the lead, so six bodies don't pile into one point — and so
 * they are not standing in the camera. With forward = (-sinθ, -cosθ), the
 * behind-the-lead direction is (+sinθ, +cosθ), which is what this uses.
 */
// Where each companion walks, as a BEARING FROM THE LEAD'S FACING (radians;
// 0 is dead ahead, +/-PI is directly behind) and a stand-off distance.
//
// This used to be `lead + (sin a, cos a) * r`, which is the exact NEGATIVE of
// the camera's forward vector (-sin, -cos) — so all five companions were pinned
// permanently BEHIND the player. Measured: they were on screen 0.0% of the
// time, at a median of 6.2 units, following 100% of the time. A perfectly
// disciplined squad, standing in the one place the player can never look.
//
// That reads to a player as "they scatter and do their own thing", because the
// only time you ever see anyone is when you happen to turn, and they are
// somewhere different every time you do. The party did not need to be made more
// cohesive; it needed to be VISIBLE.
//
// So: two walking point (staggered further out so they do not wall off the
// view), two on the flanks just inside the frame edge, and one rear guard.
// Four of the five sit inside a 90-degree horizontal FOV at any moment.
const FORMATION = [
  { bearing: -0.30, r: 7.0 }, // point, left of centre — the scout
  { bearing: 0.55, r: 5.6 },  // right flank
  { bearing: -0.55, r: 5.6 }, // left flank
  { bearing: 0.30, r: 7.0 },  // point, right of centre
  { bearing: 2.75, r: 4.6 },  // rear guard — see the note below
];

// How far a blocked station may be nudged before we give up and stand by the
// lead. Ordered nearest-first so a companion never takes a bigger detour than
// the formation needs: pull straight in, then swing off the bearing, then both.
const SLOT_FALLBACKS = [
  { scale: 1, swing: 0 },
  { scale: 0.72, swing: 0 },
  { scale: 1, swing: 0.38 },
  { scale: 1, swing: -0.38 },
  { scale: 0.72, swing: 0.38 },
  { scale: 0.72, swing: -0.38 },
  { scale: 0.5, swing: 0 },
  { scale: 1, swing: 0.8 },
  { scale: 1, swing: -0.8 },
  { scale: 0.42, swing: 0.8 },
  { scale: 0.42, swing: -0.8 },
];

function formationSlot(sim, c) {
  const lead = sim.player;
  // Anchored to the lead's smoothed direction of TRAVEL, not their yaw — see
  // updateLeadHeading in state.js. A yaw-anchored formation orbits the player
  // whenever they look around, which means the rear guard can never be looked
  // at and the flanks swirl on every glance.
  const heading = typeof lead.heading === "number" ? lead.heading : lead.yaw || 0;
  const slot = FORMATION[(c.index - 1) % FORMATION.length];
  const base = heading + slot.bearing;
  // A station AHEAD of the lead is regularly inside the very spire the lead is
  // about to walk around — measured at 31-38% of following-seconds for the four
  // forward slots, against 7% for the rear guard, whose ground the lead has just
  // finished walking over. An unreachable target does not read as "unreachable":
  // the companion paths at it, gets wedged, re-paths, and drifts, which from the
  // lead's seat is indistinguishable from wandering off. So the station is
  // resolved against geometry here, before anyone is asked to stand on it.
  //
  // Deterministic — no rng draws — so the per-tick roll count stays stable and
  // seeded runs stay reproducible.
  for (const f of SLOT_FALLBACKS) {
    const a = base + f.swing;
    const r = slot.r * f.scale;
    // Negated to match the camera's forward basis (-sin, -cos): bearing 0 is
    // genuinely ahead of the player, not behind them.
    const p = { x: lead.x - Math.sin(a) * r, z: lead.z - Math.cos(a) * r };
    if (!isBlockedAt(sim.world, p.x, p.z)) return p;
  }
  // Boxed in on every side: close up on the lead rather than stand in stone.
  return { x: lead.x, z: lead.z };
}

function updateMemory(sim, c) {
  for (const p of sim.pylons) if (dist(c, p) <= KNOWN_PYLON_DIST) c.known.pylons.add(p.id);
  for (const m of sim.monoliths) if (dist(c, m) <= 18) c.known.monoliths.add(m.id);
}

function nearestKnownPylon(sim, c) {
  let best = null, bestD = Infinity;
  for (const p of sim.pylons) {
    if (!c.known.pylons.has(p.id) || p.spent) continue;
    if ((c.givenUpPylons?.[p.id] || 0) > sim.time) continue; // waited for a second, nobody came
    const d = dist(c, p);
    if (d < bestD) { bestD = d; best = p; }
  }
  return bestD <= SEEK_PYLON_DIST ? best : null;
}

/**
 * The nearest discovered, untaken world item that would complete a recipe
 * with something the lead ALREADY has in hand — the "search the world for
 * ingredient drops" half of the errand. Reactive, not a shopping list: nobody
 * decides what to craft ahead of time, a companion just notices that the lead
 * is one item away from something and goes to close the gap. Excludes items
 * another companion is already en route to, so two couriers never race for
 * the same one.
 */
/**
 * Would this item kind complete a recipe with something real the lead is
 * already holding, and is there room to receive it? Shared by the search
 * (findFetchableItem) and the in-progress check (updateCompanions) so an
 * errand that finds a target and an errand that keeps chasing one never
 * disagree about what still counts as "worth it".
 */
function completesSomething(sim, itemKind) {
  if (sim.inventory.length >= ITEM_CAP) return false;
  return sim.inventory.some((s) => s.real && CRAFT_RECIPES[recipeKey(s.kind, itemKind)]);
}

function findFetchableItem(sim, c) {
  const claimed = new Set(sim.companions.filter((o) => o !== c && o.fetchItemId).map((o) => o.fetchItemId));
  let best = null, bestD = Infinity;
  for (const it of sim.items) {
    if (it.taken || !it.discovered || claimed.has(it.id)) continue;
    if (!completesSomething(sim, it.itemKind)) continue;
    const d = dist(c, it);
    if (d < bestD) { bestD = d; best = it; }
  }
  return bestD <= SEEK_ITEM_DIST ? best : null;
}

/**
 * Where a hallucinating companion has decided to go. Confident, and wrong.
 *
 * Three flavours, each one a different way of being wrong in front of you:
 * a real marker for an unreal reason, a spot near the LEAD (they are certain
 * they are the one guiding the party — see GONE_LINES' "I'm not lost. You're
 * lost. Follow me."), or nothing in particular, which is the worst to watch.
 *
 * Every destination is now drawn from the NEIGHBOURHOOD rather than from the
 * whole grid. That is the difference between a mind coming apart where you can
 * see it and one that simply leaves: the old uniform-over-the-basin draw meant
 * the very first leg of every episode was a straight line out of sight.
 */
function phantomGoal(sim, c) {
  const rng = sim.rng;
  const roll = rng.float(0, 1);
  if (roll < 0.34 && sim.monoliths.length) {
    // Nearest markers first, so the leg is short enough to be watched.
    const reachable = sim.monoliths.filter((m) => dist(c, m) <= LOST_GOAL_FAR * 1.6);
    const m = rng.pick(reachable.length ? reachable : sim.monoliths);
    return { x: m.x, z: m.z, label: m.name };
  }
  if (roll < 0.6) {
    // A point beside the lead, snapshotted now — they are walking to where you
    // WERE, with total conviction. Not a follow: they do not re-aim as you move.
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(3, 9);
    return { x: sim.player.x + Math.cos(a) * r, z: sim.player.z + Math.sin(a) * r, label: null };
  }
  const here = worldToCell(c.x, c.z);
  for (let tries = 0; tries < 20; tries++) {
    const a = rng.float(0, Math.PI * 2);
    const r = rng.float(LOST_GOAL_NEAR, LOST_GOAL_FAR);
    const cx = Math.round(here.cx + (Math.cos(a) * r) / CELL);
    const cz = Math.round(here.cz + (Math.sin(a) * r) / CELL);
    if (cx < 2 || cz < 2 || cx > GRID - 3 || cz > GRID - 3) continue;
    if (sim.world.blocked[cz * GRID + cx]) continue;
    return { ...cellToWorld(cx, cz), label: null };
  }
  return { x: c.x, z: c.z, label: null };
}

/** Advance all five companions by `dt`. Called from state.tick. */
export function updateCompanions(sim, dt) {
  for (const c of sim.companions) {
    ensureMemory(c);
    c.aliveTime += dt;
    updateMemory(sim, c);

    // A companion a human has taken over still SENSES the basin — the memory
    // update above is what lets them keep sighting markers and remembering
    // pylons — but nothing here may steer them. Their movement comes from
    // that player's input in tick(), and notably their hallucination is NOT
    // short-circuited into a phantom errand: a hallucinating human still has
    // the wheel, they are just being lied to about where they are going.
    if (c.humanSlot !== null) continue;

    if (c.hallucinating) {
      // No formation, no orders, no lead. Just the errand they have invented.
      c.goalKind = "hallucinating";
      // The moment they go. state.js sets the flag; this is the first tick of
      // party.js's that sees it, so it is where the episode's own clock starts.
      if (c.lostSince === undefined || c.lostSince === null) {
        c.lostSince = sim.time;
        c.lostStallUntil = 0;
        c.goal = null;
      }

      // The dwell: for the first few seconds they do not go anywhere. They
      // stand roughly where they stopped and turn, which is the whole tell —
      // wrong colour, wrong behaviour, still close enough to be seen. Without
      // it the announcement ("X stops making sense") and the departure land on
      // the same tick and the player is told about something already gone.
      if (sim.time - c.lostSince < LOST_DWELL) {
        c.path = null;
        if (!c.goal) {
          const a = sim.rng.float(0, Math.PI * 2);
          c.goal = { x: c.x + Math.cos(a) * LOST_DWELL_DRIFT, z: c.z + Math.sin(a) * LOST_DWELL_DRIFT, label: null };
        }
        // A drift, not a walk — a quarter pace, so they stay watchable.
        const wasX = c.x, wasZ = c.z;
        stepToward(sim, c, c.goal, LOST_SPEED * 0.25, dt);
        // Once the drift has run out (or they are wedged), they turn on the
        // spot rather than standing frozen: looking at something that isn't
        // there. Applied only when they did NOT move, because stepToward owns
        // `facing` whenever it actually walks them somewhere.
        if (Math.abs(c.x - wasX) < 1e-4 && Math.abs(c.z - wasZ) < 1e-4) {
          c.facing = (c.facing || 0) + dt * (0.55 + c.wander * 0.9);
        }
        continue;
      }

      // Arrived somewhere, and now certain it is the place. They stand at it
      // for a beat before inventing the next one — the pause is what gives the
      // lead a chance to close the distance, and it is what "It's right here.
      // I'm standing at it. Log it." is describing.
      if (c.lostStallUntil > sim.time) {
        c.path = null;
        c.facing = (c.facing || 0) + dt * 0.35;
        continue;
      }
      if (!c.goal || dist(c, c.goal) < 2.2) {
        if (c.goal) {
          c.lostStallUntil = sim.time + sim.rng.float(LOST_STALL_MIN, LOST_STALL_MAX);
          c.goal = null;
          c.path = null;
          continue;
        }
        c.goal = phantomGoal(sim, c);
      }
      stepToward(sim, c, c.goal, LOST_SPEED * (0.7 + c.wander * 0.5), dt);
      continue;
    }
    // Back with us: the episode clock resets so the next one gets its own
    // dwell. Kept here rather than in state.recover() so the whole shape of a
    // gone companion lives in this one module.
    if (c.lostSince !== undefined && c.lostSince !== null) {
      c.lostSince = null;
      c.lostStallUntil = 0;
    }

    // A hallucinating mind still physically holds whatever it was carrying —
    // it just won't reach out and hand it over until lucid again (see the
    // `continue` above): nothing is lost or duplicated by the gap, delivery
    // just resumes the moment this companion is back and close enough.
    if (c.inventory.length && dist(c, sim.player) <= ITEM_PICKUP_RADIUS) {
      handoffToPlayer(sim, c);
    }

    const band = bandOf(c.lucidity);

    // PER-TICK BOOKKEEPING, NOT A BRANCH OUTCOME. This has to run for every
    // companion every tick, before anything below can `continue` past it. It
    // sat inside the wander branch first, which meant a companion busy at a
    // pylon or on an errand never advanced their ping clock at all: `pingAt`
    // went stale behind them, and the moment they left that branch it was
    // already overdue and fired instantly. That made behaviour depend on which
    // branches a companion had happened to take, which is precisely the kind of
    // hidden history a save cannot carry — the divergence test caught it as a
    // resumed run forking four seconds in.
    updatePing(sim, c);

    // THREE DRAWS, EVERY COMPANION, EVERY TICK, WHATEVER BRANCH THEY TAKE.
    // brain: waiting-city#E9 (constant roll count), and the same discipline
    // tickLucidity states one file over: "if a value is only USED on one
    // branch, it still has to be DRAWN on all of them."
    //
    // These are the ambient-wander values, used only when a companion is on
    // their own business and their dwell has run out. Drawing them there —
    // inside the branch, only when needed — is what broke the resume: a
    // companion busy at a pylon skipped the draws, so the number of draws in a
    // tick depended on which branch each of five companions happened to be in,
    // and a resumed run that differed by one branch entry re-perturbed every
    // mind sharing that tick. The divergence test caught it as a fork four
    // seconds after restore, and the draw count differed by exactly three.
    //
    // Drawing unconditionally costs three rng calls per companion per tick and
    // makes the stream position a function of TIME ALONE, which is the only
    // form a save can carry.
    const wanderRoll = {
      angle: sim.rng.float(0, Math.PI * 2),
      reach: sim.rng.float(0, 1),
      dwell: sim.rng.float(WANDER_DWELL_MIN, WANDER_DWELL_MAX),
    };

    // BRITTLE is the loud, uniform tell: everyone breaks formation for a
    // remembered pylon by then, whether or not you were planning to go
    // there. A companion with a high selfCare trait acts on that same signal
    // earlier — UNSETTLED or FRAYING instead of waiting for BRITTLE — which
    // is itself something you can learn to read about THEM specifically.
    if (BAND_SEVERITY[band] >= BAND_SEVERITY[seekThresholdBand(c)]) {
      const p = nearestKnownPylon(sim, c);
      if (p) {
        if (c.goalKind !== "pylon") {
          c.goalKind = "pylon";
          c.path = null;
          emit(sim, "break", `${c.name} breaks off toward a pylon.`, { who: c.id });
        }
        // ARRIVED: spend it. This has to happen inside the seek branch, not
        // after it — a companion already standing on their target pylon
        // re-enters this branch every tick and `continue`s, so an activation
        // placed below could never be reached and companions would walk to
        // pylons forever without ever using one.
        if (dist(c, p) <= PYLON_RADIUS) {
          // Prime it, and then find out whether anyone joined. Checking for
          // another BODY in range is not the same as being confirmed by one —
          // the lead standing beside you has not touched the pylon — and
          // treating presence as confirmation looped this branch forever on
          // "resting" with the meter untouched.
          const res = activatePylon(sim, c);
          if (res.confirmed) {
            c.goalKind = "resting";
            c.pylonWaitFor = null;
            continue;
          }
          if (c.pylonWaitFor !== p.id) { c.pylonWaitFor = p.id; c.pylonWaitUntil = sim.time + 12; }
          if (sim.time < c.pylonWaitUntil) {
            c.goalKind = "pylon";
            continue; // hands on it, waiting for a second — the lead may still come
          }
          // Nobody came. A MAP, not a single id: with one slot a companion who
          // gave up on pylon B stopped excluding A, walked back to A, gave up
          // on A, un-excluded B, and ping-ponged for the rest of the run.
          if (!c.givenUpPylons) c.givenUpPylons = {};
          c.givenUpPylons[p.id] = sim.time + PYLON_RETRY;
          c.pylonWaitFor = null;
        }
        c.goal = { x: p.x, z: p.z };
        stepToward(sim, c, c.goal, WALK_SPEED, dt);
        continue;
      }
    }

    // A companion who walked all the way to a pylon spends it. They will not
    // burn one they merely happen to be standing in — a pylon only works once,
    // and a companion wasting the basin's scarcest resource in passing is the
    // failure that made contact-firing untenable. Reaching one on purpose, in
    // trouble, is a different thing, and it is also the moment the lead can
    // choose to be standing close enough to catch the same pulse.
    // Deliberately NOT "standing in one is enough". A companion crossing a
    // pylon on an errand must not burn the basin's scarcest resource for one
    // body with the lead nowhere near it — spending one is something you walk
    // to on purpose, handled in the seek branch above.

    // Errand, part one: already chasing something for the lead. Keyed on
    // `fetchItemId` alone, NOT on `goalKind` still reading "fetch" — a pylon
    // break, a rest-in-pylon, or a hallucination episode all overwrite
    // goalKind on top of this, and the errand must survive underneath and
    // resume once that crisis clears, not get permanently stranded (and the
    // item permanently unclaimable by anyone else — see findFetchableItem's
    // `claimed` set) just because something more urgent briefly took over.
    if (c.fetchItemId) {
      const target = sim.items.find((it) => it.id === c.fetchItemId);
      // Also abandon an errand the lead has already outgrown — used the
      // ingredient, crafted it away, or filled the cap some other way — so a
      // companion doesn't keep walking 50+ units for a delivery that no
      // longer completes anything.
      if (!target || target.taken || !completesSomething(sim, target.itemKind)) {
        c.fetchItemId = null; // gone or pointless — reassessed fresh below
      } else {
        c.goalKind = "fetch";
        if (dist(c, target) <= ITEM_PICKUP_RADIUS) {
          companionPickup(sim, c, target.id);
          c.fetchItemId = null;
        } else {
          stepToward(sim, c, target, WALK_SPEED, dt);
          continue;
        }
      }
    }

    // Errand, part two: already carrying something for the lead. Delivering
    // takes priority over ambient formation-following (a full hand only has
    // one job) but never over this companion's own crisis, above.
    if (c.inventory.length) {
      c.goalKind = "deliver";
      stepToward(sim, c, sim.player, WALK_SPEED, dt);
      continue;
    }

    // Errand, part three: nothing to carry yet — is there something out there
    // that would complete a recipe the lead is already halfway to?
    if (!c.fetchItemId) {
      const found = findFetchableItem(sim, c);
      if (found) {
        c.goalKind = "fetch";
        c.fetchItemId = found.id;
        stepToward(sim, c, found, WALK_SPEED, dt);
        continue;
      }
    }

    // Coming back is an event too. Breaking off already announces itself
    // ("X breaks off toward a pylon"), so without this the log only ever
    // records people LEAVING — five departures and no returns reads exactly
    // like a party that scatters, even when everyone is in fact back on
    // station. Latched on the goalKind transition so it fires once per
    // absence, and only for absences the lead could have noticed.
    // "Away" means away on SOMETHING — a pylon, an errand, a broken mind. The
    // ambient states do not count, or the latch is set every tick for everyone
    // and "X comes back over" fires forever. This used to exclude "follow"; the
    // default is "wander" now, and leaving the old exclusion in place made
    // every companion permanently, silently away.
    if (c.goalKind && !["follow", "wander", "resting", "regrouping"].includes(c.goalKind)) {
      c.wasAway = c.goalKind;
    }
    // Somebody in the party has set hands on a pylon and is waiting for a
    // second. A lucid companion standing in the same light joins in — that is
    // what the confirmation IS, and without it the lead could never spend a
    // pylon without a human second player. They will not walk across the basin
    // for it; they have to already be there, which is what makes bringing the
    // party close to a pylon before you touch it the actual decision.
    const waiting = sim.pylons.find(
      (p) =>
        !p.spent &&
        p.primedBy?.length &&
        !p.primedBy.includes(c.id) &&
        sim.time - p.primedAt <= PRIME_WINDOW &&
        dist(p, c) <= PYLON_RADIUS,
    );
    if (waiting) {
      activatePylon(sim, c);
      c.goalKind = "resting";
      continue;
    }

    // ---- coming to you ---------------------------------------------------
    // Following is GONE. Five people walking in your pocket reads as an escort,
    // not a crew, and it makes "am I alone out here" impossible to feel because
    // you never are. What replaces it is two impulses, both with deadlines:
    // somebody you CALLED, and somebody the periodic ping turned around.
    //
    // Both are impulses, never restoring forces (brain: dog#E41 — a cluster
    // driven by balanced inflow and outflow reaches a fixed point and freezes
    // there). When the deadline passes they stop where they are and go back to
    // their own business, wherever that has left them.
    const summoned = isAnswering(sim, c);
    if (summoned || isReturning(sim, c)) {
      c.goalKind = summoned ? "answering" : "regrouping";
      const d = dist(c, sim.player);
      if (c.wasAway && d <= FOLLOW_SLACK * 2.5) {
        const how = c.wasAway === "hallucinating" ? `${c.name} is back with us.` : `${c.name} comes back over.`;
        c.wasAway = null;
        emit(sim, "break", how, { who: c.id });
      }
      // Close enough. A called companion who has arrived stops being called —
      // otherwise they stand pressed against the lead for the rest of the
      // window, which is the leash again by another name.
      if (d <= FOLLOW_SLACK * 2) {
        if (summoned) c.summonUntil = 0;
        c.pingUntil = 0;
        c.facing = Math.atan2(sim.player.x - c.x, sim.player.z - c.z);
      } else {
        stepToward(sim, c, sim.player, followSpeed(d, band), dt);
      }
      continue;
    }

    // ---- their own business ----------------------------------------------
    // Nobody called, no ping is pulling them back. Before cohesion this branch
    // was "follow", and removing following left NOTHING here — companions
    // simply stopped, which read as five people frozen at whatever distance
    // they happened to be. A crew that only ever moves when summoned is not a
    // crew; the wandering is what makes the calling mean anything.
    //
    // A stroll, not a patrol: pick somewhere within reach, walk there, stand a
    // moment, pick again. Radius scales with this companion's own `wander`
    // trait, so the restless ones really do get further away and the homebodies
    // stay close — one of the behavioural tells the player is meant to learn.
    c.goalKind = "wander";
    if (sim.time >= (c.wanderUntil || 0) || !c.wanderGoal) {
      // Uses the values drawn unconditionally at the top of this iteration.
      // Nothing here may call sim.rng.
      const a = wanderRoll.angle;
      const r = WANDER_NEAR + wanderRoll.reach * WANDER_SPREAD * (0.4 + c.wander);
      c.wanderGoal = { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
      c.wanderUntil = sim.time + wanderRoll.dwell;
    }
    if (dist(c, c.wanderGoal) > 1.2) stepToward(sim, c, c.wanderGoal, WALK_SPEED * 0.7, dt);
  }
}

// ---------------------------------------------------------------------------
// Unprompted chatter. The second sensor. A companion never states their meter,
// but what they choose to mention correlates with it — and once they are gone,
// they narrate a basin that isn't there with complete conviction.
// ---------------------------------------------------------------------------

// Keyed by the literal BAND values rather than by `BAND.*`. state.js and this
// module import each other, so a top-level dereference of `BAND` here would hit
// the temporal dead zone during module evaluation and throw before the game ever
// starts. Inside functions it is safe; in an object literal at load time it is not.
const LINES = {
  steady: [
    "Ground's good here.",
    "Still with you.",
    "Bearing holds.",
    "Nothing to report. Good, for once.",
    "Pace feels right. Keep it.",
    "Quiet out here. The good kind of quiet.",
  ],
  unsettled: [
    "You hear that? …no. Forget it.",
    "Light's odd. Probably the dust.",
    "How long have we been walking?",
    "Did we pass that rock already?",
    "My ears are doing something. It'll pass.",
    "Just tired. That's all this is.",
  ],
  fraying: [
    "The ridge moved. It moved, I watched it.",
    "Say my name. Just — say it.",
    "I don't like how quiet the stones are.",
    "Are we six? Count us. Count us again.",
    "Something's walking the same line we are. Behind the fog.",
    "I keep losing seconds. Small ones. It's fine.",
    "The basin's got a rhythm. I can hear it now.",
  ],
  brittle: [
    "I need a pylon. I need one NOW.",
    "My hands aren't mine.",
    "Don't let me walk off. Promise me.",
    "If I stop talking, that's when to worry.",
    "Get me to the light. Please.",
  ],
};

// A gone companion narrates, and that narration is the ONE tell that crosses
// distance and fog — the body colour and the wrong heading both need line of
// sight, this does not. So it is deliberately the loudest channel a
// hallucinating companion has, and it fires on its own cadence below rather
// than through the band formula the lucid pools use.
//
// The pool is sized to that cadence, not to a writing budget: at one line
// every ~5-11s a ~70-second episode spends fourteen-odd lines, so nine of them
// meant the same handful looping inside a single episode. Sixteen plus a
// no-immediate-repeat rule is what the measured rate actually needs.
const GONE_LINES = [
  "It's right here. I'm standing at it. Log it.",
  "The others went ahead. Hours ago. You saw them go.",
  "This pylon's warm. Feel it. Feel it.",
  "North is behind us. It has been the whole time.",
  "They're all saying it. Can't you hear them agreeing?",
  "I found the seventh marker. There's always been seven.",
  "You already logged this one. Don't you remember?",
  "The camp moved closer. It does that, near the end.",
  "I'm not lost. You're lost. Follow me.",
  "Stop shouting. I can hear you fine from here.",
  "Who's that walking with you? No — the other one.",
  "I've done this stretch four times today. Four.",
  "Don't come any closer. You're standing in it.",
  "The light's on the wrong side of the ridge.",
  "I'll wait here. Somebody has to hold the place.",
  "It's easier now. You should try it.",
];

// A gone companion's own line cadence, in seconds. Fast enough that "somebody
// out there is not okay" reaches you across the basin; slow enough to stay
// speech and not a stream.
const GONE_REMARK_MIN = 5;
const GONE_REMARK_MAX = 11;

// A role-flavored line, mixed in alongside the general band pool so a
// Surveyor sounds like a surveyor even while frayed, not just a generic
// "someone" reading from the same script as everyone else.
const ROLE_LINES = {
  Surveyor: {
    fraying: ["My own bearings don't agree with each other anymore."],
    brittle: ["I can't trust my own readings. That's — that's the job, gone."],
  },
  Medic: {
    fraying: ["Someone's pulse is wrong. I keep checking whose."],
    brittle: ["I can't tell who needs me and who's asking for someone else."],
  },
  Rigger: {
    fraying: ["That knot wasn't there this morning. I tied it. Didn't I?"],
    brittle: ["My hands know the rope better than my head does right now."],
  },
  Signals: {
    fraying: ["I'm picking up chatter. There's no one to send it."],
    brittle: ["Everything sounds like it's coming through water."],
  },
  Geologist: {
    fraying: ["This rock is younger than it was an hour ago."],
    brittle: ["The ground keeps answering before I ask it anything."],
  },
};

/**
 * Maybe have a companion say something. Rate-limited per character and weighted
 * by temperament, so a chatty medic is a better sensor than a stoic surveyor —
 * which is itself a thing the player learns to account for.
 */
export function companionRemark(sim, c, dt) {
  ensureMemory(c);
  // Going under cuts straight through whatever silence was left on the clock.
  // Otherwise the announcement that a mind has broken can be followed by up to
  // half a minute of that mind saying nothing, which reads as nothing having
  // happened — and it is the SPOKEN line, not the body, that reaches a lead
  // who is forty metres away in fog. `goneAnnounced` also latches so the
  // shortcut fires once per episode, not once per tick.
  if (c.hallucinating && !c.goneAnnounced) {
    c.goneAnnounced = true;
    c.remarkCooldown = 0;
  } else if (!c.hallucinating) {
    c.goneAnnounced = false;
  }
  c.remarkCooldown -= dt;
  if (c.remarkCooldown > 0) return null;

  const band = bandOf(c.lucidity);
  const chatty = 0.35 + c.chatty * 0.9;
  // Worse state, more talking — except the stoic, who go quiet instead, and that
  // silence is its own signal.
  const urgency = { steady: 0.35, unsettled: 0.7, fraying: 1.1, brittle: 1.5, gone: 1.2 }[band] || 0.5;
  // A gone mind runs on its own clock, not the band formula: temperament stops
  // mattering once you are past the point of choosing what to mention, and the
  // formula's stoic-and-quiet term would otherwise silence exactly the
  // companion the lead most needs to hear.
  c.remarkCooldown = c.hallucinating
    ? sim.rng.float(GONE_REMARK_MIN, GONE_REMARK_MAX)
    : Math.max(3.5, 16 / (chatty * urgency)) * sim.rng.float(0.75, 1.3);

  if (c.hallucinating) {
    // Never the same line twice running. Filtering the pool costs no extra rng
    // draw — `pick` still rolls exactly once, just over a shorter list — which
    // keeps the per-tick draw count stable for seed reproducibility.
    const pool = GONE_LINES.filter((l) => l !== c.lastGoneLine);
    const text = sim.rng.pick(pool);
    c.lastGoneLine = text;
    emit(sim, "chatter", `${c.name}: ${text}`, { who: c.id, gone: true });
    return text;
  }
  if (band === BAND.STEADY && sim.rng.chance(0.6)) return null; // healthy people don't narrate
  if (c.stoic > 0.7 && (band === BAND.FRAYING || band === BAND.UNSETTLED) && sim.rng.chance(0.55)) return null;

  // A third of the time, reach for a line specific to this companion's role
  // instead of the shared pool — when that band even has one for them.
  const roleLines = ROLE_LINES[c.role]?.[band];
  const pool = roleLines && sim.rng.chance(1 / 3) ? roleLines : LINES[band] || LINES[BAND.STEADY];
  const text = sim.rng.pick(pool);
  emit(sim, "chatter", `${c.name}: ${text}`, { who: c.id });
  return text;
}
