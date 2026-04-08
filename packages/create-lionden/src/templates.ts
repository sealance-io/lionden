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
          include: ["test/**/*.ts", "scripts/**/*.ts", "lionden.config.ts"],
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
    /// Add two unsigned 32-bit integers.
    fn main(a: u32, b: u32) -> u32 {
        return a + b;
    }
}
`;

const HELLO_TEST = `\
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { setup, type TestContext } from "@lionden/testing";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  await ctx.deploy("hello");
});

afterAll(async () => {
  await ctx.teardown();
});

describe("hello program", () => {
  it("adds two numbers", async () => {
    const result = await ctx.execute("hello.aleo", "main", ["3u32", "5u32"]);
    expect(result.outputs[0]).toBe("8u32");
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
  testing: { timeout: 120_000 },
  deploy: { confirmTransactions: true },
});
`;

const TOKEN_PROGRAM = `\
program token.aleo {
    /// Public balances stored on-chain.
    mapping balances: address => u64;

    /// A private token record.
    record Token {
        owner: address,
        amount: u64,
    }

    /// Mint public tokens to the caller.
    fn mint_public(receiver: address, amount: u64) {
        let current: u64 = Mapping::get_or_use(balances, receiver, 0u64);
        Mapping::set(balances, receiver, current + amount);
    }

    /// Transfer public tokens from caller to receiver.
    fn transfer_public(receiver: address, amount: u64) {
        let sender: address = self.caller;
        let sender_balance: u64 = Mapping::get(balances, sender);
        assert(sender_balance >= amount);
        Mapping::set(balances, sender, sender_balance - amount);

        let receiver_balance: u64 = Mapping::get_or_use(balances, receiver, 0u64);
        Mapping::set(balances, receiver, receiver_balance + amount);
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
import { setup, type TestContext, assertMappingValue } from "@lionden/testing";

let ctx: TestContext;

beforeAll(async () => {
  ctx = await setup();
  await ctx.deploy("token");
});

afterAll(async () => {
  await ctx.teardown();
});

describe("token program", () => {
  it("mints public tokens", async () => {
    // Use account-2 so this test is independent of others
    const receiver = ctx.accounts[2]!.address;
    await ctx.execute("token.aleo", "mint_public", [receiver, "1000u64"]);

    await assertMappingValue(
      ctx.connection,
      "token.aleo",
      "balances",
      receiver,
      "1000u64",
    );
  });

  it("transfers public tokens", async () => {
    // Use account-0 (sender) and account-3 (receiver) — isolated from other tests
    const sender = ctx.accounts[0]!.address;
    const receiver = ctx.accounts[3]!.address;

    await ctx.execute("token.aleo", "mint_public", [sender, "2000u64"]);
    await ctx.execute("token.aleo", "transfer_public", [receiver, "500u64"]);

    await assertMappingValue(
      ctx.connection,
      "token.aleo",
      "balances",
      receiver,
      "500u64",
    );
  });

  it("mints private tokens", async () => {
    const receiver = ctx.accounts[1]!.address;
    const result = await ctx.execute("token.aleo", "mint_private", [
      receiver,
      "100u64",
    ]);
    expect(result.outputs).toHaveLength(1);
  });
});
`;

const TOKEN_DEPLOY = `\
import type { LionDenRuntimeEnvironment } from "@lionden/core";

export default async function (lre: LionDenRuntimeEnvironment) {
  console.log("Compiling...");
  await lre.tasks.run("compile");

  console.log("Deploying token.aleo...");
  const results = await lre.tasks.run("deploy", { program: "token" });
  const deploy = (results as Array<{ programId: string; txId: string }>)[0]!;
  console.log(\`Deployed \${deploy.programId} — tx: \${deploy.txId}\`);
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
