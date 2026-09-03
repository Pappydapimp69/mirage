// tutorial-play.mjs — does the walk in play from start to finish, in a browser?
//
// tests/tutorial.mjs proves the objective table is well-formed and the observer
// is pure. Neither is evidence that the tutorial COMPLETES. The characteristic
// bug here is silent starvation somewhere between a key press and the step, and
// every layer of that pipeline only exists in the browser.
//
// This drives all seven objectives through the real verbs, in ONE session, on
// the real camp map — no remounting, no synthetic events — and asserts progress
// actually moves. It is the test that says the tutorial is playable.
//
// Run: node tests/tutorial-play.mjs

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { createServer } from "http";
import { readFile } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png" };
const server = createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  try {
    const body = await readFile(path.join(ROOT, url === "/" ? "index.html" : url));
    res.writeHead(200, { "Content-Type": TYPES[path.extname(url)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("no"); }
});
await new Promise((r) => server.listen(0, r));
const PORT = server.address().port;

const failures = [];
const notes = [];
const assert = (c, m) => { if (!c) failures.push(m); };

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(String(e)));
await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__mirage, null, { timeout: 20000 });

// --- the entry point --------------------------------------------------------
{
  const btn = await page.evaluate(() => {
    const b = document.getElementById("learnBtn");
    return b ? { text: b.textContent.trim(), visible: b.offsetParent !== null, row: b.dataset.row } : null;
  });
  assert(btn, "no Learn the walk button on the title screen");
  assert(btn && btn.visible, "the tutorial entry point is not visible");
  assert(btn && btn.row !== undefined, "the tutorial button is outside the gamepad menu grid — unreachable on a pad");
}

// --- does the camp LOOK like a camp? ----------------------------------------
// Every other check in this file passes on a camp rendered as a near-black
// rocky clearing, which is exactly what shipped: blocked cells drew as rock
// spires because the renderer had never been told the camp exists, and the
// per-frame fog drift reset the daylight every single frame. A player pressed
// "Learn the walk" and reported being dropped in the woods with no tutorial.
//
// So this samples the actual framebuffer. It cannot judge whether the place
// reads as a camp — no test can — but it can catch "the screen is black" and
// "nothing but rock", which is what actually went wrong.
{
  // FIRST, before the playthrough — sampling after it finishes measures the
  // title screen it returns to, which is dark and scored 21/255 with no green.
  await page.evaluate(() => { window.__mirage.startStage(0); });
  await page.waitForTimeout(1500);

  // Screenshot, then read the PIXELS BACK THROUGH AN <img>. Drawing the WebGL
  // canvas straight into a 2D context returns solid black: the drawing buffer
  // is not preserved between frames, so a readback outside the render call
  // samples an empty buffer. The first version of this check measured 0/255 on
  // a camp that was plainly lit on screen — the test was wrong, not the game.
  const png = (await page.screenshot({ type: "png" })).toString("base64");
  const lum = await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = 160; c.height = 90;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, green = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) {
      sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      if (d[i + 1] > d[i] + 4 && d[i + 1] > d[i + 2] + 4) green++;
      n++;
    }
    return { mean: sum / n, greenFraction: green / n };
  }, png);
  notes.push(`camp brightness ${lum.mean.toFixed(0)}/255, green ${(lum.greenFraction * 100).toFixed(0)}%`);
  assert(lum.mean > 40, `the camp renders almost black (mean luminance ${lum.mean.toFixed(0)}/255) — it is unlit or the daylight was overwritten`);
  assert(lum.greenFraction > 0.15, `only ${(lum.greenFraction * 100).toFixed(0)}% of the camp is green — trees and grass are not drawing, so it is rendering as a rock field`);
}

// --- the whole walk in, one session, start to finish ------------------------
{
  const r = await page.evaluate(async () => {
    const M = window.__mirage;
    const out = { steps: [] };
    const done = () => M.tutorialDone();
    const note = (k, v) => out.steps.push([k, v]);

    // ---- 1: walk to the trainer -------------------------------------------
    M.startStage(0);
    const sim = M.sim;
    out.mapIsCamp = sim.pylons.length === 2 && sim.pylons.every((p) => p.mossed);
    out.noDrain = sim.noDrain === true;
    out.spawnedAwayFromTrainer = Math.hypot(sim.player.x - sim.trainer.x, sim.player.z - sim.trainer.z) > 30;

    // Wander into a mossed pylon FIRST, before being told anything, and check
    // it answers instead of doing nothing.
    const p0 = sim.pylons[0];
    sim.player.x = p0.x; sim.player.z = p0.z;
    M.advance(0.1);
    out.mossPrompt = document.getElementById("actionPromptText")?.textContent || "";
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.1);
    out.mossHeldEarly = !!p0.mossed;

    // Now walk to the trainer, the way a player would.
    sim.player.x = sim.trainer.x + 1; sim.player.z = sim.trainer.z;
    M.advance(0.2);
    note("walk-in", done().includes("walk-in"));

    // The objective advances on a timer; the debug hook skips the wait.
    const go = (i) => { M.enterObjective(i); M.advance(0.1); };

    // ---- 2: take what he gives you ----------------------------------------
    go(1);
    const a = sim.items.find((i) => i.id === "tut-item-a");
    out.itemSpawned = !!a;
    if (a) { sim.player.x = a.x; sim.player.z = a.z; M.advance(0.1); }
    out.pickPrompt = document.getElementById("actionPromptText")?.textContent || "";
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.1);
    note("ground", done().includes("ground"));

    // ---- 3: craft ----------------------------------------------------------
    go(2);
    const b = sim.items.find((i) => i.id === "tut-item-b");
    out.secondSpawned = !!b;
    if (b) { sim.player.x = b.x; sim.player.z = b.z; M.advance(0.1); M.act(M.ACTIONS.SURVEY); M.advance(0.1); }
    out.held = sim.inventory.length;
    M.act(M.ACTIONS.CRAFT);
    M.advance(0.2);
    note("craft", done().includes("craft"));

    // ---- 4: hand it to IREN ------------------------------------------------
    go(3);
    const iren = sim.companions[1];
    out.irenId = iren.id;
    iren.x = sim.player.x + 1; iren.z = sim.player.z; iren.lucidity = 80;
    M.advance(0.1);
    M.act(M.ACTIONS.NEXT_TARGET);
    M.act(M.ACTIONS.OFFER_ITEM);
    M.advance(0.2);
    note("hands", done().includes("hands"));

    // ---- 5: the pylon, in two beats ---------------------------------------
    go(4);
    out.callLockedBefore = sim.callUnlocked === false;
    const p = sim.pylons.find((x) => x.mossed) || sim.pylons[0];
    sim.player.x = p.x; sim.player.z = p.z;
    M.advance(0.1);
    M.act(M.ACTIONS.SURVEY);              // beat one: the moss comes off
    M.advance(0.2);
    out.mossCleared = !p.mossed;
    out.callUnlockedAfterMoss = sim.callUnlocked === true;
    // One pair of hands is a claim...
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.1);
    out.aloneDoesNotFire = !done().includes("pylon");
    // ...so call someone, and they have to actually arrive.
    const mate = sim.companions[0];
    M.act(M.ACTIONS.CALL);
    M.advance(0.2);
    out.answering = !!mate.summonBy || sim.companions.some((c) => c.summonBy);
    const comer = sim.companions.find((c) => c.summonBy) || mate;
    comer.x = p.x; comer.z = p.z; comer.lucidity = 90;
    M.advance(1.0);
    note("pylon", done().includes("pylon"));
    out.pylonSpent = !!p.spent;

    // ---- 6: ask them both --------------------------------------------------
    go(5);
    out.askIds = [sim.companions[2].id, sim.companions[3].id];
    M.act(M.ACTIONS.CHECK_IN, 2);
    M.advance(0.2);
    out.askAfterOne = done().includes("ask");
    M.act(M.ACTIONS.CHECK_IN, 3);
    M.advance(0.2);
    note("ask", done().includes("ask"));

    // ---- 7: the first lie --------------------------------------------------
    go(6);
    out.leadUnder = !!sim.player.hallucinating;
    M.advance(0.1);
    const ph = M.percept.phantomMonoliths[0];
    out.phantoms = M.percept.phantomMonoliths.length;
    if (ph) { sim.player.x = ph.x; sim.player.z = ph.z; M.advance(0.1); }
    M.act(M.ACTIONS.SURVEY);
    M.advance(0.2);
    note("first-lie", done().includes("first-lie"));
    out.badLogs = sim.logEntries.filter((e) => !e.real && !e.struck).length;

    out.finished = done().length;
    out.sameSessionThroughout = M.sim === sim;   // never remounted
    return out;
  });

  // The map
  assert(r.mapIsCamp, "the tutorial did not start on the camp map");
  assert(r.noDrain, "the camp is draining the party — a lesson has become a race");
  assert(r.spawnedAwayFromTrainer, "the player spawned on top of the trainer — objective 1 is not a walk");

  // Effect-gating: a mossed pylon answers, and stays shut
  assert(/moss/i.test(r.mossPrompt), `a mossed pylon's prompt was "${r.mossPrompt}" — it should say what it is`);
  assert(r.mossHeldEarly, "the moss came off before the objective that opens it");

  // Every objective, in order
  for (const [id, ok] of r.steps) assert(ok, `objective "${id}" never completed`);

  // Existence-gating
  assert(r.itemSpawned, "objective 2 did not spawn its item");
  assert(r.secondSpawned, "objective 3 did not spawn the second ingredient");
  assert(/Pick up/i.test(r.pickPrompt), `objective 2's prompt was "${r.pickPrompt}" — the taught verb is outranked at its own site`);
  assert(r.held === 2, `the player held ${r.held} ingredients at the craft, not 2`);

  // The pylon's two beats
  assert(r.callLockedBefore, "CALL was available before the objective that teaches it");
  assert(r.mossCleared, "the moss never came off");
  assert(r.callUnlockedAfterMoss, "clearing the moss did not hand over the CALL verb");
  assert(r.aloneDoesNotFire, "one pair of hands fired the pylon — the two-hands rule is not being taught");
  assert(r.answering, "nobody answered the call");
  assert(r.pylonSpent, "the pylon never fired");

  // The rest
  assert(r.irenId === "c2", `objective 4 is pinned to c2 but roster slot 1 is ${r.irenId}`);
  assert(String(r.askIds) === "c3,c4", `objective 6 is pinned to c3/c4 but slots 2-3 are ${r.askIds}`);
  assert(!r.askAfterOne, "one check-in completed objective 6 — it needs both");
  assert(r.leadUnder, "objective 7 did not put the lead under");
  assert(r.phantoms > 0, "objective 7 seeded no phantom to find");
  assert(r.badLogs >= 1, "objective 7 completed without a false entry reaching the record");

  // The whole point
  assert(r.finished === 7, `only ${r.finished} of 7 objectives completed`);
  assert(r.sameSessionThroughout, "the run was remounted mid-tutorial — this is meant to be one continuous session");
  notes.push(`all 7 objectives complete in one session · ${r.badLogs} false entr${r.badLogs === 1 ? "y" : "ies"} left in the record`);
}

// --- the meter never reaches the screen -------------------------------------
{
  const leaked = await page.evaluate(() => {
    const words = ["lucidity", "sanity", "hallucinat", "steady", "unsettled", "fraying", "brittle"];
    const hud = document.getElementById("hudLayer")?.innerText?.toLowerCase() || "";
    return words.filter((w) => hud.includes(w));
  });
  assert(leaked.length === 0, `the HUD showed the hidden meter during the tutorial: ${leaked.join(", ")}`);
}

// --- progress persists --------------------------------------------------------
{
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("mirage:settings") || "{}"));
  assert(Array.isArray(stored.tutorial?.done), "tutorial progress is not in the settings payload");
  assert(stored.tutorial.done.length >= 5, `only ${stored.tutorial?.done?.length} objectives recorded as done`);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  assert(keys.length <= 2, `a third localStorage key appeared: ${keys.join(", ")} (dog#E64)`);
}

assert(consoleErrors.length === 0, `page errors: ${consoleErrors.slice(0, 3).join(" | ")}`);

await browser.close();
server.close();
for (const n of notes) console.log("  · " + n);
if (failures.length) {
  console.log("\nTUTORIAL PLAY FAILED:");
  for (const f of failures) console.log("  ✗ " + f);
  process.exit(1);
}
console.log("tutorial play: OK — the walk in plays start to finish");
