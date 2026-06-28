/**
 * Declarative specs for adapting upstream leo-samples packages into lionden
 * source-first projects. Each spec collapses one upstream sample group into a
 * single lionden project with N `programs/` subdirs.
 *
 * The adapter (adapt.ts) *discovers* most facts from each package's
 * `program.json` + `src/` (program-vs-library, program id, declared deps).
 * Specs only carry what cannot be discovered: which upstream packages belong
 * to the project, runtime dispatch targets, the upgradability v1/v2 split, and
 * the expected resolved graph used by the adapter unit test / 0f proof.
 */

/** A v2 source package for the upgradability in-place-swap upgrade flow (0d). */
export interface V2PackageSpec {
  /** Upstream package dir, relative to `.upstream`, e.g. "upgradability/frozen_base_v2". */
  readonly upstreamDir: string;
  /** Program id this v2 source replaces, e.g. "frozen_base.aleo". */
  readonly programId: string;
}

/**
 * A documented lionden finding that excludes a sample group from the lane.
 * Adaptation still succeeds (the graph is correct); it is *compilation* that
 * fails, so the group stays in SPECS to keep the adapter unit test honest and
 * to lock the finding via the 0f proof.
 */
export interface ExclusionFinding {
  /** One-line reason shown in the lane README / selection doc. */
  readonly reason: string;
  /** Full finding text (root cause + remediation). */
  readonly finding: string;
  /** Substring of the `leo build` failure that locks the finding in the 0f proof. */
  readonly errorMarker: string;
}

/** Expected resolved dependency graph after adaptation (lionden-canonical ids). */
export interface ExpectedGraph {
  /** Canonical unit ids, sorted. Programs keep `.aleo`; libraries drop it. */
  readonly units: readonly string[];
  /** Per-unit external dependency ids (canonical), order-insensitive. */
  readonly imports: Readonly<Record<string, readonly string[]>>;
  /** Network deps (e.g. "credits.aleo"), sorted. */
  readonly networkDeps: readonly string[];
}

export interface SampleGroupSpec {
  /** lionden project name; also the generated dir name under `generated/`. */
  readonly name: string;
  /** v1 / on-chain packages, dirs relative to `.upstream`. */
  readonly packages: readonly string[];
  /** Runtime dispatch targets → `execution.imports` in the generated config. */
  readonly executionImports?: Readonly<Record<string, readonly string[]>>;
  /** Upgradability v2 sources, kept out of `programs/` (0d). */
  readonly v2Packages?: readonly V2PackageSpec[];
  /** Per-test timeout override (ms) for the generated config. */
  readonly timeout?: number;
  /**
   * Compile/codegen-only in the default lane (no on-chain suite) — surface is
   * mostly ABI-shape, covered cheaply without deploys.
   */
  readonly compileOnly?: boolean;
  /**
   * Emit `namedAccounts: { admin: { default: 0 } }` into the generated config —
   * devnode account index 0 (the genesis key the `@admin` programs bake in).
   * Lights up the admin-signer resolution branch in upgrade-task.ts +
   * network/named-account-manager.ts with no new transaction.
   */
  readonly namedAdminAccount?: boolean;
  /**
   * When set, the group is a documented lionden finding: adaptation works but
   * `leo build` does not, so it is excluded from compile-codegen + on-chain
   * lanes (the 0f proof still locks the finding).
   */
  readonly excluded?: ExclusionFinding;
  /** Expected resolved graph, asserted by adapt.test.ts. */
  readonly expected: ExpectedGraph;
}

const DEVNODE_TIMEOUT = 240_000;

export const SPECS: readonly SampleGroupSpec[] = [
  {
    name: "abi_surface",
    packages: ["abi_surface"],
    timeout: DEVNODE_TIMEOUT,
    // COMPILE-ONLY — documented lionden codegen finding. abi_surface compiles
    // and its JSON ABI parses, but codegen cannot emit a usable TypeScript
    // binding for it, so no on-chain suite can import one. Codegen now rejects
    // the program EARLY — in `assertCodegenSupportedTypes` (typescript-generator.ts)
    // — with `Primitive::Signature is not supported`, before any binding is
    // emitted. That stricter primitive check masks the older const-generic
    // finding (the struct `Slot::[N]` was emitted verbatim as an invalid TS type
    // identifier `Slot::[2u32]`, because `isValidIdentifier` sanitizes method/field
    // names but not struct/interface *type* names). The finding is locked by an
    // assertion in compile-codegen.test.ts that expects the Signature rejection;
    // if Signature support lands in codegen, that assertion flips — re-lock the
    // resurfaced `Slot::[N]` const-generic finding and re-evaluate promoting
    // abi_surface to the on-chain set. Until then abi_surface stays in the
    // compile/codegen lane (full ABI breadth) but out of the on-chain set.
    compileOnly: true,
    expected: {
      units: ["abi_surface.aleo"],
      imports: { "abi_surface.aleo": [] },
      networkDeps: [],
    },
  },
  {
    name: "native_runtime_edges",
    packages: [
      "native_runtime_edges/credit_left",
      "native_runtime_edges/credit_right",
      "native_runtime_edges/native_runtime_edges",
    ],
    timeout: DEVNODE_TIMEOUT,
    expected: {
      units: ["credit_left.aleo", "credit_right.aleo", "native_runtime_edges.aleo"],
      imports: {
        "credit_left.aleo": ["credits.aleo"],
        "credit_right.aleo": ["credits.aleo"],
        "native_runtime_edges.aleo": ["credits.aleo", "credit_left.aleo", "credit_right.aleo"],
      },
      networkDeps: ["credits.aleo"],
    },
  },
  {
    name: "dynamic_dispatch",
    packages: [
      "dynamic_dispatch/token_iface",
      "dynamic_dispatch/token_alt",
      "dynamic_dispatch/dispatcher",
    ],
    executionImports: {
      "dispatcher.aleo": ["token_iface.aleo", "token_alt.aleo"],
    },
    timeout: DEVNODE_TIMEOUT,
    expected: {
      units: ["dispatcher.aleo", "token_alt.aleo", "token_iface.aleo"],
      imports: {
        "token_iface.aleo": [],
        "token_alt.aleo": ["token_iface.aleo"],
        "dispatcher.aleo": ["token_iface.aleo", "token_alt.aleo"],
      },
      networkDeps: [],
    },
  },
  {
    name: "external_composition",
    packages: [
      "external_composition/abi_point_lib",
      "external_composition/abi_shape_lib",
      "external_composition/abi_provider",
      "external_composition/abi_consumer",
    ],
    timeout: DEVNODE_TIMEOUT,
    // EXCLUDED — documented lionden finding. Adaptation succeeds and the
    // resolved graph is correct, but `leo build` cannot code-generate a
    // library-qualified struct *type path* (`<lib>.aleo::Type`). lionden's
    // source-first library convention (a `lib.leo`, referenced `<lib>.aleo::x`)
    // supports library FUNCTIONS (proven by examples/multi-program's
    // `math_utils.aleo::min`) but a library STRUCT type used cross-unit panics
    // the compiler. Upstream compiles the same composition only because it
    // references libraries BARE (`abi_point_lib::Point`, declared solely as
    // program.json metadata) — which lionden's `.aleo`-only `parseImports`
    // cannot detect, so lionden cannot express an *inlined* library type.
    // See test/fixtures/leo-samples/README.md § Findings and the 0f proof.
    excluded: {
      reason:
        "Leo 4.1.0 cannot code-generate a library-qualified struct type path (<lib>.aleo::Type); " +
        "lionden's .aleo-only library convention supports library functions but not library struct types.",
      finding:
        "external_composition's surface is predominantly library struct types " +
        "(abi_point_lib::Point, abi_shape_lib::Rect/Grid). Adapting them to lionden's " +
        "convention rewrites bare refs to abi_point_lib.aleo::Point and materializes the " +
        "library as an .aleo dependency. `leo build` then fails. Two manifestations of the " +
        "same root cause: (1) a minimal non-diamond case panics at code generation " +
        "(`path format cannot be legalized at this point: <lib>.aleo/Type`); (2) the full " +
        "group fails earlier in the type checker with not-in-scope (nested modules, " +
        "ETYC0372017) and diamond type-identity errors (`expected X, but found X`, " +
        "ETYC0372117). Both reference the library-qualified type path `abi_point_lib.aleo`. " +
        "Remediation needs a lionden/Leo change: either bare-library detection in " +
        "parseImports plus non-.aleo materialization (so library types inline), or Leo " +
        "support for library type paths. Until then the lane proceeds with the other four " +
        "projects.",
      // Present in every manifestation of the failure (type errors reference
      // `abi_point_lib.aleo::Point`; the codegen panic references
      // `abi_point_lib.aleo/Point`). Absent on success (no throw to inspect).
      errorMarker: "abi_point_lib.aleo",
    },
    expected: {
      units: ["abi_consumer.aleo", "abi_point_lib", "abi_provider.aleo", "abi_shape_lib"],
      imports: {
        abi_point_lib: [],
        abi_shape_lib: ["abi_point_lib"],
        "abi_provider.aleo": ["abi_point_lib", "abi_shape_lib"],
        "abi_consumer.aleo": ["abi_provider.aleo", "abi_point_lib", "abi_shape_lib"],
      },
      networkDeps: [],
    },
  },
  {
    name: "upgradability",
    packages: [
      "upgradability/frozen_base",
      "upgradability/open_upgrade",
      "upgradability/admin_upgrade",
      "upgradability/checksum_upgrade",
      "upgradability/timelock_upgrade",
      "upgradability/governance",
    ],
    v2Packages: [
      { upstreamDir: "upgradability/frozen_base_v2", programId: "frozen_base.aleo" },
      { upstreamDir: "upgradability/open_upgrade_v2", programId: "open_upgrade.aleo" },
      { upstreamDir: "upgradability/admin_upgrade_v2", programId: "admin_upgrade.aleo" },
      { upstreamDir: "upgradability/checksum_upgrade_v2", programId: "checksum_upgrade.aleo" },
      { upstreamDir: "upgradability/timelock_upgrade_v2", programId: "timelock_upgrade.aleo" },
    ],
    // The @admin programs bake in the devnode genesis address (== accounts[0]);
    // surface it as namedAccounts.admin so the admin-signer resolution path runs.
    namedAdminAccount: true,
    timeout: DEVNODE_TIMEOUT,
    expected: {
      units: [
        "admin_upgrade.aleo",
        "checksum_upgrade.aleo",
        "frozen_base.aleo",
        "governance.aleo",
        "open_upgrade.aleo",
        "timelock_upgrade.aleo",
      ],
      imports: {
        "frozen_base.aleo": [],
        "open_upgrade.aleo": [],
        "admin_upgrade.aleo": [],
        "checksum_upgrade.aleo": ["governance.aleo"],
        "timelock_upgrade.aleo": [],
        "governance.aleo": [],
      },
      networkDeps: [],
    },
  },
] as const;

/**
 * 0f BLOCKING proof gate: the two riskiest adapter paths, with the outcome the
 * gate locks in. `native_runtime_edges` must cold-compile (offline credits.aleo);
 * `external_composition` must fail with its documented marker (the
 * bare-library/struct-type-path finding). If either expectation flips, the gate
 * fails and the finding must be re-evaluated.
 */
export const PROOF_EXPECTATIONS = [
  { project: "native_runtime_edges", expect: "compiles" },
  { project: "external_composition", expect: "fails" },
] as const;

/** Non-excluded specs — the projects the lane actually adapts, compiles, runs. */
export const LANE_PROJECTS: readonly SampleGroupSpec[] = SPECS.filter((s) => !s.excluded);

/** Lane projects with an on-chain suite (everything not compile-only). */
export const ON_CHAIN_PROJECTS: readonly SampleGroupSpec[] = LANE_PROJECTS.filter(
  (s) => !s.compileOnly,
);

export function getSpec(name: string): SampleGroupSpec {
  const spec = SPECS.find((s) => s.name === name);
  if (!spec) {
    throw new Error(
      `Unknown leo-samples spec "${name}". Known: ${SPECS.map((s) => s.name).join(", ")}`,
    );
  }
  return spec;
}
