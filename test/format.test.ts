import { describe, it, expect } from "bun:test";
import { formatResult } from "../src/format.ts";

describe("formatResult", () => {
  it("formats error", () => {
    expect(formatResult({ error: "something went wrong" })).toBe("Error: something went wrong");
  });

  it("formats terminated with exit code", () => {
    const out = formatResult({ status: "terminated", exitCode: 1 });
    expect(out).toContain("terminated");
    expect(out).toContain("exit 1");
  });

  it("formats terminated without exit code", () => {
    const out = formatResult({ status: "terminated" });
    expect(out).toContain("terminated");
  });

  it("formats terminated with output", () => {
    const out = formatResult({ status: "terminated", exitCode: 0, output: "hello\n" });
    expect(out).toContain("Output:");
    expect(out).toContain("hello");
  });

  it("formats closed", () => {
    expect(formatResult({ status: "closed" })).toBe("Session closed.");
  });

  it("formats eval result", () => {
    expect(formatResult({ result: "42", type: "int" })).toContain("42");
    expect(formatResult({ result: "42", type: "int" })).toContain("int");
  });

  it("formats eval result without type", () => {
    expect(formatResult({ result: "hello" })).toBe("hello");
  });

  it("formats breakpoint verified", () => {
    const out = formatResult({ verified: true, file: "app.py", line: 42 });
    expect(out).toContain("verified");
    expect(out).toContain("app.py");
    expect(out).toContain("42");
  });

  it("formats breakpoint pending", () => {
    expect(formatResult({ verified: false, file: "app.py", line: 10 })).toContain("pending");
  });

  it("formats standalone vars", () => {
    const out = formatResult({
      variables: [
        { name: "x", value: "5", type: "int" },
        { name: "items", value: "[]", type: "list" },
      ],
      count: 2,
    });
    expect(out).toContain("x = 5");
    expect(out).toContain("items = []");
  });

  it("formats empty vars", () => {
    expect(formatResult({ variables: [], count: 0 })).toContain("no local variables");
  });

  it("formats standalone stack", () => {
    const out = formatResult({
      frames: [
        { function: "compute", file: "app.py", line: 41 },
        { function: "main", file: "app.py", line: 10 },
      ],
    });
    expect(out).toContain("compute");
    expect(out).toContain("main");
    expect(out).toContain("→");  // first frame marked
  });

  it("formats status", () => {
    const out = formatResult({ state: "paused", location: { file: "app.py", line: 5, function: "foo" } });
    expect(out).toContain("paused");
    expect(out).toContain("app.py");
  });

  it("formats auto-context (paused with location)", () => {
    const out = formatResult({
      status: "paused",
      reason: "breakpoint",
      location: { file: "app.py", line: 41, function: "compute" },
      source_snippet: "   40 │ result = None\n→   41 │ return result",
      variables: [{ name: "result", value: "None", type: "NoneType" }],
      frames: [
        { function: "compute", file: "app.py", line: 41 },
        { function: "main", file: "app.py", line: 10 },
      ],
      output: "Starting...\n",
    });
    expect(out).toContain("compute");
    expect(out).toContain("app.py:41");
    expect(out).toContain("[breakpoint]");
    expect(out).toContain("return result");
    expect(out).toContain("result = None");
    expect(out).toContain("Stack:");
    expect(out).toContain("Output:");
    expect(out).toContain("Starting...");
  });

  it("auto-context omits sections that are empty", () => {
    const out = formatResult({
      status: "paused",
      location: { file: "app.py", line: 1, function: "main" },
    });
    expect(out).not.toContain("Locals:");
    expect(out).not.toContain("Stack:");
    expect(out).not.toContain("Output:");
  });

  it("formats attach running state", () => {
    const out = formatResult({
      status: "running",
      breakpoints: [{ file: "app.py", line: 42, verified: true }],
    });
    expect(out).toContain("running");
    expect(out).toContain("continue");
    expect(out).toContain("app.py:42");
  });

  it("formats standalone output", () => {
    expect(formatResult({ output: "hello world" })).toContain("hello world");
  });

  it("formats empty standalone output", () => {
    expect(formatResult({ output: "" })).toContain("no output");
  });
});
