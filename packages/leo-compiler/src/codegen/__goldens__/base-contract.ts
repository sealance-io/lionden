
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import {
  decryptRecordCiphertext,
  deriveViewKey,
  NetworkRecordDecryptionError,
} from "@lionden/network";

export type ExecutionMode = "local" | "onchain";

const LEO_BRAND: unique symbol = Symbol("LIONDEN_LEO_BRAND");

// Brands are compile-time guidance only; runtime values are the underlying Leo strings.
type LeoBrand<Name extends string> = string & { readonly [LEO_BRAND]: Name };

export type LeoAddress = LeoBrand<"Address">;
export type LeoField = LeoBrand<"Field">;
export type LeoGroup = LeoBrand<"Group">;
export type LeoScalar = LeoBrand<"Scalar">;
export type LeoIdentifier = LeoBrand<"Identifier">;
export type LeoDynamicRecord = LeoBrand<"DynamicRecord">;
export type LeoPlaintext = LeoBrand<"Plaintext">;

export type AddressInput = LeoAddress | { readonly address: string };
export type FieldInput = LeoField;
export type GroupInput = LeoGroup;
export type ScalarInput = LeoScalar;
export type IdentifierInput = LeoIdentifier;
export type DynamicRecordInput = LeoDynamicRecord;
export type PlaintextInput = LeoPlaintext;

export interface SignerInput {
  readonly privateKey: string;
  readonly address: string;
}

export interface TransitionInputContext {
  readonly programId?: string;
  readonly transition?: string;
  readonly input?: string;
  readonly path?: string;
}

export interface BaseCallOptions {
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
  /** Override the signer for this call. */
  signer?: SignerInput;
}

export interface LocalExecutionOptions extends Omit<BaseCallOptions, "privateFee"> {}

export interface OnChainExecutionOptions extends BaseCallOptions {
  /** Confirmation timeout used by settled/accepted/rejected helpers. */
  confirmTimeout?: number;
}

export interface TransitionExecutionResult {
  /** Raw outputs from the transition as Leo-encoded strings. */
  readonly outputs: string[];
  /** Transaction ID. Only set for on-chain execution. */
  readonly txId?: string;
}

export interface SubmittedTransition {
  readonly txId: string;
}

export interface SettledTransition extends SubmittedTransition {
  readonly blockHeight: number;
  readonly status: "accepted" | "rejected";
  /**
   * Raw Leo-encoded outputs of the SPECIFIC transition the caller invoked,
   * filtered from the confirmed transaction's transitions[] by transition
   * identity. Record outputs are ciphertexts (\`record1...\`) — pass them to
   * the per-record \`decryptXxx(ciphertext, key)\` helpers to recover typed
   * records.
   *
   * Accepted: exactly one matching transition is required (0 or >1 throws
   * TransactionShapeError). rawOutputs is that transition's outputs.
   *
   * Rejected: typically \`[]\` because Aleo converts rejected executes to
   * fee-only on inclusion (no execute transitions carried). The selector
   * stays permissive — if a matching transition entry IS present, its
   * outputs are surfaced instead of failing; if multiple match, the first
   * is picked. This preserves \`.rejected()\` semantics for finalizer
   * failures so the rejection itself isn't masked by a shape error.
   */
  readonly rawOutputs: readonly string[];
}

/**
 * Accepts a raw key string (auto-detected by \`APrivateKey1...\` /
 * \`AViewKey1...\` prefix), an object with \`viewKey\`, or an object with
 * \`privateKey\` (lionden \`SignerInput\` and similar structures match the
 * \`privateKey\` arm). Unrecognized strings throw \`RecordDecryptionKeyError\`
 * rather than guessing.
 */
export type RecordDecryptionKey =
  | string
  | { readonly viewKey: string }
  | { readonly privateKey: string };

// Primitive types lionden has serializers/parsers for. "signature" is
// intentionally excluded — no serializeSignature exists yet.
export type LeoPrimitiveType =
  | "address" | "boolean" | "field" | "group" | "scalar"
  | "u8" | "u16" | "u32" | "u64" | "u128"
  | "i8" | "i16" | "i32" | "i64" | "i128";

export type LeoVisibility = "public" | "private";

export type LeoFieldSchemaEntry = `${LeoPrimitiveType}.${LeoVisibility}`;

export type DynamicRecordSchema<T> = {
  readonly [K in keyof T]: LeoFieldSchemaEntry;
};

export type TypechainErrorKind =
  | "TransitionInputError"
  | "LocalTransitionError"
  | "UnexpectedLocalSuccessError"
  | "TransitionSubmissionError"
  | "TransactionConfirmationTimeoutError"
  | "OnChainRejectedError"
  | "UnexpectedTransactionStatusError"
  | "TransactionShapeError"
  | "RecordDecryptionKeyError"
  | "LocalRecordDecryptionError";

export type TypechainErrorPhase =
  | "input"
  | "local"
  | "submit"
  | "confirm"
  | "settled"
  | "shape";

export interface TypechainErrorContext {
  readonly phase: TypechainErrorPhase;
  readonly programId?: string;
  readonly transition?: string;
  readonly input?: string;
  readonly cause?: unknown;
}

export class LionDenTypechainError extends Error {
  readonly kind: TypechainErrorKind;
  readonly phase: TypechainErrorPhase;
  readonly programId?: string;
  readonly transition?: string;
  readonly input?: string;

  constructor(kind: TypechainErrorKind, message: string, context: TypechainErrorContext) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = kind;
    this.kind = kind;
    this.phase = context.phase;
    this.programId = context.programId;
    this.transition = context.transition;
    this.input = context.input;
  }
}

export class TransitionInputError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("TransitionInputError", message, { ...context, phase: "input" });
  }
}

export class LocalTransitionError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("LocalTransitionError", message, { ...context, phase: "local" });
  }
}

export class UnexpectedLocalSuccessError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("UnexpectedLocalSuccessError", message, { ...context, phase: "local" });
  }
}

export class TransitionSubmissionError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("TransitionSubmissionError", message, { ...context, phase: "submit" });
  }
}

export class TransactionConfirmationTimeoutError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("TransactionConfirmationTimeoutError", message, { ...context, phase: "confirm" });
  }
}

export class OnChainRejectedError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("OnChainRejectedError", message, { ...context, phase: "settled" });
  }
}

export class UnexpectedTransactionStatusError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("UnexpectedTransactionStatusError", message, { ...context, phase: "settled" });
  }
}

export class TransactionShapeError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("TransactionShapeError", message, { ...context, phase: "shape" });
  }
}

export class RecordDecryptionKeyError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("RecordDecryptionKeyError", message, { ...context, phase: "input" });
  }
}

export class LocalRecordDecryptionError extends LionDenTypechainError {
  constructor(message: string, context: Omit<TypechainErrorContext, "phase"> = {}) {
    super("LocalRecordDecryptionError", message, { ...context, phase: "local" });
  }
}

/**
 * Symbol-keyed cache for the original record literal a deserializer parsed.
 * Generated record serializers use this to round-trip records losslessly.
 */
export const RECORD_RAW: unique symbol = Symbol("LIONDEN_RECORD_RAW");

function stripVisibility(value: string): string {
  return value.trim().replace(/\.(?:public|private)$/i, "");
}

function describeInput(context?: TransitionInputContext): string {
  const location = context?.programId && context.transition
    ? context.programId + "/" + context.transition
    : context?.programId ?? "transition";
  if (context?.input && context.path) {
    return location + " input " + JSON.stringify(context.input) + "." + context.path;
  }
  if (context?.input) {
    return location + " input " + JSON.stringify(context.input);
  }
  if (context?.path) {
    return location + " input ." + context.path;
  }
  return location + " input";
}

function childPath(parent: string | undefined, segment: string): string {
  return parent ? parent + "." + segment : segment;
}

function createInputError(
  expected: string,
  received: unknown,
  context?: TransitionInputContext,
  hint?: string,
): TransitionInputError {
  const rendered = typeof received === "string"
    ? "string " + JSON.stringify(received)
    : received === null
      ? "null"
      : Array.isArray(received)
        ? "array"
        : typeof received;
  const suffix = hint ? " " + hint : "";
  return new TransitionInputError(
    describeInput(context) + " expected " + expected + ". Received " + rendered + "." + suffix,
    {
      programId: context?.programId,
      transition: context?.transition,
      input: context?.input,
    },
  );
}

function expectString(value: unknown, expected: string, context?: TransitionInputContext, hint?: string): string {
  if (typeof value !== "string") {
    throw createInputError(expected, value, context, hint);
  }
  return value.trim();
}

function brand<Name extends string>(value: string): LeoBrand<Name> {
  return value as LeoBrand<Name>;
}

export const Leo = {
  address(value: string | { readonly address: string }): LeoAddress {
    return brand<"Address">(BaseContract.serializeAddress(value, undefined));
  },

  field(value: string): LeoField {
    return brand<"Field">(BaseContract.serializeField(value, undefined));
  },

  group(value: string): LeoGroup {
    return brand<"Group">(BaseContract.serializeGroup(value, undefined));
  },

  scalar(value: string): LeoScalar {
    return brand<"Scalar">(BaseContract.serializeScalar(value, undefined));
  },

  identifier(value: string): LeoIdentifier {
    return brand<"Identifier">(BaseContract.parseIdentifier(BaseContract.serializeIdentifier(value, undefined)));
  },

  /**
   * Build a typed Leo \`dyn record\` literal from a JS object and a
   * per-field type+visibility schema. Schema entries are validated at
   * compile time via the \`\${LeoPrimitiveType}.\${LeoVisibility}\` template
   * union; values are validated and range-checked at runtime.
   *
   * Example:
   *   const token = Leo.dynamicRecord({
   *     owner: Leo.address(addr),
   *     amount: 100n,
   *     _nonce: Leo.group("0group"),
   *     _version: 0,
   *   }, {
   *     owner: "address.private",
   *     amount: "u128.private",
   *     _nonce: "group.public",
   *     _version: "u8.public",
   *   });
   */
  dynamicRecord<T extends object>(value: T, schema: DynamicRecordSchema<T>): LeoDynamicRecord {
    return brand<"DynamicRecord">(BaseContract.encodeDynamicRecord(
      value as unknown as Record<string, unknown>,
      schema as unknown as Record<string, LeoFieldSchemaEntry>,
    ));
  },

  unsafe: {
    dynamicRecord(value: string): LeoDynamicRecord {
      const literal = expectString(value, "DynamicRecord literal");
      if (literal.length === 0) {
        throw createInputError("DynamicRecord literal", value);
      }
      return brand<"DynamicRecord">(literal);
    },

    plaintext(value: string): LeoPlaintext {
      const literal = expectString(value, "Leo plaintext literal");
      if (literal.length === 0) {
        throw createInputError("Leo plaintext literal", value);
      }
      return brand<"Plaintext">(literal);
    },
  },
} as const;

export abstract class BaseContract {
  static readonly RECORD_RAW: typeof RECORD_RAW = RECORD_RAW;

  protected readonly programId: string;
  protected lre: LionDenRuntimeEnvironment | null = null;
  protected signer?: SignerInput;

  constructor(programId: string) {
    this.programId = programId;
  }

  /** Connect this contract wrapper to an LRE instance. */
  connect(lre: LionDenRuntimeEnvironment): this {
    this.lre = lre;
    return this;
  }

  /**
   * Return a new contract instance bound to a specific signer.
   * The returned instance shares the same LRE connection but all
   * transitions will execute as the given signer.
   */
  withSigner(signer: SignerInput): this {
    const ContractClass = this.constructor as new () => this;
    const instance = new ContractClass();
    instance.lre = this.lre;
    instance.signer = signer;
    return instance;
  }

  static childInputContext(
    context: TransitionInputContext | undefined,
    segment: string,
  ): TransitionInputContext | undefined {
    if (!context) return undefined;
    return { ...context, path: childPath(context.path, segment) };
  }

  protected inputContext(transition: string, input: string): TransitionInputContext {
    return { programId: this.programId, transition, input };
  }

  protected getLre(): LionDenRuntimeEnvironment {
    if (!this.lre) {
      throw new TransactionShapeError(
        "Contract " + this.programId + " is not connected to an LRE. Call .connect(lre) before executing transitions.",
        { programId: this.programId },
      );
    }
    return this.lre;
  }

  protected getNetwork(): any {
    const lre = this.getLre();
    const network = (lre as any).network;
    if (!network || typeof network.execute !== "function") {
      throw new TransactionShapeError(
        "Network is not available for " + this.programId + ". Ensure @lionden/plugin-network is loaded and connected before executing transitions.",
        { programId: this.programId },
      );
    }
    return network;
  }

  /**
   * Execute a transition locally and return raw Leo outputs.
   * Generated transition helpers deserialize this path into JS values.
   */
  protected async executeLocal(
    transitionName: string,
    args: string[],
    options: LocalExecutionOptions = {},
  ): Promise<TransitionExecutionResult> {
    try {
      const result = await this.executeRaw(transitionName, args, {
        ...options,
        mode: "local",
      });
      return result;
    } catch (error) {
      if (error instanceof LionDenTypechainError) throw error;
      throw new LocalTransitionError(
        this.programId + "/" + transitionName + " failed during local execution. This usually means a transition assertion or local runtime check failed. Cause: " + errorMessage(error),
        {
          programId: this.programId,
          transition: transitionName,
          cause: error,
        },
      );
    }
  }

  protected async expectLocalFailure(
    transitionName: string,
    args: string[],
    options: LocalExecutionOptions = {},
  ): Promise<LocalTransitionError> {
    try {
      await this.executeLocal(transitionName, args, options);
    } catch (error) {
      if (error instanceof LocalTransitionError) return error;
      throw error;
    }
    throw new UnexpectedLocalSuccessError(
      this.programId + "/" + transitionName + " was expected to fail during local execution, but it succeeded.",
      { programId: this.programId, transition: transitionName },
    );
  }

  protected async submitTransition(
    transitionName: string,
    args: string[],
    options: OnChainExecutionOptions = {},
  ): Promise<SubmittedTransition> {
    try {
      const result = await this.executeRaw(transitionName, args, {
        ...options,
        mode: "onchain",
      });
      if (!result.txId) {
        throw new TransactionShapeError(
          this.programId + "/" + transitionName + " was submitted on-chain but no transaction ID was returned.",
          { programId: this.programId, transition: transitionName },
        );
      }
      return { txId: result.txId };
    } catch (error) {
      if (error instanceof LionDenTypechainError) throw error;
      throw new TransitionSubmissionError(
        this.programId + "/" + transitionName + " failed before confirmation while building or submitting the transaction. Cause: " + errorMessage(error),
        {
          programId: this.programId,
          transition: transitionName,
          cause: error,
        },
      );
    }
  }

  protected async settleTransition(
    transitionName: string,
    args: string[],
    options: OnChainExecutionOptions = {},
  ): Promise<SettledTransition> {
    const submitted = await this.submitTransition(transitionName, args, options);
    const network = this.getNetwork();
    if (typeof network.waitForConfirmation !== "function") {
      throw new TransactionShapeError(
        "Network for " + this.programId + " does not expose waitForConfirmation(). Cannot settle " + transitionName + ".",
        { programId: this.programId, transition: transitionName },
      );
    }

    try {
      const confirmed = await network.waitForConfirmation(submitted.txId, options.confirmTimeout);
      if (
        !confirmed ||
        confirmed.txId !== submitted.txId ||
        typeof confirmed.blockHeight !== "number" ||
        (confirmed.status !== "accepted" && confirmed.status !== "rejected")
      ) {
        throw new TransactionShapeError(
          this.programId + "/" + transitionName + " confirmation returned an unexpected shape.",
          { programId: this.programId, transition: transitionName },
        );
      }
      const rawOutputs = this.selectTransitionOutputs(
        transitionName,
        confirmed.status,
        confirmed.transitions,
      );
      return {
        txId: confirmed.txId,
        blockHeight: confirmed.blockHeight,
        status: confirmed.status,
        rawOutputs,
      };
    } catch (error) {
      if (error instanceof LionDenTypechainError) throw error;
      if (isNetworkConfirmationTimeoutError(error)) {
        throw new TransactionConfirmationTimeoutError(
          this.programId + "/" + transitionName + " submitted as " + submitted.txId + " but did not confirm in time. Cause: " + errorMessage(error),
          {
            programId: this.programId,
            transition: transitionName,
            cause: error,
          },
        );
      }
      const message = errorMessage(error);
      throw new TransactionShapeError(
        this.programId + "/" + transitionName + " could not resolve confirmation status for " + submitted.txId + ". Cause: " + message,
        {
          programId: this.programId,
          transition: transitionName,
          cause: error,
        },
      );
    }
  }

  protected async expectAccepted(
    transitionName: string,
    args: string[],
    options: OnChainExecutionOptions = {},
  ): Promise<SettledTransition> {
    const settled = await this.settleTransition(transitionName, args, options);
    if (settled.status !== "accepted") {
      throw new OnChainRejectedError(
        this.programId + "/" + transitionName + " confirmed rejected as " + settled.txId + ". This is an on-chain rejection, commonly from a finalizer assertion or network execution rule, not a local transition failure.",
        { programId: this.programId, transition: transitionName },
      );
    }
    return settled;
  }

  protected async expectRejected(
    transitionName: string,
    args: string[],
    options: OnChainExecutionOptions = {},
  ): Promise<SettledTransition> {
    const settled = await this.settleTransition(transitionName, args, options);
    if (settled.status !== "rejected") {
      throw new UnexpectedTransactionStatusError(
        this.programId + "/" + transitionName + " was expected to be rejected on-chain, but " + settled.txId + " was accepted.",
        { programId: this.programId, transition: transitionName },
      );
    }
    return settled;
  }

  protected outputAt(
    result: TransitionExecutionResult,
    transitionName: string,
    index: number,
  ): string {
    const value = result.outputs[index];
    if (typeof value !== "string") {
      throw new TransactionShapeError(
        this.programId + "/" + transitionName + " local execution did not return output #" + index + ".",
        { programId: this.programId, transition: transitionName },
      );
    }
    return value;
  }

  private async executeRaw(
    transitionName: string,
    args: string[],
    options: BaseCallOptions & { readonly mode: ExecutionMode },
  ): Promise<TransitionExecutionResult> {
    const network = this.getNetwork();
    const effectiveOptions: BaseCallOptions & { readonly mode: ExecutionMode } = { ...options };
    if (this.signer && !effectiveOptions.signer) {
      effectiveOptions.signer = this.signer;
    }
    if (effectiveOptions.prove === undefined) {
      const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
      if (env?.["LIONDEN_PROVE"] === "true") {
        effectiveOptions.prove = true;
      }
    }
    return network.execute(this.programId, transitionName, args, effectiveOptions);
  }

  protected async queryMapping(
    mappingName: string,
    key: string,
  ): Promise<string | null> {
    const lre = this.getLre();
    const network = (lre as any).network;

    if (!network || typeof network.getMappingValue !== "function") {
      throw new TransactionShapeError(
        "Network is not available for " + this.programId + ". Ensure @lionden/plugin-network is loaded and connected before querying mappings.",
        { programId: this.programId },
      );
    }

    return network.getMappingValue(this.programId, mappingName, key);
  }

  // ---------------------------------------------------------------------------
  // Leo string to JS value parsers and JS value to Leo string serializers
  // ---------------------------------------------------------------------------

  static stripSuffix(value: string): string {
    return value.replace(/(?:u(?:8|16|32|64|128)|i(?:8|16|32|64|128)|field|group|scalar|bool|address)(?:\.(?:public|private))?$/i, "");
  }

  static parseBoolean(value: string): boolean {
    return stripVisibility(value) === "true";
  }

  static parseNumber(value: string): number {
    return Number(BaseContract.stripSuffix(value));
  }

  static parseBigInt(value: string): bigint {
    return BigInt(BaseContract.stripSuffix(value));
  }

  static parseString(value: string): string {
    return stripVisibility(value);
  }

  static assertObject(value: unknown, context?: TransitionInputContext): asserts value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw createInputError("object", value, context);
    }
  }

  static serializeBoolean(value: unknown, context?: TransitionInputContext): string {
    if (typeof value !== "boolean") {
      throw createInputError("boolean", value, context);
    }
    return String(value);
  }

  static serializeArray(
    value: unknown,
    context: TransitionInputContext | undefined,
    serializeElement: (value: unknown, context: TransitionInputContext | undefined) => string,
  ): string {
    if (!Array.isArray(value)) {
      throw createInputError("array", value, context);
    }
    return "[" + value.map((element, index) =>
      serializeElement(element, BaseContract.childInputContext(context, String(index))),
    ).join(", ") + "]";
  }

  static serializeUnsupportedOptionalNone(context?: TransitionInputContext): never {
    throw createInputError(
      "non-null Optional value",
      null,
      context,
      "This Optional inner type has no generated zero value, so None cannot be represented.",
    );
  }

  static serializeUInt(
    value: unknown,
    bits: 8 | 16 | 32 | 64 | 128,
    context?: TransitionInputContext,
  ): string {
    const expectedType = bits <= 32 ? "number" : "bigint";
    if (bits <= 32) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw createInputError("u" + bits + " " + expectedType, value, context);
      }
      const max = 2 ** bits - 1;
      if (value < 0 || value > max) {
        throw createInputError("u" + bits + " in range 0.." + max, value, context);
      }
      return value.toString() + "u" + bits;
    }
    if (typeof value !== "bigint") {
      throw createInputError("u" + bits + " " + expectedType, value, context);
    }
    const max = (1n << BigInt(bits)) - 1n;
    if (value < 0n || value > max) {
      throw createInputError("u" + bits + " in range 0.." + max.toString(), value, context);
    }
    return value.toString() + "u" + bits;
  }

  static serializeInt(
    value: unknown,
    bits: 8 | 16 | 32 | 64 | 128,
    context?: TransitionInputContext,
  ): string {
    if (bits <= 32) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw createInputError("i" + bits + " number", value, context);
      }
      const min = -(2 ** (bits - 1));
      const max = 2 ** (bits - 1) - 1;
      if (value < min || value > max) {
        throw createInputError("i" + bits + " in range " + min + ".." + max, value, context);
      }
      return value.toString() + "i" + bits;
    }
    if (typeof value !== "bigint") {
      throw createInputError("i" + bits + " bigint", value, context);
    }
    const min = -(1n << BigInt(bits - 1));
    const max = (1n << BigInt(bits - 1)) - 1n;
    if (value < min || value > max) {
      throw createInputError("i" + bits + " in range " + min.toString() + ".." + max.toString(), value, context);
    }
    return value.toString() + "i" + bits;
  }

  static serializeAddress(value: unknown, context?: TransitionInputContext): string {
    const raw = typeof value === "string"
      ? value
      : value && typeof value === "object" && "address" in value
        ? value.address
        : value;
    const address = expectString(raw, "Address", context, "Use Leo.address(...) or pass a named/devnode account.");
    if (!/^aleo1[0-9a-z]+$/i.test(address)) {
      throw createInputError("Address", raw, context, "Use Leo.address(...) or pass a named/devnode account.");
    }
    return stripVisibility(address);
  }

  static parseAddress(value: string): LeoAddress {
    return brand<"Address">(BaseContract.serializeAddress(stripVisibility(value), undefined));
  }

  static serializeField(value: unknown, context?: TransitionInputContext): string {
    const field = expectString(value, "Field", context, "Use Leo.field(...).");
    if (!/^[0-9]+field$/i.test(field)) {
      throw createInputError("Field literal like 99field", value, context, "Use Leo.field(...).");
    }
    return stripVisibility(field);
  }

  static parseField(value: string): LeoField {
    return brand<"Field">(BaseContract.serializeField(stripVisibility(value), undefined));
  }

  static serializeGroup(value: unknown, context?: TransitionInputContext): string {
    const group = expectString(value, "Group", context, "Use Leo.group(...).");
    if (!/^[0-9]+group$/i.test(group)) {
      throw createInputError("Group literal like 0group", value, context, "Use Leo.group(...).");
    }
    return stripVisibility(group);
  }

  static parseGroup(value: string): LeoGroup {
    return brand<"Group">(BaseContract.serializeGroup(stripVisibility(value), undefined));
  }

  static serializeScalar(value: unknown, context?: TransitionInputContext): string {
    const scalar = expectString(value, "Scalar", context, "Use Leo.scalar(...).");
    if (!/^[0-9]+scalar$/i.test(scalar)) {
      throw createInputError("Scalar literal like 0scalar", value, context, "Use Leo.scalar(...).");
    }
    return stripVisibility(scalar);
  }

  static parseScalar(value: string): LeoScalar {
    return brand<"Scalar">(BaseContract.serializeScalar(stripVisibility(value), undefined));
  }

  static serializeIdentifier(value: unknown, context?: TransitionInputContext): string {
    const trimmed = expectString(value, "Identifier", context, "Use Leo.identifier(...).");
    if (trimmed.length === 0) {
      throw createInputError("Identifier", value, context, "Use Leo.identifier(...).");
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      const name = trimmed.slice(1, -1);
      BaseContract.assertIdentifierName(name, context);
      return "'" + name + "'";
    }
    BaseContract.assertIdentifierName(trimmed, context);
    return "'" + trimmed + "'";
  }

  static parseIdentifier(value: string): LeoIdentifier {
    const trimmed = stripVisibility(value);
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
      return brand<"Identifier">(trimmed.slice(1, -1));
    }
    BaseContract.assertIdentifierName(trimmed, undefined);
    return brand<"Identifier">(trimmed);
  }

  static serializeDynamicRecord(value: unknown, context?: TransitionInputContext): string {
    const literal = expectString(value, "DynamicRecord literal", context, "Use Leo.unsafe.dynamicRecord(...).");
    if (literal.length === 0) {
      throw createInputError("DynamicRecord literal", value, context, "Use Leo.unsafe.dynamicRecord(...).");
    }
    return literal;
  }

  static parseDynamicRecord(value: string): LeoDynamicRecord {
    return brand<"DynamicRecord">(value);
  }

  static serializePlaintext(value: unknown, context?: TransitionInputContext): string {
    const literal = expectString(value, "Leo plaintext literal", context, "Use Leo.unsafe.plaintext(...).");
    if (literal.length === 0) {
      throw createInputError("Leo plaintext literal", value, context, "Use Leo.unsafe.plaintext(...).");
    }
    return literal;
  }

  static parsePlaintext(value: string): LeoPlaintext {
    return brand<"Plaintext">(value);
  }

  private static assertIdentifierName(value: string, context?: TransitionInputContext): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
      throw createInputError("Identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/", value, context, "Use Leo.identifier(...).");
    }
  }

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
   * Filter the confirmed transaction's transitions[] to the specific
   * (programId, transitionName) the caller invoked, returning its rawOutputs.
   *
   * Accepted txs: fail-fast on 0 or >1 matches — the caller cannot safely
   * pick the right outputs without unambiguous identity. Reentrant or
   * recursive transitions hit this; reach for the raw escape hatch instead.
   *
   * Rejected txs: permissive (Aleo converts rejected execs to fee-only on
   * inclusion, so transitions[] is usually empty). Returns [] when no match.
   */
  protected selectTransitionOutputs(
    transitionName: string,
    status: "accepted" | "rejected",
    transitions: readonly { readonly programId: string; readonly transitionName: string; readonly rawOutputs: readonly string[] }[] | undefined,
  ): readonly string[] {
    const list = transitions ?? [];
    const matches = list.filter(
      (t) => t.programId === this.programId && t.transitionName === transitionName,
    );
    if (status === "rejected") {
      // Fee-only inclusion is the common rejected shape. Empty rawOutputs
      // is expected; preserves .rejected() semantics for finalizer failures.
      return matches.length > 0 ? matches[0]!.rawOutputs : [];
    }
    if (matches.length === 0) {
      throw new TransactionShapeError(
        "Confirmed transaction did not contain a matching transition for " + this.programId + "/" + transitionName + ". Available: " + list.map((t) => t.programId + "/" + t.transitionName).join(", ") + ".",
        { programId: this.programId, transition: transitionName },
      );
    }
    if (matches.length > 1) {
      throw new TransactionShapeError(
        "Confirmed transaction contained " + matches.length + " transitions matching " + this.programId + "/" + transitionName + ". Cannot pick outputs unambiguously; use raw.execute(...) for reentrant or recursive flows.",
        { programId: this.programId, transition: transitionName },
      );
    }
    return matches[0]!.rawOutputs;
  }

  /**
   * Decrypt an Aleo record ciphertext into a typed record. Used by generated
   * per-record \`decryptXxx\` free functions; can also be invoked directly
   * for advanced cases (custom deserializers).
   *
   * Accepts a polymorphic key — string (auto-detected prefix), {viewKey},
   * or {privateKey}. Throws RecordDecryptionKeyError on unrecognized shapes
   * and LocalRecordDecryptionError when the SDK rejects the ciphertext or
   * view-key combo (wrong account, malformed ciphertext, etc.).
   */
  static async decryptRecord<T>(
    ciphertext: string,
    key: RecordDecryptionKey,
    deserialize: (plaintext: string) => T,
  ): Promise<T> {
    // Shape errors (bad object/string) are RecordDecryptionKeyError — caller
    // input bug, surface as-is. SDK-level errors (bad APrivateKey1 string
    // failing deriveViewKey, bad ciphertext, mismatched view key) are
    // re-wrapped as LocalRecordDecryptionError so test assertions can match
    // a single typechain-layer error class.
    try {
      const viewKey = await BaseContract.normalizeRecordDecryptionKey(key);
      const plaintext = await decryptRecordCiphertext(ciphertext, viewKey);
      return deserialize(plaintext);
    } catch (cause: unknown) {
      // RecordDecryptionKeyError and other typechain errors pass through.
      if (cause instanceof LionDenTypechainError) throw cause;
      const isNetworkErr =
        cause instanceof NetworkRecordDecryptionError ||
        (cause && typeof cause === "object" && (cause as { kind?: unknown }).kind === "NetworkRecordDecryptionError");
      if (isNetworkErr) {
        throw new LocalRecordDecryptionError(
          "Failed to decrypt record ciphertext. The view key may not match the record's owner, or the ciphertext is malformed. Cause: " + errorMessage(cause),
          { cause },
        );
      }
      throw cause;
    }
  }

  private static async normalizeRecordDecryptionKey(key: RecordDecryptionKey): Promise<string> {
    if (typeof key === "string") {
      const trimmed = key.trim();
      if (trimmed.startsWith("AViewKey1")) return trimmed;
      if (trimmed.startsWith("APrivateKey1")) return deriveViewKey(trimmed);
      throw new RecordDecryptionKeyError(
        "Decryption key string must start with \"APrivateKey1\" or \"AViewKey1\". Received prefix " + JSON.stringify(trimmed.slice(0, 16)) + ". To pass an opaque string, wrap in { viewKey } or { privateKey }.",
      );
    }
    if (key && typeof key === "object") {
      const viewKey = (key as { readonly viewKey?: unknown }).viewKey;
      if (typeof viewKey === "string" && viewKey.length > 0) {
        if (!viewKey.startsWith("AViewKey1")) {
          throw new RecordDecryptionKeyError(
            "{ viewKey } must start with \"AViewKey1\". Received prefix " + JSON.stringify(viewKey.slice(0, 16)) + ".",
          );
        }
        return viewKey;
      }
      const privateKey = (key as { readonly privateKey?: unknown }).privateKey;
      if (typeof privateKey === "string" && privateKey.length > 0) {
        if (!privateKey.startsWith("APrivateKey1")) {
          throw new RecordDecryptionKeyError(
            "{ privateKey } must start with \"APrivateKey1\". Received prefix " + JSON.stringify(privateKey.slice(0, 16)) + ".",
          );
        }
        return deriveViewKey(privateKey);
      }
    }
    throw new RecordDecryptionKeyError(
      "Decryption key must be a non-empty AViewKey1/APrivateKey1 string, or an object with a \`viewKey\` or \`privateKey\` field. Received " + (key === null ? "null" : typeof key) + ".",
    );
  }

  /**
   * Compose a Leo \`dyn record\` literal from a JS object and a per-field
   * schema. Validates that schema and value have matching keys; dispatches
   * each field through the existing typed serializer; appends the visibility
   * suffix; brands the result. Synchronous — no SDK call.
   */
  static encodeDynamicRecord(
    value: Record<string, unknown>,
    schema: Record<string, LeoFieldSchemaEntry>,
  ): string {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new TransitionInputError(
        "Leo.dynamicRecord expected an object value. Received " + (value === null ? "null" : Array.isArray(value) ? "array" : typeof value) + ".",
      );
    }
    if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
      throw new TransitionInputError(
        "Leo.dynamicRecord expected an object schema mapping field name to \"<type>.<visibility>\".",
      );
    }
    const valueKeys = Object.keys(value);
    const schemaKeys = Object.keys(schema);
    const missing = schemaKeys.filter((k) => !valueKeys.includes(k));
    const extra = valueKeys.filter((k) => !schemaKeys.includes(k));
    if (missing.length > 0 || extra.length > 0) {
      throw new TransitionInputError(
        "Leo.dynamicRecord value and schema keys must match exactly. Missing in value: [" + missing.join(", ") + "]. Extra in value: [" + extra.join(", ") + "].",
      );
    }
    const parts: string[] = [];
    for (const fieldName of schemaKeys) {
      const entry = schema[fieldName]!;
      const split = entry.lastIndexOf(".");
      if (split <= 0) {
        throw new TransitionInputError(
          "Leo.dynamicRecord schema entry for \"" + fieldName + "\" must be \"<type>.<visibility>\". Received " + JSON.stringify(entry) + ".",
        );
      }
      const ty = entry.slice(0, split);
      const viz = entry.slice(split + 1);
      if (viz !== "public" && viz !== "private") {
        throw new TransitionInputError(
          "Leo.dynamicRecord schema entry for \"" + fieldName + "\" has invalid visibility \"" + viz + "\". Expected \"public\" or \"private\".",
        );
      }
      const ctx: TransitionInputContext = { path: fieldName };
      const serialized = BaseContract.serializeDynamicRecordField(value[fieldName], ty, ctx);
      parts.push(fieldName + ": " + serialized + "." + viz);
    }
    return "{ " + parts.join(", ") + " }";
  }

  private static serializeDynamicRecordField(
    value: unknown,
    leoType: string,
    ctx: TransitionInputContext,
  ): string {
    switch (leoType) {
      case "address":
        return BaseContract.serializeAddress(value, ctx);
      case "boolean":
        return BaseContract.serializeBoolean(value, ctx);
      case "field":
        return BaseContract.serializeField(value, ctx);
      case "group":
        return BaseContract.serializeGroup(value, ctx);
      case "scalar":
        return BaseContract.serializeScalar(value, ctx);
      case "u8":
      case "u16":
      case "u32":
      case "u64":
      case "u128": {
        const bits = parseInt(leoType.slice(1), 10) as 8 | 16 | 32 | 64 | 128;
        return BaseContract.serializeUInt(value, bits, ctx);
      }
      case "i8":
      case "i16":
      case "i32":
      case "i64":
      case "i128": {
        const bits = parseInt(leoType.slice(1), 10) as 8 | 16 | 32 | 64 | 128;
        return BaseContract.serializeInt(value, bits, ctx);
      }
      default:
        throw new TransitionInputError(
          "Leo.dynamicRecord schema entry uses unsupported type \"" + leoType + "\". Supported: address, boolean, field, group, scalar, u8/u16/u32/u64/u128, i8/i16/i32/i64/i128.",
        );
    }
  }

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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNetworkConfirmationTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly kind?: unknown; readonly name?: unknown };
  return candidate.kind === "NetworkConfirmationTimeoutError" ||
    candidate.name === "NetworkConfirmationTimeoutError";
}
