import { describe, expect, it } from "vitest";
import { isProvableSdkConsoleNoise, silenceProvableSdkConsoleNoise } from "./sdk-console-filter.js";

describe("sdk-console-filter", () => {
  it("suppresses current Provable SDK progress messages", () => {
    const messages = [
      "Creating deployment transaction",
      "Creating deployment",
      "Checking program has a valid name",
      "Importing program: credits.aleo",
      "Adding credits.aleo to the process",
      "Loading program",
      "Loading function",
      "Creating authorization for hello.aleo/run",
      "Creating proving request for hello.aleo/run",
      "Loading the SnarkVM process",
      "Setup the program and inputs",
      "Check program imports are valid and add them",
      "Importing verifying key for function: transfer_public",
      "Authorizing credits.aleo/fee_public",
      "Authorizing credits.aleo/fee_private",
      "Authorizing Fee",
      "Executing Fee",
      "Inserting externally provided fee proving and verifying keys",
      "Inserting externally provided proving and verifying keys for hello.aleo - ",
      "Executing function: hello.aleo/main on-chain",
      "Function keys not found in KeyStore or KeyProvider. The function keys will be synthesized",
      "parsing inputs",
      "Calculating the minimum execution fee",
      "Preparing inclusion proofs for fee execution",
      "Program hello.aleo does not exist on the network, deploying...",
      "Program hello.aleo does not exist on the network...",
    ];

    for (const message of messages) {
      expect(isProvableSdkConsoleNoise(message), message).toBe(true);
    }
  });

  it("strips ANSI escape sequences and trims before matching", () => {
    expect(isProvableSdkConsoleNoise(" \x1B[32mCreating deployment transaction\x1B[0m\n")).toBe(
      true,
    );
  });

  it("suppresses multi-line Vitest batches only when every line is SDK noise", () => {
    expect(
      isProvableSdkConsoleNoise(`Creating deployment transaction
Checking program has a valid name
Creating deployment
Setting program checksum and owner`),
    ).toBe(true);

    expect(
      isProvableSdkConsoleNoise(`Creating deployment transaction
PROBE_USER_LOG`),
    ).toBe(false);
  });

  it("suppresses program-existence and latest-edition retry chatter only for program endpoints", () => {
    const messages = [
      "Error - response from http://localhost:3030/program/hello.aleo, retrying in 1000ms",
      "Error - response from http://localhost:3030/program/hello.aleo/latest_edition, retrying in 1000ms",
      "Error - response from http://localhost:3030/programs/hello.aleo/amendment_count, retrying in 1000ms",
    ];

    for (const message of messages) {
      expect(isProvableSdkConsoleNoise(message), message).toBe(true);
    }
  });

  it("leaves LionDen status logs and normal user logs visible", () => {
    const messages = [
      "Compiling programs",
      'Running tests against network "altnet"',
      "Tests: 1 passed, 0 failed, 0 skipped (1 files)",
      "user: Creating deployment transaction",
      "Executing program business workflow",
      "Program hello.aleo already exists on the network, please rename your program",
      "Spawning 10 threads",
    ];

    for (const message of messages) {
      expect(isProvableSdkConsoleNoise(message), message).toBe(false);
    }
  });

  it("leaves real errors, stack traces, endpoint failures, and arbitrary retries visible", () => {
    const messages = [
      "Error: Creating deployment transaction failed",
      "Creating deployment transaction\n    at deploy (/tmp/test.ts:12:3)",
      "No network specified",
      "No endpoint specified",
      "Error finding edition/amendment for hello.aleo. Network response: 'No endpoint specified'. Defaulting to edition 1, amendment 0.",
      "Error finding edition/amendment for hello.aleo. Network response: 'fetch failed'. Defaulting to edition 1, amendment 0.",
      "Error finding edition/amendment for hello.aleo. Network response: 'Error fetching amendment count for hello.aleo: Error: 404 Not Found'. Defaulting to edition 1, amendment 0.",
      "Error finding edition/amendment for hello.aleo. Network response: 'Program hello.aleo does not exist'. Defaulting to edition 1, amendment 0.",
      "Error - response from https://example.com/status, retrying in 1000ms",
      "Error - disk full, retrying in 1000ms",
    ];

    for (const message of messages) {
      expect(isProvableSdkConsoleNoise(message), message).toBe(false);
    }
  });

  it("returns false from the Vitest hook only for SDK noise", () => {
    expect(silenceProvableSdkConsoleNoise("Creating deployment transaction")).toBe(false);
    expect(silenceProvableSdkConsoleNoise("No endpoint specified")).toBeUndefined();
  });
});
