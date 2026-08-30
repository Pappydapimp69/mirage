// hud.js — the DOM overlay. Reads PERCEPTION, never the sim's hidden numbers.
//
// There is no lucidity bar, and that is a design rule rather than an omission:
// the roster shows the lead's own qualitative read of each companion ("lagging",
// "breaking off", "shaking"), which degrades to "you can't tell" when the lead is
// the one hallucinating. The only place a real number is ever printed is the
// debrief, after the run is over.

import { perceivedYaw, rosterRead, distortion, filterReport, perceivedWorldItems, perceivedInventory, chorusEcho, believedKinds } from "./percept.js?v=mirage-0.13.2";
import { LOG_RADIUS, PYLON_RADIUS, TIME_LIMIT, discoveredCount, ITEM_PICKUP_RADIUS, ITEM_INFO, gatherTarget, GATHER_HOLD_TIME, previewCraft, claimedEntryAt, pylonAt,
  mossedAt,
} from "./state.js?v=mirage-0.13.2";

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

/**
 * Paint a hint string into an element, turning `[TOKEN]` markers into coloured
 * face-button badges (A/B/X/Y) or grey chips (LB/RB/Start/…). Device-adaptive UI
 * means never making the player translate: a gamepad hint should show the button
 * shapes actually on the controller, not a word standing in for one. Strings for
 * keyboard/touch schemes simply contain no brackets, so this is a no-op for them.
 */
export function paintHint(el, text) {
  if (!el) return;
  el.innerHTML = text.replace(
    /\[([A-Za-z0-9]+)\]/g,
    (_, tok) => `<span class="pad-badge b-${tok.toLowerCase()}">${tok}</span>`,
  );
}

/**
 * `opts.onChorus` is called whenever a CHORUS reply actually lands, so main.js
 * can sound it. The HUD has no audio handle of its own and shouldn't grow one —
 * percept.js decides IF a line happens, this file decides where it lands, and
 * the caller decides what it sounds like.
 */
export function createHud(sim, percept, opts = {}) {
  const el = {
    roster: document.getElementById("roster"),
    survey: document.getElementById("surveyCount"),
    found: document.getElementById("foundCount"),
    doses: document.getElementById("doseCount"),
    compass: document.getElementById("compass"),
    clock: document.getElementById("clock"),
    subtitles: document.getElementById("subtitles"),
    prompt: document.getElementById("actionPrompt"),
    vignette: document.getElementById("vignette"),
    hints: document.getElementById("hints"),
    selection: document.getElementById("selectionLabel"),
    items: document.getElementById("itemBar"),
    items2: document.getElementById("itemBar2"),
    level: document.getElementById("levelLabel"),
    flash: document.getElementById("flash"),
    wood: document.getElementById("woodCount"),
    stone: document.getElementById("stoneCount"),
    woodPill: document.getElementById("woodPill"),
    stonePill: document.getElementById("stonePill"),
    promptFill: document.getElementById("actionPromptFill"),
    promptText: document.getElementById("actionPromptText"),
    prompt2: document.getElementById("actionPrompt2"),
    promptFill2: document.getElementById("actionPromptFill2"),
    promptText2: document.getElementById("actionPromptText2"),
    craftHint: document.getElementById("craftHint"),
  };

  // Build the roster once; only the read-out text changes per frame.
  const rows = new Map();
  el.roster.innerHTML = "";
  for (const c of sim.companions) {
    const row = document.createElement("div");
    row.className = "roster-row";
    row.innerHTML =
      `<span class="r-key">${c.index}</span>` +
      `<span class="r-name">${c.name}</span>` +
      `<span class="r-role">${c.role}</span>` +
      `<span class="r-read"></span>`;
    el.roster.appendChild(row);
    rows.set(c.id, { row, read: row.querySelector(".r-read") });
  }

  const lines = [];
  function say(text, cls = "") {
    lines.push({ text, cls, t: sim.time });
    if (lines.length > 4) lines.shift();
    el.subtitles.innerHTML = lines
      .map((l, i) => `<div class="sub ${l.cls}" style="opacity:${0.35 + (i / lines.length) * 0.65}">${l.text}</div>`)
      .join("");
  }

  /** A brief full-screen flash — the one moment a lucidity restore gets a
   * visceral cue instead of only a subtitle and a slowly-thinning vignette.
   * A fresh reflow before adding "show" restarts the CSS transition even on
   * back-to-back uses, the same trick a shake/damage-flash effect needs. */
  function flash() {
    if (!el.flash) return;
    el.flash.classList.remove("show");
    void el.flash.offsetWidth;
    el.flash.classList.add("show");
    // "show" holds the instant jump to visible; removing it after a brief hold
    // hands back to the base .flash rule's own (eased) transition to fade out.
    setTimeout(() => el.flash.classList.remove("show"), 90);
  }

  /** Briefly highlight a resource pill when its count just went up — the
   * landing beat for a chop/mine haul, whether or not collectFly's dot made
   * the trip (e.g. the node was behind the camera when the hold completed).
   * Same forced-reflow retrigger trick as flash(), so back-to-back gathers
   * each get their own pulse instead of the first one's timeout cutting the
   * second one's class short. */
  function pillGain(resource) {
    const pill = resource === "wood" ? el.woodPill : el.stonePill;
    if (!pill) return;
    pill.classList.remove("gain");
    void pill.offsetWidth;
    pill.classList.add("gain");
    setTimeout(() => pill.classList.remove("gain"), 420);
  }

  /**
   * Fly a small dot from `from` (a screen point render.js projected from the
   * gathered tree/deposit's own world position) to the resource's pill, then
   * land with a pillGain() pulse — a physical sense of the haul arriving,
   * not just a counter that silently ticked up. Pure DOM/CSS: a transform
   * transition on a throwaway fixed-position element. Cleanup is a timer, not
   * transitionend, so a backgrounded tab (which can stall CSS transitions)
   * can't leak the element or skip the landing pulse.
   */
  function collectFly(resource, from) {
    if (!from || !from.visible) {
      pillGain(resource);
      return;
    }
    const pill = resource === "wood" ? el.woodPill : el.stonePill;
    if (!pill) return;
    const to = pill.getBoundingClientRect();
    const DURATION = 550;
    const dot = document.createElement("div");
    dot.className = `gather-fly ${resource}`;
    dot.style.transform = `translate(${from.x}px, ${from.y}px)`;
    document.body.appendChild(dot);
    // Force the start position to commit before moving the target, or the
    // browser may coalesce both writes into one frame and skip the transition.
    void dot.offsetWidth;
    dot.style.transform = `translate(${to.left + to.width / 2}px, ${to.top + to.height / 2}px)`;
    dot.style.opacity = "0";
    setTimeout(() => {
      dot.remove();
      pillGain(resource);
    }, DURATION);
  }

  /**
   * Drain the sim's event queue into subtitles. Called once per frame.
   * `actionEvents` is a one-shot array main.js captured from THIS frame's
   * handleAction() calls before tick() reset sim.events for its own internal
   * emits (discover/recover/hallucinate/chatter/...) — passed in fresh every
   * call, never stored, so it can't repeat on a later frame the way writing
   * it back into sim.events itself did (see main.js's step() comment).
   */
  function pumpEvents(actionEvents = []) {
    for (const ev of actionEvents.concat(sim.events)) {
      if (ev.kind === "chatter" || ev.kind === "report") say(ev.text, ev.gone ? "gone" : "");
      else if (ev.kind === "break") say(ev.text, "warn");
      else if (ev.kind === "hallucinate") say(ev.text, "gone");
      else if (ev.kind === "recover") say(ev.text, "good");
      else if (ev.kind === "log") say(ev.text, "good");
      else if (ev.kind === "logFalse") say(ev.text, "gone");
      else if (ev.kind === "logStrike") {
        // Styled "good" for BOTH outcomes. A believed-only strike that arrived
        // in a different colour would be the tell all over again, one layer
        // down — the point is that a correction you cannot trust looks exactly
        // like one you can.
        say(ev.text, "good");
        if (ev.believedOnly && ev.entryId) percept.believedStruck.add(ev.entryId);
      }
      else if (ev.kind === "dose") say(ev.text, "good");
      else if (ev.kind === "discoverItem") say(ev.text, "");
      else if (ev.kind === "discoverResource") say(ev.text, "");
      else if (ev.kind === "gather") say(ev.text, "good");
      // Same text AND same styling: a phantom pickup used to be flagged "gone"
      // (red) while a real one read "good", which told the player which slots
      // were fake without them ever reaching for one.
      else if (ev.kind === "pickup") say(ev.text, "good");
      else if (ev.kind === "pickupFalse") say(ev.text, "good");
      else if (ev.kind === "companionPickup") say(ev.text, "");
      // A phantom handoff the lead ACCEPTS reads as good news, because to them
      // it is — the styling must not be the thing that gives it away.
      else if (ev.kind === "handoff") say(ev.text, "good");
      // The two reveals, though, are the game telling the truth for once.
      else if (ev.kind === "handoffEmpty") say(ev.text, "gone");
      else if (ev.kind === "offerEmpty") say(ev.text, "gone");
      else if (ev.kind === "offerUsed") say(ev.text, "good");
      else if (ev.kind === "offerLost") say(ev.text, "warn");
      else if (ev.kind === "offerRefused") say(ev.text, "warn");
      else if (ev.kind === "itemUsed") {
        say(ev.text, "good");
        if (ITEM_INFO[ev.itemKind]?.restore) flash();
      } else if (ev.kind === "itemPhantom") say(ev.text, "gone");
      else if (ev.kind === "craft") say(ev.text, "good");
      else if (ev.kind === "drop") say(ev.text, "");
      else if (ev.kind === "dropPhantom") say(ev.text, "gone");
      else if (ev.kind === "advance") say(ev.text, "good");
      else if (ev.kind === "end") say(ev.text, "warn");

      // CHORUS answers the lead's own verbs. percept.js owns every decision
      // here — whether this event earns a reply at all, who speaks, how loud
      // it has got — and gates itself so at most one line lands per several
      // seconds across all sources; this is only the surface it lands on.
      const echo = chorusEcho(percept, sim, ev);
      if (echo) {
        say(echo.text, "gone");
        opts.onChorus?.();
      }
    }
  }

  /** A check-in the player asked for, passed through the lead's own filter. */
  /** `viewer` is the percept of whoever ASKED — the listener is the second
   * filter (see percept.filterReport), so player two's check-ins must pass
   * through player two's own state, not the lead's. Defaults to the lead. */
  function showReport(report, viewer = percept) {
    const filtered = filterReport(viewer, sim, report);
    if (!filtered) return;
    say(`${filtered.name}: ${filtered.text}`, filtered.claim === "gone" ? "gone" : "");
  }

  function nearestUnloggedName(viewer = percept, actor = sim.player) {
    let best = null, bestD = Infinity;
    for (const m of sim.monoliths) {
      if (m.logged) continue;
      const d = Math.hypot(m.x - actor.x, m.z - actor.z);
      if (d < bestD) { bestD = d; best = m; }
    }
    // Phantoms count for the prompt — the whole point is that this mind cannot
    // tell the difference from where they are standing. Each player's prompt
    // reads THEIR OWN phantoms; one player's hallucination never leaks into
    // the other half of the screen.
    for (const ph of viewer.active ? viewer.phantomMonoliths : []) {
      const d = Math.hypot(ph.x - actor.x, ph.z - actor.z);
      if (d < bestD) { bestD = d; best = ph; }
    }
    return bestD <= LOG_RADIUS ? best : null;
  }

  /** Nearest pickup in reach, shown through PERCEPTION — the prompt names the
   * item the lead believes they see, never the true kind underneath it. */
  function nearestPickupItem(viewer = percept, actor = sim.player) {
    let best = null, bestD = Infinity;
    for (const it of perceivedWorldItems(viewer, sim)) {
      const d = Math.hypot(it.x - actor.x, it.z - actor.z);
      if (d < bestD) { bestD = d; best = it; }
    }
    return bestD <= ITEM_PICKUP_RADIUS ? best : null;
  }

  /**
   * Paint one player's contextual action prompt. ONE resolver drives the whole
   * surface (Brain: dog#E20 — a single "what can happen right now" answer keeps
   * every prompt honest as verbs are added), and the same priority order
   * handleAction uses: pickup, then gather, then survey.
   */
  /** What this viewer believes is a live pylon underfoot. Truth not consulted. */
  function believedPylonAt(viewer, s2, actor) {
    if (!viewer?.active) return null;
    for (const ph of viewer.phantomPylons || []) {
      if (Math.hypot(ph.x - actor.x, ph.z - actor.z) <= PYLON_RADIUS) return ph;
    }
    for (const p of s2.pylons) {
      if (!viewer.deadPylonsLookLive?.has(p.id)) continue;
      if (Math.hypot(p.x - actor.x, p.z - actor.z) <= PYLON_RADIUS) return p;
    }
    return null;
  }

  function paintPrompt(els, viewer, actor, hold) {
    if (!els.prompt) return;
    const pickup = nearestPickupItem(viewer, actor);
    const gatherable = gatherTarget(sim, actor);
    const near = nearestUnloggedName(viewer, actor);
    // claimedEntryAt, NOT strikeTargetAt: the prompt must read the same to a
    // mind that is gone as to one that is not, or its absence becomes a
    // lucidity readout. The rules refuse the verb; the screen never admits it.
    const claim = claimedEntryAt(sim, actor);
    // An entry this mind believes it already crossed out stops being offered,
    // exactly as a genuinely struck one does.
    const strikeable = claim && !viewer.believedStruck?.has(claim.id) ? claim : null;
    // Top of the chain: a pylon you are standing in is the one thing here that
    // can be permanently lost by walking away from it, and it only works once.
    // Believed, not real: the prompt must appear over a phantom pylon too, or
    // its absence tells the lead they are hallucinating.
    // ABOVE the pylon rung, because a mossed pylon is where a pylon would be
    // and the two can never both apply — pylonAt hides mossed ones. Without a
    // rung of its own the prompt went blank at a thing the player is standing
    // right on top of, which reads as the game not seeing it.
    const mossy = mossedAt(sim, actor);
    if (mossy && sim.status === "playing") {
      els.text.textContent = sim.canClearMoss
        ? "Scrape the moss off"
        : "Something under the moss — it will not shift";
      els.prompt.classList.add("show");
      els.fill.style.width = "0%";
      return;
    }
    const pylon = pylonAt(sim, actor) || believedPylonAt(viewer, sim, actor);
    if (pylon && sim.status === "playing") {
      const together = sim.party.filter(
        (c) => Math.hypot(c.x - pylon.x, c.z - pylon.z) <= PYLON_RADIUS,
      ).length;
      els.text.textContent = pylon.primedBy?.length
        ? `Pylon primed — needs a second pair of hands`
        : `Set hands on the pylon — ${together} of you in range, one use only`;
      els.prompt.classList.add("show");
      els.fill.style.width = "0%";
    } else if (pickup && sim.status === "playing") {
      els.text.textContent = `Pick up ${ITEM_INFO[pickup.shownKind].label}`;
      els.prompt.classList.add("show");
      els.fill.style.width = "0%";
    } else if (gatherable && sim.status === "playing") {
      els.text.textContent = gatherable.gatherKind === "tree" ? "Hold to chop the tree" : "Hold to mine the stone";
      els.prompt.classList.add("show");
      const pct = hold && hold.targetId === gatherable.id ? (hold.progress / GATHER_HOLD_TIME) * 100 : 0;
      els.fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    } else if (near && sim.status === "playing") {
      els.text.textContent = `Survey ${near.name}`;
      els.prompt.classList.add("show");
      els.fill.style.width = "0%";
    } else if (strikeable && sim.status === "playing") {
      // The only channel that makes the repair reachable. A player cannot be
      // expected to remember which of six entries they wrote while their mind
      // was gone, or where — so the record does not accuse anyone, the GROUND
      // does: stand where an entry claims a marker, find nothing, and the game
      // offers to cross it out. Nothing here reveals which entries are false
      // from a distance; you still have to go and look. And a lead who is under
      // sees this same offer, presses it, and nothing happens — which is what
      // being unreliable is supposed to feel like from the inside.
      els.text.textContent = `Nothing here — strike ${strikeable.name} from the record`;
      els.prompt.classList.add("show");
      els.fill.style.width = "0%";
    } else {
      els.prompt.classList.remove("show");
      els.fill.style.width = "0%";
    }
  }

  /**
   * Paint one player's read of the shared pack into `container`. The pack
   * itself is ONE array (see state.js's own comment on that), but each viewer
   * is handed a DIFFERENT `viewerPercept` — so the same physical slot can
   * legitimately show two different labels at once, one per screen half.
   * That is the whole mechanism behind "show it to someone who isn't gone":
   * nothing is transferred, nobody performs a hand-off, a lucid partner's own
   * panel was reading the truth about that slot the entire time.
   */
  function renderSlots(container, selectedItem, viewerPercept) {
    if (!container) return;
    const slots = perceivedInventory(viewerPercept, sim);
    container.innerHTML = slots.length
      ? slots.map((s, i) => `<div class="item-slot${i === selectedItem ? " sel" : ""}">${s.label}</div>`).join("")
      : `<div class="item-slot empty">—</div>`;
  }

  function update(view, selected, selectedItem = 0, actionEvents = [], coop = null) {
    pumpEvents(actionEvents);

    for (const c of sim.companions) {
      const { row, read } = rows.get(c.id);
      const r = rosterRead(percept, sim, c);
      read.textContent = r.note;
      row.className = `roster-row tag-${r.tag.replace(/\s+/g, "-")}` +
        (r.uncertain ? " uncertain" : "") +
        (sim.companions[selected] === c ? " selected" : "");
    }
    if (el.selection) el.selection.textContent = sim.companions[selected]?.name || "";
    if (el.level) el.level.textContent = `${sim.level} / ${sim.campaignLength}`;

    const logged = sim.monoliths.filter((m) => m.logged).length;
    // The counter shows the LOG's length, not the truth — a false entry looks
    // exactly like a real one until the debrief.
    el.survey.textContent = `${sim.logEntries.length} / ${sim.monoliths.length}`;
    el.survey.classList.toggle("complete", logged >= sim.monoliths.length);
    if (el.found) el.found.textContent = `${discoveredCount(sim)} / ${sim.monoliths.length}`;
    el.doses.textContent = String(sim.doses);
    if (el.wood) el.wood.textContent = String(sim.wood);
    if (el.stone) el.stone.textContent = String(sim.stone);

    const yaw = perceivedYaw(percept, sim);
    const oct = ((Math.round((-yaw / (Math.PI * 2)) * 8) % 8) + 8) % 8;
    el.compass.textContent = COMPASS[oct];
    // Deliberately NOT flagged when it settles. WRONG_WAY's needle now
    // releases its accumulated error in one jump while the lead is standing
    // still, and that jump always crosses a whole compass point (percept.js
    // COMPASS_SNAP_MIN), so the letter genuinely changes under a player who
    // is not moving — but only for a player who happens to be looking. A
    // highlight here would turn "wrong in a way you can almost catch" into a
    // notification, which is the opposite of the effect.

    const left = Math.max(0, TIME_LIMIT - sim.time);
    el.clock.textContent = `${String(Math.floor(left / 60)).padStart(2, "0")}:${String(Math.floor(left % 60)).padStart(2, "0")}`;
    el.clock.classList.toggle("low", left < 120);

    const dis = distortion(percept, sim);
    el.vignette.style.opacity = String(Math.min(0.92, dis * 0.9));
    // Gated on `dis`, not raw `percept.active`: the .lost class starts a CSS
    // animation (breathe) that overrides the inline opacity above for as long
    // as it's applied, so during the grace window (dis === 0 by construction,
    // even if percept.active is already true from carried-over state) this
    // must stay off — otherwise the animation alone makes the screen pulse
    // regardless of what distortion() computed.
    el.vignette.classList.toggle("lost", dis > 0);

    renderSlots(el.items, selectedItem, percept);

    paintPrompt({ prompt: el.prompt, text: el.promptText, fill: el.promptFill },
      percept, sim.player, sim.gatherHold);
    // Player two's prompt lives in their half of the screen and reads THEIR
    // percept, THEIR position and THEIR OWN hold — nothing about it touches
    // the lead's. Hidden entirely outside co-op (CSS keys off body[data-coop]).
    if (coop) {
      paintPrompt({ prompt: el.prompt2, text: el.promptText2, fill: el.promptFill2 },
        coop.percept, coop.eye, coop.eye.gatherHold);
      // Same shared inventory as el.items, painted through player two's OWN
      // percept — see renderSlots' own comment.
      renderSlots(el.items2, coop.selectedItem, coop.percept);
    }

    // Craft accessibility: name what's craftable the moment it's possible,
    // rather than making the player guess and press blind. Reads the same
    // belief view the craft itself will use, so a lead being lied to about
    // what they're carrying gets INVITED into the false craft by name — the
    // indicator has to be as wrong as the item bar above it, or it would
    // quietly become the one honest instrument on the screen.
    if (el.craftHint) {
      // Same selected slot craftItem will use, so the hint can never name a
      // different result than the button produces — and the same belief view,
      // so a mind being lied to about what it carries gets INVITED into the
      // false craft by name. The indicator has to be as wrong as the item bar
      // above it, or it quietly becomes the one honest instrument on screen.
      const preview = previewCraft(sim, selectedItem, believedKinds(percept, sim));
      if (preview.ok && sim.status === "playing") {
        el.craftHint.textContent = `Craft ready: ${ITEM_INFO[preview.kind].label}`;
        el.craftHint.classList.add("show");
      } else {
        el.craftHint.classList.remove("show");
      }
    }
  }

  function setHints(scheme) {
    const text = {
      keyboard: "WASD move · Shift run · E survey/pick up, hold to gather · Z cycle item · X use item · V drop · Q/R select · B give · T call over · C craft · 1–5 check in · Shift+1–5 dose · Esc pause",
      gamepad: "Stick move · [A] survey/pick up, hold to gather · [RT] cycle item · [B] use item · D-pad Up craft · D-pad Down drop · D-pad Right give · D-pad Left call over · [X] check in · [Y] dose · [LB]/[RB] select · [Start] pause",
      touch: "Left half steers · right half looks · buttons bottom-right",
    }[scheme] || "";
    paintHint(el.hints, text);
  }

  return { update, say, showReport, setHints, collectFly, el };
}

/** The debrief screen — the one and only place hidden state is revealed. */
export function renderDebrief(container, report) {
  // Every ending needs its own words. `discredited` used to fall through this
  // chain to "DARK", so a run that got home and had its record thrown out was
  // told the light ran out — the game reporting the wrong cause of death for
  // its own newest failure. tests/logic.test.mjs now asserts one distinct
  // verdict per ending, so the next one added cannot inherit someone else's.
  const VERDICTS = {
    extracted: "SURVEY COMPLETE",
    advance: "SURVEY COMPLETE",
    dissolved: "THE PARTY DISSOLVED",
    discredited: "THE RECORD IS REJECTED",
    darkness: "DARK",
  };
  const verdict = VERDICTS[report.ending] || (report.status === "won" ? "SURVEY COMPLETE" : "DARK");
  // The one ending you can still do something about next time, so it says how.
  const discreditNote =
    report.ending === "discredited"
      ? `<p class="debrief-warn">You walked home with ${report.badLogs} entr${report.badLogs === 1 ? "y" : "ies"} naming ${report.badLogs === 1 ? "a marker" : "markers"} that ${report.badLogs === 1 ? "is" : "are"} not out there. Nobody can tell which half of the survey to trust, so none of it counts.<br>Stand where an entry claims a marker, while lucid, and survey again — finding nothing is what strikes it from the record.</p>`
      : "";
  const falseNote = report.falseLogs
    ? `<p class="debrief-warn">${report.falseLogs} entr${report.falseLogs === 1 ? "y was" : "ies were"} written at nothing.` +
      (report.strikes ? ` You struck ${report.strikes} back out.` : "") +
      `</p>`
    : "";
  // The count of things you built that were never there. Withheld for the
  // entire run — this is the first and only moment the game admits it.
  const craftNote = report.falseCrafts
    ? `<p class="debrief-warn">${report.falseCrafts} of the ${report.itemsCrafted} thing${report.itemsCrafted === 1 ? "" : "s"} you made ${report.falseCrafts === 1 ? "was" : "were"} never there.</p>`
    : "";
  container.innerHTML = `
    <div class="debrief-card">
      <h2>${verdict}</h2>
      <p class="debrief-sub">Basin ${report.level} of ${report.campaignLength} · ${report.logged} of ${report.total} markers really surveyed · ${Math.floor(report.time / 60)}m ${report.time % 60}s</p>
      ${discreditNote}
      ${falseNote}
      ${craftNote}
      <table class="debrief-table">
        <tr><th>Who</th><th>Lucidity</th><th>State</th><th>Scars</th><th>Lost to it</th></tr>
        ${report.party
          .map(
            (p) => `<tr class="${p.hallucinating ? "row-gone" : ""}">
          <td>${p.name}</td><td>${p.lucidity}</td>
          <td>${p.hallucinating ? "hallucinating" : p.band}</td>
          <td>${p.scars}</td><td>${p.goneSeconds}s</td></tr>`,
          )
          .join("")}
      </table>
      <p class="debrief-foot">Doses used ${report.doseUses} · recoveries ${report.recoveries} · items used ${report.itemsUsed} · crafted ${report.itemsCrafted} · phantom items ${report.phantomItemsUsed} · called out ${report.phantomsRevealed} · wood left ${report.wood} · stone left ${report.stone}</p>
      <button id="againBtn" class="big-btn" data-row="0" data-col="0">New basin</button>
    </div>`;
}
