// verify-deploy.mjs — check what the LIVE site actually serves, not what the
// repo contains.
//
// This exists because three consecutive correct fixes were shipped and none of
// them reached the player. Each was verified by `curl`ing the changed module
// and finding the new code in it — which proves nothing, because the entry
// module the browser executes pins its OWN url for that import. If main.js
// still says `./percept.js?v=OLD`, then percept.js?v=NEW is a file nobody
// requests.
//
// So this fetches index.html, follows the entry module, and asserts:
//   1. index.html's script/link tokens match main.js's BUILD constant
//   2. every relative import inside every reachable module carries that token
//   3. exactly one token is live across the whole graph (a partial stamp loads
//      a module twice under two urls, as two module instances)
//
// Usage: node tools/verify-deploy.mjs [baseUrl]
//   defaults to the project's GitHub Pages url.

const BASE = (process.argv[2] || "https://pappydapimp69.github.io/mirage/").replace(/\/?$/, "/");

const problems = [];
const note = (m) => problems.push(m);

async function get(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

const IMPORT_RE = /from\s+"(\.\/[^"]+)"/g;
// Any project's token, not one hard-coded prefix — and an EMPTY token set is a
// failure rather than a pass. A hard-coded prefix silently matches nothing the
// moment the project is renamed or forked, and the tool then prints "OK — every
// module carries the current token" over a graph in which it checked none. A
// verifier that cannot fail is worse than no verifier, because it is believed.
const TOKEN_RE = /\?v=([a-z]+-[\d.]+)/g;

(async () => {
  console.log(`checking ${BASE}`);

  const html = await get(BASE + "index.html");
  const scriptSrc = html.match(/src="(src\/main\.js[^"]*)"/)?.[1];
  if (!scriptSrc) {
    note("index.html has no <script src=\"src/main.js…\"> — cannot follow the entry module");
    console.log(problems.join("\n"));
    process.exit(1);
  }

  const mainText = await get(BASE + scriptSrc);
  const build = mainText.match(/const BUILD = "([^"]+)"/)?.[1];
  if (!build) note("main.js has no BUILD constant");
  console.log(`  entry: ${scriptSrc}`);
  console.log(`  BUILD: ${build}`);

  // index.html's own references must carry BUILD.
  for (const asset of ["css/style.css", "src/main.js"]) {
    if (!html.includes(`${asset}?v=${build}`)) {
      note(`index.html references ${asset} without ?v=${build} — returning visitors get it from cache`);
    }
  }

  // Walk the module graph from the entry, following the EXACT urls the browser
  // would follow — the whole point is to see a stale pin if there is one.
  const tokens = new Set();
  for (const [, t] of html.matchAll(TOKEN_RE)) tokens.add(t);

  const seen = new Set();
  const queue = [scriptSrc];
  let modules = 0;

  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    let text;
    try {
      text = rel === scriptSrc ? mainText : await get(BASE + rel);
    } catch (e) {
      note(`could not fetch ${rel} — ${e.message}`);
      continue;
    }
    modules++;
    for (const [, t] of text.matchAll(TOKEN_RE)) tokens.add(t);
    for (const [, spec] of text.matchAll(IMPORT_RE)) {
      if (!spec.includes(`?v=${build}`)) {
        note(`${rel} imports "${spec}" without ?v=${build} — the browser will serve it from cache`);
      }
      // Resolve "./x.js?v=…" relative to src/ and keep the query, because that
      // is literally the url the browser requests.
      queue.push("src/" + spec.replace(/^\.\//, ""));
    }
  }

  if (tokens.size === 0) {
    note("no cache-bust token appears anywhere in the live module graph — nothing was actually checked");
  }
  if (tokens.size > 1) {
    note(`more than one cache-bust token is live (${[...tokens].join(", ")}) — a partial stamp loads a module twice as two instances`);
  }

  console.log(`  modules walked: ${modules}`);
  console.log(`  tokens live: ${[...tokens].join(", ") || "(none)"}`);

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log("  ✗ " + p);
    process.exit(1);
  }
  console.log("\ndeploy verify: OK — every module the browser loads carries the current token");
})().catch((e) => {
  console.error("VERIFY CRASHED:", e.message);
  process.exit(1);
});
