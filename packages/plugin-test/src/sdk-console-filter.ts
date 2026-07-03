/**
 * Provable SDK Vitest console filter.
 *
 * The authoritative SDK log control is still `config.sdk.logLevel`, which
 * flows through `applySdkLogLevel()` to the SDK's `setLogLevel()`. Keep that
 * path as the primary suppression mechanism. This hook is only a Vitest
 * display-layer backstop for SDK/WASM progress chatter that can still surface
 * during proving runs or when tests intentionally raise the SDK log level.
 *
 * Vitest may batch several console writes into one `log.content` value. To
 * avoid hiding real diagnostics, this filter suppresses a batch only when every
 * non-empty line is a reviewed SDK progress/status message.
 *
 * Audited against @provablehq/sdk 0.11.1 and @provablehq/wasm 0.11.1. The
 * current pin is @provablehq/sdk 0.11.3 (snarkVM 4.8.1), which has not yet been
 * re-audited against this allowlist — the SDK's progress-message surface is
 * unchanged in the patch bump as far as we know, but treat this as pending.
 * Re-audit this allowlist whenever either package is bumped.
 */
const ansiPattern = new RegExp("\\u001B(?:[@-Z\\\\-_]|\\[[0-?]*[ -/]*[@-~])", "g");
const leoProgramId = "[A-Za-z][A-Za-z0-9_]*\\.aleo";

const sdkProgressMessages = new Set([
  "Adding program to the process",
  "Authorizing credits.aleo/fee_private",
  "Authorizing credits.aleo/fee_public",
  "Authorizing Fee",
  "Calculating the minimum execution fee",
  "Check program has a valid name",
  "Check program imports are valid and add them",
  "Checking program has a valid name",
  "Create sample deployment",
  "Creating authorization",
  "Creating deployment",
  "Creating deployment transaction",
  "Creating execution transaction",
  "Creating execution transaction for join",
  "Creating execution transaction for split",
  "Creating execution transaction for transfer",
  "Ensuring the fee is sufficient to pay for the deployment",
  "Estimate the deployment fee",
  "Executing fee",
  "Executing Fee",
  "Executing program",
  "Executing split program",
  "Function keys not found in KeyStore or KeyProvider. The function keys will be synthesized",
  "Get the latest block height and determine the consensus version",
  "Inserting externally provided fee proving and verifying keys",
  "Loading function",
  "Loading program",
  "Loading the SnarkVM process",
  "parsing inputs",
  "Preparing inclusion proof for the join execution",
  "Preparing inclusion proofs for execution",
  "Preparing inclusion proofs for fee execution",
  "Private fee specified, but no private fee record provided, estimating fee and finding a matching fee record.",
  "Proving execution",
  "Proving fee execution",
  "Proving the inclusion proof for the transfer execution",
  "Proving the split execution",
  "Proving the transfer execution",
  "Setting program checksum and owner",
  "Setup the program and inputs",
  "Verifying fee execution",
  "Verifying the split execution",
  "Verifying the transfer execution",
]);

const sdkProgressPatterns = [
  new RegExp(`^Adding ${leoProgramId} to the process$`),
  new RegExp(`^Creating authorization for ${leoProgramId}/[A-Za-z][A-Za-z0-9_]*$`),
  new RegExp(`^Creating proving request for ${leoProgramId}/[A-Za-z][A-Za-z0-9_]*$`),
  new RegExp(`^Executing function: ${leoProgramId}/[A-Za-z][A-Za-z0-9_]* on-chain$`),
  new RegExp(`^Inserting externally provided proving and verifying keys for ${leoProgramId} - ?$`),
  /^Importing verifying key for function: [A-Za-z][A-Za-z0-9_]*$/,
  new RegExp(`^Importing program: ${leoProgramId}$`),
  new RegExp(`^Program ${leoProgramId} does not exist on the network(?:, deploying)?\\.\\.\\.$`),
  /^Spawning [0-9]+ threads$/,
];

const sdkProgramEndpointRetryPattern = new RegExp(
  `^Error - response from \\S*/programs?/${leoProgramId}(?:/(?:latest_edition|amendment_count|[0-9]+))?, retrying in [0-9]+ms$`,
);

const sdkMissingProgramIndicators = [
  "404",
  "not found",
  "does not exist",
  "no such program",
  "program not found",
];

const sdkEditionFallbackPattern = new RegExp(
  `^Error finding edition/amendment for ${leoProgramId}\\. Network response: '(.+)'\\. Defaulting to edition [0-9]+, amendment 0\\.$`,
);

export function isProvableSdkConsoleNoise(log: string): boolean {
  const normalized = normalizeConsoleLog(log);
  if (!normalized) return false;

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length > 1) {
    return lines.every(isSingleLineProvableSdkConsoleNoise);
  }

  return isSingleLineProvableSdkConsoleNoise(normalized);
}

function isSingleLineProvableSdkConsoleNoise(log: string): boolean {
  if (sdkProgressMessages.has(log)) return true;
  if (sdkProgressPatterns.some((pattern) => pattern.test(log))) return true;
  if (sdkProgramEndpointRetryPattern.test(log)) return true;

  const editionFallback = sdkEditionFallbackPattern.exec(log);
  if (editionFallback) {
    const networkResponse = editionFallback[1]?.toLowerCase() ?? "";
    return sdkMissingProgramIndicators.some((indicator) => networkResponse.includes(indicator));
  }

  return false;
}

export function silenceProvableSdkConsoleNoise(log: string): false | void {
  if (isProvableSdkConsoleNoise(log)) return false;
}

function normalizeConsoleLog(log: string): string {
  return log.replace(ansiPattern, "").trim();
}
