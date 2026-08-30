#!/usr/bin/env bash
# Run the full MIRAGE test suite. Exits non-zero on any failure.
#
# The smoke test needs Playwright + Chromium. If they are absent it is SKIPPED
# with a loud note rather than silently passing — a suite that quietly stops
# testing the 3D layer is worse than one that fails.
set -e
cd "$(dirname "$0")/.."

echo "== logic =="
node tests/logic.test.mjs
echo

echo "== save/resume (pure) =="
node tests/save.test.mjs
echo

echo "== hallucination (does the player actually SEE the tells?) =="
node tests/hallucination.test.mjs
echo

echo "== kinds (the four that used to be static) =="
node tests/kinds.test.mjs
echo

echo "== camp (the one authored map earns its guarantees) =="
node tests/camp.mjs
echo

echo "== cohesion (the call, the chain, the ping) =="
node tests/cohesion.mjs
echo

echo "== tutorial (step pinning, starvation, meter leaks) =="
node tests/tutorial.mjs
echo

echo "== stress (invariants, hostile input, save/restore lockstep) =="
node tests/stress.mjs "${STRESS_SEEDS:-16}"
echo

echo "== formation (is the party ever actually in frame?) =="
node tests/formation.mjs "${FORMATION_SEEDS:-6}"
echo

if [ -d /opt/pw-browsers ] && node -e 'require("/opt/node22/lib/node_modules/playwright")' 2>/dev/null; then
  echo "== smoke (real browser) =="
  node tests/smoke.mjs
  echo
  echo "== gamepad (real browser, fake pad) =="
  node tests/gamepad.mjs
  echo
  echo "== coop (real browser, split-screen) =="
  node tests/coop.mjs
  echo
  echo "== resume (real browser, save slot) =="
  node tests/resume.mjs
  echo
  echo "== menu nav (real browser, changing menu shape) =="
  node tests/menu-nav.mjs
  echo
  echo "== campaign (real browser, basin -> basin + save) =="
  node tests/campaign.mjs
  echo
  echo "== settings (real browser, preferences across a reload) =="
  node tests/settings.mjs
  echo
  echo "== field of view (real browser, aspect independence) =="
  node tests/fov.mjs
  echo
  echo "== display scaling (real browser, 100/125/150% OS zoom) =="
  node tests/dpi.mjs
  echo
  echo "== tutorial play (real browser, stages start and steps fire) =="
  node tests/tutorial-play.mjs
else
  echo "== smoke + gamepad: SKIPPED — Playwright/Chromium not available here =="
  echo "   (the 3D layer was NOT exercised in this run)"
fi
echo

# BALANCE RUNS LAST, AND DOES NOT BLOCK WHAT FOLLOWS IT.
#
# `set -e` plus a known-red test in the middle of the file meant the entire
# browser tier below it never ran — one long-standing difficulty question was
# silently switching off the 3D layer and the tutorial playthrough for anyone
# running the suite. The `deceived` row is a difficulty DECISION, not a defect,
# so it is reported loudly at the end and its status carried rather than
# short-circuiting everything after it.
echo "== balance (whole runs to a terminal state) =="
set +e
node tests/balance.mjs "${BALANCE_SEEDS:-12}"
BALANCE=$?
set -e
echo

if [ "$BALANCE" -ne 0 ]; then
  echo "ALL MIRAGE TESTS PASSED — except balance, the known open difficulty question"
  exit 1
fi

echo "ALL MIRAGE TESTS PASSED"
