/** Debug session state machine + command handlers. */

import { readFileSync } from "node:fs";
import { resolve as pathResolve, dirname } from "node:path";
import type { ChildProcess } from "node:child_process";
import { DAPClient } from "./dap-client.js";
import type { AdapterConfig } from "./adapters/base.js";
import { getAdapterForFile, getAdapter } from "./adapters/registry.js";
import type { Command, CommandResult, LocationInfo, VariableInfo, BreakpointInfo } from "./protocol.js";

export type SessionState = "idle" | "starting" | "running" | "paused" | "terminated";

// ---- Pure utilities (exported for testing) ----

/** Parse "file:line" or "file:line:condition" breakpoint strings, grouped by file. */
export function parseBreakpoints(raw: string[]): Array<{ file: string; lines: number[]; conditions: Array<string | null> }> {
  const byFile = new Map<string, { lines: number[]; conditions: Array<string | null> }>();
  for (const bp of raw) {
    const parts = bp.split(":");
    if (parts.length < 2) continue;
    const file = pathResolve(parts[0]!);
    const line = parseInt(parts[1]!, 10);
    if (isNaN(line)) continue;
    const condition = parts.length > 2 ? parts.slice(2).join(":") : null;
    let entry = byFile.get(file);
    if (!entry) { entry = { lines: [], conditions: [] }; byFile.set(file, entry); }
    entry.lines.push(line);
    entry.conditions.push(condition);
  }
  return Array.from(byFile.entries()).map(([file, data]) => ({ file, lines: data.lines, conditions: data.conditions }));
}

/** Build a source snippet (up to 10 lines) around centerLine, marking the current line with →. */
export function buildSourceSnippet(filePath: string, centerLine: number): string | undefined {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const center = centerLine - 1; // 0-indexed
    const start = Math.max(0, center - 4);
    const end = Math.min(lines.length, center + 6);
    const result: string[] = [];
    for (let i = start; i < end; i++) {
      const lineNum = String(i + 1).padStart(5);
      const marker = i === center ? "→" : " ";
      result.push(`${marker}${lineNum} │ ${lines[i] ?? ""}`);
    }
    return result.join("\n");
  } catch {
    return undefined;
  }
}

// ---- Session ----

export class Session {
  state: SessionState = "idle";
  private client: DAPClient | null = null;
  private adapter: AdapterConfig | null = null;
  private adapterProcess: ChildProcess | null = null;
  private threadId: number | null = null;
  private frameId: number | null = null;
  private attachedMode = false;
  private outputBuffer: string[] = [];

  async handleCommand(cmd: Command): Promise<CommandResult> {
    switch (cmd.action) {
      case "start":    return this.startSession(cmd);
      case "attach":   return this.attachSession(cmd);
      case "vars":     return this.getVariables();
      case "stack":    return this.getStack();
      case "eval":     return this.evalExpression(cmd.expression);
      case "step":     return this.step(cmd.kind ?? "over");
      case "continue": return this.continueExecution();
      case "break":    return this.setBreakpoint(cmd.file, cmd.line, cmd.condition);
      case "source":   return this.getSource(cmd.file, cmd.line);
      case "status":   return this.getStatusAsync();
      case "output":   return { output: this.drainOutput() };
      case "context":  return this.getContext();
      case "close":    return this.close();
    }
  }

  /** Drain and return buffered stdout/stderr since last stop. */
  drainOutput(): string {
    const text = this.outputBuffer.join("");
    this.outputBuffer = [];
    return text;
  }

  private async startSession(cmd: Extract<Command, { action: "start" }>): Promise<CommandResult> {
    if (this.state !== "idle") return { error: "Session already active — run 'dapi close' first." };

    const script = pathResolve(cmd.script);
    this.state = "starting";

    this.adapter = cmd.language ? getAdapter(cmd.language) : getAdapterForFile(script);
    if (!this.adapter) {
      this.state = "idle";
      return { error: `Unsupported file type: ${script}. Supported: .py .js .ts .go .rs .c .cpp` };
    }

    const installErr = await this.adapter.checkInstalled(cmd.runtime);
    if (installErr) { this.state = "idle"; return { error: installErr }; }

    try {
      const spawnResult = await this.adapter.spawn({
        program: script,
        args: cmd.args,
        cwd: cmd.cwd ?? dirname(script),
        stopOnEntry: cmd.stop_on_entry,
        runtimePath: cmd.runtime,
      });
      this.adapterProcess = spawnResult.process;
      this.client = new DAPClient();
      await this.client.connect("127.0.0.1", spawnResult.port);
    } catch (err) {
      this.state = "idle";
      return { error: `Failed to start debug adapter: ${(err as Error).message}` };
    }

    const breakpoints = parseBreakpoints(cmd.breakpoints ?? []);
    const result = await this.adapter.initFlow(this.client, {
      program: script,
      args: cmd.args,
      cwd: cmd.cwd ?? dirname(script),
      stopOnEntry: cmd.stop_on_entry,
      runtimePath: cmd.runtime,
      breakpoints,
      exceptionFilters: cmd.exceptionFilters,
    });

    if (result.error) { this.state = "idle"; await this.cleanup(); return result; }

    if (result.status === "terminated") {
      this.state = "terminated";
      return result;
    }

    if (result.status === "paused") {
      this.state = "paused";
      const body = (this.client.drainEvents("stopped")[0]?.body ?? {}) as { threadId?: number };
      this.threadId = body.threadId ?? 1;
      await this.updateFrame();
    } else {
      this.state = "running";
    }

    return this.getAutoContext({ reason: result.reason, breakpoints: result.breakpoints });
  }

  private async attachSession(cmd: Extract<Command, { action: "attach" }>): Promise<CommandResult> {
    if (this.state !== "idle") return { error: "Session already active — run 'dapi close' first." };
    if (!cmd.port && !cmd.pid) return { error: "Either port or --pid is required" };

    this.state = "starting";
    const language = cmd.language ?? "python";
    this.adapter = getAdapter(language);
    if (!this.adapter) { this.state = "idle"; return { error: `Unknown language: ${language}` }; }
    if (!this.adapter.attachFlow) { this.state = "idle"; return { error: `Attach not supported for ${this.adapter.name}` }; }

    let host = cmd.host ?? "127.0.0.1";
    let port = cmd.port;

    if (cmd.pid) {
      if (!this.adapter.inject) { this.state = "idle"; return { error: `PID injection not supported for ${this.adapter.name}` }; }
      try {
        const injectResult = await this.adapter.inject(cmd.pid, cmd.runtime);
        port = injectResult.debuggeePort ?? injectResult.port;
        host = "127.0.0.1";
      } catch (err) {
        this.state = "idle";
        return { error: `Failed to inject into PID ${cmd.pid}: ${(err as Error).message}` };
      }
    }

    try {
      this.client = new DAPClient();
      await this.client.connect(host, port!);
    } catch (err) {
      this.state = "idle";
      this.client = null;
      return { error: `Failed to connect to ${host}:${port}: ${(err as Error).message}` };
    }

    const breakpoints = parseBreakpoints(cmd.breakpoints ?? []);
    const result = await this.adapter.attachFlow(this.client, {
      host,
      port: port!,
      runtimePath: cmd.runtime,
      breakpoints,
      exceptionFilters: cmd.exceptionFilters,
    });

    if (result.error) { this.state = "idle"; await this.cleanup(); return result; }

    this.state = "running";
    this.attachedMode = true;
    return result;
  }

  private async step(kind: string): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client || this.threadId === null) return { error: "No active session" };

    const command = kind === "into" ? "stepIn" : kind === "out" ? "stepOut" : "next";
    await this.client.request(command, { threadId: this.threadId });
    this.state = "running";
    return this.awaitStop();
  }

  private async continueExecution(): Promise<CommandResult> {
    if (this.state === "running") {
      if (!this.client) return { error: "No active session" };
      return this.awaitStop();
    }
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client || this.threadId === null) return { error: "No active session" };

    await this.client.request("continue", { threadId: this.threadId });
    this.state = "running";
    return this.awaitStop();
  }

  /** Wait for the next stop, collecting output events along the way. */
  private async awaitStop(): Promise<CommandResult> {
    if (!this.client) return { error: "No active session" };

    while (true) {
      // Collect output events each poll cycle
      for (const evt of this.client.drainEvents("output")) {
        const body = evt.body as { category?: string; output?: string };
        if (body.output && (body.category === "stdout" || body.category === "stderr" || !body.category)) {
          this.outputBuffer.push(body.output);
        }
      }

      const stopped = await this.client.waitForEvent("stopped", 1000);
      if (stopped) {
        this.state = "paused";
        const body = (stopped.body ?? {}) as { reason?: string; threadId?: number };
        this.threadId = body.threadId ?? this.threadId;
        await this.updateFrame();
        return this.getAutoContext({ reason: body.reason ?? "unknown" });
      }

      const terminated = this.client.drainEvents("terminated");
      const exited = this.client.drainEvents("exited");
      if (terminated.length || exited.length) {
        this.state = "terminated";
        const exitCode = exited.length
          ? ((exited[0]!.body as { exitCode?: number })?.exitCode ?? null)
          : null;
        const output = this.drainOutput() || undefined;
        return { status: "terminated", exitCode, output };
      }
    }
  }

  /** Bundle current location + source snippet + locals + stack + buffered output. */
  private async getAutoContext(opts: { reason?: string; breakpoints?: BreakpointInfo[] } = {}): Promise<CommandResult> {
    const location = await this.currentLocation();
    const source_snippet = location ? buildSourceSnippet(location.file, location.line) : undefined;
    const [variables, frames] = await Promise.all([
      this.getVariablesInternal(),
      this.getStackInternal(),
    ]);
    const output = this.drainOutput() || undefined;
    return {
      status: "paused",
      reason: opts.reason,
      location,
      source_snippet,
      variables,
      frames,
      output,
      breakpoints: opts.breakpoints,
    };
  }

  private async getContext(): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    return this.getAutoContext();
  }

  // ---- Standalone inspection commands ----

  async getVariables(): Promise<CommandResult> {
    const result = await this.getVariablesInternal();
    if (!result) return { error: this.state !== "paused" ? "Program is not paused" : "No frame available" };
    return { variables: result, count: result.length, location: await this.currentLocation() };
  }

  private async getVariablesInternal(): Promise<VariableInfo[] | undefined> {
    if (this.state !== "paused" || !this.client || this.frameId === null) return undefined;
    const resp = await this.client.request("scopes", { frameId: this.frameId });
    if (!resp.success) return undefined;
    const scopes = (resp.body as { scopes?: Array<{ name: string; variablesReference: number }> }).scopes ?? [];
    const result: VariableInfo[] = [];
    for (const scope of scopes) {
      if (scope.name !== "Locals" && scope.name !== "Local") continue;
      const varResp = await this.client.request("variables", { variablesReference: scope.variablesReference, count: 100 });
      if (varResp.success && varResp.body) {
        const vars = (varResp.body as { variables?: Array<{ name: string; value: string; type?: string; variablesReference: number }> }).variables ?? [];
        for (const v of vars) {
          if (this.adapter?.isInternalVariable(v as never)) continue;
          result.push({ name: v.name, value: v.value, type: v.type ?? "" });
        }
      }
    }
    return result;
  }

  async getStack(): Promise<CommandResult> {
    const frames = await this.getStackInternal();
    if (!frames) return { error: this.state !== "paused" ? "Program is not paused" : "No active session" };
    return { frames, count: frames.length };
  }

  private async getStackInternal(): Promise<LocationInfo[] | undefined> {
    if (this.state !== "paused" || !this.client || this.threadId === null) return undefined;
    const resp = await this.client.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 50 });
    if (!resp.success) return undefined;
    const rawFrames = (resp.body as { stackFrames?: Array<{ id: number; name: string; line: number; source?: { path?: string } }> }).stackFrames ?? [];
    return rawFrames
      .filter(f => !this.adapter?.isInternalFrame(f as never))
      .map(f => ({ function: f.name, file: f.source?.path ?? "", line: f.line }));
  }

  private async evalExpression(expression: string): Promise<CommandResult> {
    if (this.state !== "paused") return { error: "Program is not paused" };
    if (!this.client) return { error: "No active session" };
    const args: Record<string, unknown> = { expression, context: "repl" };
    if (this.frameId !== null) args.frameId = this.frameId;
    const resp = await this.client.request("evaluate", args);
    if (resp.success && resp.body) {
      const body = resp.body as { result: string; type?: string };
      return { result: body.result, type: body.type ?? "" };
    }
    return { error: resp.message ?? "Evaluation failed" };
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

  private async getSource(filePath?: string, line?: number): Promise<CommandResult> {
    let resolvedFile = filePath;
    let resolvedLine = line;
    if (!resolvedFile && this.state === "paused") {
      const loc = await this.currentLocation();
      if (loc) { resolvedFile = loc.file; resolvedLine ??= loc.line; }
    }
    if (!resolvedFile) return { error: "No file specified and not paused at a known location" };
    resolvedFile = pathResolve(resolvedFile);
    const snippet = buildSourceSnippet(resolvedFile, resolvedLine ?? 1);
    if (!snippet) return { error: `File not found: ${resolvedFile}` };
    return { file: resolvedFile, line: resolvedLine, source: snippet };
  }

  async getStatusAsync(): Promise<CommandResult> {
    const result: CommandResult = { state: this.state };
    if (this.state === "paused") result.location = await this.currentLocation();
    return result;
  }

  async close(): Promise<CommandResult> {
    await this.cleanup();
    this.state = "idle";
    this.threadId = null;
    this.frameId = null;
    this.outputBuffer = [];
    this.attachedMode = false;
    return { status: "closed" };
  }

  // ---- Internals ----

  private async updateFrame(): Promise<void> {
    if (!this.client || this.threadId === null) return;
    const resp = await this.client.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 1 });
    if (resp.success && resp.body) {
      const frames = (resp.body as { stackFrames?: Array<{ id: number }> }).stackFrames;
      if (frames?.length) this.frameId = frames[0]!.id;
    }
  }

  private async currentLocation(): Promise<LocationInfo | null> {
    if (!this.client || this.threadId === null) return null;
    const resp = await this.client.request("stackTrace", { threadId: this.threadId, startFrame: 0, levels: 1 });
    if (resp.success && resp.body) {
      const frames = (resp.body as { stackFrames?: Array<{ name: string; line: number; source?: { path?: string } }> }).stackFrames;
      if (frames?.length) {
        const f = frames[0]!;
        return { file: f.source?.path ?? "?", line: f.line, function: f.name };
      }
    }
    return null;
  }

  private async cleanup(): Promise<void> {
    if (this.client) {
      try { await this.client.disconnect(!this.attachedMode); } catch { /* best effort */ }
      this.client = null;
    }
    if (this.adapterProcess) {
      try {
        this.adapterProcess.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { try { this.adapterProcess?.kill("SIGKILL"); } catch { /* ignore */ } resolve(); }, 3000);
          this.adapterProcess!.once("exit", () => { clearTimeout(timer); resolve(); });
        });
      } catch { /* best effort */ }
      this.adapterProcess = null;
    }
  }
}
