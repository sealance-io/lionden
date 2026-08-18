const STABLE_LEO_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function supportsLeoProgramRename(leoVersion: string): boolean {
  const match = STABLE_LEO_VERSION_RE.exec(leoVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 4 || (major === 4 && minor >= 3);
}

/** The only Leo line whose `deploy`/`upgrade` flag surface the Leo backend targets. */
export const LEO_DEPLOY_BACKEND_LINE = "4.3";

/**
 * Whether `leoVersion` is on the one line the Leo deploy backend supports.
 *
 * Deliberately an exact `4.3.x` assertion rather than a `>=` gate. lionden
 * supports Leo 3.5 through 4.3 for compilation, but the deploy/upgrade flag
 * surface has only been verified against 4.3.x — and unlike the compile path,
 * a wrong flag here can produce a wrong *deployment*, not just a build error.
 * Newer lines are excluded for the same reason: they have not been checked.
 *
 * Unparseable versions are rejected. This is the opposite of the
 * `emitsLegacyBuildFlags` convention, which treats unparseable as modern —
 * that helper picks between two working flag sets, this one decides whether to
 * run at all, so the safe default is the other way around.
 */
export function supportsLeoDeployBackend(leoVersion: string): boolean {
  const match = STABLE_LEO_VERSION_RE.exec(leoVersion);
  if (!match) return false;
  return `${match[1]}.${match[2]}` === LEO_DEPLOY_BACKEND_LINE;
}
