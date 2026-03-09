/** Go debug adapter — dlv (Delve). */

import { spawn as cpSpawn } from "node:child_process";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type { AdapterConfig, SpawnResult, LaunchOpts, InitFlowOpts } from "./base.js";
import { getFreePort } from "../util/ports.js";

export class GoAdapter implements AdapterConfig {
  name = "go";

  async checkInstalled(): Promise<string | null> {
    try {
      await execCheck("dlv", ["version"]);
      return null;
    } catch {
      return "Delve not found. Run: go install github.com/go-delve/delve/cmd/dlv@latest";
    }
  }

  async spawn(opts: LaunchOpts): Promise<SpawnResult> {
    const port = await getFreePort();
    const proc = cpSpawn(
      "dlv",
      ["dap", "--listen", `127.0.0.1:${port}`],
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
      adapterID: "dlv",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
    };
  }

  launchArgs(opts: LaunchOpts): Record<string, unknown> {
    return {
      type: "go",
      request: "launch",
      mode: "debug",
      program: opts.program,
      stopOnEntry: opts.stopOnEntry ?? false,
      args: opts.args || [],
      cwd: opts.cwd,
    };
  }

  /**
   * Delve DAP init flow (aligned with Python/debugpy pattern):
   * 1. initialize
   * 2. launch (async — response may be deferred)
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

    // 2. Launch (async — Delve may defer response until configurationDone)
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

    // 5. Exception breakpoints (empty = no exception breaking, required by spec)
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
    const name = frame.name || "";
    return path.includes("/runtime/") || name.startsWith("runtime.");
  }

  isInternalVariable(v: Variable): boolean {
    return false; // Go doesn't have dunder-style internals
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
