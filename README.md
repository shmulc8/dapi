# dapi

**Let your AI agent debug like a human developer.**

`dapi` ships two things:

- **An agent skill** — teaches your AI agent *when* to reach for the debugger, how to form a hypothesis, and how to confirm it with a single `eval`. Install once, works on every project.
- **The `dapi` CLI** — a stateless CLI wrapper around the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP). Set breakpoints, inspect runtime state, attach to running servers by PID — no IDE, no restart, no guesswork.

Every stop returns **auto-context**: location + source snippet + locals + stack + output in one shot. No follow-up calls needed.

Supports Python, Go, JavaScript/TypeScript, Rust, C, and C++.

---

## Install the Skill

### Claude Code

```bash
mkdir -p ~/.claude/skills/dapi && \
  curl -fsSL https://raw.githubusercontent.com/anuk909/dapi/main/skills/dapi/SKILL.md \
  -o ~/.claude/skills/dapi/SKILL.md
```

### Other agents

```bash
npx skills install anuk909/dapi
```

---

## Install the CLI

```bash
npm install -g dapi-cli
```

Or zero-install — no setup needed:

```bash
npx -y dapi-cli start app.py --break app.py:25
```

Requires Node.js >= 18.

## Quick Start

### Debug a script

```bash
dapi start app.py --break app.py:25

# Every stop returns auto-context automatically:
# Stopped at calculate() · app.py:25 [breakpoint]
#     23 │ def calculate(data):
#     24 │     total = 0
# →   25 │     for item in data:
# Locals:
#   data = [{'name': 'Alice', 'age': 30}, ...]  (list)
#   total = 0  (int)
# Stack:
#   calculate [app.py:25]  main [app.py:10]

dapi eval "type(data[0]['age'])"   # inspect anything
dapi continue                      # next breakpoint
dapi close
```

### Debug a running server

```bash
ps aux | grep uvicorn
dapi attach --pid 12345 --break routes.py:42
curl localhost:8000/api/endpoint   # trigger the code path
dapi continue                      # wait for breakpoint hit
dapi eval "request.body"
dapi close                         # detaches without killing the server
```

## Commands

| Command | Description |
|---------|-------------|
| `start <script> [options]` | Start a debug session |
| `attach --pid <PID> [options]` | Attach to a running process by PID |
| `attach [host:]port [options]` | Attach to an existing debug server |
| `step [over\|into\|out]` | Step (default: over) |
| `continue` | Resume execution / wait for next breakpoint |
| `context` | Re-fetch auto-context without stepping |
| `eval <expression>` | Evaluate in current frame |
| `vars` | List local variables |
| `stack` | Show call stack |
| `output` | Drain buffered stdout/stderr since last stop |
| `break <file:line[:cond]>` | Add breakpoint mid-session |
| `source [file] [line]` | Show source around current line |
| `status` | Show session state |
| `close` | End the debug session |

### start options

```
--break, -b <file:line[:condition]>    Set a breakpoint (repeatable)
--runtime <path>                       Path to language runtime (e.g. /path/to/venv/python)
--break-on-exception <filter>          Stop on exceptions (repeatable)
--stop-on-entry                        Pause on the first line
--args <...>                           Arguments for the debugged script
--session <name>                       Session name (default: "default")
```

### attach options

```
--pid <PID>                            Attach by PID (injects debugpy via lldb/gdb)
--break, -b <file:line[:condition]>    Set a breakpoint (repeatable)
--break-on-exception <filter>          Stop on exceptions (repeatable)
--runtime <path>                       Language runtime path (optional)
--language <name>                      Adapter: python, node, go, rust (default: python)
--session <name>                       Session name
```

## Auto-Context

Every execution command (`start`, `step`, `continue`, `context`) returns full context in one response:

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

No follow-up `vars`, `stack`, or `source` calls needed.

## Multi-Session

Run independent debug sessions in parallel using `--session <name>`:

```bash
dapi --session api    start api.py    --break routes.py:42
dapi --session worker start worker.py --break tasks.py:88

dapi --session api    eval "request.user"
dapi --session worker eval "queue.size()"

dapi --session api    close
dapi --session worker close
```

Each session has its own daemon at `~/.dapi/<name>.sock`.

## Supported Languages

| Language | Extension | Adapter | Setup |
|----------|-----------|---------|-------|
| Python | `.py` | debugpy | `pip install debugpy` (auto-installed on `attach --pid`) |
| JavaScript/TypeScript | `.js` `.ts` | @vscode/js-debug | VS Code installed, or `JS_DEBUG_PATH` env var |
| Go | `.go` | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust/C/C++ | `.rs` `.c` `.cpp` | CodeLLDB | `CODELLDB_PATH` env var |

### Language-specific notes

**Python** — use `--runtime` to target a specific venv:
```bash
dapi start app.py --break app.py:10 --runtime /path/to/venv/bin/python
```

**JavaScript/TypeScript** — js-debug auto-detected from `~/.vscode/extensions/`. Override:
```bash
export JS_DEBUG_PATH=/path/to/ms-vscode.js-debug-x.x.x
```

**Go** — install Delve:
```bash
go install github.com/go-delve/delve/cmd/dlv@latest
```

**Rust/C/C++** — set CodeLLDB path:
```bash
export CODELLDB_PATH=/path/to/codelldb/adapter/codelldb
```

## How It Works

```
CLI (stateless)  ──unix socket──▶  Daemon  ──TCP/DAP──▶  Debug Adapter
                                   ~/.dapi/<session>.sock   (debugpy, dlv, etc.)
```

**Attach by PID:**
```
CLI  ──▶  Daemon  ──lldb/gdb──▶  Target Process (injects debugpy.listen())
                  ──TCP/DAP──▶   debugpy adapter (spawned by debugpy.listen)
```

- **CLI** (`dapi`): Stateless. Sends JSON commands over a Unix socket, prints results.
- **Daemon**: Background process per session. Manages DAP session, buffers output.
- **Debug Adapter**: Language-specific process (debugpy, dlv, js-debug, CodeLLDB).

The daemon starts automatically on the first command and exits when the session closes.

## Development

```bash
git clone https://github.com/anuk909/dapi
cd dapi
bun install
bun test
```

## Credits

dapi is based on [JoaquinCampo/agent-debugger](https://github.com/JoaquinCampo/agent-debugger) (multi-language DAP support, attach by PID) and incorporates design ideas from [AlmogBaku/debug-skill](https://github.com/AlmogBaku/debug-skill) (auto-context, output buffering, multi-session).
