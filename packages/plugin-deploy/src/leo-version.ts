const STABLE_LEO_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

export function supportsLeoProgramRename(leoVersion: string): boolean {
  const match = STABLE_LEO_VERSION_RE.exec(leoVersion);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 4 || (major === 4 && minor >= 3);
}
