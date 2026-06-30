/**
 * Minimal structural interface for accessing deployment cache from the
 * testing package without depending on @lionden/plugin-deploy.
 *
 * DeploymentManagerImpl satisfies this interface structurally.
 */

export interface CachedDeploymentRecord {
  readonly status: string;
  readonly programId: string;
  readonly txId?: string | null;
  readonly blockHeight?: number | null;
}

export interface DeploymentCacheAccessor {
  getCached(programId: string, network?: string): CachedDeploymentRecord | null;
  invalidateSession(network: string): void;
}
