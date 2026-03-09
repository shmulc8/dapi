/** Rust/C++ debug adapter — CodeLLDB. */

import { spawn as cpSpawn } from "node:child_process";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type { AdapterConfig, SpawnResult, LaunchOpts, InitFlowOpts } from "./base.js";
import { getFreePort } from "../util/ports.js";

export class RustAdapter implements AdapterConfig {
  name = "rust";

  async checkInstalled(): Promise<string | null> {
    const codelldbPath = process.env.CODELLDB_PATH;
    if (!codelldbPath) {
      return "CodeLLDB not found. Set CODELLDB_PATH environment variable.";
    }
    try {
      await execCheck(codelldbPath, ["--version"]);
      return null;
    } catch {
      return `CodeLLDB not found at ${codelldbPath}`;
    }
  }

  async spawn(opts: LaunchOpts): Promise<SpawnResult> {
    const codelldbPath = process.env.CODELLDB_PATH;
    if (!codelldbPath) throw new Error("CODELLDB_PATH not set");

    const port = await getFreePort();
    const proc = cpSpawn(
      codelldbPath,
      ["--port", String(port)],
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
      adapterID: "codelldb",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
    };
  }

  launchArgs(opts: LaunchOpts): Record<string, unknown> {
    return {
      type: "lldb",
      request: "launch",
      program: opts.program,
      stopOnEntry: opts.stopOnEntry ?? false,
      args: opts.args || [],
      cwd: opts.cwd,
    };
  }

  /**
   * CodeLLDB DAP init flow (aligned with Python/debugpy pattern):
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

    // 2. Launch (async — CodeLLDB may defer response until configurationDone)
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
    const name = frame.name || "";
    return name.startsWith("std::") || name.startsWith("core::") || name.includes("__rust_");
  }

  isInternalVariable(v: Variable): boolean {
    return v.name.startsWith("__");
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
