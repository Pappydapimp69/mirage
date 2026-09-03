// audio.js — generative ambience and cues. No samples, no assets: everything is
// synthesised, so the game stays a static site with nothing to download.
//
// The bed does real work here. Lucidity is invisible, so the mix is one of the
// few honest-ish channels the player has: wind thins, a detuned second drone
// slides in as the lead frays, and whispers arrive only once they are gone.
// Degrades to silence if WebAudio is unavailable (headless test runs).

export function createAudio() {
  let ctx = null;
  let master = null;
  const nodes = {};
  let started = false;
  let muted = false;
  let volume = 0.7;

  function ensure() {
    if (ctx || typeof window === "undefined") return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(ctx.destination);
    return ctx;
  }

  function noiseBuffer(seconds = 2) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < n; i++) {
      // Brown-ish noise: closer to wind than white noise, and easier on the ear
      // over a long run.
      last = (last + (Math.random() * 2 - 1) * 0.06) * 0.985;
      d[i] = last * 3;
    }
    return buf;
  }

  /** Start the ambient bed. Must be called from a user gesture (browser policy). */
  function start() {
    if (started || !ensure()) return false;
    started = true;
    if (ctx.state === "suspended") ctx.resume();

    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(4);
    wind.loop = true;
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 420;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.22;
    wind.connect(windFilter).connect(windGain).connect(master);
    wind.start();
    nodes.windGain = windGain;
    nodes.windFilter = windFilter;

    // ground drone (stable) + a detuned partner that only rises with distortion
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.1;
    droneGain.connect(master);
    for (const f of [55, 82.5]) {
      const o = ctx.createOscillator();
      o.type = "sine";
      o.frequency.value = f;
      o.connect(droneGain);
      o.start();
    }
    const wrongGain = ctx.createGain();
    wrongGain.gain.value = 0;
    wrongGain.connect(master);
    const wrong = ctx.createOscillator();
    wrong.type = "sawtooth";
    wrong.frequency.value = 53.2; // a hair flat against the 55 — beats, slowly
    const wrongFilter = ctx.createBiquadFilter();
    wrongFilter.type = "lowpass";
    wrongFilter.frequency.value = 300;
    wrong.connect(wrongFilter).connect(wrongGain);
    wrong.start();
    nodes.wrongGain = wrongGain;

    // pylon hum — gain tracks proximity, set from update()
    const humGain = ctx.createGain();
    humGain.gain.value = 0;
    humGain.connect(master);
    const hum = ctx.createOscillator();
    hum.type = "triangle";
    hum.frequency.value = 196;
    hum.connect(humGain);
    hum.start();
    nodes.humGain = humGain;

    // ---- WOODLAND, for the camp -------------------------------------------
    // The basin's bed is wind, a low drone and a detuned partner — correct for
    // a fogged plain where the mix is one of the few honest channels. The camp
    // is a wood in daylight and was inheriting all of it, so a peaceful place
    // sounded like the thing it exists to prepare you for.
    //
    // Its own layer, crossfaded against the basin bed rather than replacing it.
    // EQUAL POWER (cos/sin, g1^2+g2^2=1) because the two beds are uncorrelated
    // signals — brain: dog#E57, where a linear fade between uncorrelated layers
    // dips 3 dB at the midpoint. A linear crossfade here would put an audible
    // hole in the middle of every transition.
    const woodGain = ctx.createGain();
    woodGain.gain.value = 0;
    woodGain.connect(master);
    nodes.woodGain = woodGain;

    // Leaves: filtered noise, band-passed high and gently swept so it breathes
    // instead of hissing.
    const leaves = ctx.createBufferSource();
    leaves.buffer = noiseBuffer(6);
    leaves.loop = true;
    const leafFilter = ctx.createBiquadFilter();
    leafFilter.type = "bandpass";
    leafFilter.frequency.value = 2600;
    leafFilter.Q.value = 0.7;
    const leafGain = ctx.createGain();
    leafGain.gain.value = 0.16;
    leaves.connect(leafFilter).connect(leafGain).connect(woodGain);
    leaves.start();
    // A slow LFO on the filter — wind moving through a canopy, not a hiss.
    const gust = ctx.createOscillator();
    gust.type = "sine";
    gust.frequency.value = 0.07;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 900;
    gust.connect(gustDepth).connect(leafFilter.frequency);
    gust.start();

    // Birds. Scheduled on the AUDIOCONTEXT CLOCK with a look-ahead window, never
    // per-call setTimeout — brain: shadow#E1, JS timers drift and are throttled
    // when the tab is backgrounded, so a bird would stutter or stop entirely
    // the moment somebody alt-tabbed.
    const birdBus = ctx.createGain();
    birdBus.gain.value = 0.5;
    birdBus.connect(woodGain);
    nodes.birdBus = birdBus;
    let nextCall = 0;
    nodes.pumpBirds = () => {
      if (!ctx || woodGain.gain.value < 0.02) return;
      const horizon = ctx.currentTime + 2.5;
      // Bounded by the horizon, so this can never queue an unbounded burst of
      // voices (dog#E6's concurrent-voice budget, in the form this needs).
      let guard = 0;
      while (nextCall < horizon && guard++ < 8) {
        if (nextCall < ctx.currentTime) nextCall = ctx.currentTime + 0.5;
        chirp(nextCall);
        nextCall += 2.2 + Math.random() * 5.5;
      }
    };

    /** One short two-note call. Every node is disconnected on ended (dog#E6). */
    function chirp(at) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      const base = 1700 + Math.random() * 1400;
      o.frequency.setValueAtTime(base, at);
      o.frequency.exponentialRampToValueAtTime(base * (1.25 + Math.random() * 0.5), at + 0.07);
      o.frequency.exponentialRampToValueAtTime(base * 0.92, at + 0.16);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.14, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
      o.connect(g).connect(birdBus);
      o.start(at);
      o.stop(at + 0.26);
      // Connected/scheduled nodes are NOT freed for you.
      o.onended = () => { try { o.disconnect(); g.disconnect(); } catch {} };
    }

    return true;
  }

  /**
   * Cross-fade between the basin bed and the woodland bed.
   * @param wood 0 = basin, 1 = camp
   */
  function setBiome(wood) {
    if (!ctx || !nodes.woodGain) return;
    const w = Math.max(0, Math.min(1, wood));
    // Equal power: the two beds are uncorrelated, so amplitudes must satisfy
    // g1^2 + g2^2 = 1 or the midpoint loses 3 dB (dog#E57).
    const gWood = Math.sin((w * Math.PI) / 2);
    const gBasin = Math.cos((w * Math.PI) / 2);
    ramp(nodes.woodGain.gain, gWood, 1.2);
    if (nodes.windGain) ramp(nodes.windGain.gain, 0.22 * gBasin, 1.2);
    if (nodes.humGain && w > 0.5) ramp(nodes.humGain.gain, 0, 1.2);
    nodes.biome = w;
  }

  function ramp(param, value, seconds = 0.4) {
    if (!ctx) return;
    param.cancelScheduledValues(ctx.currentTime);
    param.setTargetAtTime(value, ctx.currentTime, Math.max(0.02, seconds / 3));
  }

  /**
   * @param distortion 0..1 — how far gone the lead is
   * @param pylonProximity 0..1 — 1 at the core of a live pylon
   */
  function update(distortion, pylonProximity) {
    if (!started || !ctx) return;
    // SCALED BY THE BIOME. This runs every frame from the basin's palette and
    // was undoing setBiome's crossfade on the next tick — the same shape as the
    // renderer's per-frame fog drift resetting the camp's daylight. Anything
    // set once has to be respected here or it lasts exactly one frame.
    const wood = nodes.biome || 0;
    const basin = Math.cos((wood * Math.PI) / 2);
    ramp(nodes.wrongGain.gain, 0.13 * distortion * basin, 1.2);
    ramp(nodes.windGain.gain, 0.22 * (1 - distortion * 0.6) * basin, 1.5);
    ramp(nodes.windFilter.frequency, 420 - distortion * 260, 1.5);
    ramp(nodes.humGain.gain, 0.09 * pylonProximity * basin, 0.5);
    // Top up the bird schedule inside its look-ahead window.
    nodes.pumpBirds?.();
  }

  function blip({ freq = 440, dur = 0.16, type = "sine", gain = 0.18, slide = 0 } = {}) {
    if (!started || !ctx) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, ctx.currentTime + dur);
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(gain, ctx.currentTime + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  const cues = {
    log: () => { blip({ freq: 520, dur: 0.14, type: "triangle" }); setTimeout(() => blip({ freq: 780, dur: 0.2, type: "triangle" }), 90); },
    logFalse: () => blip({ freq: 300, dur: 0.5, type: "sawtooth", gain: 0.12, slide: -120 }),
    dose: () => blip({ freq: 660, dur: 0.3, type: "sine", gain: 0.15, slide: 240 }),
    recover: () => { blip({ freq: 300, dur: 0.3, type: "sine", slide: 200 }); setTimeout(() => blip({ freq: 620, dur: 0.35 }), 140); },
    hallucinate: () => blip({ freq: 180, dur: 0.9, type: "sawtooth", gain: 0.16, slide: -70 }),
    // A brief, low, guttural stinger for the monster-flicker reveal — deliberately
    // distinct from "hallucinate" (that one marks going under; this one marks a
    // single wrong instant inside an episode already underway).
    monster: () => blip({ freq: 85, dur: 0.5, type: "sawtooth", gain: 0.17, slide: -35 }),
    // A carried item turning out to be something else the moment it's used —
    // deliberately its own cue rather than reusing "break" (that one already
    // means a companion snapping off toward a pylon, in party.js). Quick
    // downward buzz: a wrong answer, not a threat.
    reveal: () => blip({ freq: 520, dur: 0.22, type: "square", gain: 0.15, slide: -260 }),
    break: () => blip({ freq: 240, dur: 0.25, type: "square", gain: 0.08 }),
    deny: () => blip({ freq: 150, dur: 0.12, type: "square", gain: 0.07 }),
    // CHORUS agreeing with something the player just did. Deliberately NOT a
    // stinger: three near-unison partials a few cents apart, entering together
    // and decaying together, so it reads as several throats saying one word
    // rather than as an alarm. The beating between them is the whole effect —
    // the same trick the `wrong` drone uses against the ground tone, which is
    // why this sits comfortably on top of the bed instead of fighting it.
    chorus: () => {
      for (const f of [196, 197.6, 293.4]) {
        blip({ freq: f, dur: 0.75, type: "triangle", gain: 0.055, slide: -3 });
      }
    },
  };

  /**
   * A whisper: filtered noise burst. Only ever played while the lead is gone.
   *
   * `emphasis` (0..1) is how insistent the voices have got — percept.js's
   * chorusTier over 2, for a lead under CHORUS. It narrows the band and lifts
   * the level a little, so the same channel carries "there are voices" and
   * "the voices are getting louder about it" without becoming a second sound.
   * Defaults to 0, so every existing caller is unchanged.
   */
  function whisper(emphasis = 0) {
    if (!started || !ctx) return;
    const e = Math.max(0, Math.min(1, emphasis));
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(1);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 900 + Math.random() * 1400;
    bp.Q.value = 6 + e * 6;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.gain.linearRampToValueAtTime(0.13 + e * 0.06, ctx.currentTime + 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.9);
    src.connect(bp).connect(g).connect(master);
    src.start();
    src.stop(ctx.currentTime + 1);
  }

  function play(kind) {
    (cues[kind] || (() => {}))();
  }

  function setVolume(v) {
    volume = Math.max(0, Math.min(1, v));
    if (master && !muted) ramp(master.gain, volume, 0.2);
  }
  function setMuted(m) {
    muted = !!m;
    if (master) ramp(master.gain, muted ? 0 : volume, 0.2);
  }

  return { start, update, play, whisper, setVolume, setMuted, setBiome, get ready() { return started; } };
}
