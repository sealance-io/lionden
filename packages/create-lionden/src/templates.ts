/**
 * Project templates for create-lionden.
 * Each template defines the files to generate for a new LionDen project.
 */

export interface TemplateFile {
  /** Relative path from project root */
  readonly path: string;
  /** File contents (with {{name}} placeholder for project name) */
  readonly content: string;
}

export interface Template {
  readonly id: string;
  readonly description: string;
  readonly files: readonly TemplateFile[];
}

// ---------------------------------------------------------------------------
// Shared files (used by all templates)
// ---------------------------------------------------------------------------

export function sharedFiles(projectName: string): TemplateFile[] {
  return [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: projectName,
          version: "0.1.0",
          private: true,
          type: "module",
          scripts: {
            compile: "lionden compile",
            test: "lionden test",
            deploy: "lionden run scripts/deploy.ts",
            node: "lionden node",
          },
          engines: {
            node: "^20.19.0 || >=22.12.0",
          },
          devDependencies: {
            "@lionden/cli": "^0.1.0",
            "@lionden/config": "^0.1.0",
            "@lionden/core": "^0.1.0",
            "@lionden/network": "^0.1.0",
            "@lionden/plugin-deploy": "^0.1.0",
            "@lionden/plugin-leo": "^0.1.0",
            "@lionden/plugin-network": "^0.1.0",
            "@lionden/plugin-test": "^0.1.0",
            "@lionden/testing": "^0.1.0",
            tsx: "^4.0.0",
            typescript: "^5.7.0",
            vitest: "^4.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            verbatimModuleSyntax: true,
            strict: true,
            skipLibCheck: true,
            outDir: "dist",
            declaration: true,
          },
          include: ["typechain/**/*.ts", "recipes/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "lionden.config.ts"],
        },
        null,
        2,
      ) + "\n",
    },
    {
      path: ".gitignore",
      content: `\
node_modules/
dist/
artifacts/
build/
typechain/
.cache/
.aleo/
*.tsbuildinfo
*.log
.env
.env.*
!.env.example
.DS_Store
`,
    },
  ];
}

// ---------------------------------------------------------------------------
// hello-world template
// ---------------------------------------------------------------------------

const HELLO_CONFIG = `\
import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  testing: { timeout: 120_000 },
});
`;

const HELLO_PROGRAM = `\
program hello.aleo {
    @noupgrade
    constructor() {}

    /// Add two unsigned 32-bit integers.
    fn main(a: u32, b: u32) -> u32 {
        return a + b;
    }
}
`;

const HELLO_TEST = `\
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, type TestContext } from "@lionden/testing";
import { createHello } from "../typechain/Hello.js";

let ctx: TestContext | undefined;

beforeAll(async () => {
  ctx = await setup();
  try {
    await ctx.deploy("hello");
  } catch (error) {
    await ctx.teardown();
    ctx = undefined;
    throw error;
  }
});

afterAll(async () => {
  await ctx?.teardown();
});

describe("hello program", () => {
  const hello = createHello();

  beforeAll(() => {
    hello.connect(ctx!.lre);
  });

  it("adds two numbers", async () => {
    expect(await hello.main.locally({ a: 3, b: 5 })).toBe(8);
  });
});
`;

const HELLO_DEPLOY = `\
import type { LionDenRuntimeEnvironment } from "@lionden/core";

export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling...");
  await lre.tasks.run("compile");

  console.log("Deploying hello.aleo...");
  const results = await lre.tasks.run("deploy", { program: "hello" });
  const deploy = (results as Array<{ programId: string; txId: string }>)[0]!;
  console.log(\`Deployed \${deploy.programId} — tx: \${deploy.txId}\`);
}
`;

// ---------------------------------------------------------------------------
// token template
// ---------------------------------------------------------------------------

const TOKEN_RECIPE = `\
import type { DeploymentRecipe } from "@lionden/plugin-deploy";
import { createTokenContract } from "../typechain/index.js";

export interface TokenSetupResult {
  readonly programId: string;
  readonly treasury: string;
  readonly initialSupply: bigint;
}

const INITIAL_SUPPLY = 1_000_000n;

/**
 * Deploy token.aleo and mint initial supply to the treasury.
 *
 * Run from CLI:   lionden recipe --file recipes/setup.ts
 * Run from tests: await setupToken(ctx)  (TestContext satisfies DeploymentContext)
 *
 * Note: this recipe is intended for first-time deployment only. Re-running it
 * on a network where token.aleo is already deployed will fail because the
 * deploy step returns no results when skipDeployed skips all targets and
 * DeploymentContext.deploy() does not accept a noSkipDeployed override.
 */
export const setupToken: DeploymentRecipe<TokenSetupResult> = async (ctx) => {
  const { deployer, treasury } = ctx.named.require({
    deployer: "signer",
    treasury: "address",
  });

  const { programId } = await ctx.deploy("token");

  const token = createTokenContract().connect(ctx.lre);
  await token.withSigner(deployer).mint_public.accepted({
    receiver: treasury,
    amount: INITIAL_SUPPLY,
  });

  return { programId, treasury: treasury.address, initialSupply: INITIAL_SUPPLY };
};

export default setupToken;
`;

const TOKEN_CONFIG = `\
import { defineConfig } from "@lionden/config";
import pluginLeo from "@lionden/plugin-leo";
import pluginNetwork from "@lionden/plugin-network";
import pluginDeploy from "@lionden/plugin-deploy";
import pluginTest from "@lionden/plugin-test";

export default defineConfig({
  plugins: [pluginLeo, pluginNetwork, pluginDeploy, pluginTest],
  leoVersion: "4.0.0",
  defaultNetwork: "devnode",
  networks: {
    devnode: { type: "devnode", autoBlock: true },
  },
  namedAccounts: {
    deployer: {
      default: 0,
      // testnet: configVariable("DEPLOYER_KEY"),
    },
    treasury: {
      default: "aleo1fagxe9lxaxektcnqfz4vpp0f9w7muxvwmrprepus8tve4h9fyyzq80pwu5",
    },
  },
  testing: { timeout: 120_000 },
  deploy: { confirmTransactions: true },
});
`;

const TOKEN_PROGRAM = `\
program token.aleo {
    @noupgrade
    constructor() {}

    /// Public balances stored on-chain.
    mapping balances: address => u64;

    /// A private token record.
    record Token {
        owner: address,
        amount: u64,
    }

    /// Mint public tokens to a receiver.
    fn mint_public(public receiver: address, public amount: u64) -> Final {
        return final {
            let current: u64 = balances.get_or_use(receiver, 0u64);
            balances.set(receiver, current + amount);
        };
    }

    /// Transfer public tokens from signer to receiver.
    fn transfer_public(public receiver: address, public amount: u64) -> Final {
        let sender: address = self.signer;
        return final {
            let sender_balance: u64 = balances.get(sender);
            assert(sender_balance >= amount);
            balances.set(sender, sender_balance - amount);

            let receiver_balance: u64 = balances.get_or_use(receiver, 0u64);
            balances.set(receiver, receiver_balance + amount);
        };
    }

    /// Mint private tokens as a record.
    fn mint_private(receiver: address, amount: u64) -> Token {
        return Token {
            owner: receiver,
            amount: amount,
        };
    }

    /// Transfer private tokens.
    fn transfer_private(token: Token, receiver: address, amount: u64) -> (Token, Token) {
        let remaining: u64 = token.amount - amount;
        let to_receiver: Token = Token { owner: receiver, amount: amount };
        let to_sender: Token = Token { owner: token.owner, amount: remaining };
        return (to_receiver, to_sender);
    }
}
`;

const TOKEN_TEST = `\
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, type TestContext } from "@lionden/testing";
import { createTokenContract } from "../typechain/index.js";
import { setupToken } from "../recipes/setup.js";

let ctx: TestContext | undefined;

beforeAll(async () => {
  ctx = await setup();
  try {
    await setupToken(ctx);
  } catch (error) {
    await ctx.teardown();
    ctx = undefined;
    throw error;
  }
});

afterAll(async () => {
  await ctx?.teardown();
});

describe("token program", () => {
  const token = createTokenContract();

  beforeAll(() => {
    token.connect(ctx!.lre);
  });

  it("recipe minted initial supply to treasury", async () => {
    const treasury = ctx!.named.address("treasury");
    expect(await token.getBalances(treasury)).toBe(1_000_000n);
  });

  it("transfers public tokens from a different signer", async () => {
    const account1 = ctx!.accounts[1]!;
    const receiver = ctx!.accounts[2]!;

    const balance1Before = (await token.getBalances(account1)) ?? 0n;

    // Mint tokens to account-1 (default signer is account-0)
    await token.mint_public.accepted({ receiver: account1, amount: 5000n });

    // transfer_public reads self.signer to determine the sender.
    // withSigner switches the transaction signer to account-1.
    await token.withSigner(account1).transfer_public.accepted({ receiver, amount: 2000n });

    // account-1: +5000 (mint) -2000 (transfer) = +3000 delta
    expect(await token.getBalances(account1)).toBe(balance1Before + 3000n);
  });

  it("mints private tokens as a typed Token record", async () => {
    const receiver = ctx!.accounts[1]!;
    const record = await token.mint_private.locally({ receiver, amount: 100n });
    // Owner comes back with a \`.private\` visibility suffix on record outputs.
    expect(record.owner.startsWith(receiver.address)).toBe(true);
    expect(record.amount).toBe(100n);
  });

  describe("named accounts", () => {
    it("deployer resolves to a signable devnode account", () => {
      const deployer = ctx!.named.signer("deployer");
      expect(deployer.address).toMatch(/^aleo1/);
    });

    it("treasury resolves to an address-only account", () => {
      const treasury = ctx!.named.address("treasury");
      expect(treasury.type).toBe("address-only");
    });
  });
});
`;

const TOKEN_DEPLOY = `\
import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Deploy the token program and mint initial supply to the treasury.
 * Usage: lionden run scripts/deploy.ts
 *
 * Targets lre.config.defaultNetwork. For a different network use:
 *   lionden recipe --file recipes/setup.ts --network <name>
 */
export default async function (lre: LionDenRuntimeEnvironment) {
  await lre.tasks.run("recipe", { file: "recipes/setup.ts" });
}
`;

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------

export const TEMPLATES: readonly Template[] = [
  {
    id: "hello-world",
    description: "A minimal Leo program with a single add function",
    files: [
      { path: "lionden.config.ts", content: HELLO_CONFIG },
      { path: "programs/hello/main.leo", content: HELLO_PROGRAM },
      { path: "test/hello.test.ts", content: HELLO_TEST },
      { path: "scripts/deploy.ts", content: HELLO_DEPLOY },
    ],
  },
  {
    id: "token",
    description: "A token program with mint, transfer, and balance mapping",
    files: [
      { path: "lionden.config.ts", content: TOKEN_CONFIG },
      { path: "programs/token/main.leo", content: TOKEN_PROGRAM },
      { path: "recipes/setup.ts", content: TOKEN_RECIPE },
      { path: "test/token.test.ts", content: TOKEN_TEST },
      { path: "scripts/deploy.ts", content: TOKEN_DEPLOY },
    ],
  },
];

export function getTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export function getTemplateIds(): string[] {
  return TEMPLATES.map((t) => t.id);
}
