// Sandbox: can a test that shares its feature's assumption detect a defect in
// that assumption? Modelled by construction rather than argued.
//
// The real case (mirage#E11): observe() accumulated a multi-event tally on the
// `progress` object it was handed. The unit test held ONE progress object
// across all three calls. The real caller rebuilt it every frame from storage.
// The tally therefore never survived in play — and the test passed, because it
// happened to supply the object lifetime the implementation assumed.
//
// This models the shape directly: two tests over the SAME implementation,
// differing only in whether they re-derive the caller's conditions or reuse the
// implementation's convenient assumption. Then the defect is injected and both
// are run. Deterministic: no rng, no wall-clock.

// ---- the implementation, with a switchable defect --------------------------
// `scratch` is where a cross-call tally must live. The DEFECT is putting it on
// `progress`, which the real caller rebuilds every call.
function observe(progress, scratch, event, { defect }) {
  const home = defect ? progress : scratch;
  home.seen = home.seen || [];
  if (!home.seen.includes(event)) home.seen.push(event);
  if (home.seen.length >= 2) { progress.done = true; home.seen = []; return true; }
  return false;
}

// ---- test 1: shares the implementation's assumption ------------------------
// Holds ONE progress object across calls, because that is the convenient way to
// write it and matches how the author was thinking about the code.
function testSharedAssumption({ defect }) {
  const progress = { done: false };
  const scratch = {};
  observe(progress, scratch, "a", { defect });
  observe(progress, scratch, "b", { defect });
  return progress.done;
}

// ---- test 2: re-derives the caller's real conditions ------------------------
// The real caller reloads progress from storage every call, so this does too.
// Nothing about the implementation is inspected — only its contract.
function testRealCaller({ defect }) {
  const stored = { done: false };
  const scratch = {};
  const reload = () => ({ done: stored.done });   // a NEW object, every call
  for (const ev of ["a", "b"]) {
    const p = reload();
    if (observe(p, scratch, ev, { defect })) stored.done = p.done;
  }
  return stored.done;
}

const cases = [
  ["correct implementation", false],
  ["DEFECT injected", true],
];
console.log("does the test pass?   (a guard is only real if it FAILS on the defect)\n");
console.log("                        shared-assumption test   real-caller test");
for (const [name, defect] of cases) {
  const a = testSharedAssumption({ defect });
  const b = testRealCaller({ defect });
  console.log(`${name.padEnd(24)} ${String(a ? "PASS" : "FAIL").padEnd(24)} ${b ? "PASS" : "FAIL"}`);
}

console.log("\n--- the claim ---");
const sharedCatches = testSharedAssumption({ defect: false }) && !testSharedAssumption({ defect: true });
const realCatches = testRealCaller({ defect: false }) && !testRealCaller({ defect: true });
console.log(`shared-assumption test detects the defect: ${sharedCatches}`);
console.log(`real-caller test detects the defect:       ${realCatches}`);
console.log(`\nBoth tests pass on correct code, so a green suite cannot distinguish them.`);
console.log(`Only running them against the DEFECT separates a guard from a decoration.`);

// How much of a suite can be inert without anyone noticing? Model a suite where
// a fraction of guards share their feature's assumption.
console.log("\n--- a suite with a mix of guard kinds ---");
for (const shareRate of [0, 0.25, 0.5, 0.75, 1]) {
  const N = 100;
  const shared = Math.round(N * shareRate);
  const effective = N - shared;               // only independent guards can fail
  console.log(`  ${String(Math.round(shareRate * 100)).padStart(3)}% of guards share the assumption -> ${String(N).padStart(3)} green, ${String(effective).padStart(3)} actually load-bearing`);
}
