/** Human-readable formatting for CommandResult — used by the CLI and tested independently. */

import type { CommandResult } from "./protocol.js";

export function formatResult(result: CommandResult): string {
  if (result.error) return `Error: ${result.error}`;

  // Auto-context (start, step, continue, context)
  if (result.status === "paused" && result.location) {
    return formatAutoContext(result);
  }

  // Terminated
  if (result.status === "terminated") {
    const exit = result.exitCode !== undefined && result.exitCode !== null ? ` (exit ${result.exitCode})` : "";
    const out = result.output ? `\n\nOutput:\n${result.output.trimEnd()}` : "";
    return `Program terminated${exit}${out}`;
  }

  // Closed
  if (result.status === "closed") return "Session closed.";

  // Eval
  if (result.result !== undefined) {
    return result.type ? `${result.result}  (${result.type})` : result.result;
  }

  // Source (standalone)
  if (result.source) return result.source;

  // Breakpoint set
  if (result.verified !== undefined) {
    const v = result.verified ? "verified" : "pending";
    return `Breakpoint ${v}: ${result.file}:${result.line}`;
  }

  // vars (standalone)
  if (result.variables && !result.location) {
    if (!result.variables.length) return "(no local variables)";
    return result.variables.map(v => `  ${v.name} = ${v.value}${v.type ? `  (${v.type})` : ""}`).join("\n");
  }

  // stack (standalone)
  if (result.frames && !result.location) {
    if (!result.frames.length) return "(empty stack)";
    return result.frames.map((f, i) => {
      const marker = i === 0 ? "→" : " ";
      return `  ${marker} ${f.function} at ${f.file}:${f.line}`;
    }).join("\n");
  }

  // output (standalone)
  if (result.output !== undefined && !result.location) {
    return result.output.trimEnd() || "(no output)";
  }

  // status
  if (result.state) {
    const loc = result.location;
    const locStr = loc ? `\n  at ${loc.file}:${loc.line} in ${loc.function}` : "";
    return `State: ${result.state}${locStr}`;
  }

  // attach running (breakpoints set, waiting for trigger)
  if (result.status === "running") {
    const lines = ["Attached — program is running."];
    for (const bp of result.breakpoints ?? []) {
      lines.push(`  Breakpoint ${bp.verified ? "verified" : "pending"}: ${bp.file}:${bp.line}`);
    }
    lines.push("  Run 'dapi continue' to wait for a breakpoint hit.");
    return lines.join("\n");
  }

  return JSON.stringify(result, null, 2);
}

function formatAutoContext(result: CommandResult): string {
  const loc = result.location!;
  const reason = result.reason ? ` [${result.reason}]` : "";
  const lines: string[] = [
    `Stopped at ${loc.function}() · ${loc.file}:${loc.line}${reason}`,
  ];

  if (result.source_snippet) {
    lines.push("", result.source_snippet);
  }

  if (result.variables?.length) {
    lines.push("", "Locals:");
    for (const v of result.variables) {
      lines.push(`  ${v.name} = ${v.value}${v.type ? `  (${v.type})` : ""}`);
    }
  }

  if (result.frames?.length) {
    lines.push("", "Stack:");
    for (const f of result.frames) {
      lines.push(`  ${f.function} [${f.file}:${f.line}]`);
    }
  }

  if (result.breakpoints?.length) {
    lines.push("", "Breakpoints set:");
    for (const bp of result.breakpoints) {
      lines.push(`  ${bp.verified ? "✓" : "?"} ${bp.file}:${bp.line}`);
    }
  }

  if (result.output?.trim()) {
    lines.push("", "Output:", result.output.trimEnd());
  }

  return lines.join("\n");
}
