# Working list

Brain's local store holds **proposals** — things I already believe and want
promoted. It has nowhere for **open items**: a ripple I predicted but have not
confirmed, a non-blocking bug found mid-batch, a hypothesis to try next. Those
currently live only in an agent's head and evaporate between turns.

This is that file. It is scratch, it is committed (so it survives a container
restart — the `.brain/` local store is gitignored and does not), and it is
short on purpose.

**Rules.**

1. **Read it at the start of every phase.** That is the entire point. Not "when
   appropriate" — that instruction has already been tried in the Brain pointer
   block and it does not fire.
2. **An item leaves only three ways.** Confirmed → write a Brain proposal
   (`brain mine` for the schema — do NOT hand-write it) and delete. Denied →
   delete, and if the refutation was interesting, propose *that*; a refuted
   claim is worth as much as a confirmed one. Stale → dropped after two
   phases unexamined, deliberately, without ceremony.
3. **It never shadows Brain.** If an item starts explaining something general,
   it graduates or it goes. A local store that quietly becomes a second source
   of truth is worse than not having one — see the first trigger in
   `tools/triggers.mjs`.
4. **It does not sync.** Only what graduates travels.

---

## Open — predicted, unconfirmed

_(empty)_

## Open — found in passing, not yet fixed

- [ ] The `.brain/` local store is gitignored and did NOT survive this
      session's container restart. Anything kept there is scratch in the
      strongest sense. That is why this file is committed.
- [ ] `tests/balance.mjs` — the `deceived` bot at 17% against a 35% bar,
      `deceived/bleak` at 0%. The owner's open difficulty decision, not a
      defect; the structural bugs behind it were found and fixed. Do not tune
      the constants they chose.

## Denied — kept so it is not re-proposed

- **"The trigger index should be GENERATED from each Brain entry's own
  `Where/why it failed` field, which is where the precondition already lives."**
  Measured, refuted. Back-test: the 14 hand-written triggers, 12 of which have a
  source entry in the canon (718 memory entries). For each, how much of the
  trigger's `when:` vocabulary each field of its source entry could have
  produced:

  | field | mean recall | wins | vs shuffled pairing |
  |---|---|---|---|
  | `What` (67 words) | 44.5% | 8/12 | +39.7 |
  | `Rule of thumb` (39 words) | 41.9% | 2/12 | +37.9 |
  | `Where/why it failed` (42 words) | 19.4% | **0/12** | +15.0 |

  Not a length artefact — `Rule of thumb` is SHORTER than the failure field and
  still more than doubles it, and every field was negative-controlled against
  shuffled trigger/entry pairings. Hand-reading a 24-entry spread across the
  corpus agrees: 1 states a precondition outright, ~7 state a general mechanism
  a human could turn into one, ~16 are a post-hoc causal narrative of one
  incident ("the clear left N default nodes at the front"). Two of the 14
  triggers have no canon entry at all, so no generator over the corpus could
  have produced them.

  The precondition lives in `What:`, and the generalisation in `Rule of thumb:`
  — the failure field is where the *narrative* lives, by design. A generator is
  still worth building; it must read those two fields, and it will never be
  complete.

- **"The nightfall stall was a code bug."** It was environment saturation: a
  headless page under software GL with three mounted runs. Six attempts went
  into this before a 20-line isolated probe answered it in 30 seconds. The real
  lesson is the stopping rule, not the timer. (The rAF-timestamp finding was
  real and separate, and is filed.)
- **"Re-entering `activatePylon` evicts chatter from the 64-entry event
  buffer."** Refuted by sandbox at every re-entry length. The code comment
  claiming it was corrected.
