import { describe, expect, it } from "vitest";
import {
  API_KEY_ENV,
  OTLP_ENDPOINT_ENV,
  OTLP_LOGS_ENDPOINT_ENV,
  resolveOtlpConfig,
  resolveOtlpLogsConfig,
} from "./config.js";

/** No ambient environment leaks into these cases unless a test opts in. */
const NO_ENV: Record<string, string | undefined> = {};

describe("resolveOtlpConfig — endpoint precedence", () => {
  it("defaults to the Cloud traces route derived from the client's base URL", () => {
    expect(resolveOtlpConfig({}, NO_ENV).url).toBe("https://cloud.ratel.sh/api/v1/traces");
  });

  it("derives the route from an explicit baseUrl, stripping trailing slashes", () => {
    expect(resolveOtlpConfig({ baseUrl: "https://eu.ratel.sh/api/v1/" }, NO_ENV).url).toBe(
      "https://eu.ratel.sh/api/v1/traces",
    );
  });

  it("lets RATEL_OTLP_ENDPOINT redirect to any OTLP backend", () => {
    const env = { [OTLP_ENDPOINT_ENV]: "https://collector.internal/v1/traces" };
    expect(resolveOtlpConfig({}, env).url).toBe("https://collector.internal/v1/traces");
  });

  it("prefers an explicit endpoint over the environment", () => {
    const env = { [OTLP_ENDPOINT_ENV]: "https://from-env/v1/traces" };
    expect(resolveOtlpConfig({ endpoint: "https://explicit/v1/traces" }, env).url).toBe(
      "https://explicit/v1/traces",
    );
  });

  it("prefers a full endpoint over a baseUrl", () => {
    const resolved = resolveOtlpConfig(
      { baseUrl: "https://eu.ratel.sh/api/v1", endpoint: "https://collector/v1/traces" },
      NO_ENV,
    );
    expect(resolved.url).toBe("https://collector/v1/traces");
  });
});

describe("resolveOtlpConfig — auth precedence", () => {
  it("sends an explicit apiKey as Bearer", () => {
    expect(resolveOtlpConfig({ apiKey: "rtl_explicit" }, NO_ENV).headers).toEqual({
      Authorization: "Bearer rtl_explicit",
    });
  });

  it("falls back to RATEL_API_KEY when no key is passed", () => {
    const env = { [API_KEY_ENV]: "rtl_from_env" };
    expect(resolveOtlpConfig({}, env).headers).toEqual({ Authorization: "Bearer rtl_from_env" });
  });

  it("never lets ambient env clobber an Authorization header the caller set on purpose", () => {
    const env = { [API_KEY_ENV]: "rtl_from_env" };
    const resolved = resolveOtlpConfig({ headers: { Authorization: "Bearer deliberate" } }, env);
    expect(resolved.headers.Authorization).toBe("Bearer deliberate");
  });

  it("detects a caller's Authorization header regardless of casing", () => {
    const env = { [API_KEY_ENV]: "rtl_from_env" };
    const resolved = resolveOtlpConfig({ headers: { authorization: "Bearer deliberate" } }, env);
    expect(resolved.headers).toEqual({ authorization: "Bearer deliberate" });
  });

  it("lets code-level apiKey win over a caller's Authorization header", () => {
    const resolved = resolveOtlpConfig(
      { apiKey: "rtl_explicit", headers: { Authorization: "Bearer stale" } },
      NO_ENV,
    );
    expect(resolved.headers.Authorization).toBe("Bearer rtl_explicit");
  });

  it("carries unrelated headers through untouched", () => {
    const resolved = resolveOtlpConfig({ apiKey: "k", headers: { "x-tenant": "acme" } }, NO_ENV);
    expect(resolved.headers["x-tenant"]).toBe("acme");
  });

  it("sends no Authorization header at all when no key is resolvable", () => {
    expect(resolveOtlpConfig({}, NO_ENV).headers).toEqual({});
  });
});

describe("resolveOtlpConfig — resolved shape", () => {
  it("resolves a traces route and headers, and nothing else", () => {
    // Traces are the entire destination: Cloud reads content capture as span
    // events on the same signal, so there is no second route to resolve.
    expect(Object.keys(resolveOtlpConfig({ apiKey: "k" }, NO_ENV)).sort()).toEqual([
      "headers",
      "url",
    ]);
  });
});

describe("resolveOtlpLogsConfig — endpoint precedence", () => {
  it("defaults to the Cloud logs route derived from the client's base URL", () => {
    expect(resolveOtlpLogsConfig({}, NO_ENV).url).toBe("https://cloud.ratel.sh/api/v1/logs");
  });

  it("strips trailing slashes from an explicit baseUrl", () => {
    expect(resolveOtlpLogsConfig({ baseUrl: "https://eu.ratel.sh/api/v1/" }, NO_ENV).url).toBe(
      "https://eu.ratel.sh/api/v1/logs",
    );
  });

  it("uses the logs-specific environment endpoint", () => {
    const env = { [OTLP_LOGS_ENDPOINT_ENV]: "https://collector.internal/v1/logs" };
    expect(resolveOtlpLogsConfig({}, env).url).toBe("https://collector.internal/v1/logs");
  });

  it("prefers an explicit endpoint over environment and baseUrl", () => {
    const env = { [OTLP_LOGS_ENDPOINT_ENV]: "https://from-env/v1/logs" };
    expect(
      resolveOtlpLogsConfig(
        { baseUrl: "https://eu.ratel.sh/api/v1", endpoint: "https://explicit/v1/logs" },
        env,
      ).url,
    ).toBe("https://explicit/v1/logs");
  });
});

describe("resolveOtlpLogsConfig — auth parity", () => {
  it("preserves the trace resolver's header precedence", () => {
    const env = { [API_KEY_ENV]: "rtl_from_env" };
    expect(
      resolveOtlpLogsConfig(
        {
          apiKey: "rtl_explicit",
          headers: { Authorization: "Bearer stale", "x-tenant": "acme" },
        },
        env,
      ).headers,
    ).toEqual({ Authorization: "Bearer rtl_explicit", "x-tenant": "acme" });
    expect(
      resolveOtlpLogsConfig({ headers: { authorization: "Bearer deliberate" } }, env).headers,
    ).toEqual({ authorization: "Bearer deliberate" });
  });
});
