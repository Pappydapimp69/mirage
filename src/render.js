// render.js — Three.js presentation of the basin, drawn from PERCEPTION.
//
// Hard rule: this module reads the perceived world (percept.js), never the sim's
// truth. That is what lets a hallucinating lead be shown a monolith that does not
// exist without any special case here — the phantom simply arrives in the same
// list as the real ones.

import * as THREE from "../lib/three.module.js";
import { CELL, GRID, cellToWorld } from "./world.js?v=mirage-0.13.2";
import { perceivedMonoliths, perceivedPylons, perceivedCompanions, perceivedWorldItems, distortion } from "./percept.js?v=mirage-0.13.2";
import { PYLON_RADIUS } from "./state.js?v=mirage-0.13.2";

const PALETTE = {
  sky: 0x0a0f16,
  fog: 0x121a24,
  fogLost: 0x2a1d2b, // the basin goes wrong-coloured when the lead does
  ground: 0x333c4b,
  groundHi: 0x475364,
  rock: 0x1b212b,
  monolith: 0x59657a,
  monolithLogged: 0x7fd6c0,
  pylon: 0x2a3550,
  pylonLive: 0x74e0ff,
  pylonDead: 0x40484f,
  camp: 0xffb562,
  body: 0x8d97a8,
  // A gone companion must separate from a well one by LUMINANCE, not hue. The
  // previous 0xb06a72 was a warm red at almost exactly the body's brightness:
  // WCAG contrast 1.38 normally and 1.14 simulated for deuteranopia, i.e. the
  // single most important tell in the game — "that mind is gone" — was
  // invisible to a large share of players. This is the same warm register,
  // dropped in brightness: 3.15 against the body across all three CVD types,
  // and still 1.8 against PALETTE.monster, which additionally carries a size
  // change and a different eye colour. (Brain: COUCH-MULTIPLAYER/accessibility
  // — no palette is safe across all CVD types, so meaning must never rest on
  // hue alone. A contrast guard in logic.test.mjs holds this.)
  bodyLost: 0x5e2f3c,
  monster: 0x140a0d, // near-black with a red undertone — wrong, not just "gone"
  monsterEye: 0xff2a2a,
  itemFlare: 0xff8a3d,
  itemTether: 0x5fe0c0,
  itemLens: 0xbfe6ff,
  treeTrunk: 0x4a3826,
  treeLeaf: 0x3f6b3f, // green, deliberately distinct from the dark rock-spire cones
  stoneDeposit: 0x8b95a3, // lighter than the near-black rock spires and the grey ground litter
};

// No phantom-object case here — a fake pickup is resolved entirely in
// state.js/percept.js's inventory layer, never as a fake mesh sitting in the
// world (see perceivedWorldItems's own comment for why).
const ITEM_COLOR = { flare: PALETTE.itemFlare, tether: PALETTE.itemTether, lens: PALETTE.itemLens };

const EYE_HEIGHT = 1.72;

// Horizontal field of view, in degrees. 90 sits in the ordinary first-person
// band (most games ship 90-100 horizontal); past ~100 the perspective starts
// reading as a fisheye lens rather than as a room.
// 90 was too wide. Rectilinear projection stretches hard toward the frame edges
// at that angle — trunks near the screen border lean and smear as you turn, and
// it reads as the lens being wrong rather than as a wide view. It is also the
// wrong choice for THIS game: a slow, close, wooded exploration where the
// periphery is where you are trying to notice a figure. 78 keeps the edges
// honest. Still a player setting (70-110) — this is only the default.
const DEFAULT_HFOV = 78;
// On a very tall/narrow window (a phone held upright) deriving vertical from a
// fixed horizontal would balloon it, so cap it — a portrait player loses a
// little horizontal instead of gaining a vertical fisheye.
// And a hard cap on the VERTICAL, which is what actually distorts. On a narrow
// or square window verticalFov() from a wide horizontal runs away — at a 1:1
// aspect a 90 horizontal solves to 90 vertical — so the cap is the only thing
// standing between an unusual window shape and a fisheye. 68 is wide enough to
// feel open and short of where the stretch becomes obvious.
const MAX_VFOV = 68;

/** The VERTICAL fov Three wants, for a given aspect, holding horizontal fixed. */
function verticalFov(aspect, hfov = DEFAULT_HFOV) {
  const h = (hfov * Math.PI) / 180;
  const v = 2 * Math.atan(Math.tan(h / 2) / Math.max(0.2, aspect || 1));
  return Math.min(MAX_VFOV, (v * 180) / Math.PI);
}

export function createRenderer(canvas, sim) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  // Fog density set against SIGHT_RANGE (38 units): at 0.021 a marker at the
  // edge of sighting range was ~47% fogged out, which made exploring feel like
  // guessing. 0.014 keeps the basin oppressive but legible.
  // The CAMP is daylight, not a fogged basin at dusk. Same scene, different
  // weather: thinner fog so you can see the length of the path and the cabins
  // at the far end, and a warmer ground colour. Built without this the camp
  // rendered as a near-black clearing — correct geometry, unreadable place.
  const isCamp = !!sim.world.cellKind;
  scene.fog = new THREE.FogExp2(isCamp ? 0x8fa2b4 : PALETTE.fog, isCamp ? 0.006 : 0.014);
  // Without this the sky is the clear colour — black — so a daylit camp still
  // read as night above the treeline.
  if (isCamp) scene.background = new THREE.Color(0x8fa2b4);

  // FIELD OF VIEW IS HORIZONTAL-FIRST ("Hor+"), and this matters more than it
  // looks. Three's PerspectiveCamera takes a VERTICAL fov, and this shipped at
  // 72 — which is 105° HORIZONTAL on a 16:9 screen and 119° on an ultrawide.
  // That is deep fisheye: wide-angle perspective bows straight lines toward the
  // frame edges and sweeps edge geometry past you as you walk, which reads as
  // "the world is curved and misshapen" and as a problem with the MOVEMENT,
  // even though the movement is mathematically exact (a constant input walks a
  // line with 0.0000 lateral deviation — measured, not assumed).
  //
  // So: pick the horizontal angle and derive vertical from the real aspect.
  // A wider monitor now shows MORE WORLD instead of more distortion, which is
  // the whole point of Hor+ — the lens stops changing shape with the window.
  // Player-adjustable, because comfort at a given angle is genuinely personal —
  // the same lens that reads as "a room" to one player reads as a tunnel or a
  // fisheye to another. setFov() is the only writer.
  let hfov = DEFAULT_HFOV;
  const camera = new THREE.PerspectiveCamera(verticalFov(1.778, hfov), 1, 0.1, 420);
  const rig = new THREE.Group(); // yaw/position; camera holds pitch and roll
  rig.add(camera);
  scene.add(rig);

  scene.add(isCamp
    ? new THREE.HemisphereLight(0xcfe0f2, 0x6a6555, 1.5)
    : new THREE.HemisphereLight(0x5d708c, 0x1d2230, 1.05));
  const sun = new THREE.DirectionalLight(isCamp ? 0xfff0d8 : 0xbfd0e6, isCamp ? 1.15 : 0.55);
  sun.position.set(-40, 60, 30);
  scene.add(sun);
  // A single carried lamp — cheaper than one light per companion, and it makes
  // the party's own pool of light the thing you navigate by.
  const lamp = new THREE.PointLight(0xffdcb0, 1.9, 44, 1.5);
  rig.add(lamp);

  // ---- terrain -------------------------------------------------------------
  const span = GRID * CELL;
  const groundGeo = new THREE.PlaneGeometry(span, span, GRID, GRID);
  groundGeo.rotateX(-Math.PI / 2);
  {
    const pos = groundGeo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    // Grass in the camp, cold rock in a basin.
    const lo = new THREE.Color(isCamp ? 0x3f5230 : PALETTE.ground);
    const hi = new THREE.Color(isCamp ? 0x59703c : PALETTE.groundHi);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const h = sim.world.heightAt(x / CELL + GRID / 2, z / CELL + GRID / 2);
      pos.setY(i, h);
      c.copy(lo).lerp(hi, Math.min(1, Math.max(0, (h + 2) / 7)));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    groundGeo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    groundGeo.computeVertexNormals();
  }
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 }),
  );
  scene.add(ground);

  const terrainHeight = (x, z) => sim.world.heightAt(x / CELL + GRID / 2, z / CELL + GRID / 2);

  // ---- what a blocked cell LOOKS like --------------------------------------
  // A basin has one answer: a rock spire. The camp has four, and it needs them —
  // built without this, its cabins drew as rock, its treeline drew as rock, and
  // its dirt path drew as nothing, so the whole map read as a rocky clearing and
  // a player who pressed "Learn the walk" believed the tutorial had not loaded.
  // Every geometry test passed the whole time; none of them can see.
  //
  // `cellKind` is camp-only. A world without it takes the original path below,
  // unchanged.
  const KIND = { NONE: 0, CABIN: 1, TREELINE: 2, WOOD: 3, PATH: 4 };
  const kindAt = (cx, cz) => (sim.world.cellKind ? sim.world.cellKind[cz * GRID + cx] : KIND.NONE);
  const isSpire = (cx, cz) => {
    const i = cz * GRID + cx;
    if (!sim.world.blocked[i]) return false;
    return kindAt(cx, cz) === KIND.NONE;   // anything tagged draws as itself
  };

  if (sim.world.cellKind) buildCampScenery();

  /** Cabins, trees and a dirt path — the camp's own vocabulary. */
  function buildCampScenery() {
    const timber = new THREE.MeshStandardMaterial({ color: 0x4a3a2c, roughness: 0.95, flatShading: true });
    const roof = new THREE.MeshStandardMaterial({ color: 0x2e2620, roughness: 1, flatShading: true });
    const trunkMat = new THREE.MeshStandardMaterial({ color: PALETTE.treeTrunk, roughness: 0.9 });
    const leafMat = new THREE.MeshStandardMaterial({ color: PALETTE.treeLeaf, roughness: 0.85, flatShading: true });
    // Well lighter than the grass. At 0x50432f the path was technically drawn
    // and read as a slightly different green — a path you cannot see is not a path.
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0x9c7f55, roughness: 1 });

    // CABINS. One box per tagged cell would read as a wall of cubes, so
    // contiguous runs are merged into a single building per rectangle and only
    // the run's first cell places geometry.
    const seen = new Uint8Array(GRID * GRID);
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (kindAt(cx, cz) !== KIND.CABIN || seen[cz * GRID + cx]) continue;
        let x1 = cx; while (x1 + 1 < GRID && kindAt(x1 + 1, cz) === KIND.CABIN) x1++;
        let z1 = cz;
        outer: while (z1 + 1 < GRID) {
          for (let x = cx; x <= x1; x++) if (kindAt(x, z1 + 1) !== KIND.CABIN) break outer;
          z1++;
        }
        for (let z = cz; z <= z1; z++) for (let x = cx; x <= x1; x++) seen[z * GRID + x] = 1;

        const a = cellToWorld(cx, cz), b = cellToWorld(x1, z1);
        const w = Math.abs(b.x - a.x) + CELL, d = Math.abs(b.z - a.z) + CELL;
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const ground = terrainHeight(mx, mz);
        const H = 3.2;
        const walls = new THREE.Mesh(new THREE.BoxGeometry(w * 0.92, H, d * 0.92), timber);
        walls.position.set(mx, ground + H / 2, mz);
        scene.add(walls);
        // A pitched roof, so it reads as a building rather than a crate.
        const cap = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, 1.9, 4), roof);
        cap.position.set(mx, ground + H + 0.85, mz);
        cap.rotation.y = Math.PI / 4;
        scene.add(cap);
      }
    }

    // TREES, for the perimeter wall and the thin wood inside it. Instanced —
    // there are over a thousand.
    let treeCount = 0;
    for (let i = 0; i < sim.world.cellKind.length; i++) {
      const k = sim.world.cellKind[i];
      if (k === KIND.TREELINE || k === KIND.WOOD) treeCount++;
    }
    const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.32, 3.4, 5), trunkMat, treeCount);
    const crowns = new THREE.InstancedMesh(new THREE.ConeGeometry(1.5, 4.4, 6), leafMat, treeCount);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion();
    let n = 0;
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        const k = kindAt(cx, cz);
        if (k !== KIND.TREELINE && k !== KIND.WOOD) continue;
        const { x, z } = cellToWorld(cx, cz);
        // Deterministic jitter from the cell index — the same camp every time,
        // without touching the sim's rng.
        const j = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
        const ox = (((j % 100) / 100) - 0.5) * CELL * 0.55;
        const oz = ((((j >>> 8) % 100) / 100) - 0.5) * CELL * 0.55;
        const h = 0.82 + ((j >>> 16) % 100) / 100 * 0.7;
        const g = terrainHeight(x + ox, z + oz);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ((j >>> 5) % 360) * (Math.PI / 180));
        m.compose(new THREE.Vector3(x + ox, g + 1.7 * h, z + oz), q, new THREE.Vector3(h, h, h));
        trunks.setMatrixAt(n, m);
        m.compose(new THREE.Vector3(x + ox, g + (3.4 + 2.2) * h, z + oz), q, new THREE.Vector3(h, h, h));
        crowns.setMatrixAt(n, m);
        n++;
      }
    }
    trunks.instanceMatrix.needsUpdate = true;
    crowns.instanceMatrix.needsUpdate = true;
    scene.add(trunks, crowns);

    // THE PATH. Flat quads just above the ground, so the route through the camp
    // is legible as a route.
    const pathGeo = new THREE.PlaneGeometry(CELL, CELL);
    let pathCount = 0;
    for (let i = 0; i < sim.world.cellKind.length; i++) if (sim.world.cellKind[i] === KIND.PATH) pathCount++;
    const dirt = new THREE.InstancedMesh(pathGeo, dirtMat, pathCount);
    let pn = 0;
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (kindAt(cx, cz) !== KIND.PATH) continue;
        const { x, z } = cellToWorld(cx, cz);
        m.makeRotationX(-Math.PI / 2);
        // Sample the cell's CORNERS and clear the highest of them. Placing the
        // quad at the cell-centre height buried it: the ground is an
        // interpolated vertex-coloured plane, so between grid vertices the real
        // surface can sit well above the centre sample, and the path vanished
        // under the grass in exactly the places the ground rose.
        const h = Math.max(
          terrainHeight(x - CELL / 2, z - CELL / 2), terrainHeight(x + CELL / 2, z - CELL / 2),
          terrainHeight(x - CELL / 2, z + CELL / 2), terrainHeight(x + CELL / 2, z + CELL / 2),
          terrainHeight(x, z),
        );
        m.setPosition(x, h + 0.06, z);
        dirt.setMatrixAt(pn++, m);
      }
    }
    dirt.instanceMatrix.needsUpdate = true;
    scene.add(dirt);
  }

  // ---- rock spires (one instanced mesh for every UNTAGGED blocked cell) -----
  {
    let count = 0;
    for (let cz = 0; cz < GRID; cz++) for (let cx = 0; cx < GRID; cx++) if (isSpire(cx, cz)) count++;
    const rocks = new THREE.InstancedMesh(
      new THREE.ConeGeometry(CELL * 0.72, 1, 6),
      new THREE.MeshStandardMaterial({ color: PALETTE.rock, roughness: 1, flatShading: true }),
      count,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    let n = 0;
    for (let cz = 0; cz < GRID; cz++) {
      for (let cx = 0; cx < GRID; cx++) {
        if (!isSpire(cx, cz)) continue;
        const { x, z } = cellToWorld(cx, cz);
        // Deterministic pseudo-variation from the cell index — no rng needed, and
        // it stays identical across reloads of the same seed.
        const j = ((cx * 73856093) ^ (cz * 19349663)) >>> 0;
        const h = 3.4 + ((j % 100) / 100) * 5.2;
        const yaw = ((j >>> 7) % 360) * (Math.PI / 180);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        m.compose(
          new THREE.Vector3(x, terrainHeight(x, z) + h / 2 - 0.4, z),
          q,
          new THREE.Vector3(1, h, 1),
        );
        rocks.setMatrixAt(n++, m);
      }
    }
    rocks.instanceMatrix.needsUpdate = true;
    scene.add(rocks);
  }

  // ---- ground litter -------------------------------------------------------
  // Scattered stones across the open floor. Not decoration: the basin is a fogged
  // plain, and without near-field detail passing the camera there is no parallax,
  // so walking reads as standing still with the fog shifting. This is the cheapest
  // fix — one instanced mesh, no per-frame work — and it is what makes movement
  // legible in an exploration game with a short view distance.
  {
    const MAX = 620;
    const stones = new THREE.InstancedMesh(
      new THREE.IcosahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({ color: 0x39424f, roughness: 1, flatShading: true }),
      MAX,
    );
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    let n = 0;
    // Deterministic scatter from the cell index, so the same seed lays out the
    // same stones on every reload without consuming the sim's rng stream.
    for (let cz = 1; cz < GRID - 1 && n < MAX; cz++) {
      for (let cx = 1; cx < GRID - 1 && n < MAX; cx++) {
        if (sim.world.blocked[cz * GRID + cx]) continue;
        const j = ((cx * 2654435761) ^ (cz * 40503)) >>> 0;
        if (j % 5 !== 0) continue; // ~20% of open cells get one
        const ox = (((j >>> 3) % 100) / 100 - 0.5) * CELL;
        const oz = (((j >>> 11) % 100) / 100 - 0.5) * CELL;
        const { x, z } = cellToWorld(cx, cz);
        const s = 0.5 + ((j >>> 17) % 100) / 140;
        q.setFromAxisAngle(up, ((j >>> 5) % 360) * (Math.PI / 180));
        m.compose(
          new THREE.Vector3(x + ox, terrainHeight(x + ox, z + oz) + 0.08 * s, z + oz),
          q,
          new THREE.Vector3(s, s * 0.6, s),
        );
        stones.setMatrixAt(n++, m);
      }
    }
    stones.count = n; // don't draw unused instances at the origin
    stones.instanceMatrix.needsUpdate = true;
    scene.add(stones);
  }

  // ---- camp ---------------------------------------------------------------
  {
    const camp = new THREE.Group();
    const { x, z } = sim.world.camp;
    camp.position.set(x, terrainHeight(x, z), z);
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, 6, 6),
      new THREE.MeshStandardMaterial({ color: 0x555f6d, roughness: 0.8 }),
    );
    mast.position.y = 3;
    camp.add(mast);
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.42, 14, 12),
      new THREE.MeshBasicMaterial({ color: PALETTE.camp }),
    );
    beacon.position.y = 6.2;
    camp.add(beacon);
    camp.add(new THREE.PointLight(PALETTE.camp, 1.1, 26, 1.7).translateY(6.2));
    scene.add(camp);
  }

  // ---- monoliths, pylons, figures: pooled and rebuilt from perception ------
  const monolithGeo = new THREE.BoxGeometry(1.5, 7.4, 1.1);
  const ringGeo = new THREE.TorusGeometry(PYLON_RADIUS, 0.09, 6, 40);
  const pool = { monoliths: new Map(), pylons: new Map(), figures: new Map(), items: new Map(), trees: new Map(), stones: new Map() };

  function makeMonolith() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      monolithGeo,
      new THREE.MeshStandardMaterial({ color: PALETTE.monolith, roughness: 0.85, flatShading: true }),
    );
    body.position.y = 3.7;
    body.rotation.z = 0.06;
    g.add(body);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 10),
      new THREE.MeshBasicMaterial({ color: PALETTE.monolithLogged }),
    );
    cap.position.y = 7.7;
    cap.visible = false;
    g.add(cap);
    g.userData = { body, cap };
    scene.add(g);
    return g;
  }

  function makePylon() {
    const g = new THREE.Group();
    const col = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.5, 4.6, 8),
      new THREE.MeshStandardMaterial({ color: PALETTE.pylon, roughness: 0.7, metalness: 0.2 }),
    );
    col.position.y = 2.3;
    g.add(col);
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 16, 12),
      new THREE.MeshBasicMaterial({ color: PALETTE.pylonLive }),
    );
    core.position.y = 5.0;
    g.add(core);
    const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: PALETTE.pylonLive, transparent: true, opacity: 0.28 }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.25;
    g.add(ring);
    const glow = new THREE.PointLight(PALETTE.pylonLive, 1.4, 22, 1.7);
    glow.position.y = 5.0;
    g.add(glow);
    g.userData = { core, ring, glow };
    scene.add(g);
    return g;
  }

  // FIVE DISTINCT BUILDS, one per roster slot. Every companion was the same
  // capsule in the same colour, so at any distance past a few metres the party
  // was five identical grey shapes and "who is that over there" had no answer.
  //
  // Silhouette carries the difference, not colour — heights, widths, a pack, a
  // hood. brain: the-game-the-recursion#E12 found two independently-authored
  // entity palettes landing on the red-green confusion axis at nearly identical
  // luminance, where only the silhouettes separated them. So the shapes differ
  // first and the tints are a secondary cue, checked for luminance spread — the
  // first pass put slots 3 and 5 within 0.7 luminance of each other ON that
  // axis, which is precisely E12's case, so slot 5 was darkened until every
  // pair clears a real margin.
  const BUILDS = [
    { r: 0.34, h: 1.05, head: 0.25, tint: 0x8d97a8, pack: true,  hood: false }, // 1 broad, packed
    { r: 0.27, h: 0.86, head: 0.22, tint: 0xb9a58c, pack: false, hood: false }, // 2 slight
    { r: 0.33, h: 1.16, head: 0.24, tint: 0x7f8d84, pack: false, hood: true  }, // 3 tall, hooded
    { r: 0.30, h: 0.78, head: 0.26, tint: 0xa89aa6, pack: true,  hood: false }, // 4 short, packed
    { r: 0.36, h: 0.98, head: 0.23, tint: 0x6a5f4a, pack: false, hood: false }, // 5 stocky
  ];

  function makeFigure(item) {
    const g = new THREE.Group();
    // `index` is 1-based on companions and 0 on the lead; a phantom has none, so
    // it falls through to slot 0's build and reads as a real member — which is
    // the point of a phantom.
    const b = BUILDS[Math.max(0, ((item?.index ?? 1) - 1)) % BUILDS.length];
    const mat = new THREE.MeshStandardMaterial({ color: b.tint, roughness: 0.8 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(b.r, b.h, 6, 10), mat);
    body.position.y = 0.55 + b.h / 2;
    g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(b.head, 12, 10), mat);
    head.position.y = 0.55 + b.h + b.head * 1.3;
    g.add(head);
    if (b.hood) {
      const hood = new THREE.Mesh(new THREE.ConeGeometry(b.head * 1.5, b.head * 2.1, 7), mat);
      hood.position.y = head.position.y + b.head * 0.5;
      g.add(hood);
    }
    if (b.pack) {
      const pack = new THREE.Mesh(new THREE.BoxGeometry(b.r * 1.5, b.h * 0.7, b.r * 0.9), mat);
      pack.position.set(0, 0.55 + b.h * 0.55, -b.r * 1.1);
      g.add(pack);
    }
    const light = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    );
    light.position.set(b.r * 0.9, 0.55 + b.h * 0.75, 0.22);
    g.add(light);
    g.userData = { mat, light, tint: b.tint, bob: Math.random() * 6.283, lastX: 0, lastZ: 0 };
    scene.add(g);
    return g;
  }

  /**
   * A marker over the trainer, so "walk over to him" names somebody you can
   * pick out. Without it the objective points at one of six identical figures
   * standing in a field and the player has to guess which.
   *
   * Deliberately DIEGETIC-ish and camp-only: a lantern on a pole, not a
   * floating waypoint arrow. It is a thing at a place, which is the same
   * grammar as everything else in this game, and it never appears in a basin.
   */
  let trainerMark = null;
  function ensureTrainerMark(at) {
    if (!at) { if (trainerMark) trainerMark.visible = false; return; }
    if (!trainerMark) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6),
        new THREE.MeshStandardMaterial({ color: 0x3a3128, roughness: 0.9 }),
      );
      pole.position.y = 1.6;
      g.add(pole);
      const lamp = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.3, 0),
        new THREE.MeshBasicMaterial({ color: 0xffd489 }),
      );
      lamp.position.y = 3.25;
      g.add(lamp);
      const glow = new THREE.PointLight(0xffc879, 1.6, 16, 2);
      glow.position.y = 3.25;
      g.add(glow);
      g.userData.lamp = lamp;
      scene.add(g);
      trainerMark = g;
    }
    trainerMark.visible = true;
    trainerMark.position.set(at.x, terrainHeight(at.x, at.z), at.z);
    // A slow pulse, so it reads as lit rather than as a decal.
    const t = performance.now() / 1000;
    trainerMark.userData.lamp.scale.setScalar(1 + Math.sin(t * 1.7) * 0.12);
  }

  function makeItem() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.34, 0),
      new THREE.MeshStandardMaterial({ color: PALETTE.itemFlare, roughness: 0.5, flatShading: true }),
    );
    body.position.y = 0.5;
    g.add(body);
    const glow = new THREE.PointLight(PALETTE.itemFlare, 0.9, 9, 2);
    glow.position.y = 0.5;
    g.add(glow);
    g.userData = { body, glow };
    scene.add(g);
    return g;
  }

  // A literal tree: brown trunk, green foliage — unmistakably not one of the
  // dark rock-spire obstacles (see PALETTE.treeLeaf's own comment).
  function makeTree() {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.22, 1.6, 6),
      new THREE.MeshStandardMaterial({ color: PALETTE.treeTrunk, roughness: 0.9 }),
    );
    trunk.position.y = 0.8;
    g.add(trunk);
    const leaves = new THREE.Mesh(
      new THREE.ConeGeometry(0.9, 2.1, 7),
      new THREE.MeshStandardMaterial({ color: PALETTE.treeLeaf, roughness: 0.85, flatShading: true }),
    );
    leaves.position.y = 2.3;
    g.add(leaves);
    g.userData = {};
    scene.add(g);
    return g;
  }

  // A small cluster of rock chunks — lighter and more compact than a rock
  // spire, and distinct from the purely decorative ground litter.
  function makeStoneDeposit() {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: PALETTE.stoneDeposit, roughness: 0.8, flatShading: true });
    const offsets = [
      [0, 0, 0, 0.36],
      [0.28, 0.05, -0.1, 0.24],
      [-0.22, 0.02, 0.18, 0.22],
    ];
    for (const [ox, oy, oz, s] of offsets) {
      const chunk = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), mat);
      chunk.position.set(ox, oy + s * 0.6, oz);
      g.add(chunk);
    }
    g.userData = {};
    scene.add(g);
    return g;
  }

  function syncPool(map, list, factory) {
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      let obj = map.get(item.id);
      if (!obj) {
        // The ITEM is passed so a factory can vary by whose it is. makeFigure
        // needs it to pick a build per roster slot; the others ignore it.
        obj = factory(item);
        map.set(item.id, obj);
      }
      obj.visible = true;
      obj.userData.item = item;
    }
    for (const [id, obj] of map) if (!seen.has(id)) obj.visible = false;
    return map;
  }

  const tmpColor = new THREE.Color();
  let elapsed = 0;

  /**
   * Draw the basin as ONE mind perceives it.
   *
   * `opts.eye` is the character whose head the camera sits in (defaults to the
   * lead, so single-player callers are unchanged). `opts.viewport` is a
   * {x,y,w,h} rect in device pixels for couch co-op split-screen; omitted, the
   * whole canvas is used.
   *
   * Couch co-op calls this once PER PLAYER per frame, with that player's own
   * percept — which is the whole reason the two halves of the screen can
   * legitimately disagree about what is in the basin. Pass dt only on the
   * first call of a frame: `elapsed` is shared scene-animation time, and
   * advancing it once per viewport would run the world at 2x for two players.
   */
  function update(percept, dt, view, opts = {}) {
    elapsed += dt;
    const eye = opts.eye || sim.player;
    const vp = opts.viewport || null;
    const dis = distortion(percept, sim);

    if (vp) {
      renderer.setScissorTest(true);
      renderer.setViewport(vp.x, vp.y, vp.w, vp.h);
      renderer.setScissor(vp.x, vp.y, vp.w, vp.h);
      camera.aspect = vp.w / vp.h || 1;
    } else {
      renderer.setScissorTest(false);
      const w = canvas.width, h = canvas.height;
      renderer.setViewport(0, 0, w, h);
      camera.aspect = (canvas.clientWidth || w) / (canvas.clientHeight || h) || 1;
    }

    // ---- camera ----
    const px = eye.x;
    const pz = eye.z;
    rig.position.set(px, terrainHeight(px, pz) + EYE_HEIGHT, pz);
    rig.rotation.y = view.yaw;
    camera.rotation.x = view.pitch;
    // Sway and roll scale with distortion: the lead's own tell, before anything
    // in the world has visibly changed.
    camera.rotation.z = Math.sin(percept.swayPhase * 1.7) * 0.045 * dis;
    camera.position.y = Math.sin(percept.swayPhase * 2.3) * 0.06 * dis;
    // Derived from the CURRENT aspect every frame, so a resize or a co-op
    // split (which halves each viewport's aspect) re-derives instead of
    // inheriting a lens shaped for a different window. The hallucination's
    // breathing rides on top as a delta.
    camera.fov = verticalFov(camera.aspect, hfov) + Math.sin(percept.swayPhase * 0.9) * 5 * dis;
    camera.updateProjectionMatrix();

    // ---- fog / colour drift ----
    // PER FRAME, from the basin palette — which silently undid the camp's
    // daylight every single frame. Setting the fog once at build time was not
    // enough; anything set at build must also be respected here or it lasts
    // exactly one frame. The camp still drifts as the lead goes, just from its
    // own colours and its own baseline density.
    const baseFog = isCamp ? 0x8fa2b4 : PALETTE.fog;
    const baseDensity = isCamp ? 0.006 : 0.014;
    tmpColor.set(baseFog).lerp(new THREE.Color(PALETTE.fogLost), dis);
    scene.fog.color.copy(tmpColor);
    scene.background = tmpColor;
    scene.fog.density = baseDensity + dis * 0.018; // it closes in as the lead goes
    lamp.intensity = 1.9 - dis * 0.6;

    // ---- markers ----
    syncPool(pool.monoliths, perceivedMonoliths(percept, sim), makeMonolith);
    for (const obj of pool.monoliths.values()) {
      if (!obj.visible) continue;
      const m = obj.userData.item;
      obj.position.set(m.x, terrainHeight(m.x, m.z), m.z);
      obj.userData.cap.visible = !!m.logged;
      obj.userData.body.material.color.set(m.logged ? PALETTE.monolithLogged : PALETTE.monolith);
    }

    // ---- pylons ----
    syncPool(pool.pylons, perceivedPylons(percept, sim), makePylon);
    for (const obj of pool.pylons.values()) {
      if (!obj.visible) continue;
      const p = obj.userData.item;
      obj.position.set(p.x, terrainHeight(p.x, p.z), p.z);
      // NOTE: `looksLive` — not `charge > 0`. A spent pylon can read as full to a
      // hallucinating lead, and that lie has to survive all the way to the pixel.
      const live = p.looksLive;
      const frac = p.spent ? 0 : 1; // one-shot: a pylon is lit or it is out
      const shown = live ? Math.max(0.25, frac) : 0;
      obj.userData.core.material.color.set(live ? PALETTE.pylonLive : PALETTE.pylonDead);
      obj.userData.core.scale.setScalar(0.7 + shown * 0.5 + Math.sin(elapsed * 2 + p.x) * 0.04);
      obj.userData.glow.intensity = live ? 0.5 + shown * 1.4 : 0.05;
      obj.userData.ring.material.opacity = live ? 0.12 + shown * 0.22 : 0.05;
      obj.userData.ring.material.color.set(live ? PALETTE.pylonLive : PALETTE.pylonDead);
    }

    // ---- ground items — kind SHOWN can be a lie, but the mesh itself never is:
    // a phantom pickup has no world object at all (see perceivedWorldItems) ----
    syncPool(pool.items, perceivedWorldItems(percept, sim), makeItem);
    for (const obj of pool.items.values()) {
      if (!obj.visible) continue;
      const it = obj.userData.item;
      const bob = 0.5 + Math.sin(elapsed * 2.4 + it.x + it.z) * 0.06;
      obj.position.set(it.x, terrainHeight(it.x, it.z) + bob, it.z);
      const color = ITEM_COLOR[it.shownKind] || PALETTE.itemFlare;
      obj.userData.body.material.color.set(color);
      obj.userData.glow.color.set(color);
    }

    // ---- trees and stone deposits — read straight from the sim, not
    // perception: neither one is ever a lie (see state.js's own comment on
    // RESOURCE_SIGHT_RANGE), so there is nothing here for percept.js to filter ----
    syncPool(pool.trees, sim.trees.filter((t) => t.discovered && !t.chopped), makeTree);
    for (const obj of pool.trees.values()) {
      if (!obj.visible) continue;
      const t = obj.userData.item;
      obj.position.set(t.x, terrainHeight(t.x, t.z), t.z);
    }
    syncPool(pool.stones, sim.stones.filter((s) => s.discovered && !s.mined), makeStoneDeposit);
    for (const obj of pool.stones.values()) {
      if (!obj.visible) continue;
      const s = obj.userData.item;
      obj.position.set(s.x, terrainHeight(s.x, s.z), s.z);
    }

    // The trainer's lantern. Camp only — `sim.trainer` exists nowhere else.
    ensureTrainerMark(sim.trainer && !sim.reachedTrainer ? sim.trainer : null);

    // ---- companions (real and otherwise) ----
    syncPool(pool.figures, perceivedCompanions(percept, sim), makeFigure);
    for (const obj of pool.figures.values()) {
      if (!obj.visible) continue;
      const c = obj.userData.item;
      const moved = Math.hypot(c.x - obj.userData.lastX, c.z - obj.userData.lastZ);
      obj.userData.lastX = c.x;
      obj.userData.lastZ = c.z;
      obj.userData.bob += moved * 2.6;
      obj.position.set(c.x, terrainHeight(c.x, c.z) + Math.abs(Math.sin(obj.userData.bob)) * 0.07, c.z);
      // A companion who is with you looks at you. One who has gone does not —
      // they are drawn on their own heading, walking at something you can't
      // see. That difference is legible at a distance where the body colour
      // has already fogged out, and it is the only tell that survives the
      // whole length of an episode.
      const dx = px - c.x;
      const dz = pz - c.z;
      obj.rotation.y = c.hallucinating && !c.phantom ? c.facing || 0 : Math.atan2(dx, dz);
      if (c.monstrous) {
        // A lie about identity, not position — the figure keeps its real
        // spot and facing, only reads wrong for a beat. Wrong proportions
        // (looms taller and wider) rather than just a new colour, so it
        // reads as "not them" at a glance, not merely "them, but red."
        obj.scale.set(1.15, 1.6, 1.1);
        obj.userData.mat.color.set(PALETTE.monster);
        obj.userData.light.material.color.set(PALETTE.monsterEye);
      } else {
        obj.scale.set(1, 1, 1);
        obj.userData.mat.color.set(c.hallucinating ? PALETTE.bodyLost : PALETTE.body);
        obj.userData.light.material.color.set(c.hallucinating ? 0xff8a94 : 0xffd9a0);
      }
    }

    renderer.render(scene, camera);
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    // Re-apply the pixel ratio EVERY resize, not once at construction. It is
    // not a property of the machine: it changes when the user alters Windows
    // display scaling, when they zoom the browser, and when the window is
    // dragged to a monitor with a different DPI. Set once, it goes stale, and
    // `setSize(w, h, false)` then allocates a drawing buffer at the wrong
    // resolution for the CSS box it is stretched across.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h || 1;
    camera.fov = verticalFov(camera.aspect, hfov);
    camera.updateProjectionMatrix();
  }

  /**
   * Project a world point to CSS pixel coordinates against the canvas's own
   * bounding rect, for HUD elements (fixed-position DOM, not WebGL) that need
   * to line up with something in the 3D scene — e.g. a collected-resource fly
   * animation starting where the tree/deposit actually stood. `visible` is
   * false once the point is behind the camera, where the projected x/y are
   * meaningless (they'd otherwise mirror to the wrong side of the screen).
   */
  function worldToScreen(x, y, z, vp = null) {
    const v = new THREE.Vector3(x, y, z).project(camera);
    const rect = canvas.getBoundingClientRect();
    // In split-screen the camera was last set up for ONE viewport, so the NDC
    // it produces maps into that viewport's slice of the canvas, not the whole
    // thing. `vp` is in device pixels (what Three wants); the DOM overlay is in
    // CSS pixels, hence the ratio. Its y-origin is bottom-left, the DOM's is
    // top-left, so the flip below is not the same flip as the NDC one.
    let left = rect.left, top = rect.top, width = rect.width, height = rect.height;
    if (vp) {
      const sx = rect.width / (canvas.width || rect.width);
      const sy = rect.height / (canvas.height || rect.height);
      left = rect.left + vp.x * sx;
      top = rect.top + (canvas.height - vp.y - vp.h) * sy;
      width = vp.w * sx;
      height = vp.h * sy;
    }
    return {
      x: left + (v.x * 0.5 + 0.5) * width,
      y: top + (-v.y * 0.5 + 0.5) * height,
      visible: v.z < 1,
    };
  }
  window.addEventListener("resize", resize);

  // A system-zoom change does NOT always fire `resize` — the CSS viewport can
  // keep the same dimensions while devicePixelRatio moves under it (dragging
  // the window to a monitor with different scaling is the clearest case). The
  // only reliable notification is a resolution media query, which has to be
  // re-armed after every change because it matches one exact ratio. Without
  // this the buffer resolution silently goes stale mid-session.
  let dprQuery = null;
  const onDprChange = () => {
    armDprWatch();
    resize();
  };
  function armDprWatch() {
    if (typeof window.matchMedia !== "function") return;
    if (dprQuery) dprQuery.removeEventListener?.("change", onDprChange);
    dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprQuery.addEventListener?.("change", onDprChange);
  }
  armDprWatch();
  resize();

  /**
   * Tear this renderer down. Needed once a run can outlive a single world — a
   * campaign's next basin is entirely new geometry (terrain, rock instancing,
   * monolith/pylon/item meshes), so advancing a level builds a fresh
   * createRenderer() rather than repointing this one, and the old one must
   * free its GPU resources instead of leaking them.
   */
  function dispose() {
    window.removeEventListener("resize", resize);
    dprQuery?.removeEventListener?.("change", onDprChange);
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
      for (const m of mats) m.dispose();
    });
    renderer.dispose();
  }

  /** Set the horizontal field of view in degrees; clamped to a sane band. */
  function setFov(deg) {
    hfov = Math.max(70, Math.min(110, Number(deg) || DEFAULT_HFOV));
    camera.fov = verticalFov(camera.aspect, hfov);
    camera.updateProjectionMatrix();
    return hfov;
  }

  return { renderer, scene, camera, rig, update, resize, dispose, terrainHeight, worldToScreen, setFov, get hfov() { return hfov; }, PALETTE };
}
