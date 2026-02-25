/** Python debug adapter — debugpy. */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";
import type { AdapterConfig, SpawnResult, InjectResult, LaunchOpts, InitFlowOpts, AttachFlowOpts } from "./base.js";
import { getFreePort } from "../util/ports.js";

export class PythonAdapter implements AdapterConfig {
  name = "python";

  async checkInstalled(runtimePath?: string): Promise<string | null> {
    const python = runtimePath || "python3";
    try {
      await execCheck(python, ["-m", "debugpy", "--version"]);
      return null;
    } catch {
      return `debugpy not found. Run: ${python} -m pip install debugpy`;
    }
  }

  async spawn(opts: LaunchOpts): Promise<SpawnResult> {
    const python = opts.runtimePath || "python3";
    const port = await getFreePort();
    const proc = cpSpawn(
      python,
      ["-Xfrozen_modules=off", "-m", "debugpy.adapter", "--host", "127.0.0.1", "--port", String(port)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    return { process: proc, port };
  }

  /**
   * Inject debugpy into a running Python process by PID using lldb.
   *
   * Uses Python C API calls (PyGILState_Ensure/PyRun_SimpleString/PyGILState_Release)
   * via lldb expressions — no architecture-specific dylibs needed.
   * Works on macOS ARM64 where debugpy's built-in --pid inject fails.
   *
   * debugpy.listen() spawns its own adapter subprocess, so the returned port
   * is where the adapter is serving DAP for clients to connect to.
   */
  async inject(pid: number, runtimePath?: string): Promise<InjectResult> {
    const debuggeePort = await getFreePort();

    // Use lldb to inject debugpy.listen() into the running process
    const code = `import debugpy; debugpy.listen(('127.0.0.1', ${debuggeePort}))`;
    const lldbProc = cpSpawn("lldb", [
      "--batch",
      "-o", `process attach --pid ${pid}`,
      "-o", `expr (int) PyGILState_Ensure()`,
      "-o", `expr (int) PyRun_SimpleString("${code}")`,
      "-o", `expr (void) PyGILState_Release($0)`,
      "-o", `detach`,
    ], { stdio: ["pipe", "pipe", "pipe"] });

    // Wait for lldb to finish
    const lldbOutput = await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      lldbProc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      lldbProc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      lldbProc.on("exit", (exitCode) => {
        if (exitCode !== 0) reject(new Error(`lldb failed (exit ${exitCode}): ${stderr.trim()}`));
        else resolve(stdout);
      });
      lldbProc.on("error", (err) => reject(new Error(`lldb not found: ${err.message}`)));
    });

    // Verify PyRun_SimpleString returned 0 (success)
    if (lldbOutput.includes("$1 = -1")) {
      throw new Error("PyRun_SimpleString failed — debugpy may not be installed in the target process");
    }

    // Don't poll the port here — debugpy treats a TCP connection as a DAP client,
    // and our probe would consume the single-client slot. The DAPClient.connect()
    // has its own retry loop that will wait for the port to be ready.

    // Small delay for debugpy to initialize its server after lldb detaches.
    await new Promise(resolve => setTimeout(resolve, 2000));

    return { process: lldbProc, port: debuggeePort };
  }

  initializeArgs(): Record<string, unknown> {
    return {
      clientID: "agent-debugger",
      clientName: "agent-debugger",
      adapterID: "debugpy",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsVariableType: true,
      supportsRunInTerminalRequest: false,
    };
  }

  launchArgs(opts: LaunchOpts): Record<string, unknown> {
    const args: Record<string, unknown> = {
      type: "debugpy",
      request: "launch",
      program: opts.program,
      console: "internalConsole",
      stopOnEntry: opts.stopOnEntry ?? false,
      justMyCode: true,
    };
    if (opts.runtimePath) {
      args.python = [opts.runtimePath, "-Xfrozen_modules=off"];
    }
    if (opts.args?.length) {
      args.args = opts.args;
    }
    if (opts.cwd) {
      args.cwd = opts.cwd;
    }
    return args;
  }

  /**
   * debugpy-specific init flow:
   * 1. initialize
   * 2. launch (async — response deferred until configurationDone)
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

    // 2. Launch (async — debugpy defers response until configurationDone)
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
    await client.request("setExceptionBreakpoints", { filters: [] });

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

  /**
   * Attach flow for debugpy — connects to a debugpy.listen() DAP server.
   *
   * debugpy.listen() starts a debug server that speaks DAP, but after the
   * `attach` request it emits `debugpyWaitingForServer` — requiring a
   * debugpy.adapter process to connect to an internal port before proceeding.
   *
   * Flow: initialize -> attach (async) -> debugpyWaitingForServer event
   *       -> spawn adapter -> initialized event -> setBreakpoints
   *       -> configurationDone -> attach response -> program running
   */
  async attachFlow(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult> {
    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Attach (async — response deferred until configurationDone)
    const attachArgs: Record<string, unknown> = {
      type: "debugpy",
      request: "attach",
      justMyCode: true,
      subProcess: true,
    };
    const attachSeq = client.requestAsync("attach", attachArgs);

    // 3. Wait for initialized event.
    //    debugpy.listen() spawns its own adapter subprocess with the access token.
    //    After the adapter connects to the internal server, the initialized event fires.
    //    We drain debugpyWaitingForServer and other internal events along the way.
    const initialized = await client.waitForEvent("initialized", 15000);
    if (!initialized) {
      return { error: "Timeout waiting for initialized event from debugpy" };
    }

    // 6. Set breakpoints
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

    // 7. Exception breakpoints
    await client.request("setExceptionBreakpoints", { filters: [] });

    // 8. configurationDone
    await client.request("configurationDone");

    // 9. Wait for the deferred attach response
    const attachResp = await client.waitForResponse(attachSeq, 15000);
    if (!attachResp.success) {
      return { error: `Attach failed: ${attachResp.message || "unknown"}` };
    }

    // Program is already running — don't wait for stopped event.
    return { status: "running", breakpoints: bpResults };
  }

  isInternalFrame(frame: StackFrame): boolean {
    const path = frame.source?.path || "";
    return path.includes("debugpy") || path.includes("pydevd") || path.includes("<frozen");
  }

  isInternalVariable(v: Variable): boolean {
    return v.name.startsWith("__") || v.name === "special variables" || v.name === "function variables";
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
