# MIRAGE

## Before you edit anything

```
node tools/triggers.mjs --check          # the pre-flight, every change
node tools/triggers.mjs <what you are about to do>
```

`tools/triggers.mjs` is a second index over lessons Brain already holds. Brain
is indexed by CONCLUSION — "a default lives twice", "one WebGL context per
mount". At the moment a lesson is needed, what is in your head is "I am
changing a constant" or "I am adding a button that starts a run", and no query
you would think to type bridges that: `brain query fov` returns nothing. Every
failure in the 2026-08-30 session was already recorded somewhere and none of
them surfaced. `tests/triggers.mjs` back-tests it — 14/14 fire before the edit,
and it scores precision on trivial edits too, because adding triggers is free
and always improves recall.

It does not replace `brain query`. Query Brain for the PROBLEM; run the
triggers for the CHANGE.

`docs/WORKING-LIST.md` holds open items — predicted-but-unconfirmed ripples,
non-blocking bugs found mid-batch, refuted claims kept so they are not
re-proposed. Read it at the start of a phase.

**Writing to Brain: never hand-write the proposal format.** Run `brain mine`
and copy the schema verbatim; the `- Field:` bullets and the `- ID:` line are
what the steward parses. Nine entries written from a remembered shape in one
session were all held and invisible to `brain query`. **`brain doctor` says
file-by-file why anything is stuck — run it after any sync.**

## How to work here

- **Fetch remotes and read main before the first edit.** A whole alpha was
  built without this in one session; a parallel implementation was already on
  main and was found only at merge time.
- **Blueprint first** for anything spanning more than two modules. Ten lines is
  enough — `docs/blueprint-*.md` is the existing convention.
- **Two test tiers, different rules.** Pure suite (~1s) after every change; it
  catches the silent interactions while you still know what you changed.
  Browser suite (~10min) once per batch, as a gate. Deploy verify post-merge.
- **Batch the testing, not the committing.** One commit per logical change; one
  browser run per batch.
- **Second failure of the same hypothesis → build a minimal repro.** Do not run
  the big harness a third time. Eight 4-minute runs went into a problem a
  20-line probe answered in 30 seconds.
- **Negative-control every guard.** Break the thing it watches, watch it fail,
  restore. Expensive, and it has earned it — four guards here were inert on
  first write.
- **When an action would destroy work that is not yours**, "don't ask" means
  don't do it and proceed on your own branch — not decide alone.

## Cognitive system: Brain (linked via `brain` CLI)
This project is linked to the Brain cognitive system. Do not read the node
repos directly — use the CLI.

**How to invoke it (try in order, use the first that runs):**
1. `brain <cmd>`
2. if `brain` is not found: `python "$HOME/.brain/Brain/bin/brain" <cmd>`
   (Windows PowerShell: `python "$env:USERPROFILE\.brain\Brain\bin\brain" <cmd>`)

When the user asks anything like "query save" / "ask brain X" / "mine this",
run the matching `brain` command yourself — do not make the user type paths.
Before non-trivial work: `brain query <terms>`. To capture lessons, write a
proposal file + `brain sync` (or `brain mine` for a work-list). `brain sync`
reconciles with main. Keep session output minimal.

### Using Brain well (read this before deciding it's empty)
- **Query with 1-2 KEYWORDS, not sentences.** `brain query reachability`, not
  `brain query "ai cannot reach the exit on a walled map"`. The matcher is
  keyword-based; long phrases return 0. **A 0-result query almost always means
  rephrase, not "empty system"** — try broader / single terms first, and read
  the `local:` bucket, not just the shared counts.
- **Re-query at each NEW sub-problem, not only at session start.** Every
  non-trivial bug or decision is its own retrieval trigger.
- **Capture non-bugs too, not only bugs:** reusable pattern -> `ideas` kernel;
  unresolved fork -> `tension`; experiment/synthesis -> `exploration`; a
  committed decision -> an ADR in the build (and if it generalizes, ALSO an
  `ideas` kernel). See `orchestration.md`'s write-back table.
- **At each milestone, produce a Cognitive Update UNPROMPTED** (New Ideas,
  Memory, Tensions, Exploration, Graduation Candidates) — the standing rule in
  `orchestration.md`.
- **Surface any open (red/yellow) tension that touches your work to the user**
  before committing to that fork.
- Schema: memory proposals use `## FULL ENTRY` + `## PROPOSED INDEX LINE`;
  tensions/exploration use `### ` blocks. Malformed entries are held on `sync`.

### This project's history
MIRAGE was built inside `Pappydapimp69/Opticon` (branch
`claude/3d-party-hallucination-game-f31dj0`) and extracted into this standalone
repo once it stood on its own — see `docs/adr/0001-extracted-from-opticon.md`.
Opticon's own tension **T26** ("shared vendored library vs standalone
deployability") tracked the tradeoff this extraction resolves; check it before
assuming the old shim-based Three.js setup still applies anywhere — it doesn't,
`lib/three.module.js` here is a real vendored copy.
