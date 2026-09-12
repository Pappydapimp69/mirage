> # This repository is retired. The work continues in **[SEVEN](https://github.com/Pappydapimp69/seven)**.
>
> MIRAGE and SEVEN were the same game with two names. As of 2026-09-12 seven is
> the single home: the name carries no giveaway about what the game is doing to
> you, and it means something inside the fiction — there is a seventh crew
> member who is a hallucination.
>
> **What moved.** The `serializeRun` live-reference fix (12 of 60 seeds forked on
> resume; 0 after) and the per-world grid refactor were ported to seven. The two
> map enlargements below were NOT: they were sized for a survey-and-return loop
> against a fixed clock, and seven's design replaces that loop with a traverse.
>
> **Do not develop here.** Anything in `docs/` is a frozen record — `IDEAS.md`
> and `docs/WORKING-LIST.md` in particular have live counterparts in seven that
> have already moved on. Read seven's copies, not these.

# MIRAGE

A real-time 3D exploration game: you lead a survey party of six through a
fogged basin. Every mind in the party — yours included — carries a hidden
meter that only counts down, and at zero, that mind starts hallucinating.

> Status: **0.7.x**, playable end to end — title, run, debrief, and a
> campaign you can put down and pick up again. Started life as
> a build inside [Opticon](https://github.com/Pappydapimp69/Opticon) and was
> pulled out into its own repo once it stood on its own (see `docs/adr/`).

## The idea

You lead a survey party of six into a fogged basin: yourself and five companions.
Each of you carries a hidden **lucidity** meter. It only counts down. When one
hits zero, that mind begins to **hallucinate** — and that includes yours.

**The meters are never shown.** Not as a bar, not as a number, not on a hover.
The whole game is reading your party without instrumentation:

| What you see | What it means |
| --- | --- |
| someone lags behind | fraying |
| someone goes quiet who is normally chatty | fraying, and hiding it |
| "the ridge moved, I watched it move" | fraying, and not hiding it |
| someone breaks formation and walks off | brittle, heading for a pylon |
| someone tells you a marker is right here, and it isn't | gone |

You can **check in** on any companion. A fraying one shades it optimistic (the
stoic ones most of all). One who is gone will tell you they are fine, with
complete conviction. So a check-in is evidence, never proof.

And when **your** meter hits zero, the screen stops being a witness:

- markers appear where there is nothing
- a sixth companion joins the formation and keeps station
- spent pylons glow like full ones, and a pylon appears that was never built
- north stops being north
- every companion agrees with you about everything

Logging a marker while gone, with nobody lucid at your shoulder, writes a
**false entry**. It looks exactly like a real one in the log. It counts for
nothing at extraction.

## Goal

Find and survey all **six** markers, then get back to **camp** with at least two
companions still walking with you. Markers are not on a map — the party has to
sight them through the fog, so anyone still with you is another pair of eyes.

Relief comes from **pylons**: stand inside one and everyone in range comes back
up. They spend charge while in use and recharge while left alone, so you cannot
camp in one. Three **lumen doses** exist, for six people, and you have to pick
who gets one without being able to see who needs it most.

You lose to **darkness** (the light runs out) or to **dissolution** (all six of
you hallucinating at once, long enough that nobody is left to notice).

## Play

Static site, no build step, fully offline (Three.js is vendored in `lib/`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

### Controls

The on-screen legend adapts live to whichever device is actually in your
hands — the summary below is complete, but you never have to remember it, the
UI reshapes itself around your controller/keyboard/touch as you switch.

| | Keyboard/mouse | Gamepad | Touch |
| --- | --- | --- | --- |
| move / run | `WASD` · `Shift` | left stick · click it / `RT` | left half of screen |
| look | mouse (click to capture) | right stick | right half of screen |
| survey a marker | `E` | `A` | Survey button |
| check in | `1`–`5`, or `F` on the selected | `X` | Check in button |
| lumen dose | `Shift`+`1`–`5`, or `G` on the selected | `Y` | Dose button |
| select companion | `Q` / `R` | `LB` / `RB` | Next button |
| pause | `Esc` | `Start` | — |

Menus (title, pause, debrief) are fully navigable on every device too: arrows/WASD
or D-pad/stick to move focus, Enter/Space or `A`/`Start` to confirm, `Escape` or
`B` to back out of pause.

## Structure

```
index.html          title / HUD / pause / debrief shells
css/style.css       overlay styling (contains no meter — by design)
lib/three.module.js vendored Three.js (self-contained single-file build)
src/
  rng.js            seeded determinism: a seed describes a whole run;
                    snapshot()/restore() carry the raw state word for saves
  save.js           run snapshots -> localStorage (the world is NOT saved; it
                    is regenerated from the seed and the delta applied over it)
  world.js          basin generation + the connectivity repair pass
  state.js          THE SIM — lucidity, hallucination, pylons, endings
  party.js          the five companions: follow, break, wander, talk
  percept.js        the ONLY module allowed to lie
  render.js         Three.js scene, drawn from perception
  hud.js            DOM overlay, drawn from perception
  input.js          keyboard/mouse/touch/gamepad -> one intent object,
                    one persistent instance for the app's whole lifetime
  audio.js          synthesised ambience; no assets
  main.js           wiring, menu grid nav, frame loop
tests/
  logic.test.mjs    pure-logic assertions, no browser
  save.test.mjs     save/resume round trip + forward-divergence check
  hallucination.test.mjs
                    OBSERVED-rate floors and strobe ceilings for the tells
  resume.mjs        real browser: play, leave, resume, discard-guard
  menu-nav.mjs      real browser: focus over a menu whose shape changes
  campaign.mjs      real browser: basin -> basin, and the save across it
  balance.mjs       whole runs to a terminal state; completability oracle
  smoke.mjs         real Chromium: draws, drains, hallucinates, recovers
  gamepad.mjs       real Chromium + a fake Gamepad object: full menu +
                    in-run nav on a controller alone
  run-all.sh
tools/
  stamp-version.mjs put ONE cache-bust token on index.html AND every
                    relative import in src/ — see "Deploying" below
docs/adr/           why this repo looks the way it does
```

### The one architectural rule

`state.js` keeps an honest record. `percept.js` is the only place that may
distort it. `render.js` and `hud.js` read **perception**, never the sim.

That is what makes the hallucination testable: a phantom marker arrives in the
same list as the real ones, so the renderer needs no special case, and a test can
assert "a hallucinating lead is shown a marker the basin does not contain"
without booting a browser. The corresponding invariant — perception never mutates
the sim — is asserted in the test suite.

The one real number in the game is revealed exactly once, in the **debrief**,
after the run is over.

### Device-adaptive UI

`body[data-scheme]` tracks whichever input device is currently active
(`keyboard` | `touch` | `gamepad`) and the on-screen UI reshapes around it live:
touch buttons appear only while touch is active, and gamepad hints render as
coloured A/B/X/Y badges instead of plain letters — the player should never have
to translate "the button that looks like this" into a word.

## Saving

The run autosaves every 5 sim-seconds and on tab hide/close. The title screen
offers **Resume run** when a save exists; **New run** then needs two presses,
so a campaign can't be discarded by muscle memory.

Only the mutable delta is stored — the basin is a pure function of its seed, so
a resume regenerates the world and applies what changed over it. Two rules the
schema is built around:

- **The rng is restored from its raw state word**, not by replaying draws.
  Anything that *gates* an rng draw is therefore save state too, however
  cosmetic it looks: `sightTimer`, `remarkCooldown`, `repathTimer` and a
  companion's cached `path` all decide *which tick* a draw happens on, and
  leaving them out produced a resume with identical positions and meters and a
  silently different rng stream — invisible for minutes, then a different basin.
- **An ended run is never saved.** Resume can't hand back the frame you lost.

Couch co-op is deliberately not restored: a resume comes up solo and player two
rejoins with a pad press. Reviving a slot for a controller that may not be
plugged in produces a companion nobody is driving, which reads as a frozen party
member rather than a lost slot.

## Deploying

`index.html` is loaded with a `?v=` token, but **ES module imports do not
inherit a query string** — `import "./percept.js"` is its own cache entry. An
entry-point-only bust therefore refreshes `main.js` and serves every other
module from cache, which looks exactly like "the fix didn't work" and gets
re-diagnosed as a phantom logic bug.

So bump versions with the tool, never by hand:

```bash
node tools/stamp-version.mjs 0.7.6   # index.html + BUILD + every src/ import
```

Commit **everything it touches in one commit**. A partial stamp means
`main.js` imports `./state.js?v=NEW` while `percept.js` imports
`./state.js?v=OLD`, and the browser loads state.js twice as two module
instances. `logic.test.mjs` asserts both invariants (every import carries the
current token; exactly one token is live anywhere).

## Tests

```bash
tests/run-all.sh          # everything
node tests/logic.test.mjs # pure logic, fast
node tests/balance.mjs 20 # whole-run simulations
node tests/smoke.mjs      # real browser (needs Playwright + Chromium)
node tests/gamepad.mjs    # real browser, gamepad-only playthrough
node tools/verify-deploy.mjs   # walk the LIVE site's module graph
```

A third lesson joined the two below, from the hallucination work: **a
mechanism that fires correctly but off-screen has not fired at all.** The
monster-flicker feature was covered by a passing test that forced the roll and
stood a companion five units away — it proved the mechanism and said nothing
about the rate, which was one visible flicker per ~110 seconds of hallucinating.
Anything whose purpose is to be *perceived* needs its observed rate asserted
from both sides: a floor (the player does see it) and a ceiling (it is not a
strobe).

Built around two lessons:

- **No assertion is phrased in wall-clock seconds.** Headless rAF runs at a
  fraction of real time (measured at 8–10 fps under software GL), so
  "wait 3s, expect 3s of drain" is a flake. Tests drive the sim's own clock
  through `window.__mirage.advance(seconds)` and assert on `sim.time`.
- **"It loaded and nothing threw" is a false green for 3D.** Software GL will
  happily load a scene that draws nothing, so the smoke test asserts on Three's
  own draw-call and triangle counters — and reports SKIP, not PASS, when the
  environment has no WebGL at all.

`balance.mjs` is a **completability** oracle, not a difficulty oracle. The bot
reads the sim's truth directly, so the hallucination layer — the entire
difficulty for a human being shown things that are not there — costs it almost
nothing. Its win rates say the basin can be surveyed and returned from; they say
nothing about how hard that is to do.
