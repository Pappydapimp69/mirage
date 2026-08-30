// main.js — wiring. Menu -> run -> debrief, and the frame loop that pumps
// input into the sim, the sim into perception, and perception into the screen.

import {
  createRun, tick, debrief, logMarker, checkIn, useDose, pickupItem, useItem, dropItem, craftItem, gatherTarget, offerItem,
  possess, release, possessableCompanions, activatePylon, pylonAt,
  callCompanion, clearMoss, mossedAt,
  PARTY_SIZE, DIFFICULTY, LOG_RADIUS, PYLON_RADIUS, ITEM_CAP, ITEM_PICKUP_RADIUS, CAMPAIGN_LENGTH, ITEM_INFO,
} from "./state.js?v=mirage-0.13.2";
import { STAGES, openObjective, checkTrainer, observe, objectiveText, stageById } from "./tutorial.js?v=mirage-0.13.2";
import { buildCamp, CAMP_SEED } from "./camp.js?v=mirage-0.13.2";
import { createPercept, updatePercept, distortion, perceivedMonoliths, believedKinds } from "./percept.js?v=mirage-0.13.2";
import { createRenderer } from "./render.js?v=mirage-0.13.2";
import { createHud, renderDebrief, paintHint } from "./hud.js?v=mirage-0.13.2";
import { createInput, ACTIONS } from "./input.js?v=mirage-0.13.2";
import { createAudio } from "./audio.js?v=mirage-0.13.2";
import { hashSeed } from "./rng.js?v=mirage-0.13.2";
import { saveRun, loadSave, clearSave, deserializeRun, describeSave, loadSettings, saveSettings } from "./save.js?v=mirage-0.13.2";

const BUILD = "mirage-0.13.2";

const el = (id) => document.getElementById(id);
const canvas = el("gl");

const audio = createAudio();
// ONE persistent input instance for the whole app lifetime — title, pause,
// debrief, and gameplay all read the same pad/keyboard, dispatched by
// input.setMode('menu' | 'game'). A per-run instance (the previous design)
// meant nothing before the first run existed could see a gamepad at all, so a
// controller-only player had no way to even press Start.
const input = createInput(canvas, { sensitivity: 1, onScheme: refreshSchemeUI });
let run = null; // { sim, percept, renderer, hud }
let paused = false;
let coopAllowed = false; // title-screen Party option; gates the mid-run join poll
// Slot 0's selection, mirrored out for the HUD, the touch buttons and the
// debug hooks. The authoritative copy lives on each player (makeLocalPlayer).
const lead = () => (run && run.players[0]) || { selected: 0, selectedItem: 0 };
let whisperTimer = 0;
// Seconds of SIM time since the last autosave (see step()).
let saveTimer = 0;
// Horizontal field of view in degrees, from stored preferences. Applied to
// each renderer as it is built, since a run can start before the pause menu
// has ever been opened.
let fovPref = 78;
// Sim-seconds between autosaves. Short enough that a closed tab costs little,
// long enough that a serialise is nowhere near a per-frame cost.
const AUTOSAVE_EVERY = 5;
let lastFrame = 0;
let campaignSeed = 0; // the seed the player actually entered/rolled — each basin in the campaign derives its own seed from this so "New basin" always starts a fresh campaign

const LAYERS = ["title", "hudLayer", "pauseLayer", "debriefLayer"];
function screens(show) {
  for (const id of LAYERS) el(id).classList.toggle("hidden", id !== show);
  input.setMode(show === "hudLayer" ? "game" : "menu");
  // Before focus is seated, so the grid is already its final shape: showing or
  // hiding Resume changes which rows exist.
  if (show === "title") { refreshTitleSave(); refreshLearnLabel(); }
  if (show !== "hudLayer") setupMenuFocus(show);
}

// ---- gamepad/keyboard menu navigation --------------------------------------
// Same shape as Opticon's menu grid nav: a screen's focusable controls carry
// data-row/data-col, horizontal nav is confined to the current row and
// vertical nav lands on the nearest column of the adjacent row — a single
// button GRID per screen, not a flat list, so no direction can ever wander
// into the wrong control (Brain: a flat single-axis focus list over visually
// distinct groups lets any direction leak into the wrong group).
const ROOT_SELECTOR = { title: "#title", pauseLayer: "#pauseLayer", debriefLayer: "#debriefLayer" };
const menu = { root: null, row: 0, col: 0 };

function menuElements() {
  const sel = ROOT_SELECTOR[menu.root];
  if (!sel) return [];
  // HIDDEN CONTROLS ARE NOT IN THE GRID. `display:none` still matches a
  // querySelector, so once the title screen gained a Resume button that only
  // appears when a save exists, a controller pressing Down landed focus on an
  // invisible row and confirm did nothing — the pad looked broken. Anything
  // that can be conditionally shown has to be filtered here, not just styled.
  return Array.from(document.querySelectorAll(`${sel} [data-row]`)).filter((e) => e.offsetParent !== null);
}
function currentFocusEl() {
  return menuElements().find((e) => Number(e.dataset.row) === menu.row && Number(e.dataset.col) === menu.col);
}
function menuFocusApply() {
  document.querySelectorAll(".gpfocus").forEach((e) => e.classList.remove("gpfocus"));
  const cur = currentFocusEl();
  if (cur) {
    cur.classList.add("gpfocus");
    cur.scrollIntoView?.({ block: "nearest" });
  }
}
function menuNavX(delta) {
  const els = menuElements().filter((e) => Number(e.dataset.row) === menu.row);
  const cols = els.map((e) => Number(e.dataset.col)).sort((a, b) => a - b);
  if (cols.length < 2) return;
  const i = cols.indexOf(menu.col);
  const next = Math.max(0, Math.min(cols.length - 1, (i < 0 ? 0 : i) + delta));
  if (cols[next] === menu.col) return;
  menu.col = cols[next];
  menuFocusApply();
}
function menuNavY(delta) {
  const rows = [...new Set(menuElements().map((e) => Number(e.dataset.row)))].sort((a, b) => a - b);
  if (rows.length < 2) return;
  const i = rows.indexOf(menu.row);
  const next = Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + delta));
  if (rows[next] === menu.row) return;
  menu.row = rows[next];
  const rowCols = menuElements().filter((e) => Number(e.dataset.row) === menu.row).map((e) => Number(e.dataset.col));
  if (!rowCols.includes(menu.col)) menu.col = rowCols[0] ?? 0;
  menuFocusApply();
}
function menuConfirm() {
  // Not a synthetic keyboard/mouse event, just `.click()` — the DOM element's
  // own listener (set difficulty, start the run, resume, …) does the real work
  // identically regardless of what triggered it, the same pattern Opticon uses.
  currentFocusEl()?.click();
}
function menuCancel() {
  if (menu.root === "pauseLayer") togglePause(); // B backs out to resume, same as Escape
}
function setupMenuFocus(root) {
  const prevRoot = menu.root;
  menu.root = root;
  const els = menuElements();
  if (!els.length) {
    input.setMenuHandlers(null, null, null, null);
    return;
  }
  const stillValid = prevRoot === root && els.some((e) => Number(e.dataset.row) === menu.row && Number(e.dataset.col) === menu.col);
  if (!stillValid) {
    menu.row = Number(els[0].dataset.row);
    menu.col = Number(els[0].dataset.col);
  }
  menuFocusApply();
  input.setMenuHandlers(menuNavX, menuNavY, menuConfirm, menuCancel);
}

// ---- device-adaptive UI (Brain: device-adaptive-ui / show-the-active-scheme)
// Reshape the on-screen UI to match whichever device is actually in the
// player's hands, live, as devices change — never make the player translate.
function menuHintFor(scheme) {
  return {
    keyboard: "Arrows / WASD move · Enter / Space select",
    gamepad: "D-pad / stick move · [A] select · [B] back",
    touch: "Tap to select",
  }[scheme] || "";
}
function refreshSchemeUI(scheme) {
  document.body.dataset.scheme = scheme;
  document.querySelectorAll(".menu-hints").forEach((e) => paintHint(e, menuHintFor(scheme)));
  if (run) run.hud.setHints(scheme);
}


// ---- title-screen save state ------------------------------------------------
// Whether a resumable save exists, re-read every time the title screen is
// shown (a run can end, or another tab can clear it, while the title sits open).
let hasSaveNow = false;
// One-press-to-arm guard on "Walk in" while a save exists — see its handler.
let newRunArmed = false;

/**
 * Sync the title screen to whatever is in the save slot: show or hide Resume,
 * label it with how far the run got, and reset the discard confirmation.
 * Deliberately reports basin/elapsed/difficulty and NOTHING about anyone's
 * lucidity — the meters are invisible, and a menu is not a loophole for them.
 */
function refreshTitleSave() {
  const data = loadSave();
  hasSaveNow = !!data;
  newRunArmed = false;
  const start = el("startBtn");
  if (start) {
    start.textContent = hasSaveNow ? "New run" : "Walk in";
    start.classList.remove("confirm-new");
  }
  const btn = el("continueBtn");
  if (!btn) return;
  btn.classList.toggle("show", hasSaveNow);
  if (hasSaveNow) {
    const d = describeSave(data);
    const mm = String(d.minutes).padStart(2, "0");
    const ss = String(d.seconds).padStart(2, "0");
    el("continueDetail").textContent =
      `basin ${d.level} of ${d.campaignLength} · ${mm}:${ss} in · ${DIFFICULTY[d.difficulty]?.label || d.difficulty} · seed ${d.seed}`;
  }
  // The menu grid changes shape when Resume appears/disappears, so re-seat
  // focus or a controller can be left pointing at a row that no longer exists.
  if (menu.root === "title") setupMenuFocus("title");
}

// ---- the walk in -----------------------------------------------------------
// A tutorial stage is a REAL run, mounted through the same mountRun as anything
// else, with its basin post-processed by applyStage. There is no tutorial mode
// to exit and no second implementation of any verb — the overlay only watches
// (brain: the-game-prologue#E15).
let tut = null; // { stage, index, done } while a stage is running; null otherwise

function tutorialProgress() {
  const s = loadSettings();
  return s.tutorial || { done: [], current: 0 };
}

function refreshLearnLabel() {
  const d = el("learnDetail");
  if (!d) return;
  const p = tutorialProgress();
  const n = p.done.length;
  d.textContent = n === 0 ? "" : n >= STAGES.length ? " · done" : ` · ${n}/${STAGES.length}`;
  // Loud until it has been finished, then it steps back. A player who has never
  // done the walk in should not have to notice a quiet button underneath a loud
  // one to find out the game has a tutorial at all.
  el("learnBtn")?.classList.toggle("quiet", n >= STAGES.length);
}

/**
 * Start the walk in: ONE run, on the camp, from objective `index`.
 *
 * The old shape built a fresh basin per stage and tore it down on completion,
 * so nothing persisted and nowhere was anywhere. This mounts the camp once;
 * `openObjective` then opens each objective around a player who never leaves.
 */
function startTutorial(index = 0) {
  const obj = STAGES[index];
  if (!obj) { tut = null; screens("title"); return null; }
  const world = buildCamp();
  const sim = createRun({ seed: CAMP_SEED, difficulty: "gentle", level: 1, campaignLength: 1, world });
  // Nobody decays while they are being taught. Time still moves, so the call
  // cadences still recharge — see state.js noDrain.
  sim.noDrain = true;
  sim.canClearMoss = false;
  sim.callUnlocked = false;
  sim.trainer = world.trainer;
  campParty(sim, world);
  const r = mountRun(sim, obj.brief);
  tut = { index, stage: obj, done: false, beats: [] };
  enterObjective(index, sim);
  return r;
}

/**
 * Place everybody for the camp: the trainer where the map says, the rest
 * standing around the yard. Nobody follows during the walk in — canonically
 * they finished their own training yesterday — so they are simply here.
 */
function campParty(sim, world) {
  const yard = world.camp;
  sim.companions.forEach((c, i) => {
    const a = (i / sim.companions.length) * Math.PI * 2;
    c.x = yard.x + Math.cos(a) * 6 + 14;
    c.z = yard.z + Math.sin(a) * 6;
    c.wanderUntil = Infinity;   // stand still; the walk in is not about them moving
    c.pingAt = Infinity;
  });
  sim.player.x = world.spawn.x;
  sim.player.z = world.spawn.z;
}

/** Open objective `index` in the run already on screen. */
function enterObjective(index, sim = run.sim) {
  const obj = STAGES[index];
  if (!obj) return;
  tut = { index, stage: obj, done: false, beats: [] };
  openObjective(sim, obj);
  setObjective(`${index + 1}/${STAGES.length}  ${obj.title}`, obj.brief);
  if (obj.line) setTimeout(() => run && hudSay(`${sim.companions[obj.line.who - 1].name}: ${obj.line.text}`), 1200);
}

function setObjective(title, text) {
  const box = el("objective");
  if (!box) return;
  box.classList.toggle("hidden", !title);
  if (!title) return;
  el("objectiveTitle").textContent = title;
  el("objectiveText").textContent = text || "";
}

function hudSay(text) { run?.hud.say(text, ""); }

/** An objective's step just fired: show its debrief, then open the next one. */
function completeStage() {
  if (!tut || tut.done) return;
  tut.done = true;
  const { stage, index } = tut;
  const p = tutorialProgress();
  if (!p.done.includes(stage.id)) p.done.push(stage.id);
  p.current = Math.min(index + 1, STAGES.length);
  saveSettings({ tutorial: p });
  setObjective(`${stage.title} — done`, stage.debrief);
  hudSay(stage.debrief);
  // Long enough to read, short enough that it does not feel like a cutscene.
  setTimeout(() => {
    if (!tut) return;
    const next = index + 1;
    if (next >= STAGES.length) { tut = null; setObjective(null); screens("title"); return; }
    // NO REMOUNT. The same run, the same camp, the same player standing where
    // they were left — only the objective changes.
    enterObjective(next);
  }, 4200);
}

function startRun({ seed, difficulty } = {}) {
  const seedValue = seed ?? Math.floor(Math.random() * 0xffffff) + 1;
  campaignSeed = seedValue;
  tut = null;
  setObjective(null);
  const sim = createRun({ seed: seedValue, difficulty: difficulty || "standard", level: 1, campaignLength: CAMPAIGN_LENGTH });
  // A NEW run always clears the slot: leaving the old save behind would offer
  // a Resume that silently jumps out of the run now on screen (Brain: dbh#E4 —
  // New Game must go through the real construction path, and must not leave
  // stale authoritative state lying around behind it).
  clearSave();
  return mountRun(sim, "Six of you. One basin. Keep them together.");
}

/**
 * Resume a saved run. Deliberately shares mountRun with startRun so a resumed
 * run is wired EXACTLY like a fresh one — same percept binding, renderer, hud,
 * player list. Returns null if there is nothing valid to resume, so the caller
 * can fall back rather than mounting a half-run.
 */
function resumeRun() {
  const data = loadSave();
  const sim = data && deserializeRun(data);
  if (!sim) return null;
  campaignSeed = sim.seed;
  return mountRun(sim, `Basin ${sim.level} of ${sim.campaignLength}. You pick up where you stopped.`);
}

/** Everything a run needs on screen, shared by a fresh start and a resume. */
function mountRun(sim, openingLine) {
  // DROP THE PREVIOUS RUN'S RENDERER FIRST.
  //
  // Every mount builds a fresh scene, a fresh geometry set and a fresh WebGL
  // context on the same canvas. advanceLevel already disposed the outgoing one
  // when moving basin to basin; this path — title -> run -> title -> run, and
  // every tutorial start — never did, so a session that bounced in and out of
  // the menu a few times stacked live contexts on one canvas. Browsers hard-cap
  // those and start discarding the OLDEST, which presents as a black screen
  // with nothing in the console.
  run?.renderer?.dispose?.();
  const seedValue = sim.seed;
  const percept = createPercept(sim.player);
  const renderer = createRenderer(canvas, sim);
  renderer.setFov(fovPref);
  const hud = createHud(sim, percept, { onChorus: () => audio.play("chorus") });
  paused = false;
  whisperTimer = 0;
  run = { sim, percept, renderer, hud, players: [makeLocalPlayer(0, sim.player, percept)] };
  hud.setHints(input.activeScheme);
  hud.say(openingLine, "warn");
  saveTimer = 0;
  el("seedLabel").textContent = `seed ${seedValue}`;
  screens("hudLayer");
  audio.start();
  // The camp is a wood in daylight; a basin is a fogged plain. Crossfaded, not
  // switched — see audio.js setBiome.
  audio.setBiome(sim.world.cellKind ? 1 : 0);
  // A controller player has no use for mouse pointer lock — their look comes
  // from the right stick regardless of lock state — and requesting it here
  // would either no-op or flash a browser permission prompt for nothing.
  if (input.activeScheme !== "gamepad") input.requestLock();
  lastFrame = 0;
  // No assignment to window.__mirage here: `sim`, `percept` and `renderer` are
  // getters over the live `run`, so they already follow this new run. Writing to
  // them throws in strict mode (ES modules are always strict), which is exactly
  // what the smoke test caught.
  return run;
}

/**
 * A basin cleared with more of the campaign left: rebuild a fresh world under
 * the same run rather than dropping to the debrief screen. The party's
 * lucidity/scars/hallucination state, doses, inventory, and cumulative stats
 * carry forward (see createRun's carryOver) — a worn-down party walks into the
 * next fog still worn down, not reset to full. Percept/renderer are rebuilt
 * from scratch because the world (terrain, rock instancing, monolith/pylon/
 * item positions) is entirely new geometry, not something last basin's
 * renderer can be pointed at in place.
 */
function advanceLevel() {
  const old = run.sim;
  const carryOver = {
    party: old.party.map((c) => ({
      id: c.id,
      lucidity: c.lucidity,
      scars: c.scars,
      hallucinating: c.hallucinating,
      hallucination: c.hallucination,
      goneTime: c.goneTime,
      // Rolled once at campaign start (createRun ignores these for the
      // player, who has no trait vector) — carried so a personality doesn't
      // reshuffle at the next basin.
      drain: c.drain,
      stoic: c.stoic,
      chatty: c.chatty,
      wander: c.wander,
      selfCare: c.selfCare,
      // Couch co-op: carry who a second player is driving across the basin
      // boundary, or their pad goes dead at the transition.
      humanSlot: c.humanSlot,
    })),
    doses: old.doses,
    inventory: old.inventory,
    slotSeq: old.slotSeq,
    wood: old.wood,
    stone: old.stone,
    stats: old.stats,
    // Travels with the inventory it names, so ids stay unique across basins.
    nextSlotId: old.nextSlotId,
  };
  const nextLevel = old.level + 1;
  // Deterministic per-level seed derived from the campaign's own seed, so a
  // given campaign seed always produces the same sequence of basins.
  const seed = campaignSeed + nextLevel * 104729;
  const sim = createRun({ seed, difficulty: old.difficulty, level: nextLevel, campaignLength: old.campaignLength, carryOver });
  const percept = createPercept(sim.player);
  run.renderer.dispose();
  const renderer = createRenderer(canvas, sim);
  renderer.setFov(fovPref);
  const hud = createHud(sim, percept, { onChorus: () => audio.play("chorus") });
  hud.setHints(input.activeScheme);
  hud.say(`Basin ${nextLevel} of ${sim.campaignLength}. The party pushes on.`, "warn");
  // createRun rebuilt every character object, so each joined player's percept
  // has to be re-bound to the NEW object for the mind they are driving —
  // sim.humans is already restored in slot order by carryOver.
  const players = sim.humans.map((ch, slot) =>
    slot === 0 ? makeLocalPlayer(0, ch, percept) : makeLocalPlayer(slot, ch, createPercept(ch)));
  run = { sim, percept, renderer, hud, players };
  lastFrame = 0;
}

/**
 * The pylon this mind BELIEVES it is standing in — real, phantom, or a spent
 * one the hallucination is still painting as full. Truth is never consulted;
 * that is the point.
 */
function nearestBelievedPylon(sim, percept, actor) {
  if (!percept?.active) return null;
  for (const ph of percept.phantomPylons || []) {
    if (Math.hypot(ph.x - actor.x, ph.z - actor.z) <= PYLON_RADIUS) return ph;
  }
  for (const p of sim.pylons) {
    if (!percept.deadPylonsLookLive?.has(p.id)) continue;
    if (Math.hypot(p.x - actor.x, p.z - actor.z) <= PYLON_RADIUS) return p;
  }
  return null;
}

function nearestPhantom(sim, percept, actor = sim.player) {
  if (!percept.active) return null;
  let best = null, bestD = Infinity;
  for (const ph of percept.phantomMonoliths) {
    const d = Math.hypot(ph.x - actor.x, ph.z - actor.z);
    if (d < bestD) { bestD = d; best = ph; }
  }
  return bestD <= LOG_RADIUS ? best : null;
}

/** Is there a pickup within reach right now? Checked before falling back to a
 * marker survey — one contextual "interact" verb, not a separate pickup button. */
function nearestPickupItem(sim, actor = sim.player) {
  return sim.items
    .filter((it) => it.discovered && !it.taken && Math.hypot(it.x - actor.x, it.z - actor.z) <= ITEM_PICKUP_RADIUS)
    .sort((a, b) => Math.hypot(a.x - actor.x, a.z - actor.z) - Math.hypot(b.x - actor.x, b.z - actor.z))[0] || null;
}

/**
 * Run one verb. `player` is the local player pressing the button — slot 0 (the
 * lead) by default. Every verb below takes the acting CHARACTER, so a joined
 * player surveys the marker THEY are standing at and picks up the item THEY
 * walked to, rather than firing the lead's action from across the basin.
 *
 * What stays shared is the pack, not the position: one inventory, one dose
 * supply, one wood/stone pile. Two people reaching into the same bag is the
 * intended co-op texture — the argument about who gets the last flare is the
 * point — so only the reach itself is per-actor.
 */
function handleAction(action, arg, player = run.players[0]) {
  const { sim, hud } = run;
  const actor = player.eye;
  const percept = player.percept;
  if (sim.status !== "playing") return;
  switch (action) {
    case ACTIONS.SURVEY: {
      // A pickup takes priority over a survey when both are in reach — items
      // sit much closer to the ground than a monolith you can stand inside the
      // radius of, so this only ever matters when the player deliberately
      // walked up to something small.
      const item = nearestPickupItem(sim, actor);
      if (item) {
        const pres = pickupItem(sim, actor);
        if (!pres.ok) {
          audio.play("deny");
          hud.say(pres.reason === "full" ? "Hands are full. Use or drop something first." : "Nothing to pick up here.", "warn");
        } else {
          audio.play(pres.real ? "log" : "logFalse");
        }
        break;
      }
      // Gathering is next in the priority chain, but it's a HOLD now (see
      // tick()'s updateGatherHold), not a tap — a bare press here just needs
      // to not fall through to a confusing "nothing to survey" message.
      if (gatherTarget(sim, actor)) break;
      // Standing in an unspent pylon, the verb spends it. Same key, because a
      // pylon is not something you carry or aim — it is a thing you are
      // standing in, and "act on what is here" already means exactly that. It
      // takes priority over surveying: nobody walks into the light of a pylon
      // to write in a notebook.
      // Believed pylons, not real ones. A hallucinating lead is shown pylons
      // that are not there and spent ones that look full; if the verb only
      // responded to real ones, pressing it on a phantom would do nothing
      // visible and that silence would be a perfect lucidity readout. So the
      // press always LANDS — same line, same sound — and the difference shows
      // up as nobody ever joining you.
      // Moss first: a crusted pylon is not a pylon yet, and pylonAt hides it
      // deliberately. Pressing the verb on one gives a real in-fiction answer
      // either way — it comes off, or it will not shift — which is what makes
      // this a gate on the WORLD rather than a guard on the input.
      const mossy = mossedAt(sim, actor);
      if (mossy) {
        const mres = clearMoss(sim, mossy, actor);
        audio.play(mres.ok ? "recover" : "deny");
        hud.say(mres.ok
          ? "The moss comes away. Whatever this is, it is still live."
          : "Moss has grown right over it. It will not shift.", mres.ok ? "good" : "warn");
        break;
      }
      const believedPylon = pylonAt(sim, actor) || nearestBelievedPylon(sim, percept, actor);
      if (believedPylon) {
        const ares = activatePylon(sim, actor);
        audio.play(ares.confirmed ? "recover" : "log");
        if (ares.confirmed) {
          hud.say(
            `The pylon gives out. ${ares.caught} of you caught it — it will not light again.`,
            "good",
          );
        } else {
          hud.say("Hands on the pylon. It needs a second pair before it will give.", "warn");
        }
        break;
      }
      const res = logMarker(sim, nearestPhantom(sim, percept, actor), actor);
      if (!res.ok) {
        // A failed survey used to be silent-but-for-a-sound-cue — indistinguishable
        // from the button doing nothing at all if audio hadn't started or wasn't
        // noticed. Every press now says something on screen.
        audio.play("deny");
        hud.say(res.reason === "over" ? "The survey is already over." : "Nothing to survey here.", "warn");
      } else {
        audio.play(res.real ? "log" : "logFalse");
      }
      break;
    }
    case ACTIONS.CALL: {
      // Locked until the walk in teaches it, and only there — a basin run sets
      // callUnlocked at construction. Gated by ABSENCE of the verb rather than
      // by a silent refusal so the tutorial never has to intercept an input.
      if (sim.callUnlocked === false) break;
      const target = sim.companions[player.selected];
      if (!target) break;
      const cres = callCompanion(sim, target.id, actor);
      // Only the cadences refuse, and a refusal is silent and free. There is no
      // "nobody answered" line and there never will be: that would report the
      // hidden meter through an error string. The call sounds the same whether
      // or not anybody is coming; what differs is whether anybody arrives.
      if (cres.ok) audio.play("log");
      break;
    }
    case ACTIONS.CHECK_IN: {
      // An explicit arg (a keyboard digit) both targets AND becomes the shared
      // selection, so the roster highlight and Q/R/LB/RB cycling anchor move
      // with it. Without updating `selected` here, a gamepad's X/Y buttons —
      // which carry no arg and rely on this shared value — would act on
      // whatever LB/RB last cycled to, never on a digit-picked companion.
      if (typeof arg === "number") player.selected = arg;
      const target = sim.companions[player.selected];
      if (!target) return;
      // The report filters through the ASKER's percept — a hallucinating
      // player two garbles their own answers, and never the lead's.
      hud.showReport(checkIn(sim, target.id), player.percept);
      break;
    }
    case ACTIONS.DOSE: {
      if (typeof arg === "number") player.selected = arg;
      const target = sim.companions[player.selected];
      if (!target) return;
      if (useDose(sim, target.id)) audio.play("dose");
      else audio.play("deny");
      break;
    }
    case ACTIONS.NEXT_TARGET:
      player.selected = (player.selected + 1) % (PARTY_SIZE - 1);
      break;
    case ACTIONS.PREV_TARGET:
      player.selected = (player.selected + PARTY_SIZE - 2) % (PARTY_SIZE - 1);
      break;
    case ACTIONS.CYCLE_ITEM:
      if (sim.inventory.length) player.selectedItem = (player.selectedItem + 1) % sim.inventory.length;
      break;
    case ACTIONS.USE_ITEM: {
      if (!sim.inventory.length) {
        audio.play("deny");
        hud.say("Nothing carried to use.", "warn");
        break;
      }
      if (player.selectedItem >= sim.inventory.length) player.selectedItem = 0;
      const target = sim.companions[player.selected];
      // Read what THIS ACTOR believed the slot was, before useItem consumes it
      // and the slot id stops meaning anything. useItem itself never sees
      // percept (state.js stays honest) — this is the one glue point allowed
      // to compare what percept.js told them against what state.js actually
      // does, and only to pick a cue/message, never to change the outcome.
      const slot = sim.inventory[player.selectedItem];
      const shownKind = slot?.real ? percept.itemLabels.get(slot.id) : null;
      const misidentified = !!shownKind && shownKind !== slot.kind;
      const ures = useItem(sim, player.selectedItem, target?.id, actor);
      if (!ures.ok) { audio.play("deny"); break; }
      if (!ures.real || misidentified) {
        // The hallucination just broke on contact: either there was nothing
        // there at all (useItem already said so), or the item was real but
        // not what this actor believed. Either way, a distinct cue — not the
        // ordinary "dose" chime a correctly-seen item gets.
        audio.play("reveal");
        if (misidentified) hud.say(`That wasn't ${ITEM_INFO[shownKind].label}. It was ${ITEM_INFO[ures.kind].label}.`, "warn");
      } else {
        audio.play("dose");
      }
      if (player.selectedItem >= sim.inventory.length && player.selectedItem > 0) player.selectedItem -= 1;
      break;
    }
    case ACTIONS.DROP_ITEM: {
      if (!sim.inventory.length) {
        audio.play("deny");
        hud.say("Nothing carried to put down.", "warn");
        break;
      }
      if (player.selectedItem >= sim.inventory.length) player.selectedItem = 0;
      const dres = dropItem(sim, player.selectedItem, actor);
      if (!dres.ok) { audio.play("deny"); break; }
      audio.play(dres.real ? "log" : "logFalse");
      if (player.selectedItem >= sim.inventory.length && player.selectedItem > 0) player.selectedItem -= 1;
      break;
    }
    case ACTIONS.CRAFT: {
      // Crafts against what THIS player's item bar is SHOWING, not the sim's
      // truth, so a mind that believes it holds a matching pair always gets to
      // commit — and finds out what it actually built later (state.craftItem).
      // `player.selectedItem` anchors WHICH pair, so the hint and the craft
      // never disagree about what is about to be made.
      const cres = craftItem(sim, player.selectedItem, believedKinds(percept, sim));
      if (!cres.ok) {
        audio.play("deny");
        hud.say(cres.reason === "full" ? "Hands are full. Use or drop something first." : "Nothing here combines.", "warn");
        break;
      }
      // Deliberately does NOT branch on cres.real: a false craft has to look,
      // sound and read exactly like an honest one at the moment it happens.
      audio.play("log");
      player.selectedItem = Math.max(0, sim.inventory.length - 1); // land selection on the new item
      break;
    }
    case ACTIONS.OFFER_ITEM: {
      if (!sim.inventory.length) {
        audio.play("deny");
        hud.say("Nothing carried to offer.", "warn");
        break;
      }
      if (player.selectedItem >= sim.inventory.length) player.selectedItem = 0;
      const target = sim.companions[player.selected];
      if (!target) break;
      const ores = offerItem(
        sim,
        player.selectedItem,
        target.id,
        believedKinds(percept, sim)[player.selectedItem],
        actor,
      );
      if (!ores.ok) {
        audio.play("deny");
        if (ores.reason === "too-far") hud.say(`${target.name} is too far to hand anything to.`, "warn");
        else if (ores.reason === "no-target") hud.say("Pick someone else to hand it to.", "warn");
        break;
      }
      // Branches on whether the offer was CALLED OUT, never on whether the item
      // was real: a phantom that two deceived minds pass between them has to
      // sound exactly like a real one landing, or the sound is the tell.
      audio.play(ores.revealed ? "logFalse" : "dose");
      if (player.selectedItem >= sim.inventory.length && player.selectedItem > 0) player.selectedItem -= 1;
      break;
    }
    case ACTIONS.PAUSE:
      togglePause();
      break;
    default:
      break;
  }
}

function togglePause() {
  if (!run || run.sim.status !== "playing") return;
  paused = !paused;
  screens(paused ? "pauseLayer" : "hudLayer");
  if (!paused && input.activeScheme !== "gamepad") input.requestLock();
}

// ---- couch co-op -----------------------------------------------------------
//
// A joined player drives an existing companion (see state.js possess), gets
// their OWN percept, and gets their own half of the screen. Two humans in the
// same basin are therefore shown two different worlds — the second player can
// be walking confidently toward a marker the first cannot see. That asymmetry
// is the mode: the information each of you holds is unreliable in a DIFFERENT
// way, so you have to keep talking (Brain: COUCH-MULTIPLAYER/role-balance —
// an asymmetric split only stays load-bearing while each side holds something
// the other lacks).

function makeLocalPlayer(slot, eye, percept) {
  // selected/selectedItem are PER PLAYER: the pack is shared, but "which
  // companion am I aiming this tether at" and "which slot am I holding" are
  // each player's own pointer into it. Sharing them would make one player's
  // cycle silently move the other's selection mid-reach.
  return { slot, eye, percept, yaw: eye.yaw || 0, pitch: 0, selected: 0, selectedItem: 0, lastMonsterId: null };
}

/** Split the canvas into one viewport per player, in DEVICE pixels for Three. */
function viewportsFor(n) {
  const W = canvas.width, H = canvas.height;
  if (n <= 1) return [null]; // null = "use the whole canvas"
  // Side-by-side, never stacked: a top/bottom split halves viewport HEIGHT,
  // which is what breaks proportionally-sized HUD text (Brain:
  // COUCH-MULTIPLAYER/ui — fixed-pixel text floor). Halving width instead
  // keeps every text row at its full single-player height.
  const w = Math.floor(W / 2);
  return [
    { x: 0, y: 0, w, h: H },
    { x: w, y: 0, w: W - w, h: H },
  ];
}

/** Poll for someone on the couch pressing Start on an unclaimed pad. */
function pollCoopJoin() {
  if (!coopAllowed) return;
  const { sim } = run;
  const padIndex = input.pendingJoinPad();
  if (padIndex === null) return;
  const free = possessableCompanions(sim);
  if (!free.length) return;
  const target = free[0];
  const slot = possess(sim, target.id);
  if (slot === null) return;
  input.claimPad(padIndex, slot);
  run.players.push(makeLocalPlayer(slot, target, createPercept(target)));
  run.hud.say(`${target.name} is player ${slot + 1} now.`, "good");
  const nameEl = el(`coopName${slot + 1}`);
  if (nameEl) nameEl.textContent = target.name;
  document.body.dataset.coop = String(run.players.length);
  run.renderer.resize();
}

/** Drop the last joined player, handing their mind back to the party AI. */
function dropCoopPlayer(slot) {
  const { sim } = run;
  if (!release(sim, slot)) return;
  input.releaseSlot(slot);
  run.players = run.players.filter((p) => p.slot !== slot);
  const nameEl = el(`coopName${slot + 1}`);
  if (nameEl) nameEl.textContent = "—";
  document.body.dataset.coop = String(run.players.length);
  run.renderer.resize();
}

/** One simulation + presentation step. Separated from rAF so tests can drive it. */
function step(dt, intent) {
  const { sim, percept, renderer, hud } = run;
  const yaw = intent.yaw ?? 0;
  // Screen-space intent rotated into world space by the camera's yaw. Note this
  // uses the REAL yaw: a lead with a scrambled compass still walks where their
  // body is pointed, they just believe it is a different direction.
  // Three's camera looks down -Z, so after a yaw rotation of θ about Y the basis
  // is forward = (-sinθ, -cosθ) and right = (cosθ, -sinθ). Screen-space intent
  // (W is z = -1) is projected onto that basis. Getting these signs wrong is
  // invisible to a "did the player move?" test — it moved, just backwards — and
  // it also silently put the follow formation in front of the lead.
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const move = {
    x: intent.move.x * cos + intent.move.z * sin,
    z: -intent.move.x * sin + intent.move.z * cos,
  };

  for (const { action, arg } of intent.queue) handleAction(action, arg);
  // handleAction() (pickup/use/craft/gather/log/dose) emits into sim.events —
  // but tick()'s own first line wipes that array clean for ITS OWN internal
  // emits (discover/recover/hallucinate/chatter/...), per sim.events'
  // documented contract ("transient, drained by the HUD each frame" —
  // createRun's own comment) that tick() owns and resets that array once per
  // call. That contract is also load-bearing elsewhere (the balance harness
  // and a couple of logic tests call tick() directly in a loop and count
  // sim.events per call, which only works if each call starts clean) — so
  // the fix here is a LOCAL, one-shot capture passed straight to hud.update,
  // never written back into sim.events. This is why pickup/use/craft
  // subtitles (and the flare-use flash) never actually appeared: the event
  // existed for a few statements and was gone before anything read it.
  const actionEvents = sim.events.slice();

  // Couch co-op: read each joined player's own pad and rotate their movement
  // by THEIR facing, not the lead's. A slot whose pad has vanished (unplugged,
  // flat battery) contributes no intent this frame — its character simply
  // stands still rather than inheriting someone else's stick.
  const others = [];
  for (let i = 1; i < run.players.length; i++) {
    const p = run.players[i];
    // A debug intent (the test harness's advance() hook) bypasses the pad
    // entirely — already world-space, no look/queue. Real play polls the pad.
    const dbg = intent.others && intent.others[i - 1];
    if (dbg) {
      if (typeof dbg.yaw === "number") p.yaw = dbg.yaw;
      others.push({ move: dbg.move || { x: 0, z: 0 }, run: !!dbg.run, yaw: p.yaw, interact: !!dbg.interact });
      continue;
    }
    const raw = input.pollSlot(p.slot);
    if (!raw) { others.push(null); continue; }
    if (raw.leave) { dropCoopPlayer(p.slot); i--; continue; }
    p.yaw -= raw.look.dx * 0.0022;
    p.pitch = Math.max(-1.2, Math.min(1.2, p.pitch - raw.look.dy * 0.0022));
    const s2 = Math.sin(p.yaw), c2 = Math.cos(p.yaw);
    others.push({
      move: { x: raw.move.x * c2 + raw.move.z * s2, z: -raw.move.x * s2 + raw.move.z * c2 },
      run: raw.run,
      yaw: p.yaw,
      interact: raw.interact,
    });
    // Verbs now take the acting character, so a joined player's press acts on
    // THEIR position and THEIR hallucination state — not the lead's.
    for (const action of raw.queue) handleAction(action, undefined, p);
  }

  tick(sim, dt, { move, run: intent.run, yaw, interact: intent.interact, others });
  // The camp's one place-based objective. Emits once, into the same merged
  // stream the observer reads, so "walk to the trainer" is an ordinary event
  // like any other rather than a special case inside the overlay.
  if (tut && sim.trainer) checkTrainer(sim, (s2, kind, text, opts) => sim.events.push({ ...opts, kind, text, t: s2.time }));
  const events = actionEvents.concat(sim.events);

  // THE observer hook. It has to be here and nowhere else: `sim.events` alone
  // is wiped by tick() on its first line, so every verb a stage teaches —
  // pickup, craft, offerUsed, draw, report — exists only in this merged array.
  // An observer in state.js would have watched an empty stream forever without
  // erroring (brain: sandbox-resolver-starves-tutorial#E2 — one silent
  // starvation candidate per pipeline layer).
  if (tut && !tut.done) {
    const p = tutorialProgress();
    // The movement stage has no entity to pin to, so it watches distance
    // walked rather than an event, and synthesises the one kind it needs.
    const seen = tut.stage.step.on === "moved"
      ? (Math.hypot(sim.player.x - tut.startX, sim.player.z - tut.startZ) >= tut.stage.step.minDistance
          ? [{ kind: "moved" }] : [])
      : events;
    // `tut` is the one object that lives for exactly as long as the stage does,
    // which makes it the only correct home for a multi-target step's running
    // tally — `p` is rebuilt from localStorage every frame (see observe).
    // BEATS — mid-objective moments that are not completions. The pylon
    // objective needs one: clearing the moss is not finishing it, it is the
    // point where the trainer casts doubt and hands you the verb that answers
    // him. Each beat fires at most once, latched on `tut.beats`.
    for (const beat of tut.stage.beats || []) {
      if (tut.beats.includes(beat.on)) continue;
      if (!seen.some((ev) => ev.kind === beat.on)) continue;
      tut.beats.push(beat.on);
      if (beat.opens) openObjective(sim, { opens: beat.opens });
      if (beat.say) hudSay(beat.say);
    }
    if (observe(p, tut.stage, seen, sim, tut)) completeStage();
  }
  for (const p of run.players) {
    updatePercept(p.percept, sim, dt);
    // A one-shot stinger on ONSET only — the id persisting across frames
    // while the flicker holds must not replay the cue every frame, and the
    // id clearing back to null must not play it either (that's relief, not a
    // scare). One shared bed, so whichever player's own mind goes, the couch
    // hears it.
    if (p.percept.monsterId !== null && p.percept.monsterId !== p.lastMonsterId) audio.play("monster");
    p.lastMonsterId = p.percept.monsterId;
  }

  for (const ev of events) {
    if (ev.kind === "hallucinate") audio.play("hallucinate");
    else if (ev.kind === "recover") audio.play("recover");
    else if (ev.kind === "break") audio.play("break");
    else if (ev.kind === "gather") {
      // Approximate world height of the tree/deposit's visual centre (trees
      // read taller than deposits) — close enough for a dot the eye follows
      // for half a second, not a precision hit-test.
      const h = ev.resource === "wood" ? 1.4 : 0.3;
      const from = renderer.worldToScreen(ev.x, renderer.terrainHeight(ev.x, ev.z) + h, ev.z);
      hud.collectFly(ev.resource, from);
    }
  }

  // Whispers only exist for a lead who is gone.
  if (percept.active) {
    whisperTimer -= dt;
    if (whisperTimer <= 0) {
      whisperTimer = 2.5 + Math.random() * 5;
      audio.whisper();
    }
  }

  let prox = 0;
  for (const p of sim.pylons) {
    if (p.spent) continue;
    const d = Math.hypot(p.x - sim.player.x, p.z - sim.player.z);
    prox = Math.max(prox, Math.max(0, 1 - d / PYLON_RADIUS));
  }
  audio.update(distortion(percept, sim), prox);

  hud.update({ yaw, pitch: intent.pitch ?? 0 }, run.players[0].selected, run.players[0].selectedItem, actionEvents, run.players[1] || null);

  // One draw per player, each from that player's OWN percept — which is what
  // lets the two halves of the screen legitimately disagree about the basin.
  // dt goes to the first draw only: `elapsed` is shared scene-animation time,
  // and advancing it once per viewport would run the world at 2x in co-op.
  const vps = viewportsFor(run.players.length);
  run.players[0].yaw = yaw;
  run.players[0].pitch = intent.pitch ?? 0;
  for (let i = 0; i < run.players.length; i++) {
    const p = run.players[i];
    renderer.update(p.percept, i === 0 ? dt : 0, { yaw: p.yaw, pitch: p.pitch }, { eye: p.eye, viewport: vps[i] });
  }

  // sim.events is documented as "transient, drained by the HUD each frame"
  // (createRun's own comment), but nothing actually drained it until now:
  // tick() only clears it at the START of ITS OWN call, so whatever tick()
  // emitted internally this frame (gather/discover/recover/hallucinate/
  // chatter/...) was still sitting in sim.events when THIS frame ends. The
  // next frame's `actionEvents = sim.events.slice()` (meant to rescue only
  // THIS frame's own handleAction emits from tick()'s upcoming clear) would
  // then mistake last frame's already-handled tick events for fresh ones and
  // reprocess them a second time a frame late — a duplicate audio cue, a
  // repeated subtitle line, or (caught by testing the new collect-fly
  // animation) a second dot flying to a pill that already landed. Clearing
  // here, once step() itself is done with `events`, is what actually fulfills
  // the "drained each frame" contract without touching tick()'s own clear,
  // which a few logic tests and the balance harness depend on when they call
  // tick() directly in a loop.
  sim.events.length = 0;

  // Autosave on the SIM's clock, not wall time, so a slow frame or a
  // backgrounded tab can't change how much progress a save is worth.
  // saveRun itself refuses anything that isn't status "playing", so the
  // ordering below (save, then handle endings) can't write a finished board.
  saveTimer += dt;
  if (saveTimer >= AUTOSAVE_EVERY) {
    saveTimer = 0;
    saveRun(sim, Date.now());
  }

  if (sim.status === "levelComplete") advanceLevel();
  else if (sim.status !== "playing") finish();
}

function finish() {
  // The run is over: drop the slot before showing the debrief, so "Resume"
  // can never hand the player back the frame they already lost (Brain:
  // wrong-sky#E2 — never keep a save of an ended world).
  clearSave();
  const report = debrief(run.sim);
  renderDebrief(el("debriefLayer"), report);
  screens("debriefLayer");
  if (document.exitPointerLock) document.exitPointerLock();
  el("againBtn")?.addEventListener("click", () => screens("title"));
}

function frame(now) {
  requestAnimationFrame(frame);
  if (!lastFrame) lastFrame = now;
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt <= 0) return;
  // input.poll() runs every frame regardless of screen — that is what lets a
  // gamepad drive the title/pause/debrief menus before any run exists at all.
  // In 'menu' mode it only has side effects (scheme tracking, dispatching to
  // the registered menu handlers) and returns null; in 'game' mode it also
  // returns the movement intent the sim step needs. Scheme-change UI updates
  // are pushed via the onScheme callback (refreshSchemeUI), not polled here.
  const intent = input.poll(dt);
  if (!run || paused || run.sim.status !== "playing" || !intent) return;
  pollCoopJoin();
  step(dt, intent);
}

// ---- menu wiring -----------------------------------------------------------
function boot() {
  el("buildLabel").textContent = BUILD;
  // Preferences OUTLIVE runs — they live in their own storage key, so losing a
  // campaign (which clears the run slot) never also resets your volume.
  const prefs = loadSettings();
  let difficulty = prefs.difficulty;
  fovPref = prefs.fov;
  for (const b of document.querySelectorAll("[data-fov]")) {
    b.classList.toggle("sel", Number(b.dataset.fov) === prefs.fov);
    b.addEventListener("click", () => {
      fovPref = Number(b.dataset.fov);
      saveSettings({ fov: fovPref });
      run?.renderer.setFov(fovPref);
      for (const o of document.querySelectorAll("[data-fov]")) o.classList.toggle("sel", o === b);
    });
  }
  audio.setVolume(prefs.volume);
  for (const b of document.querySelectorAll("[data-vol]")) {
    b.classList.toggle("sel", Number(b.dataset.vol) === prefs.volume);
  }
  for (const b of document.querySelectorAll("[data-diff]")) {
    b.classList.toggle("sel", b.dataset.diff === prefs.difficulty);
  }
  coopAllowed = prefs.coop === "couch";
  for (const b of document.querySelectorAll("[data-coop-opt]")) {
    b.classList.toggle("sel", b.dataset.coopOpt === prefs.coop);
  }
  for (const btn of document.querySelectorAll("[data-diff]")) {
    btn.addEventListener("click", () => {
      difficulty = btn.dataset.diff;
      saveSettings({ difficulty });
      for (const b of document.querySelectorAll("[data-diff]")) b.classList.toggle("sel", b === btn);
    });
  }
  // Couch co-op is an OPTION, chosen on the title screen — never something a
  // stray second controller can spring on a solo run. Solo is the default;
  // the mid-run join poll runs only when "Couch co-op" was picked.
  for (const btn of document.querySelectorAll("[data-coop-opt]")) {
    btn.addEventListener("click", () => {
      coopAllowed = btn.dataset.coopOpt === "couch";
      saveSettings({ coop: btn.dataset.coopOpt });
      for (const b of document.querySelectorAll("[data-coop-opt]")) b.classList.toggle("sel", b === btn);
    });
  }
  el("startBtn").addEventListener("click", () => {
    // Starting fresh DISCARDS a saved run, so when one exists the first press
    // only arms the button and says so. A destructive action reachable by one
    // press of the control the player has been pressing all along is how you
    // lose someone's campaign to muscle memory.
    if (hasSaveNow && !newRunArmed) {
      newRunArmed = true;
      const btn = el("startBtn");
      btn.textContent = "Discard saved run — press again";
      btn.classList.add("confirm-new");
      return;
    }
    const raw = el("seedInput").value.trim();
    const seed = raw ? (/^\d+$/.test(raw) ? Number(raw) : hashSeed(raw)) : undefined;
    startRun({ seed, difficulty });
  });
  el("continueBtn").addEventListener("click", () => {
    if (!resumeRun()) refreshTitleSave(); // the save vanished or was unreadable — re-sync the button
  });
  el("learnBtn").addEventListener("click", () => {
    const p = tutorialProgress();
    // Resume where they stopped; a finished tutorial restarts from the top
    // rather than refusing, because these are worth replaying.
    startTutorial(p.current >= STAGES.length ? 0 : p.current);
  });
  el("howBtn").addEventListener("click", () => el("howto").classList.toggle("hidden"));
  el("resumeBtn").addEventListener("click", togglePause);
  el("quitBtn").addEventListener("click", () => {
    run = null;
    paused = false;
    screens("title");
  });
  // Discrete steps rather than a range slider — see the HTML comment: a
  // slider has no natural gamepad binding, but these buttons slot straight
  // into the same row/col grid nav as everything else in the pause menu.
  for (const btn of document.querySelectorAll("[data-vol]")) {
    btn.addEventListener("click", () => {
      const v = Number(btn.dataset.vol);
      audio.setVolume(v);
      saveSettings({ volume: v });
      for (const b of document.querySelectorAll("[data-vol]")) b.classList.toggle("sel", b === btn);
    });
  }
  // Touch action buttons mirror the keyboard verbs. Survey/pickup still fires
  // on tap (click, which lands on release); pointerdown/pointerup ALSO track
  // held state for the hold-to-gather mechanic, exactly like HELD.has("KeyE")
  // does for keyboard — a touch button has no physical "held" state of its
  // own, so input.js needs to be told.
  el("btnSurvey").addEventListener("click", () => run && handleAction(ACTIONS.SURVEY));
  el("btnSurvey").addEventListener("pointerdown", () => input.setTouchInteractHeld(true));
  el("btnSurvey").addEventListener("pointerup", () => input.setTouchInteractHeld(false));
  el("btnSurvey").addEventListener("pointerleave", () => input.setTouchInteractHeld(false));
  el("btnSurvey").addEventListener("pointercancel", () => input.setTouchInteractHeld(false));
  el("btnCheck").addEventListener("click", () => run && handleAction(ACTIONS.CHECK_IN, lead().selected));
  el("btnDose").addEventListener("click", () => run && handleAction(ACTIONS.DOSE, lead().selected));
  el("btnNext").addEventListener("click", () => run && handleAction(ACTIONS.NEXT_TARGET));
  el("btnItem")?.addEventListener("click", () => run && handleAction(ACTIONS.CYCLE_ITEM));
  el("btnUse")?.addEventListener("click", () => run && handleAction(ACTIONS.USE_ITEM));
  el("btnCraft")?.addEventListener("click", () => run && handleAction(ACTIONS.CRAFT));
  el("btnGive")?.addEventListener("click", () => run && handleAction(ACTIONS.OFFER_ITEM));

  // A closing tab, a backgrounded phone, an alt-tab: all of these can end the
  // session between autosaves, so flush on the way out. visibilitychange is the
  // one that actually fires reliably on mobile — beforeunload does not.
  const flush = () => { if (run && !paused) saveRun(run.sim, Date.now()); };
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flush(); });

  screens("title");
  requestAnimationFrame(frame);
}

// Debug/test hook. The smoke test drives `advance()` rather than waiting on wall
// time: headless rAF runs at a fraction of real speed, so asserting on real
// elapsed seconds is a known source of false failures. Everything the tests
// need to observe is reachable from here.
if (typeof window !== "undefined") {
  window.__mirage = {
    build: BUILD,
    startRun,
    get sim() { return run?.sim ?? null; },
    get percept() { return run?.percept ?? null; },
    // Exposed so the smoke test can assert the scene was actually DRAWN.
    // "the module loaded and nothing threw" is a false green for 3D: under
    // software GL a broken scene graph still loads clean, so the test reads
    // Three's own draw-call counter instead.
    get renderer() { return run?.renderer ?? null; },
    get paused() { return paused; },
    get selected() { return lead().selected; },
    get selectedItem() { return lead().selectedItem; },
    act: (action, arg) => run && handleAction(action, arg),
    /** Leave the run for the title screen — what "quit" does, for tests. */
    toTitle() { run = null; paused = false; screens("title"); },
    /** Feed a raw pointer-lock delta in CSS pixels, as a real mouse would.
     * The DPI test needs to send the SAME PHYSICAL sweep at several display
     * scaling levels, and the only honest way to do that is to hand the input
     * layer the CSS-pixel figure a real device would report at that scaling. */
    debugMouseLook(dx, dy) { return input.debugLook(dx, dy); },
    /** Start a tutorial stage by index — the same path the title button takes. */
    startStage(i) { return startTutorial(i); },
    enterObjective(i) { return enterObjective(i); },
    /** Which stages are recorded done, for the browser tutorial test. */
    tutorialDone() { return tutorialProgress().done.slice(); },
    /** Drive the menu grid down one row — for testing focus over a changing menu. */
    menuDown() { menuNavY(1); },
    // Couch co-op, driven without physical controllers. The real join path is
    // a pad press (pollCoopJoin); this is the same possession + percept +
    // viewport wiring with the device step skipped, so a test can exercise
    // split-screen and independent hallucination in a headless browser.
    get players() { return run ? run.players : []; },
    debugJoin(companionId) {
      if (!run) return null;
      const target = companionId
        ? run.sim.companions.find((c) => c.id === companionId)
        : possessableCompanions(run.sim)[0];
      if (!target) return null;
      const slot = possess(run.sim, target.id);
      if (slot === null) return null;
      run.players.push(makeLocalPlayer(slot, target, createPercept(target)));
      const nameEl = el(`coopName${slot + 1}`);
      if (nameEl) nameEl.textContent = target.name;
      document.body.dataset.coop = String(run.players.length);
      run.renderer.resize();
      return slot;
    },
    debugDrop(slot) { if (run) dropCoopPlayer(slot); },
    get coopAllowed() { return coopAllowed; },
    /** Per-player views, so a test can compare what each human is SHOWN. */
    perceivedMonolithsFor(slot) {
      const p = run && run.players[slot];
      return p ? perceivedMonoliths(p.percept, run.sim) : [];
    },
    distortionFor(slot) {
      const p = run && run.players[slot];
      return p ? distortion(p.percept, run.sim) : 0;
    },
    /** Advance the sim by `seconds` in fixed slices, optionally holding movement. */
    advance(seconds, intent = {}) {
      if (!run) return null;
      const slice = 1 / 30;
      let done = 0;
      while (done < seconds && run.sim.status === "playing") {
        step(slice, {
          move: intent.move || { x: 0, z: 0 },
          run: !!intent.run,
          yaw: intent.yaw ?? run.sim.player.yaw,
          pitch: 0,
          queue: [],
          interact: !!intent.interact,
          others: intent.others || null,
        });
        done += slice;
      }
      return run.sim.time;
    },
    /** Drop a character's lucidity directly — for testing the hallucination path. */
    drain(id, to = 0) {
      if (!run) return null;
      const ch = run.sim.party.find((c) => c.id === id);
      if (!ch) return null;
      ch.lucidity = to;
      return ch.lucidity;
    },
    teleport(x, z) {
      if (!run) return null;
      run.sim.player.x = x;
      run.sim.player.z = z;
      return { x, z };
    },
    debrief: () => (run ? debrief(run.sim) : null),
    DIFFICULTY,
    ACTIONS,
    CAMPAIGN_LENGTH,
  };
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
