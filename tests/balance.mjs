// Balance harness: plays complete MIRAGE runs headlessly with a scripted lead and
// reports the outcome distribution. Run: node mirage/tests/balance.mjs [seeds]
//
// Why whole runs and not step assertions: reachability/outcome is a distinct test
// axis from step-correctness. A sim can be right at every step and still produce a
// game that cannot be finished — the only way to see that is to drive runs to a
// terminal state and look at the spread.
//
// What it asserts (deliberately narrow):
//   1. EVERY run terminates and records an ending.
//   2. COMPLETABILITY — some reasonable policy finishes most standard seeds.
//   3. PRESSURE — the hardest tier is not a walkover for every policy.
// What it only REPORTS: the careful-vs-reckless gap, and the per-tier rates. A
// scripted bot is a completability oracle, not a difficulty oracle: it reads the
// sim's truth directly, so the hallucination layer — which is the entire
// difficulty for a human who is shown markers that do not exist and told by their
// own party that everything is fine — costs it almost nothing.

import { createRun, tick, logMarker, trueLogCount, debrief, activatePylon, callCompanion, LOG_RADIUS, PYLON_RADIUS, FULL_DRAIN_AT } from "../src/state.js";
import { createPercept, updatePercept } from "../src/percept.js";
import { findPath, worldToCell, cellToWorld, floodFill, GRID } from "../src/world.js";

const SEEDS = Number(process.argv[2] || 40);
const DT = 1 / 20;

// A coarse lattice of sweep waypoints over the reachable floor. The bot has to
// SEARCH the basin — it is not allowed to route to a marker it has not sighted,
// because a bot with the answer key measures nothing about whether the area is
// explorable in the time given.
function sweepPoints(sim) {
  const reach = floodFill(sim.world.blocked, sim.world.camp.cx, sim.world.camp.cz);
  const pts = [];
  const stride = 7;
  for (let cz = 3; cz < GRID - 3; cz += stride) {
    for (let cx = 3; cx < GRID - 3; cx += stride) {
      // Snap to a reachable cell in the neighbourhood of the lattice point.
      let found = null;
      for (let r = 0; r <= 3 && !found; r++) {
        for (let dz = -r; dz <= r && !found; dz++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            const nx = cx + dx, nz = cz + dz;
            if (nx > 0 && nz > 0 && nx < GRID - 1 && nz < GRID - 1 && reach[nz * GRID + nx]) found = { cx: nx, cz: nz };
          }
        }
      }
      if (found) pts.push({ ...found, ...cellToWorld(found.cx, found.cz), visited: false });
    }
  }
  return pts;
}

/**
 * Drive one run to a terminal state.
 * @param policy "careful" | "reckless" | "deceived" — see the constants below
 */
function playRun(seed, policy, difficulty = "standard") {
  const sim = createRun({ seed, difficulty });
  const sweep = sweepPoints(sim);
  const cooldown = new Map(); // pylon id -> sim time it becomes selectable again
  let path = null;
  let goal = null;
  let waitingAt = null; // which pylon we are holding, and until when
  let goalKind = null;
  let repath = 0;

  // Two policies, both plausible readings of how to play:
  //   careful  — detour to relief only once somebody is actually breaking
  //              (brittle or gone), then top up and move on
  //   reckless — never stop for anyone; sweep, survey, go home
  // An earlier "cautious" policy detoured whenever anyone dropped below the
  // FRAYING line and rested until the worst member was nearly full. It lost 100%
  // of runs to the light limit — but that measured the policy, not the game: it
  // spent its entire day resting because someone in a six-person party is always
  // below that line. It is recorded here as a negative result, not kept.
  const REST_TRIGGER = 16; // brittle
  const REST_TARGET = 60;
  // Long enough to actually take several DRAWS. A pylon no longer restores
  // continuously — one draw, then PYLON_PAUSE seconds of nothing however long
  // you stand there — so a 20-second visit was only ever worth two draws, and
  // the policy was measuring the old tap model rather than the game.
  const REST_CAP = 45; // seconds per visit

  // --- the handicap ---------------------------------------------------------
  // careful/reckless read sim.monoliths, sim.pylons and c.lucidity directly.
  // That makes them completability oracles and NOTHING else: MIRAGE's entire
  // difficulty is the gap between what is true and what you are shown, and a
  // bot with the answer key never opens that gap. Raising the drain rate until
  // an omniscient bot loses sets the difficulty for a player who cannot be
  // deceived, and then ships it to one who can.
  //
  // `deceived` closes its own eyes. It runs a real percept — the same module
  // the screen is drawn from — and every decision below is taken from THAT:
  //   * it walks to markers that do not exist, and logs them (falseLogs)
  //   * it detours to relief that recedes, and to dead pylons that look live
  //   * it steers by a compass whose error grows while it holds a line
  //   * it believes the party is fine, because the chorus agrees that it is
  // It is still not a human. It has perfect memory, no fear, and it never
  // second-guesses. But its win rate is the only one in this file that has been
  // paid for, and it is the only one difficulty tuning is allowed to read.
  const lied = policy === "deceived";
  const percept = lied ? createPercept(sim.player) : null;
  if (lied) {
    // Start the clock where the basin actually starts lying. The first ~90
    // seconds of a run are a deliberate dead calm and the ramp runs 150 more;
    // an omniscient bot finishes the whole survey in 96 seconds, so measured
    // from t=0 the deceived policy scored an identical 100% with zero false
    // logs — it had simply never hallucinated. That is not evidence the
    // deception is cheap, it is evidence the bot outran it.
    //
    // A human does not survey a basin in ninety seconds. Starting past the
    // ramp measures the phase this metric is about, on the light that is
    // actually left by then.
    sim.time = FULL_DRAIN_AT;
  }
  const believesLies = () => lied && percept.active;

  const pickGoal = () => {
    // Under a hallucination the party sounds fine — that is what CHORUS is: five
    // voices agreeing with you. So the deceived bot reads 100 across the board
    // and stops detouring for anyone, exactly when detouring matters most.
    const partyWorst = believesLies()
      ? 100
      : Math.min(...sim.companions.map((c) => (c.hallucinating ? 0 : c.lucidity)));
    // `sim.player.hallucinating` is not a thing the mind having the
    // hallucination has access to. Reading it made the deceived bot divert to
    // relief the instant it went under — which meant it never once walked to a
    // phantom marker, and logged zero false entries across every seed. Going
    // under has to feel like nothing being wrong, or none of the rest of this
    // is being measured at all.
    const selfLow = believesLies() ? false : sim.player.lucidity < 25 || sim.player.hallucinating;
    if ((policy === "careful" || lied) && (partyWorst < REST_TRIGGER || selfLow)) {
      if (believesLies()) {
        // Relief, as it APPEARS. Phantom pylons first — FALSE_ANCHOR makes them
        // the nearest thing on screen, and they back off as you approach — then
        // dead pylons the lie is still painting as live.
        const apparent = [
          ...percept.phantomPylons.map((p) => ({ ...p, id: `phantom:${p.id ?? "anchor"}`, phantom: true })),
          ...sim.pylons.filter((p) => !p.spent || percept.deadPylonsLookLive.has(p.id)),
        ].filter((p) => (cooldown.get(p.id) || 0) < sim.time);
        if (apparent.length) {
          const p = apparent.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
          return { target: p, kind: p.phantom ? "mirage" : "pylon" };
        }
      }
      // A pylon we have just finished using is on cooldown. Without this the bot
      // oscillates: "someone in the party is low" keeps selecting the pylon we
      // are standing in, while "nobody IN RANGE still needs it" keeps abandoning
      // it — a companion who is low but far away satisfies both forever.
      const live = sim.pylons.filter((p) => !p.spent && (cooldown.get(p.id) || 0) < sim.time);
      if (live.length) {
        const p = live.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
        return { target: p, kind: "pylon" };
      }
    }
    // Only DISCOVERED markers are legitimate destinations.
    const todo = sim.monoliths.filter((m) => m.discovered && !m.logged);
    if (believesLies()) {
      // A phantom marker is indistinguishable from a real one at the point of
      // deciding where to walk — that is the whole design. So it goes in the
      // same list and competes on distance, like everything else on screen.
      const apparent = [...todo, ...percept.phantomMonoliths.map((m) => ({ ...m, phantom: true }))];
      if (apparent.length) {
        const m = apparent.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
        return { target: m, kind: m.phantom ? "phantom-marker" : "marker" };
      }
    } else if (todo.length) {
      const m = todo.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
      return { target: m, kind: "marker" };
    }
    // A deceived surveyor counts their OWN log, false entries and all — they do
    // not have trueLogCount, that is the point of a false entry.
    const believedLogs = lied ? sim.logEntries.length : trueLogCount(sim);
    // Lucid again, with the survey done: walk the record and check it. An entry
    // that claims a marker leads somewhere; if nothing is there, striking it is
    // the same verb as logging. A bot that skips this comes home discredited.
    if (lied && !believesLies() && trueLogCount(sim) >= sim.monoliths.length) {
      const bad = sim.logEntries.find((e) => !e.real && !e.struck && typeof e.x === "number");
      if (bad) return { target: bad, kind: "strike" };
    }
    if (believedLogs >= sim.monoliths.length) return { target: sim.world.camp, kind: "camp" };
    // Nothing in hand: keep sweeping the basin for the ones still out there.
    const next = sweep.filter((p) => !p.visited);
    if (next.length) {
      const p = next.reduce((a, b) => (dist(a, sim.player) < dist(b, sim.player) ? a : b));
      return { target: p, kind: "sweep" };
    }
    for (const p of sweep) p.visited = false; // second lap
    return { target: sim.world.camp, kind: "camp" };
  };

  let restUntil = 0;
  // Watchdog. Several branches below re-decide without advancing the sim (goal
  // reached, goal abandoned), which is correct but means a policy bug can spin
  // forever without the clock moving — and a hanging test is far worse than a
  // failing one. Any long stretch of decisions with no tick is a bug here.
  let spins = 0;
  let ticksDone = 0;
  const guard = () => {
    if (++spins > 500) {
      throw new Error(
        `balance bot spun ${spins} decisions without ticking (seed ${seed}, ${policy}, ` +
          `goal=${goalKind}, t=${sim.time.toFixed(1)}s, ticks=${ticksDone})`,
      );
    }
  };
  const step = (input) => {
    tick(sim, DT, input);
    if (percept) updatePercept(percept, sim, DT);
    ticksDone++;
    spins = 0;
  };

  while (sim.status === "playing") {
    guard();
    repath -= DT;
    // HOLD THE PRIME. The bot re-decides its goal every second, which was
    // harmless when a pylon fired the instant you stood in it — and fatal once
    // it takes two: it would set hands on a pylon, call somebody, then wander
    // off after a marker before they arrived, over and over, never firing one.
    // A player waiting for help does not stroll away; nor does this.
    // `goal &&` matters: the pylon branch nulls the goal when it gives up, and
    // without that guard this held a stale wait with nothing to measure
    // against and dereferenced null on the next line.
    const holding = goal && waitingAt && sim.time <= waitingAt.until
      && !sim.pylons.find((p) => p.id === waitingAt.id)?.spent;
    if (holding) repath = Math.max(repath, 0.1);
    if (!holding && (!goal || repath <= 0)) {
      const g = pickGoal();
      if (!goal || g.kind !== goalKind || dist(g.target, goal) > 1) {
        goal = g.target;
        goalKind = g.kind;
        path = null;
      }
      repath = 1.0;
    }

    if (goalKind === "sweep" && dist(goal, sim.player) < 4) {
      goal.visited = true;
      goal = null;
      continue;
    }

    // A pylon takes TWO pairs of hands, and since cohesion nobody follows you
    // any more — so "walk in and press it" is no longer a policy, it is a way
    // to waste the basin's scarcest resource. The bot has to do what a player
    // has to do: get someone to come.
    //
    // This is the change that made the difference. Before it the deceived bot
    // won 0% of standard seeds, not because the deception got harder but
    // because it could not reach relief at all: it primed pylon after pylon
    // alone and nobody ever joined. A policy that ignores a verb the game
    // requires is not measuring difficulty, it is measuring its own blind spot.
    if (goalKind === "pylon" && dist(goal, sim.player) < PYLON_RADIUS * 0.6) {
      const helper = sim.companions.find(
        (c) => !c.hallucinating && dist(c, sim.player) <= PYLON_RADIUS,
      );
      if (helper) {
        // Somebody is already in the light. Both sets of hands, and it fires.
        activatePylon(sim);
        activatePylon(sim, helper);
        step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
        cooldown.set(goal.id, sim.time + 25);
        waitingAt = null;
        goal = null;
        continue;
      }
      // Nobody here. Set hands on it, call the nearest mind that still answers,
      // and hold the spot while they walk over. The call refuses silently when
      // it is recharging, which costs nothing.
      activatePylon(sim);
      const mate = sim.companions
        .filter((c) => !c.hallucinating)
        .sort((a, b) => dist(a, sim.player) - dist(b, sim.player))[0];
      if (mate) callCompanion(sim, mate.id);
      step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
      // Wait, but not forever: PRIME_WINDOW is what the prime is worth.
      if (!waitingAt || waitingAt.id !== goal.id) waitingAt = { id: goal.id, until: sim.time + 14 };
      if (sim.time > waitingAt.until) {
        cooldown.set(goal.id, sim.time + 40);
        waitingAt = null;
        goal = null;
      }
      continue;
    }

    if (goalKind === "strike" && dist(goal, sim.player) <= LOG_RADIUS * 0.85) {
      logMarker(sim); // lucid, and there is nothing here: the claim is crossed out
      goal = null;
      step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
      continue;
    }

    if (goalKind === "marker" && dist(goal, sim.player) <= LOG_RADIUS * 0.85) {
      logMarker(sim);
      goal = null;
      step({ move: { x: 0, z: 0 }, yaw: sim.player.yaw });
      continue;
    }

    // Walk the BFS path toward the current goal. `null` means "not computed";
    // an empty array is a computed answer and must not trigger a recompute every
    // tick (see the same distinction in party.js).
    if (path === null) {
      path = findPath(sim.world, worldToCell(sim.player.x, sim.player.z), worldToCell(goal.x, goal.z)) || [];
      if (!path.length) path = [worldToCell(goal.x, goal.z)]; // already in the goal cell
    }
    // Path exhausted: steer straight at the goal for the last few metres.
    const node = path[0];
    const aim = node ? cellToWorld(node.cx, node.cz) : goal;
    const dx = aim.x - sim.player.x;
    const dz = aim.z - sim.player.z;
    const len = Math.hypot(dx, dz) || 1;
    if (len < 1.2) path.shift();
    const yaw = Math.atan2(dx, -dz);
    // The compass lie, applied where it actually bites: on the step taken, not
    // on the plan. WRONG_WAY's error GROWS while you hold a straight line, so a
    // long confident leg is the one that ends up somewhere else entirely.
    let mx = dx / len, mz = dz / len;
    if (believesLies() && percept.compassOffset) {
      const a = percept.compassOffset;
      const ca = Math.cos(a), sa = Math.sin(a);
      [mx, mz] = [mx * ca - mz * sa, mx * sa + mz * ca];
    }
    step({ move: { x: mx, z: mz }, run: !lied, yaw });

    // EXTRACTION IS AN ACT NOW, NOT AN ARRIVAL. The win check needs the lead
    // plus two more bodies within 9m of camp. That used to happen by itself,
    // because the party followed you home; with cohesion nobody follows, so a
    // bot that walks to camp and waits stands there until the run dissolves
    // with the whole survey complete in its pocket. That was the real cause of
    // the deceived rows collapsing — not difficulty, an unreachable win
    // condition. It has to call its crew in, exactly as a player must.
    if (goalKind === "camp" && dist(sim.world.camp, sim.player) < 4) {
      const home = sim.party.filter((c) => dist(c, sim.world.camp) <= 9).length;
      if (home < 3) {
        // Nearest first, and only minds that still answer. A refused call costs
        // nothing, so this can be attempted every tick.
        const wanted = sim.companions
          .filter((c) => !c.hallucinating && dist(c, sim.world.camp) > 9)
          .sort((a, b) => dist(a, sim.world.camp) - dist(b, sim.world.camp))[0];
        if (wanted) callCompanion(sim, wanted.id);
      }
      step({ move: { x: 0, z: 0 }, yaw });
    }
  }
  return { ...debrief(sim), draws: sim.stats.draws || 0, pylonsLeft: sim.pylons.filter((p) => !p.spent).length };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

function summarise(label, reports) {
  const n = reports.length;
  const wins = reports.filter((r) => r.status === "won").length;
  const dissolved = reports.filter((r) => r.ending === "dissolved").length;
  const dark = reports.filter((r) => r.ending === "darkness").length;
  const discredited = reports.filter((r) => r.ending === "discredited").length;
  const avg = (f) => (reports.reduce((s, r) => s + f(r), 0) / n).toFixed(1);
  const goneSecs = reports.map((r) => r.party.reduce((s, p) => s + p.goneSeconds, 0));
  console.log(
    `${label.padEnd(11)} n=${n}  won ${String(wins).padStart(3)} (${String(((wins / n) * 100).toFixed(0)).padStart(3)}%)` +
      `  dissolved ${dissolved}  dark ${dark}  discredited ${discredited}` +
      `  found ${avg((r) => r.found)}/6  logged ${avg((r) => r.logged)}/6  false ${avg((r) => r.falseLogs)}` +
      `  slips ${avg((r) => r.slips)}  struck ${avg((r) => r.strikes)}  left-in ${avg((r) => r.badLogs)}` +
      `  time ${avg((r) => r.time)}s  party-seconds-lost ${(goneSecs.reduce((a, b) => a + b, 0) / n).toFixed(0)}`,
  );
  return { n, wins, dissolved, dark, winRate: wins / n };
}

console.log(`MIRAGE balance — ${SEEDS} seeds per policy\n`);

const careful = [];
const reckless = [];
for (let seed = 1; seed <= SEEDS; seed++) {
  careful.push(playRun(seed, "careful"));
  reckless.push(playRun(seed, "reckless"));
}

const c = summarise("careful", careful);
const r = summarise("reckless", reckless);
console.log("");
const bleak = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) bleak.push(playRun(seed, "careful", "bleak"));
const b = summarise("bleak/care", bleak);
const bleakReck = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) bleakReck.push(playRun(seed, "reckless", "bleak"));
const br = summarise("bleak/reck", bleakReck);
const gentle = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) gentle.push(playRun(seed, "careful", "gentle"));
summarise("gentle/care", gentle);

console.log("");
const deceived = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) deceived.push(playRun(seed, "deceived"));
if (process.env.DRAW_DEBUG) console.log("deceived pylon draws per run:", deceived.map((r) => r.draws ?? "?").join(","));
const d = summarise("deceived", deceived);
const deceivedBleak = [];
for (let seed = 1; seed <= Math.min(SEEDS, 20); seed++) deceivedBleak.push(playRun(seed, "deceived", "bleak"));
const db = summarise("deceived/bl", deceivedBleak);

// ---- assertions ------------------------------------------------------------
const problems = [];

// 1. Termination. `playRun` only exits when status leaves "playing", so a
//    non-terminating run would hang rather than fail — the real check is that
//    every report carries an ending.
for (const rep of [...careful, ...reckless, ...bleak, ...bleakReck]) {
  if (!rep.ending) problems.push(`a run finished with no ending recorded: ${JSON.stringify(rep.status)}`);
}

// 2. Completability. The basin must be surveyable and returnable-from inside the
//    daylight, by SOME reasonable policy, on most seeds. This is the claim this
//    harness is actually entitled to make.
const best = Math.max(c.winRate, r.winRate);
if (best < 0.6) {
  problems.push(`no policy wins more than ${(best * 100).toFixed(0)}% of standard seeds — the basin is not reliably completable`);
}

// 3. Pressure — asked of the only bot entitled to answer it. careful/reckless
//    read the sim's truth, so their win rate says nothing about a game whose
//    difficulty IS the lie; this used to assert on them, and what it actually
//    measured was the pathfinder. `deceived` pays for its information, so what
//    happens to it is a real signal.
//
//    Two-sided on purpose. Too easy and the deception costs nothing, which is
//    the failure this file exists to catch. Too hard and a run is unwinnable
//    once your meter drops — not a difficulty, a dead end, and the exact thing
//    a panicked drain-rate increase produces.
if (d.winRate >= 0.98) {
  problems.push(`the deceived bot won ${(d.winRate * 100).toFixed(0)}% of standard seeds — being lied to costs nothing`);
}
if (d.winRate < 0.35) {
  problems.push(`the deceived bot won only ${(d.winRate * 100).toFixed(0)}% of standard seeds — a deceived run is barely survivable`);
}
// The tiers must still separate for a bot that can be fooled.
if (db.winRate > d.winRate) {
  problems.push(`bleak (${(db.winRate * 100).toFixed(0)}%) was kinder than standard (${(d.winRate * 100).toFixed(0)}%) to the deceived bot`);
}
// And the lie must actually land: a deceived run should be writing entries for
// markers that were never there. Zero means the handicap is not connected.
if (deceived.reduce((a, r) => a + r.falseLogs, 0) === 0) {
  problems.push("the deceived bot logged no false markers across every seed — the handicap is not wired up");
}

console.log("");
console.log(
  `note: careful ${(c.winRate * 100).toFixed(0)}% vs reckless ${(r.winRate * 100).toFixed(0)}% is REPORTED, not asserted. ` +
    `Two policies on one seed diverge the moment they act differently, which re-rolls every\n` +
    `      later draw, so the gap is descriptive rather than a controlled measurement. And a bot ` +
    `is a valid oracle for COMPLETABILITY only: it reads the sim's truth\n` +
    `      directly, so the hallucination layer — the actual difficulty for a human, who sees ` +
    `phantom markers and gets lied to by their own party — costs it almost\n` +
    `      nothing. Do not read those win rates as human difficulty. The \`deceived\` row is the one that prices\n` +
    `      the lie: it navigates from a real percept, so it walks to markers that are not there, logs them, and chases relief\n` +
    `      that backs away. It is the only row difficulty tuning may be read from.`,
);

if (problems.length) {
  console.log("\nFAILED:");
  for (const p of problems) console.log("  ✗ " + p);
  process.exit(1);
}
console.log("\nmirage balance: OK");
