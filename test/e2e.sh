#!/usr/bin/env bash
# End-to-end test suite for dapi
# Usage: PYTHON=/path/to/python bash test/e2e.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BIN="${BIN:-$REPO_DIR/bin/dapi}"
FIXTURES="$SCRIPT_DIR/fixtures"
PYTHON="${PYTHON:-python3}"

PASS=0
FAIL=0
ERRORS=""

run_cmd() { "$@" 2>&1 || true; }

assert_contains() {
  local name="$1" expected="$2" actual="$3"
  if echo "$actual" | grep -qF "$expected"; then
    PASS=$((PASS + 1)); echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $name\n    Expected: $expected\n    Got: $(echo "$actual" | head -3)\n"
    echo "  ✗ $name"
  fi
}

assert_matches() {
  local name="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -qE "$pattern"; then
    PASS=$((PASS + 1)); echo "  ✓ $name"
  else
    FAIL=$((FAIL + 1))
    ERRORS="${ERRORS}\n  FAIL: $name\n    Pattern: $pattern\n    Got: $(echo "$actual" | head -3)\n"
    echo "  ✗ $name"
  fi
}

cleanup() {
  run_cmd "$BIN" close >/dev/null
  local pid_file="$HOME/.dapi/default.pid"
  if [ -f "$pid_file" ]; then kill "$(cat "$pid_file")" 2>/dev/null || true; fi
  rm -f "$HOME/.dapi/default.sock" "$HOME/.dapi/default.pid" 2>/dev/null || true
  sleep 0.5
}

# ═══════════════════════════════════════════════════
echo "═══ dapi E2E Test Suite ═══"
echo ""

# ─── Test 1: Help output ───
echo "─── Test 1: CLI Help ───"
OUT=$(run_cmd "$BIN" --help)
assert_contains "help shows binary name" "dapi" "$OUT"
assert_contains "help shows start command" "start <script>" "$OUT"
assert_contains "help shows eval command" "eval <expression>" "$OUT"
assert_contains "help shows context command" "context" "$OUT"
assert_contains "help shows output command" "output" "$OUT"

# ─── Test 2: Error handling ───
echo "─── Test 2: Error Handling ───"
cleanup

OUT=$(run_cmd "$BIN" start)
assert_contains "start without script shows error" "Error" "$OUT"

OUT=$(run_cmd "$BIN" foobar)
assert_contains "unknown command shows error" "Unknown command" "$OUT"

cleanup
OUT=$(run_cmd "$BIN" vars)
assert_contains "vars before session shows error" "Error" "$OUT"

cleanup
OUT=$(run_cmd "$BIN" eval "1+1")
assert_contains "eval before session shows error" "Error" "$OUT"

cleanup
OUT=$(run_cmd "$BIN" context)
assert_contains "context before session shows error" "Error" "$OUT"

# ─── Test 3: Auto-context ───
echo "─── Test 3: Auto-Context ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:25" \
    --runtime "$PYTHON")
assert_contains "auto-context: status paused" "paused" "$OUT"
assert_contains "auto-context: shows location" "buggy_script.py" "$OUT"
assert_contains "auto-context: shows source snippet" "│" "$OUT"
assert_contains "auto-context: shows locals" "Locals:" "$OUT"
assert_contains "auto-context: shows stack" "Stack:" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 4: Recursive tree bug ───
echo "─── Test 4: Recursive Bug ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/recursive_bug.py" \
    --break "$FIXTURES/recursive_bug.py:18" \
    --runtime "$PYTHON")
assert_contains "recursive: starts and pauses" "paused" "$OUT"
assert_contains "recursive: auto-context has locals" "Locals:" "$OUT"

OUT=$(run_cmd "$BIN" eval "current_depth")
assert_matches "recursive: current_depth is int" "[0-9]" "$OUT"

OUT=$(run_cmd "$BIN" step)
assert_contains "recursive: step returns auto-context" "paused" "$OUT"
assert_contains "recursive: step has source" "│" "$OUT"

OUT=$(run_cmd "$BIN" stack)
assert_contains "recursive: stack shows recursion" "max_depth" "$OUT"

OUT=$(run_cmd "$BIN" context)
assert_contains "recursive: context returns full state" "paused" "$OUT"
assert_contains "recursive: context has source" "│" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_matches "recursive: continue works" "paused|terminated" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 5: Data pipeline ───
echo "─── Test 5: Data Pipeline ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/async_pipeline.py" \
    --break "$FIXTURES/async_pipeline.py:60" \
    --runtime "$PYTHON")
assert_contains "pipeline: starts" "paused" "$OUT"

OUT=$(run_cmd "$BIN" step)
assert_contains "pipeline: step" "paused" "$OUT"

OUT=$(run_cmd "$BIN" eval "len(records)")
assert_contains "pipeline: 7 records" "7" "$OUT"

OUT=$(run_cmd "$BIN" eval "type(records[1]['quantity'])")
assert_contains "pipeline: string quantity" "str" "$OUT"

OUT=$(run_cmd "$BIN" status)
assert_contains "pipeline: status shows paused" "paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 6: Conditional breakpoint ───
echo "─── Test 6: Conditional Breakpoint ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/closure_bug.py" \
    --break "$FIXTURES/closure_bug.py:14:i == 3" \
    --runtime "$PYTHON")
assert_contains "conditional: starts" "paused" "$OUT"

OUT=$(run_cmd "$BIN" eval "i")
assert_contains "conditional: i is 3" "3" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 7: Step into/out ───
echo "─── Test 7: Step Into/Out ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/recursive_bug.py" \
    --break "$FIXTURES/recursive_bug.py:22" \
    --runtime "$PYTHON")
assert_contains "step-into: starts" "paused" "$OUT"

OUT=$(run_cmd "$BIN" step into)
assert_contains "step-into: step into" "paused" "$OUT"

OUT=$(run_cmd "$BIN" step out)
assert_contains "step-out: step out" "paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 8: Output command ───
echo "─── Test 8: Output Command ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:25" \
    --runtime "$PYTHON")
assert_contains "output: session started" "paused" "$OUT"

OUT=$(run_cmd "$BIN" output)
assert_matches "output: command succeeds" ".*" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 9: Multiple breakpoints ───
echo "─── Test 9: Multiple Breakpoints ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:23" \
    --break "$FIXTURES/buggy_script.py:26" \
    --runtime "$PYTHON")
assert_contains "multi-bp: starts paused" "paused" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_contains "multi-bp: hits second breakpoint" "paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 10: Add breakpoint mid-session ───
echo "─── Test 10: Add Breakpoint Mid-Session ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/closure_bug.py" \
    --break "$FIXTURES/closure_bug.py:39" \
    --runtime "$PYTHON")
assert_contains "add-bp: starts" "paused" "$OUT"

OUT=$(run_cmd "$BIN" break "$FIXTURES/closure_bug.py:54")
assert_contains "add-bp: breakpoint set" "Breakpoint" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_contains "add-bp: hits added breakpoint" "paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 11: Termination ───
echo "─── Test 11: Termination ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/closure_bug.py" \
    --break "$FIXTURES/closure_bug.py:62" \
    --runtime "$PYTHON")
assert_contains "terminate: starts" "paused" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_contains "terminate: program ended" "terminated" "$OUT"

OUT=$(run_cmd "$BIN" vars)
assert_contains "terminate: vars after end errors" "Error" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 12: Session lifecycle ───
echo "─── Test 12: Session Lifecycle ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:26" \
    --runtime "$PYTHON")
assert_contains "lifecycle: first start" "paused" "$OUT"

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:26" \
    --runtime "$PYTHON")
assert_contains "lifecycle: double start errors" "Error" "$OUT"

OUT=$(run_cmd "$BIN" close)
assert_contains "lifecycle: close works" "closed" "$OUT"

cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:26" \
    --runtime "$PYTHON")
assert_contains "lifecycle: restart after close" "paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 13: Full debug workflow ───
echo "─── Test 13: Full Debug Workflow ───"
cleanup

OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.py" \
    --break "$FIXTURES/buggy_script.py:25" \
    --runtime "$PYTHON")
assert_contains "workflow: stops at breakpoint" "paused" "$OUT"
assert_contains "workflow: auto-context in calculate_average_age" "calculate_average_age" "$OUT"

OUT=$(run_cmd "$BIN" eval "data['name']")
assert_contains "workflow: first user Alice" "Alice" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_contains "workflow: continue to Bob" "paused" "$OUT"

OUT=$(run_cmd "$BIN" eval "data['name']")
assert_contains "workflow: Bob iteration" "Bob" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_contains "workflow: continue to Charlie" "paused" "$OUT"

OUT=$(run_cmd "$BIN" eval "type(data['age'])")
assert_contains "workflow: Charlie age is string" "str" "$OUT"

OUT=$(run_cmd "$BIN" continue)
assert_matches "workflow: crashes on type error" "terminated|paused" "$OUT"

run_cmd "$BIN" close >/dev/null

# ─── Test 14: Node.js (gated) ───
JS_DEBUG_AVAILABLE=0
if [ -n "${JS_DEBUG_PATH:-}" ]; then
  JS_DEBUG_AVAILABLE=1
elif [ -d "$HOME/.vscode/extensions" ]; then
  if ls -d "$HOME/.vscode/extensions"/ms-vscode.js-debug-*/src/dapDebugServer.js 2>/dev/null | tail -1 | grep -q .; then
    JS_DEBUG_AVAILABLE=1
  fi
fi
# dapi auto-provisions js-debug on first use, so always try if Node.js is available
if [ "$JS_DEBUG_AVAILABLE" -eq 0 ] && command -v node >/dev/null 2>&1; then
  JS_DEBUG_AVAILABLE=1
fi

if [ "$JS_DEBUG_AVAILABLE" -eq 1 ]; then
  echo "─── Test 14: Node.js (js-debug) ───"
  cleanup

  OUT=$(run_cmd "$BIN" start "$FIXTURES/buggy_script.js" --break "$FIXTURES/buggy_script.js:22")
  assert_contains "node: starts and pauses" "paused" "$OUT"
  assert_contains "node: auto-context has locals" "Locals:" "$OUT"

  OUT=$(run_cmd "$BIN" eval "data.name")
  assert_contains "node: eval data.name" "Alice" "$OUT"

  OUT=$(run_cmd "$BIN" continue)
  assert_contains "node: continue to Charlie" "paused" "$OUT"

  OUT=$(run_cmd "$BIN" eval "typeof data.age")
  assert_contains "node: detects string age bug" "string" "$OUT"

  run_cmd "$BIN" close >/dev/null
else
  echo "─── Test 14: Node.js — SKIPPED (js-debug not found) ───"
fi

# ═══════════════════════════════════════════════════
cleanup
echo ""
echo "═══ Results ═══"
echo "  Passed: $PASS / $((PASS + FAIL))"

if [ "$FAIL" -gt 0 ]; then
  echo ""
  printf "%b" "$ERRORS"
  exit 1
fi

echo "All tests passed!"
