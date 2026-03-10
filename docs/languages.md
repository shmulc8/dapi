# Supported Languages

| Language | Extension | Adapter | Setup |
|----------|-----------|---------|-------|
| Python | `.py` | debugpy | `pip install debugpy` (auto-installed on `attach --pid`) |
| JavaScript/TypeScript | `.js` `.ts` | @vscode/js-debug | Auto-installed on first use. Override with `JS_DEBUG_PATH` env var |
| Go | `.go` | Delve | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| Rust/C/C++ | `.rs` `.c` `.cpp` | CodeLLDB | `CODELLDB_PATH` env var |

## Python

Use `--runtime` to target a specific venv:

```bash
dapi start app.py --break app.py:10 --runtime /path/to/venv/bin/python
```

`attach --pid` auto-installs debugpy into the target process — no manual setup needed. Requires `lldb` (macOS) or `gdb` (Linux).

## JavaScript/TypeScript

js-debug is auto-provisioned on first use — downloaded from [GitHub releases](https://github.com/microsoft/vscode-js-debug/releases) to `~/.dapi/js-debug/`. Also auto-detected from `~/.vscode/extensions/` if present. Override with:

```bash
export JS_DEBUG_PATH=/path/to/ms-vscode.js-debug-x.x.x
```

## Go

Install Delve:

```bash
go install github.com/go-delve/delve/cmd/dlv@latest
```

## Rust/C/C++

Set the CodeLLDB path:

```bash
export CODELLDB_PATH=/path/to/codelldb/adapter/codelldb
```
