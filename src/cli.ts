#!/usr/bin/env bun
/** CLI entry point — thin stateless client that talks to the daemon. */

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { socketPath, pidFile } from "./util/paths.js";
import { formatResult } from "./format.js";
import type { CommandResult } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Daemon lifecycle ---

function isDaemonRunning(session: string): boolean {
  const pid = pidFile(session);
  if (!existsSync(pid)) return false;
  try {
    process.kill(parseInt(readFileSync(pid, "utf-8").trim(), 10), 0);
    return true;
  } catch {
    for (const p of [pid, socketPath(session)]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    return false;
  }
}

function ensureDaemon(session: string): Promise<void> {
  if (isDaemonRunning(session)) return Promise.resolve();

  const daemonScript = pathResolve(__dirname, "daemon.ts");
  const child = spawn("bun", ["run", daemonScript, session], { stdio: "ignore", detached: true });
  child.unref();

  return new Promise((resolve, reject) => {
    let attempts = 0;
    const sock = socketPath(session);
    const check = () => {
      if (existsSync(sock)) { resolve(); return; }
      if (++attempts > 30) { reject(new Error(`Daemon failed to start (session: ${session})`)); return; }
      setTimeout(check, 100);
    };
    check();
  });
}

function sendCommand(cmd: Record<string, unknown>, session: string): Promise<CommandResult> {
  return new Promise(async (resolve, reject) => {
    try { await ensureDaemon(session); } catch (err) { reject(err); return; }

    const sock: Socket = connect(socketPath(session));
    let data = "";

    sock.on("connect", () => { sock.write(JSON.stringify(cmd) + "\n"); });
    sock.on("data", (chunk) => { data += chunk.toString(); });
    sock.on("end", () => {
      try { resolve(JSON.parse(data.trim())); }
      catch { resolve({ error: "Invalid response from daemon" }); }
    });
    sock.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        for (const p of [pidFile(session), socketPath(session)]) {
          try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
        }
        resolve({ error: "Daemon not running. Try again." });
      } else {
        reject(err);
      }
    });
  });
}

// --- CLI ---

const HELP = `dapi — CLI debugger for AI agents

Usage:
  dapi start <script> [--break file:line[:cond]] [--runtime path] [--break-on-exception filter] [--args ...]
  dapi attach --pid <PID> [--break file:line]
  dapi attach [host:]port [--break file:line]
  dapi step [over|into|out]              Step (default: over)
  dapi continue                          Run to next breakpoint
  dapi context                           Re-fetch location+source+locals+stack+output
  dapi eval <expression>                 Evaluate expression in current frame
  dapi vars                              List local variables
  dapi stack                             Show call stack
  dapi output                            Drain buffered stdout/stderr
  dapi break <file:line[:cond]>          Add breakpoint mid-session
  dapi source [file] [line]              Show source around current line
  dapi status                            Show session state
  dapi close                             End debug session

Global flags:
  --session <name>                       Session name (default: "default")

start/step/continue/context return auto-context: location + source + locals + stack + output.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Extract --session flag (global)
  let session = "default";
  const sessionIdx = argv.indexOf("--session");
  if (sessionIdx !== -1 && sessionIdx + 1 < argv.length) {
    session = argv[sessionIdx + 1]!;
    argv.splice(sessionIdx, 2);
  }

  if (!argv.length || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    console.log(HELP);
    return;
  }

  const command = argv[0]!;
  let result: CommandResult;

  switch (command) {
    case "start": {
      if (argv.length < 2) { process.stderr.write("Error: missing script path\n"); process.exit(1); }
      const script = argv[1]!;
      const breakpoints: string[] = [];
      const exceptionFilters: string[] = [];
      let runtimePath: string | undefined;
      let scriptArgs: string[] | undefined;
      let stopOnEntry = false;

      let i = 2;
      while (i < argv.length) {
        const flag = argv[i]!;
        if ((flag === "--break" || flag === "-b") && i + 1 < argv.length) {
          breakpoints.push(argv[i + 1]!); i += 2;
        } else if ((flag === "--runtime" || flag === "--python") && i + 1 < argv.length) {
          runtimePath = argv[i + 1]!; i += 2;
        } else if (flag === "--break-on-exception" && i + 1 < argv.length) {
          exceptionFilters.push(argv[i + 1]!); i += 2;
        } else if (flag === "--stop-on-entry") {
          stopOnEntry = true; i++;
        } else if (flag === "--args") {
          scriptArgs = argv.slice(i + 1); break;
        } else if (flag.includes(":") && /:\d+/.test(flag)) {
          breakpoints.push(flag); i++;
        } else { i++; }
      }

      const cmd: Record<string, unknown> = {
        action: "start",
        script: pathResolve(script),
        breakpoints,
        stop_on_entry: stopOnEntry,
      };
      if (runtimePath) cmd.runtime = pathResolve(runtimePath);
      if (scriptArgs) cmd.args = scriptArgs;
      if (exceptionFilters.length) cmd.exceptionFilters = exceptionFilters;
      result = await sendCommand(cmd, session);
      break;
    }

    case "attach": {
      const breakpoints: string[] = [];
      const exceptionFilters: string[] = [];
      let host: string | undefined;
      let port: number | undefined;
      let pid: number | undefined;
      let language: string | undefined;
      let runtime: string | undefined;

      let ai = 1;
      while (ai < argv.length) {
        const flag = argv[ai]!;
        if ((flag === "--break" || flag === "-b") && ai + 1 < argv.length) {
          breakpoints.push(argv[ai + 1]!); ai += 2;
        } else if (flag === "--pid" && ai + 1 < argv.length) {
          pid = parseInt(argv[ai + 1]!, 10); ai += 2;
        } else if (flag === "--language" && ai + 1 < argv.length) {
          language = argv[ai + 1]!; ai += 2;
        } else if ((flag === "--runtime" || flag === "--python") && ai + 1 < argv.length) {
          runtime = argv[ai + 1]!; ai += 2;
        } else if (flag === "--break-on-exception" && ai + 1 < argv.length) {
          exceptionFilters.push(argv[ai + 1]!); ai += 2;
        } else if (!port && !flag.startsWith("-")) {
          const lastColon = flag.lastIndexOf(":");
          if (lastColon > 0 && !/^\d+$/.test(flag)) {
            host = flag.substring(0, lastColon);
            port = parseInt(flag.substring(lastColon + 1), 10);
          } else {
            port = parseInt(flag, 10);
          }
          ai++;
        } else if (flag.includes(":") && /:\d+/.test(flag)) {
          breakpoints.push(flag); ai++;
        } else { ai++; }
      }

      if (!port && !pid) {
        process.stderr.write("Error: provide a port or --pid\n"); process.exit(1);
      }

      const attachCmd: Record<string, unknown> = { action: "attach", breakpoints };
      if (port) attachCmd.port = port;
      if (pid) attachCmd.pid = pid;
      if (host) attachCmd.host = host;
      if (language) attachCmd.language = language;
      if (runtime) attachCmd.runtime = runtime;
      if (exceptionFilters.length) attachCmd.exceptionFilters = exceptionFilters;
      result = await sendCommand(attachCmd, session);
      break;
    }

    case "step":
      result = await sendCommand({ action: "step", kind: argv[1] ?? "over" }, session);
      break;

    case "continue":
    case "cont":
    case "c":
      result = await sendCommand({ action: "continue" }, session);
      break;

    case "context":
      result = await sendCommand({ action: "context" }, session);
      break;

    case "eval": {
      const expr = argv.slice(1).join(" ");
      if (!expr) { process.stderr.write("Error: missing expression\n"); process.exit(1); }
      result = await sendCommand({ action: "eval", expression: expr }, session);
      break;
    }

    case "vars":
      result = await sendCommand({ action: "vars" }, session);
      break;

    case "stack":
      result = await sendCommand({ action: "stack" }, session);
      break;

    case "output":
      result = await sendCommand({ action: "output" }, session);
      break;

    case "break":
    case "bp": {
      if (argv.length < 2) { process.stderr.write("Error: missing location\n"); process.exit(1); }
      const parts = argv[1]!.split(":");
      if (parts.length < 2) { process.stderr.write("Error: use file:line or file:line:condition\n"); process.exit(1); }
      const bpCmd: Record<string, unknown> = { action: "break", file: parts[0]!, line: parseInt(parts[1]!, 10) };
      if (parts.length > 2) bpCmd.condition = parts.slice(2).join(":");
      result = await sendCommand(bpCmd, session);
      break;
    }

    case "source": {
      const srcCmd: Record<string, unknown> = { action: "source" };
      if (argv.length > 1) srcCmd.file = argv[1]!;
      if (argv.length > 2) srcCmd.line = parseInt(argv[2]!, 10);
      result = await sendCommand(srcCmd, session);
      break;
    }

    case "status":
      result = await sendCommand({ action: "status" }, session);
      break;

    case "close":
      result = await sendCommand({ action: "close" }, session);
      break;

    default:
      process.stderr.write(`Unknown command: ${command}. Run 'dapi --help' for usage.\n`);
      process.exit(1);
  }

  console.log(formatResult(result));
  if (result.error) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${(err as Error).message}\n`);
  process.exit(1);
});
