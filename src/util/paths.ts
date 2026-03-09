import { join } from "node:path";
import { homedir } from "node:os";

export const BASE_DIR = join(homedir(), ".dapi");

export function socketPath(session: string): string {
  return join(BASE_DIR, `${session}.sock`);
}

export function pidFile(session: string): string {
  return join(BASE_DIR, `${session}.pid`);
}
