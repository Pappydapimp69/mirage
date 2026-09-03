// Sandbox: chain cohesion (you are "with the group" if within R of ANYONE in
// it) has properties that proximity-to-leader does not, and they are not
// obvious from the rule.
//
// Claims under test:
//   A. Connectivity is not proximity. The furthest a CONNECTED member can be
//      from the leader is (N-1)*R, so it grows LINEARLY with party size —
//      adding a member makes the existing crew able to be further away.
//   B. Therefore recruiting has a cost nobody asks for: a sixth body silently
//      widens the group's legal diameter by one whole link.
//   C. A hallucinated member counts as a link to the mind that sees it, so a
//      phantom extends reach by a link the real party does not have — and
//      more sharply, it can hold a chain that is REALLY in two pieces.
//   D. Fragmentation under losses is a percolation curve, not linear: losing
//      members from a line breaks it catastrophically at the middle and barely
//      at the ends, so "how many are still with me" depends on WHICH.
//
// Deterministic: fixed layouts, no rng, no wall-clock.

const R = 20;

function groupWith(members, leadId) {
  const parent = new Map(members.map((m) => [m.id, m.id]));
  const find = (a) => { while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a); } return a; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (let i = 0; i < members.length; i++)
    for (let j = i + 1; j < members.length; j++)
      if (Math.hypot(members[i].x - members[j].x, members[i].z - members[j].z) <= R) union(members[i].id, members[j].id);
  if (!parent.has(leadId)) return new Set();
  const root = find(leadId);
  return new Set(members.filter((m) => find(m.id) === root).map((m) => m.id));
}

// A: a maximally-stretched line of N, each exactly R from the next.
console.log("A. max reach of a CONNECTED member, as party size grows");
for (const N of [2, 3, 4, 5, 6, 7, 8]) {
  const line = Array.from({ length: N }, (_, i) => ({ id: `m${i}`, x: i * R, z: 0 }));
  const g = groupWith(line, "m0");
  const far = Math.max(...line.filter((m) => g.has(m.id)).map((m) => m.x));
  console.log(`   N=${N}  all connected: ${g.size === N}  furthest connected member: ${far}m  (= (N-1)*R = ${(N - 1) * R})`);
}

// B: the recruiting cost, stated as a delta.
console.log("\nB. what one extra body buys the EXISTING crew");
for (const N of [5, 6]) {
  console.log(`   party of ${N}: legal diameter ${(N - 1) * R}m`);
}
console.log(`   recruiting one member widens the group's legal spread by ${R}m without anyone moving`);

// C: the phantom as a load-bearing link.
console.log("\nC. a phantom link vs the real chain");
const gap = R * 1.8;
const real = [{ id: "you", x: 0, z: 0 }, { id: "c1", x: gap, z: 0 }];
const believed = [...real, { id: "ph", x: gap / 2, z: 0 }];
console.log(`   real party, ${gap}m apart:      connected = ${groupWith(real, "you").size}/2`);
console.log(`   with a phantom between them:   connected = ${groupWith(believed, "you").size}/3  <- the lead believes the group is whole`);
// Sharper: a phantom holding TWO real halves together.
// Every hop must be <= R or the phantom bridges nothing — the first version of
// this fixture spaced the halves 2.3R apart and proved only that I cannot do
// arithmetic. Halves at {0, R} and {3R, 4R}; the phantom at 2R closes both hops.
const split = [
  { id: "you", x: 0, z: 0 }, { id: "a", x: R, z: 0 },
  { id: "b", x: R * 3, z: 0 }, { id: "c", x: R * 4, z: 0 },
];
const withPh = [...split, { id: "ph", x: R * 2, z: 0 }];
console.log(`   two real halves:               connected = ${groupWith(split, "you").size}/4`);
console.log(`   one phantom bridging them:     connected = ${groupWith(withPh, "you").size}/5  <- a 2-piece party reads as whole`);

// D: fragmentation depends on WHICH member is lost, not how many.
console.log("\nD. losing ONE member from a 6-line, by position");
const six = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, x: i * R, z: 0 }));
for (let drop = 1; drop < 6; drop++) {
  const remaining = six.filter((m) => m.id !== `m${drop}`);
  const g = groupWith(remaining, "m0");
  console.log(`   drop m${drop} (${drop === 5 ? "tail" : drop === 1 ? "next to lead" : "middle"})  still with the lead: ${g.size}/${remaining.length}`);
}
