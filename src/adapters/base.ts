/** Base adapter interface for debug adapters. */

import type { ChildProcess } from "node:child_process";
import type { DAPClient } from "../dap-client.js";
import type { StackFrame, Variable } from "../dap-types.js";
import type { CommandResult } from "../protocol.js";

export interface SpawnResult {
  process: ChildProcess;
  port: number;
}

export interface LaunchOpts {
  program: string;
  args?: string[];
  cwd?: string;
  stopOnEntry?: boolean;
  runtimePath?: string;
}

export interface InitFlowOpts extends LaunchOpts {
  breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
  exceptionFilters?: string[];
}

export interface AttachFlowOpts {
  host: string;
  port: number;
  runtimePath?: string;
  breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
  exceptionFilters?: string[];
}

export interface InjectResult {
  process: ChildProcess;
  port: number;
  debuggeePort?: number;
}

export interface AdapterConfig {
  name: string;

  checkInstalled(runtimePath?: string): Promise<string | null>;
  spawn(opts: LaunchOpts): Promise<SpawnResult>;
  initializeArgs(): Record<string, unknown>;
  launchArgs(opts: LaunchOpts): Record<string, unknown>;
  initFlow(client: DAPClient, opts: InitFlowOpts): Promise<CommandResult>;
  inject?(pid: number, runtimePath?: string): Promise<InjectResult>;
  attachFlow?(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult>;
  isInternalFrame(frame: StackFrame): boolean;
  isInternalVariable(v: Variable): boolean;
}
