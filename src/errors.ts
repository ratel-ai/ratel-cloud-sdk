/**
 * The client error taxonomy. The v1 surface puts a machine code in `error`
 * ("not_found" | "conflict" | "invalid", per ratel-cloud `lib/suggestions/v1-errors.ts`)
 * and an optional finer-grained code in `reason` ("version_conflict",
 * "not_pending", …); auth failures carry a display sentence instead. We trust
 * a code-shaped `error` body when present and fall back to the HTTP status.
 */

export type CloudSdkErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid"
  | "quota_exceeded"
  | "unavailable"
  | "server_error"
  | "network_error";

export class CloudSdkError extends Error {
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;
  readonly code: CloudSdkErrorCode;
  /** Finer-grained server code, e.g. "version_conflict" | "not_pending". */
  readonly reason: string | null;

  constructor(
    message: string,
    opts: { status: number | null; code: CloudSdkErrorCode; reason?: string | null },
  ) {
    super(message);
    this.name = "CloudSdkError";
    this.status = opts.status;
    this.code = opts.code;
    this.reason = opts.reason ?? null;
  }
}

const CODES_BY_STATUS: Record<number, CloudSdkErrorCode> = {
  400: "invalid",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  402: "quota_exceeded",
  429: "quota_exceeded",
  503: "unavailable",
};

function codeForStatus(status: number): CloudSdkErrorCode {
  return CODES_BY_STATUS[status] ?? (status >= 500 ? "server_error" : "invalid");
}

const KNOWN_BODY_CODES: ReadonlySet<string> = new Set([
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "quota_exceeded",
  "unavailable",
  "server_error",
]);

/** Build the typed error for a non-2xx response body (already JSON-parsed, may be null). */
export function errorFromResponse(status: number, body: unknown): CloudSdkError {
  let bodyError: string | null = null;
  let reason: string | null = null;
  if (body !== null && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") bodyError = b.error;
    if (typeof b.reason === "string") reason = b.reason;
  }
  const code =
    bodyError !== null && KNOWN_BODY_CODES.has(bodyError)
      ? (bodyError as CloudSdkErrorCode)
      : codeForStatus(status);
  const detail = reason ? ` (${reason})` : "";
  // A non-code `error` is a display sentence — keep it as the message.
  const message =
    bodyError !== null && !KNOWN_BODY_CODES.has(bodyError)
      ? bodyError
      : `Ratel Cloud request failed: ${status} ${code}${detail}`;
  return new CloudSdkError(message, { status, code, reason });
}
