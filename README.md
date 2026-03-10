# dapi

**Let your AI agent debug like a human developer.**

`dapi` ships two things:

- **An agent skill** — teaches your AI agent *when* to reach for the debugger, how to form a hypothesis, and how to confirm it with a single `eval`. Install once, works on every project.
- **The `dapi` CLI** — a stateless CLI wrapper around the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP). Set breakpoints, inspect runtime state, attach to running servers by PID — no IDE, no restart, no guesswork.

Every stop returns **auto-context**: location + source snippet + locals + stack + output in one shot. No follow-up calls needed.

Supports Python, Go, JavaScript/TypeScript, Rust, C, and C++.

---

## Install the Skill

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

---

## Quick Start

### Debug a script

```bash
dapi start app.py --break app.py:25
# → paused at calculate() · app.py:25 [breakpoint]
#   Locals, stack, source snippet — all returned automatically

dapi eval "type(data[0]['age'])"   # confirm your hypothesis
dapi continue                      # next breakpoint
dapi close
```

### Attach to a running server

```bash
ps aux | grep uvicorn
dapi attach --pid 12345 --break routes.py:42
curl localhost:8000/api/endpoint   # trigger the code path
dapi continue                      # waits for breakpoint hit
dapi eval "request.body"
dapi close                         # detaches, server keeps running
```

---

## Commands

| Command | Description |
|---------|-------------|
| `start <script>` | Start a debug session |
| `attach --pid <PID>` | Attach to a running process by PID |
| `attach [host:]port` | Attach to an existing debug server |
| `step [over\|into\|out]` | Step (default: over) |
| `continue` | Resume / wait for next breakpoint |
| `context` | Re-fetch auto-context without stepping |
| `eval <expression>` | Evaluate in current frame |
| `vars` | List local variables |
| `stack` | Show call stack |
| `output` | Drain buffered stdout/stderr |
| `break <file:line[:cond]>` | Add breakpoint mid-session |
| `status` | Show session state |
| `close` | End the debug session |

See [docs/cli-reference.md](docs/cli-reference.md) for all flags and multi-session usage.

---

## Supported Languages

| Language | Extension | Adapter | Setup |
|----------|-----------|---------|-------|
| Python | `.py` | debugpy | auto-installed on `attach --pid` |
| JavaScript/TypeScript | `.js` `.ts` | js-debug | Auto-installed on first use |
| Go | `.go` | Delve | `go install ...dlv@latest` |
| Rust/C/C++ | `.rs` `.c` `.cpp` | CodeLLDB | `CODELLDB_PATH` env var |

See [docs/languages.md](docs/languages.md) for language-specific setup details.

---

## Credits

dapi is based on [JoaquinCampo/agent-debugger](https://github.com/JoaquinCampo/agent-debugger) (multi-language DAP support, attach by PID) and incorporates design ideas from [AlmogBaku/debug-skill](https://github.com/AlmogBaku/debug-skill) (auto-context, output buffering, multi-session).
