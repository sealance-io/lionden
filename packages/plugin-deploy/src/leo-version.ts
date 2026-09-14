const STABLE_LEO_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function supportsLeoProgramRename(leoVersion: string): boolean {
  const match = STABLE_LEO_VERSION_RE.exec(leoVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 4 || (major === 4 && minor >= 3);
}

/** The Leo lines whose `deploy`/`upgrade` flag surface the Leo backend targets. */
export const LEO_DEPLOY_BACKEND_LINES = ["4.3", "4.4"] as const;
export const LEO_DEPLOY_BACKEND_RANGE = "4.3.x or 4.4.x";

/**
 * Whether `leoVersion` is on a line the Leo deploy backend supports.
 *
 * Deliberately an exact supported-lines assertion rather than a `>=` gate. lionden
 * supports Leo 3.5 through 4.4 for compilation, but the deploy/upgrade flag
 * surface is admitted only after line-specific probes — and unlike the compile
 * path, a wrong flag here can produce a wrong *deployment*, not just a build
 * error. Future lines are excluded until checked.
 *
 * Unparseable versions are rejected. This is the opposite of the
 * `emitsLegacyBuildFlags` convention, which treats unparseable as modern —
 * that helper picks between two working flag sets, this one decides whether to
 * run at all, so the safe default is the other way around.
 */
export function supportsLeoDeployBackend(leoVersion: string): boolean {
  const match = STABLE_LEO_VERSION_RE.exec(leoVersion);
  if (!match) return false;
  const line = `${match[1]}.${match[2]}`;
  return LEO_DEPLOY_BACKEND_LINES.includes(line as (typeof LEO_DEPLOY_BACKEND_LINES)[number]);
}
