// Sandbox: what happens to a "pick the first eligible and HOLD it" selector when
// the eligible set widens from rare to common?
//
// dog#E39: a single-action resolver is only correct while there is truly ONE
// selectable target; add a sibling and you need real selection state.
// This asks the next question: the selector already holds ONE target, and the
// sibling arrives not as a new UI item but as a widened ELIGIBILITY PREDICATE.
//
// Claim: stickiness inverts. While eligibility is rare, "first eligible, held"
// and "the important one" are the same thing, so the design looks correct for
// as long as the rare regime lasts. Widen the predicate and the selector
// reliably locks onto a trivial instance that arrived earlier and never sees
// the important one at all — and the hold is what does it, not the picking.
//
// Live case: MIRAGE's doubled-party phantom stands in the place of a companion
// who is "missing". Missing used to mean only "came apart", which is rare.
// Cohesion added "wandered past the vacancy distance", which is common — so a
// stroller claimed the slot in the first second and still held it minutes later,
// and the companion who actually broke was never the one impersonated.
//
// Deterministic: no rng, no wall-clock.

const N = 6;          // candidates
const TICKS = 600;
const BREAK_AT = 120; // when the IMPORTANT event happens, to candidate #4

// Two eligibility regimes over identical selector logic.
const RARE = (c) => c.broken;
const WIDE = (c) => c.broken || c.far;

function run({ eligible, preempt, priorityAcquire }) {
  const cands = Array.from({ length: N }, (_, i) => ({
    id: i,
    broken: false,
    // Strollers drift in and out of "far" on fixed, staggered cycles.
    far: false,
  }));
  let held = null;
  let onImportant = 0;
  let onTrivial = 0;
  let heldAtAll = 0;

  for (let t = 0; t < TICKS; t++) {
    for (const c of cands) c.far = c.id !== 4 && ((t + c.id * 17) % 90) < 55;
    if (t === BREAK_AT) cands[4].broken = true;

    // Release: only when the held one personally stops qualifying.
    if (held !== null && !eligible(cands[held])) held = null;
    // Preemption: an important instance displaces a trivial incumbent.
    if (preempt && held !== null && !cands[held].broken && cands.some((c) => c.broken)) held = null;
    // Acquire: first eligible wins.
    if (held === null) {
      // Releasing an incumbent is only half a fix. If the re-acquire still takes
      // the FIRST eligible, it hands the slot straight back to a stroller with a
      // lower index and the preemption achieves exactly nothing — which is what
      // the first version of this sandbox measured (0% either way) before the
      // acquire was made to prioritise too.
      const pick = priorityAcquire
        ? (cands.find((c) => eligible(c) && c.broken) || cands.find(eligible))
        : cands.find(eligible);
      if (pick) held = pick.id;
    }

    if (held !== null) {
      heldAtAll++;
      if (cands[held].broken) onImportant++; else onTrivial++;
    }
  }
  return { heldAtAll, onImportant, onTrivial };
}

const rows = [
  ["rare eligibility (pre-change)", run({ eligible: RARE, preempt: false })],
  ["wide eligibility, sticky", run({ eligible: WIDE, preempt: false })],
  ["wide, preempt only", run({ eligible: WIDE, preempt: true })],
  ["wide, priority acquire only", run({ eligible: WIDE, priorityAcquire: true })],
  ["wide, preempt + priority", run({ eligible: WIDE, preempt: true, priorityAcquire: true })],
];
for (const [name, r] of rows) {
  const after = TICKS - BREAK_AT;
  console.log(`${name.padEnd(30)} held ${String(r.heldAtAll).padStart(3)}  on-IMPORTANT ${String(r.onImportant).padStart(3)}/${after}  on-trivial ${String(r.onTrivial).padStart(3)}`);
}

console.log("\n--- the claim ---");
const [, rare] = rows[0], [, sticky] = rows[1], [, preOnly] = rows[2], [, acqOnly] = rows[3], [, both] = rows[4];
console.log(`rare regime: the selector is on the important one ${((rare.onImportant / (TICKS - BREAK_AT)) * 100).toFixed(0)}% of the time after it happens`);
console.log(`wide + sticky: ${((sticky.onImportant / (TICKS - BREAK_AT)) * 100).toFixed(0)}% — and it is HELDABLE ${sticky.heldAtAll} ticks, so it looks fully operational`);
console.log(`wide + preempt ONLY:        ${((preOnly.onImportant / (TICKS - BREAK_AT)) * 100).toFixed(0)}%  (releases, then hands it back to the same class of candidate)`);
console.log(`wide + priority acquire ONLY: ${((acqOnly.onImportant / (TICKS - BREAK_AT)) * 100).toFixed(0)}%  (never releases the incumbent, so the priority never gets consulted)`);
console.log(`wide + BOTH:               ${((both.onImportant / (TICKS - BREAK_AT)) * 100).toFixed(0)}%`);
console.log(`\nthe sticky selector is never idle and never errors — it is simply pointed at the wrong thing`);
