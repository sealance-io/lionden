/**
 * Unit tests for the SDK egress transport factories — `makeNetworkTransport`
 * (user-configurable network-host allowlist with block/warn semantics) and
 * `makeParameterTransport` (hardcoded internal SDK-host allowlist, always
 * blocks). Redirect tests prove every followed Location is re-validated
 * before another socket can be opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkTransport, makeParameterTransport } from "./sdk-adapter.js";

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof Request !== "undefined" && input instanceof Request) return input.url;
  if (input instanceof URL) return input.href;
  return String(input);
}

describe("makeNetworkTransport()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("forwards allowed hosts to fetch", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    const res = await transport("http://127.0.0.1:3030/testnet/stateRoot/latest");
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3030/testnet/stateRoot/latest",
      { redirect: "manual" },
    );
  });

  it("rejects disallowed hosts in block mode without calling fetch", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await expect(
      transport("https://api.provable.com/v2/testnet/statePaths"),
    ).rejects.toThrow(/LionDen blocked SDK network fetch to host "api.provable.com"/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("warns and forwards disallowed hosts in warn mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "warn");
      const res = await transport("https://api.provable.com/v2/testnet/statePaths");
      expect(res.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toMatch(/LionDen blocked SDK network fetch/);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("references sdk.egress.networkHosts in the rejection message", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await expect(transport("https://blocked.example/x")).rejects.toThrow(
      /Extend sdk\.egress\.networkHosts or change sdk\.egress\.violation\./,
    );
  });

  it("accepts URL objects as input", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    const url = new URL("http://127.0.0.1:3030/path");
    const res = await transport(url);
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(url, { redirect: "manual" });
  });

  it("accepts Request objects and extracts the URL for host check", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    const req = new Request("http://127.0.0.1:3030/path");
    const res = await transport(req);
    expect(res.ok).toBe(true);

    const blocked = new Request("https://api.provable.com/v2/x");
    await expect(transport(blocked)).rejects.toThrow(/api\.provable\.com/);
  });

  it("forwards the init argument to fetch", async () => {
    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    const init = { method: "POST", body: '{"x":1}' };
    await transport("http://127.0.0.1:3030/x", init);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:3030/x",
      { ...init, redirect: "manual" },
    );
  });

  it("lists allowed hosts in the rejection message to aid debugging", async () => {
    const transport = makeNetworkTransport(
      new Set(["a.example.com", "b.example.com"]),
      "block",
    );
    await expect(transport("https://blocked.example/x")).rejects.toThrow(
      /Allowed hosts: (a\.example\.com, b\.example\.com|b\.example\.com, a\.example\.com)/,
    );
  });

  it("reports (none) when the allowlist is empty", async () => {
    const transport = makeNetworkTransport(new Set<string>(), "block");
    await expect(transport("https://anywhere.example/x")).rejects.toThrow(
      /Allowed hosts: \(none\)/,
    );
  });

  it("re-validates redirected targets before following in block mode", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://api.provable.com/v2/testnet/statePaths" },
      }),
    );

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await expect(
      transport("http://127.0.0.1:3030/testnet/stateRoot/latest"),
    ).rejects.toThrow(/LionDen blocked SDK network fetch to host "api\.provable\.com"/);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(inputUrl(fetchSpy.mock.calls[0]![0])).toBe(
      "http://127.0.0.1:3030/testnet/stateRoot/latest",
    );
  });

  it("follows redirects when every network target is allowed", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/stateRoot/latest") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:4040/testnet/stateRoot/latest" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const transport = makeNetworkTransport(
      new Set(["127.0.0.1:3030", "127.0.0.1:4040"]),
      "block",
    );
    const res = await transport("http://127.0.0.1:3030/testnet/stateRoot/latest");

    expect(await res.text()).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(inputUrl(fetchSpy.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:4040/testnet/stateRoot/latest",
    );
  });

  it("resolves relative redirect locations against the current URL", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/stateRoot/latest") {
        return new Response(null, {
          status: 302,
          headers: { Location: "../block/1" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await transport("http://127.0.0.1:3030/testnet/stateRoot/latest");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(inputUrl(fetchSpy.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3030/testnet/block/1",
    );
  });

  it("warns and follows redirected network targets in warn mode", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/stateRoot/latest") {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://api.provable.com/v2/testnet/statePaths" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    try {
      const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "warn");
      const res = await transport("http://127.0.0.1:3030/testnet/stateRoot/latest");

      expect(res.ok).toBe(true);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toMatch(/api\.provable\.com/);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("rewrites POST redirects through 302 to GET and drops body headers", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/transaction/broadcast") {
        return new Response(null, {
          status: 302,
          headers: { Location: "/testnet/transaction/accepted" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await transport("http://127.0.0.1:3030/testnet/transaction/broadcast", {
      method: "POST",
      body: "tx",
      headers: {
        "content-encoding": "identity",
        "content-length": "2",
        "content-type": "application/json",
        authorization: "Bearer token",
      },
    });

    const redirectedInit = fetchSpy.mock.calls[1]![1];
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(inputUrl(fetchSpy.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3030/testnet/transaction/accepted",
    );
    expect(redirectedInit?.method).toBe("GET");
    expect(redirectedInit?.body).toBeUndefined();
    expect(new Headers(redirectedInit?.headers).get("content-type")).toBeNull();
    expect(new Headers(redirectedInit?.headers).get("content-length")).toBeNull();
    expect(new Headers(redirectedInit?.headers).get("content-encoding")).toBeNull();
    expect(new Headers(redirectedInit?.headers).get("authorization")).toBe(
      "Bearer token",
    );
  });

  it("preserves method and body through 307 redirects", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/transaction/broadcast") {
        return new Response(null, {
          status: 307,
          headers: { Location: "/testnet/transaction/broadcast2" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await transport("http://127.0.0.1:3030/testnet/transaction/broadcast", {
      method: "POST",
      body: "tx",
      headers: { "content-type": "application/json" },
    });

    const redirectedInit = fetchSpy.mock.calls[1]![1];
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(inputUrl(fetchSpy.mock.calls[1]![0])).toBe(
      "http://127.0.0.1:3030/testnet/transaction/broadcast2",
    );
    expect(redirectedInit?.method).toBe("POST");
    expect(redirectedInit?.body).toBe("tx");
    expect(new Headers(redirectedInit?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("rewrites non-GET 303 redirects to GET", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      if (inputUrl(input) === "http://127.0.0.1:3030/testnet/transaction/broadcast") {
        return new Response(null, {
          status: 303,
          headers: { Location: "/testnet/transaction/accepted" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await transport("http://127.0.0.1:3030/testnet/transaction/broadcast", {
      method: "PUT",
      body: "tx",
    });

    const redirectedInit = fetchSpy.mock.calls[1]![1];
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(redirectedInit?.method).toBe("GET");
    expect(redirectedInit?.body).toBeUndefined();
  });

  it("rejects redirect loops before issuing another request", async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "/testnet/stateRoot/latest" },
      }),
    );

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await expect(
      transport("http://127.0.0.1:3030/testnet/stateRoot/latest"),
    ).rejects.toThrow(/detected redirect loop/);

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("rejects long redirect chains cleanly", async () => {
    fetchSpy.mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(inputUrl(input));
      const current = Number(url.searchParams.get("r") ?? "0");
      return new Response(null, {
        status: 302,
        headers: { Location: `/testnet/stateRoot/latest?r=${current + 1}` },
      });
    });

    const transport = makeNetworkTransport(new Set(["127.0.0.1:3030"]), "block");
    await expect(
      transport("http://127.0.0.1:3030/testnet/stateRoot/latest?r=0"),
    ).rejects.toThrow(/exceeded 20 redirects/);

    expect(fetchSpy).toHaveBeenCalledTimes(21);
    expect(inputUrl(fetchSpy.mock.calls[20]![0])).toBe(
      "http://127.0.0.1:3030/testnet/stateRoot/latest?r=20",
    );
  });
});

describe("makeParameterTransport()", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    globalThis.fetch = originalFetch;
  });

  it("allows the WASM-baked Provable parameter host", async () => {
    const transport = makeParameterTransport();
    const res = await transport(
      "https://parameters.provable.com/testnet/fee_public.prover",
    );
    expect(res.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("allows the S3 mirror", async () => {
    const transport = makeParameterTransport();
    const res = await transport(
      "https://s3.us-west-1.amazonaws.com/testnet.parameters/fee_public.prover",
    );
    expect(res.ok).toBe(true);
  });

  it("allows the legacy Aleo Labs parameters host", async () => {
    const transport = makeParameterTransport();
    const res = await transport(
      "https://parameters.aleo.org/testnet/powers-of-beta-16.usrs.84631bc",
    );
    expect(res.ok).toBe(true);
  });

  it("blocks an unknown parameter host with the stale-allowlist wording", async () => {
    const transport = makeParameterTransport();
    await expect(
      transport("https://attacker.example/testnet/fee_public.prover"),
    ).rejects.toThrow(
      /LionDen does not recognize SDK parameter host "attacker\.example"/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never warns and forwards — even unknown hosts always block", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const transport = makeParameterTransport();
      await expect(
        transport("https://attacker.example/x"),
      ).rejects.toThrow(/stale LionDen allowlist/);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("lists the known hosts in the rejection message", async () => {
    const transport = makeParameterTransport();
    await expect(transport("https://attacker.example/x")).rejects.toThrow(
      /Known hosts: parameters\.provable\.com, s3\.us-west-1\.amazonaws\.com, parameters\.aleo\.org/,
    );
  });

  it("re-validates redirected parameter targets before following", async () => {
    fetchSpy.mockImplementation(async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://attacker.example/testnet/fee_public.prover" },
      }),
    );

    const transport = makeParameterTransport();
    await expect(
      transport("https://parameters.provable.com/testnet/fee_public.prover"),
    ).rejects.toThrow(
      /LionDen does not recognize SDK parameter host "attacker\.example"/,
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(inputUrl(fetchSpy.mock.calls[0]![0])).toBe(
      "https://parameters.provable.com/testnet/fee_public.prover",
    );
  });
});
