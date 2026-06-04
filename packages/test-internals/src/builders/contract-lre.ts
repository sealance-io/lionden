import type { LionDenResolvedConfig } from "@lionden/config";
import type { LionDenPlugin, LionDenRuntimeEnvironment } from "@lionden/core";
import { createLre, task } from "@lionden/core";
import type { FakeNetworkOptions } from "../fakes/fake-network.js";
import { FakeNetworkConnection, FakeNetworkManager } from "../fakes/fake-network.js";
import { createMockConfig } from "../mock-config.js";
import type { TempProject } from "./temp-project.js";
import { TempProjectBuilder } from "./temp-project.js";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ContractLreOptions {
  /** Plugins to register (order matters). */
  plugins?: LionDenPlugin[];
  /** Config overrides applied via createMockConfig. */
  configOverrides?: Partial<LionDenResolvedConfig>;
  /** Programs to add to the temp project. */
  programs?: Array<{
    name: string;
    source?: string;
    imports?: string[];
    annotation?: string;
  }>;
  /** Use FakeNetworkManager for lre.network. Pass options or `true` for defaults. */
  withNetwork?: boolean | FakeNetworkOptions;
  /** Register a stub "compile" task so other tasks can depend on it. */
  withMockCompile?: boolean;
  /** Pre-populate artifacts for these program IDs after LRE creation. */
  prePopulateArtifacts?: Array<{
    programId: string;
    abi?: unknown;
    aleoSource?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface ContractLreResult {
  readonly lre: LionDenRuntimeEnvironment;
  readonly project: TempProject;
  readonly fakeNetwork?: FakeNetworkConnection;
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a wired-up LRE for contract tests.
 *
 * Combines {@link TempProjectBuilder}, {@link createMockConfig}, and
 * `createLre()` into a single call. Module-level `vi.mock()` statements
 * remain the test file's responsibility — this helper handles wiring only.
 */
export function createContractLre(options: ContractLreOptions = {}): ContractLreResult {
  const {
    plugins: userPlugins = [],
    configOverrides,
    programs = [],
    withNetwork,
    withMockCompile,
    prePopulateArtifacts = [],
  } = options;

  // 1. Build temp project
  const builder = new TempProjectBuilder();
  for (const prog of programs) {
    if (prog.source) {
      builder.addProgram(prog.name, prog.source);
    } else if (prog.imports || prog.annotation !== undefined) {
      builder.addProgramWithImports(prog.name, prog.imports ?? [], prog.annotation);
    } else {
      builder.addProgram(prog.name);
    }
  }
  const project = builder.build();

  // 2. Build config with temp project paths
  const config = createMockConfig({
    paths: {
      root: project.root,
      programs: project.programsDir,
      artifacts: project.artifactsDir,
      typechain: `${project.root}/typechain`,
      cache: `${project.root}/cache`,
      deployments: `${project.root}/deployments`,
    },
    ...configOverrides,
  });

  // 3. Assemble internal plugins
  const internalPlugins: LionDenPlugin[] = [];
  let fakeNetwork: FakeNetworkConnection | undefined;

  if (withMockCompile) {
    internalPlugins.push({
      id: "mock-compile",
      tasks: [
        task("compile", "Mock compile")
          .setAction(async () => {})
          .build(),
      ],
    });
  }

  if (withNetwork) {
    const networkOpts = typeof withNetwork === "object" ? withNetwork : undefined;
    const conn = new FakeNetworkConnection(networkOpts);
    const manager = new FakeNetworkManager({ connection: conn });
    fakeNetwork = conn;

    internalPlugins.push({
      id: "fake-network",
      name: "Fake Network",
      extendLre(lre) {
        (lre as unknown as Record<string, unknown>).network = manager;
      },
    });
  }

  // 4. Create LRE (internal plugins first, then user plugins)
  const allPlugins = [...internalPlugins, ...userPlugins];
  const lre = createLre({ config, plugins: allPlugins });

  // 5. Pre-populate artifacts
  for (const entry of prePopulateArtifacts) {
    if (entry.abi !== undefined) {
      lre.artifacts.setAbi(entry.programId, entry.abi);
    }
    if (entry.aleoSource !== undefined) {
      lre.artifacts.setAleoSource(entry.programId, entry.aleoSource);
    }
  }

  return {
    lre,
    project,
    fakeNetwork,
    cleanup() {
      project.cleanup();
    },
  };
}
