/**
 * The Leo backend's single error class.
 *
 * One class rather than a hierarchy, matching the tone of `devnode-backend.ts`:
 * every failure here is "the Leo CLI could not produce a transaction", and the
 * useful discrimination is the `stage` field plus a message that always ends in
 * a concrete remedy.
 */

import { DeployError } from "../../errors.js";

export type LeoDeployStage = "version-gate" | "package" | "spawn" | "run" | "timeout" | "outcome";

export interface LeoDeployErrorDetails {
  readonly programId?: string;
  readonly stage: LeoDeployStage;
  readonly exitCode?: number | null;
  /** Already redacted by the runner. */
  readonly stderrTail?: string;
}

/**
 * Extends `DeployError` so existing task-level handling and tests that match on
 * it keep working.
 *
 * The stderr tail is folded into `message` rather than kept in a side field on
 * purpose: `bin.ts` prints only `error.message`, so a separate field is
 * silently dropped — exactly the existing usability bug that makes
 * `CompilationError`'s stderr invisible.
 */
export class LeoDeployError extends DeployError {
  readonly programId: string | undefined;
  readonly stage: LeoDeployStage;
  readonly exitCode: number | null | undefined;
  readonly stderrTail: string | undefined;

  constructor(message: string, details: LeoDeployErrorDetails) {
    super(composeMessage(message, details.stderrTail));
    this.name = "LeoDeployError";
    this.programId = details.programId;
    this.stage = details.stage;
    this.exitCode = details.exitCode;
    this.stderrTail = details.stderrTail;
  }
}

function composeMessage(message: string, stderrTail: string | undefined): string {
  const tail = stderrTail?.trim();
  if (!tail) return message;
  return `${message}\n\nLeo output (tail):\n${tail}`;
}
