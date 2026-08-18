/**
 * Effective deploy-backend selection.
 *
 * Sits alongside `resolveProveOption` (`../prove.ts`) in role — read a
 * preference from the invocation, the environment, and config — but the ladder
 * is deeper: `--prove` has no config layer, while the backend has both a
 * per-network and a project-wide one, and per-network outranks project-wide.
 *
 * Lives here rather than next to `prove.ts` because `resolveDeployBackend` in
 * this directory is its only consumer.
 */

import { DEPLOY_PROVIDERS, type DeployProvider, type LionDenResolvedConfig } from "@lionden/config";
import type { LionDenRuntimeEnvironment } from "@lionden/core";
import { DeployError } from "../errors.js";

export const DEPLOY_BACKEND_ENV_VAR = "LIONDEN_DEPLOY_BACKEND";

/** Human-readable provider list for error messages: `"sdk", "leo"`. */
export function formatDeployProviders(): string {
  return DEPLOY_PROVIDERS.map((p) => `"${p}"`).join(", ");
}

export function isDeployProvider(value: unknown): value is DeployProvider {
  return typeof value === "string" && (DEPLOY_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Narrow one layer's raw value. Only `undefined` means "this layer is unset,
 * fall through"; anything else present but unrecognized — including `null` and
 * `""` — is a hard error rather than a silent fall-through, so a typo
 * (`--deploy-backend Leo`) or a malformed invocation (`--deploy-backend=`) can
 * never quietly resolve to the default.
 *
 * `emptyIsUnset` exists for the environment variable alone. In a shell, `FOO=`
 * is an ordinary way to clear a variable, and `parseBooleanEnv` (`config/env.ts`)
 * already treats an empty env value as unset; diverging from that here would be
 * surprising. No other layer gets the exemption.
 */
function readLayer(
  value: unknown,
  source: string,
  { emptyIsUnset = false }: { emptyIsUnset?: boolean } = {},
): DeployProvider | undefined {
  if (value === undefined) return undefined;
  if (emptyIsUnset && value === "") return undefined;
  if (isDeployProvider(value)) return value;
  const shown = value === "" ? "an empty value" : JSON.stringify(value);
  throw new DeployError(
    `Invalid deploy backend ${shown} from ${source}. ` +
      `Expected one of: ${formatDeployProviders()}.`,
  );
}

/**
 * Resolve the backend that will build this invocation's deploy/upgrade
 * transactions.
 *
 * Precedence, highest first:
 *
 * 1. an explicit per-call argument
 * 2. `--deploy-backend` (seeded into `lre.globalOptions` by the CLI)
 * 3. `LIONDEN_DEPLOY_BACKEND`
 * 4. `config.networks[networkName].deployBackend`
 * 5. `config.deploy.backend`
 * 6. `"sdk"`
 *
 * Layers 4 and 5 are only distinguishable because `resolveNetworkConfig`
 * conditionally spreads `deployBackend` — an explicit `deployBackend: "sdk"` on
 * the network must beat `deploy.backend: "leo"`, which requires "unset" and
 * "explicitly sdk" to be different values.
 *
 * Called from `deployAction` and `upgradeAction` only. `recipeAction` resolves
 * nothing itself; it inherits the backend through the deploy task it dispatches.
 */
export function resolveDeployBackendOption(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
  networkName: string,
): DeployProvider {
  const explicit = readLayer(args["deployBackend"], "the deployBackend argument");
  if (explicit) return explicit;

  const global = readLayer(lre.globalOptions["deployBackend"], "--deploy-backend");
  if (global) return global;

  return resolveDeployBackendFromEnvAndConfig(lre.config, networkName);
}

/**
 * The tail of the ladder — layers 3 through 6 — for callers that have a config
 * but no LRE.
 *
 * `DeploymentManager.preflight()` is the programmatic entry point and takes no
 * `args`/`lre`, so `--deploy-backend` is genuinely out of reach there. It is
 * the same situation the manager is already in for every other global option,
 * and the environment variable still applies because it is process-global.
 */
export function resolveDeployBackendFromEnvAndConfig(
  config: LionDenResolvedConfig,
  networkName: string,
): DeployProvider {
  const env = readLayer(process.env[DEPLOY_BACKEND_ENV_VAR], DEPLOY_BACKEND_ENV_VAR, {
    emptyIsUnset: true,
  });
  if (env) return env;

  const perNetwork = readLayer(
    config.networks[networkName]?.deployBackend,
    `networks.${networkName}.deployBackend`,
  );
  if (perNetwork) return perNetwork;

  return readLayer(config.deploy.backend, "deploy.backend") ?? "sdk";
}
