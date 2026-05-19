import type { SdkEgressPolicy } from "@lionden/network";

/**
 * Shared SDK egress policy for test fakes and mocks. Allowlists the
 * canonical devnode endpoint (`127.0.0.1:3030`) so that tests which
 * accidentally route through the guarded transport surface a clear
 * "blocked host X" error rather than the confusing "(none)" form from
 * an empty allowlist.
 *
 * `test-internals` is private to the workspace, so this constant is the
 * single source of truth for fake/mock connections. The network package's
 * own test files keep parallel local constants (importing from
 * `test-internals` would create a circular dep) but follow the same shape.
 */
export const TEST_DEVNODE_EGRESS_POLICY: SdkEgressPolicy = {
  allowedNetworkHosts: new Set(["127.0.0.1:3030"]),
  violation: "block",
};
