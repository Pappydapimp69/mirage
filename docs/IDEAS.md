# Ideas — a place to put things before they get lost

Raw capture. Nothing here is committed to, planned, or designed. An entry
existing is not a decision to build it.

**This is not Brain.** Brain holds *verified lessons* and *portable kernels* —
things that earned their place by being confirmed. This file holds unverified
sparks, half-thoughts and "what if", including ones that turn out to be bad.
Something graduates from here into Brain (or into a blueprint) only after it
has been thought through and, where it makes a claim about behaviour, tested.

## How to add one

Append to the top of the list. Keep it short — enough to rebuild the thought
later, not a spec. Date it so a stale idea is obvious.

    ## YYYY-MM-DD — short title
    Whatever the thought was, in as few lines as it takes.
    (optional) Why it came up / what prompted it.

Leave it alone after that. Editing an idea into a plan is what blueprints are
for; the value of this file is that writing in it costs nothing.

## Status markers (optional)

- `[open]` — untouched, the default; assume this if unmarked
- `[building]` — has a blueprint or is being worked on
- `[dropped]` — considered and rejected; keep the entry and say why, so it
  does not get re-proposed from scratch in six months
- `[graduated]` — became a blueprint, an ADR, or a Brain entry; say which

---

## 2026-08-28 — THE WOODS: full design note  [building — forked to its own repo]

Worked out in conversation. This supersedes the two entries below it, which are
kept because they show how it got here. Everything here is design, not code.

**Status.** Being built as a FORK of mirage, not on top of it. mirage is the
bones — sim/percept separation, the party, the verbs, the save discipline, the
test harness. This adds organs. A fork so that a failed organ cannot break a
working skeleton; the two are not expected to merge back.

### The shape

You set out to walk a trail through the woods and come out the other side. That
is what the game tells you. It never says anything else, right to the end.

What it is actually about is who walks out with you.

### The map, and hallucination as geography

ONE large persistent map, not levels. Hallucination is a ZONE centred on the
middle of the woods, in rings, strongest at the heart. Depth is the difficulty
dial and the player sets it with their feet. This replaces a countdown entirely:
the hidden meter becomes a PLACE, which is legible without any HUD — the thing
the original game fought with constantly.

Nothing is walled off. Progress is gated by TIME: a fallen tree across the path
needs cutting, cutting takes hours, hours are daylight. You can always go
further; you may not get back before dark. The boundary is self-imposed.

### Days

A day is the unit, not a level. You wake, you have daylight, you decide what to
spend it on, you sleep when you choose and that ends the day. Night raises the
hallucination rate substantially. There is a grace period in in-game hours at
the start of a day, mirroring the existing LUCIDITY_GRACE.

Day one is deliberately quiet: hike in, make camp, gather, craft, explore. No
hallucination effects. A baseline, so that later wrongness has something to be
wrong against.

### Pylons, reworked

NOT a reset. A pylon lights a local zone that SLOWS the fill rate — terrain
modification, not a heal. Small immediate reduction, a pause of a few in-game
hours, then a burn-down (blue -> red) and death. You cannot camp one forever;
it buys roughly a day in an area.

Which makes pylons a ROUTE. A chain of lit pylons is a corridor into the centre,
and it rots behind you as you go. The question stops being "am I safe here" and
becomes "how far ahead of my own supply line am I."

A pylon is also the one HONEST instrument in the game — everything else you are
told comes through a person or your own eyes. A pylon burns down on a schedule
and does not lie. (Consistent with the existing rule that a far-gone mind sees
dead pylons as live: even the honest instrument stops being honest exactly when
you need it.)

Pylons are discovered, never explained. The first one appears a few days in,
often because a companion calls you over to look at something neither of you
understands. It is evidence before it is a tool.

### The party, and why you care

At the start you RECRUIT a team and SPEND POINTS on their skills (logging,
etc). You choose who matters. The game never tells you who is important — you
decided, and that is what makes losing them personal.

Specialisation is a difficulty dial the player sets without realising:
concentrate ten points in one logger and you move fast and are one disappearance
from crippled; spread them and you are resilient but slow, and slow means more
nights, and nights are where the hallucination lives. No dominant answer.

Names are generated per run by SYLLABLE COMPOSITION (~30 fragments with
adjacency rules), never picked from a list. Seeded from ONE run seed — never
from device state. The whole codebase is built on the world being a pure
function of the seed; a run must stay saveable, resumable and reproducible.

Tutorial characters are separate people (canonically everyone in training is
being trained to LEAD a team, so they scatter). Their names may be reused for
fakes, which gives a diegetic reason a fake is better at the job. Constraint: a
fake carrying a trainee's name cannot then be brought home, or two people share
a name.

### The day everyone vanishes — the keystone

Early on, you wake and the roster is EMPTY. You wander. As you come back into
range they repopulate one at a time, in a different order than they left.

Some of them are, some are not. You will never know which.

This one scripted event does the work a whole system was being invented for:
from that morning, no certainty about anyone is available, and every later doubt
is legitimate. Nothing has to announce itself again, ever.

### Disappearance and return

Nobody teleports. A member who went under WANDERED OFF in the night and is still
out there on the map. What is at your fire is something that took the empty slot.

- The replacement has the SAME NAME and the SAME SKILLS. It must be competent —
  if a fake is bad at the job you identify it with a stopwatch and the game is
  over.
- Nothing is announced. The tell is that NOBODY ELSE FINDS IT STRANGE. The
  other members behave normally; a check-in has them recounting yesterday as
  though the newcomer was there. A player who spots a new name learns nothing;
  a player who notices that nobody else noticed has found the horror.
- The missing one CALLS OUT AT NIGHT, from a distance. Recovery costs the hours
  you least want to spend outside.
- Going out, you ALWAYS find a pylon; whether you also find THEM is a chance,
  weighted by things you controlled (how many nights they were out, how deep,
  whether you went the same night).
- The window is spatial. They can be found in this area or the next, never
  further back. So WALKING FORWARD IS HOW YOU ABANDON THEM — no prompt, no
  confirmation, you just make progress one day too many.
- Holding a fake raises the chance of losing another. One at a time.

### Investigation — the middle game

The verb is CHECK-IN, which already exists. You ask someone about a day you both
lived through.

The account is DERIVED FROM THE REAL EVENT LOG, never authored. A real one
recounts it correctly. A fake's account is generated from the same log with ONE
FACT PERTURBED — wrong order, wrong weather, a name slightly off. Because the
days vary, the tells vary; authoring a list of tells is the mistake that would
kill this by run ten.

Asking costs daylight, which is the thing you never have enough of.

Skill is deliberately useless as evidence. Memory is the only evidence, and only
you have it, because you were there.

### Acting on a conclusion

Suspicion needs a verb or the investigation dead-ends. The verb is the pylon:
bring who you doubt, light it, and a hallucination does not survive it.

- Right: they are gone. Cost — a pylon, their skills, and a walk to the next one.
- Wrong: nothing happens. Cost — the pylon anyway.

You cannot test everyone. Every pylon spent on a person is one not spent on the
fill rate. And the fake logger is BETTER at logging, so proving it means giving
up the better worker — you may decide you would rather not know.

### The ending

The centre of the woods holds the exit: pylons that send you home, back to the
training ground you started in — closing the loop on the mossed, unexplained
pylon from the tutorial.

THE COUNT. There is one more pylon than you have real people. You see the count
on arrival. It tells you HOW MANY, never WHICH — so it does not answer the
question, it destroys your confidence and then makes you choose anyway.
Arriving convinced your team is whole and seeing three pylons instead of six is
the best moment in this design.

EVERY ATTEMPT SPENDS THE PYLON, success or failure. So you get exactly ONE
mistake. Not a game over — one wrong guess, spent at the moment you are most
rattled. Guess wrong twice and someone real stands there with nothing left, and
you walk out having abandoned a person you were right about.

A pylon takes TWO, which the tutorial taught on day one. A hallucination cannot
be the second pair of hands. It was the ending all along.

If every one of them is false you can still walk out — alone, last pylon dark.
That is an ending, not a failure screen.

### Runs, not a campaign

15-20 minutes per run. The first several end at the centre, which will feel like
the end of the game. It is the extraction point: bank who you have, or push on.

WHOEVER COMES HOME WITH YOU RETURNS A FRACTION OF THEIR INVESTED POINTS to a
shared pool. So the score is not distance — it is who you saved. The mechanics
and the theme finally point the same way, and each run reaches further because
the team is better, until eventually a run reaches the far side.

### The one real risk

Deduction erodes under repetition. Per-run party generation and log-derived
tells are what protect it. If the tells ever become a hand-written set, the game
is dead by run ten. Decide this early — it shapes how investigation is built.

### The alpha to build first

Everything above except one part is known-good machinery from other games. The
unproven claim is: CAN A PLAYER CATCH A FAKE BY ASKING ABOUT A SHARED DAY, AND
DOES IT FEEL LIKE DEDUCTION RATHER THAN A COIN FLIP?

Smallest thing that answers it:

- one short scripted day, fixed camp, a handful of events you are present for
- overnight, one member swapped — same name, same skills, no announcement
- next morning, ask anyone about yesterday; accounts derived from the event log,
  the fake's with one fact perturbed
- name who you think it is; it tells you whether you were right

No map, crafting, days, pylons, recruitment or progression. If that is not fun,
none of the rest matters.

## 2026-08-28 — replay your own actions back at yourself: the phantom possesses, it does not appear  [open]

Follow-on from the investigation idea, after learning the phantom is only ever
an episode today and making it permanent would be a large change. This gets the
same effect without ever adding a seventh body.

**The move.** Never add a seventh entity. Instead, the phantom POSSESSES an
existing member — one, or two, or three — and the tell is that a possessed
member does not replay what you actually did.

**How it works across levels.**

- Basin one is ordered, like the tutorial: gather wood, then stone, then build
  a fire, then a tent, then go activate something. A given sequence, done in
  order.
- Basin two you play as a DIFFERENT member, walking through the same events —
  their account of the same day.
- Everyone else in that level replays what they did the first time round. The
  character you played as in basin one should now be a bot repeating YOUR
  actions: going where you went for the wood, coming back to build the fire, in
  the order you did it.
- Where a member has been possessed, the replay is subtly wrong. They fetch
  stone before wood. They pitch the tent before the fire. Nothing announces
  itself; the order is just not what you remember doing.

**Why this is the good version.** The player is the recording. You are not
comparing two accounts the game hands you — you are comparing the game's
account against your own memory of a level you personally played. That makes
the evidence something the game cannot fake and cannot hand you by mistake, and
it means no HUD, no log and no meter is involved at any point.

It also solves the thing that started this: a possessed member behaves like a
member. They are not broken, they do not fail to answer, they are not
identifiable by anything not working. They are only identifiable by being out
of order.

**What it needs, and none of this exists yet.** A recording of the player's
action sequence per level, kept in the save. A replay driver that can make a
companion re-perform a recorded sequence rather than run its own AI. A
per-level ordered objective list for the basin, which the tutorial now has a
working shape for. Some notion of the same events being replayable from another
member's viewpoint.

**Open questions.** How exact the replay has to be before "different" reads as
deliberate rather than as the AI being loose. Whether the player will actually
remember an order from a level or two ago without a crutch — and whether giving
them a crutch destroys it. What happens if the player does the first level in a
weird order, or badly. Whether a possessed member should ever be right by
coincidence.

## 2026-08-28 — MIRAGE as an investigation: play the party one at a time, find who was never there  [open]

Came out of asking how the balance bots are set up, and noticing the phantom
sixth companion is a problem in normal play rather than just a stat.

**The problem that started it.** A hallucinated companion who is always present
and never works is either solved instantly or is just irritating. You call them,
they do not come; they never confirm a pylon. Within a level or two the player
knows which one is fake and there is no mystery left — and until then it reads
as the game being broken, not as the game lying. A permanent unreliable
teammate is a bug the player learns to route around.

**The idea.** Stop making the fake one detectable by behaviour, and make finding
them the actual game.

- You play as ONE named character for a level or two, not as a generic lead.
  The whole party is present, phantoms included, and the phantom behaves like a
  real member — maybe slightly less reliable, but not obviously broken.
- Then you switch and play through as a DIFFERENT member of the party, and go
  through their version of events.
- Each perspective legitimately differs — different people saw different things
  — so disagreement alone proves nothing. That is the point.
- Eventually you play as the hallucinated one. Their level looks correct: same
  map, same gameplay. The tells are small and textual — a teammate's name
  spelled differently (Stephanie / Stefanie), trees slightly wrong, small
  omissions in the account.
- The object becomes: reconstruct who was actually there. Possibly more than
  one was not.

**The other half — days instead of a clock.** Instead of lucidity being a timer
that runs down every level, a level becomes a DAY:

- Clear an area: activate one or two pylons, then make camp.
- Making camp lets the party rest and ends the day.
- Waking up starts the next day, and the hallucination pressure steps up.
- The campaign is something like ten days before the hallucinated member takes
  the whole party.
- So pylons and camps stop being "turn on the lights, walk A to B" and become
  the thing that SLOWS how fast the hallucination spreads. The race is against
  takeover, not against a clock.

**Why it might be worth doing.** It reframes the loop from "complete objectives
before a meter empties" to "work out what is true before it stops mattering",
which is what the deception layer was always for. It also gives the phantom
somewhere to go other than being an annoyance.

**Open questions, not answered here.** How a rest/camp verb interacts with
pylons firing once. Whether per-character playthroughs mean per-character saves.
Whether "play as the phantom" is a twist that only works once. Whether multiple
fakes is legible or just noise. How much of the current basin loop survives.
