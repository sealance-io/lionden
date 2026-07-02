// ---------------------------------------------------------------------------
// Leo JSON ABI types — mirrors the schema produced by `leo build`
// ---------------------------------------------------------------------------

// Primitive types
export type UIntSize = "U8" | "U16" | "U32" | "U64" | "U128";
export type IntSize = "I8" | "I16" | "I32" | "I64" | "I128";

export type PrimitiveType =
  | "Address"
  | "Boolean"
  | "Field"
  | "Group"
  | "Identifier"
  | "Scalar"
  | "Signature"
  | { UInt: UIntSize }
  | { Int: IntSize };

// Type references — preserve full identity for upgrade compatibility
export interface StructRef {
  readonly path: readonly string[];
  readonly program: string | null;
}

export interface RecordRef {
  readonly path: readonly string[];
  readonly program: string | null;
}

// Plaintext types (recursive)
export type PlaintextType =
  | { Primitive: PrimitiveType }
  | { Struct: StructRef }
  | { Array: [PlaintextType, number] }
  | { Optional: PlaintextType };

// Top-level Aleo types (function inputs/outputs)
export type AleoType =
  | { Plaintext: PlaintextType }
  | { Record: RecordRef }
  | { Future: string }
  | "DynamicRecord";

// Storage variable type — supports vectors unlike Plaintext
export type StorageType = { Plaintext: PlaintextType } | { Vector: StorageType };

// Input/output mode.
//
// Leo 4.2 dropped `Mode::None` from the emitted ABI (unmoded plaintext is
// canonicalized by the parser to `Private` for transitions / `Public` for
// views) and introduced `Constant`. The mode is only meaningful for the
// `Plaintext` AleoType variant; `Record`/`Future`/`DynamicRecord` carry no
// mode and the parser stores an inert `Private` that is never read.
export type Mode = "Public" | "Private" | "Constant";

// ---------------------------------------------------------------------------
// ABI structures
// ---------------------------------------------------------------------------

export interface AbiInput {
  /**
   * Parameter name. Leo 4.1 ABIs (and bytecode `leo abi`) emit input names;
   * Leo 4.2 dropped them, so the parser synthesizes positional names
   * (`arg0`, `arg1`, …) when absent and preserves existing names otherwise.
   */
  readonly name: string;
  readonly ty: AleoType;
  /** Only meaningful when `ty` is the `Plaintext` variant; otherwise inert. */
  readonly mode: Mode;
}

export interface AbiOutput {
  readonly ty: AleoType;
  /** Only meaningful when `ty` is the `Plaintext` variant; otherwise inert. */
  readonly mode: Mode;
}

export type AbiJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AbiJsonValue[]
  | { readonly [key: string]: AbiJsonValue };

export type ConstParameterABI = AbiJsonValue;

export interface TransitionABI {
  readonly name: string;
  readonly is_async: boolean;
  readonly inputs: readonly AbiInput[];
  readonly outputs: readonly AbiOutput[];
  readonly const_parameters?: readonly ConstParameterABI[];
}

export interface ViewABI {
  readonly name: string;
  readonly inputs: readonly AbiInput[];
  readonly outputs: readonly AbiOutput[];
  readonly const_parameters?: readonly ConstParameterABI[];
}

export type InterfaceRefABI =
  | string
  | {
      readonly path: readonly string[];
      readonly program: string | null;
    };

export interface StructFieldABI {
  readonly name: string;
  readonly ty: PlaintextType;
}

export interface StructABI {
  readonly path: readonly string[];
  readonly fields: readonly StructFieldABI[];
}

export interface RecordFieldABI {
  readonly name: string;
  readonly ty: PlaintextType;
  readonly mode: Mode;
}

export interface RecordABI {
  readonly path: readonly string[];
  readonly fields: readonly RecordFieldABI[];
}

export interface MappingABI {
  readonly name: string;
  readonly key: PlaintextType;
  readonly value: PlaintextType;
}

export interface StorageVariableABI {
  readonly name: string;
  readonly ty: StorageType;
}

// ---------------------------------------------------------------------------
// Top-level program ABI
// ---------------------------------------------------------------------------

export interface ProgramABI {
  readonly program: string;
  readonly structs: readonly StructABI[];
  readonly records: readonly RecordABI[];
  readonly mappings: readonly MappingABI[];
  readonly storage_variables: readonly StorageVariableABI[];
  readonly transitions: readonly TransitionABI[];
  readonly views?: readonly ViewABI[];
  readonly implements?: readonly InterfaceRefABI[];
}
