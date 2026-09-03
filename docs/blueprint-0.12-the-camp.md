# Blueprint — 0.12, the camp: one map, one session, and a party that drifts

## The problem

Three separate things are wrong, and they share a cause.

1. **The tutorial is seven disconnected runs.** `startStage(i)` builds a fresh
   world from seed `7000+i` and wipes it. Finishing a stage tears the basin
   down and rebuilds another. Nothing persists, nothing is a place.
2. **The tutorial happens in the wilderness.** Every stage is a generated
   basin — the same kind of ground the real game drops you into. Nothing marks
   this as before, as preparation, as somewhere people live.
3. **The party follows the player.** Five people walking behind you reads as an
   escort, not as a crew. It also makes "am I alone out here" impossible to
   feel, because you never are.

The cause is that the tutorial was built as an OVERLAY on the existing run
loop, which was the right call for verbs and the wrong one for place. An
overlay can watch events. It cannot make somewhere feel like anywhere.

## Decisions taken (owner may veto)

- **One authored camp map, fixed, identical every time.** The generator stays,
  for basins only. The camp is hand-placed: a dirt path between two or three
  cabins, a thin wood inside the bounds you can wander, and a dense treeline
  as the boundary wall.
- **One continuous session.** The player spawns into the camp once. Stages
  become sequential OBJECTIVES, not separate runs. Nothing remounts.
- **Objectives are places and people, not distances.** Stage 1 is "walk to the
  trainer and stand with him", not "cover 30m".
- **The party is stationary in camp.** Fiction: you woke up late, everybody
  else has already been through this. They stand around. They do not follow.
- **A new verb: CALL.** Bring one companion to you. This is a real game verb,
  not a tutorial affordance — the tutorial may not teach a verb that only
  exists in the tutorial.
- **In the basin, cohesion becomes a CHAIN.** A companion is with the group if
  they are in range of ANY other member, not of the player. Following is gone.

## The hard constraint, restated

**The meter never reaches the screen.** Not as a number, not as a band name,
not as an error message. This blueprint adds two new channels that can leak it
and both are handled explicitly below: the CALL verb's failure, and the ping
interval's length.

## Brain retrieval that changed this design

Five entries materially altered what is written here. This section exists so
that a later reader can tell which choices are reasoned and which are inherited.

- **wrong-sky#E8** — *gate discovery interactables by EFFECT, not existence;
  spawn them always and give the not-yet-active case an explicit in-fiction
  no-op; keep only objective-CRITICAL targets existence-gated.* This splits the
  gating rule in two, where I had one. The pylons are EFFECT-gated: present
  from the first frame, crusted with moss, findable and rememberable, inert
  when pressed. The stage-2 item is EXISTENCE-gated: it does not spawn until
  its objective opens, because an item lying around early is objective-critical
  — picking it up out of order is exactly the accident the pinning discipline
  exists to prevent.
- **dog#E41** — *to make emergent clusters breathe, drive them by DECAY, not
  balance: a balanced inflow/outflow reaches a fixed point and the crowd
  freezes forever.* This is the ping design's biggest hazard. If the ping pulls
  inward exactly as hard as wander pushes outward, the party settles at a fixed
  radius and stays there — which looks like a bug and feels like a leash. The
  ping must therefore be a DECAYING impulse (walk toward the player for N
  seconds, then stop and resume wandering), never a sustained restoring force.
- **cadence-frametick#E1** — *an input-gated cadence must count integer ticks,
  not `cooldownMs -= dt`; the float form makes the discrete-event rate
  frame-rate-dependent.* Both call cooldowns and the ping interval are
  input-gated cadences. They count ticks.
- **opticon#E15** — *a cooldown ability needs TWO gates, "recharged" and "has a
  valid target now", with the cooldown assigned only after every precondition
  passes, so a refused use is free.* Applies directly to CALL.
- **T (resolved): "party cohesion protects the player from the deception the
  game is about."** Already settled once — cohesion must not act as a shield.
  Chain membership decides who hears a call and who can vouch for a survey. It
  must not slow anyone's decline, and it must not be a survivability stat.

## Part 1 — the camp map

A second world source, not a second world generator. `world.js` keeps
`generateWorld(seed)` untouched; a new `camp.js` exports `buildCamp()`
returning the same world shape from a static description.

- Roughly 60% of a basin's extent. Big enough to wander, small enough that the
  treeline is always somewhere you can see.
- A dirt path spine with two or three cabins along it. Cabins are solid
  (blocked cells); the path and the yards are open.
- A thin wood inside the bounds — passable, sparse, somewhere to explore.
- A dense treeline around the whole perimeter, blocking, as the map boundary.
- Two mossed pylons, one on the path and one in the thin wood, so a wanderer
  finds at least one before stage 5 asks about them.
- The party stand in the yard between the cabins. The trainer stands apart, at
  the far end of the path, so stage 1 is a real walk.

Because this map is authored, it does not inherit the generator's guarantees.
It must earn them back with a test: every open cell reachable from spawn by
flood fill, no cabin sealing a pocket, and at least one continuous 30m walk.

## Part 2 — objectives, not stages

`tut` stops being "which run am I in" and becomes "which objective is open".
`applyStage` is deleted. In its place, each objective declares what it OPENS
(what spawns, what becomes live) and what completes it.

| # | objective | opens | completes when |
|---|-----------|-------|----------------|
| 1 | walk to the trainer | — | you stand inside his circle |
| 2 | take what he gives you | the item spawns | you pick it up |
| 3 | make one thing from two | the second ingredient | you craft the ember |
| 4 | hand it to IREN | — | IREN takes it |
| 5 | the pylon takes two | the pylons shed their moss | a pylon fires |
| 6 | call someone over | CALL becomes available | a companion reaches you |
| 7 | ask them both | — | you check in on both named people |
| 8 | the first lie | the lead goes under | a false entry reaches the record |

Note this is now EIGHT, not seven: CALL earns its own objective, and it has to
come before the pylon rather than after, because the pylon is what needs the
second pair of hands. Order is 1,2,3,4,CALL,pylon,ask,lie — the table above
lists the pylon at 5 for continuity with the old numbering and should be
renumbered in implementation.

Between objectives, a line of dialogue you advance. This is new — today a
subtitle fades on its own. A dialogue beat that WAITS is a small system, but it
is a system: it needs a "press to continue" that cannot be satisfied by the
same press that completed the objective, or the beat is skipped invisibly.

## Part 3 — the CALL verb

`call(sim, companionId, caller)`.

Two gates, both checked before any cooldown is spent (opticon#E15):
- the caller's global call cadence has recharged (30s), and
- that specific companion's personal cadence has recharged (120s).

A refused call costs nothing. Both cadences count integer ticks, never
`-= dt` (cadence-frametick#E1).

**The leak, and how it is closed.** A call that cannot land must look
identical to one that will. Same key, same sound, same line — *"You call out
for HALDER."* — whether HALDER is coming, is too far gone to care, or does not
exist. The player learns the outcome from the world: somebody walks out of the
trees, or nobody does. At low lucidity, somebody arrives who is not there.

This means CALL has no failure message, ever. Not "too far", not "no answer".
The cooldown gates are the only refusals, and a refused call is silent and
free.

**Binding.** Every obvious key is taken (E, Q/R, Z, X, C, V, B, F, G, 1-5,
Shift+1-5). Candidates: `T`, or `Shift+F` alongside check-in. On a pad every
face and shoulder button is spoken for; the free inputs are D-pad Left and a
stick click. This is an open question for the owner — see below.

## Part 4 — chain cohesion and the ping

Replaces following entirely.

**Membership.** Build a graph over the party where an edge exists between two
members within `LINK_RANGE` (20m). Anyone in the player's connected component
is with the group. This is a union-find over at most six nodes, run once per
tick — trivial cost, no pathing involved.

**Euclidean, with a caveat.** The link test is straight-line distance, which
means two people can be "linked" through a cabin wall or a rock. On the camp
map this is nearly harmless; in a basin it is a real inaccuracy
(sandbox-distance#E1 makes the general case: on obstacled ground, straight-line
closeness is not reachability). Accepting Euclidean deliberately for now,
because the alternative is a BFS per pair per tick, and because a link through
a thin rock reads as "they're just over there" rather than as a bug. Flagged
here so it is a decision, not an oversight.

**The ping.** Every `PING_EVERY` seconds (15-20), any member beyond
`PING_RANGE` of the player turns and walks toward the player for
`PING_DURATION` seconds (5-6), then stops and resumes wandering. A decaying
impulse, not a restoring force — this is dog#E41's rule, and getting it wrong
produces a party frozen at a fixed radius forever.

**The decline coupling, and its leak.** As a companion declines, their ping
interval stretches — they come back less often and drift further. This is the
tell, and it is a good one: you read someone's condition from how reliably
they come back to you, which is exactly the kind of behavioural evidence this
game wants you reading.

It is also a leak if implemented carelessly. The interval must not be
readable as a number, a bar, or a roster note. It is legible only as a felt
pattern over minutes. Concretely: no HUD element may derive from
`PING_EVERY`, and the roster note must not change wording when it stretches.

**The phantom anchor.** The cohesion check runs over PERCEIVED members. A
hallucinated sixth companion is therefore a valid link in the chain — your
group reads intact, through someone who is not there, while the real party has
already scattered. Nothing extra is needed to build this; it falls out of
reading percept instead of sim, and it is the single best thing in this
blueprint.

**Never show the chain.** No lines, no "connected" indicator, no count. You
infer membership from who you can see and who answers.

## Part 5 — who the party is

Two populations, deliberately different.

**In camp, the party is fixed.** VOSS, IREN, HALDER, NKEM and PAO, with the
trait bundles they have today, in the slots they have today. The tutorial's
authored briefs may keep naming them directly — no slot-reference indirection
is needed, because these five never change. Canonically everyone here is
training; this is the crew you learn on.

**Entering the basin re-rolls the party.** New display names drawn per
campaign, AND the trait bundles shuffled across slots, so the wanderer is a
different person with a different name every run. Ids (`c1`..`c5`) stay stable
as the internal handle; only the name and the bundle attached to a slot move.

Both changes are needed, not one. Renaming alone leaves the roster order
readable — "the third person always lags" survives a rename — so the bundles
must move too, or the table has been relabelled rather than scrambled.

Consequences:

- Both the names and the slot->bundle mapping become save state, rolled once
  through `sim.rng` at basin entry and restored exactly, for the same reason
  traits already are: a resumed party that reshuffles its personalities
  silently invalidates every behavioural tell the player has learned to read.
- The person you trained with is not the person you walk in with. That is a
  feature — it is the moment the game stops being a lesson.
- This is the hook for later systems: recruiting a sixth, losing someone
  permanently, upgrading a trait. All of them need exactly this — a party
  whose composition is data rolled at a known point, not a constant table.

## What must remain UNCHANGED

- `state.js` stays the only source of sim truth; all randomness through
  `sim.rng`; every decision consumes a FIXED number of draws regardless of
  branch, including "no need to roll" boundaries.
- `percept.js` is still the only module allowed to lie, still never mutates.
- The tutorial still OBSERVES. CALL, the ping and cohesion are real game
  systems that exist identically outside the tutorial. No verb behaves one way
  in camp and another in a basin.
- Every teaching step stays pinned to a specific entity id.
- Cohesion does not shield: no chain membership may slow a decline.

## Preflight — what to check before writing code

1. **Does anything else depend on `applyStage`?** It is called only by
   `startStage`, but `tests/tutorial.mjs` asserts against its behaviour and
   `tests/tutorial-play.mjs` drives it. Both need rewriting, not patching.
2. **Does the save payload need a new version?** Objective progress replaces
   stage progress, and the camp is a new world SOURCE — `serializeRun` stores
   `seed` and regenerates from it. A camp run cannot be rebuilt from a seed
   alone, so either the camp gets a reserved sentinel seed that `deserializeRun`
   knows to route to `buildCamp()`, or saves are disabled in camp. Decide
   before touching `save.js`; this is a schema change either way (SAVE_VERSION
   3).
3. **What reads `sim.party` positions assuming a following formation?**
   `party.js`'s `FORMATION`, `formationSlot` and `followSpeed` all become dead
   in a basin. Confirm nothing else — the renderer's culling, the roster, the
   co-op split — assumes companions are near the player.
4. **Does the prompt resolver need a new rung for a mossed pylon?** An inert
   pylon must not surface a prompt at all, or it outranks pickup at its own
   site and starves whatever else is there. Check `VERB_PRIORITY` and the
   resolver's pylon branch together.
5. **Which existing tests encode "the party follows"?** `tests/formation.mjs`
   exists entirely to assert the party is in frame. It becomes wrong, not
   broken — decide whether it is deleted or re-aimed at the chain.
6. **Is 30s/120s actually reachable in a 5-minute calm window?** If the tutorial
   is one continuous session, the calm grace (300s) may expire mid-tutorial.
   Either the camp suspends the clock entirely or the tutorial is a race.

## Verification plan

- **Camp reachability**: flood fill from spawn reaches every open cell; a
  continuous 30m walk exists; no cabin seals a pocket.
- **Objective ordering**: driving the objectives out of order in a browser
  cannot complete a later one early; the stage-2 item does not exist before its
  objective opens; a mossed pylon refuses and emits nothing.
- **CALL**: a refused call spends no cooldown; both cadences are frame-rate
  independent (assert identical fire counts at 16ms and 20ms steps, per
  cadence-frametick#E2 — compare PER TICK, not end state, or a desync hides);
  a call at low lucidity is byte-identical in message and sound to one at full.
- **Cohesion**: a chain of five spaced at 19m all read as grouped; at 21m the
  far end drops; a phantom link keeps the chain intact when the real one has
  broken.
- **Ping**: over a long run the party's spread does NOT converge to a fixed
  radius (the dog#E41 failure) — assert variance, not just mean.
- **No leak**: the HUD's full text contains no band name, no meter word, and
  no CALL failure string, driven through a real browser at low lucidity.

## Still requires a human

- The CALL binding, on both keyboard and pad. Everything obvious is taken.
- Whether eight objectives is too long for an opening.
- Whether the camp reads as a camp, which no test can tell me.
- Whether losing stage 1's "five people holding formation" costs more than the
  late-arrival fiction gains.
