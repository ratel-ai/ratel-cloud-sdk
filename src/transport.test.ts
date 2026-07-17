import { describe, expect, it } from "vitest";
import { CloudSdkError } from "./errors.js";
import { Transport } from "./transport.js";

function fetchStub(respond: (url: string, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch;
  calls: { url: string; init: RequestInit | undefined }[];
} {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  }) as typeof fetch;
  return { fetch: impl, calls };
}

const OPTS = { apiKey: "rtl_k", baseUrl: "https://x.test/api/v1" };

describe("Transport", () => {
  it("joins base URL, path, and query; sends Bearer auth and JSON body", async () => {
    const stub = fetchStub(() => Response.json({ ok: true }));
    const t = new Transport({ ...OPTS, fetch: stub.fetch });
    await t.request("POST", "/things", {
      query: { a: "1", skip: undefined },
      body: { hello: "world" },
    });
    const call = stub.calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe("https://x.test/api/v1/things?a=1");
    const headers = call?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer rtl_k");
    expect(headers["content-type"]).toBe("application/json");
    expect(call?.init?.body).toBe('{"hello":"world"}');
  });

  it("strips a trailing slash from baseUrl", async () => {
    const stub = fetchStub(() => Response.json({}));
    const t = new Transport({ apiKey: "k", baseUrl: "https://x.test/api/v1/", fetch: stub.fetch });
    await t.request("GET", "/catalog");
    expect(stub.calls[0]?.url).toBe("https://x.test/api/v1/catalog");
  });

  it("maps machine-code error bodies to code + reason", async () => {
    const stub = fetchStub(() =>
      Response.json({ error: "conflict", reason: "version_conflict" }, { status: 409 }),
    );
    const t = new Transport({ ...OPTS, fetch: stub.fetch });
    const err = await t.request("GET", "/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudSdkError);
    const cloudErr = err as CloudSdkError;
    expect(cloudErr.status).toBe(409);
    expect(cloudErr.code).toBe("conflict");
    expect(cloudErr.reason).toBe("version_conflict");
  });

  it("keeps a display-sentence error body as the message and maps code by status", async () => {
    const stub = fetchStub(() =>
      Response.json({ error: "Invalid or revoked API key." }, { status: 401 }),
    );
    const t = new Transport({ ...OPTS, fetch: stub.fetch });
    const err = (await t.request("GET", "/x").catch((e: unknown) => e)) as CloudSdkError;
    expect(err.code).toBe("unauthorized");
    expect(err.message).toBe("Invalid or revoked API key.");
  });

  it("maps a 5xx with a non-JSON body to server_error", async () => {
    const stub = fetchStub(() => new Response("<html>boom</html>", { status: 500 }));
    const t = new Transport({ ...OPTS, fetch: stub.fetch });
    const err = (await t.request("GET", "/x").catch((e: unknown) => e)) as CloudSdkError;
    expect(err.code).toBe("server_error");
    expect(err.status).toBe(500);
  });

  it("wraps thrown fetch failures as network_error", async () => {
    const impl = (() => Promise.reject(new Error("socket hangup"))) as typeof fetch;
    const t = new Transport({ ...OPTS, fetch: impl });
    const err = (await t.request("GET", "/x").catch((e: unknown) => e)) as CloudSdkError;
    expect(err.code).toBe("network_error");
    expect(err.status).toBeNull();
    expect(err.message).toContain("socket hangup");
  });

  it("returns statuses listed in acceptStatuses instead of throwing", async () => {
    const stub = fetchStub(() => new Response(null, { status: 304, headers: { etag: '"e"' } }));
    const t = new Transport({ ...OPTS, fetch: stub.fetch });
    const res = await t.request("GET", "/catalog", { acceptStatuses: [304] });
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe('"e"');
    expect(res.json).toBeNull();
  });
});
