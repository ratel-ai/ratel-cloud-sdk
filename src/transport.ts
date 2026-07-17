import { CloudSdkError, errorFromResponse } from "./errors.js";

/** Default production API root. All paths are relative to it. */
export const DEFAULT_BASE_URL = "https://cloud.ratel.sh/api/v1";

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface CloudSdkOptions {
  /** Project API key (`rtl_…`), sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** API root, default {@link DEFAULT_BASE_URL}. Include the `/api/v1` prefix. */
  baseUrl?: string;
  /** Injectable for testing; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Per-request timeout. Long-running calls (analyze, generate) override this. */
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Non-2xx statuses to return instead of throwing (e.g. 304 for conditional GET). */
  acceptStatuses?: number[];
  timeoutMs?: number;
}

export interface TransportResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or null when the body was empty / not JSON (e.g. 304). */
  json: unknown;
}

/**
 * Minimal fetch wrapper: base-URL join, Bearer auth, JSON in/out, typed errors.
 * No retries — mutations aren't idempotent and reads are cheap to re-issue at
 * the caller's discretion.
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: CloudSdkOptions) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request(
    method: string,
    path: string,
    opts: RequestOptions = {},
  ): Promise<TransportResponse> {
    let url = this.baseUrl + path;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, v);
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      ...opts.headers,
    };
    let bodyInit: string | null = null;
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      bodyInit = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: bodyInit,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new CloudSdkError(`Ratel Cloud request failed: ${errorMessage(err)}`, {
        status: null,
        code: "network_error",
      });
    }

    let json: unknown = null;
    const text = await response.text();
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    const ok =
      (response.status >= 200 && response.status < 300) ||
      (opts.acceptStatuses ?? []).includes(response.status);
    if (!ok) throw errorFromResponse(response.status, json);
    return { status: response.status, headers: response.headers, json };
  }

  /** Issue a request and return its parsed JSON body typed as `T`. */
  async json<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, path, opts);
    return res.json as T;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
