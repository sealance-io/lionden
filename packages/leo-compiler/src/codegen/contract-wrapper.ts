/**
 * Base contract wrapper class template.
 * Generated wrappers extend this class.
 */
export const CONTRACT_WRAPPER_TEMPLATE = `\
import type { LionDenRuntimeEnvironment } from "@lionden/core";

export type ExecutionMode = "local" | "onchain";

export interface CallOptions {
  mode?: ExecutionMode;
  fee?: number;
  privateFee?: boolean;
  /**
   * Generate real proofs during on-chain execution.
   * When false (default), devnode connections use the fast-path builder
   * which skips proof generation. When true, real proofs are generated
   * (significantly slower). Has no effect in "local" mode or on
   * non-devnode connections.
   */
  prove?: boolean;
}

export interface LocalCallOptions extends Omit<CallOptions, "mode"> {
  mode?: never;
}

export interface BroadcastOptions extends Omit<CallOptions, "mode"> {
  mode?: never;
}

export interface TransitionCallResult {
  /** Raw outputs from the transition as Leo-encoded strings */
  readonly outputs: string[];
  /** Transaction ID (only set for on-chain execution) */
  readonly txId?: string;
}

export abstract class BaseContract {
  protected readonly programId: string;
  protected lre: LionDenRuntimeEnvironment | null = null;

  constructor(programId: string) {
    this.programId = programId;
  }

  /** Connect this contract wrapper to an LRE instance */
  connect(lre: LionDenRuntimeEnvironment): this {
    this.lre = lre;
    return this;
  }

  protected getLre(): LionDenRuntimeEnvironment {
    if (!this.lre) {
      throw new Error("Contract not connected to LRE. Call .connect(lre) first.");
    }
    return this.lre;
  }

  /**
   * Execute a transition on this program.
   * Routes through the LRE's network interface.
   *
   * @param transitionName - the function name (e.g. "transfer")
   * @param args - Leo-encoded argument strings (e.g. ["aleo1...", "100u64"])
   * @param options - execution mode and fee options
   */
  protected async execute(
    transitionName: string,
    args: string[],
    options: CallOptions = {},
  ): Promise<TransitionCallResult> {
    const lre = this.getLre();
    const network = lre.network as any;

    if (!network || typeof network.execute !== "function") {
      throw new Error(
        \`Network not available on LRE. Ensure @lionden/plugin-network is loaded \` +
        \`and a network connection is established before calling transitions.\`
      );
    }

    return network.execute(this.programId, transitionName, args, options);
  }

  /**
   * Execute a transition locally and return raw Leo outputs.
   * Generated typed wrappers deserialize this path into JS values.
   */
  protected async executeLocal(
    transitionName: string,
    args: string[],
    options: LocalCallOptions = {},
  ): Promise<TransitionCallResult> {
    return this.execute(transitionName, args, {
      ...options,
      mode: "local",
    });
  }

  /**
   * Broadcast a transition on-chain and return the transaction metadata.
   */
  protected async broadcast(
    transitionName: string,
    args: string[],
    options: BroadcastOptions = {},
  ): Promise<TransitionCallResult> {
    const result = await this.execute(transitionName, args, {
      ...options,
      mode: "onchain",
    });
    if (!result.txId) {
      throw new Error(
        \`Expected on-chain execution of \${this.programId}/\${transitionName} to return a transaction ID.\`,
      );
    }
    return result;
  }

  /**
   * Query a mapping value from this program.
   * Routes through the LRE's network interface.
   *
   * @param mappingName - the mapping name (e.g. "balances")
   * @param key - Leo-encoded key string (e.g. "aleo1...")
   */
  protected async queryMapping(
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    const lre = this.getLre();
    const network = lre.network as any;

    if (!network || typeof network.getMappingValue !== "function") {
      throw new Error(
        \`Network not available on LRE. Ensure @lionden/plugin-network is loaded \` +
        \`and a network connection is established before querying mappings.\`
      );
    }

    return network.getMappingValue(this.programId, mappingName, key);
  }

  // ---------------------------------------------------------------------------
  // Leo string → JS value parsers
  // ---------------------------------------------------------------------------

  /** Strip a Leo type suffix and return the raw string. "100u64" → "100" */
  static stripSuffix(value: string): string {
    return value.replace(/(?:u(?:8|16|32|64|128)|i(?:8|16|32|64|128)|field|group|scalar|bool|address)$/i, "");
  }

  /** Parse a Leo boolean string. "true" → true */
  static parseBoolean(value: string): boolean {
    return value === "true";
  }

  /** Parse a Leo integer string to number. "42u32" → 42 */
  static parseNumber(value: string): number {
    return Number(BaseContract.stripSuffix(value));
  }

  /** Parse a Leo integer string to bigint. "100u64" → 100n */
  static parseBigInt(value: string): bigint {
    return BigInt(BaseContract.stripSuffix(value));
  }

  /** Parse a Leo string value (address/field/group/scalar) — returned as-is. */
  static parseString(value: string): string {
    return value;
  }

  /**
   * Parse a Leo array string into its elements using depth-aware splitting.
   * Format: "[elem1, elem2, ...]"
   * Handles nested structs, records, and arrays that contain commas.
   */
  static parseArray(value: string): string[] {
    const trimmed = value.trim();
    const inner = trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1).trim()
      : trimmed;

    if (inner.length === 0) return [];

    const elements: string[] = [];
    let depth = 0;
    let current = "";

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;

      if (depth === 0 && ch === ",") {
        elements.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    if (current.trim()) {
      elements.push(current.trim());
    }

    return elements;
  }

  /**
   * Parse a Leo struct string into a plain object.
   * Format: "{ field1: value1, field2: value2 }"
   * Returns a Record<string, string> with raw field values for further parsing.
   */
  static parseStruct(value: string): Record<string, string> {
    const trimmed = value.trim();
    const inner = trimmed.startsWith("{") && trimmed.endsWith("}")
      ? trimmed.slice(1, -1).trim()
      : trimmed;

    const result: Record<string, string> = {};
    let depth = 0;
    let current = "";
    let key = "";

    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i]!;
      if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") depth--;

      if (depth === 0 && ch === ":" && !key) {
        key = current.trim();
        current = "";
      } else if (depth === 0 && ch === ",") {
        if (key) {
          result[key] = current.trim();
          key = "";
        }
        current = "";
      } else {
        current += ch;
      }
    }
    if (key) {
      result[key] = current.trim();
    }

    return result;
  }
}
`;
