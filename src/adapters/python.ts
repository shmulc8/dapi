/** Python debug adapter — debugpy. */

import { spawn as cpSpawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
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
   * Inject debugpy into a running Python process by PID.
   * Runs: python -m debugpy --listen 127.0.0.1:PORT --pid PID
   * This injects the debug adapter into the target process and starts a DAP server.
   */
  async inject(pid: number, runtimePath?: string): Promise<InjectResult> {
    const python = runtimePath || "python3";
    const port = await getFreePort();

    const proc = cpSpawn(
      python,
      ["-m", "debugpy", "--listen", `127.0.0.1:${port}`, "--pid", String(pid)],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    // Wait for the DAP server to be ready by polling the port
    await waitForPort(port, 15000, proc);

    return { process: proc, port };
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
   * Attach flow for debugpy — connects to a running debugpy listener.
   * The user starts their server with:
   *   python -m debugpy --listen PORT [-m module | script.py]
   * or adds debugpy.listen(PORT) to their code.
   *
   * Flow: initialize -> attach (async) -> initialized event -> setBreakpoints
   *       -> configurationDone -> attach response -> program continues running
   */
  async attachFlow(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult> {
    // 1. Initialize
    const initResp = await client.request("initialize", this.initializeArgs());
    if (!initResp.success) {
      return { error: `Initialize failed: ${initResp.message || "unknown"}` };
    }

    // 2. Attach (async — debugpy defers response until configurationDone)
    const attachArgs: Record<string, unknown> = {
      type: "debugpy",
      request: "attach",
      justMyCode: true,
      subProcess: true,
    };
    const attachSeq = client.requestAsync("attach", attachArgs);

    // 3. Wait for initialized event
    const initialized = await client.waitForEvent("initialized", 10000);
    if (!initialized) {
      return { error: "Timeout waiting for initialized event from debugpy" };
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

    // 5. Exception breakpoints
    await client.request("setExceptionBreakpoints", { filters: [] });

    // 6. configurationDone
    await client.request("configurationDone");

    // 7. Wait for the deferred attach response
    const attachResp = await client.waitForResponse(attachSeq, 15000);
    if (!attachResp.success) {
      return { error: `Attach failed: ${attachResp.message || "unknown"}` };
    }

    // Program is already running — don't wait for stopped event.
    // The user should trigger their server, then run `agent-debugger continue` to wait.
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

/** Poll a TCP port until it accepts connections, or timeout. */
function waitForPort(port: number, timeout: number, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeout;

  return new Promise((resolve, reject) => {
    // Fail fast if the injection process exits with an error
    let procExited = false;
    let procStderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => { procStderr += chunk.toString(); });
    proc.on("exit", (code) => {
      if (code !== 0 && !procExited) {
        procExited = true;
        reject(new Error(`debugpy inject failed (exit ${code}): ${procStderr.trim() || "unknown error"}`));
      }
    });

    const attempt = () => {
      if (procExited) return;
      if (Date.now() > deadline) {
        reject(new Error(`Timeout waiting for debugpy to start on port ${port}`));
        return;
      }
      const sock = new Socket();
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        setTimeout(attempt, 200);
      });
      sock.connect(port, "127.0.0.1");
    };
    attempt();
  });
}
