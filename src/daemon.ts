/** Background daemon — holds the DAP session, accepts CLI commands via Unix socket.
 *
 * Usage: bun run src/daemon.ts [session-name]
 * Session name defaults to "default". Socket lives at ~/.dapi/<session>.sock.
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { BASE_DIR, socketPath, pidFile } from "./util/paths.js";
import { Session } from "./session.js";
import { Command } from "./protocol.js";

const sessionName = process.argv[2] ?? "default";
const SOCKET_PATH = socketPath(sessionName);
const PID_FILE = pidFile(sessionName);

class Daemon {
  private session = new Session();
  private server: Server | null = null;
  private isShuttingDown = false;

  start(): void {
    mkdirSync(BASE_DIR, { recursive: true });

    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
    writeFileSync(PID_FILE, String(process.pid));

    this.server = createServer((conn) => { this.handleConnection(conn); });
    this.server.listen(SOCKET_PATH);

    const shutdown = (signal: string) => {
      if (this.isShuttingDown) return;
      this.isShuttingDown = true;
      process.stderr.write(`Daemon [${sessionName}] received ${signal}, shutting down...\n`);
      this.cleanup();
    };

    process.on("SIGTERM", () => { shutdown("SIGTERM"); setTimeout(() => process.exit(1), 5_000).unref(); });
    process.on("SIGINT",  () => { shutdown("SIGINT");  setTimeout(() => process.exit(1), 5_000).unref(); });
    process.on("uncaughtException", (err) => {
      process.stderr.write(`Daemon [${sessionName}] uncaught: ${err.message}\n`);
      shutdown("uncaughtException");
    });
  }

  private handleConnection(conn: Socket): void {
    let data = "";
    let processed = false;

    conn.on("data", (chunk) => {
      if (processed) return;
      data += chunk.toString();
      const nlIdx = data.indexOf("\n");
      const toParse = nlIdx !== -1 ? data.substring(0, nlIdx) : data;
      try {
        const cmd = JSON.parse(toParse) as Record<string, unknown>;
        processed = true;
        this.processCommand(cmd, conn);
      } catch { /* wait for more data */ }
    });

    conn.on("end", () => {
      if (!processed && data.trim()) {
        try {
          const cmd = JSON.parse(data.trim()) as Record<string, unknown>;
          processed = true;
          this.processCommand(cmd, conn);
        } catch { this.sendResponse(conn, { error: "Invalid JSON" }); }
      }
    });

    conn.on("error", () => { /* client disconnected */ });
  }

  private async processCommand(rawCmd: Record<string, unknown>, conn: Socket): Promise<void> {
    try {
      const parsed = Command.safeParse(rawCmd);
      if (!parsed.success) {
        this.sendResponse(conn, { error: `Invalid command: ${parsed.error.message}` });
        return;
      }
      const result = await this.session.handleCommand(parsed.data);
      this.sendResponse(conn, result as Record<string, unknown>);
      if (parsed.data.action === "close") setTimeout(() => this.cleanup(), 100);
    } catch (err) {
      this.sendResponse(conn, { error: (err as Error).message });
    }
  }

  private sendResponse(conn: Socket, result: Record<string, unknown>): void {
    try { conn.write(JSON.stringify(result) + "\n"); conn.end(); } catch { /* client gone */ }
  }

  private cleanup(): void {
    this.session.close().catch(() => {});
    if (this.server) { this.server.close(); this.server = null; }
    try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
    try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* ignore */ }
    process.exitCode = 0;
  }
}

const daemon = new Daemon();
daemon.start();
