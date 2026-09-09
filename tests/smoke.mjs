// Headless browser smoke test for MIRAGE. Boots the real page in Chromium,
// starts a run, drives it, and asserts on observable state.
// Run: node tests/smoke.mjs [scenario]
//   scenario: play (default) | hallucinate | phantomLog
//
// Two lessons are baked into this file:
//
// 1. NEVER ASSERT ON WALL-CLOCK TIME. Headless rAF runs at a fraction of real
//    speed, so "wait 3 seconds, expect ~3 seconds of drain" is a flake. Every
//    timing assertion below drives `window.__mirage.advance(seconds)`, which
//    steps the sim in fixed slices, and then reads the sim's own clock.
//
// 2. "IT LOADED AND NOTHING THREW" IS A FALSE GREEN FOR 3D. Software GL will
//    happily load a scene that draws nothing. So this asserts on Three's own
//    draw-call counter, and degrades gracefully (reporting SKIP, not PASS) if the
//    environment has no working WebGL at all.

import { createRequire } from "module";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/node22/lib/node_modules/playwright");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, ".."); // this repo's root — MIRAGE is standalone, served at "/"
// The static server binds port 0 — the OS picks a free one. A hardcoded port
// fails with EADDRINUSE when an earlier run's server is still up, and that
// failure looks nothing like the game being broken; it just burns a debug cycle.
const SCENARIO = process.argv[2] || "play";

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function serve() {
  return http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
}

// Screenshot options. Both parts matter under software GL:
//   animations: "disabled" — the hallucinating vignette runs an infinite CSS
//     animation, and a capture that waits for the page to settle never settles.
//   timeout — a 1280x800 readback with the full-screen overlay composited over a
//     live WebGL canvas measured ~5s here and occasionally blew the 30s default.
//     That is the environment being slow, not the game being wrong, so the fix is
//     a real timeout rather than a smaller assertion.
const SHOT = { animations: "disabled", timeout: 180000 };

/**
 * Take a review screenshot WITHOUT letting it fail the run.
 *
 * These captures assert nothing — they exist so a human can look at a frame.
 * But compositing a full-viewport animated overlay over a live WebGL canvas
 * under swiftshader is brutally CPU-bound: measured at 177s on this machine
 * for the in-hallucination frame, against a scene whose draw calls and
 * triangle count were unchanged (21 / 21546). A slow compositor turning an
 * otherwise green suite red is a false alarm that costs a debugging cycle
 * every time, and worse, trains you to ignore the suite. So: try, and if the
 * environment cannot do it in time, say so in the notes and carry on. Every
 * real assertion around these lines still runs.
 */
async function shoot(page, name) {
  try {
    await page.screenshot({ path: path.join(ROOT, "tests", name), ...SHOT });
    return true;
  } catch (e) {
    notes.push(`SKIP screenshot ${name} — ${e.name || "error"} (environment too slow to composite; no assertion lost)`);
    return false;
  }
}

const failures = [];
const notes = [];
function assert(cond, msg) {
  if (!cond) failures.push(msg);
}

(async () => {
  const server = serve();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const PORT = server.address().port;

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: [
      "--use-gl=swiftshader",
      // Note the spelling: `--enable-unsafe-swiftshader`, not `--allow-...`.
      // Without it, newer Chromium refuses the software path and getContext
      // returns null, which looks exactly like a broken game.
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-sandbox",
    ],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => !!window.__mirage, null, { timeout: 15000 });

  const build = await page.$eval("#buildLabel", (el) => el.textContent);
  assert(build && build !== "—", `build label never populated (got ${JSON.stringify(build)})`);

  // Is there usable WebGL here at all? If not, the 3D assertions are skipped
  // rather than reported as passing.
  const glOk = await page.evaluate(() => {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  });
  if (!glOk) notes.push("SKIP: no WebGL in this environment — 3D assertions not run");

  // Start a run on a fixed seed so the basin is the same every time.
  await page.click('[data-diff="standard"]');
  await page.fill("#seedInput", "1234");
  await page.click("#startBtn");
  await page.waitForFunction(() => !!window.__mirage.sim, null, { timeout: 10000 });

  const start = await page.evaluate(() => {
    const s = window.__mirage.sim;
    return {
      party: s.party.length,
      companions: s.companions.length,
      monoliths: s.monoliths.length,
      pylons: s.pylons.length,
      doses: s.doses,
      seed: s.seed,
      status: s.status,
      hudVisible: !document.getElementById("hudLayer").classList.contains("hidden"),
      // No meter may be rendered anywhere in the HUD.
      hudText: document.getElementById("hudLayer").innerText,
    };
  });
  assert(start.party === 6, `expected 6 in the party, got ${start.party}`);
  assert(start.companions === 5, `expected 5 NPC companions, got ${start.companions}`);
  assert(start.monoliths === 6 && start.pylons === 5, "world features missing");
  assert(start.seed === 1234, `seed not honoured: ${start.seed}`);
  assert(start.hudVisible, "HUD did not appear");
  assert(!/\b\d{2}\s*\/\s*100\b/.test(start.hudText), "the HUD appears to render a lucidity value");

  // A frame from the opening position, for visual review: the party in
  // formation, in daylight, before any of the test's teleports.
  await shoot(page, "shot-start.png");

  // --- drive the sim on ITS OWN CLOCK -------------------------------------
  const walked = await page.evaluate(() => {
    const before = { x: window.__mirage.sim.player.x, z: window.__mirage.sim.player.z };
    // WALKING, not running. Cohesion removed following: companions match a
    // lead who WALKS (4.6 units/sec against 4.3) and cannot match one who runs
    // (7.4). This advanced with `run: true` and still passed, because on the
    // 46-cell basin the rim stopped a sprint after ~30 units and the party
    // caught up against the wall. On the 65-cell basin there is room to
    // actually run away, and 8 seconds of it put the whole party 48-66 units
    // back — which is the design working, not a regression. The keep-up
    // assertion below is about the walking contract, so walk.
    const t = window.__mirage.advance(8, { move: { x: 0, z: -1 } });
    const s = window.__mirage.sim;
    return {
      simTime: t,
      moved: Math.hypot(s.player.x - before.x, s.player.z - before.z),
      lucidity: s.player.lucidity,
      companionSpread: s.companions.map((c) => Math.hypot(c.x - s.player.x, c.z - s.player.z)),
    };
  });
  assert(walked.simTime >= 7.9, `sim clock only reached ${walked.simTime}s after advancing 8s`);
  assert(walked.moved > 3, `player barely moved (${walked.moved.toFixed(2)} units in 8 sim-seconds)`);
  // The first 5 minutes of a basin are a grace window (LUCIDITY_GRACE, state.js)
  // — nobody's meter moves yet at 8 sim-seconds in, on purpose.
  assert(walked.lucidity === 100, `lucidity moved inside the opening grace window: ${walked.lucidity}`);
  // NOT "did they keep up". Following is gone: companions walk their own
  // errands and only come when CALLED, so a lead who walks off leaves them
  // behind BY DESIGN. This asserted 3 of 5 within 22 units and passed only
  // because the 46-cell basin's rim stopped the lead after ~30 units; on the
  // 65-cell one the same 8 seconds opens a 27-38 unit gap and the assertion
  // was measuring the wall, not the party. What cohesion actually promises is
  // that the CALL closes the gap, so that is what is checked.
  assert(walked.companionSpread.every((d) => Number.isFinite(d) && d < 200),
    `a companion is nowhere near the basin: ${walked.companionSpread}`);
  // The distance alone is NOT enough to assert on: the ping cadence brings a
  // companion back on its own, so "they got closer over 12 seconds" passes with
  // the call deleted — measured, by deleting it. The summon LATCH is the call's
  // own effect and nothing else sets it, so assert that first and the closing
  // second.
  const called = await page.evaluate(() => {
    const M = window.__mirage, s = M.sim;
    const id = s.companions[M.selected].id;
    const at = () => { const c = s.companions.find((x) => x.id === id); return { c, d: Math.hypot(c.x - s.player.x, c.z - s.player.z) }; };
    const before = at();
    const latchBefore = before.c.summonUntil ?? 0;
    M.act(M.ACTIONS.CALL);
    const latchAfter = before.c.summonUntil ?? 0;
    const summonBy = before.c.summonBy ?? null;
    M.advance(12, { move: { x: 0, z: 0 } });
    return { id, before: before.d, after: at().d, latchBefore, latchAfter, summonBy, now: s.time };
  });
  assert(called.latchAfter > called.now && called.latchAfter > called.latchBefore,
    `CALL did not summon ${called.id}: summonUntil ${called.latchBefore} -> ${called.latchAfter} at t=${called.now.toFixed(1)}`);
  assert(called.summonBy !== null, `CALL summoned ${called.id} without recording who called`);
  assert(called.after < called.before - 5,
    `${called.id} was summoned but did not come in: ${called.before.toFixed(1)} -> ${called.after.toFixed(1)} units`);

  if (glOk) {
    const drew = await page.evaluate(() => {
      const info = window.__mirage.renderer.renderer.info;
      return { calls: info.render.calls, triangles: info.render.triangles };
    });
    assert(drew.calls > 0, "the renderer made zero draw calls — the scene is not being drawn");
    assert(drew.triangles > 1000, `suspiciously few triangles drawn: ${drew.triangles}`);
    notes.push(`drew ${drew.calls} calls / ${drew.triangles} triangles`);
  }

  // --- the hallucination path ---------------------------------------------
  const gone = await page.evaluate(() => {
    const M = window.__mirage;
    M.sim.time = 300; // past LUCIDITY_GRACE — drain is withheld for the first 5 minutes of a basin
    M.drain("you", 0.05);
    M.advance(1);
    const s = M.sim;
    const p = M.percept;
    M.advance(4); // let the distortion ramp
    return {
      hallucinating: s.player.hallucinating,
      kind: s.player.hallucination,
      perceptActive: p.active,
      intensity: p.intensity,
      // The INLINE target opacity, not getComputedStyle: the vignette has a
      // 0.6s CSS transition, so the computed value right after the change is
      // still mid-fade and reads ~0. Asserting on it tests the transition, not
      // the game.
      vignette: Number(document.getElementById("vignette").style.opacity || 0),
      vignetteLost: document.getElementById("vignette").classList.contains("lost"),
      rosterText: document.getElementById("roster").innerText,
      // The sim's own record must be untouched by the lie layer.
      realMonoliths: s.monoliths.length,
    };
  });
  assert(gone.hallucinating, "the player did not begin hallucinating at zero lucidity");
  assert(gone.perceptActive, "the perception layer did not activate");
  assert(gone.intensity > 0.1, `distortion never ramped (${gone.intensity})`);
  assert(gone.vignette > 0.05, `vignette stayed invisible (opacity ${gone.vignette})`);
  assert(/can't tell/.test(gone.rosterText), `the roster should stop claiming to know: ${JSON.stringify(gone.rosterText.slice(0, 120))}`);
  assert(gone.vignetteLost, "the vignette did not switch to its hallucinating variant");
  assert(gone.realMonoliths === 6, "perception contaminated the sim's own record");

  // A frame from inside a hallucination, for visual review.
  await shoot(page, "shot-gone.png");

  // Whatever kind was drawn, the perceived world must diverge from the real one
  // in the way that kind promises.
  const divergence = await page.evaluate(() => {
    const M = window.__mirage;
    const p = M.percept;
    const s = M.sim;
    return {
      kind: p.kind,
      phantomMarkers: p.phantomMonoliths.length,
      phantomCompanions: p.phantomCompanions.length,
      phantomPylons: p.phantomPylons.length,
      compassOffset: p.compassOffset,
      deadLookLive: p.deadPylonsLookLive.size,
      whisper: p.whisper,
      realCompanions: s.companions.length,
    };
  });
  const diverged =
    divergence.phantomMarkers > 0 ||
    divergence.phantomCompanions > 0 ||
    divergence.phantomPylons > 0 ||
    Math.abs(divergence.compassOffset) > 0.5 ||
    divergence.whisper !== null;
  assert(diverged, `hallucination kind ${divergence.kind} produced no perceptual divergence`);
  assert(divergence.realCompanions === 5, "a phantom companion leaked into the sim");
  notes.push(`hallucination kind: ${divergence.kind}`);

  // --- recovery -----------------------------------------------------------
  const recovered = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    // A pylon no longer works by standing in it. It fires ONCE, when someone
    // activates it — same key as survey — and is then dead for the run. So
    // this drives the real verb rather than waiting, which is also the only
    // remaining way back from a hallucination besides a dose.
    const p = s.pylons.find((x) => !x.spent) || s.pylons[0];
    p.spent = false;
    p.primedBy = [];
    p.primedAt = -1e9;
    // A pylon takes TWO. Put a lucid companion in the light so they can be the
    // second pair of hands — party.js confirms a primed pylon they are already
    // standing in. Without them the press only primes, which is exactly the
    // mechanic and exactly why this step had to change.
    const mate = s.companions[0];
    mate.hallucinating = false;
    mate.lucidity = 90;
    M.teleport(p.x, p.z);
    mate.x = p.x; mate.z = p.z;
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.5);
    return { hallucinating: s.player.hallucinating, lucidity: s.player.lucidity, perceptActive: M.percept.active, spent: p.spent };
  });
  assert(recovered.spent, "activating a pylon did not spend it");
  assert(!recovered.hallucinating, "the pylon pulse did not bring the lead back");
  assert(!recovered.perceptActive, "the perception layer stayed active after recovery");
  assert(recovered.lucidity > 20, `recovered to a suspicious level: ${recovered.lucidity}`);

  // --- verbs --------------------------------------------------------------
  const verbs = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    const before = s.doses;
    M.act(M.ACTIONS.DOSE, 0);
    const afterDose = s.doses;
    M.act(M.ACTIONS.CHECK_IN, 1);
    const subtitles = document.getElementById("subtitles").innerText;
    // Walk to a marker and survey it for real.
    const m = s.monoliths[0];
    M.teleport(m.x + 1, m.z + 1);
    M.advance(0.5);
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.2); // the HUD repaints on the frame loop, so give it a frame
    return {
      doseSpent: before - afterDose,
      subtitles,
      logged: s.monoliths.filter((x) => x.logged).length,
      entries: s.logEntries.length,
      surveyPill: document.getElementById("surveyCount").textContent,
      foundPill: document.getElementById("foundCount").textContent,
    };
  });
  assert(verbs.doseSpent === 1, `dose was not consumed (${verbs.doseSpent})`);
  // Checks for the SPEAKER'S NAME specifically, not just "some text is
  // present" — a weak length>0 check here previously passed even when the
  // check-in line silently failed to appear at all, because the leftover
  // "Six of you..." start-of-run line was still sitting in the subtitle
  // history from before (see the frame-ordering bug fixed in main.js's
  // step(): handleAction()'s emitted events were being wiped by the very
  // next tick() call in the same frame, before hud.update() ever read them).
  assert(/IREN/.test(verbs.subtitles), `check-in did not name the companion who answered: ${JSON.stringify(verbs.subtitles)}`);
  assert(verbs.logged === 1, `survey did not log the marker (${verbs.logged})`);
  assert(/1 \/ 6/.test(verbs.surveyPill), `log counter did not update: ${verbs.surveyPill}`);
  assert(/[1-6] \/ 6/.test(verbs.foundPill), `found counter never moved: ${verbs.foundPill}`);

  // --- items: pick up via the contextual survey verb, cycle, use ---------
  const items = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    const it = s.items.find((x) => !x.taken);
    it.discovered = true;
    M.teleport(it.x, it.z);
    M.advance(0.2);
    M.act(M.ACTIONS.SURVEY); // pickup takes priority over marker-survey when both are in reach
    M.advance(0.2);
    const pickedUp = s.inventory.length > 0 && it.taken;
    const barAfterPickup = document.getElementById("itemBar").innerText;
    // Push a second, known-real flare slot directly so USE_ITEM has a
    // deterministic effect to assert on, regardless of what the world roll gave us.
    s.inventory.push({ id: "smoke-flare", real: true, kind: "flare", claimedKind: null });
    M.act(M.ACTIONS.CYCLE_ITEM);
    const before = s.inventory.length;
    M.act(M.ACTIONS.USE_ITEM);
    M.advance(0.2);
    return {
      pickedUp,
      barAfterPickup,
      inventoryBeforeUse: before,
      inventoryAfterUse: s.inventory.length,
      itemsUsed: s.stats.itemsUsed + s.stats.phantomItemsUsed,
      subtitles: document.getElementById("subtitles").innerText,
    };
  });
  assert(items.pickedUp, "the survey verb did not pick up an item in reach");
  assert(items.barAfterPickup.trim().length > 0 && items.barAfterPickup !== "—", "the item bar did not show a carried item");
  assert(items.inventoryAfterUse === items.inventoryBeforeUse - 1, `USE_ITEM did not consume a slot (${items.inventoryBeforeUse} -> ${items.inventoryAfterUse})`);
  assert(items.itemsUsed >= 1, "no item use was recorded in stats");
  // CYCLE_ITEM from a fresh selectedItem=0 lands on index 1 — the manually
  // pushed flare, not whatever the world pickup happened to be — so the
  // exact use-text is deterministic. A length>0 check here is what let the
  // frame-ordering bug (see the check-in assertion above) through silently.
  assert(/The flare catches/.test(items.subtitles), `using the flare did not show its text: ${JSON.stringify(items.subtitles)}`);

  // --- crafting: two real items combine into one via the CRAFT verb -------
  const craft = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "craft-a", real: true, kind: "flare", claimedKind: null });
    s.inventory.push({ id: "craft-b", real: true, kind: "tether", claimedKind: null });
    M.act(M.ACTIONS.CRAFT);
    M.advance(0.2);
    return {
      inventory: s.inventory.map((slot) => slot.kind),
      itemsCrafted: s.stats.itemsCrafted,
      subtitles: document.getElementById("subtitles").innerText,
    };
  });
  assert(craft.inventory.length === 1 && craft.inventory[0] === "ember", `crafting flare+tether should leave one ember, got ${JSON.stringify(craft.inventory)}`);
  assert(craft.itemsCrafted === 1, "craft was not recorded in stats");
  assert(/The two combine/.test(craft.subtitles), `crafting did not show its text: ${JSON.stringify(craft.subtitles)}`);

  // --- crafting deception: the WIRING around it -----------------------------
  // logic.test.mjs already covers offerItem/craftItem's rules in isolation;
  // this section is only the parts a logic test cannot reach: the real KeyB
  // keypress, the #btnGive touch button actually being in the DOM and wired,
  // the phantom-reveal line actually reaching the subtitle element, and the
  // belief-based craft indicator actually painting through hud.js.

  // Nothing above this point in the file drives a physical keyboard event —
  // every verb test so far calls M.act()/M.advance() directly — so this uses
  // Playwright's own `keyboard`, which for a named key like "KeyB" fires a
  // genuine trusted keydown/keyup with `code: "KeyB"`, exactly what
  // input.js's onKeyDown switches on. Unlike M.act()/M.advance(), a real
  // keydown only gets drained once the game's own rAF loop calls
  // input.poll() on a LATER frame, so a short real wait follows it — this is
  // not an assertion on elapsed SIM time (nothing below reads sim.time or a
  // drain amount), just giving one real frame a chance to land, the same
  // reason gamepad.mjs's tap()/hold() helpers wait after flipping a button.
  async function pressKeyAndSettle(code) {
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press(code);
    await page.waitForTimeout(300);
  }

  // 1) KeyB is wired to ACTIONS.OFFER_ITEM end to end: give a real, useful
  // item (a Flare) to the currently-selected companion, in range and lucid,
  // and confirm it actually reached them.
  await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "give-flare", real: true, kind: "flare", claimedKind: null });
    const c = s.companions[M.selected];
    c.hallucinating = false;
    c.lucidity = 50; // clear of both 0 and the 100 cap, so a +40 restore is unambiguous
    c.x = s.player.x;
    c.z = s.player.z;
  });
  await pressKeyAndSettle("KeyB");
  const giveKey = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    return { inventory: s.inventory.length, lucidity: s.companions[M.selected].lucidity };
  });
  assert(giveKey.inventory === 0, `KeyB should consume the offered slot, inventory still has ${giveKey.inventory}`);
  // A DELTA, not a floor at 89. The restore is +40 from 50, but the press has to
  // settle through a few real frames and the meter is draining the whole time,
  // so the exact landing point is a function of how fast this machine happens to
  // be running — which is precisely the kind of assertion this repo does not
  // make. Anything near +40 proves the verb fired; anything near 0 proves it did
  // not, and no amount of frame drift closes that gap.
  const gained = giveKey.lucidity - 50;
  assert(gained >= 30, `KeyB-triggered offer did not restore the companion's lucidity (+${gained.toFixed(1)})`);

  // 2) The #btnGive touch button exists and fires the same verb — a Tether
  // this time, so the OTHER "helps" branch (steadySeconds, not restore) is
  // exercised too. `.click()` here is the element's own DOM method, not
  // Playwright's visibility-gated page.click() — the touch buttons are
  // legitimately display:none under the keyboard scheme this whole test runs
  // under (see gamepad.mjs's own assertion on that), so this proves the
  // listener is wired without fighting the scheme-adaptive CSS to do it.
  const btnGiveHandle = await page.$("#btnGive");
  assert(!!btnGiveHandle, "#btnGive is missing from the DOM");
  await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "give-tether", real: true, kind: "tether", claimedKind: null });
    const c = s.companions[M.selected];
    c.hallucinating = false;
    c.steadyUntil = 0;
  });
  await page.$eval("#btnGive", (el) => el.click());
  const btnGive = await page.evaluate(() => {
    const M = window.__mirage;
    return { inventory: M.sim.inventory.length, steadyUntil: M.sim.companions[M.selected].steadyUntil };
  });
  assert(btnGive.inventory === 0, `#btnGive should consume the offered slot, inventory still has ${btnGive.inventory}`);
  assert(btnGive.steadyUntil > 0, `#btnGive-triggered offer did not steady the companion (steadyUntil ${btnGive.steadyUntil})`);

  // 3) A phantom offered to a lucid companion is exposed ON SCREEN, not just
  // in the returned result — the only way a player learns their own item was
  // fake. Asserted on the SPECIFIC line, not merely non-empty subtitles: a
  // length>0 check here previously let a real bug through elsewhere in this
  // file (see the check-in assertion above) — the same class of bug would
  // hide a reveal behind stale text left over from tests 1/2 above.
  const offerReveal = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "phantom-flare", real: false, claimedKind: "flare", kind: null });
    const c = s.companions[M.selected];
    // STAND THEM BACK UP. Tests 1 and 2 teleported this companion onto the
    // lead; the frames those two spend pressing keys and clicking are frames
    // the companion spends walking its own errand, so by here it had wandered
    // out of hand-over range and the offer refused with "too far". Inheriting
    // another test's teleport is the same stale-precondition bug as assuming a
    // spot 30 units east of a pylon is walkable — state the precondition.
    c.x = s.player.x;
    c.z = s.player.z;
    c.hallucinating = false;
    const before = s.stats.phantomsRevealed;
    M.act(M.ACTIONS.OFFER_ITEM);
    M.advance(0.2); // the HUD repaints on the frame loop — give it a frame, same as the survey/check-in assertions above
    return {
      inventory: s.inventory.length,
      phantomsRevealed: s.stats.phantomsRevealed - before,
      subtitles: document.getElementById("subtitles").innerText,
    };
  });
  assert(offerReveal.inventory === 0, `offering a phantom should still consume the slot, inventory still has ${offerReveal.inventory}`);
  assert(offerReveal.phantomsRevealed === 1, "offering a phantom to a lucid companion did not record a reveal");
  assert(/There's nothing there\./.test(offerReveal.subtitles), `phantom reveal text did not reach the subtitles: ${JSON.stringify(offerReveal.subtitles)}`);

  // 4) The craft-ready indicator reflects BELIEF, not truth, end to end
  // through hud.js: two real items that genuinely combine (Flare + Tether ->
  // Ember, per CRAFT_RECIPES) should light #craftHint up and name the result
  // — the guard that the new belief-view plumbing didn't quietly break the
  // ordinary, honest case.
  const craftHint = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "hint-a", real: true, kind: "flare", claimedKind: null });
    s.inventory.push({ id: "hint-b", real: true, kind: "tether", claimedKind: null });
    M.advance(0.2); // let hud.update() run at least once against the new inventory
    const el = document.getElementById("craftHint");
    const res = { visible: el.classList.contains("show"), text: el.textContent };
    s.inventory.length = 0; // leave a clean slate for the gathering/stake tests below, which expect no leftover craftable pair
    return res;
  });
  assert(craftHint.visible, "craftHint did not appear for a genuine Flare+Tether pair");
  assert(/Ember/.test(craftHint.text), `craftHint did not name the expected result: ${JSON.stringify(craftHint.text)}`);

  // --- item hallucinations: a mislabeled real item reveals on use, a husk is
  // real but does nothing --------------------------------------------------
  const reveal = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.inventory.length = 0;
    s.inventory.push({ id: "reveal-flare", real: true, kind: "flare", claimedKind: null });
    s.player.hallucinating = true;
    // Force the lie deterministically rather than trusting the roll: the
    // player believes slot 0 is a Lens, it is really a Flare.
    M.percept.itemLabels.set("reveal-flare", "lens");
    // Leave room for the restore to be visible. The calm window is now five
    // minutes, so the lead is still pinned at full this early in a smoke run
    // and "did the Flare put light back" could not be answered either way.
    s.player.lucidity = 40;
    const lucidityBefore = s.player.lucidity;
    M.act(M.ACTIONS.USE_ITEM);
    M.advance(0.2);
    return {
      subtitles: document.getElementById("subtitles").innerText,
      lucidityRestored: s.player.lucidity > lucidityBefore,
      inventoryAfter: s.inventory.length,
    };
  });
  assert(/That wasn't Lens\. It was Flare\./.test(reveal.subtitles), `misidentified use did not reveal the truth: ${JSON.stringify(reveal.subtitles)}`);
  assert(reveal.lucidityRestored, "a mislabeled Flare must still apply its REAL effect when used");
  assert(reveal.inventoryAfter === 0, "the used slot was not consumed");

  const husk = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.player.hallucinating = false;
    s.inventory.length = 0;
    s.inventory.push({ id: "husk-0", real: true, kind: "husk", claimedKind: null });
    const lucidityBefore = s.player.lucidity;
    const before = s.stats.itemsUsed;
    M.act(M.ACTIONS.USE_ITEM);
    // Compare BEFORE the advance below: passive drain runs every tick
    // regardless of what was used, so any elapsed time — not the husk —
    // would otherwise account for the difference.
    const lucidityRightAfterUse = s.player.lucidity;
    M.advance(0.2); // let hud.update() paint the subtitle
    return {
      subtitles: document.getElementById("subtitles").innerText,
      lucidityUnchanged: lucidityRightAfterUse === lucidityBefore,
      itemsUsed: s.stats.itemsUsed - before,
      inventoryAfter: s.inventory.length,
    };
  });
  assert(/crumbles/.test(husk.subtitles), `using a husk did not show its text: ${JSON.stringify(husk.subtitles)}`);
  assert(husk.lucidityUnchanged, "a husk must have no effect at all");
  assert(husk.itemsUsed === 1, "husk use was not counted");
  assert(husk.inventoryAfter === 0, "the husk slot was not consumed");

  // --- gathering: chop a tree, mine a deposit, craft and plant a Stake ----
  // Gathering is a HOLD, not a tap: a single M.act(SURVEY) must NOT gather,
  // and only holding interact for long enough should.
  const gather = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    // Record the .gain pulse as it happens. M.advance() steps the sim
    // synchronously in a tight loop, so BOTH gathers below land within a few
    // real milliseconds — by the time this evaluate() returns, a pulse that
    // was read directly could already have expired. An observer turns a
    // fleeting class into a durable fact.
    window.__gainSeen = { wood: false, stone: false };
    for (const [key, id] of [["wood", "woodPill"], ["stone", "stonePill"]]) {
      const pill = document.getElementById(id);
      new MutationObserver(() => {
        if (pill.classList.contains("gain")) window.__gainSeen[key] = true;
      }).observe(pill, { attributes: true, attributeFilter: ["class"] });
    }
    const t = s.trees.find((x) => !x.chopped);
    t.discovered = true;
    M.teleport(t.x, t.z);
    M.advance(0.2);
    M.act(M.ACTIONS.SURVEY); // a bare tap must not chop
    M.advance(0.1);
    const choppedAfterTap = t.chopped;
    M.advance(1.5, { interact: true }); // now hold it
    const woodAfterChop = s.wood;
    const st = s.stones.find((x) => !x.mined);
    st.discovered = true;
    M.teleport(st.x, st.z);
    M.advance(0.2);
    M.advance(1.5, { interact: true });
    return {
      choppedAfterTap,
      chopped: t.chopped,
      mined: st.mined,
      woodAfterChop,
      stoneAfterMine: s.stone,
      woodPill: document.getElementById("woodCount").textContent,
      stonePill: document.getElementById("stoneCount").textContent,
      // Both dots are still mid-flight here (they live ~550ms of real time,
      // and everything above took a few ms), so this is a safe read.
      spawnedFlies: document.querySelectorAll(".gather-fly").length,
    };
  });
  assert(!gather.choppedAfterTap, "a bare tap should not chop a tree — gathering must be a hold");
  assert(gather.chopped, "holding interact did not chop a tree in reach");
  assert(gather.mined, "holding interact did not mine a deposit in reach");
  assert(gather.woodAfterChop >= 1, "wood was not credited");
  assert(gather.stoneAfterMine >= 1, "stone was not credited");
  assert(gather.woodPill !== "0", `wood pill did not update: ${gather.woodPill}`);
  assert(gather.stonePill !== "0", `stone pill did not update: ${gather.stonePill}`);

  // The collect-fly animation (hud.js collectFly/pillGain) is the one part of
  // this file that genuinely runs on WALL-CLOCK time — CSS transitions and
  // setTimeout, not the sim clock — so M.advance() can't drive it. It is still
  // asserted by POLLING for the end state (waitForFunction), never by sleeping
  // a fixed span and reading once: the .gain pulse is only ~420ms wide, and a
  // loaded headless box can easily slide a fixed read outside that window. The
  // MutationObserver installed above is what makes "the pulse happened" a
  // recorded fact rather than something that had to be caught mid-flight.
  assert(gather.spawnedFlies > 0, "chopping/mining did not spawn a .gather-fly element");
  // Generous timeouts, on purpose. These wait on WALL-CLOCK browser timers
  // (collectFly's ~550ms flight, pillGain's ~420ms pulse) in an environment
  // that renders this scene at 8-10fps under software GL and saturates the
  // main thread doing it — a 550ms timer routinely lands seconds late here,
  // and a 5s budget failed on exactly that. What is being asserted is that
  // the animation CLEANS UP, not that it is fast; picking a tight bound would
  // be re-making this file's own lesson about wall-clock assertions.
  // Report the live count on failure — "never cleaned up" alone doesn't say
  // whether nothing was removed or something keeps spawning more.
  await page.waitForFunction(() => document.querySelectorAll(".gather-fly").length === 0, null, { timeout: 30000 })
    .catch(async () => {
      const n = await page.evaluate(() => document.querySelectorAll(".gather-fly").length);
      throw new Error(`gather-fly dot(s) were never cleaned up after landing (${n} still present, ${gather.spawnedFlies} spawned)`);
    });
  const pulsed = await page.evaluate(() => window.__gainSeen);
  assert(pulsed.wood, "wood pill never got its landing highlight (.gain)");
  assert(pulsed.stone, "stone pill never got its landing highlight (.gain)");
  await page.waitForFunction(() => !document.querySelector(".pill.gain"), null, { timeout: 30000 })
    .catch(() => { throw new Error("a pill's landing highlight (.gain) never cleared") });

  const stake = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    s.wood = 2;
    s.stone = 2;
    M.act(M.ACTIONS.CRAFT); // no matching item pair carried -> falls back to the wood+stone recipe
    const pylonsBefore = s.pylons.length;
    const stakeSlot = s.inventory.findIndex((slot) => slot.kind === "stake");
    M.teleport(30, 30);
    M.advance(0.2);
    // Cycle selection onto whichever slot actually holds the stake — it may
    // not be slot 0 depending on what else is carried.
    while (M.sim.inventory[M.selectedItem]?.kind !== "stake" && M.sim.inventory.some((x) => x.kind === "stake")) {
      M.act(M.ACTIONS.CYCLE_ITEM);
    }
    M.act(M.ACTIONS.USE_ITEM);
    M.advance(0.2);
    return {
      craftedStake: stakeSlot >= 0,
      pylonsAfter: s.pylons.length,
      pylonsBefore,
      plantedAt: s.pylons[s.pylons.length - 1] ? { x: s.pylons[s.pylons.length - 1].x, z: s.pylons[s.pylons.length - 1].z } : null,
    };
  });
  assert(stake.craftedStake, "wood+stone did not craft a stake");
  assert(stake.pylonsAfter === stake.pylonsBefore + 1, `using a stake should plant exactly one pylon (${stake.pylonsBefore} -> ${stake.pylonsAfter})`);
  assert(stake.plantedAt && Math.abs(stake.plantedAt.x - 30) < 0.5 && Math.abs(stake.plantedAt.z - 30) < 0.5, `stake planted at the wrong spot: ${JSON.stringify(stake.plantedAt)}`);

  // --- campaign: clearing a basin before the last one advances in place ---
  const level = await page.evaluate(() => {
    const M = window.__mirage;
    const s = M.sim;
    const levelBefore = s.level;
    const monolithPosBefore = s.monoliths.map((m) => `${m.x.toFixed(1)},${m.z.toFixed(1)}`).join("|");
    for (const m of s.monoliths) m.logged = true;
    s.logEntries = s.monoliths.map((m) => ({ id: m.id, name: m.name, real: true, t: s.time }));
    M.teleport(s.world.camp.x, s.world.camp.z);
    s.companions[0].x = s.world.camp.x;
    s.companions[0].z = s.world.camp.z;
    s.companions[1].x = s.world.camp.x;
    s.companions[1].z = s.world.camp.z;
    M.advance(0.5);
    return {
      levelBefore,
      levelAfter: M.sim.level,
      campaignLength: M.sim.campaignLength,
      monolithPosBefore,
      monolithPosAfter: M.sim.monoliths.map((m) => `${m.x.toFixed(1)},${m.z.toFixed(1)}`).join("|"),
      allUnlogged: M.sim.monoliths.every((m) => !m.logged),
      status: M.sim.status,
      hudVisible: !document.getElementById("hudLayer").classList.contains("hidden"),
      debriefVisible: !document.getElementById("debriefLayer").classList.contains("hidden"),
      levelPill: document.getElementById("levelLabel").textContent,
    };
  });
  assert(level.campaignLength > 1, `expected a real playthrough to opt into a multi-basin campaign, got length ${level.campaignLength}`);
  assert(level.levelAfter === level.levelBefore + 1, `clearing a basin should advance the level (${level.levelBefore} -> ${level.levelAfter})`);
  assert(level.status === "playing", `the new basin should be live and playing, got ${level.status}`);
  assert(level.hudVisible && !level.debriefVisible, "advancing a level should stay on the HUD, not drop to the debrief screen");
  assert(level.monolithPosAfter !== level.monolithPosBefore, "the next basin should be genuinely new geometry, not the same markers again");
  assert(level.allUnlogged, "the new basin's markers should start unlogged");
  assert(new RegExp(`${level.levelAfter} / ${level.campaignLength}`).test(level.levelPill), `level pill did not update: ${level.levelPill}`);

  // --- pause really stops the world ---------------------------------------
  const paused = await page.evaluate(async () => {
    const M = window.__mirage;
    M.act(M.ACTIONS.PAUSE);
    const t0 = M.sim.time;
    const l0 = M.sim.player.lucidity;
    await new Promise((r) => setTimeout(r, 400));
    const res = { pausedDuring: M.paused, dt: M.sim.time - t0, dl: l0 - M.sim.player.lucidity };
    M.act(M.ACTIONS.PAUSE);
    res.pausedAfter = M.paused;
    return res;
  });
  assert(paused.pausedDuring === true, "pause did not engage");
  assert(paused.pausedAfter === false, "pause did not toggle back off");
  assert(paused.dt === 0, `the sim advanced ${paused.dt}s while paused`);
  assert(paused.dl === 0, `the party drained ${paused.dl} while paused`);


  // ---- the record's repair verb, on screen ---------------------------------
  // The strike is bound to the SURVEY key, so nothing in the control hints says
  // it exists, and a player cannot be expected to remember which of six entries
  // they wrote while their mind was gone. The contextual prompt is the entire
  // discoverability channel — and a logic test on strikeTargetAt cannot prove
  // it reaches the DOM. Brain: opticon#E — the two defects a green suite missed
  // were both about what the player was TOLD, not what the code did.
  {
    const promptRead = await page.evaluate(() => {
      const M = window.__mirage;
      const s = M.sim;
      // Somewhere well clear of every real marker, so nothing else claims the
      // prompt's single slot.
      const spot = { x: s.world.camp.x + 40, z: s.world.camp.z + 40 };
      s.logEntries.push({ name: "Ghost Pillar", real: false, t: s.time, corroborated: false, ...spot });
      s.player.x = spot.x;
      s.player.z = spot.z;
      s.player.hallucinating = false;
      M.advance(0.1);
      const lucid = document.getElementById("actionPromptText")?.textContent || "";
      const shown = document.getElementById("actionPrompt")?.classList.contains("show");
      // ...and it must vanish for a mind that cannot be trusted to audit
      // itself. Driven through the sim (lucidity to zero) rather than by
      // setting the flag by hand: `hallucinating` is a state the rules OWN,
      // and poking it directly leaves the kind unset, so the first version of
      // this check was asserting against a mind the game did not consider
      // gone.
      s.player.lucidity = 0;
      M.advance(0.1);
      const reallyGone = !!s.player.hallucinating;
      const gone = document.getElementById("actionPromptText")?.textContent || "";
      s.logEntries.pop();
      return { lucid, shown, gone, reallyGone };
    });
    assert(promptRead.shown, "no action prompt was shown while standing at a false claim");
    assert(
      /strike/i.test(promptRead.lucid) && /Ghost Pillar/.test(promptRead.lucid),
      `the strike prompt did not name the entry: "${promptRead.lucid}"`,
    );
    assert(promptRead.reallyGone, "the lead never actually went under — the second case proves nothing");
    // The prompt must read IDENTICALLY to a mind that is gone. An offer that
    // disappears when you are hallucinating is a lucidity meter: press it,
    // notice nothing happened, and you have learned the one thing the game
    // exists to keep from you. The rules refuse the strike; the screen does not
    // let on. (First version of this check asserted the opposite and would have
    // shipped that leak.)
    assert(
      promptRead.gone === promptRead.lucid,
      `the prompt changed when the lead went under — "${promptRead.lucid}" became "${promptRead.gone}"`,
    );
    notes.push(`strike prompt: "${promptRead.lucid}"`);
  }

  const shotName = `shot-${SCENARIO}.png`;
  const shot = path.join(ROOT, "tests", shotName);
  const shotOk = await shoot(page, shotName);

  // Console errors are checked LAST so a functional failure is reported first.
  assert(errors.length === 0, `console errors: ${errors.slice(0, 5).join(" | ")}`);

  await browser.close();
  server.close();

  for (const n of notes) console.log("  · " + n);
  if (shotOk) console.log(`SCREENSHOT: ${shot}`);
  if (failures.length) {
    console.log("\nSMOKE FAILED:");
    for (const f of failures) console.log("  ✗ " + f);
    process.exit(1);
  }
  console.log("mirage smoke: OK");
})().catch((e) => {
  console.error("SMOKE CRASHED:", e);
  process.exit(1);
});
