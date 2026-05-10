import { describe, expect, expectTypeOf, it } from "vitest";
import {
  asSigner,
  createNamedAccountAccessor,
  isSignable,
  requireNamedAccount,
  requireSignableNamedAccount,
  type NamedAccounts,
  type NamedAccount,
  type NamedAccountAccessor,
  type SignableNamedAccount,
} from "./named-account.js";

const accounts: NamedAccounts = {
  deployer: {
    type: "signable",
    name: "deployer",
    address: "aleo1deployer",
    privateKey: "APrivateKey1deployer",
  },
  treasury: {
    type: "address-only",
    name: "treasury",
    address: "aleo1treasury",
  },
};

describe("named account helpers", () => {
  it("identifies signable accounts and safely rejects missing accounts", () => {
    expect(isSignable(accounts["deployer"])).toBe(true);
    expect(isSignable(accounts["treasury"])).toBe(false);
    expect(isSignable(undefined)).toBe(false);
  });

  it("returns required named accounts", () => {
    expect(requireNamedAccount(accounts, "treasury")).toBe(accounts["treasury"]);
  });

  it("throws a clear error when a required named account is missing", () => {
    expect(() => requireNamedAccount(accounts, "admin")).toThrow(
      `Named account "admin" is not configured.`,
    );
  });

  it("returns required signable named accounts", () => {
    expect(requireSignableNamedAccount(accounts, "deployer")).toBe(
      accounts["deployer"],
    );
  });

  it("throws a clear error when a required signer is address-only", () => {
    expect(() => requireSignableNamedAccount(accounts, "treasury")).toThrow(
      `Named account "treasury" is address-only and cannot be used as a signer.`,
    );
  });

  it("still extracts a plain signer shape from signable accounts", () => {
    expect(asSigner(accounts["deployer"]!)).toEqual({
      address: "aleo1deployer",
      privateKey: "APrivateKey1deployer",
    });
  });
});

describe("createNamedAccountAccessor", () => {
  const named = createNamedAccountAccessor(accounts, "devnode");

  it("returns required address roles", () => {
    expect(named.address("treasury")).toBe(accounts["treasury"]);
    expect(named.address("deployer")).toBe(accounts["deployer"]);
  });

  it("returns required signer roles", () => {
    expect(named.signer("deployer")).toBe(accounts["deployer"]);
  });

  it("throws a standard contract error for missing roles", () => {
    expect(() => named.address("admin")).toThrow(
      [
        `Named accounts contract failed for network "devnode":`,
        `  - "admin" is not configured`,
      ].join("\n"),
    );
  });

  it("throws a standard contract error for address-only signers", () => {
    expect(() => named.signer("treasury")).toThrow(
      [
        `Named accounts contract failed for network "devnode":`,
        `  - "treasury" is address-only but the contract requires a signer`,
      ].join("\n"),
    );
  });

  it("validates a batch contract and returns typed accounts", () => {
    const roles = named.require({
      deployer: "signer",
      treasury: "address",
    });

    expect(roles.deployer).toBe(accounts["deployer"]);
    expect(roles.treasury).toBe(accounts["treasury"]);
    expectTypeOf(roles.deployer).toEqualTypeOf<SignableNamedAccount>();
    expectTypeOf(roles.treasury).toEqualTypeOf<NamedAccount>();
  });

  it("aggregates batch contract failures", () => {
    expect(() =>
      named.require({
        admin: "address",
        treasury: "signer",
      }),
    ).toThrow(
      [
        `Named accounts contract failed for network "devnode":`,
        `  - "admin" is not configured`,
        `  - "treasury" is address-only but the contract requires a signer`,
      ].join("\n"),
    );
  });

  it("infers inline batch specs without as const", () => {
    const roles = named.require({
      deployer: "signer",
      treasury: "address",
    });

    expectTypeOf(roles.deployer).toEqualTypeOf<SignableNamedAccount>();
    expectTypeOf(roles.treasury).toEqualTypeOf<NamedAccount>();
  });

  it("rejects invalid contract types at compile time", () => {
    const typedNamed: NamedAccountAccessor = named;

    if (false) {
      // @ts-expect-error - "siner" is not assignable to NamedAccountRole
      typedNamed.require({ deployer: "siner" });

      const roles = typedNamed.require({
        deployer: "signer",
        treasury: "address",
      });
      // @ts-expect-error - address role result is not guaranteed to be a signer
      const signer: SignableNamedAccount = roles.treasury;
      void signer;
    }

    expect(typedNamed.signer("deployer")).toBe(accounts["deployer"]);
  });
});
