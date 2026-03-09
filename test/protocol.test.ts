import { describe, it, expect } from "bun:test";
import { Command } from "../src/protocol.ts";

describe("Command parsing", () => {
  it("parses start with script", () => {
    const cmd = Command.parse({ action: "start", script: "app.py" });
    expect(cmd.action).toBe("start");
    if (cmd.action === "start") expect(cmd.script).toBe("app.py");
  });

  it("parses start with exceptionFilters", () => {
    const cmd = Command.parse({ action: "start", script: "app.py", exceptionFilters: ["raised", "uncaught"] });
    if (cmd.action === "start") expect(cmd.exceptionFilters).toEqual(["raised", "uncaught"]);
  });

  it("parses attach with pid", () => {
    const cmd = Command.parse({ action: "attach", pid: 1234 });
    if (cmd.action === "attach") expect(cmd.pid).toBe(1234);
  });

  it("parses attach with exceptionFilters", () => {
    const cmd = Command.parse({ action: "attach", port: 5678, exceptionFilters: ["all"] });
    if (cmd.action === "attach") expect(cmd.exceptionFilters).toEqual(["all"]);
  });

  it("parses output command", () => {
    const cmd = Command.parse({ action: "output" });
    expect(cmd.action).toBe("output");
  });

  it("parses context command", () => {
    const cmd = Command.parse({ action: "context" });
    expect(cmd.action).toBe("context");
  });

  it("parses step with kind", () => {
    const cmd = Command.parse({ action: "step", kind: "into" });
    if (cmd.action === "step") expect(cmd.kind).toBe("into");
  });

  it("parses eval", () => {
    const cmd = Command.parse({ action: "eval", expression: "x + 1" });
    if (cmd.action === "eval") expect(cmd.expression).toBe("x + 1");
  });

  it("rejects unknown action", () => {
    expect(() => Command.parse({ action: "unknown" })).toThrow();
  });

  it("rejects start without script", () => {
    expect(() => Command.parse({ action: "start" })).toThrow();
  });

  it("rejects step with invalid kind", () => {
    expect(() => Command.parse({ action: "step", kind: "sideways" })).toThrow();
  });
});
