#!/usr/bin/env node
/** CLI entry point — thin stateless client that talks to the daemon. */

import { connect, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_DIR, SOCKET_PATH, PID_FILE } from "./util/paths.js";
import type { CommandResult } from "./protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0); // Check if process exists
    return true;
  } catch {
    // Clean up stale files
    for (const p of [PID_FILE, SOCKET_PATH]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
    return false;
  }
}

function ensureDaemon(): Promise<void> {
  if (isDaemonRunning()) return Promise.resolve();

  // Spawn daemon as a detached background process
  const daemonScript = pathResolve(__dirname, "daemon.js");
  const child = spawn("node", [daemonScript], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  // Wait for socket to appear
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      if (existsSync(SOCKET_PATH)) {
        resolve();
        return;
      }
      attempts++;
      if (attempts > 30) {
        reject(new Error("Daemon failed to start"));
        return;
      }
      setTimeout(check, 100);
    };
    check();
  });
}

function sendCommand(cmd: Record<string, unknown>): Promise<CommandResult> {
  return new Promise(async (resolve, reject) => {
    try {
      await ensureDaemon();
    } catch (err) {
      reject(err);
      return;
    }

    const sock: Socket = connect(SOCKET_PATH);
    let data = "";

    sock.on("connect", () => {
      sock.write(JSON.stringify(cmd) + "\n");
    });

    sock.on("data", (chunk) => {
      data += chunk.toString();
    });

    sock.on("end", () => {
      try {
        resolve(JSON.parse(data.trim()));
      } catch {
        resolve({ error: "Invalid response from daemon" });
      }
    });

    sock.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
        // Daemon died, clean up
        for (const p of [PID_FILE, SOCKET_PATH]) {
          try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
        }
        resolve({ error: "Daemon not running. Try again." });
      } else {
        reject(err);
      }
    });
  });
}

function formatResult(result: CommandResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
  }

  // Variables
  if (result.variables) {
    const loc = result.location;
    const lines: string[] = [];
    if (loc) {
      lines.push(`  at ${loc.file}:${loc.line} in ${loc.function}`);
    }
    for (const v of result.variables) {
      const typeSuffix = v.type ? ` (${v.type})` : "";
      lines.push(`  ${v.name} = ${v.value}${typeSuffix}`);
    }
    if (!result.variables.length) {
      lines.push("  (no local variables)");
    }
    return lines.join("\n");
  }

  // Status (check before location since status also has location)
  if (result.state) {
    const lines = [`State: ${result.state}`];
    const loc = result.location as CommandResult["location"];
    if (loc) {
      lines.push(`  ${loc.file}:${loc.line} in ${loc.function}`);
    }
    return lines.join("\n");
  }

  // Start / step / continue (has status + location)
  if (result.location) {
    const loc = result.location;
    const out: string[] = [];
    if (result.status) {
      const reason = result.reason ? ` (${result.reason})` : "";
      out.push(`Status: ${result.status}${reason}`);
    }
    out.push(`  ${loc.file}:${loc.line} in ${loc.function}`);
    if (result.breakpoints) {
      for (const bp of result.breakpoints) {
        const v = bp.verified ? "verified" : "pending";
        out.push(`  Breakpoint: ${bp.file}:${bp.line} (${v})`);
      }
    }
    return out.join("\n");
  }

  // Stack trace
  if (result.frames) {
    const lines: string[] = [];
    for (let i = 0; i < result.frames.length; i++) {
      const f = result.frames[i]!;
      const marker = i === 0 ? "\u2192" : " ";
      lines.push(`  ${marker} ${f.function} at ${f.file}:${f.line}`);
    }
    return lines.length ? lines.join("\n") : "  (empty stack)";
  }

  // Eval result
  if (result.result !== undefined) {
    const typeSuffix = result.type ? ` (${result.type})` : "";
    return `  ${result.result}${typeSuffix}`;
  }

  // Source
  if (result.source) {
    return result.source;
  }

  // Breakpoint set
  if (result.verified !== undefined) {
    const v = result.verified ? "verified" : "pending";
    return `  Breakpoint: ${result.file}:${result.line} (${v})`;
  }

  // Running (e.g. after attach — breakpoints set, waiting for trigger)
  if (result.status === "running") {
    const out: string[] = ["Attached. Program is running."];
    if (result.breakpoints) {
      for (const bp of result.breakpoints) {
        const v = bp.verified ? "verified" : "pending";
        out.push(`  Breakpoint: ${bp.file}:${bp.line} (${v})`);
      }
    }
    out.push("  Run 'agent-debugger continue' to wait for a breakpoint hit.");
    return out.join("\n");
  }

  // Terminated
  if (result.status === "terminated") {
    const exitStr = result.exitCode !== undefined && result.exitCode !== null ? ` (exit code: ${result.exitCode})` : "";
    return `Status: terminated${exitStr}`;
  }

  // Closed
  if (result.status === "closed") {
    return "Session closed.";
  }

  // Generic
  return JSON.stringify(result, null, 2);
}

const HELP = `agent-debugger \u2014 CLI debugger for AI agents

Usage:
  agent-debugger start <script> [--break file:line] [--runtime path] [--args ...]
  agent-debugger attach --pid <PID> [--break file:line]
  agent-debugger attach [host:]port [--break file:line]
  agent-debugger vars                        Get local variables
  agent-debugger eval <expression>           Evaluate expression
  agent-debugger step [into|out]             Step over/into/out
  agent-debugger continue                    Continue / wait for next breakpoint
  agent-debugger stack                       Show call stack
  agent-debugger break <file:line[:cond]>    Add breakpoint
  agent-debugger source [file] [line]        Show source code
  agent-debugger status                      Show current state
  agent-debugger close                       Detach / end debug session`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (!args.length || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    console.log(HELP);
    return;
  }

  const command = args[0]!;
  let result: CommandResult;

  switch (command) {
    case "start": {
      if (args.length < 2) {
        process.stderr.write("Error: missing script path. Usage: agent-debugger start <script>\n");
        process.exit(1);
      }
      const script = args[1]!;
      const breakpoints: string[] = [];
      let runtimePath: string | undefined;
      let scriptArgs: string[] | undefined;
      let stopOnEntry = false;

      let i = 2;
      while (i < args.length) {
        if ((args[i] === "--break" || args[i] === "-b") && i + 1 < args.length) {
          breakpoints.push(args[i + 1]!);
          i += 2;
        } else if ((args[i] === "--runtime" || args[i] === "--python") && i + 1 < args.length) {
          runtimePath = args[i + 1]!;
          i += 2;
        } else if (args[i] === "--stop-on-entry") {
          stopOnEntry = true;
          i += 1;
        } else if (args[i] === "--args") {
          scriptArgs = args.slice(i + 1);
          break;
        } else {
          // Treat as breakpoint if it looks like file:line
          const val = args[i]!;
          if (val.includes(":") && /:\d+/.test(val)) {
            breakpoints.push(val);
          }
          i += 1;
        }
      }

      const cmd: Record<string, unknown> = {
        action: "start",
        script: pathResolve(script),
        breakpoints,
        stop_on_entry: stopOnEntry,
      };
      if (runtimePath) cmd.runtime = pathResolve(runtimePath);
      if (scriptArgs) cmd.args = scriptArgs;
      result = await sendCommand(cmd);
      break;
    }

    case "attach": {
      const attachBreakpoints: string[] = [];
      let attachHost: string | undefined;
      let attachPort: number | undefined;
      let attachPid: number | undefined;
      let attachLanguage: string | undefined;
      let attachRuntime: string | undefined;

      let ai = 1;
      while (ai < args.length) {
        if ((args[ai] === "--break" || args[ai] === "-b") && ai + 1 < args.length) {
          attachBreakpoints.push(args[ai + 1]!);
          ai += 2;
        } else if (args[ai] === "--pid" && ai + 1 < args.length) {
          attachPid = parseInt(args[ai + 1]!, 10);
          ai += 2;
        } else if (args[ai] === "--language" && ai + 1 < args.length) {
          attachLanguage = args[ai + 1]!;
          ai += 2;
        } else if ((args[ai] === "--runtime" || args[ai] === "--python") && ai + 1 < args.length) {
          attachRuntime = args[ai + 1]!;
          ai += 2;
        } else if (!attachPort && !args[ai]!.startsWith("-")) {
          // Positional: [host:]port
          const target = args[ai]!;
          if (target.includes(":")) {
            const lastColon = target.lastIndexOf(":");
            attachHost = target.substring(0, lastColon);
            attachPort = parseInt(target.substring(lastColon + 1), 10);
          } else {
            attachPort = parseInt(target, 10);
          }
          ai += 1;
        } else {
          const val = args[ai]!;
          if (val.includes(":") && /:\d+/.test(val)) {
            attachBreakpoints.push(val);
          }
          ai += 1;
        }
      }

      if (!attachPort && !attachPid) {
        process.stderr.write("Error: provide a port or --pid. Usage:\n  agent-debugger attach [host:]port [--break file:line]\n  agent-debugger attach --pid <PID> [--break file:line]\n");
        process.exit(1);
      }

      const attachCmd: Record<string, unknown> = {
        action: "attach",
        breakpoints: attachBreakpoints,
      };
      if (attachPort) attachCmd.port = attachPort;
      if (attachPid) attachCmd.pid = attachPid;
      if (attachHost) attachCmd.host = attachHost;
      if (attachLanguage) attachCmd.language = attachLanguage;
      if (attachRuntime) attachCmd.runtime = attachRuntime;
      result = await sendCommand(attachCmd);
      break;
    }

    case "vars":
      result = await sendCommand({ action: "vars" });
      break;

    case "eval": {
      const expr = args.slice(1).join(" ");
      if (!expr) {
        process.stderr.write("Error: missing expression. Usage: agent-debugger eval <expression>\n");
        process.exit(1);
      }
      result = await sendCommand({ action: "eval", expression: expr });
      break;
    }

    case "step":
      result = await sendCommand({ action: "step", kind: args[1] || "over" });
      break;

    case "continue":
    case "cont":
    case "c":
      result = await sendCommand({ action: "continue" });
      break;

    case "stack":
      result = await sendCommand({ action: "stack" });
      break;

    case "break":
    case "bp": {
      if (args.length < 2) {
        process.stderr.write("Error: missing location. Usage: agent-debugger break <file:line[:condition]>\n");
        process.exit(1);
      }
      const parts = args[1]!.split(":");
      if (parts.length < 2) {
        process.stderr.write("Error: invalid breakpoint format. Use file:line or file:line:condition\n");
        process.exit(1);
      }
      const cmd: Record<string, unknown> = {
        action: "break",
        file: parts[0]!,
        line: parseInt(parts[1]!, 10),
      };
      if (parts.length > 2) cmd.condition = parts.slice(2).join(":");
      result = await sendCommand(cmd);
      break;
    }

    case "source": {
      const cmd: Record<string, unknown> = { action: "source" };
      if (args.length > 1) cmd.file = args[1]!;
      if (args.length > 2) cmd.line = parseInt(args[2]!, 10);
      result = await sendCommand(cmd);
      break;
    }

    case "status":
      result = await sendCommand({ action: "status" });
      break;

    case "close":
      result = await sendCommand({ action: "close" });
      break;

    default:
      process.stderr.write(`Unknown command: ${command}. Run 'agent-debugger --help' for usage.\n`);
      process.exit(1);
  }

  console.log(formatResult(result));
  if (result.error) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
