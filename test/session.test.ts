import { describe, it, expect } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBreakpoints, buildSourceSnippet, Session } from "../src/session.ts";

describe("parseBreakpoints", () => {
  it("parses a single file:line", () => {
    const result = parseBreakpoints(["/abs/app.py:42"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.file).toContain("app.py");
    expect(result[0]!.lines).toEqual([42]);
    expect(result[0]!.conditions).toEqual([null]);
  });

  it("parses file:line:condition", () => {
    const result = parseBreakpoints(["/abs/app.py:10:x > 5"]);
    expect(result[0]!.conditions[0]).toBe("x > 5");
  });

  it("handles condition with colons (e.g. dict literal)", () => {
    const result = parseBreakpoints(["/abs/app.py:10:d == {'a': 1}"]);
    expect(result[0]!.conditions[0]).toBe("d == {'a': 1}");
  });

  it("groups multiple breakpoints in the same file", () => {
    const result = parseBreakpoints(["/abs/app.py:10", "/abs/app.py:20"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.lines).toEqual([10, 20]);
  });

  it("separates breakpoints in different files", () => {
    const result = parseBreakpoints(["/abs/a.py:1", "/abs/b.py:2"]);
    expect(result).toHaveLength(2);
  });

  it("skips entries without a line number", () => {
    const result = parseBreakpoints(["app.py", "noconn"]);
    expect(result).toHaveLength(0);
  });

  it("returns empty for empty input", () => {
    expect(parseBreakpoints([])).toHaveLength(0);
  });
});

describe("buildSourceSnippet", () => {
  let tmpFile: string;

  const makeFile = (lines: string[]) => {
    tmpFile = join(tmpdir(), `dapi-test-${Date.now()}.py`);
    writeFileSync(tmpFile, lines.join("\n"));
    return tmpFile;
  };

  it("marks the current line with →", () => {
    const f = makeFile(["a = 1", "b = 2", "c = 3", "d = 4", "e = 5"]);
    const snippet = buildSourceSnippet(f, 3)!;
    expect(snippet).toContain("→");
    const markedLine = snippet.split("\n").find(l => l.startsWith("→"));
    expect(markedLine).toContain("c = 3");
    unlinkSync(f);
  });

  it("does not mark other lines with →", () => {
    const f = makeFile(["a = 1", "b = 2", "c = 3"]);
    const snippet = buildSourceSnippet(f, 2)!;
    const lines = snippet.split("\n");
    const arrowLines = lines.filter(l => l.startsWith("→"));
    expect(arrowLines).toHaveLength(1);
    unlinkSync(f);
  });

  it("includes surrounding context lines", () => {
    const f = makeFile(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"]);
    const snippet = buildSourceSnippet(f, 5)!;
    expect(snippet).toContain("l1");  // up to 4 lines before
    expect(snippet).toContain("l10"); // up to 5 lines after
    unlinkSync(f);
  });

  it("works at the start of a file", () => {
    const f = makeFile(["first", "second", "third"]);
    const snippet = buildSourceSnippet(f, 1)!;
    expect(snippet).toContain("first");
    unlinkSync(f);
  });

  it("returns undefined for a missing file", () => {
    expect(buildSourceSnippet("/nonexistent/file.py", 1)).toBeUndefined();
  });
});

describe("Session", () => {
  it("starts in idle state", () => {
    const session = new Session();
    expect(session.state).toBe("idle");
  });

  it("drainOutput returns empty string when no output buffered", () => {
    const session = new Session();
    expect(session.drainOutput()).toBe("");
  });

  it("returns error for step when not paused", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "step" });
    expect(result.error).toMatch(/not paused/);
  });

  it("returns error for continue when not paused or running", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "continue" });
    expect(result.error).toMatch(/not paused/);
  });

  it("returns error for eval when not paused", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "eval", expression: "x" });
    expect(result.error).toMatch(/not paused/);
  });

  it("returns error for context when not paused", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "context" });
    expect(result.error).toMatch(/not paused/);
  });

  it("output command returns empty string initially", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "output" });
    expect(result.output).toBe("");
  });

  it("status returns idle state", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "status" });
    expect(result.state).toBe("idle");
  });

  it("close from idle state is safe", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "close" });
    expect(result.status).toBe("closed");
    expect(session.state).toBe("idle");
  });

  it("start fails gracefully on unsupported extension", async () => {
    const session = new Session();
    const result = await session.handleCommand({ action: "start", script: "/tmp/prog.xyz" });
    expect(result.error).toMatch(/Unsupported/);
    expect(session.state).toBe("idle");
  });

  it("start requires close before starting again", async () => {
    const session = new Session();
    // Manually set state to simulate an active session
    (session as unknown as { state: string }).state = "paused";
    const result = await session.handleCommand({ action: "start", script: "/tmp/app.py" });
    expect(result.error).toMatch(/already active/);
  });
});
