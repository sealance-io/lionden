import type { ConfirmedTransitionRecord } from "./types.js";
import { TransitionSelectionError } from "./types.js";

// TODO(unify): converge with BaseContract.selectAcceptedTransition in
// packages/leo-compiler/src/codegen/contract-wrapper.ts. The generated
// template inlines an equivalent guard; once we regenerate typechain
// goldens we can have the template import this helper directly.

/**
 * Pick the single transition matching `(programId, transitionName)` from a
 * confirmed transaction's `transitions[]`. Throws `TransitionSelectionError`
 * on zero matches and on multiple matches.
 *
 * Reentrant or recursive flows produce multiple matches; the error message
 * directs callers to opt out of the default await with
 * `{ awaitConfirmation: false }` and inspect transitions directly via
 * `connection.waitForConfirmation(txId)`. Pass `txId` so the error can quote
 * the broadcast id — without it, `execute({ awaitConfirmation: true })`
 * callers lose the handle they need to recover the confirmed transaction.
 */
export function selectMatchingTransition(
  programId: string,
  transitionName: string,
  transitions: readonly ConfirmedTransitionRecord[],
  txId?: string,
): ConfirmedTransitionRecord {
  const matches = transitions.filter(
    (t) => t.programId === programId && t.transitionName === transitionName,
  );
  const available = transitions.map((t) => `${t.programId}/${t.transitionName}`);
  const txIdSuffix = txId === undefined ? "" : ` (txId ${txId})`;
  if (matches.length === 0) {
    throw new TransitionSelectionError(
      `Confirmed transaction${txIdSuffix} did not contain a matching transition for ${programId}/${transitionName}. Available: ${available.join(", ") || "(none)"}.`,
      {
        programId,
        transitionName,
        matchCount: 0,
        availableTransitions: available,
        ...(txId === undefined ? {} : { txId }),
      },
    );
  }
  if (matches.length > 1) {
    const recoverHint =
      txId === undefined
        ? "call connection.waitForConfirmation(txId) directly to inspect all transitions"
        : `call connection.waitForConfirmation("${txId}") directly to inspect all transitions`;
    throw new TransitionSelectionError(
      `Confirmed transaction${txIdSuffix} contained ${matches.length} transitions matching ${programId}/${transitionName}. Cannot pick outputs unambiguously. For reentrant or recursive flows, pass { awaitConfirmation: false } to execute() and ${recoverHint}.`,
      {
        programId,
        transitionName,
        matchCount: matches.length,
        availableTransitions: available,
        ...(txId === undefined ? {} : { txId }),
      },
    );
  }
  return matches[0]!;
}
