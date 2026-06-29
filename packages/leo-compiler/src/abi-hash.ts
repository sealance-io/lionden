import * as crypto from "node:crypto";
import { parseAbi } from "./abi-parser.js";
import type { ProgramABI, TransitionABI, ViewABI } from "./abi-types.js";

/**
 * Compute the canonical ABI fingerprint used by deploy and upgrade state.
 *
 * Empty Leo 4.1 extension fields are intentionally omitted so programs that do
 * not use views, interface inheritance, or const parameters keep their legacy
 * hash.
 *
 * This hash is RECORDED ONLY — it is written into deploy/upgrade records but is
 * never compared as a correctness gate (the upgrade gate is the version-agnostic
 * comparator in `@lionden/plugin-deploy`'s `checkAbiCompatibility`). It will
 * therefore drift cosmetically across the Leo 4.1 → 4.2 cutover (input names are
 * synthesized, modes/self-refs/implements/const-params are canonicalized), which
 * is harmless.
 */
export function computeAbiHash(abi: ProgramABI): string {
  const normalized = normalizeAbiForHash(abi);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeAbiForHash(normalized)))
    .digest("hex");
}

function canonicalizeAbiForHash(abi: ProgramABI): ProgramABI {
  const canonical: ProgramABI = {
    program: abi.program,
    structs: abi.structs,
    records: abi.records,
    mappings: abi.mappings,
    storage_variables: abi.storage_variables,
    transitions: abi.transitions.map(canonicalizeTransition),
  };

  if (abi.views && abi.views.length > 0) {
    (canonical as { views: readonly ViewABI[] }).views = abi.views.map(canonicalizeView);
  }
  if (abi.implements && abi.implements.length > 0) {
    (canonical as { implements: ProgramABI["implements"] }).implements = abi.implements;
  }

  return canonical;
}

function normalizeAbiForHash(abi: ProgramABI): ProgramABI {
  const raw = abi as unknown as Record<string, unknown>;
  if (
    Array.isArray(raw["structs"]) &&
    Array.isArray(raw["records"]) &&
    Array.isArray(raw["mappings"]) &&
    Array.isArray(raw["storage_variables"]) &&
    Array.isArray(raw["transitions"])
  ) {
    return abi;
  }
  return parseAbi(JSON.stringify(raw));
}

function canonicalizeTransition(transition: TransitionABI): TransitionABI {
  const canonical: TransitionABI = {
    name: transition.name,
    is_async: transition.is_async,
    inputs: transition.inputs,
    outputs: transition.outputs,
  };
  if (transition.const_parameters && transition.const_parameters.length > 0) {
    (canonical as { const_parameters: TransitionABI["const_parameters"] }).const_parameters =
      transition.const_parameters;
  }
  return canonical;
}

function canonicalizeView(view: ViewABI): ViewABI {
  const canonical: ViewABI = {
    name: view.name,
    inputs: view.inputs,
    outputs: view.outputs,
  };
  if (view.const_parameters && view.const_parameters.length > 0) {
    (canonical as { const_parameters: ViewABI["const_parameters"] }).const_parameters =
      view.const_parameters;
  }
  return canonical;
}
