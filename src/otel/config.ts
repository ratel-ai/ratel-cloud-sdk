/**
 * Pure endpoint/auth resolution for the Ratel Cloud OTLP destination.
 *
 * No OpenTelemetry import: these helpers only decide *where* telemetry goes and
 * *how* it authenticates, so the precedence rules stay testable without a network
 * or an SDK. The processors in `./processor.ts` consume the result.
 *
 * Routes derive from the same `baseUrl` the management client uses
 * ({@link DEFAULT_BASE_URL}), so a project points both halves of the SDK at one
 * deployment by setting one value.
 */

import { DEFAULT_BASE_URL } from "../transport.js";

/** Env var naming the OTLP traces endpoint. Redirects telemetry to any OTLP backend. */
export const OTLP_ENDPOINT_ENV = "RATEL_OTLP_ENDPOINT";

/** Env var holding the project API key used when `apiKey` is omitted. */
export const API_KEY_ENV = "RATEL_API_KEY";

/** Where telemetry goes and how it authenticates. Shared by both processors. */
export interface RatelOtlpOptions {
  /** Project API key (`rtl_…`), sent as `Authorization: Bearer <key>`. Defaults to `RATEL_API_KEY`. */
  apiKey?: string;
  /**
   * API root the signal routes hang off, default {@link DEFAULT_BASE_URL}. Include
   * the `/api/v1` prefix, exactly as the management client expects it.
   */
  baseUrl?: string;
  /** Full OTLP traces URL. Overrides {@link baseUrl}; defaults to `RATEL_OTLP_ENDPOINT`. */
  endpoint?: string;
  /** Full OTLP logs URL. Defaults to the sibling route derived from the traces URL. */
  logsEndpoint?: string;
  /**
   * Extra headers merged onto every export. An `Authorization` header set here is
   * kept over the `RATEL_API_KEY` env fallback, but an explicit `apiKey` still wins.
   */
  headers?: Record<string, string>;
}

/** Resolved destination config — the pure core of both processors, exposed for testing. */
export interface ResolvedOtlpConfig {
  url: string;
  /** `undefined` when no logs route could be derived and none was given. */
  logsUrl: string | undefined;
  headers: Record<string, string>;
}

/**
 * Resolve {@link RatelOtlpOptions} into concrete exporter config.
 *
 * Endpoint precedence: explicit `endpoint` → `RATEL_OTLP_ENDPOINT` → `${baseUrl}/traces`.
 * Auth precedence: explicit `apiKey` → a caller-supplied `Authorization` header →
 * `RATEL_API_KEY`. Code-level config always beats ambient environment, and ambient
 * environment never clobbers an auth header the caller set deliberately.
 *
 * Pure and env-injectable so the precedence is provable without a network.
 */
export function resolveOtlpConfig(
  opts: RatelOtlpOptions = {},
  env: Record<string, string | undefined> = process.env,
): ResolvedOtlpConfig {
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = opts.endpoint ?? env[OTLP_ENDPOINT_ENV] ?? `${baseUrl}/traces`;

  const headers: Record<string, string> = { ...opts.headers };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  } else if (env[API_KEY_ENV] && !hasAuthorizationHeader(headers)) {
    headers.Authorization = `Bearer ${env[API_KEY_ENV]}`;
  }

  return { url, logsUrl: opts.logsEndpoint ?? deriveLogsUrl(url), headers };
}

/**
 * Swap a trailing `/traces` path segment for `/logs`, covering both the Cloud route
 * (`/api/v1/traces`) and a bare collector route (`/v1/traces`).
 *
 * Returns `undefined` when the traces URL has no such segment: a caller pointing at
 * a custom path gets an explicit "pass logsEndpoint" error from the logs processor
 * rather than logs silently POSTed at the traces route.
 */
function deriveLogsUrl(tracesUrl: string): string | undefined {
  const derived = tracesUrl.replace(/\/traces(?=\/?(?:[?#]|$))/, "/logs");
  return derived === tracesUrl ? undefined : derived;
}

/** Whether the caller already supplied an `Authorization` header (any casing). */
function hasAuthorizationHeader(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}
