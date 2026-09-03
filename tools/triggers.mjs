// triggers.mjs — the index Brain does not have: what am I ABOUT TO DO?
//
// Brain is indexed by CONCLUSION. An entry is filed as "a default lives twice"
// or "one WebGL context per mount". At the moment the lesson is needed, what is
// in the agent's head is "I am changing a constant" or "I am adding a button
// that starts a run". Nothing connects those two, and no query anyone would
// think to type bridges the gap — `brain query fov` returns nothing useful.
//
// So this is a SECOND INDEX over lessons that already exist: precondition ->
// the checks that fire, each citing the entry it came from. Every failure made
// in the 2026-08-30 session — here and in the fork built on these bones — was
// already recorded somewhere; none surfaced, because the search key was the
// answer rather than the situation.
//
// Deliberately NOT a knowledge base. It holds no explanations — only a
// question and a pointer. The moment it starts explaining, it is a second copy
// of Brain that will drift from the first — which is precisely the first entry
// in the table below: one value, two homes, only one of them updated.
//
// Usage:
//   node tools/triggers.mjs                    # everything
//   node tools/triggers.mjs adding a field     # what fires for that
//   node tools/triggers.mjs --check            # the standing pre-flight
//
// PROVING IT, THEN PROPAGATING IT. This is hand-derived and project-local on
// purpose. If it fires on real work here, the mechanism belongs in the Brain
// CLI, generated from each entry's own "where/why it failed" field rather than
// maintained by hand — a hand-kept table rots into exactly the stale file this
// exists to replace. If it does not fire, it dies here and costs nothing.

export const TRIGGERS = [
  {
    when: ["changing a constant", "changing a default", "tuning a value", "new default"],
    ask: "Is this value ALSO written somewhere else — a pre-selected control, a static class in markup, a pre-load copy, a test asserting the literal?",
    then: "Move every copy together, and assert the copies against EACH OTHER on a cleared profile rather than each against a number.",
    from: "mirage: a default lives twice — DEFAULT_HFOV 90->78 left the pause ladder and main.js on 90",
  },
  {
    when: ["adding a field", "new sim state", "new flag", "storing state"],
    ask: "Does this field gate an rng draw, or decide WHICH TICK something happens on?",
    then: "Then it is save state. A missing timer restores as undefined, arithmetic gives NaN, comparisons are false, and a resumed run silently takes a different branch minutes later.",
    from: "mirage: rng-gating-is-save-state; the cohesion deadlines that broke the divergence test",
  },
  {
    when: ["setting once", "at build time", "on mount", "at startup", "initialising"],
    ask: "Is there a per-frame loop that writes this same property?",
    then: "It will be overwritten on the next frame. This codebase has produced it three times: renderer fog, audio update(), and nearly the biome.",
    from: "mirage: the per-frame overwrite pattern",
  },
  {
    when: ["adding a verb", "new prompt", "new interaction", "new action"],
    ask: "What outranks this in the single-prompt resolver where it has to appear?",
    then: "Anything above it makes the new verb unreachable at that spot, silently. Clear what outranks it from the site, or give it its own rung.",
    from: "mirage: resolver starvation (VERB_PRIORITY, the tutorial's two uncompletable stages)",
  },
  {
    when: ["acquiring", "new context", "creating a renderer", "addEventListener", "opening a handle", "play again", "restart button"],
    ask: "Who releases this, and does the function that CREATES it release the previous one?",
    then: "Release in the acquirer as its first statement, never in each caller. Browsers cap WebGL contexts and reclaim by force-losing the OLDEST — a black screen with nothing thrown.",
    from: "mirage 0.13.2 (found in the fork, live here): one WebGL context per mount — mountRun never disposed",
  },
  {
    when: ["reserved value", "sentinel", "special seed", "magic id"],
    ask: "Which branch actually READS this sentinel? Grep for it.",
    then: "A sentinel with no consumer is a comment. The camp's reserved seed was handed to the procedural generator and produced a real, walkable, different map with the saved positions pasted on.",
    from: "mirage 0.13.1: the camp's reserved seed had no consumer; the tutorial autosaves every 5s",
  },
  {
    when: ["storage key", "localStorage", "save slot", "new key", "forking a project"],
    ask: "Is this origin shared with another project?",
    then: "GitHub Pages serves every project of one account from ONE origin; the project name is a path. Namespace the keys or two games silently overwrite each other's saves and each reports 'no save' to a player who had one.",
    from: "mirage/seven: one GitHub Pages account is ONE origin; both games shared a save slot",
  },
  {
    when: ["writing a test", "adding a guard", "new assertion"],
    ask: "Have I watched this fail? Break the thing it guards, confirm it goes red, restore.",
    then: "A guard that has never been observed to fail is unmeasured, not proven — and the ones most likely to be inert are written by the same person at the same time as the feature. Four in this codebase were dead on first write.",
    from: "mirage#E16: a guard that never failed is unmeasured",
  },
  {
    when: ["reading source in a test", "parsing a file", "slicing source"],
    ask: "Is the window bounded by a character count?",
    then: "It narrows silently every time the subject grows, then fails blaming the subject rather than its own reach. Bound by a structural delimiter — the next declaration, the closing tag.",
    from: "mirage 0.13.1: two fixed-character source windows expired as their subjects grew",
  },
  {
    when: ["passing a callback", "helper that draws", "constant roll count"],
    ask: "Can anything this function calls touch the generator, and is it called a data-dependent number of times?",
    then: "The rule binds the function's TOTAL, not its own visible draws. Hoist those draws to the caller and pass a finished table. And sweep the DATA SHAPE, not just the seed, when measuring the count.",
    from: "the fork: pickPerturbation took a callback that drew once per actor",
  },
  {
    when: ["timing", "animation", "fade", "duration", "requestAnimationFrame", "setTimeout"],
    ask: "Is this measuring wall-clock duration off the rAF timestamp, or off a capped simulation delta?",
    then: "The rAF timestamp is the frame's SCHEDULED time and arrives behind the clock under throttling — elapsed goes negative and the effect never ends. A capped sim delta stretches the effect. Read performance.now() at call time.",
    from: "the fork: a fade measured elapsed off the rAF timestamp and went negative",
  },
  {
    when: ["adding a test to the runner", "known failure", "accepted red", "set -e"],
    ask: "Where does this sit in a fail-fast runner?",
    then: "A tolerated red mid-file deletes every check below it, silently — a suite that stops early looks exactly like a suite that ran. Put it LAST and capture its status.",
    from: "mirage 0.13.1: balance sat mid-file under set -e and deleted the whole browser tier",
  },
  {
    // NOT a bare "renaming" — that fired on renaming a css class, which this
    // has nothing to say about. A trigger that fires on everything is noise,
    // and noise is how a checklist stops being read.
    when: ["renaming a project", "renaming the build", "renaming a repo", "forking", "matching by name", "regex on a project name", "version token"],
    ask: "Does any tool identify its subject by a literal that names the project?",
    then: "It matches nothing after the rename, and every check of the form 'for each X found, assert P' is then vacuously satisfied. Make an EMPTY result set a failure.",
    from: "mirage 0.13.2: verify-deploy matched /mirage-/ and reported OK over an unchecked graph",
  },
  {
    when: ["starting work", "new feature", "beginning a phase", "taking over"],
    ask: "Have I fetched every remote and read the recent commits on main?",
    then: "The whole WOODS alpha was built without this. A parallel implementation was already on main and was found only at merge time.",
    from: "session 2026-08-30: a whole alpha built without fetching main, where a rival already sat",
  },
];

// The short list that applies to every change, regardless of what it is.
export const PREFLIGHT = [
  "Fetched remotes; read main's recent commits.",
  "Ran `brain doctor` if anything was written to Brain recently — a held proposal is invisible to query.",
  "Queried Brain for prior art on THIS problem, not just at session start.",
  "Listed what else this change touches BEFORE editing (see triggers above).",
  "Pure suite after each change; browser suite once per batch.",
  "Two failed attempts at the same hypothesis -> isolate in a minimal repro instead of a third variant.",
];

function match(words) {
  const q = words.join(" ").toLowerCase();
  if (!q) return TRIGGERS;
  return TRIGGERS.filter((t) => t.when.some((w) => q.includes(w) || w.includes(q)));
}

// Entry-point guard by RESOLVED PATH, not by filename. `endsWith("triggers.mjs")`
// also matched tests/triggers.mjs, so importing this module printed the whole
// table before the test ran a single check.
import { fileURLToPath } from "url";
import path from "path";
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  if (args[0] === "--check") {
    console.log("\nPRE-FLIGHT — every change, no exceptions\n");
    for (const p of PREFLIGHT) console.log("  [ ] " + p);
    console.log();
  } else {
    const hits = match(args);
    if (!hits.length) {
      console.log(`\nnothing fires for "${args.join(" ")}".`);
      console.log("That is a gap, not an all-clear — if this change turns out to touch something,");
      console.log("add the trigger here and propose the lesson to Brain.\n");
    } else {
      console.log(`\n${hits.length} trigger(s) fire:\n`);
      for (const t of hits) {
        console.log(`  ? ${t.ask}`);
        console.log(`    ${t.then}`);
        console.log(`    — ${t.from}\n`);
      }
    }
  }
}
