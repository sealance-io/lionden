import type { LionDenRuntimeEnvironment } from "@lionden/core";

/**
 * Resolve whether to build standard/proven transactions, shared by the deploy
 * and upgrade actions. Precedence: an explicit per-call/task arg wins; then an
 * explicit `--prove[=true|false]` global (so `--prove=false` disables proving
 * even when LIONDEN_PROVE is set); then the LIONDEN_PROVE env var; else false.
 */
export function resolveProveOption(
  args: Record<string, unknown>,
  lre: LionDenRuntimeEnvironment,
): boolean {
  const explicit = args["prove"];
  if (typeof explicit === "boolean") return explicit;
  const global = lre.globalOptions["prove"];
  if (typeof global === "boolean") return global; // I5: honor explicit false, not just === true
  return process.env["LIONDEN_PROVE"] === "true";
}
