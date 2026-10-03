import { type RankCandidate, RetrieverError } from "@ratel-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ratelCloud } from "./tool-picker.js";

const TOOLS: RankCandidate[] = [
  { id: "deploy", kind: "tool", text: "deploy Prepare a production release." },
  { id: "rollback", kind: "tool", text: "rollback Roll back the last deploy." },
];

const PICKED = {
  mode: "precise",
  tools: [
    { id: "rollback", name: "rollback", description: "Roll back the last deploy.", score: 0.92 },
    { id: "deploy", name: "deploy", description: "Prepare a production release.", score: 0.31 },
  ],
  confident: true,
  usage: { candidates: 2, questions: 1, input_tokens: 120 },
};

interface Call {
  url: string;
  init: RequestInit;
}

function stub(respond: (call: Call) => Response | Promise<Response> = () => Response.json(PICKED)) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.init.body)) as Record<string, unknown>;
}

async function failure(promise: unknown): Promise<RetrieverError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RetrieverError);
    return error as RetrieverError;
  }
  throw new Error("expected the picker to throw");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ratelCloud().toolPicker", () => {
  it("posts the query to the Tool Picker with the project key", async () => {
    const http = stub();
    const rc = ratelCloud({ apiKey: "rk_test", fetch: http.fetch });

    await rc.toolPicker("roll back prod", TOOLS, 3);

    expect(http.calls).toHaveLength(1);
    const [call] = http.calls;
    expect(call?.url).toBe("https://cloud.ratel.sh/api/v1/tools/pick");
    expect(call?.init.method).toBe("POST");
    const headers = new Headers(call?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer rk_test");
    expect(headers.get("content-type")).toBe("application/json");
    expect(bodyOf(call)).toEqual({ query: "roll back prod", mode: "precise", top_k: 3 });
  });

  it("honours a custom baseUrl without a doubled slash", async () => {
    const http = stub();
    const rc = ratelCloud({
      apiKey: "rk",
      baseUrl: "http://localhost:3000/api/v1/",
      fetch: http.fetch,
    });

    await rc.toolPicker("q", TOOLS, 5);

    expect(http.calls[0]?.url).toBe("http://localhost:3000/api/v1/tools/pick");
  });

  it("caps top_k at the picker's maximum of 20", async () => {
    const http = stub();
    const rc = ratelCloud({ apiKey: "rk", fetch: http.fetch });

    await rc.toolPicker("q", TOOLS, 50);

    expect(bodyOf(http.calls[0]).top_k).toBe(20);
  });

  it("returns the picked ids and scores, best first", async () => {
    const rc = ratelCloud({ apiKey: "rk", fetch: stub().fetch });

    await expect(rc.toolPicker("q", TOOLS, 5)).resolves.toEqual([
      { id: "rollback", score: 0.92 },
      { id: "deploy", score: 0.31 },
    ]);
  });

  describe("modes", () => {
    it("defaults to precise", () => {
      expect(ratelCloud({ apiKey: "rk" }).toolPicker.mode).toBe("precise");
    });

    it.each(["instant", "precise", "exhaustive"] as const)("sends mode %s", async (mode) => {
      const http = stub();
      const picker = ratelCloud({ apiKey: "rk", fetch: http.fetch }).toolPicker.withMode(mode);

      await picker("q", TOOLS, 5);

      expect(picker.mode).toBe(mode);
      expect(bodyOf(http.calls[0]).mode).toBe(mode);
    });

    it("withMode returns a new picker and leaves the original alone", async () => {
      const http = stub();
      const rc = ratelCloud({ apiKey: "rk", fetch: http.fetch });

      const exhaustive = rc.toolPicker.withMode("exhaustive");
      await rc.toolPicker("q", TOOLS, 5);

      expect(exhaustive).not.toBe(rc.toolPicker);
      expect(exhaustive.withMode("instant").mode).toBe("instant");
      expect(bodyOf(http.calls[0]).mode).toBe("precise");
    });
  });

  describe("requests it skips", () => {
    it("returns [] for skill candidates without calling Cloud", async () => {
      const http = stub();
      const rc = ratelCloud({ apiKey: "rk", fetch: http.fetch });

      const ranked = await rc.toolPicker("q", [{ id: "s", kind: "skill", text: "a skill" }], 5);

      expect(ranked).toEqual([]);
      expect(http.calls).toHaveLength(0);
    });

    it("returns [] when there is nothing to rank", async () => {
      const http = stub();
      const rc = ratelCloud({ apiKey: "rk", fetch: http.fetch });

      expect(await rc.toolPicker("q", [], 5)).toEqual([]);
      expect(await rc.toolPicker("q", TOOLS, 0)).toEqual([]);
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("the API key", () => {
    it("falls back to RATEL_API_KEY", async () => {
      vi.stubEnv("RATEL_API_KEY", "rk_env");
      const http = stub();

      await ratelCloud({ fetch: http.fetch }).toolPicker("q", TOOLS, 5);

      expect(new Headers(http.calls[0]?.init.headers).get("authorization")).toBe("Bearer rk_env");
    });

    it("fails with Config before any request when no key is set", async () => {
      vi.stubEnv("RATEL_API_KEY", "");
      const http = stub();

      const error = await failure(ratelCloud({ fetch: http.fetch }).toolPicker("q", TOOLS, 5));

      expect(error.code).toBe("Config");
      expect(error.transient).toBe(false);
      expect(error.message).toContain("RATEL_API_KEY");
      expect(http.calls).toHaveLength(0);
    });
  });

  describe("errors", () => {
    function errorResponse(status: number, headers?: Record<string, string>): Response {
      return Response.json(
        { error: { message: `cloud says ${status}`, type: "invalid_request_error" } },
        { status, ...(headers === undefined ? {} : { headers }) },
      );
    }

    it.each([
      [400, "InvalidRequest", false],
      [413, "InvalidRequest", false],
      [401, "Unauthorized", false],
      [403, "Unauthorized", false],
      [402, "InsufficientCredits", false],
      [409, "NoSyncedTools", false],
      [429, "RateLimited", true],
      [502, "Unavailable", true],
      [503, "Unavailable", true],
      [504, "Timeout", true],
      [500, "Http", true],
      [418, "Http", false],
    ] as const)("maps HTTP %i to %s (transient: %s)", async (status, code, transient) => {
      const rc = ratelCloud({ apiKey: "rk", fetch: stub(() => errorResponse(status)).fetch });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.code).toBe(code);
      expect(error.transient).toBe(transient);
      expect(error.status).toBe(status);
      expect(error.message).toContain(`cloud says ${status}`);
    });

    it("tells the caller to sync the catalog on 409", async () => {
      const rc = ratelCloud({ apiKey: "rk", fetch: stub(() => errorResponse(409)).fetch });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.message).toContain("attach(");
      expect(error.message).toContain("flush()");
    });

    it("carries Retry-After seconds on 429", async () => {
      const rc = ratelCloud({
        apiKey: "rk",
        fetch: stub(() => errorResponse(429, { "retry-after": "7" })).fetch,
      });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.retryAfterSecs).toBe(7);
    });

    it("leaves retryAfterSecs unset without a numeric Retry-After", async () => {
      for (const headers of [undefined, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }]) {
        const rc = ratelCloud({
          apiKey: "rk",
          fetch: stub(() => errorResponse(429, headers)).fetch,
        });

        const error = await failure(rc.toolPicker("q", TOOLS, 5));

        expect(error.code).toBe("RateLimited");
        expect(error.retryAfterSecs).toBeUndefined();
      }
    });

    it("falls back to the status line when the error body is not JSON", async () => {
      const rc = ratelCloud({
        apiKey: "rk",
        fetch: stub(() => new Response("<html>bad gateway</html>", { status: 502 })).fetch,
      });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.code).toBe("Unavailable");
      expect(error.message).toContain("502");
    });

    it("maps a network failure to Unreachable", async () => {
      const rc = ratelCloud({
        apiKey: "rk",
        fetch: stub(() => {
          throw new TypeError("fetch failed");
        }).fetch,
      });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.code).toBe("Unreachable");
      expect(error.transient).toBe(true);
      expect(error.status).toBeUndefined();
    });

    it.each([
      ["non-JSON", () => new Response("not json", { status: 200 })],
      ["no tools array", () => Response.json({ mode: "precise" })],
      ["a tool without an id", () => Response.json({ tools: [{ score: 0.5 }] })],
      ["a non-numeric score", () => Response.json({ tools: [{ id: "deploy", score: "high" }] })],
    ])("maps a 2xx with %s to Malformed", async (_label, respond) => {
      const rc = ratelCloud({ apiKey: "rk", fetch: stub(respond).fetch });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.code).toBe("Malformed");
      expect(error.transient).toBe(true);
      expect(error.status).toBe(200);
    });
  });

  describe("timeouts", () => {
    function hangUntilAborted(call: Call): Promise<Response> {
      return new Promise((_resolve, reject) => {
        call.init.signal?.addEventListener("abort", () => reject(call.init.signal?.reason));
      });
    }

    it("maps a client timeout to Timeout", async () => {
      const rc = ratelCloud({ apiKey: "rk", timeoutMs: 20, fetch: stub(hangUntilAborted).fetch });

      const error = await failure(rc.toolPicker("q", TOOLS, 5));

      expect(error.code).toBe("Timeout");
      expect(error.transient).toBe(true);
    });

    it.each([
      ["instant", 15_000],
      ["precise", 15_000],
      ["exhaustive", 60_000],
    ] as const)("gives %s a %i ms budget", async (mode, budget) => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      const rc = ratelCloud({ apiKey: "rk", fetch: stub().fetch });

      await rc.toolPicker.withMode(mode)("q", TOOLS, 5);

      expect(timeout).toHaveBeenCalledWith(budget);
    });
  });
});
