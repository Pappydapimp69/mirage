// state.js — the MIRAGE simulation. Pure logic: no DOM, no Three, no audio.
// The browser build and the Node test suite run this exact file.
//
// THE ONE IDEA
// Six minds walk into the basin: you and five companions. Each carries a hidden
// LUCIDITY meter that only counts down. At zero, that mind begins to hallucinate
// — and the game never shows you the number. You are meant to read your party,
// not a bar. Companions volunteer remarks and answer check-ins; a fraying one
// shades the truth, a gone one states falsehood with total confidence. And when
// YOUR meter hits zero the lie moves into the renderer itself: markers that
// aren't there, a sixth companion, a pylon that gives nothing back.
//
// So every source of information in the game can be wrong, including the screen.
// The sim's job is to keep an honest, testable record of what is TRUE; `percept.js`
// is the only place allowed to lie about it.

import { generateWorld, worldToCell, cellToWorld, moveWithCollision, isBlockedAt, CELL, ITEM_KINDS, FEATURE } from "./world.js?v=mirage-0.13.1";
import { makeRng } from "./rng.js?v=mirage-0.13.1";
import { updateCompanions, companionRemark } from "./party.js?v=mirage-0.13.1";

export const PARTY_SIZE = 6; // you + 5 companions — the spec's five NPCs, plus the player
export const MAX_LUCIDITY = 100;

// --- tuning -----------------------------------------------------------------
// Aimed at making a careful route through the pylons beat a straight dash for the
// markers, and measured rather than asserted: `tests/balance.mjs` currently reports
// careful 88% vs reckless 75% on standard over 8 seeds — directionally right, and a
// small enough gap that it should not be quoted as settled. Note the harness bot
// reads the sim's truth, so none of these numbers price the hallucination layer.
// NOT tuned against tests/balance.mjs. Tightening the formation removed most of
// the isolation drain the game used to collect (that multiplier is measured from
// the party CENTROID, and a scattered party was paying it on several people at
// once), and the obvious response was to raise this until the harness bot
// started losing again. That response is invalid, and the harness says why in
// its own header: the bot reads the sim's truth, so it is never shown a marker
// that isn't there and never believes a companion who is wrong. It is a
// COMPLETABILITY oracle and nothing else. Tuning drain until an omniscient bot
// struggles sets the rate for a player who cannot be deceived — and then hands
// it to one who can. See tests/balance.mjs's `deceived` policy for the only bot
// in here whose win rate is allowed to inform this number.
export const BASE_DRAIN = 1.05; // lucidity/second at rest, before modifiers
// An orientation window, in two parts: a hard freeze where NOTHING moves, then
// an ease-in to full drain. `sim.time` resets to 0 at the top of every level
// (see createRun), so both are measured per-basin.
//
// This started as a flat 300s freeze — a literal "five minutes before the
// meter moves". Measured, that turned out to disable the game rather than
// gentle its opening: a basin is completable in ~270s, so the ENTIRE typical
// run fell inside the window. The balance harness returned byte-identical
// results for careful, reckless AND bleak (75%, 268.6s, same markers found),
// because with no drain anywhere the difficulty multiplier has nothing to
// multiply. It also cut companion hallucination episodes from 0.88 to 0.21 per
// run — which is the same "nobody else seems to hallucinate" the player
// reported, caused by the fix for the other thing they reported.
//
// So: a real settling beat where the meter genuinely does not move, then
// pressure arriving as a slope rather than a cliff, reaching full while a
// normal run is still going.
//
// Retuned after the first real play session, which reported the opening as
// "too punishing" and asked for a longer calm. 45s/180s -> 90s/240s halves the
// pressure a careful run actually pays (party-seconds-lost 81 -> 34) while a
// reckless one still pays 135, so the tiers keep their order and the game
// keeps its teeth. Full drain still lands at 4:00, inside a real run.
//
// Measured at the previous numbers (n=40 where available):
//   * the pressure tiers order correctly again, by party-seconds-lost —
//     gentle 25, careful 55, bleak/careful 99, reckless 122, bleak/reckless 234
//   * companions break again: 4.75 episodes and ~237 gone-seconds per basin
//     over a realistic 420s run, against 0.21 episodes under the flat 300s
//   * a controlled zero-grace run gives bleak/careful 25%, matching the
//     pre-grace game — so the collapse really was the window, not the
//     companion-behaviour changes that landed alongside it
//
// Win RATES stay high across tiers here, and that is expected rather than a
// miss: balance.mjs's bot reads sim truth and is blind to the hallucination
// layer, so it is a completability oracle, not a difficulty one (T23). It
// finishes a basin in ~180s; a human being lied to takes far longer and meets
// much more of the full-drain phase. party-seconds-lost is the honest tier
// signal here, and it separates cleanly.
//
// To go back to a flat "nothing for N seconds", set LUCIDITY_RAMP to 0 and
// LUCIDITY_GRACE to N — but re-run tests/balance.mjs and check the tiers are
// still distinguishable, because at N=300 they were not.
export const LUCIDITY_GRACE = 300; // five dead-calm minutes: no drain at all
// Then it just goes down. No ramp: the earlier easing existed to soften a start
// that is now a flat five minutes of nothing, and a slope you cannot feel is
// not a mechanic. After the calm, the meter falls at a constant rate for the
// rest of the basin and the only thing that interrupts it is a pylon.
export const LUCIDITY_RAMP = 0;
/** The moment drain reaches its full rate. Tests that want normal drain use this. */
export const FULL_DRAIN_AT = LUCIDITY_GRACE + LUCIDITY_RAMP;

/**
 * How much of the normal drain rate applies at time `t`. 0 through the freeze,
 * then linear to 1. Kept as a pure function of the clock so it is trivially
 * testable and so nothing else has to know the shape.
 */
export function graceMultiplier(t) {
  if (t < LUCIDITY_GRACE) return 0;
  if (LUCIDITY_RAMP <= 0) return 1; // no easing: the calm ends and the fall begins
  const into = t - LUCIDITY_GRACE;
  return into >= LUCIDITY_RAMP ? 1 : into / LUCIDITY_RAMP;
}
export const ISOLATION_DIST = 13; // units from the party centroid before you count as alone
export const ISOLATION_MULT = 1.9; // walking off alone burns you down fastest
export const CONTAGION_DIST = 9; // seeing someone come apart costs you
export const CONTAGION_MULT = 0.28; // per hallucinating neighbour in range
export const SCAR_MULT = 0.16; // per prior recovery — coming back costs something
export const PYLON_RADIUS = 12;
// A pylon fires ONCE. Standing in one puts a chunk of light back into every
// mind inside it and holds their decay off for PYLON_PAUSE seconds — and then
// that pylon is dead for the rest of the basin. It does not recharge. There is
// no second visit.
//
// Two earlier models are worth not going back to. Continuous restore while you
// stood inside made a pylon an off switch: park the party, wait, walk out full.
// A charge pool you could draw from repeatedly made it a slow off switch, and
// put the whole balance on a cliff edge between "camp forever" and "unwinnable"
// (measured: a four-point change in draw cost took the deceived bot from 92% to
// 25%). One shot removes the knob entirely — the basin holds exactly as much
// relief as it has pylons, and the only question left is WHEN you spend each
// one and WHO is standing close enough to catch it.
//
// That last part is the point. Because the pulse takes everyone inside the
// radius at once, a pylon rewards having the party gathered when you trigger it
// — which is a real decision rather than a resource to grind.
export const PYLON_DRAW = 55; // lucidity returned to each mind in the pulse
export const PYLON_PAUSE = 10; // seconds of held-off decay the pulse buys
// How long a primed pylon waits for a second pair of hands.
//
// TWO minds have to set hands on the same pylon, in range, inside this window,
// or nothing happens. That second person is not a difficulty tax — they are the
// SANITY CHECK. A hallucinating lead is shown pylons that do not exist and
// spent ones that look full, and until now those fired exactly like real ones:
// the deception simply did not reach the game's most important object. It does
// now, and the way you find out is that nobody joins you. A companion cannot
// confirm a pylon that is not there, because companions act on the basin rather
// than on your picture of it.
//
// It also gives cohesion a job that ISN'T armour. Corroboration was removed as
// a passive shield against the lie; this is the same party, spending the same
// closeness, on something they have to actually do.
// LONGER THAN IT TAKES CALLED HELP TO ARRIVE. 14 seconds was right when the
// second pair of hands was already standing beside you; with cohesion they have
// to walk, and CALL_DURATION gives them 25 seconds to do it. A prime that
// expires at 14 means the mechanic that creates the need (a pylon takes two)
// and the mechanic that answers it (call someone over) actively contradict:
// help arrives to find the prime already gone, every time, and the basin's only
// renewable relief becomes unreachable. Measured: the deceived bot's win rate
// fell to 0% and it burned pylon after pylon priming them alone.
export const PRIME_WINDOW = 32;
export const DOSE_COUNT = 3; // "lumen" ampoules — the whole supply, for six people
export const DOSE_RESTORE = 70;
export const RECOVER_AT = 45; // lucidity a mind comes back to after hallucinating
export const RECOVER_TIME = 2.5; // seconds inside a pylon needed to pull someone back
export const SIGHT_RANGE = 38; // how far into the fog a marker can be picked out
export const LOG_RADIUS = 5.0; // how close you must stand to log a monolith
export const CORROBORATE_RADIUS = 11; // a companion this close can confirm what you see
// How long a companion will stand behind what you showed them, after you ASK.
//
// Corroboration used to be ambient: any lucid body inside the radius silently
// vouched for every entry you wrote. Measured, a lucid companion was at the
// lead's shoulder for 75% of all hallucinating seconds, so the party was
// blocking three quarters of every false entry the game could produce — and
// dropping the radius to 0 raised false logs from 23.8 to 260.1 per run without
// moving the win rate by a single seed. Holding formation had become a
// permanent, invisible, unspendable shield against the deception the game is
// about.
//
// Now it is a VERB. You have to turn to someone and ask, and their answer only
// covers you for a little while — long enough to ask and then walk to the
// marker together, nowhere near long enough to ask once at camp and be covered
// all day. Standing near people is not the same as checking with them.
export const VOUCH_WINDOW = 18;
export const DISSOLVE_TIME = 10; // seconds with all six gone before the party dissolves

// --- items -------------------------------------------------------------------
// A found item is not automatically what it appears to be. state.js only ever
// records the TRUE kind of a real pickup; percept.js is where a hallucinating
// lead's own item bar can lie about it — see perceivedInventory(). A pickup made
// WHILE hallucinating can additionally be a PHANTOM: `real:false`, nothing behind
// it at all. Both cases resolve their surprise at USE time, never at pickup —
// the whole point is that you don't find out until you reach for it.
export const ITEM_CAP = 3; // carried at once — forces the same "which do I keep" choice as doses
export const ITEM_PICKUP_RADIUS = 3.2;
export const ITEM_SIGHT_RANGE = 15; // smaller than SIGHT_RANGE — these are ground clutter, not standing stones
export const ITEM_INFO = Object.freeze({
  flare: { label: "Flare", restore: 40 }, // used on self: instant partial lucidity restore
  tether: { label: "Tether", steadyMult: 0.35, steadySeconds: 60 }, // used on the selected companion: steadier for a while, not a cure
  lens: { label: "Lens", clearSeconds: 25 }, // used on self: the SCREEN tells the truth for a while, even if you're still gone
  // Crafted only — never spawn in the world (see CRAFT_RECIPES below). Each
  // does BOTH parent effects at once: the payoff for spending two carried
  // slots and a craft action instead of using the pair separately.
  ember: { label: "Ember", restore: 40, steadyMult: 0.35, steadySeconds: 60 }, // flare + tether
  beacon: { label: "Beacon", restore: 40, clearSeconds: 25 }, // flare + lens
  ward: { label: "Ward", steadyMult: 0.35, steadySeconds: 60, clearSeconds: 25 }, // tether + lens
  // Crafted from raw materials, not other items — see STAKE_COST/craftItem.
  // Using it doesn't affect the player directly at all; it plants a pylon.
  stake: { label: "Stake", charge: 60 },
  // Spawns in the world exactly like flare/tether/lens — it is a REAL pickup,
  // never a phantom — but it does nothing at all when used. Not every find is
  // useful; a hallucinating lead can just as easily mislabel a real Husk as a
  // Flare as the reverse (see percept.js perceivedInventory/perceivedWorldItems).
  husk: { label: "Husk" },
});
// A phantom item's use is always a bad surprise — there is no real effect to
// fall back on, so reaching for it costs you instead of rewarding you.
export const PHANTOM_ITEM_COST = 8;

// Unordered-pair recipes: combine any two of the three base pickups into one
// stronger, craft-only item. Keyed by the two kinds sorted and joined, so
// order never matters at the call site (see recipeKey below).
export const CRAFT_RECIPES = Object.freeze({
  "flare+tether": "ember",
  "flare+lens": "beacon",
  "lens+tether": "ward",
});
export function recipeKey(a, b) {
  return [a, b].sort().join("+");
}

// --- raw materials -----------------------------------------------------------
// Trees and stone deposits are always exactly what they look like — there is no
// deception layer here at all, unlike carried items. A tree cannot be a phantom
// and a hallucinating lead cannot be shown the wrong kind of node, because
// nothing about "this is a tree" is ever in question; the lie only ever lives
// in what an ITEM claims to be once it's in your hand. That is also why
// render.js is allowed to read sim.trees/sim.stones directly instead of going
// through percept.js — the same exception camp itself already gets.
export const GATHER_RADIUS = 3.2; // same reach as an item pickup
export const RESOURCE_SIGHT_RANGE = ITEM_SIGHT_RANGE; // same ground-clutter sighting distance as items
// A chop/mine takes a deliberate hold, not a tap — long enough to feel like
// real effort, short enough not to be a chore. Releasing early or switching
// to a different tree/deposit resets progress to zero; see updateGatherHold.
export const GATHER_HOLD_TIME = 1.2;
// A bare-handed chop/mine yields a small random haul rather than a flat one —
// a tree or deposit is worth reaching for on its own, not just as a Stake fee.
export const GATHER_YIELD = Object.freeze({ min: 2, max: 3 });
// 2 wood + 2 stone -> one Stake (a carried item like any other; see useItem's
// "stake" case). With 5 of each per basin that's at most 2 stakes a run,
// scarce enough to matter, not so scarce it's never worth reaching for.
export const STAKE_COST = Object.freeze({ wood: 2, stone: 2 });

// A short campaign: winning a basin before the last one advances to a fresh
// basin instead of ending the run — see checkEndings(). Callers that don't
// know about campaigns (tests, the balance harness) get campaignLength=1 by
// default in createRun(), which keeps checkEndings' old single-basin "won"
// path exactly as it was; only main.js opts into the multi-basin campaign.
export const CAMPAIGN_LENGTH = 3;
// Seconds of daylight. Finite, so a run cannot be salvaged by camping in a pylon
// forever (otherwise a dominant and extremely boring strategy) — but set from
// measurement rather than taste. The intended pressure is the party's minds, not
// the clock, and at 600s the balance harness showed careful play losing 67% of
// runs to darkness with 5.7 of 6 markers already logged: the clock was deciding
// runs that the design wants the party to decide.
//
// Caveat on that evidence, kept deliberately: it was measured BEFORE the
// movement-basis fix, which made the party actually form up behind the lead and so
// changed both isolation drain and marker sighting. On current code careful play
// ends dark in 1 run of 8 at standard, so 780s is now slack here rather than the
// binding constraint it was tuned against. The value is still right for the reason
// it was chosen — bound pylon camping — but the 67% figure no longer reproduces.
export const TIME_LIMIT = 780;

// Lucidity bands. HALLUCINATING is not a band — it is what happens at zero.
export const BAND = Object.freeze({
  STEADY: "steady",
  UNSETTLED: "unsettled",
  FRAYING: "fraying",
  BRITTLE: "brittle",
  GONE: "gone",
});

export function bandOf(lucidity) {
  if (lucidity <= 0) return BAND.GONE;
  if (lucidity < 14) return BAND.BRITTLE;
  if (lucidity < 36) return BAND.FRAYING;
  if (lucidity < 62) return BAND.UNSETTLED;
  return BAND.STEADY;
}

// The five companions. Each has a temperament that changes both how fast they
// burn and how they TALK — the tells are the interface, so they have to differ.
export const COMPANION_TEMPLATES = Object.freeze([
  { id: "c1", name: "VOSS", role: "Surveyor", drain: 0.86, stoic: 0.85, chatty: 0.4, wander: 0.5 },
  { id: "c2", name: "IREN", role: "Medic", drain: 1.0, stoic: 0.45, chatty: 0.8, wander: 0.35 },
  { id: "c3", name: "HALDER", role: "Rigger", drain: 1.18, stoic: 0.7, chatty: 0.5, wander: 0.8 },
  { id: "c4", name: "NKEM", role: "Signals", drain: 0.94, stoic: 0.3, chatty: 1.0, wander: 0.4 },
  { id: "c5", name: "PAO", role: "Geologist", drain: 1.1, stoic: 0.6, chatty: 0.6, wander: 0.95 },
]);

// --- per-run trait variance ---------------------------------------------------
// The four numbers above are each companion's BASE personality — the same five
// named people every run, still recognizably themselves. What varies run to run
// is a jitter around that base (seeded, so a given seed always rolls the same
// VOSS), plus one new trait with no fixed base at all. Rolled once per campaign
// at createRun() (see there) and then carried across a campaign's basins like
// scars — a personality doesn't reset just because the party reached a new one.
export const TRAIT_VARIANCE = 0.15; // how far drain/stoic/chatty/wander may drift from their base
const clamp01 = (v) => Math.min(1, Math.max(0, v));

export function rollTraits(rng, tpl) {
  const jitter = () => rng.float(-TRAIT_VARIANCE, TRAIT_VARIANCE);
  return {
    drain: Math.min(1.4, Math.max(0.6, tpl.drain + jitter())),
    stoic: clamp01(tpl.stoic + jitter()),
    chatty: clamp01(tpl.chatty + jitter()),
    wander: clamp01(tpl.wander + jitter()),
    // No per-role base — this is a genuinely new trait, not a modifier on an
    // existing one: how proactively a mind manages its OWN lucidity risk
    // rather than only reacting once already brittle (see party.js).
    selfCare: clamp01(rng.float(0, 1)),
  };
}

// The kinds of hallucination a mind can fall into. Which one you draw changes
// what the character DOES (companions) or what the screen SHOWS (the player).
export const HALLUCINATION = Object.freeze({
  PHANTOM_MARKER: "phantomMarker", // a monolith that is not there
  DOUBLED_PARTY: "doubledParty", // a companion who is not there
  FALSE_ANCHOR: "falseAnchor", // a pylon that gives nothing back
  WRONG_WAY: "wrongWay", // north is not north
  CHORUS: "chorus", // voices, and the certainty that comes with them
});

const HALLUCINATION_LIST = Object.values(HALLUCINATION);

function makeCharacter(tpl, spawn, index) {
  return {
    ...tpl,
    index,
    isPlayer: false,
    // Which human is driving this mind, if any (couch co-op). null = the AI in
    // party.js owns it. `isPlayer` stays false for a possessed companion: it
    // means "is the LEAD", which is a different question and is what the
    // narration/scoring already keys off.
    humanSlot: null,
    yaw: 0, // only read while possessed; the AI steers by goal, not facing
    x: spawn.x,
    z: spawn.z,
    // Hidden state. Nothing in the HUD may read `lucidity` directly — see percept.js.
    lucidity: MAX_LUCIDITY,
    hallucinating: false,
    hallucination: null,
    scars: 0,
    recoverProgress: 0,
    // Where this companion currently believes it is going, and why.
    goal: null,
    goalKind: "follow",
    path: null,
    beliefs: { claimedMarkers: [] },
    aliveTime: 0,
    goneTime: 0, // total seconds spent hallucinating (scored at the end)
    steadyUntil: 0, // sim.time until which a Tether reduces this mind's drain
    selfCare: 0, // overwritten immediately below (rollTraits, or carried over) — never left at this default
    // What this companion is currently carrying for the lead — see
    // companionPickup/handoffToPlayer. Always starts empty on a fresh basin,
    // same as gatherHold: a half-run errand from the last basin means nothing
    // here, the world items are all new.
    inventory: [],
    fetchItemId: null, // the world item id this companion is currently en route to, if any
  };
}

/**
 * Create a run. `seed` fixes the world AND the behavioural jitter, so a seed is
 * a complete description of a run — which is what makes the balance harness and
 * the regression tests meaningful.
 *
 * `level`/`campaignLength`/`carryOver` are the campaign extension: a fresh
 * basin always gets its own world (new seed) and spawn positions, but when
 * `carryOver` is passed the party's lucidity/scars/hallucination state, doses,
 * inventory, and cumulative stats continue from the previous basin instead of
 * resetting — a worn-down party walks into the next fog already worn down.
 * `campaignLength` defaults to 1 (single basin, the original behaviour) so
 * every caller that doesn't know about campaigns — the balance harness, the
 * logic tests — is unaffected; only main.js opts a real playthrough in.
 */
export function createRun({ seed = 1, difficulty = "standard", level = 1, campaignLength = 1, carryOver = null, world: given = null } = {}) {
  // `world` is an INJECTION POINT, not a second generator. Basins still come
  // from generateWorld(seed) and nothing about that changes; the camp is the
  // one authored map and hands its own world in. Everything downstream reads
  // the same shape either way and never learns which it got — see camp.js on
  // why that contract is asserted field-for-field in tests.
  const world = given || generateWorld(seed);
  const rng = makeRng(seed ^ 0x5eed);
  const spawn = { x: world.camp.x, z: world.camp.z };

  const player = {
    id: "you",
    name: "YOU",
    role: "Lead",
    index: 0,
    isPlayer: true,
    humanSlot: 0, // the lead is always human slot 0
    drain: 1.0,
    stoic: 0.5,
    chatty: 0,
    wander: 0,
    x: spawn.x,
    z: spawn.z,
    yaw: 0,
    lucidity: MAX_LUCIDITY,
    hallucinating: false,
    hallucination: null,
    scars: 0,
    recoverProgress: 0,
    goneTime: 0,
    steadyUntil: 0,
    lensUntil: 0, // sim.time until which the lead's OWN screen is forced honest
    decayPausedUntil: 0, // sim.time until which a pylon draw holds the decay off
    microUntil: 0, // sim.time a brief slip ends; 0 means this is not a slip
    microCooldownUntil: 0, // no second slip before this
    vouchUntil: 0, // sim.time until which this mind will vouch for what you showed them
  };

  // Open facing the middle of the basin: camp sits off-centre near the rim, and
  // spawning pointed at the nearest rock wall is a bad first second of a game.
  // forward = (-sin(yaw), -cos(yaw)), so yaw = atan2(-toCentre.x, -toCentre.z).
  player.yaw = Math.atan2(-(0 - spawn.x), -(0 - spawn.z));

  // The party forms up AROUND the lead, in the same bearings party.js will ask
  // them to hold — mostly forward, one behind. This used to be `+sin, +cos`,
  // which is the exact negative of the camera's forward basis, so the opening
  // second of every basin put all five squarely in the one place the lead
  // cannot look. First impressions of a party are made standing still.
  const SPAWN_FAN = [
    { bearing: -0.30, r: 7.0 },
    { bearing: 0.55, r: 5.6 },
    { bearing: -0.55, r: 5.6 },
    { bearing: 0.30, r: 7.0 },
    { bearing: 2.75, r: 4.6 },
  ];
  const companions = COMPANION_TEMPLATES.map((tpl, i) => {
    const f = SPAWN_FAN[i % SPAWN_FAN.length];
    const a = player.yaw + f.bearing;
    const spot = { x: spawn.x - Math.sin(a) * f.r, z: spawn.z - Math.cos(a) * f.r };
    return makeCharacter(tpl, spot, i + 1);
  });
  // Traits are rolled once per CAMPAIGN, not per basin — carryOver below
  // restores them on every level after the first, so a personality doesn't
  // reshuffle just because the party reached a new basin.
  if (!carryOver) {
    for (const ch of companions) Object.assign(ch, rollTraits(rng, ch));
  }

  const diff = DIFFICULTY[difficulty] || DIFFICULTY.standard;

  // Carry the previous basin's party state forward by id — position/goal/path
  // still reset to a fresh spawn (below), but lucidity, scars, whether a mind
  // is mid-hallucination, total gone-time, and rolled traits survive the jump.
  // A companion roster is a fixed set of ids every run, so lookup by id is exact.
  if (carryOver) {
    for (const saved of carryOver.party) {
      const ch = saved.id === player.id ? player : companions.find((c) => c.id === saved.id);
      if (!ch) continue;
      ch.lucidity = saved.lucidity;
      ch.scars = saved.scars;
      ch.hallucinating = saved.hallucinating;
      ch.hallucination = saved.hallucination;
      ch.goneTime = saved.goneTime;
      if (!ch.isPlayer) {
        ch.drain = saved.drain;
        ch.stoic = saved.stoic;
        ch.chatty = saved.chatty;
        ch.wander = saved.wander;
        ch.selfCare = saved.selfCare;
        // Couch co-op: whoever a second player was driving, they keep driving
        // into the next basin. Without this a joined player would be silently
        // dropped back to the AI at every level transition — their controller
        // would just stop working, which reads as a broken pad rather than a
        // lost slot (Brain: COUCH-MULTIPLAYER/input — a silently dead second
        // controller is the classic local-multiplayer failure).
        ch.humanSlot = saved.humanSlot ?? null;
      }
    }
  }
  // Rebuild the human roster from the restored slots, densely and in slot
  // order, so `humans[i]` still means "slot i" on the far side of a basin.
  const rejoined = companions
    .filter((c) => c.humanSlot !== null)
    .sort((a, b) => a.humanSlot - b.humanSlot);
  for (const c of rejoined) c.yaw = player.yaw; // re-form facing the lead, same as possess()

  return {
    seed,
    difficulty,
    diffMult: diff.drain,
    rng,
    world,
    player,
    companions,
    // A stable array rather than a fresh one per access: `party` is read a dozen
    // times per tick (drain, contagion, sightings, endings) and rebuilding it each
    // time was pure allocation churn in the long-run simulations.
    party: [player, ...companions],
    // Human-controlled minds, indexed by couch-co-op slot. Slot 0 is always the
    // lead, so `humans[0] === player` and every existing single-player call
    // site that reads sim.player keeps meaning exactly what it meant. A second
    // player POSSESSES an existing companion rather than adding a seventh body
    // to the basin: the party size, the endings, the dissolve rule and the
    // scoring all stay exactly as balanced, and dropping out is a handoff back
    // to the AI that is already driving that character.
    humans: [player, ...rejoined],
    // `spent` is the ONE fact about a pylon. It used to be shadowed by
    // `charge` and `live`, which percept and render each read instead — so any
    // path that set spent without zeroing the other two (a save from before the
    // change, a test fixture, the next person's code) left a dead pylon looking
    // and behaving alive. Three names for one truth is three chances to drift.
    pylons: world.pylons.map((p) => ({ ...p, spent: false, primedBy: [], primedAt: -1e9 })),
    // `discovered` is what makes this a game about EXPLORING rather than about
    // walking a known route: a marker's position is not knowledge the party
    // starts with. It is set when somebody in the party actually picks it out of
    // the fog (see `discover`).
    monoliths: world.monoliths.map((m) => ({ ...m, logged: false, discovered: false, foundBy: null })),
    // World pickups. `taken` is set the instant a pickup resolves (Brain: never
    // gate a one-shot pickup's deactivation on a despawn animation) — nothing
    // downstream ever gets a second chance to grab an already-taken item.
    items: world.items.map((it) => ({ ...it, discovered: false, taken: false })),
    // Raw-material nodes. `chopped`/`mined` are one-shot, same pattern as an
    // item's `taken` — set the instant gatherResource() resolves.
    trees: world.trees.map((t) => ({ ...t, discovered: false, chopped: false })),
    stones: world.stones.map((s) => ({ ...s, discovered: false, mined: false })),
    // The party's carried items. A slot with `real:false` is a phantom picked up
    // while hallucinating: it has no true kind, only a `claimedKind` baked in at
    // pickup time — permanent, exactly like a false survey log entry, so it does
    // NOT reveal itself just because the lead later recovers. Discovery only
    // happens at use time. Carries forward across a campaign's basins.
    inventory: carryOver ? carryOver.inventory : [],
    // Gathered raw materials. Plain counters, not inventory slots — they are
    // crafting fuel, never carried or used on their own. Carry forward too.
    wood: carryOver ? carryOver.wood : 0,
    stone: carryOver ? carryOver.stone : 0,
    // Monotonic slot-id counter. Ids used to be `slot{length}-{time}`, which
    // repeats the moment a use-then-pickup lands in the same 0.01s tick at the
    // same inventory length — and percept.itemLabels is keyed by slot id, so a
    // reused id inherited the PREVIOUS slot's hallucinated label. Carried
    // across basins so a campaign never recycles one either.
    slotSeq: carryOver ? (carryOver.slotSeq || 0) : 0,
    // Hold-to-gather progress. Always fresh — a half-finished hold from the
    // last basin means nothing here; the trees/deposits are all new.
    gatherHold: { targetId: null, progress: 0 },
    // The survey log. Entries can be FALSE — that is the point.
    logEntries: [],
    doses: carryOver ? carryOver.doses : DOSE_COUNT,
    time: 0, // the sim's own clock. Tests assert against THIS, never wall time.
    status: "playing", // playing | levelComplete | won | lost
    ending: null,
    // Basins contain no mossed pylons, so this is true there and only the camp
    // ever turns it off. See clearMoss.
    canClearMoss: true,
    // The camp suppresses DRAIN, not the clock. A continuous tutorial runs well
    // past LUCIDITY_GRACE and would start eating people mid-lesson, turning a
    // lesson into a race nobody was told they had entered — but stopping
    // `sim.time` instead would freeze every deadline in the game with it,
    // including the call cadences, which would then never recharge. Time moves;
    // nobody decays.
    noDrain: false,
    dissolveTimer: 0,
    events: [], // transient, drained by the HUD each frame
    // Reused across a campaign's basins (not recreated) so the end-of-campaign
    // debrief reports cumulative totals, not just the final basin's.
    // `falseCrafts` and `phantomsRevealed` are the crafting-deception counters:
    // how many items were built that were never there, and how many times
    // another mind's reach called one of those out (either direction — see
    // handoffToPlayer/offerItem). Both stay hidden until the debrief.
    stats: carryOver ? carryOver.stats : { doseUses: 0, pylonSeconds: 0, recoveries: 0, falseLogs: 0, strikes: 0, slips: 0, itemsUsed: 0, phantomItemsUsed: 0, itemsCrafted: 0, falseCrafts: 0, phantomsRevealed: 0 },
    level,
    campaignLength,
  };
}

export const DIFFICULTY = Object.freeze({
  gentle: { drain: 0.75, label: "Gentle" },
  standard: { drain: 1.0, label: "Standard" },
  bleak: { drain: 1.35, label: "Bleak" },
});

export function emit(sim, kind, text, opts = {}) {
  // `...opts` spreads FIRST: an opts field that happens to be named `kind`
  // (e.g. an item's own kind, passed as extra context) must never be able to
  // silently overwrite the event's own type discriminator. It did, briefly —
  // pickup/itemUsed events carried an `opts.kind` and ended up with `ev.kind`
  // reading "flare" instead of "itemUsed", so the HUD's pumpEvents() switch
  // never matched and the subtitle was silently dropped.
  sim.events.push({ ...opts, kind, text, t: sim.time });
  if (sim.events.length > 64) sim.events.shift();
}

const dist2D = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

export function partyCentroid(sim) {
  const p = sim.party;
  return {
    x: p.reduce((s, c) => s + c.x, 0) / p.length,
    z: p.reduce((s, c) => s + c.z, 0) / p.length,
  };
}

/** The pylon a character is standing in, if it has not already been spent. */
export function pylonAt(sim, ch) {
  // NEAREST, not first-found. Two pylons can overlap — a planted stake next to
  // a world pylon, or two world pylons at the larger radius — and returning
  // whichever happened to come first in the array meant two people standing in
  // the same light could prime DIFFERENT pylons and never confirm either.
  let best = null, bestD = Infinity;
  for (const p of sim.pylons) {
    // A mossed pylon is not a pylon yet. Returning one here would let it be
    // primed while inert, and would put "set hands on the pylon" at the top of
    // the prompt ladder at a site where that verb does nothing — starving
    // whatever else is in reach. `mossedAt` is the separate lookup for the one
    // caller that wants to find them.
    if (p.spent || p.mossed) continue;
    const d = dist2D(p, ch);
    if (d <= PYLON_RADIUS && d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/** The nearest mossed pylon in reach, which `pylonAt` deliberately hides. */
export function mossedAt(sim, ch) {
  let best = null, bestD = Infinity;
  for (const p of sim.pylons) {
    if (!p.mossed) continue;
    const d = dist2D(p, ch);
    if (d <= PYLON_RADIUS && d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * Spend the pylon `actor` is standing in. ONE pulse, taking everyone inside the
 * radius together — including pulling back anyone hallucinating, which used to
 * need sustained contact and now simply happens, because there is no second
 * chance to stand there longer.
 *
 * ACTIVATED, not triggered by contact. That distinction is the whole mechanic
 * once a pylon only works once: firing on proximity meant a companion wandering
 * through on their way somewhere else burned the basin's scarcest resource for
 * a single body, and the lead never got a say. Now somebody has to choose to
 * spend it, and the choice is worth making well — the pulse takes everyone in
 * the radius, so the question is who you brought.
 */
export function activatePylon(sim, actor = sim.player) {
  const p = pylonAt(sim, actor);
  // No real pylon here. The caller must NOT treat this as a visible failure —
  // a mind standing at a pylon that does not exist has to be allowed to think
  // it just primed one. See main.js.
  if (!p) return { ok: false, reason: "no-pylon" };

  if (!p.primedBy || p.primedAt === undefined || sim.time - p.primedAt > PRIME_WINDOW) {
    p.primedBy = [];
    p.primedAt = sim.time;
  }
  // IDEMPOTENT. A companion standing on a pylon waiting for a second pair of
  // hands re-enters this function every tick — that is by design, it is how
  // they notice the moment somebody joins. What must NOT happen is a fresh
  // "sets hands on the pylon" line every tick for the whole wait: 12 seconds
  // of waiting emitted 121 identical events. (An earlier version of this comment
  // claimed that flooded the 64-entry buffer and evicted chatter with it; a
  // sandbox built to reproduce that found no eviction at any re-entry length,
  // because tick() drains the buffer far faster than the cap is reached. The
  // spam was real and worth fixing on its own terms — 121 identical subtitles
  // for one action — but the eviction was an inference, not an observation.) The
  // bug predates cohesion; a following party simply never stood on a pylon
  // alone for long enough to show it.
  const already = p.primedBy.includes(actor.id);
  if (!already) p.primedBy.push(actor.id);

  // One pair of hands is a claim; two is a fact. Until a SECOND mind standing
  // in the same light does the same thing, nothing happens.
  const confirmers = sim.party.filter(
    (c) => p.primedBy.includes(c.id) && dist2D(p, c) <= PYLON_RADIUS,
  );
  if (confirmers.length < 2) {
    // Only the FIRST touch announces itself. Re-entering while still waiting is
    // silent — the state is unchanged, so there is nothing new to say.
    if (!already) emit(sim, "prime", `${actor.name} sets hands on the pylon. It needs a second.`, { who: actor.id });
    return { ok: true, primed: true, confirmed: false, waitingFor: 2 - confirmers.length };
  }

  const inside = sim.party.filter((c) => dist2D(p, c) <= PYLON_RADIUS);
  p.spent = true;
  for (const ch of inside) {
    if (ch.hallucinating) recover(sim, ch, "pylon");
    ch.lucidity = Math.min(MAX_LUCIDITY, ch.lucidity + PYLON_DRAW);
    ch.decayPausedUntil = sim.time + PYLON_PAUSE;
  }
  sim.stats.draws = (sim.stats.draws || 0) + 1;
  emit(sim, "draw", `The pylon gives out — ${inside.length} of you caught it. It will not light again.`, {
    id: p.id,
    count: inside.length,
  });
  return { ok: true, primed: true, confirmed: true, caught: inside.length };
}

/**
 * Drain (or restore) one mind for `dt` seconds. Returns the effective rate used,
 * which the balance harness reports on.
 */
export function tickLucidity(sim, ch, dt) {
  // ONE DRAW PER MIND PER TICK, ALWAYS — before any branch, whatever the state.
  // brain: waiting-city#E9 (constant roll count) and #E17, which names the
  // "no need to roll, it's forced" boundary as a third way this discipline gets
  // broken. A roll skipped on an obviously-nothing-to-decide branch silently
  // re-perturbs every other mind sharing the tick, and shows up much later as a
  // resumed run diverging from the original.
  const slipRoll = sim.rng();
  // TWO draws, both unconditional. The duration roll used to sit inside the
  // success branch, which is the same violation one level down: a mind that
  // slips would have burned one more draw than a mind that did not, and every
  // other mind in that tick would shift. If a value is only USED on one branch,
  // it still has to be DRAWN on all of them.
  const slipDur = MICRO_MIN_DUR + sim.rng() * (MICRO_MAX_DUR - MICRO_MIN_DUR);

  if (inMicroEpisode(ch) && sim.time >= ch.microUntil) endMicroEpisode(sim, ch);

  if (pylonAt(sim, ch)) sim.stats.pylonSeconds += dt;
  ch.recoverProgress = 0;
  // The pause travels with the MIND, not the pylon: catch a pulse, then walk,
  // and you carry ten seconds of held-off decay out with you. That is what
  // makes a pylon a staging post rather than a place to sit — and since it only
  // ever fires once, sitting was never going to work anyway.
  if ((ch.decayPausedUntil || 0) > sim.time && !ch.hallucinating) return 0;
  if (ch.hallucinating) {
    ch.goneTime += dt;
    return 0; // already at the floor; nothing left to take
  }
  // Zero means gone, whether or not the grace window is still open — grace
  // only withholds NEW drain, it must never mask a meter already at the
  // floor (however it got there: a direct set, a future mechanic, ...).
  if (ch.lucidity <= 0) {
    beginHallucinating(sim, ch);
    return 0;
  }
  // The camp sets noDrain: nobody decays while they are being taught. One
  // multiplier, at the source, so every downstream consumer of `grace` (drain,
  // micro-episode rate, the bands) is switched off together and none of them
  // needs to know the camp exists.
  const grace = sim.noDrain ? 0 : graceMultiplier(sim.time);
  if (grace <= 0) return 0; // still inside the dead-calm window

  // ISOLATION IS ABOUT THE CHAIN, NOT ABOUT A CENTROID.
  //
  // This used to be "more than ISOLATION_DIST from the party's centre of mass",
  // which was the right question while the party walked in a clump behind you.
  // Cohesion made it the wrong one: a crew ranging over ground is routinely
  // 20-30m from the centroid while being perfectly connected, so the penalty
  // fired on everybody, almost always, for doing exactly what the design now
  // asks of them. Measured: party-seconds-lost went from 17 to 383 and the
  // deceived bot's win rate from 42% to 0% — the basin was not harder, it was
  // punishing its own intended behaviour.
  //
  // Being alone now means what it says: not linked, however indirectly, to
  // anybody. Someone at the far end of a five-person chain is with the group;
  // someone twelve metres away with nobody in between is not.
  //
  // This deliberately does NOT make cohesion a shield (a resolved tension):
  // being in the chain removes a PENALTY for being alone, it does not slow the
  // ordinary decline that everybody pays regardless.
  const group = groupWith(sim.party, sim.player.id);
  let mult = 1;
  if (!group.has(ch.id)) mult *= ISOLATION_MULT;
  const witnessed = sim.party.filter((o) => o !== ch && o.hallucinating && dist2D(o, ch) <= CONTAGION_DIST).length;
  mult *= 1 + CONTAGION_MULT * witnessed;
  mult *= 1 + SCAR_MULT * ch.scars;
  // A Tether steadies without curing: it only ever reduces the rate feeding
  // into the meter, never restores lucidity directly, so it can't substitute
  // for a pylon — just buy time to reach one.
  if (ch.steadyUntil > sim.time) mult *= ITEM_INFO.tether.steadyMult;

  // Slip check, using the draw taken at the top. Gated on the same grace window
  // as the drain — the opening calm means calm, not "calm unless unlucky".
  if (
    !ch.hallucinating &&
    sim.time >= (ch.microCooldownUntil || 0) &&
    slipRoll < (MICRO_RATE[bandOf(ch.lucidity)] || 0) * dt
  ) {
    beginMicroEpisode(sim, ch, slipDur);
    return 0;
  }

  const rate = BASE_DRAIN * ch.drain * sim.diffMult * mult * grace;
  ch.lucidity = Math.max(0, ch.lucidity - rate * dt);
  if (ch.lucidity <= 0) beginHallucinating(sim, ch);
  return rate;
}

/**
 * Which kind of hallucination this mind falls into. The player has no trait
 * vector to weight by (they're not a rolled character), so they keep a flat
 * roll — only a companion's own personality tilts the odds, never certainty:
 * every kind stays reachable for everyone, just more or less likely. Each
 * kind is pushed by the trait it's thematically closest to; DOUBLED_PARTY
 * carries no push at all, so it's relatively likelier for a companion whose
 * traits don't lean anywhere in particular.
 */
export function pickHallucinationKind(sim, ch) {
  if (ch.isPlayer) return sim.rng.pick(HALLUCINATION_LIST);
  const weights = {
    [HALLUCINATION.PHANTOM_MARKER]: 1 + ch.wander * 2, // out roving is where a fake discovery lands
    [HALLUCINATION.WRONG_WAY]: 1 + ch.wander * 2, // ...and where a bad compass actually matters
    [HALLUCINATION.CHORUS]: 1 + ch.chatty * 2, // the lie arrives in the register they already use
    [HALLUCINATION.FALSE_ANCHOR]: 1 + ch.selfCare * 2, // hits exactly what they're anxious about
    [HALLUCINATION.DOUBLED_PARTY]: 1, // flat baseline — the default for no particular lean
  };
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = sim.rng() * total;
  for (const kind of HALLUCINATION_LIST) {
    r -= weights[kind];
    if (r <= 0) return kind;
  }
  return HALLUCINATION_LIST[HALLUCINATION_LIST.length - 1]; // float-rounding fallback, never reached in practice
}

// --- micro-episodes: the lie, at a rate a player actually meets ------------
// A mind used to hallucinate only at lucidity ZERO, which is close to terminal.
// The whole deception layer was therefore gated behind the worst moment of a
// run: measured against the deceived policy at the shipped constants, a
// standard run wrote 0.2 false entries and ended `discredited` once in twenty.
// A game named after being lied to touched the player's record every fifth run.
//
// A slip is the short kind. Seconds, not the rest of the basin; it ends on its
// own with no pylon and no dose; and it uses the same HALLUCINATION kinds and
// the same percept machinery, because a lapse you can tell apart from the real
// thing teaches you to ignore it.
export const MICRO_MIN_DUR = 4;
export const MICRO_MAX_DUR = 9;
// A channel that fires on every event stops carrying information (brain:
// brain-builder#E6). The refractory gap is the ceiling: whatever the band, a
// mind gets one slip and then a stretch of being reliably itself.
export const MICRO_REFRACTORY = 30;
// Per second, by band. STEADY is deliberately zero — a mind with nothing wrong
// with it is the control the player reads everyone else against.
export const MICRO_RATE = Object.freeze({ steady: 0, unsettled: 0.007, fraying: 0.02, brittle: 0.05 });

/** Is this mind in a brief slip rather than gone for good? */
export const inMicroEpisode = (ch) => !!ch.hallucinating && (ch.microUntil || 0) > 0;

export function beginMicroEpisode(sim, ch, dur) {
  ch.hallucinating = true;
  ch.microUntil = sim.time + dur;
  ch.recoverProgress = 0;
  ch.hallucination = pickHallucinationKind(sim, ch);
  ch.goal = null;
  ch.goalKind = "hallucinating";
  sim.stats.slips = (sim.stats.slips || 0) + 1;
  // The SAME line the long kind emits. From the inside there is no difference
  // between a lapse and the beginning of the end, and being told which one this
  // is would hand the player the single fact the game withholds.
  emit(sim, "hallucinate", ch.isPlayer ? "Something is wrong with the light." : `${ch.name} stops making sense.`, {
    who: ch.id,
  });
}

/** End a slip. Not `recover` — no pylon, no dose, no scar; it just passes. */
function endMicroEpisode(sim, ch) {
  ch.hallucinating = false;
  ch.hallucination = null;
  ch.microUntil = 0;
  ch.microCooldownUntil = sim.time + MICRO_REFRACTORY;
  ch.goalKind = null;
  ch.goal = null;
  emit(sim, "recover", ch.isPlayer ? "The light settles." : `${ch.name} comes back to themselves.`, { who: ch.id });
}

export function beginHallucinating(sim, ch) {
  if (ch.hallucinating && !inMicroEpisode(ch)) return;
  // A slip that runs into the floor stops being a slip.
  ch.microUntil = 0;
  ch.hallucinating = true;
  ch.lucidity = 0;
  ch.recoverProgress = 0;
  ch.hallucination = pickHallucinationKind(sim, ch);
  // A companion who has gone abandons the party's plan for their own.
  ch.goal = null;
  ch.goalKind = "hallucinating";
  emit(sim, "hallucinate", ch.isPlayer ? "Something is wrong with the light." : `${ch.name} stops making sense.`, {
    who: ch.id,
  });
}

export function recover(sim, ch, cause) {
  ch.hallucinating = false;
  ch.hallucination = null;
  // CLEAR THE SLIP WINDOW TOO. This function predates micro-episodes and only
  // ever knew how to end the bottomed-out kind of hallucination. Pulling
  // somebody out of a SLIP from outside — a pylon firing around them, a dose —
  // left `microUntil` set on a character who was now lucid, which is the exact
  // state the stress invariant forbids: a slip window with nobody in it. The
  // refractory is applied as well, because a slip cut short by help is still a
  // slip that happened, and without it they could immediately slip again.
  if ((ch.microUntil || 0) > 0) {
    ch.microUntil = 0;
    ch.microCooldownUntil = sim.time + MICRO_REFRACTORY;
  }
  ch.recoverProgress = 0;
  ch.scars += 1;
  ch.lucidity = RECOVER_AT;
  ch.goalKind = "follow";
  ch.goal = null;
  sim.stats.recoveries += 1;
  emit(sim, "recover", ch.isPlayer ? "The basin resolves. You are here." : `${ch.name} comes back.`, {
    who: ch.id,
    cause,
  });
}

/** Spend a lumen dose on one character. Returns true if it was spent. */
export function useDose(sim, targetId) {
  if (sim.doses <= 0 || sim.status !== "playing") return false;
  const ch = sim.party.find((c) => c.id === targetId);
  if (!ch) return false;
  sim.doses -= 1;
  sim.stats.doseUses += 1;
  if (ch.hallucinating) recover(sim, ch, "dose");
  else {
    ch.lucidity = Math.min(MAX_LUCIDITY, ch.lucidity + DOSE_RESTORE);
    emit(sim, "dose", `${ch.isPlayer ? "You take" : `${ch.name} takes`} a lumen dose.`, { who: ch.id });
  }
  return true;
}

// ---------------------------------------------------------------------------
// MOSS — a pylon you can find but not yet use
// ---------------------------------------------------------------------------

/**
 * Scrape the moss off a pylon.
 *
 * The camp's pylons stand there from the first frame, crusted over and inert.
 * A player who wanders before being told anything finds one, presses the verb,
 * and gets a real answer — "it's under moss" — rather than silence or a
 * mysterious refusal. That is gating by what the world IS, not by forbidding a
 * press (brain: wrong-sky#E8 — gate discovery interactables by EFFECT, give the
 * not-yet-active case an explicit in-fiction no-op). Blocking the input instead
 * would put a guard at a shared entry point, which is the thing that silently
 * starves every other consumer of that event stream.
 *
 * `sim.canClearMoss` is what the lesson opens. Basins have no mossed pylons at
 * all, so it defaults to true there and only the camp ever sets it false.
 */
export function clearMoss(sim, p, actor = sim.player) {
  if (!p || !p.mossed) return { ok: false, reason: "not-mossed" };
  if (!sim.canClearMoss) {
    // A real answer, and deliberately not a refusal sound. They learn where it
    // is; they come back when they know what it is for.
    emit(sim, "mossFast", "Moss has grown right over it. It will not shift.", { id: p.id, who: actor.id });
    return { ok: false, reason: "sealed" };
  }
  p.mossed = false;
  emit(sim, "unmoss", "The moss comes away. Whatever this is, it is still live.", { id: p.id, who: actor.id });
  return { ok: true, id: p.id };
}

// ---------------------------------------------------------------------------
// COHESION — who is still with the group
// ---------------------------------------------------------------------------

/** How close two people must be to count as linked. */
export const LINK_RANGE = 20;
/** Beyond this from the lead, the ping turns you around. */
export const PING_RANGE = 26;
/** Seconds between pings, for a mind in good order. */
export const PING_EVERY = 17;
/** How long a pinged companion walks back before resuming their own business. */
export const PING_DURATION = 5.5;
/** At full decline the ping interval has stretched by this factor. */
export const PING_STRETCH = 3.2;

/**
 * The set of ids currently in the lead's group.
 *
 * A CHAIN, not a leash: you are with the group if you are within LINK_RANGE of
 * ANYONE in it, not of the player. Five people spaced 19m apart in a line are
 * all together even though the far end is 76m from the lead. This is what makes
 * the party read as a crew spread over ground rather than an escort walking in
 * your pocket.
 *
 * `members` is whoever the CALLER believes is there. Pass percept's roster and
 * a hallucinated sixth companion becomes a valid link in the chain — the group
 * reads intact, through somebody who is not there, while the real party has
 * already scattered past any real connection. Pass sim.party and you get the
 * truth. Neither is the default; the caller chooses, and that choice is the
 * whole mechanic.
 *
 * Straight-line distance, deliberately. Two people can therefore be "linked"
 * through a cabin wall or a rock spire, which sandbox-distance#E1 is the
 * general warning about — on obstacled ground, straight-line closeness is not
 * reachability. Accepted here because the alternative is a BFS per pair per
 * tick, and because a link through a thin rock reads as "they are just over
 * there" rather than as a bug. Recorded as a decision, not an oversight.
 */
export function groupWith(members, leadId) {
  const ids = members.map((m) => m.id);
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      if (dist2D(members[i], members[j]) <= LINK_RANGE) union(members[i].id, members[j].id);
    }
  }
  if (!parent.has(leadId)) return new Set();
  const root = find(leadId);
  return new Set(ids.filter((id) => find(id) === root));
}

/**
 * How long THIS mind waits between pings.
 *
 * Stretches as they decline, so somebody slipping comes back less often and
 * drifts further. That is the tell, and it is the good kind: you read their
 * condition from how reliably they return, not from a number.
 *
 * It is also a leak if anything renders it. No HUD element may derive from this
 * value and no roster note may change wording as it grows — it is legible only
 * as a felt pattern over minutes.
 */
export function pingInterval(ch) {
  const gone = 1 - Math.max(0, Math.min(1, ch.lucidity / 100));
  return PING_EVERY * (1 + gone * (PING_STRETCH - 1));
}

/**
 * Decide, once per tick, whether this companion turns back toward the lead.
 *
 * A DECAYING IMPULSE, NEVER A RESTORING FORCE. brain: dog#E41 — an emergent
 * cluster driven by balanced inflow and outflow reaches a fixed point and
 * freezes there forever. If the ping pulled inward exactly as hard as wander
 * pushes outward, the party would settle at one radius and sit at it, which
 * looks like a bug and feels like a leash. So a ping is an impulse with a
 * deadline: walk back for PING_DURATION seconds, then stop and go back to your
 * own business, wherever that has left you.
 *
 * Mutates only the companion's own ping bookkeeping. Draws no rng.
 */
export function updatePing(sim, ch) {
  if (ch.isPlayer) return;
  if (sim.time < (ch.pingAt || 0)) return;
  ch.pingAt = sim.time + pingInterval(ch);
  // A mind that is gone does not care where the group is.
  if (ch.hallucinating) return;
  if (dist2D(ch, sim.player) <= PING_RANGE) return;
  ch.pingUntil = sim.time + PING_DURATION;
}

/** Is this companion currently walking back toward the lead after a ping? */
export function isReturning(sim, ch) {
  return sim.time < (ch.pingUntil || 0) && !ch.hallucinating;
}

// ---------------------------------------------------------------------------
// CALL — bring one companion to you
// ---------------------------------------------------------------------------

/** Seconds before the caller may call ANYONE again. */
export const CALL_COOLDOWN = 30;
/** Seconds before a SPECIFIC companion will answer again. */
export const CALL_PERSONAL = 120;
/** How long a called companion walks toward the caller before resuming their own business. */
export const CALL_DURATION = 25;

/**
 * Call a companion over.
 *
 * TWO GATES, AND A REFUSED CALL IS FREE (brain: opticon#E15 — a cooldown
 * ability needs "recharged" AND "has a valid target now", with the cooldown
 * assigned only after every precondition passes, or a refused use silently
 * costs the player their next real one).
 *
 * THE CALL NEVER REPORTS FAILURE. This is the leak rule, and it is the whole
 * reason this function returns so little. A "nobody heard you" message is a
 * direct readout of hidden state: the player would learn their own condition,
 * or a companion's, from an error string instead of from the world. So a call
 * that will be answered and a call that will not are byte-identical at the
 * moment of the press — same event, same text, same sound. The ONLY difference
 * is whether anybody actually walks out of the trees, which is ambiguous,
 * delayed, and readable as distance or terrain or somebody being busy.
 *
 * The cooldowns are absolute DEADLINES (`sim.time >= readyAt`), never a
 * `remaining -= dt` countdown. cadence-frametick#E1 is about the latter: a
 * decrementing float makes the discrete-event rate frame-rate dependent. A
 * deadline compared against the same accumulated `sim.time` everything else
 * uses has no such drift, and matches every other timer in this file
 * (vouchUntil, steadyUntil, microUntil, decayPausedUntil).
 */
export function callCompanion(sim, id, caller = sim.player) {
  const ch = sim.companions.find((c) => c.id === id);
  // Gate 1: is there anybody to call? Gate 2: are both cadences recharged?
  // Checked BEFORE anything is spent.
  if (!ch) return { ok: false, reason: "no-target" };
  if (sim.time < (caller.callReadyAt || 0)) return { ok: false, reason: "recharging" };
  if (sim.time < (ch.answerReadyAt || 0)) return { ok: false, reason: "recharging" };

  caller.callReadyAt = sim.time + CALL_COOLDOWN;
  ch.answerReadyAt = sim.time + CALL_PERSONAL;

  // Whether they COME is a separate question from whether the call went out.
  // A mind that is gone does not answer, and is not told about it here — the
  // player finds out by watching the treeline.
  const answers = !ch.hallucinating && !inMicroEpisode(ch);
  if (answers) {
    ch.summonBy = caller.id;
    ch.summonUntil = sim.time + CALL_DURATION;
  }

  // Deliberately does NOT branch on `answers`. Same text either way.
  emit(sim, "call", `You call out for ${ch.name}.`, { who: ch.id });
  return { ok: true, who: ch.id };
}

/** Is this companion currently walking to somebody who called them? */
export function isAnswering(sim, ch) {
  return !!ch.summonBy && sim.time < (ch.summonUntil || 0) && !ch.hallucinating;
}

/**
 * Ask a companion how they are holding up. This is the game's primary sensor,
 * and it is deliberately unreliable: the answer is filtered by the SPEAKER's
 * state here, and again by the LISTENER's state in percept.js.
 */
export function checkIn(sim, id) {
  const ch = sim.companions.find((c) => c.id === id);
  if (!ch) return null;
  const truth = bandOf(ch.lucidity);
  let claim = truth;
  if (ch.hallucinating) {
    // Total confidence, no contact with the truth.
    claim = BAND.STEADY;
  } else if (truth === BAND.BRITTLE || truth === BAND.FRAYING) {
    // Fraying minds shade optimistic — more so the more stoic they are.
    claim = sim.rng() < 0.35 + ch.stoic * 0.5 ? BAND.UNSETTLED : truth;
  }
  // Asking IS the corroboration verb. There is no separate "show them the
  // marker" key: checking on someone is already the act of getting their eyes
  // on you, and the record follows from it. See VOUCH_WINDOW.
  ch.vouchUntil = sim.time + VOUCH_WINDOW;
  const report = {
    who: ch.id,
    name: ch.name,
    claim,
    truth, // for tests and the end-of-run debrief ONLY — never shown mid-run
    text: reportText(ch, claim),
  };
  emit(sim, "report", `${ch.name}: ${report.text}`, { who: ch.id, claim });
  return report;
}

function reportText(ch, claim) {
  switch (claim) {
    case BAND.STEADY:
      return ch.stoic > 0.6 ? "Fine. Keep moving." : "I'm good. Clear head.";
    case BAND.UNSETTLED:
      return "Bit of a headache. Nothing I can't walk off.";
    case BAND.FRAYING:
      return "I keep hearing the ridge breathe. I don't love it.";
    case BAND.BRITTLE:
      return "I can't— I need a pylon. Soon.";
    default:
      return "…the stones are counting us.";
  }
}

/** Line of sight on the collision grid — spires block a sighting. */
export function hasSight(sim, from, to) {
  const d = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.ceil(d / CELL);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (isBlockedAt(sim.world, from.x + (to.x - from.x) * t, from.z + (to.z - from.z) * t)) return false;
  }
  return true;
}

/**
 * Pick markers out of the fog. Anyone in the party can make the sighting — which
 * is a quiet argument for keeping them close, and a real loss when they scatter.
 *
 * A companion who has gone can still call out a marker, and it will be a real
 * one: they are not lying about the basin, they have simply stopped being able to
 * tell which basin they are in. Their FALSE calls are chatter, not sightings.
 */
export function discover(sim) {
  for (const m of sim.monoliths) {
    if (m.discovered) continue;
    for (const ch of sim.party) {
      if (Math.hypot(m.x - ch.x, m.z - ch.z) > SIGHT_RANGE) continue;
      if (!hasSight(sim, ch, m)) continue;
      m.discovered = true;
      m.foundBy = ch.id;
      emit(sim, "discover", ch.isPlayer ? `${m.name}, off in the fog.` : `${ch.name}: there — ${m.name}.`, {
        id: m.id,
        who: ch.id,
      });
      break;
    }
  }
  for (const it of sim.items) {
    if (it.discovered || it.taken) continue;
    for (const ch of sim.party) {
      if (Math.hypot(it.x - ch.x, it.z - ch.z) > ITEM_SIGHT_RANGE) continue;
      if (!hasSight(sim, ch, it)) continue;
      it.discovered = true;
      // Deliberately kind-agnostic: naming the item here would leak its true
      // kind straight through the subtitle, bypassing percept.js entirely —
      // the one place a hallucinating lead's item bar is allowed to lie about
      // what they're looking at (see perceivedWorldItems).
      emit(sim, "discoverItem", ch.isPlayer ? "Something in the grass, off to the side." : `${ch.name}: there's something over there.`, {
        id: it.id,
        who: ch.id,
      });
      break;
    }
  }
  // Trees and stone deposits carry no deception at all — see the "raw
  // materials" comment on RESOURCE_SIGHT_RANGE — so, unlike an item, naming
  // what it is here is safe.
  for (const t of sim.trees) {
    if (t.discovered || t.chopped) continue;
    for (const ch of sim.party) {
      if (Math.hypot(t.x - ch.x, t.z - ch.z) > RESOURCE_SIGHT_RANGE) continue;
      if (!hasSight(sim, ch, t)) continue;
      t.discovered = true;
      emit(sim, "discoverResource", ch.isPlayer ? "A tree, close enough to reach." : `${ch.name}: wood, over there.`, { id: t.id, who: ch.id });
      break;
    }
  }
  for (const s of sim.stones) {
    if (s.discovered || s.mined) continue;
    for (const ch of sim.party) {
      if (Math.hypot(s.x - ch.x, s.z - ch.z) > RESOURCE_SIGHT_RANGE) continue;
      if (!hasSight(sim, ch, s)) continue;
      s.discovered = true;
      emit(sim, "discoverResource", ch.isPlayer ? "Stone breaking through the ground." : `${ch.name}: stone, over there.`, { id: s.id, who: ch.id });
      break;
    }
  }
}

/** Issue a slot id that is never reused for the life of a campaign. */
function nextSlotId(sim) {
  return `slot${sim.slotSeq++}`;
}

export const discoveredCount = (sim) => sim.monoliths.filter((m) => m.discovered).length;

/**
 * Log a survey marker. This is the win condition's currency, and it can be
 * counterfeit: a hallucinating lead with nobody lucid nearby to contradict them
 * writes down a monolith that does not exist.
 */
export function logMarker(sim, phantom = null, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };

  const near = sim.monoliths
    .filter((m) => !m.logged && dist2D(m, actor) <= LOG_RADIUS)
    .sort((a, b) => dist2D(a, actor) - dist2D(b, actor))[0];

  // Anyone in the party but the surveyor themselves can corroborate — you
  // cannot be your own witness. Searching `party` rather than `companions` is
  // what lets a second human vouch for the lead (and the lead for them); in
  // single player the actor IS the lead, so party-minus-actor is exactly the
  // companion list this used to search.
  // A witness is someone you ASKED, who is standing with you, and who is in a
  // state to answer honestly. The last of those three is the one you cannot
  // check: a companion who is themselves gone will agree with anything you put
  // in front of them, and nothing on screen tells you which kind you just
  // asked. That is the party as a tool you use, rather than armour you wear.
  const lucidWitness = sim.party.find(
    (c) => c !== actor && !c.hallucinating && bandOf(c.lucidity) !== BAND.BRITTLE
      // A second HUMAN at your shoulder vouches by being there: they are a
      // person looking at the same thing who can simply say so out loud, and
      // there is no verb to route that through. An AI companion has to be
      // asked — checkIn is that ask — because otherwise the party's mere
      // presence is a shield, which is the thing this rule exists to stop.
      && (c.humanSlot !== null || (c.vouchUntil || 0) > sim.time)
      && dist2D(c, actor) <= CORROBORATE_RADIUS,
  );

  // Lucid, standing where the record CLAIMS a marker, and there is nothing here:
  // strike the claim. Same verb, opposite outcome — "write down what is at this
  // spot" correctly answers "nothing", and crossing the entry out is what that
  // answer looks like on paper. It needs no new binding, and it is the only way
  // a corrupted record gets repaired.
  if (!near) {
    const claim = claimedEntryAt(sim, actor);
    if (claim) {
      // A mind that is under cannot audit itself — but it must not be TOLD
      // that. Silence would be the loudest tell in the game: press the key,
      // watch nothing happen, and you have learned you are hallucinating, which
      // is the single fact this whole system exists to withhold. So the strike
      // LOOKS identical from the inside. The same line arrives, the offer stops
      // being made (percept.believedStruck), and the entry stays exactly where
      // it was — waiting on the debrief.
      //
      // This is the deception applied to the repair itself, and it is the
      // reason the record is worth walking home carefully: you cannot trust
      // your own corrections either.
      const real = !actor.hallucinating;
      if (real) {
        claim.struck = true;
        claim.struckAt = sim.time;
        sim.stats.strikes = (sim.stats.strikes || 0) + 1;
      }
      emit(sim, "logStrike", `${claim.name} struck from the record. There is nothing here.`, {
        name: claim.name,
        entryId: claim.id,
        believedOnly: !real,
      });
      return { ok: true, real: false, struck: real };
    }
  }

  // Hallucinating surveyor, standing at nothing, nobody to say so: a false entry.
  if (!near && actor.hallucinating && phantom && !lucidWitness) {
    sim.logEntries.push({ id: `e${sim.logEntries.length}`, name: phantom.name, real: false, t: sim.time, corroborated: false, x: actor.x, z: actor.z });
    sim.stats.falseLogs += 1;
    emit(sim, "logFalse", `Logged ${phantom.name}.`, { phantom: true });
    return { ok: true, real: false };
  }
  if (!near) return { ok: false, reason: "nothing-here" };

  // A lucid mind at your shoulder is what keeps the record honest.
  if (actor.hallucinating && !lucidWitness && sim.rng() < 0.5) {
    sim.logEntries.push({ id: `e${sim.logEntries.length}`, name: near.name, real: false, t: sim.time, corroborated: false, x: actor.x, z: actor.z });
    sim.stats.falseLogs += 1;
    emit(sim, "logFalse", `Logged ${near.name}.`, { phantom: true });
    return { ok: true, real: false };
  }

  near.logged = true;
  sim.logEntries.push({
    id: near.id,
    name: near.name,
    real: true,
    t: sim.time,
    corroborated: !!lucidWitness,
    by: lucidWitness ? lucidWitness.name : null,
  });
  // "Uncorroborated" is the whole teaching signal for the check-in verb: it is
  // the moment a player finds out that walking with people is not the same as
  // asking them, and it fires on every entry they write alone.
  emit(sim, "log", `${near.name} surveyed.${lucidWitness ? ` ${lucidWitness.name} confirms.` : " Nobody vouched for it."}`, {
    id: near.id,
  });
  return { ok: true, real: true, corroborated: !!lucidWitness };
}

/**
 * An unstruck entry of the record claiming a marker at the actor's feet — what
 * they can SEE from where they are standing, with no judgement about whether
 * their mind is fit to act on it.
 *
 * This is deliberately NOT gated on lucidity, and the difference matters more
 * than it looks. The HUD draws its prompt from this, so the offer to strike an
 * entry appears identically whether or not the lead is under. Gating it would
 * have made the prompt's absence a reliable readout of your own hallucination —
 * "the strike option vanished, so I must be gone" — in the one game whose whole
 * premise is that you cannot tell from the inside. A tell that only fires when
 * you are lied to is worse than no tell: it is a lucidity meter with extra
 * steps.
 *
 * `strikeTargetAt` below is the RULES' answer to the same question, and it is
 * gated. The verb fails silently for a mind that cannot audit itself.
 */
export function claimedEntryAt(sim, actor = sim.player) {
  if (!actor) return null;
  return (
    sim.logEntries.find(
      (e) => !e.real && !e.struck && typeof e.x === "number" && dist2D(e, actor) <= LOG_RADIUS,
    ) || null
  );
}

/**
 * The false entry `actor` may actually cross out. You cannot audit a record
 * using the faculty that corrupted it — so a hallucinating mind gets null here
 * while still being SHOWN the offer (see claimedEntryAt).
 */
export function strikeTargetAt(sim, actor = sim.player) {
  if (!actor || actor.hallucinating) return null;
  return claimedEntryAt(sim, actor);
}

export const trueLogCount = (sim) => sim.monoliths.filter((m) => m.logged).length;

/**
 * Entries claiming a marker that was never there, and never crossed out. This is
 * what the survey is graded on.
 *
 * It was measured to be worth NOTHING before this existed: sweeping the
 * corroboration radius from 11 to 0 took false entries from 23.8 to 260.1 per
 * run and did not move the win rate by a single seed. The game's central verb —
 * you write down a marker that was never there — was decorative. Every tell
 * built for it made the lie more visible; none of it made the lie COST
 * anything.
 */
export const badLogCount = (sim) => sim.logEntries.filter((e) => !e.real && !e.struck).length;

/**
 * Pick up whatever the lead is standing next to. Two ways this can go wrong,
 * neither visible until later:
 *   - if the lead is hallucinating, the pickup has a real chance of being a
 *     PHANTOM — a slot with `real:false` and no true kind at all;
 *   - even when it IS real, what the lead currently believes they picked up
 *     is percept.js's business, not this function's — this only ever records
 *     the truth.
 */
export function pickupItem(sim, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };
  if (sim.inventory.length >= ITEM_CAP) return { ok: false, reason: "full" };

  const near = sim.items
    .filter((it) => !it.taken && it.discovered && dist2D(it, actor) <= ITEM_PICKUP_RADIUS)
    .sort((a, b) => dist2D(a, actor) - dist2D(b, actor))[0];
  if (!near) return { ok: false, reason: "nothing-here" };

  // Deactivate the instant it's taken — no despawn animation gates a second
  // pickup attempt racing in behind this one.
  near.taken = true;

  // Both branches emit the SAME kind-agnostic line, for the same reason
  // `discoverItem` above is kind-agnostic: naming what was picked up here
  // prints the TRUE kind straight into the subtitles, bypassing percept.js —
  // the only module allowed to say what a mind thinks it is holding. It used
  // to read "<True Kind> secured." for a real pickup and a differently-shaped
  // sentence for a phantom, which between them handed the player the true kind
  // of every real slot AND a tell for every fake one. With both facts public,
  // the outcome of any craft was decidable before committing to it (see
  // craftItem). The item bar is where a pickup gets named, and the bar can lie.
  const secured = actor.isPlayer ? "Secured. It settles into your hand." : `${actor.name} takes it.`;

  // A hallucinating picker-up has a real (not certain) chance that what their
  // hand closed on was never there at all.
  if (actor.hallucinating && sim.rng.chance(0.45)) {
    const claimedKind = sim.rng.pick(ITEM_KINDS);
    sim.inventory.push({ id: nextSlotId(sim), real: false, claimedKind, kind: null });
    emit(sim, "pickupFalse", secured, { phantom: true, who: actor.id });
    return { ok: true, real: false };
  }

  sim.inventory.push({ id: nextSlotId(sim), real: true, kind: near.itemKind, claimedKind: null });
  // `id` names the ITEM, `who` names the taker. Both are needed: an observer
  // that can only see the kind cannot tell one flare from another, which is
  // the difference between a teaching step pinned to an entity and one that
  // any later flare satisfies by accident.
  emit(sim, "pickup", secured, { id: near.id, itemKind: near.itemKind, who: actor.id });
  return { ok: true, real: true, kind: near.itemKind };
}

// --- companion couriering -----------------------------------------------------
// A companion can carry ONE item for the lead — a courier's free hand, not a
// second loadout — and closes on it the exact same way the lead's own
// pickupItem does: if THIS companion is hallucinating when their hand closes
// on something, what they end up carrying is a real:false slot with a
// claimedKind and no true effect behind it, indistinguishable in shape from a
// phantom the lead picked up themselves. Handing that off later costs nothing
// extra to get right — useItem/craftItem/perceivedInventory already judge a
// slot by `real`, never by whose hallucination put it there.
export const COMPANION_ITEM_CAP = 1;
export const OFFER_RADIUS = 5.0; // close enough to put something in someone's hand

/**
 * A companion closing their hand on a reachable, discovered, untaken world
 * item. Mirrors pickupItem, just addressed to `ch` instead of the lead, and
 * writing into `ch.inventory` instead of `sim.inventory`. When `targetId` is
 * given (an errand in party.js sent this companion after a SPECIFIC item),
 * only that item counts — otherwise this would happily grab whatever nearer
 * thing happened to be sitting next to the one it was actually sent for,
 * coming home with an ingredient that completes nothing. With no `targetId`
 * (a bare pickup, no errand behind it) it falls back to nearest, same as
 * pickupItem.
 */
export function companionPickup(sim, ch, targetId = null) {
  if (ch.inventory.length >= COMPANION_ITEM_CAP) return { ok: false, reason: "full" };

  const candidates = sim.items.filter((it) => !it.taken && it.discovered && dist2D(it, ch) <= ITEM_PICKUP_RADIUS);
  const near = targetId
    ? candidates.find((it) => it.id === targetId)
    : candidates.sort((a, b) => dist2D(a, ch) - dist2D(b, ch))[0];
  if (!near) return { ok: false, reason: "nothing-here" };

  near.taken = true;

  // Deliberately kind-agnostic either way — naming what was picked up here
  // would leak the truth (or the lie) to the lead before they've ever laid
  // eyes on it, well before they were close enough to actually see. The label
  // only ever gets named at handoff, the same beat the flashlight example
  // hinges on: you don't find out what you were given until it's in your hand.
  if (ch.hallucinating && sim.rng.chance(0.45)) {
    const claimedKind = sim.rng.pick(ITEM_KINDS);
    ch.inventory.push({ id: nextSlotId(sim), real: false, claimedKind, kind: null });
    emit(sim, "companionPickup", `${ch.name} picks something up.`, { who: ch.id, phantom: true });
    return { ok: true, real: false };
  }

  ch.inventory.push({ id: nextSlotId(sim), real: true, kind: near.itemKind, claimedKind: null });
  emit(sim, "companionPickup", `${ch.name} picks something up.`, { who: ch.id, itemKind: near.itemKind });
  return { ok: true, real: true, kind: near.itemKind };
}

// --- the crossing rule --------------------------------------------------------
// THE PRECEDENCE, decided once here rather than case by case at each call site:
//
//   1. Truth is a property of the SLOT (`real`/`kind`), never of an observer.
//   2. What a mind BELIEVES is a function of (slot, that mind's own lucidity).
//   3. A belief only becomes consequential at a RESOLUTION POINT: using it
//      (useItem), building with it (craftItem), or putting it in somebody
//      else's hands (below).
//   4. At a crossing, the RECEIVER's reading decides. A lucid mind reaching
//      for something that was never there closes on nothing — and because
//      that reach is public, the nothing is information for whoever is
//      watching. Two deceived minds, by contrast, agree, and the object
//      survives the handover intact.
//
// That last clause is the whole mechanic: a phantom is only ever exposed by a
// mind that isn't sharing the delusion, which makes a lucid companion a
// TEST INSTRUMENT and a gone one an echo chamber. In couch co-op both players
// have their own meter, so the same rule quietly turns player two into the
// instrument — and vice versa.

/**
 * Does this mind currently see through a phantom, or share the delusion?
 *
 * A Lens counts. It never cures anything — the meter and the `hallucinating`
 * flag are untouched — but for its window that mind's reading of the world is
 * honest, and that has to hold at a crossing too, or the Lens would be a
 * truth-telling instrument with one arbitrary blind spot.
 */
const seesThrough = (sim, ch) => !ch.hallucinating || (ch.lensUntil || 0) > sim.time;

/**
 * Hand off whatever `ch` is carrying to the lead. If the slot is a phantom and
 * the LEAD is lucid, the handover fails in the open: nothing changes hands and
 * the lead has just learned something true about `ch` that no check-in would
 * have told them. If the lead is gone too, both minds agree it happened and
 * the phantom transfers intact, to be discovered later at use time.
 */
export function handoffToPlayer(sim, ch) {
  if (!ch.inventory.length) return { ok: false, reason: "empty" };

  const slot = ch.inventory[0];

  if (!slot.real && seesThrough(sim, sim.player)) {
    ch.inventory.shift(); // whatever they thought they had, they no longer have
    sim.stats.phantomsRevealed += 1;
    emit(sim, "handoffEmpty", `${ch.name} holds out both hands. There is nothing in them.`, {
      who: ch.id,
      phantom: true,
    });
    return { ok: false, reason: "revealed", real: false };
  }

  // Cap only matters once something is actually going to change hands — a
  // phantom being called out above needs no room to fail in.
  if (sim.inventory.length >= ITEM_CAP) return { ok: false, reason: "full" };

  ch.inventory.shift();
  sim.inventory.push(slot);
  if (slot.real) {
    emit(sim, "handoff", `${ch.name} hands you the ${ITEM_INFO[slot.kind].label}.`, { who: ch.id, itemKind: slot.kind });
  } else {
    // Word for word the real line above, article included — "hands you Flare"
    // against "hands you the Flare" was a deterministic tell all by itself.
    emit(sim, "handoff", `${ch.name} hands you the ${ITEM_INFO[slot.claimedKind].label}.`, { who: ch.id, phantom: true });
  }
  return { ok: true, real: slot.real };
}

/**
 * The other direction: a player puts a carried item in a companion's hands.
 * This is the only verb in the game that can tell a player something about
 * THEIR OWN state — every other tell is about somebody else. Offer a lucid
 * companion something that was never there and they will say so, which is the
 * one way to find out that the last thing you built, or were given, was a lie.
 *
 * It is not just a probe, though, or nobody would spend a slot on it: a real
 * item a companion can actually use gets used, on the spot. That is what makes
 * the failed offer cost something — you were not testing a theory, you were
 * trying to save somebody.
 */
export function offerItem(sim, slotIndex, companionId, believedKind = null, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };
  const slot = sim.inventory[slotIndex];
  if (!slot) return { ok: false, reason: "empty" };
  const target = sim.companions.find((c) => c.id === companionId);
  if (!target || target === actor) return { ok: false, reason: "no-target" };
  if (dist2D(target, actor) > OFFER_RADIUS) return { ok: false, reason: "too-far" };

  // Everything below decides on the item as the OFFERER understands it. Gating
  // on the true kind instead turned a refusal into a free oracle: a genuinely
  // real Lens refused without being consumed and could be re-offered forever,
  // while a phantom claiming to be a Lens was swallowed — so "did it refuse?"
  // answered "is this real?" at no cost, which is precisely the question this
  // verb is supposed to charge you for.
  const shownKind = believedKind || (slot.real ? slot.kind : slot.claimedKind);
  const info = ITEM_INFO[shownKind];

  // A companion only takes something they could actually use. Refusing the
  // rest also keeps a handed-over item from being walked straight back by the
  // courier logic in party.js. Checked BEFORE the phantom branch so a claimed
  // Lens (or Husk) refuses identically whether or not anything is behind it.
  if (!(info.restore || info.steadySeconds)) {
    emit(sim, "offerRefused", `${target.name} shakes their head. "That one's yours to carry."`, { who: target.id });
    return { ok: false, reason: "no-use" };
  }

  if (!slot.real) {
    sim.inventory.splice(slotIndex, 1);
    if (seesThrough(sim, target)) {
      sim.stats.phantomsRevealed += 1;
      emit(sim, "offerEmpty", `${target.name} looks at your open hand, then at you. "There's nothing there."`, {
        who: target.id,
        phantom: true,
      });
      return { ok: true, real: false, revealed: true };
    }
    // Two gone minds agreeing. Nothing passes between them and neither knows —
    // so this reads exactly like the successful handover below, naming the
    // same item in the same sentence. Anything less and the line itself would
    // be the tell that the thing was never there.
    emit(sim, "offerUsed", `${target.name} takes the ${info.label}. Something in them settles.`, {
      who: target.id,
      itemKind: shownKind,
    });
    return { ok: true, real: false, revealed: false };
  }

  sim.inventory.splice(slotIndex, 1);
  sim.stats.itemsUsed += 1;
  // Steadying works on a mind that is already gone (it is a drain modifier,
  // not a cure), so it is applied before the restore branch can return early —
  // otherwise an Ember, which is strictly a Ward's superior for this purpose,
  // would do LESS for a gone companion than a plain Tether does.
  if (info.steadySeconds) target.steadyUntil = sim.time + info.steadySeconds;
  if (info.restore) {
    // Pulling a mind back from gone takes a pylon, not an item — a flare in
    // somebody else's hand tops up a mind that is still present.
    if (target.hallucinating) {
      emit(sim, "offerLost", `${target.name} turns the ${info.label} over and over. It doesn't reach them.`, { who: target.id });
      return { ok: true, real: true, kind: slot.kind, reached: false };
    }
    target.lucidity = Math.min(MAX_LUCIDITY, target.lucidity + info.restore);
  }
  emit(sim, "offerUsed", `${target.name} takes the ${info.label}. Something in them settles.`, {
    who: target.id,
    itemKind: slot.kind,
  });
  return { ok: true, real: true, kind: slot.kind, reached: true };
}

/**
 * Chop the nearest reachable tree or mine the nearest reachable stone deposit,
 * whichever is closer. Unlike a pickup, there is nothing to get wrong here —
 * no phantom chance, no misidentification — a gathered resource is exactly
 * what it looked like. Instant and one-shot, same shape as pickupItem.
 */
/**
 * The nearest tree or stone deposit in reach right now, whichever is closer,
 * tagged with its kind. Single source of truth for "what would gathering
 * hit" — used by gatherResource itself, by the hold-progress tracker below,
 * and by main.js/hud.js so the prompt and the actual action never disagree.
 */
// ---------------------------------------------------------------- couch co-op
//
// A second player does not add a body to the basin — they take the wheel of a
// companion who is already in it. That keeps every balance-bearing number the
// same (party of six, the dissolve rule, the "two companions still walking"
// win condition) and makes drop-out trivially correct: the AI that was driving
// that mind a moment ago simply resumes.
//
// The interesting half is that a possessed companion has their OWN lucidity
// meter, which was already ticking down independently — so each human gets
// their own percept and the two of you are shown DIFFERENT worlds. One of you
// can be walking toward a marker the other cannot see.

/** Companions the AI still owns — i.e. who a joining player could take over. */
export function possessableCompanions(sim) {
  return sim.companions.filter((c) => c.humanSlot === null);
}

/**
 * Hand `companion` to a human. Returns the assigned slot, or null if the
 * companion is already taken. The joining player inherits the mind exactly as
 * the AI left it — lucidity, scars, whether it is mid-hallucination, and
 * anything it was carrying — because that continuity IS the character.
 */
export function possess(sim, companionId) {
  const c = sim.companions.find((x) => x.id === companionId);
  if (!c || c.humanSlot !== null) return null;
  const slot = sim.humans.length;
  c.humanSlot = slot;
  sim.humans.push(c);
  // Drop the AI's in-flight intentions AT THE MOMENT control changes, not
  // later when something happens to notice (Brain: lockstep#E2 — clear a
  // relationship at the point you act on it). A stale goal/path left here
  // would be resumed verbatim by the AI on release, steering the character
  // toward somewhere it decided to go minutes ago.
  c.goal = null;
  c.goalKind = "follow";
  c.path = null;
  c.fetchItemId = null;
  // Face where the lead is facing, so a joining player doesn't start pointed
  // at a rock wall (Brain: lockstep#E1 — spawn co-op players together).
  c.yaw = sim.player.yaw;
  emit(sim, "join", `${c.name} is yours.`, { who: c.id, slot });
  return slot;
}

/**
 * Hand a possessed companion back to the AI. Explicit by design: an engine
 * default that quietly destroys or abandons a dropped player's character is a
 * known failure mode (Brain: COUCH-MULTIPLAYER/session-state — the handoff to
 * AI is never automatic, and doing it too late leaves the pawn unrecoverable).
 * Here the character simply stays in the basin and starts following again.
 *
 * Slots are released from the end only (the last player to join is the first
 * to leave), which keeps `humans` densely indexed — no null holes for the
 * renderer, HUD or input router to special-case.
 */
export function release(sim, slot) {
  if (slot <= 0 || slot >= sim.humans.length) return false; // slot 0 is the lead; never released
  if (slot !== sim.humans.length - 1) return false;
  const c = sim.humans[slot];
  sim.humans.pop();
  c.humanSlot = null;
  // Same clearing discipline as possess(), for the same reason: the AI must
  // start from "where am I now", not from an intention formed before a human
  // ever touched this character.
  c.goal = null;
  c.goalKind = "follow";
  c.path = null;
  c.fetchItemId = null;
  emit(sim, "leave", `${c.name} drifts back to the party.`, { who: c.id });
  return true;
}

export function gatherTarget(sim, actor = sim.player) {
  const nearTree = sim.trees
    .filter((t) => !t.chopped && t.discovered && dist2D(t, actor) <= GATHER_RADIUS)
    .sort((a, b) => dist2D(a, actor) - dist2D(b, actor))[0];
  const nearStone = sim.stones
    .filter((s) => !s.mined && s.discovered && dist2D(s, actor) <= GATHER_RADIUS)
    .sort((a, b) => dist2D(a, actor) - dist2D(b, actor))[0];
  const pick = [nearTree, nearStone].filter(Boolean).sort((a, b) => dist2D(a, actor) - dist2D(b, actor))[0];
  if (!pick) return null;
  return { ...pick, gatherKind: pick === nearTree ? "tree" : "stone" };
}

export function gatherResource(sim, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };

  const pick = gatherTarget(sim, actor);
  if (!pick) return { ok: false, reason: "nothing-here" };

  if (pick.gatherKind === "tree") {
    const t = sim.trees.find((x) => x.id === pick.id);
    t.chopped = true;
    const n = sim.rng.int(GATHER_YIELD.min, GATHER_YIELD.max);
    sim.wood += n;
    // x/z ride along on the event so the HUD can animate the haul from the
    // node's own world position to the Wood pill, instead of the counter
    // just silently ticking up.
    emit(sim, "gather", `Wood, cut and carried. (+${n})`, { resource: "wood", amount: n, x: t.x, z: t.z });
    return { ok: true, resource: "wood", amount: n };
  }
  const s = sim.stones.find((x) => x.id === pick.id);
  s.mined = true;
  const n = sim.rng.int(GATHER_YIELD.min, GATHER_YIELD.max);
  sim.stone += n;
  emit(sim, "gather", `Stone, broken free. (+${n})`, { resource: "stone", amount: n, x: s.x, z: s.z });
  return { ok: true, resource: "stone", amount: n };
}

/**
 * Advance (or reset) the hold-to-gather progress for this tick. Holding the
 * interact verb while standing at a tree/deposit accumulates GATHER_HOLD_TIME
 * seconds before gatherResource() actually fires; releasing early, walking
 * out of reach, or switching to a different node all reset progress to zero
 * — a hold is a commitment to ONE node, not a meter you can bank partway.
 */
function updateGatherHold(sim, dt, interacting, actor = sim.player, hold = sim.gatherHold) {
  const target = interacting ? gatherTarget(sim, actor) : null;
  if (!target) {
    hold.targetId = null;
    hold.progress = 0;
    return;
  }
  if (hold.targetId !== target.id) {
    hold.targetId = target.id;
    hold.progress = 0;
  }
  hold.progress += dt;
  if (hold.progress >= GATHER_HOLD_TIME) {
    gatherResource(sim, actor);
    hold.targetId = null;
    hold.progress = 0;
  }
}

/**
 * Use a carried item slot. A real item does exactly what its TRUE kind does —
 * which is "the wrong thing" from the lead's point of view whenever percept.js
 * had them convinced it was some other kind. A phantom slot has no true effect
 * to fall back on, so it always costs instead of helping: reaching for
 * something that was never there is worse than not reaching at all.
 */
export function useItem(sim, slotIndex, targetCompanionId, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };
  const slot = sim.inventory[slotIndex];
  if (!slot) return { ok: false, reason: "empty" };
  sim.inventory.splice(slotIndex, 1);

  // "self" is whoever reached for the item, not always the lead: the pack is
  // shared (one inventory, one dose supply), but the EFFECT lands on the mind
  // that used it.
  const self = actor;
  // A tether-like item can't be spent on the user themselves — steadying your
  // own hand is what a flare is for — so the fallback target skips them.
  const otherThan = (id) => sim.companions.find((c) => c.id === id && c !== self)
    || sim.companions.find((c) => c !== self);

  if (!slot.real) {
    self.lucidity = Math.max(0, self.lucidity - PHANTOM_ITEM_COST);
    sim.stats.phantomItemsUsed += 1;
    emit(sim, "itemPhantom", "It wasn't there. It was never there.", { who: self.id });
    if (self.lucidity <= 0) beginHallucinating(sim, self);
    return { ok: true, real: false, kind: null };
  }

  sim.stats.itemsUsed += 1;
  const info = ITEM_INFO[slot.kind];
  switch (slot.kind) {
    case "flare":
      self.lucidity = Math.min(MAX_LUCIDITY, self.lucidity + info.restore);
      emit(sim, "itemUsed", "The flare catches. Your head clears, sharply.", { itemKind: "flare", who: self.id });
      break;
    case "tether": {
      const target = otherThan(targetCompanionId);
      if (!target) break;
      target.steadyUntil = sim.time + info.steadySeconds;
      emit(sim, "itemUsed", `${target.name} steadies.`, { itemKind: "tether", who: target.id });
      break;
    }
    case "lens":
      self.lensUntil = sim.time + info.clearSeconds;
      emit(sim, "itemUsed", "For a while, you can trust your own eyes again.", { itemKind: "lens", who: self.id });
      break;
    // Crafted items do both parent effects at once — the payoff for spending
    // two carried slots and a craft action instead of using them separately.
    case "ember": {
      self.lucidity = Math.min(MAX_LUCIDITY, self.lucidity + info.restore);
      const target = otherThan(targetCompanionId);
      if (target) target.steadyUntil = sim.time + info.steadySeconds;
      emit(sim, "itemUsed", `The ember flares. Your head clears${target ? `, and ${target.name} steadies` : ""}.`, { itemKind: "ember", who: target ? target.id : self.id });
      break;
    }
    case "beacon":
      self.lucidity = Math.min(MAX_LUCIDITY, self.lucidity + info.restore);
      self.lensUntil = sim.time + info.clearSeconds;
      emit(sim, "itemUsed", "The beacon burns bright. Your head clears, and so does the screen.", { itemKind: "beacon", who: self.id });
      break;
    case "ward": {
      const target = otherThan(targetCompanionId);
      if (target) target.steadyUntil = sim.time + info.steadySeconds;
      self.lensUntil = sim.time + info.clearSeconds;
      emit(sim, "itemUsed", `The ward holds.${target ? ` ${target.name} steadies, and` : ""} you can trust your own eyes again.`, { itemKind: "ward", who: target ? target.id : self.id });
      break;
    }
    // Doesn't affect the player or a companion directly — it plants a pylon
    // at the player's current position. Everything downstream (recharge,
    // drain-while-in-use, even a hallucinating lead's FALSE_ANCHOR reading a
    // spent one as live) is the SAME pylon logic every other pylon already
    // gets, for free, because this just becomes an entry in sim.pylons.
    case "stake":
      sim.pylons.push({
        id: `stake${sim.pylons.length}-${sim.time.toFixed(2)}`,
        x: self.x,
        z: self.z,
        charge: info.charge,
        live: true,
      });
      emit(sim, "itemUsed", "You drive the stake into the ground. It will hold, for a while.", { itemKind: "stake" });
      break;
    // A real item, honestly picked up, that was simply never going to do
    // anything — no lucidity, no steadying, no pylon. The only "reveal" here
    // is whatever the lead believed it was a moment ago; the husk itself was
    // always exactly this.
    case "husk":
      emit(sim, "itemUsed", "It crumbles in your hand. It was never going to be anything.", { itemKind: "husk", who: self.id });
      break;
    default:
      break;
  }
  return { ok: true, real: true, kind: slot.kind };
}

/**
 * Put a carried slot down. The game told the player to "use or drop" in two
 * different full-hands messages while having no drop verb at all — so a hand
 * full of phantoms could only be cleared by USING them, at PHANTOM_ITEM_COST
 * each (three of them cost a quarter of the meter). The escape hatch the
 * messages already named now exists.
 *
 * A REAL item goes back into the basin at the dropper's feet, discovered, so
 * it can be picked up again — dropping is a decision about carry space, not a
 * way to destroy supplies. A PHANTOM has nothing to put down: opening your
 * hand simply ends the fiction, at no cost. That asymmetry is the honest one —
 * the phantom was never a thing, so it cannot become a thing on the ground.
 */
export function dropItem(sim, slotIndex, actor = sim.player) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };
  const slot = sim.inventory[slotIndex];
  if (!slot) return { ok: false, reason: "empty" };
  sim.inventory.splice(slotIndex, 1);

  if (!slot.real) {
    emit(sim, "dropPhantom", "You open your hand. There was nothing in it.",
      { phantom: true, who: actor.id });
    return { ok: true, real: false };
  }
  sim.items.push({
    id: `drop${sim.slotSeq++}`,
    kind: FEATURE.ITEM,
    itemKind: slot.kind,
    x: actor.x,
    z: actor.z,
    discovered: true,
    taken: false,
  });
  emit(sim, "drop", `${ITEM_INFO[slot.kind].label} set down.`,
    { itemKind: slot.kind, who: actor.id });
  return { ok: true, real: true, kind: slot.kind };
}

/**
 * Combine two carried REAL items into a stronger one. Works off the sim's own
 * truth (like everything else in this file) — never the lead's PERCEIVED
 * inventory labels. That split is what makes a hallucinating lead's craft
 * attempt able to fail even though the item bar told them they were holding a
 * matching pair: the screen lied about what they were carrying, not this
 * function.
 *
 * Scans every pair of carried slots for the first one that both are real AND
 * form a known recipe — no slot-picking UI needed since the cap is only 3.
 * A phantom slot's `kind` is null and can never match a recipe, so it's
 * silently skipped rather than treated as a wrong guess.
 */
/**
 * What craftItem() would do right now, without doing it — a matching item
 * pair, or (if none) enough raw materials for a Stake. Shared by craftItem
 * itself and by previewCraft, so the HUD's "craft available" indicator can
 * never claim something craftItem then refuses.
 */
/**
 * Which craft is on offer. `prefer` is the player's SELECTED slot: carrying a
 * Flare, a Tether and a Lens, all three pairs are valid recipes, and a plain
 * first-match scan silently picked one by pickup order — the same three items
 * became an Ember or a Ward depending on which you happened to grab first,
 * with nothing on screen explaining why. Anchoring the pair to the selected
 * slot turns that into a choice the player already has a control for (cycle
 * item), and previewCraft reads the same function, so the hint always names
 * exactly what the craft button will make (Brain: dog#E20 — one resolver, and
 * every surface driven off its single answer).
 */
/**
 * What each carried slot is BELIEVED to be, in inventory order.
 *
 * `believed` is the caller's own reading — percept.js's believedKinds(), which
 * is literally the label the item bar is showing that mind right now. Omitting
 * it falls back to what a LUCID observer would read: a real slot is its true
 * kind, and a phantom still shows the kind it was claiming when it was picked
 * up (permanent, baked at pickup — recovering never un-tells that lie). That
 * fallback is not a testing convenience; it is the reason a stone-cold-lucid
 * lead can still craft a false item, because one ingredient was a phantom
 * somebody else handed them.
 */
function believedInventory(sim, believed) {
  return sim.inventory.map((slot, i) => (believed && believed[i]) || (slot.real ? slot.kind : slot.claimedKind));
}

function findCraftMatch(sim, prefer = -1, believed = null) {
  const view = believedInventory(sim, believed);
  // Matches on BELIEF, not truth — a phantom ingredient combines exactly like
  // the real thing, and a mind whose bar is lying gets to commit to the pair it
  // was shown. Whether the RESULT is real is craftItem's business, not this
  // function's.
  const pairFrom = (i, j) => {
    const a = sim.inventory[i], b = sim.inventory[j];
    if (!a || !b) return null;
    const kind = CRAFT_RECIPES[recipeKey(view[i], view[j])];
    return kind ? { type: "pair", i: Math.min(i, j), j: Math.max(i, j), kind, view } : null;
  };
  if (prefer >= 0 && prefer < sim.inventory.length) {
    for (let k = 0; k < sim.inventory.length; k++) {
      if (k === prefer) continue;
      const m = pairFrom(prefer, k);
      if (m) return m;
    }
  }
  for (let i = 0; i < sim.inventory.length; i++) {
    for (let j = i + 1; j < sim.inventory.length; j++) {
      const m = pairFrom(i, j);
      if (m) return m;
    }
  }
  // Wood and stone carry no deception layer at all (see the "raw materials"
  // comment above GATHER_RADIUS), so the one recipe made entirely of things
  // that cannot lie is the one craft that can never come out false.
  if (sim.wood >= STAKE_COST.wood && sim.stone >= STAKE_COST.stone) {
    return { type: "material", kind: "stake", view };
  }
  return null;
}

/**
 * Read-only preview for the HUD: is there anything to craft right now, and
 * what would it be? Mirrors craftItem()'s eventual success exactly, cap
 * check included, so the indicator is never a promise craftItem breaks.
 */
export function previewCraft(sim, prefer = -1, believed = null) {
  const match = findCraftMatch(sim, prefer, believed);
  if (!match) return { ok: false };
  if (match.type === "material" && sim.inventory.length >= ITEM_CAP) return { ok: false };
  return { ok: true, kind: match.kind };
}

/**
 * Combine two carried items into a stronger one — as the crafter understands it.
 *
 * The recipe matches on belief (findCraftMatch above), but whether the result
 * is REAL is decided here, on truth: an honest craft needs both ingredients to
 * actually exist AND the crafter to have read both of them correctly. Any
 * other combination produces a phantom that CLAIMS to be exactly what they set
 * out to make.
 *
 * Two ways to get there, and the second is what makes this a party mechanic
 * rather than a solo punishment:
 *   - the crafter is hallucinating, so the bar lied about what they held;
 *   - the crafter is perfectly lucid, but one ingredient was a phantom — from
 *     an earlier episode of their own, or handed over by a companion who was
 *     gone at the time (companionPickup/handoffToPlayer). A mind that has never
 *     hallucinated can still be carrying somebody else's.
 *
 * Nothing about the success is allowed to differ: same event kind, same text,
 * same sound at the call site. You do not find out here. You find out when you
 * reach for it (useItem) or when you try to put it in somebody else's hands
 * (offerItem) — and by then you have spent two slots and a craft on it.
 */
export function craftItem(sim, prefer = -1, believed = null) {
  if (sim.status !== "playing") return { ok: false, reason: "over" };

  const match = findCraftMatch(sim, prefer, believed);
  if (!match) return { ok: false, reason: "no-recipe" };

  if (match.type === "pair") {
    const a = sim.inventory[match.i];
    const b = sim.inventory[match.j];
    // Honest only if both ingredients exist AND were read for what they are.
    const honest = a.real && b.real && match.view[match.i] === a.kind && match.view[match.j] === b.kind;

    sim.inventory.splice(match.j, 1);
    sim.inventory.splice(match.i, 1);
    sim.stats.itemsCrafted += 1;

    if (!honest) {
      sim.stats.falseCrafts += 1;
      sim.inventory.push({
        id: nextSlotId(sim),
        real: false,
        claimedKind: match.kind, // it will go on insisting it is exactly this
        kind: null,
      });
      // Deliberately identical to the honest branch below. See the docblock.
      emit(sim, "craft", `The two combine. ${ITEM_INFO[match.kind].label} forms in your hands.`, { itemKind: match.kind });
      return { ok: true, kind: match.kind, real: false };
    }

    sim.inventory.push({ id: nextSlotId(sim), real: true, kind: match.kind, claimedKind: null });
    emit(sim, "craft", `The two combine. ${ITEM_INFO[match.kind].label} forms in your hands.`, { itemKind: match.kind });
    return { ok: true, kind: match.kind, real: true };
  }

  // Raw materials — a Stake is a carried item like any other (see useItem's
  // "stake" case), so it needs room in the cap same as a pickup would.
  if (sim.inventory.length >= ITEM_CAP) return { ok: false, reason: "full" };
  sim.wood -= STAKE_COST.wood;
  sim.stone -= STAKE_COST.stone;
  sim.inventory.push({ id: nextSlotId(sim), real: true, kind: "stake", claimedKind: null });
  sim.stats.itemsCrafted += 1;
  emit(sim, "craft", "Wood and stone lash together. A stake, ready to plant.", { itemKind: "stake" });
  return { ok: true, kind: "stake", real: true };
}

/** Everyone at camp, or close enough to walk in together. */
export function partyAtCamp(sim) {
  return sim.party.filter((c) => dist2D(c, sim.world.camp) <= 9).length;
}

/** Called once per tick after movement. Sets `status`/`ending` when the run ends. */
export function checkEndings(sim) {
  if (sim.status !== "playing") return;

  // Minds gone for GOOD. A slip is not a dissolution: at the brittle slip rate
  // six people lapse briefly all the time, and counting those collapsed 17 of
  // 20 bleak runs into "the party dissolved" when what actually happened was a
  // few seconds of overlap. The ending means nobody is coming back.
  const gone = sim.party.filter((c) => c.hallucinating && !inMicroEpisode(c)).length;
  if (gone === PARTY_SIZE) {
    sim.dissolveTimer += sim.lastDt || 0;
    if (sim.dissolveTimer >= DISSOLVE_TIME) {
      sim.status = "lost";
      sim.ending = "dissolved";
      emit(sim, "end", "Six minds, no witnesses. The basin keeps you.");
    }
  } else {
    sim.dissolveTimer = 0;
  }

  // Nobody decays in camp and nothing is racing, so the daylight limit has no
  // business ending a lesson either.
  if (!sim.noDrain && sim.time >= TIME_LIMIT && sim.status === "playing") {
    sim.status = "lost";
    sim.ending = "darkness";
    emit(sim, "end", "The light goes. Whatever is still out here stays out here.");
    return;
  }

  // `>= sim.monoliths.length` is trivially TRUE when there are no markers at
  // all, so a map with none was won by standing still — which is exactly what
  // the camp is. The tutorial ended three seconds in with an extraction screen,
  // and every test passed, because no test ever ran the win check against a map
  // with an empty objective list.
  //
  // Requiring at least one marker is right for basins too: a basin that
  // generated none should not be winnable without doing anything.
  if (sim.monoliths.length > 0 && trueLogCount(sim) >= sim.monoliths.length && sim.status === "playing") {
    // Survey complete — now walk it home. Extraction needs YOU plus at least
    // two others physically at camp; a lone lead with a written record is a
    // rumour, not a survey.
    const atCamp = sim.party.filter((c) => dist2D(c, sim.world.camp) <= 9);
    if (atCamp.includes(sim.player) && atCamp.length >= 3) {
      // You walked the record home. Now it gets read. Every marker that exists
      // is in it — but if it also contains markers that do not, the survey is
      // not a survey, and nobody can tell which half to trust. Go back out and
      // strike them: stand where the entry claims a marker and log again.
      const bad = badLogCount(sim);
      if (bad > 0) {
        sim.status = "lost";
        sim.ending = "discredited";
        emit(
          sim,
          "end",
          bad === 1
            ? "The record names one marker that isn't out there. None of it can be trusted."
            : `The record names ${bad} markers that aren't out there. None of it can be trusted.`,
        );
        return;
      }
      if (sim.level < sim.campaignLength) {
        // More basins in this campaign — main.js catches this status and
        // rebuilds a fresh basin (advanceLevel), carrying the party forward
        // instead of ending the run. The clock doesn't stop for a mind still
        // mid-hallucination at the exact moment of extraction: that state
        // carries into the next basin too.
        sim.status = "levelComplete";
        sim.ending = "advance";
        emit(sim, "advance", `Basin ${sim.level} cleared. The party pushes on.`);
      } else {
        sim.status = "won";
        sim.ending = "extracted";
        emit(sim, "end", "Camp. The record holds.");
      }
    }
  }
}

/**
 * Advance the whole simulation by `dt` seconds. Deterministic given the seed and
 * the sequence of inputs — the smoke test drives this directly through a debug
 * hook rather than waiting on wall-clock time (headless rAF runs well under
 * real time, so asserting on real seconds is a known way to get flaky tests).
 *
 * `input.interact` is a continuous HELD boolean (not an edge/tap) — it drives
 * updateGatherHold, the only per-tick system that cares whether the verb is
 * currently down rather than whether it was just pressed.
 */
/** Apply one human's movement intent to the mind they are driving. */
function moveHuman(sim, ch, intent, step) {
  if (!ch || !intent) return;
  if (intent.move && (intent.move.x || intent.move.z)) {
    const speed = (intent.run ? 7.4 : 4.3) * step;
    // CLAMP, don't normalise. Dividing by the magnitude unconditionally threw
    // away every analog stick reading: a 20%-tilted stick has magnitude 0.2,
    // got scaled straight back up to 1, and moved at full sprint — so the
    // stick behaved as a digital 8-way pad with no fine control at all.
    // Scaling only when the magnitude EXCEEDS 1 keeps the thing this was
    // originally for (keyboard diagonals, magnitude √2, must not out-run a
    // single axis) while letting a partly-tilted stick mean what it says.
    const len = Math.hypot(intent.move.x, intent.move.z);
    const scale = len > 1 ? 1 / len : 1;
    const next = moveWithCollision(
      sim.world,
      ch,
      intent.move.x * scale * speed,
      intent.move.z * scale * speed,
    );
    ch.x = next.x;
    ch.z = next.z;
  }
  if (typeof intent.yaw === "number") ch.yaw = intent.yaw;
}

// How fast the party's anchor swings onto a new direction of travel, in
// units of "fraction of the remaining error per second". Slow enough that
// sidestepping and small corrections don't slosh the whole formation; fast
// enough that a deliberate change of course has everyone re-formed within
// about a second.
const HEADING_TRACK = 3.2;
const HEADING_MIN_STEP = 1e-4; // below this the lead is standing still, not walking

/**
 * The direction the lead is TRAVELLING, smoothed — which is what party.js
 * anchors the formation to, deliberately NOT the lead's yaw.
 *
 * In a first-person game the camera IS the body, so a yaw-anchored formation
 * rotates the entire party every time the player looks around. Two things fall
 * out of that, and both were in the build: the rear guard orbits to stay behind
 * you, so a full 360-degree turn never brings them into frame even once (the
 * sweep case in tests/formation.mjs catches exactly this), and the flanks swirl
 * across the screen on every glance, which reads as five people milling about
 * rather than five people holding a line.
 *
 * Anchored to travel instead, the formation is a thing standing in the WORLD:
 * look left and the left flank stays where it was and you look AT them.
 */
function updateLeadHeading(sim, wasX, wasZ, step) {
  const p = sim.player;
  if (typeof p.heading !== "number") p.heading = p.yaw || 0;
  const dx = p.x - wasX, dz = p.z - wasZ;
  if (Math.hypot(dx, dz) < HEADING_MIN_STEP) return; // standing still: hold the line as it is
  // Same basis as the camera: forward = (-sin, -cos).
  const target = Math.atan2(-dx, -dz);
  let err = target - p.heading;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  p.heading += err * Math.min(1, HEADING_TRACK * step);
}

export function tick(sim, dt, input = {}) {
  if (sim.status !== "playing") return sim;
  const step = Math.min(dt, 0.1); // clamp: a background tab must not teleport the run
  sim.lastDt = step;
  sim.time += step;
  sim.events.length = 0;

  // Human movement. `input` is the LEAD's intent (move already yaw-rotated by
  // the caller); `input.others[i]` is the same shape for couch-co-op slot i+1.
  // Keeping slot 0 at the top level rather than requiring an array is what
  // lets every existing caller — the balance harness, the logic tests, the
  // smoke test's advance() hook — pass exactly what they always did.
  const wasX = sim.player.x, wasZ = sim.player.z;
  moveHuman(sim, sim.humans[0], input, step);
  updateLeadHeading(sim, wasX, wasZ, step);
  for (let slot = 1; slot < sim.humans.length; slot++) {
    const intent = (input.others || [])[slot - 1];
    if (intent) moveHuman(sim, sim.humans[slot], intent, step);
  }

  // Pylons recharge only while nobody is drawing on them.

  updateCompanions(sim, step);
  // Sightings are throttled: six markers × six pairs of eyes is a lot of
  // line-of-sight tracing to redo every frame, and a quarter-second of latency on
  // "there it is" is imperceptible in play while being ~8× cheaper in the
  // long-run simulations the balance harness does.
  sim.sightTimer = (sim.sightTimer || 0) - step;
  if (sim.sightTimer <= 0) {
    sim.sightTimer = 0.25;
    discover(sim);
  }

  for (const ch of sim.party) tickLucidity(sim, ch, step);

  // Unprompted chatter is the other half of the sensor: a companion who is
  // fraying will say so sideways, if you are listening.
  for (const c of sim.companions) companionRemark(sim, c, step);

  updateGatherHold(sim, step, !!input.interact);
  for (let slot = 1; slot < sim.humans.length; slot++) {
    const ch = sim.humans[slot];
    const intent = (input.others || [])[slot - 1];
    // Each human holds their own chop/mine independently — a shared progress
    // counter would let one player's release cancel the other's swing. Slot 0
    // keeps sim.gatherHold so nothing that already reads it has to change.
    if (!ch.gatherHold) ch.gatherHold = { targetId: null, progress: 0 };
    updateGatherHold(sim, step, !!(intent && intent.interact), ch, ch.gatherHold);
  }

  checkEndings(sim);
  return sim;
}

/** End-of-run debrief. Only here is the hidden state allowed to be revealed. */
export function debrief(sim) {
  return {
    status: sim.status,
    ending: sim.ending,
    time: Math.round(sim.time),
    found: discoveredCount(sim),
    logged: trueLogCount(sim),
    total: sim.monoliths.length,
    falseLogs: sim.stats.falseLogs,
    strikes: sim.stats.strikes || 0,
    slips: sim.stats.slips || 0,
    badLogs: badLogCount(sim),
    doseUses: sim.stats.doseUses,
    recoveries: sim.stats.recoveries,
    itemsUsed: sim.stats.itemsUsed,
    phantomItemsUsed: sim.stats.phantomItemsUsed,
    itemsCrafted: sim.stats.itemsCrafted,
    falseCrafts: sim.stats.falseCrafts,
    phantomsRevealed: sim.stats.phantomsRevealed,
    wood: sim.wood,
    stone: sim.stone,
    level: sim.level,
    campaignLength: sim.campaignLength,
    party: sim.party.map((c) => ({
      name: c.name,
      role: c.role,
      lucidity: Math.round(c.lucidity),
      band: bandOf(c.lucidity),
      hallucinating: c.hallucinating,
      scars: c.scars,
      goneSeconds: Math.round(c.goneTime),
    })),
  };
}

export { worldToCell, cellToWorld };
