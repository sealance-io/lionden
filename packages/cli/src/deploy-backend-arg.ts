/**
 * Eager validation for `--deploy-backend`, following the `--network` precedent
 * in `index.ts`: fail once, centrally, before a task is dispatched — so a typo
 * cannot cost the user a full compile and a network connection first.
 *
 * `plugin-deploy` validates the same value independently in
 * `resolveDeployBackendOption`, which is what programmatic LRE callers hit.
 * This layer exists for the invocation cases that never reach a resolved value.
 */

import { DEPLOY_PROVIDERS } from "@lionden/config";

/**
 * Every spelling the parser accepts for plugin-deploy's `deployBackend` global.
 * `getPublicArgumentNames` registers both the declared name and its kebab form,
 * so a raw-token scan has to match both.
 */
const FLAG_TOKENS = new Set(["--deploy-backend", "--deployBackend"]);
const FLAG_PREFIXES = ["--deploy-backend=", "--deployBackend="];

/** Whether the user typed the flag at all, in any accepted spelling. */
export function sawDeployBackendFlag(argv: readonly string[]): boolean {
  return argv.some((a) => FLAG_TOKENS.has(a) || FLAG_PREFIXES.some((p) => a.startsWith(p)));
}

/**
 * Reject a `--deploy-backend` that was typed but carries no usable value.
 *
 * Keyed off the raw token rather than the parsed value, because the parser
 * records *nothing* for a value-less option: `lionden --deploy-backend deploy`
 * deliberately leaves `deploy` as the task instead of consuming it as the flag's
 * value — the same protection `--network` relies on. Checking only the parsed
 * value would silently fall through to the default in exactly the case where
 * the user typed the flag and meant something by it.
 *
 * @param argv raw argv (after the node/script prefix)
 * @param parsedValue `parsed.globalArgs.deployBackend`
 */
export function assertDeployBackendArg(argv: readonly string[], parsedValue: unknown): void {
  if (!sawDeployBackendFlag(argv)) return;

  if (typeof parsedValue !== "string" || parsedValue === "") {
    throw new Error(
      `--deploy-backend requires a value. Available backends: ${DEPLOY_PROVIDERS.join(", ")}.`,
    );
  }

  if (!(DEPLOY_PROVIDERS as readonly string[]).includes(parsedValue)) {
    throw new Error(
      `Deploy backend "${parsedValue}" (from --deploy-backend) is not recognized. ` +
        `Available backends: ${DEPLOY_PROVIDERS.join(", ")}.`,
    );
  }
}
