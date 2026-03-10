---
name: dapi
description: Use when a program crashes, a test fails, or code produces wrong results and reading the source isn't enough to see why. Pauses execution at any line and inspects actual runtime state — variables, types, call stack, live output — to find exactly what went wrong. Can attach to running servers by PID with no restart or code changes needed. Every stop returns full context automatically.
allowed-tools: Bash(npx -y dapi:*), Bash(dapi:*)
---

# dapi — CLI Debugger for AI Agents

Set breakpoints, inspect state, evaluate expressions, test fixes in-place. Attach to running servers by PID — no restart, no code changes. Every stop returns location + source + locals + stack + output in one shot.

## Philosophy

The debugger is a scalpel, not a flashlight. You don't turn it on to look around. You turn it on to make one precise cut — confirm or kill a specific hypothesis about why the program is broken. If you're "exploring" in the debugger, you've already lost.

**Every session starts before the debugger.** Read the code. Read the traceback. Form a theory. Know exactly what breakpoint you'll set and what eval you'll run before you type a single command. The debugger is the experiment, not the investigation.

**`eval` is the only command that matters.** `vars`, `step`, `stack`, `source` — these are all setup. The eval is the actual experiment. It's where you test your hypothesis against reality. Everything else is scaffolding to get you to the right eval at the right moment.

**Half of all bugs don't need a debugger.** Read the traceback. Read the code. Check the types. Grep for the error message. Look at git blame. Most bugs surrender to careful reading. Reach for the debugger only when the bug depends on runtime state you can't determine statically.

## The Rules

1. **Read first, debug second.** Never start a debug session without reading the relevant code and forming a hypothesis. The debugger confirms theories — it doesn't generate them.

2. **One breakpoint, one question.** Each breakpoint should answer a specific question. "Is `x` a string here?" "Is `balance` negative after this call?" "Does this branch execute?" If you can't articulate the question, you're not ready to debug.

3. **Eval, don't dump.** `vars` dumps everything and answers nothing. `eval "type(data['age'])"` answers exactly one question. Prefer eval. Always.

4. **Never step through loops.** A loop with 100 iterations is 100 step commands. A conditional breakpoint is 1 command. Use `--break "file:line:i == 50"` to jump straight to the iteration that matters.

5. **Two strikes, new theory.** If your hypothesis was wrong twice, stop. Your mental model of the code is broken, not the debugger session. Close, re-read the code, form a completely different theory, then start a new session with different breakpoints. Continuing to probe the same area has exponentially diminishing returns.

6. **Test the fix before writing it.** The debugger gives you a live REPL in the exact context of the bug. Use `eval` to run your proposed fix expression before editing any code. If it works in eval, it'll work in the code.

7. **Prove the fix, write the test.** After fixing, re-run the program to verify. Then write the smallest possible test that catches the bug. A fix without a test is a fix that will regress.

8. **Close the session.** Always. A stale session blocks the next one.

## Bootstrap

```bash
# Zero-install (recommended):
npx -y dapi start app.py --break app.py:42

# Or install globally:
npm install -g dapi
dapi start app.py --break app.py:42
```

Requires Node.js >= 18 (or bun).

## Commands

```bash
# Start a session
dapi start <script> --break file:line[:condition] [--runtime path] [--break-on-exception filter] [--args ...]

# Attach to a running process
dapi attach --pid <PID> [--break file:line]     # Inject debugger — no restart needed
dapi attach [host:]port [--break file:line]     # Connect to existing debug server

# Execution (each returns auto-context automatically)
dapi step [over|into|out]      # Step; default: over
dapi continue                  # Run to next breakpoint
dapi context                   # Re-fetch context without stepping

# Inspection
dapi eval <expression>         # Evaluate in current frame (the main tool)
dapi vars                      # List local variables
dapi stack                     # Show call stack
dapi output                    # Drain buffered stdout/stderr since last stop
dapi source [file] [line]      # Show source around current line
dapi status                    # Show session state

# Breakpoints
dapi break file:line[:cond]    # Add breakpoint mid-session

# Session
dapi close                     # End debug session

# Multi-session (for parallel debugging)
dapi --session <name> start ...
dapi --session <name> continue
```

Multiple `--break` flags supported. Conditions are expressions: `--break "app.py:42:len(items) > 10"`.

## Auto-Context

Every execution command (`start`, `step`, `continue`, `context`) returns full context automatically:

```
Stopped at compute() · app.py:41 [breakpoint]

    37 │ def compute(items):
    38 │     result = None
    39 │     for item in items:
    40 │         result += item
→   41 │     return result

Locals:
  items = [1, 2, 3]  (list)
  result = None  (NoneType)

Stack:
  compute [app.py:41]
  main [app.py:10]

Output:
  Processing batch...
```

No separate `vars`, `stack`, `source` calls needed unless you want them.

## Supported Languages

| Language | Extension | Adapter | Requirement |
|----------|-----------|---------|-------------|
| Python | .py | debugpy | Auto-installed on `attach --pid`. Or: `pip install debugpy` |
| JavaScript/TypeScript | .js/.ts | js-debug | Node.js (auto-installed on first use) |
| Go | .go | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust/C/C++ | .rs/.c/.cpp | CodeLLDB | `CODELLDB_PATH` env var |

## The Playbook

### Start vs Attach — Choose First

- **The process is already running** (server, daemon, worker) → `attach --pid`. Always. Don't restart it.
- **You need to run a script from scratch** → `start <script>`.

```bash
# Running server? Attach.
ps aux | grep uvicorn
dapi attach --pid 12345 --break routes.py:42
curl localhost:8000/api/endpoint   # trigger the breakpoint
dapi continue                      # wait for hit — auto-context returned
dapi eval "request.body"
dapi close                         # detaches without killing the server

# Script? Start.
dapi start app.py --break "app.py:25"
# → auto-context returned immediately at the breakpoint
```

### Type Bugs

```bash
dapi start app.py --break "app.py:25"
# Auto-context shows locals already. Then confirm:
dapi eval "type(data['age'])"    # <class 'str'> — found it
dapi eval "int(data['age'])"     # 35 — fix is safe
dapi close
```

### Data Pipeline Bugs

```bash
dapi start etl.py --break "etl.py:90"
dapi eval "all(isinstance(v, int) for v in result.values())"              # False
dapi eval "[k for k,v in result.items() if not isinstance(v, int)]"       # ['quantity']
dapi close
```

### Loop Bugs (Wolf Fence)

```bash
dapi start app.py --break "app.py:45:i == 500"    # midpoint
dapi eval "is_valid(result)"                       # True → bug after 500
dapi close

dapi start app.py --break "app.py:45:i == 750"    # narrow
dapi eval "is_valid(result)"                       # False → bug between 500-750
dapi close
```

~10 iterations to find the bug in 1000 items. Not 1000 step commands.

### Invariant Violations

```bash
dapi start bank.py --break "bank.py:68:account.balance < 0"
dapi start pipeline.py --break "pipeline.py:30:not isinstance(value, (int, float))"
```

### "Which of These 3 Functions?"

```bash
ps aux | grep uvicorn
dapi attach --pid 12345 \
  --break "auth.py:30" \
  --break "validate.py:55" \
  --break "handler.py:80"
curl localhost:8000/api/endpoint
dapi continue   # → auto-context tells you exactly where it stopped
dapi eval "request.payload"
dapi close
```

### Testing a Fix In-Place

```bash
# Paused at the crash
dapi eval "total + int(data['age'])"    # 90 — works
dapi eval "int(data['age'])"            # 35 — safe cast
dapi close
# NOW edit the code, with confidence
```

### Multiple Parallel Sessions

```bash
dapi --session api start api.py --break routes.py:42
dapi --session worker start worker.py --break tasks.py:88
dapi --session api eval "request.user"
dapi --session worker eval "queue.size()"
dapi --session api close
dapi --session worker close
```

## Never Do This

**Never step blindly.** More than 3 steps in a row? You need a breakpoint.

**Never start without reading code.** The debugger confirms theories. It doesn't generate them.

**Never dump vars when you have a question.** `eval "type(x)"` answers one question. `vars` answers none.

**Never debug timing bugs with the debugger.** Pausing changes timing. Use logging for races.

**Never keep going after 2 failed hypotheses.** Close. Re-read. Rethink. Your mental model is wrong.

**Never leave a session open.** `dapi close`. Always. Every time.

**Never fix without verifying.** Run after the fix. Then write a test.

## Notes

- Use **absolute paths** for breakpoints
- `attach --pid` auto-installs debugpy — no manual setup needed
- `attach --pid` requires lldb (macOS) or gdb (Linux)
- `--session <name>` runs independent daemons at `~/.dapi/<name>.sock`
- `output` drains buffered stdout/stderr — auto-context already includes it on each stop
