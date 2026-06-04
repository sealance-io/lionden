import { describe, expect, it } from "vitest";
import { selectMatchingTransition } from "./transition-selector.js";
import type { ConfirmedTransitionRecord } from "./types.js";
import { TransitionSelectionError } from "./types.js";

const record = (
  programId: string,
  transitionName: string,
  outputs: readonly string[] = [],
): ConfirmedTransitionRecord => ({
  programId,
  transitionName,
  rawOutputs: outputs,
  transitionPublicKey: `tpk_${programId}_${transitionName}`,
});

describe("selectMatchingTransition", () => {
  it("returns the single matching transition", () => {
    const transitions = [
      record("token.aleo", "transfer_public", ["1u64"]),
      record("token.aleo", "approve", []),
    ];

    const match = selectMatchingTransition("token.aleo", "transfer_public", transitions);

    expect(match.programId).toBe("token.aleo");
    expect(match.transitionName).toBe("transfer_public");
    expect(match.rawOutputs).toEqual(["1u64"]);
  });

  it("throws TransitionSelectionError with available transitions when nothing matches", () => {
    const transitions = [record("token.aleo", "approve", []), record("vault.aleo", "deposit", [])];

    const callBad = () => selectMatchingTransition("token.aleo", "transfer_public", transitions);

    expect(callBad).toThrowError(TransitionSelectionError);
    try {
      callBad();
    } catch (err) {
      const error = err as TransitionSelectionError;
      expect(error.matchCount).toBe(0);
      expect(error.programId).toBe("token.aleo");
      expect(error.transitionName).toBe("transfer_public");
      expect(error.availableTransitions).toEqual(["token.aleo/approve", "vault.aleo/deposit"]);
      expect(error.message).toContain("did not contain a matching transition");
    }
  });

  it("throws TransitionSelectionError pointing at the escape hatch when multiple match", () => {
    const transitions = [
      record("token.aleo", "transfer_public", ["1u64"]),
      record("token.aleo", "transfer_public", ["2u64"]),
    ];

    const callBad = () => selectMatchingTransition("token.aleo", "transfer_public", transitions);

    expect(callBad).toThrowError(TransitionSelectionError);
    try {
      callBad();
    } catch (err) {
      const error = err as TransitionSelectionError;
      expect(error.matchCount).toBe(2);
      expect(error.message).toContain("awaitConfirmation: false");
      expect(error.message).toContain("waitForConfirmation");
      expect(error.txId).toBeUndefined();
    }
  });

  it("surfaces the broadcast txId in the error when supplied", () => {
    const transitions = [
      record("token.aleo", "transfer_public", ["1u64"]),
      record("token.aleo", "transfer_public", ["2u64"]),
    ];

    try {
      selectMatchingTransition("token.aleo", "transfer_public", transitions, "at1broadcast");
      throw new Error("expected throw");
    } catch (err) {
      const error = err as TransitionSelectionError;
      expect(error).toBeInstanceOf(TransitionSelectionError);
      expect(error.txId).toBe("at1broadcast");
      expect(error.message).toContain("at1broadcast");
      expect(error.message).toContain(`waitForConfirmation("at1broadcast")`);
    }
  });
});
