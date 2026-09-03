# Session handoff — THE WOODS alpha

You are starting a fork of MIRAGE. Read this whole prompt, then read
`docs/IDEAS.md` in the repo — the entry titled **"THE WOODS: full design note"**
is the design of record. Everything below is context that is NOT in that file.

## What this repo is

A clone of `Pappydapimp69/mirage` at `mirage-0.12.0`. MIRAGE is a first-person
game about a party crossing a basin while their minds come apart. It works and
is deployed. **This fork adds a different game on top of those bones.** The two
are not expected to merge back — a fix in one will not reach the other.

The owner's framing, verbatim and worth keeping: *"The first game is the bones.
Now we're adding the circulatory system and the organs. If you break the bones,
the whole system flops over and dies."* Build in layers. Do not rewrite what
works.

## Build THIS first, and only this

The full design is months of work. Do not start it. Build the alpha, which
tests the single unproven claim: **can a player catch a fake by asking about a
day they both lived through, and does it feel like deduction rather than a coin
flip?**

- One short scripted day. Fixed camp, a handful of events the player is present for.
- Overnight, one party member is swapped — SAME name, SAME skills, no announcement.
- Next morning the player can ask anyone about yesterday.
- Real accounts are DERIVED FROM THE REAL EVENT LOG. The fake's is generated
  from the same log with ONE FACT PERTURBED (wrong order, wrong weather, a name
  slightly off).
- Player names who they think it is. Game says whether they were right.

No map, crafting, day/night, pylons, recruitment, skills or meta-progression.
If the investigation is not fun, none of the rest matters.

## Two constraints that are not negotiable

1. **Tells are DERIVED, never authored.** If the wrong details come from a
   hand-written list, a player memorises them by run ten and the game dies.
   Generate them by perturbing the actual recorded events.
2. **One seed per run, and nothing else.** The whole codebase is built on the
   world being a pure function of its seed: saves store a seed and regenerate,
   the rng restores from a raw state word, tests assert reproducibility. Never
   seed from device state (time, battery, resolution) — it was considered and
   rejected. A run must stay saveable, resumable and reproducible.

## What you inherit that you should reuse

- `src/state.js` — the only source of sim truth. All randomness through
  `sim.rng`. Emits events via `emit(sim, kind, text, opts)`; that stream is
  already the raw material for the accounts.
- `checkIn(sim, id)` — the ask-someone verb already exists.
- `src/percept.js` — the only module allowed to lie. Reads sim, never mutates.
- The roster HUD, the save system, the Playwright harness, the deploy verifier.
- `tests/run-all.sh` runs everything. `node tools/stamp-version.mjs <token>`
  then `node tools/verify-deploy.mjs` is the deploy path.

## Hard rules this codebase already enforces

- **The hidden meter never reaches the screen** — not as a number, not as a
  band name ("steady", "fraying"), not as an error message. A failed action must
  look identical to a successful one at the moment of the press; the difference
  shows up in the world afterwards.
- **Constant roll count.** Every decision consumes a FIXED number of rng draws
  regardless of branch, including "no need to roll, it's forced". Draw
  unconditionally, use conditionally. Violating this silently forks resumed runs.
- **Anything that gates an rng draw is save state**, however cosmetic it looks.
- **Negative-control every guard.** Revert the defect it exists for, watch the
  guard fail, restore. This session shipped four tests that asserted the bug
  instead of catching it; that is the characteristic failure here.

## Brain

The repo is linked to the Brain cognitive system — use the `brain` CLI, do not
read the node repos. `brain query <1-2 KEYWORDS>` before non-trivial work.
Relevant existing entries: `mirage#E11` (cross-frame state on a rebuilt object),
`#E13` (a window predicate degenerates when its arrival distribution moves),
`#E14` (a sticky selector inverts when eligibility widens), `#E15` (chain
cohesion is not proximity), `#E16` (a guard that never failed is unmeasured).
`brain query deduction` and `accusation` both return ZERO — that ground is
uncovered, so you are not missing prior art there.

## How the owner works

- Terse replies. Direct answers. No preamble, no unsolicited work.
- They will say "stance brief" — that means a short status: live version, what
  shipped, what is open, what no test can tell them.
- They think out loud across several messages and will say when an idea is
  finished. Do not treat a fragment as a final decision.
- They want to make the design calls. Surface tradeoffs with data, do not tune
  their stated numbers to make a test pass.
- Develop on the designated branch. Never push to a different branch without
  explicit permission.

## Known open item inherited from mirage

`tests/balance.mjs` is RED: the `deceived` bot policy wins 17% of standard seeds
against a 35% assertion, and `deceived/bleak` wins 0%. This is a difficulty
decision the owner has not made, not a bug — the structural bugs behind it were
found and fixed. Do not "fix" it by tuning constants they chose.

## The prior session

Addressable as `user-8d` via SendMessage while it is still alive. It holds the
full design conversation. It cannot transfer context — ask it specific
questions, do not ask it to hand over state.
