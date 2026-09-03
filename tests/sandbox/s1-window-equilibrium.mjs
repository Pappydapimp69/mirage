// Sandbox: does a WINDOW predicate go degenerate the same way august-10#E9's
// THRESHOLD predicate does, when the equilibrium it was calibrated against
// shifts underneath it?
//
// E9: a termination predicate keyed on a resource level ended wars on the tick
// they were declared once forests went extinct — silently starving every
// behaviour that needed time INSIDE the event (an arsonist reached a target 0
// times in 251 assigned ticks). No error; the event still "happened".
//
// The MIRAGE case: a pylon prime is valid for PRIME_WINDOW seconds and needs a
// second pair of hands to arrive inside it. Calibrated at 14s when the party
// walked beside you (arrival ~2s). Cohesion replaced following with a chain and
// a CALL verb, so arrival became a WALK of up to 25s. Nothing errored; the
// prime simply always expired first.
//
// Claim under test: a bounded window and a resource threshold are the same
// defect shape — a predicate whose constant encodes an assumption about a
// DISTRIBUTION that later moves. Deterministic, no rng, no wall-clock.

const WINDOW = 14;            // the constant, unchanged across regimes
const HOLD_WORK = 3;          // ticks of useful work that must happen INSIDE the event

// Two regimes. Only the arrival-time distribution differs — the predicate,
// the constant and every line of logic are identical.
const REGIMES = {
  "following (calibrated)": (i) => 1 + (i % 4),        // helper is already beside you: 1-4
  "cohesion (shifted)":     (i) => 18 + (i % 12),      // helper has to walk: 18-29
};

function run(arrivalAt) {
  let opened = 0, completed = 0, workDone = 0, errors = 0;
  for (let i = 0; i < 200; i++) {
    opened++;
    const arrival = arrivalAt(i);
    const openUntil = WINDOW;
    // The event runs; the helper arrives at `arrival`. Nothing throws either way.
    if (arrival <= openUntil) {
      completed++;
      // Behaviour that needs time INSIDE the event, as in E9's arsonist.
      workDone += Math.max(0, Math.min(HOLD_WORK, openUntil - arrival));
    }
  }
  return { opened, completed, workDone, errors };
}

console.log(`WINDOW = ${WINDOW} (one constant, never changed)\n`);
const rows = [];
for (const [name, fn] of Object.entries(REGIMES)) {
  const r = run(fn);
  rows.push([name, r]);
  console.log(`${name.padEnd(24)} opened ${r.opened}  completed ${r.completed} (${((r.completed / r.opened) * 100).toFixed(0)}%)  work-inside ${r.workDone}  errors ${r.errors}`);
}

const [, calib] = rows[0];
const [, shifted] = rows[1];
console.log("\n--- the claim ---");
console.log(`completion collapsed ${((calib.completed / calib.opened) * 100).toFixed(0)}% -> ${((shifted.completed / shifted.opened) * 100).toFixed(0)}%`);
console.log(`work done INSIDE the event: ${calib.workDone} -> ${shifted.workDone}`);
console.log(`errors raised by either regime: ${calib.errors + shifted.errors}`);

// And the E9 tell: is the degenerate case distinguishable from "just slow"?
console.log(`\nevents still OPEN in the shifted regime: ${shifted.opened} (the event still 'happens' — only its interior is empty)`);

// Where does it turn over? A sweep, so the finding is a boundary not an anecdote.
console.log("\n--- sweep: completion vs window, under the shifted arrival distribution ---");
for (const w of [8, 14, 20, 26, 32, 40]) {
  let c = 0, work = 0;
  for (let i = 0; i < 200; i++) {
    const a = REGIMES["cohesion (shifted)"](i);
    if (a <= w) { c++; work += Math.max(0, Math.min(HOLD_WORK, w - a)); }
  }
  console.log(`  window ${String(w).padStart(2)}  completion ${String(((c / 200) * 100).toFixed(0)).padStart(3)}%  work-inside ${work}`);
}
