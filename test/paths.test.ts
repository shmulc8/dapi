import { describe, it, expect } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { BASE_DIR, socketPath, pidFile } from "../src/util/paths.ts";

describe("paths", () => {
  it("BASE_DIR is ~/.dapi", () => {
    expect(BASE_DIR).toBe(join(homedir(), ".dapi"));
  });

  it("socketPath uses session name", () => {
    expect(socketPath("default")).toBe(join(homedir(), ".dapi", "default.sock"));
    expect(socketPath("myapp")).toBe(join(homedir(), ".dapi", "myapp.sock"));
  });

  it("pidFile uses session name", () => {
    expect(pidFile("default")).toBe(join(homedir(), ".dapi", "default.pid"));
    expect(pidFile("worker-1")).toBe(join(homedir(), ".dapi", "worker-1.pid"));
  });

  it("different sessions get different paths", () => {
    expect(socketPath("a")).not.toBe(socketPath("b"));
    expect(pidFile("a")).not.toBe(pidFile("b"));
  });
});
