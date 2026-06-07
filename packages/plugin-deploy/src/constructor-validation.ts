import type { ConstructorInfo } from "./constructor-parser.js";
import { isValidAleoAddress } from "./constructor-parser.js";
import { DeployError } from "./errors.js";

export const CUSTOM_CONSTRUCTOR_WARNING_CODE = "CUSTOM_CONSTRUCTOR";

type CustomConstructorPhase = "deployment" | "upgrade";

export interface ConstructorValidationOptions {
  readonly emitCustomWarning?: boolean;
  readonly warn?: (message: string) => void;
}

export interface ConstructorValidationWarning {
  readonly code: typeof CUSTOM_CONSTRUCTOR_WARNING_CODE;
  readonly message: string;
}

export function createCustomConstructorWarning(
  programId: string,
  phase: CustomConstructorPhase,
): ConstructorValidationWarning {
  return {
    code: CUSTOM_CONSTRUCTOR_WARNING_CODE,
    message:
      `Program "${programId}" uses @custom constructor. ` +
      `Custom constructor logic will be evaluated on-chain during ${phase}.`,
  };
}

export function formatCustomConstructorWarning(programId: string): string {
  return (
    `Warning: Program "${programId}" uses @custom constructor. ` +
    `Custom constructor logic will be evaluated on-chain during deployment.`
  );
}

/**
 * Validate the constructor annotation. Per ARC-0006:
 * - ALL deployments MUST have a constructor — hard error if missing
 * - @admin addresses must be valid Aleo addresses
 * - @checksum must specify a mapping reference and key
 * - @custom triggers a warning about on-chain evaluation unless disabled
 */
export function validateConstructorAnnotation(
  ctor: ConstructorInfo | null,
  programId: string,
  options: ConstructorValidationOptions = {},
): void {
  if (!ctor) {
    throw new DeployError(
      `Program "${programId}" has no constructor annotation.\n\n` +
        `Per ARC-0006, all deployments require a constructor. ` +
        `Add one of the following to your program:\n\n` +
        `  @noupgrade\n` +
        `  constructor() { ... }\n\n` +
        `  @admin(address="aleo1...")\n` +
        `  constructor() { ... }\n\n` +
        `  @checksum(mapping="prog.aleo::map_name", key="value")\n` +
        `  constructor() { ... }\n\n` +
        `  @custom\n` +
        `  constructor() { ... }\n`,
    );
  }

  if (ctor.type === "admin") {
    if (!ctor.adminAddress) {
      throw new DeployError(
        `Program "${programId}" has @admin constructor but no address specified.\n` +
          `Usage: @admin(address="aleo1...")`,
      );
    }
    if (!isValidAleoAddress(ctor.adminAddress)) {
      throw new DeployError(
        `Program "${programId}" has @admin constructor with invalid address: ` +
          `"${ctor.adminAddress}"\n` +
          `Aleo addresses must start with "aleo1" and be 63 characters long.`,
      );
    }
  }

  if (ctor.type === "checksum") {
    if (!ctor.checksumMapping) {
      throw new DeployError(
        `Program "${programId}" has @checksum constructor but no mapping specified.\n` +
          `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
      );
    }
    if (!ctor.checksumKey) {
      throw new DeployError(
        `Program "${programId}" has @checksum constructor but no key specified.\n` +
          `Usage: @checksum(mapping="prog.aleo::map_name", key="value")`,
      );
    }
  }

  if (ctor.type === "custom" && (options.emitCustomWarning ?? true)) {
    const warn = options.warn ?? console.warn;
    warn(formatCustomConstructorWarning(programId));
  }
}
