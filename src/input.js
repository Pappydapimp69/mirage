// input.js — keyboard, mouse-look, touch, and gamepad, normalised into one
// small intent object the game loop reads. No game logic lives here.
//
// ONE persistent instance drives the whole app — title screen, pause, debrief,
// AND gameplay — dispatching by `mode` ('menu' | 'game'), the same shape Opticon
// uses (Brain: a flat single-axis focus list over visually distinct groups lets
// any direction leak into the wrong group; model real rows/columns/groups,
// scoped per screen — see menuNavX/menuNavY in main.js). A per-run instance
// would mean the title/pause/debrief screens have no gamepad support at all,
// which was the actual gap: gameplay already read a pad, but nothing let a
// controller-only player so much as press Start.
//
// Gamepad is POLLED every frame regardless of mode (Chrome hides `getGamepads()`
// data until the first button press on that pad — `gamepadconnected` alone is
// not enough — Brain: dog#E27/test#E3), and the active scheme is tracked live so
// the UI can reshape itself around whichever device is actually in the player's
// hands (Brain: device-adaptive-ui / show-the-active-scheme) — see
// `refreshSchemeUI` in main.js for the on-screen side of that.
//
// Function keys are deliberately NOT captured (F11 fullscreen, F12 devtools):
// swallowing them breaks the browser for no gain.

export const ACTIONS = Object.freeze({
  // SURVEY is the general "interact with what's in front of me" verb — its
  // handler in main.js checks for a nearby item pickup before falling back to
  // surveying a marker, so items needed no separate pickup button.
  SURVEY: "survey",
  CHECK_IN: "checkIn",
  DOSE: "dose",
  NEXT_TARGET: "nextTarget",
  PREV_TARGET: "prevTarget",
  CYCLE_ITEM: "cycleItem",
  USE_ITEM: "useItem",
  DROP_ITEM: "dropItem",
  CRAFT: "craft",
  // Put the selected item in the selected companion's hands. Doubles as the
  // only way to find out something is wrong with YOUR OWN reading of it — see
  // state.offerItem.
  OFFER_ITEM: "offerItem",
  CALL: "call",
  PAUSE: "pause",
});

// Stick deadzone, RADIAL and rescaled — not per-axis.
//
// The old form was `v => Math.abs(v) < 0.18 ? 0 : v` applied to each axis
// independently, which carves a SQUARE dead region out of a round stick. Two
// consequences: near an axis the perpendicular component gets clipped to
// exactly zero, so input snaps to the cardinal directions and then jumps the
// moment it crosses the threshold; and along the diagonals you have to push
// noticeably further before anything registers at all. Both read as "it won't
// go where I'm pointing" and as trouble moving diagonally.
//
// Radial instead: take the stick's true magnitude, ignore it below the
// threshold, and rescale what's left across the full 0..1 range. Direction is
// carried by the unit vector and is therefore preserved EXACTLY, and there is
// no discontinuity at the edge of the deadzone.
const DEADZONE = 0.18;
// ...but a radial deadzone preserves direction EXACTLY, which means it also
// preserves AXIS DRIFT exactly. A worn stick resting at x=0.09 while pushed to
// y=-0.95 clears the magnitude gate easily, and that 0.09 rides through as a
// permanent lean: pressing straight up walks forward and slightly right,
// forever, and no amount of pushing harder corrects it because the ratio is
// preserved on purpose.
//
// So: radial gate for magnitude, then an AXIS EPSILON that snaps a component
// which is tiny RELATIVE TO THE OTHER one to zero. This is not the square
// deadzone coming back — the threshold is proportional, so a genuine diagonal
// (x and y comparably sized) is untouched and only a near-cardinal push gets
// cleaned up. That is exactly the case the player is complaining about and
// exactly the case a square deadzone got wrong in the other direction.
const AXIS_EPSILON = 0.16; // a component below 16% of the dominant one is drift
function stickVector(ax, ay) {
  const mag = Math.hypot(ax, ay);
  if (mag < DEADZONE) return { x: 0, y: 0 };
  let x = ax, y = ay;
  const dom = Math.max(Math.abs(x), Math.abs(y));
  if (Math.abs(x) < dom * AXIS_EPSILON) x = 0;
  if (Math.abs(y) < dom * AXIS_EPSILON) y = 0;
  const m2 = Math.hypot(x, y) || 1;
  const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
  return { x: (x / m2) * scaled, y: (y / m2) * scaled };
}

export function createInput(canvas, opts = {}) {
  const state = {
    move: { x: 0, z: 0 }, // raw, in screen space; the loop rotates it by yaw
    run: false,
    look: { dx: 0, dy: 0 },
    yaw: 0,
    pitch: 0,
    pointerLocked: false,
    queue: [], // discrete actions, drained each frame
    touchInteract: false, // set by main.js's pointerdown/up on the touch survey button
  };

  const HELD = new Set();
  let mode = "menu"; // 'menu' (title/pause/debrief) | 'game' (in-run)
  let scheme = "keyboard"; // keyboard | touch | gamepad — drives the on-screen legend
  let menuHandlers = null; // { navX(dir), navY(dir), confirm(), cancel() }

  const onScheme = opts.onScheme || (() => {});
  function setScheme(s) {
    if (scheme === s) return;
    scheme = s;
    onScheme(s);
  }

  const push = (action, arg) => state.queue.push({ action, arg });

  function setMode(m) { mode = m; }
  function setMenuHandlers(navX, navY, confirm, cancel) {
    menuHandlers = { navX, navY, confirm, cancel };
  }
  // Touch has no physical key to hold — main.js tracks pointerdown/pointerup
  // on the survey button itself and reports the held state here, the same
  // role HELD.has("KeyE") plays for keyboard.
  function setTouchInteractHeld(down) { state.touchInteract = down; }

  // ---- keyboard ------------------------------------------------------------
  const DIGIT = /^Digit([1-5])$/;
  function onKeyDown(e) {
    if (/^F\d{1,2}$/.test(e.key)) return; // leave the browser's own keys alone

    // A text field (the seed input) must behave like a text field. Without this
    // guard, adding menu navigation on WASD/arrows would make it impossible to
    // type a seed containing those letters — the same global listener that
    // steers the menu would eat every keystroke aimed at the input.
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (e.code === "Escape") e.target.blur();
      return;
    }

    HELD.add(e.code);
    setScheme("keyboard");

    if (mode === "menu") {
      switch (e.code) {
        case "ArrowUp": case "KeyW": menuHandlers && menuHandlers.navY(-1); break;
        case "ArrowDown": case "KeyS": menuHandlers && menuHandlers.navY(1); break;
        case "ArrowLeft": case "KeyA": menuHandlers && menuHandlers.navX(-1); break;
        case "ArrowRight": case "KeyD": menuHandlers && menuHandlers.navX(1); break;
        case "Enter": case "Space": menuHandlers && menuHandlers.confirm(); break;
        case "Escape": case "Backspace": menuHandlers && menuHandlers.cancel(); break;
        default: return;
      }
      e.preventDefault();
      return;
    }

    const digit = DIGIT.exec(e.code);
    if (digit) {
      // A digit picks a companion directly, regardless of whatever Q/R had
      // selected — the explicit index is passed through as `arg`.
      push(e.shiftKey ? ACTIONS.DOSE : ACTIONS.CHECK_IN, Number(digit[1]) - 1);
      e.preventDefault();
      return;
    }
    switch (e.code) {
      case "KeyE": push(ACTIONS.SURVEY); break;
      // F/G act on whichever companion Q/R/gamepad most recently selected —
      // no arg here, so handleAction falls through to that shared selection.
      case "KeyF": push(ACTIONS.CHECK_IN); break;
      case "KeyG": push(ACTIONS.DOSE); break;
      case "KeyQ": push(ACTIONS.PREV_TARGET); break;
      case "KeyR": push(ACTIONS.NEXT_TARGET); break;
      case "KeyZ": push(ACTIONS.CYCLE_ITEM); break;
      case "KeyX": push(ACTIONS.USE_ITEM); break;
      case "KeyC": push(ACTIONS.CRAFT); break;
      case "KeyV": push(ACTIONS.DROP_ITEM); break;
      case "KeyB": push(ACTIONS.OFFER_ITEM); break;
      case "KeyT": push(ACTIONS.CALL); break;
      case "Escape": push(ACTIONS.PAUSE); break;
      case "Space": e.preventDefault(); break;
      default: return;
    }
    e.preventDefault();
  }
  function onKeyUp(e) {
    HELD.delete(e.code);
  }

  // ---- pointer scheme detection (anywhere on the page, not just the canvas) -
  // Menus live in ordinary DOM elements outside the canvas, so scheme detection
  // has to hear about clicks/taps there too, not only in-canvas gestures.
  function onPointerDown(e) {
    setScheme(e.pointerType === "touch" || e.pointerType === "pen" ? "touch" : "keyboard");
  }

  // ---- mouse look (in-run only) ---------------------------------------------
  function onMouseMove(e) {
    if (!state.pointerLocked) return;
    // movementX/Y arrive in CSS PIXELS, and a CSS pixel is not a fixed physical
    // size — Windows display scaling at 125% makes one device pixel 0.8 CSS
    // pixels, so the identical physical mouse movement reports 20% fewer units
    // and the camera turns 20% slower. Nothing in the game changed; the unit
    // did. Multiplying by devicePixelRatio converts back to device pixels, so a
    // given physical sweep of the mouse produces the same rotation at 100%,
    // 125% and 150% scaling, on a HiDPI laptop, and after the user drags the
    // window to a second monitor mid-run.
    const toDevice = window.devicePixelRatio || 1;
    state.look.dx += e.movementX * toDevice;
    state.look.dy += e.movementY * toDevice;
  }
  /**
   * Test seam: the same path a real pointer-lock event takes, deltas in CSS px.
   * Returns the YAW IT PRODUCED — the accumulated delta is only converted to
   * rotation inside `poll`, so a seam that stops at the accumulator reports
   * nothing and any assertion built on it is vacuous.
   */
  function debugLook(dx, dy) {
    const wasLocked = state.pointerLocked;
    const wasMode = mode;
    state.pointerLocked = true;
    mode = "run";
    const before = state.yaw;
    onMouseMove({ movementX: dx, movementY: dy });
    poll(1 / 60);
    const after = state.yaw;
    state.pointerLocked = wasLocked;
    mode = wasMode;
    return after - before;
  }

  function onPointerLockChange() {
    state.pointerLocked = document.pointerLockElement === canvas;
    if (state.pointerLocked) setScheme("keyboard");
  }
  function requestLock() {
    if (canvas.requestPointerLock) canvas.requestPointerLock();
  }
  function onCanvasDown(e) {
    if (mode !== "game") return; // the canvas sits behind menu overlays too
    if (scheme === "touch") return;
    if (!state.pointerLocked) requestLock();
    else if (e.button === 0) push(ACTIONS.SURVEY);
  }

  // ---- touch (in-run steering) -----------------------------------------------
  // Left half of the screen steers, right half looks. Buttons live in the DOM.
  const touches = new Map();
  function onTouchStart(e) {
    setScheme("touch");
    for (const t of e.changedTouches) {
      touches.set(t.identifier, { x0: t.clientX, y0: t.clientY, x: t.clientX, y: t.clientY, left: t.clientX < window.innerWidth / 2 });
    }
  }
  function onTouchMove(e) {
    for (const t of e.changedTouches) {
      const rec = touches.get(t.identifier);
      if (!rec) continue;
      if (!rec.left) {
        state.look.dx += (t.clientX - rec.x) * 1.6;
        state.look.dy += (t.clientY - rec.y) * 1.6;
      }
      rec.x = t.clientX;
      rec.y = t.clientY;
    }
    if (e.cancelable) e.preventDefault();
  }
  function onTouchEnd(e) {
    for (const t of e.changedTouches) touches.delete(t.identifier);
  }
  function touchMove() {
    for (const rec of touches.values()) {
      if (!rec.left) continue;
      const dx = rec.x - rec.x0;
      const dy = rec.y - rec.y0;
      const mag = Math.min(1, Math.hypot(dx, dy) / 70);
      if (mag < 0.12) return { x: 0, z: 0, run: false };
      const len = Math.hypot(dx, dy) || 1;
      return { x: (dx / len) * mag, z: (dy / len) * mag, run: mag > 0.85 };
    }
    return { x: 0, z: 0, run: false };
  }

  // ---- gamepad ---------------------------------------------------------------
  // Xbox-style mapping: 0 A, 1 B, 2 X, 3 Y, 4 LB, 5 RB, 6 LT, 7 RT, 9 Start,
  // 10 L3, 12-15 dpad up/down/left/right, axes 0/1 left stick, 2/3 right stick.
  let padPrev = []; // previous frame's button.pressed[], for edge detection
  let stickHeldMenu = false; // debounces the left stick into discrete menu pulses

  // ---- couch co-op device ownership -----------------------------------------
  //
  // padSlots maps a physical gamepad INDEX to the human slot that owns it, and
  // an entry is written once at join time and never re-derived. That fixed
  // ownership is the whole point: local-multiplayer input goes wrong when a
  // second controller's buttons silently do nothing because the first player's
  // device claim quietly disabled them (Brain: COUCH-MULTIPLAYER/input —
  // join-action-device-cloning), and it goes wrong the other way when a
  // reconnecting pad grabs a slot it was never assigned (Brain:
  // COUCH-MULTIPLAYER/input — device-identity-registry). Freezing the mapping
  // at join makes both impossible: slot 0 reads whatever pad nobody claimed,
  // and every joined slot reads only its own.
  const padSlots = new Map(); // padIndex -> human slot (slot >= 1)
  const padPrevBySlot = new Map(); // padIndex -> previous pressed[] for edge detection

  function livePads() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    return pads ? [...pads].filter((p) => p && p.connected) : [];
  }

  /** The pad slot 0 drives: the first one nobody else has claimed. */
  function leadPad() {
    return livePads().find((p) => !padSlots.has(p.index)) || null;
  }

  /**
   * A pad that just pressed Start/A and belongs to no one yet — i.e. someone
   * on the couch asking to join. Returns its index, or null.
   *
   * Deliberately excludes the pad slot 0 is currently driving, so a solo
   * player on a controller can't accidentally join themselves as player two.
   */
  function pendingJoinPad() {
    const lead = leadPad();
    for (const p of livePads()) {
      if (padSlots.has(p.index)) continue;
      if (lead && p.index === lead.index) continue;
      const prev = padPrevBySlot.get(p.index) || [];
      const now = p.buttons.map((b) => !!(b && b.pressed));
      padPrevBySlot.set(p.index, now);
      if ((now[9] && !prev[9]) || (now[0] && !prev[0])) return p.index;
    }
    return null;
  }

  function claimPad(padIndex, slot) { padSlots.set(padIndex, slot); }
  function releaseSlot(slot) {
    for (const [idx, s] of [...padSlots]) if (s === slot) padSlots.delete(idx);
  }

  /**
   * One joined player's intent for this frame. Mirrors the lead's game-mode
   * bindings on that player's own pad, and returns null if their pad vanished
   * (unplugged / dead battery) so the caller can decide what to do rather than
   * having the character silently freeze with no explanation.
   */
  function pollSlot(slot) {
    let padIndex = null;
    for (const [idx, s] of padSlots) if (s === slot) padIndex = idx;
    if (padIndex === null) return null;
    const pad = livePads().find((p) => p.index === padIndex);
    if (!pad) return null;

    const L = stickVector(pad.axes[0] || 0, pad.axes[1] || 0);
    const R = stickVector(pad.axes[2] || 0, pad.axes[3] || 0);
    const lx = L.x, ly = L.y, rx = R.x, ry = R.y;
    const now = pad.buttons.map((b) => !!(b && b.pressed));
    const prev = padPrevBySlot.get(padIndex) || [];
    const edges = now.map((p, i) => p && !prev[i]);
    padPrevBySlot.set(padIndex, now);

    const queue = [];
    if (edges[0]) queue.push(ACTIONS.SURVEY);
    if (edges[1]) queue.push(ACTIONS.USE_ITEM);
    if (edges[2]) queue.push(ACTIONS.CHECK_IN);
    if (edges[3]) queue.push(ACTIONS.DOSE);
    if (edges[7]) queue.push(ACTIONS.CYCLE_ITEM);
    if (edges[12]) queue.push(ACTIONS.CRAFT);
    if (edges[13]) queue.push(ACTIONS.DROP_ITEM);
    if (edges[15]) queue.push(ACTIONS.OFFER_ITEM);
    if (edges[14]) queue.push(ACTIONS.CALL);

    return {
      move: { x: lx, z: ly },
      run: now[10] || now[6],
      interact: now[0],
      look: { dx: rx * 13, dy: ry * 9 },
      queue,
      // Select (button 8) is the leave verb — deliberately NOT Start, which is
      // pause, so a player cannot drop out by reaching for the pause button.
      leave: edges[8],
    };
  }

  function pollGamepad() {
    const pad = leadPad();
    if (!pad) {
      padPrev = [];
      stickHeldMenu = false;
      return null;
    }

    const L = stickVector(pad.axes[0] || 0, pad.axes[1] || 0);
    const R = stickVector(pad.axes[2] || 0, pad.axes[3] || 0);
    const lx = L.x, ly = L.y, rx = R.x, ry = R.y;
    const pressedNow = pad.buttons.map((b) => !!(b && b.pressed));
    if (lx || ly || rx || ry || pressedNow.some(Boolean)) setScheme("gamepad");

    const edges = pressedNow.map((p, i) => p && !padPrev[i]);
    padPrev = pressedNow;

    if (mode === "menu") {
      // Both D-pad (edge-triggered) and stick (debounced into single pulses)
      // drive the same grid nav — Brain: menus need to be navigable by both,
      // not just one, since players reach for whichever their thumb is on.
      const mag = Math.max(Math.abs(lx), Math.abs(ly));
      let stickDir = null;
      if (mag > 0.6 && !stickHeldMenu) {
        stickHeldMenu = true;
        stickDir = Math.abs(lx) > Math.abs(ly) ? (lx > 0 ? "right" : "left") : (ly > 0 ? "down" : "up");
      } else if (mag < 0.35) {
        stickHeldMenu = false;
      }
      if (menuHandlers) {
        if (edges[12] || stickDir === "up") menuHandlers.navY(-1);
        if (edges[13] || stickDir === "down") menuHandlers.navY(1);
        if (edges[14] || stickDir === "left") menuHandlers.navX(-1);
        if (edges[15] || stickDir === "right") menuHandlers.navX(1);
        if (edges[0] || edges[9]) menuHandlers.confirm(); // A or Start
        if (edges[1]) menuHandlers.cancel(); // B
      }
      return null;
    }

    // mode === "game"
    if (edges[0]) push(ACTIONS.SURVEY); // A
    if (edges[1]) push(ACTIONS.USE_ITEM); // B
    if (edges[2]) push(ACTIONS.CHECK_IN); // X — no arg, acts on the shared selection
    if (edges[3]) push(ACTIONS.DOSE); // Y
    if (edges[4]) push(ACTIONS.PREV_TARGET); // LB
    if (edges[5]) push(ACTIONS.NEXT_TARGET); // RB
    if (edges[7]) push(ACTIONS.CYCLE_ITEM); // RT
    if (edges[12]) push(ACTIONS.CRAFT); // D-pad Up
    if (edges[13]) push(ACTIONS.DROP_ITEM); // D-pad Down — mirrors craft above it
    if (edges[15]) push(ACTIONS.OFFER_ITEM); // D-pad Right — handing it across, sideways
    if (edges[14]) push(ACTIONS.CALL); // D-pad Left — the only face/d-pad input still free
    if (edges[9]) push(ACTIONS.PAUSE); // Start
    state.look.dx += rx * 13;
    state.look.dy += ry * 9;
    return { x: lx, z: ly, run: pressedNow[10] || pressedNow[6], interact: pressedNow[0] };
  }

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", onPointerDown, { passive: true });
  window.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onPointerLockChange);
  canvas.addEventListener("mousedown", onCanvasDown);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);
  window.addEventListener("blur", () => HELD.clear());

  /**
   * Read-and-clear the frame's intent. Call every frame regardless of screen —
   * in 'menu' mode this only has side effects (scheme tracking, dispatching to
   * menuHandlers) and returns null; in 'game' mode it also returns the movement
   * intent the sim step needs.
   */
  function poll(dt) {
    const padMove = pollGamepad();
    if (mode === "menu") return null;

    let x = 0, z = 0;
    if (HELD.has("KeyW") || HELD.has("ArrowUp")) z -= 1;
    if (HELD.has("KeyS") || HELD.has("ArrowDown")) z += 1;
    if (HELD.has("KeyA") || HELD.has("ArrowLeft")) x -= 1;
    if (HELD.has("KeyD") || HELD.has("ArrowRight")) x += 1;
    let run = HELD.has("ShiftLeft") || HELD.has("ShiftRight");
    if (!x && !z && padMove) { x = padMove.x; z = padMove.z; run = run || padMove.run; }
    const touch = touchMove();
    if (!x && !z && (touch.x || touch.z)) { x = touch.x; z = touch.z; run = run || touch.run; }

    const sens = (opts.sensitivity ?? 1) * 0.0022;
    state.yaw -= state.look.dx * sens;
    state.pitch = Math.max(-1.15, Math.min(1.15, state.pitch - state.look.dy * sens));
    state.look.dx = 0;
    state.look.dy = 0;

    const queue = state.queue;
    state.queue = [];
    state.move.x = x;
    state.move.z = z;
    state.run = run;
    // Continuous HELD state for hold-to-gather — deliberately separate from
    // `queue`, which only ever carries discrete, already-fired taps.
    const interact = HELD.has("KeyE") || !!(padMove && padMove.interact) || state.touchInteract;
    return { move: { x, z }, run, yaw: state.yaw, pitch: state.pitch, queue, scheme, dt, interact };
  }

  function destroy() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("pointerdown", onPointerDown);
    window.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
  }

  return {
    setMode,
    debugLook,
    setMenuHandlers,
    setTouchInteractHeld,
    poll,
    requestLock,
    destroy,
    get activeScheme() { return scheme; },
    // Couch co-op. `pendingJoinPad()` is polled by main.js while a run is
    // live; claiming is explicit so device ownership is fixed at join time.
    pendingJoinPad,
    claimPad,
    releaseSlot,
    pollSlot,
    get joinedPads() { return padSlots.size; },
  };
}
