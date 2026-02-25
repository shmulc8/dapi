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
  /** Path to language runtime (e.g. python3, node, dlv) */
  runtimePath?: string;
}

export interface InitFlowOpts extends LaunchOpts {
  breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
}

export interface AttachFlowOpts {
  host: string;
  port: number;
  /** Path to language runtime (needed to spawn adapter). */
  runtimePath?: string;
  breakpoints?: Array<{ file: string; lines: number[]; conditions?: Array<string | null> }>;
}

export interface InjectResult {
  process: ChildProcess;
  /** Port for the DAP client to connect to (adapter port). */
  port: number;
  /** Port where debugpy is listening inside the debuggee (for adapter routing). */
  debuggeePort?: number;
}

export interface AdapterConfig {
  name: string;

  /** Check if the debug adapter is installed. Returns null if OK, error message if not. */
  checkInstalled(runtimePath?: string): Promise<string | null>;

  /** Spawn the debug adapter process. Returns the child process and DAP port. */
  spawn(opts: LaunchOpts): Promise<SpawnResult>;

  /** Arguments for the DAP initialize request. */
  initializeArgs(): Record<string, unknown>;

  /** Arguments for the DAP launch request. */
  launchArgs(opts: LaunchOpts): Record<string, unknown>;

  /**
   * Adapter-specific DAP initialization flow.
   * Handles quirks like debugpy's deferred launch response.
   */
  initFlow(client: DAPClient, opts: InitFlowOpts): Promise<CommandResult>;

  /**
   * Inject the debug adapter into a running process by PID.
   * Returns the child process and the DAP port to connect to.
   */
  inject?(pid: number, runtimePath?: string): Promise<InjectResult>;

  /**
   * Adapter-specific DAP attach flow for connecting to an already-running debuggee.
   * Returns null if this adapter does not support attach.
   */
  attachFlow?(client: DAPClient, opts: AttachFlowOpts): Promise<CommandResult>;

  /** Filter internal frames (e.g. debugpy/pydevd internals). */
  isInternalFrame(frame: StackFrame): boolean;

  /** Filter internal variables (e.g. __dunder__ vars). */
  isInternalVariable(v: Variable): boolean;
}
