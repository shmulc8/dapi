/** Debug session state machine + command handlers. */

import { readFileSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DAPClient } from "./dap-client.js";
import type { AdapterConfig } from "./adapters/base.js";
import { getAdapterForFile, getAdapter } from "./adapters/registry.js";
import type { Command, CommandResult, LocationInfo, VariableInfo } from "./protocol.js";

export type SessionState = "idle" | "starting" | "running" | "paused" | "terminated";

export class Session {
  state: SessionState = "idle";
  private client: DAPClient | null = null;
  private adapter: AdapterConfig | null = null;
  private adapterProcess: ChildProcess | null = null;
  private threadId: number | null = null;
  private frameId: number | null = null;
  private scriptPath: string | null = null;
  /** True when connected via attach (don't kill the debuggee on close). */
  private attachedMode = false;

  async handleCommand(cmd: Command): Promise<CommandResult> {
    switch (cmd.action) {
      case "start":
        return this.startSession(cmd);
      case "attach":
        return this.attachSession(cmd);
      case "vars":
        return this.getVariables();
      case "stack":
        return this.getStack();
      case "eval":
        return this.evalExpression(cmd.expression);
      case "step":
        return this.step(cmd.kind || "over");
      case "continue":
        return this.continueExecution();
      case "break":
        return this.setBreakpoint(cmd.file, cmd.line, cmd.condition);
      case "source":
        return this.getSourceAsync(cmd.file, cmd.line);
      case "status":
        return this.getStatus();
      case "close":
        return this.close();
    }
  }

  private async startSession(cmd: Extract<Command, { action: "start" }>): Promise<CommandResult> {
    if (this.state !== "idle") {
      return { error: "Session already active. Run 'agent-debugger close' first." };
    }

    const script = pathResolve(cmd.script);
    this.scriptPath = script;
    this.state = "starting";

    // Detect language and get adapter
    const language = cmd.language;
    if (language) {
      this.adapter = getAdapter(language);
    } else {
      this.adapter = getAdapterForFile(script);
    }
    if (!this.adapter) {
      this.state = "idle";
      return { error: `Unsupported file type: ${script}. Supported: .py, .js, .ts, .go, .rs, .c, .cpp` };
    }

    // Check adapter is installed
    const installErr = await this.adapter.checkInstalled(cmd.runtime);
    if (installErr) {
      this.state = "idle";
      return { error: installErr };
    }

    // Spawn debug adapter
    try {
      const spawnResult = await this.adapter.spawn({
        program: script,
        args: cmd.args,
        cwd: cmd.cwd || dirname(script),
        stopOnEntry: cmd.stop_on_entry,
        runtimePath: cmd.runtime,
      });
      this.adapterProcess = spawnResult.process;

      // Connect DAP client
      this.client = new DAPClient();
      await this.client.connect("127.0.0.1", spawnResult.port);
    } catch (err) {
      this.state = "idle";
      return { error: `Failed to start debug adapter: ${(err as Error).message}` };
    }

    // Parse breakpoints
    const breakpoints = this.parseBreakpoints(cmd.breakpoints || []);

    // Run adapter-specific init flow
    const result = await this.adapter.initFlow(this.client, {
      program: script,
      args: cmd.args,
      cwd: cmd.cwd || dirname(script),
      stopOnEntry: cmd.stop_on_entry,
      runtimePath: cmd.runtime,
      breakpoints,
    });

    if (result.error) {
      this.state = "idle";
      await this.cleanup();
      return result;
    }

    if (result.status === "paused") {
      this.state = "paused";
      const body = (this.client.drainEvents("stopped")[0]?.body || {}) as { threadId?: number };
      this.threadId = body.threadId ?? 1;
      // threadId may already be set from the initFlow stopped event processing
      // Try to get it from the adapter's result or fallback
      if (!this.threadId) this.threadId = 1;
      await this.updateFrame();
      result.location = await this.currentLocation();
    } else if (result.status === "terminated") {
      this.state = "terminated";
    } else {
      this.state = "running";
    }

    return result;
  }

  private async attachSession(cmd: Extract<Command, { action: "attach" }>): Promise<CommandResult> {
    if (this.state !== "idle") {
      return { error: "Session already active. Run 'agent-debugger close' first." };
    }

    if (!cmd.port && !cmd.pid) {
      return { error: "Either port or --pid is required" };
    }

    this.state = "starting";

    // Get adapter (default to python)
    const language = cmd.language || "python";
    this.adapter = getAdapter(language);
    if (!this.adapter) {
      this.state = "idle";
      return { error: `Unknown language: ${language}` };
    }

    if (!this.adapter.attachFlow) {
      this.state = "idle";
      return { error: `Attach not supported for ${this.adapter.name}` };
    }

    let host = cmd.host || "127.0.0.1";
    let port = cmd.port;

    // PID mode: inject debugpy into the running process
    if (cmd.pid) {
      if (!this.adapter.inject) {
        this.state = "idle";
        return { error: `PID injection not supported for ${this.adapter.name}` };
      }

      // Check debugpy is installed
      const installErr = await this.adapter.checkInstalled(cmd.runtime);
      if (installErr) {
        this.state = "idle";
        return { error: installErr };
      }

      try {
        const injectResult = await this.adapter.inject(cmd.pid, cmd.runtime);
        this.adapterProcess = injectResult.process;
        port = injectResult.port;
        host = "127.0.0.1";
      } catch (err) {
        this.state = "idle";
        return { error: `Failed to inject debugpy into PID ${cmd.pid}: ${(err as Error).message}` };
      }
    }

    // Connect DAP client to the debug server
    try {
      this.client = new DAPClient();
      await this.client.connect(host, port!);
    } catch (err) {
      this.state = "idle";
      this.client = null;
      return { error: `Failed to connect to ${host}:${port}: ${(err as Error).message}` };
    }

    // Parse breakpoints
    const breakpoints = this.parseBreakpoints(cmd.breakpoints || []);

    // Run adapter-specific attach flow
    const result = await this.adapter.attachFlow(this.client, {
      host,
      port: port!,
      breakpoints,
    });

    if (result.error) {
      this.state = "idle";
      await this.cleanup();
      return result;
    }

    // After attach, program is running (breakpoints set, waiting for trigger)
    this.state = "running";
    this.attachedMode = true;
    return result;
  }

  private parseBreakpoints(raw: string[]): Array<{ file: string; lines: number[]; conditions: Array<string | null> }> {
    const byFile = new Map<string, { lines: number[]; conditions: Array<string | null> }>();

    for (const bp of raw) {
      const parts = bp.split(":");
      if (parts.length < 2) continue;
      const file = pathResolve(parts[0]!);
      const line = parseInt(parts[1]!, 10);
      if (isNaN(line)) continue;
      const condition = parts.length > 2 ? parts.slice(2).join(":") : null;

      let entry = byFile.get(file);
      if (!entry) {
        entry = { lines: [], conditions: [] };
        byFile.set(file, entry);
      }
      entry.lines.push(line);
      entry.conditions.push(condition);
    }

    return Array.from(byFile.entries()).map(([file, data]) => ({
      file,
      lines: data.lines,
      conditions: data.conditions,
    }));
  }

  private async updateFrame(): Promise<void> {
    if (!this.client || this.threadId === null) return;
    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 20,
    });
    if (resp.success && resp.body) {
      const frames = (resp.body as { stackFrames?: Array<{ id: number }> }).stackFrames;
      if (frames?.length) {
        this.frameId = frames[0]!.id;
      }
    }
  }

  private async currentLocation(): Promise<LocationInfo | null> {
    if (!this.client || this.threadId === null) return null;
    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 20,
    });
    if (resp.success && resp.body) {
      const frames = (resp.body as {
        stackFrames?: Array<{
          name: string;
          line: number;
          source?: { path?: string };
        }>;
      }).stackFrames;
      if (frames?.length) {
        const f = frames[0]!;
        return {
          file: f.source?.path || "?",
          line: f.line,
          function: f.name,
        };
      }
    }
    return null;
  }

  private async getVariables(): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client) return { error: "No active session" };

    await this.updateFrame();
    if (this.frameId === null) return { error: "No frame available" };

    const resp = await this.client.request("scopes", { frameId: this.frameId });
    if (!resp.success) return { error: "Failed to get scopes" };

    const scopes = (resp.body as { scopes?: Array<{ name: string; variablesReference: number }> }).scopes || [];
    const result: VariableInfo[] = [];

    for (const scope of scopes) {
      if (scope.name !== "Locals" && scope.name !== "Local") continue;
      const varResp = await this.client.request("variables", {
        variablesReference: scope.variablesReference,
        count: 100,
      });
      if (varResp.success && varResp.body) {
        const vars = (varResp.body as {
          variables?: Array<{ name: string; value: string; type?: string; variablesReference: number }>;
        }).variables || [];
        for (const v of vars) {
          if (this.adapter?.isInternalVariable(v as any)) continue;
          result.push({ name: v.name, value: v.value, type: v.type || "" });
        }
      }
    }

    const location = await this.currentLocation();
    return { variables: result, count: result.length, location };
  }

  private async getStack(): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client || this.threadId === null) return { error: "No active session" };

    const resp = await this.client.request("stackTrace", {
      threadId: this.threadId,
      startFrame: 0,
      levels: 50,
    });
    if (!resp.success) return { error: "Failed to get stack trace" };

    const rawFrames = (resp.body as {
      stackFrames?: Array<{
        id: number;
        name: string;
        line: number;
        column: number;
        source?: { path?: string };
      }>;
    }).stackFrames || [];

    const frames: LocationInfo[] = [];
    for (const f of rawFrames) {
      if (this.adapter?.isInternalFrame(f as any)) continue;
      frames.push({
        function: f.name,
        file: f.source?.path || "",
        line: f.line,
      });
    }

    return { frames, count: frames.length };
  }

  private async evalExpression(expression: string): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client) return { error: "No active session" };
    if (!expression) return { error: "No expression provided" };

    const args: Record<string, unknown> = { expression, context: "repl" };
    if (this.frameId !== null) args.frameId = this.frameId;

    const resp = await this.client.request("evaluate", args);
    if (resp.success && resp.body) {
      const body = resp.body as { result: string; type?: string };
      return { result: body.result, type: body.type || "" };
    }
    return { error: resp.message || "Evaluation failed" };
  }

  private async step(kind: string): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client || this.threadId === null) return { error: "No active session" };

    const command = kind === "into" ? "stepIn" : kind === "out" ? "stepOut" : "next";
    await this.client.request(command, { threadId: this.threadId });
    this.state = "running";
    return this.waitForStop();
  }

  private async continueExecution(): Promise<CommandResult> {
    if (this.state === "running") {
      // In running state (e.g. after attach), just wait for next breakpoint hit
      if (!this.client) return { error: "No active session" };
      return this.waitForStop();
    }
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client || this.threadId === null) return { error: "No active session" };

    await this.client.request("continue", { threadId: this.threadId });
    this.state = "running";
    return this.waitForStop();
  }

  private async waitForStop(): Promise<CommandResult> {
    if (!this.client) return { error: "No active session" };

    // Poll for stopped/terminated events
    while (true) {
      const stopped = await this.client.waitForEvent("stopped", 1000);
      if (stopped) {
        this.state = "paused";
        const body = (stopped.body || {}) as { reason?: string; threadId?: number };
        this.threadId = body.threadId ?? this.threadId;
        await this.updateFrame();
        return {
          status: "paused",
          reason: body.reason || "unknown",
          location: await this.currentLocation(),
        };
      }

      const terminated = this.client.drainEvents("terminated");
      const exited = this.client.drainEvents("exited");
      if (terminated.length || exited.length) {
        this.state = "terminated";
        let exitCode: number | null = null;
        if (exited.length) {
          exitCode = (exited[0]!.body as { exitCode?: number })?.exitCode ?? null;
        }
        return { status: "terminated", exitCode };
      }

      // Drain output events silently
      this.client.drainEvents("output");
    }
  }

  private async setBreakpoint(filePath: string, line: number, condition?: string): Promise<CommandResult> {
    if (!this.client) return { error: "No active session" };

    const absPath = pathResolve(filePath);
    const bpArgs: Record<string, unknown> = {
      source: { path: absPath },
      breakpoints: [condition ? { line, condition } : { line }],
    };

    const resp = await this.client.request("setBreakpoints", bpArgs);
    if (resp.success && resp.body) {
      const bps = (resp.body as { breakpoints?: Array<{ line?: number; verified?: boolean }> }).breakpoints;
      if (bps?.length) {
        const bp = bps[0]!;
        return { file: absPath, line: bp.line ?? line, verified: bp.verified ?? false };
      }
    }
    return { error: "Failed to set breakpoint" };
  }

  private async getSourceAsync(filePath?: string, line?: number): Promise<CommandResult> {
    let resolvedFile = filePath;
    let resolvedLine = line;

    if (!resolvedFile && this.state === "paused") {
      const loc = await this.currentLocation();
      if (loc) {
        resolvedFile = loc.file;
        resolvedLine = resolvedLine ?? loc.line;
      }
    }

    if (!resolvedFile) {
      return { error: "No file specified and not paused at a known location" };
    }

    resolvedFile = pathResolve(resolvedFile);

    let lines: string[];
    try {
      lines = readFileSync(resolvedFile, "utf-8").split("\n");
    } catch {
      return { error: `File not found: ${resolvedFile}` };
    }

    const center = (resolvedLine || 1) - 1;
    const start = Math.max(0, center - 5);
    const end = Math.min(lines.length, center + 6);
    const sourceLines: string[] = [];
    for (let i = start; i < end; i++) {
      const marker = i === center ? "\u2192" : " ";
      const lineNum = String(i + 1).padStart(4);
      sourceLines.push(`${marker} ${lineNum} \u2502 ${lines[i]}`);
    }

    return { file: resolvedFile, line: resolvedLine, source: sourceLines.join("\n") };
  }

  private getStatus(): CommandResult {
    return {
      state: this.state,
      location: null, // Will be populated by async caller if needed
    };
  }

  async getStatusAsync(): Promise<CommandResult> {
    const result: CommandResult = { state: this.state };
    if (this.state === "paused") {
      result.location = await this.currentLocation();
    }
    return result;
  }

  async close(): Promise<CommandResult> {
    await this.cleanup();
    this.state = "idle";
    this.threadId = null;
    this.frameId = null;
    this.scriptPath = null;
    this.attachedMode = false;
    return { status: "closed" };
  }

  private async cleanup(): Promise<void> {
    if (this.client) {
      try {
        // In attach mode, disconnect without terminating the debuggee
        await this.client.disconnect(!this.attachedMode);
      } catch {
        // Best effort
      }
      this.client = null;
    }

    if (this.adapterProcess) {
      try {
        this.adapterProcess.kill("SIGTERM");
        // Give it a moment to exit gracefully
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            try { this.adapterProcess?.kill("SIGKILL"); } catch { /* ignore */ }
            resolve();
          }, 3000);
          this.adapterProcess!.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      } catch {
        // Best effort
      }
      this.adapterProcess = null;
    }
  }
}
