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

- [ ] The trigger index is hand-derived. The claim is that it should be
      *generated* from each Brain entry's own "Where/why it failed" field,
      which is where the precondition already lives. Unconfirmed: I have not
      checked whether that field is consistently written as a precondition
      across the corpus, or only in the entries I wrote.
- [ ] `brain sync` from a session with only `mirage` attached: query and local
      write will work (the cache is per-machine, at `~/.brain`), but sync
      PUSHES to the knowledge repos on GitHub. Untested whether that needs them
      in the session's repo scope or just credentials. This matters — it is the
      difference between a clean single-repo session and eight CLAUDE.md files
      loading at once.

## Open — found in passing, not yet fixed

- [ ] **22 proposals in the shared intake queue are still HELD**, oldest
      2026-08-01. Not mine — other projects and earlier sessions. Most are
      missing `- ID:`, `Tags`, `What` or `Why built`, i.e. the same
      hand-written-format failure. Until a steward promotes them the system has
      been told 22 lessons it cannot answer with. Worth a single cleanup pass
      by whoever owns them.
- [ ] The `.brain/` local store is gitignored and did NOT survive this
      session's container restart. Anything kept there is scratch in the
      strongest sense. That is why this file is committed.
- [ ] `tests/balance.mjs` — the `deceived` bot at 17% against a 35% bar,
      `deceived/bleak` at 0%. The owner's open difficulty decision, not a
      defect; the structural bugs behind it were found and fixed. Do not tune
      the constants they chose.

## Denied — kept so it is not re-proposed

- **"The nightfall stall was a code bug."** It was environment saturation: a
  headless page under software GL with three mounted runs. Six attempts went
  into this before a 20-line isolated probe answered it in 30 seconds. The real
  lesson is the stopping rule, not the timer. (The rAF-timestamp finding was
  real and separate, and is filed.)
- **"Re-entering `activatePylon` evicts chatter from the 64-entry event
  buffer."** Refuted by sandbox at every re-entry length. The code comment
  claiming it was corrected.
