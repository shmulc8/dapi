/** Node.js debug adapter — @vscode/js-debug (dapDebugServer). */

import { spawn as cpSpawn, execSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import { resolve as pathResolve, join } from "node:path";
import { homedir } from "node:os";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type { AdapterConfig, SpawnResult, LaunchOpts, InitFlowOpts } from "./base.js";
import { getFreePort } from "../util/ports.js";
import { BASE_DIR } from "../util/paths.js";

const JS_DEBUG_DIR = join(BASE_DIR, "js-debug");
const JS_DEBUG_DAP_SERVER = join(JS_DEBUG_DIR, "src", "dapDebugServer.js");
/** Locate dapDebugServer.js from js-debug. */
function findJsDebugPath(): string | null {
  // 1. Explicit env var
  const envPath = process.env.JS_DEBUG_PATH;
  if (envPath) {
    const candidate = pathResolve(envPath, "src", "dapDebugServer.js");
    if (existsSync(candidate)) return candidate;
    // Maybe they pointed directly at dapDebugServer.js
    if (existsSync(envPath) && envPath.endsWith("dapDebugServer.js")) return envPath;
  }

  // 2. Auto-detect from VS Code extensions
  const vscodeExtDir = pathResolve(homedir(), ".vscode", "extensions");
  if (existsSync(vscodeExtDir)) {
    try {
      const entries = readdirSync(vscodeExtDir)
        .filter((e) => e.startsWith("ms-vscode.js-debug-"))
        .sort();
      for (let i = entries.length - 1; i >= 0; i--) {
        const candidate = pathResolve(vscodeExtDir, entries[i]!, "src", "dapDebugServer.js");
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // directory read failed
    }
  }

  // 3. Auto-provisioned copy in ~/.dapi/js-debug
  if (existsSync(JS_DEBUG_DAP_SERVER)) return JS_DEBUG_DAP_SERVER;

  return null;
}

/**
 * Download and extract the standalone js-debug DAP server from GitHub releases.
 * The tarball extracts to js-debug/ which contains src/dapDebugServer.js.
 */
function provisionJsDebug(): string {
  mkdirSync(BASE_DIR, { recursive: true });

  // Clean up any previous failed install
  if (existsSync(JS_DEBUG_DIR)) {
    rmSync(JS_DEBUG_DIR, { recursive: true, force: true });
  }

  // Resolve the latest release tag
  const tag = execSync(
    'curl -sI "https://github.com/microsoft/vscode-js-debug/releases/latest" | grep -i ^location: | sed "s/.*tag\\///" | tr -d "\\r\\n"',
    { encoding: "utf-8" },
  ).trim();
  if (!tag) throw new Error("Failed to resolve latest js-debug release tag");

  const url = `https://github.com/microsoft/vscode-js-debug/releases/download/${tag}/js-debug-dap-${tag}.tar.gz`;
  execSync(`curl -sL "${url}" | tar -xzf - -C "${BASE_DIR}"`, { stdio: "pipe" });

  if (!existsSync(JS_DEBUG_DAP_SERVER)) {
    throw new Error(`js-debug download succeeded but ${JS_DEBUG_DAP_SERVER} not found`);
  }
  return JS_DEBUG_DAP_SERVER;
}

export class NodeAdapter implements AdapterConfig {
  name = "node";

  async checkInstalled(): Promise<string | null> {
    // Check node is available
    try {
      await execCheck("node", ["--version"]);
    } catch {
      return "Node.js not found in PATH";
    }

    // Check js-debug is available, auto-provision if missing
    if (!findJsDebugPath()) {
      try {
        provisionJsDebug();
      } catch (err) {
        return [
          "@vscode/js-debug not found and auto-install failed.",
          err instanceof Error ? err.message : String(err),
          "Set JS_DEBUG_PATH manually, e.g.:",
          "  JS_DEBUG_PATH=~/.vscode/extensions/ms-vscode.js-debug-1.x.x",
        ].join("\n");
      }
    }

    return null;
  }

  async spawn(opts: LaunchOpts): Promise<SpawnResult> {
    const jsDebugPath = findJsDebugPath();
    if (!jsDebugPath) throw new Error("js-debug not found (run checkInstalled first)");

    const port = await getFreePort();
    // dapDebugServer.js <port> starts a DAP server on the given TCP port
    const proc = cpSpawn(
      "node",
      [jsDebugPath, String(port)],
      {
        stdio: ["pipe", "pipe", "pipe"],
        cwd: opts.cwd,
      },
    );
    return { process: proc, port };
  }

  initializeArgs(): Record<string, unknown> {
    return {
      clientID: "dapi",
      clientName: "dapi",
      adapterID: "js-debug",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    };
  }

  launchArgs(opts: LaunchOpts): Record<string, unknown> {
    const args: Record<string, unknown> = {
      type: "pwa-node",
      request: "launch",
      program: opts.program,
      console: "internalConsole",
      stopOnEntry: opts.stopOnEntry ?? false,
    };
    if (opts.args?.length) {
      args.args = opts.args;
    }
    if (opts.cwd) {
      args.cwd = opts.cwd;
    }
    return args;
  }

  /**
   * js-debug DAP init flow (aligned with Python/debugpy pattern):
   * 1. initialize
   * 2. launch (async — response may be deferred until configurationDone)
   * 3. wait for initialized event
   * 4. setBreakpoints
   * 5. setExceptionBreakpoints
   * 6. configurationDone
   * 7. wait for deferred launch response
   * 8. wait for stopped event
   */
  async initFlow(client: DAPClient, opts: InitFlowOpts): Promise<CommandResult> {
    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Launch (async — response may be deferred until configurationDone)
    const launchSeq = client.requestAsync("launch", this.launchArgs(opts));

    // 3. Wait for initialized event
    const initialized = await client.waitForEvent("initialized", 10000);
    if (!initialized) {
      return { error: "Timeout waiting for initialized event" };
    }

    // 4. Set breakpoints
    const bpResults: Array<{ file: string; line: number; verified: boolean }> = [];
    if (opts.breakpoints?.length) {
      for (const bp of opts.breakpoints) {
        const bpArgs: Record<string, unknown> = {
          source: { path: bp.file },
          breakpoints: bp.lines.map((line, i) => {
            const entry: Record<string, unknown> = { line };
            if (bp.conditions?.[i]) entry.condition = bp.conditions[i];
            return entry;
          }),
        };
        const resp = await client.request("setBreakpoints", bpArgs);
        if (resp.success && resp.body) {
          const bps = (resp.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> }).breakpoints;
          if (bps) {
            for (const b of bps) {
              bpResults.push({
                file: bp.file,
                line: b.line ?? 0,
                verified: b.verified ?? false,
              });
            }
          }
        }
      }
    }

    // 5. Exception breakpoints (empty = no exception breaking)
    await client.request("setExceptionBreakpoints", { filters: opts.exceptionFilters ?? [] });

    // 6. configurationDone
    await client.request("configurationDone");

    // 7. Wait for the deferred launch response
    const launchResp = await client.waitForResponse(launchSeq, 15000);
    if (!launchResp.success) {
      return { error: `Launch failed: ${launchResp.message || "unknown"}` };
    }

    // 8. Wait for stopped event (breakpoint hit or entry)
    const stopped = await client.waitForEvent("stopped", 15000);
    if (stopped) {
      const body = (stopped.body || {}) as { reason?: string; threadId?: number };
      return {
        status: "paused",
        reason: body.reason || "unknown",
        breakpoints: bpResults,
      };
    }

    // Program may have finished without hitting breakpoint
    const terminated = client.drainEvents("terminated");
    if (terminated.length) {
      return { status: "terminated", message: "Program finished without hitting breakpoint" };
    }

    return { status: "running", breakpoints: bpResults };
  }

  isInternalFrame(frame: StackFrame): boolean {
    const path = frame.source?.path || "";
    return path.includes("node:internal") || path.includes("node_modules");
  }

  isInternalVariable(v: Variable): boolean {
    return v.name === "this" || v.name === "__proto__";
  }
}

function execCheck(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = cpSpawn(cmd, args, { stdio: "pipe" });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}
