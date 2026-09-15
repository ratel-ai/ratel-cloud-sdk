import type { IntentGraph as IntentGraphType } from "@ratel-ai/sdk";
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "../transport.js";
import type { RuntimeEvent } from "../types.js";
import type { RatelRuntimeEvents } from "./attach.js";
import { nonNegative, parseRetryAfter } from "./retry.js";
import { normalizeSourceId } from "./snapshots.js";

const DEFAULT_ENDPOINT = `${DEFAULT_BASE_URL}/intent-graph`;
const DEFAULT_DEBOUNCE_MS = 2_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const QUALIFYING_EVENT_TYPES = new Set(["invoke_start", "skill_invoke"]);

export type IntentGraphSyncStatus = "idle" | "syncing" | "conflict" | "disabled" | "error";

export type IntentGraphSyncErrorKind =
  | "network"
  | "auth"
  | "rate_limited"
  | "invalid_graph"
  | "feature_disabled"
  | "conflict"
  | "setup";

/** Never carries graph content — only rev, status, and a human-readable reason. */
export interface IntentGraphSyncError {
  readonly kind: IntentGraphSyncErrorKind;
  readonly status: number | null;
  readonly message: string;
  readonly rev?: number;
}

/** The only thing this module needs from a runtime's catalog: its event stream. */
export interface IntentGraphSyncCatalog {
  readonly events: RatelRuntimeEvents;
}

export interface IntentGraphSyncOptions {
  /** Stable deployment source. Defaults to the runtime's own event-stream source id. */
  readonly sourceId?: string;
  /** Defaults to `https://cloud.ratel.sh/api/v1/intent-graph`. */
  readonly endpoint?: string;
  /** Project API key. Defaults to `RATEL_API_KEY`. */
  readonly apiKey?: string;
  /** Quiet period after a qualifying invoke before saving. Defaults to 2000 ms. */
  readonly debounceMs?: number;
  /** Cloud held a newer graph (HTTP 409) — swap it into your adaptive ranking. */
  readonly onReplaced?: (graph: IntentGraphType) => void;
  readonly onError?: (err: IntentGraphSyncError) => void;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** @internal injectable for deterministic backoff-jitter tests. */
  readonly random?: () => number;
}

export interface IntentGraphSync {
  readonly graph: IntentGraphType;
  readonly status: IntentGraphSyncStatus;
  /** Save now if `graph.rev` moved, bypassing any pending debounce or backoff wait. */
  flush(): Promise<void>;
  /** Flush once, unsubscribe, and stop all timers. Idempotent. */
  close(): Promise<void>;
}

interface GetOk {
  readonly kind: "ok";
  readonly etag: string | null;
  readonly graphJson: string;
}
type GetOutcome =
  | GetOk
  | { readonly kind: "not_modified" }
  | { readonly kind: "not_found" }
  | { readonly kind: "feature_disabled" }
  | { readonly kind: "auth" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | undefined }
  | { readonly kind: "network" };

interface PutOk {
  readonly kind: "ok";
  readonly etag: string | null;
}
type PutOutcome =
  | PutOk
  | { readonly kind: "conflict" }
  | { readonly kind: "invalid_graph" }
  | { readonly kind: "rejected" }
  | { readonly kind: "feature_disabled" }
  | { readonly kind: "auth" }
  | { readonly kind: "rate_limited"; readonly retryAfterMs: number | undefined }
  | { readonly kind: "network" };

const ATTACHED = new WeakSet<object>();

/**
 * Courier between an app's in-memory `IntentGraph` (ADR-0014, adaptive usage
 * ranking, `@ratel-ai/sdk` >=0.12.0) and Ratel Cloud's per-project,
 * per-source-id graph storage. This function never learns, clusters, ranks,
 * or edits the graph, and never calls `experimentalEnableAdaptiveRanking` /
 * `experimentalDisableAdaptiveRanking` itself — that stays the caller's job.
 */
export async function attachIntentGraphSync(
  catalog: IntentGraphSyncCatalog,
  options: IntentGraphSyncOptions = {},
): Promise<IntentGraphSync> {
  if (ATTACHED.has(catalog)) {
    // Intentional deviation from attach()'s idempotent double-attach reuse:
    // two independent debounce/backoff loops racing to PUT the same source
    // would be a bug, not a valid use case, so this rejects outright.
    throw new Error(
      "@ratel-ai/cloud-sdk/runtime: attachIntentGraphSync was already called for this catalog",
    );
  }
  ATTACHED.add(catalog);

  // A missing/incompatible peer is a caller setup error, not a Cloud
  // connectivity failure — this is the one path allowed to reject; every
  // failure past this point is fail-open.
  const IntentGraphCtor = await loadIntentGraph();

  const enabled = process.env.RATEL_CLOUD_INTENT_GRAPH?.trim().toLowerCase() !== "off";
  if (!enabled) {
    return {
      graph: new IntentGraphCtor(),
      status: "disabled",
      flush: async () => {},
      close: async () => {},
    };
  }

  const sourceId = normalizeSourceId(options.sourceId ?? catalog.events.sourceId);
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const apiKey = options.apiKey ?? process.env.RATEL_API_KEY ?? "";
  const debounceMs = nonNegative(options.debounceMs, DEFAULT_DEBOUNCE_MS);
  const timeoutMs = nonNegative(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetch ?? fetch;
  const randomImpl = options.random ?? Math.random;
  const onReplaced = options.onReplaced;
  const onError = options.onError;

  let graph: IntentGraphType = new IntentGraphCtor();
  let status: IntentGraphSyncStatus = "syncing";
  let etag: string | null = null;
  let savedRev = -1;
  // One-way ratchet: true once a baseline (200 or 404 not_found) is established.
  // No PUT is ever attempted before this, so a locally-accumulated graph can
  // never race its own rev past a stored graph it has never actually seen.
  let loaded = false;
  let skippedUntilRev: number | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let nextAttemptTimer: ReturnType<typeof setTimeout> | undefined;
  let awaitingBackoff = false;
  let dirty = false;
  let inFlightPromise: Promise<void> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let noHandlerWarned = false;
  let errorReportedForCurrentFailure = false;
  // False only during the very first attempt (the one `attachIntentGraphSync`
  // itself awaits before returning). A load that succeeds then has nothing to
  // replace — the app has not been handed a graph yet. Any attempt after that
  // one runs as a background retry while the app already holds `sync.graph`,
  // so a stored graph discovered then is a genuine replacement (onReplaced).
  let firstAttemptDone = false;
  // One-way ratchet: a revoked/invalid key never becomes valid by waiting, so
  // once set, nothing schedules another attempt again — this is a distinct
  // terminal state from `status === "disabled"` (that's Cloud's feature flag).
  let authFailed = false;

  function reportError(err: IntentGraphSyncError): void {
    try {
      onError?.(err);
    } catch {
      // User-provided observability callbacks remain fail-open.
    }
  }

  function reportErrorOnce(err: IntentGraphSyncError): void {
    if (errorReportedForCurrentFailure) return;
    errorReportedForCurrentFailure = true;
    reportError(err);
  }

  function warnReplacedWithoutHandlerOnce(): void {
    if (noHandlerWarned) return;
    noHandlerWarned = true;
    try {
      console.warn(
        `[ratel-cloud-sdk/runtime] intent_graph_conflict: no onReplaced handler was provided — ` +
          `the in-memory graph for source ${JSON.stringify(sourceId)} is now behind Ratel Cloud`,
      );
    } catch {
      // Console diagnostics remain fail-open.
    }
  }

  async function safeJson(response: Response): Promise<Record<string, unknown> | undefined> {
    try {
      const value: unknown = await response.json();
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function doGet(ifNoneMatch: string | null): Promise<GetOutcome> {
    let response: Response;
    try {
      response = await fetchImpl(`${endpoint}?source=${encodeURIComponent(sourceId)}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...(ifNoneMatch ? { "if-none-match": ifNoneMatch } : {}),
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "network" };
    }
    if (response.status === 304) return { kind: "not_modified" };
    if (response.status === 200) {
      const body = await safeJson(response);
      if (body === undefined || body.graph === undefined) return { kind: "network" };
      return {
        kind: "ok",
        etag: response.headers.get("etag"),
        graphJson: JSON.stringify(body.graph),
      };
    }
    const body = await safeJson(response);
    const errorCode = typeof body?.error === "string" ? body.error : undefined;
    if (response.status === 404 && errorCode === "feature_disabled") {
      return { kind: "feature_disabled" };
    }
    if (response.status === 404) return { kind: "not_found" };
    if (response.status === 401) return { kind: "auth" };
    if (response.status === 429) {
      return {
        kind: "rate_limited",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    return { kind: "network" };
  }

  async function doPut(graphJson: string, ifMatch: string | null): Promise<PutOutcome> {
    // String concatenation, not JSON.parse/JSON.stringify, guarantees the
    // opaque graph payload is embedded byte-identical — never reordered,
    // stripped, or mutated.
    const body = `{"source_id":${JSON.stringify(sourceId)},"graph":${graphJson}}`;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          ...(ifMatch ? { "if-match": ifMatch } : {}),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: "network" };
    }
    if (response.status === 200) {
      return { kind: "ok", etag: response.headers.get("etag") };
    }
    const respBody = await safeJson(response);
    const errorCode = typeof respBody?.error === "string" ? respBody.error : undefined;
    if (response.status === 409 && errorCode === "stale_graph") return { kind: "conflict" };
    if (response.status === 400 && errorCode === "invalid_graph") return { kind: "invalid_graph" };
    if (response.status === 404 && errorCode === "feature_disabled") {
      return { kind: "feature_disabled" };
    }
    if (response.status === 401) return { kind: "auth" };
    if (response.status === 413 || response.status === 415) return { kind: "rejected" };
    if (response.status === 429) {
      return {
        kind: "rate_limited",
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      };
    }
    return { kind: "network" };
  }

  function nextBackoffDelay(): number {
    const sample = randomImpl();
    const ratio = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
    // A floor of a quarter of the current backoff keeps full jitter's spread
    // (decorrelating a thundering herd) without letting unlimited retries
    // fire in a near-zero-delay tight loop against Cloud.
    const floor = backoffMs / 4;
    const delay = floor + (backoffMs - floor) * ratio;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    return delay;
  }

  function clearNextAttemptTimer(): void {
    if (nextAttemptTimer === undefined) return;
    clearTimeout(nextAttemptTimer);
    nextAttemptTimer = undefined;
  }

  function scheduleAttempt(delayMs: number): void {
    if (closed) return;
    clearNextAttemptTimer();
    nextAttemptTimer = setTimeout(() => {
      nextAttemptTimer = undefined;
      void triggerAttempt();
    }, delayMs);
    nextAttemptTimer.unref?.();
  }

  /** Shared by every failure branch (load-retry, conflict re-fetch, PUT) that
   * should keep retrying on a growing backoff without blocking the caller. */
  function scheduleRetryOnFailure(retryAfterMs: number | undefined): void {
    awaitingBackoff = true;
    scheduleAttempt(retryAfterMs ?? nextBackoffDelay());
  }

  /** Terminal: Cloud has this project's intent graph sync turned off. Reached
   * from either a GET (load) or a PUT (save) — waiting never recovers this,
   * so there is no retry here, and every other path already treats
   * `status === "disabled"` as a stop condition, so this only ever runs once. */
  function goTerminalDisabled(): void {
    status = "disabled";
    try {
      console.warn(
        `[ratel-cloud-sdk/runtime] intent_graph_disabled: Ratel Cloud has intent graph sync ` +
          `disabled for this project — sync is inactive for source ${JSON.stringify(sourceId)}`,
      );
    } catch {
      // Console diagnostics remain fail-open.
    }
    try {
      subscription.unsubscribe();
    } catch {
      // Detach failures cannot escape into host shutdown.
    }
  }

  /** Adopts an already-fetched authoritative graph — used both when Cloud
   * rejects a save as stale (409) and when a delayed initial load finally
   * discovers a stored graph after local usage accumulated during an outage. */
  function adoptGraphFromCloud(outcome: GetOk): void {
    graph = IntentGraphCtor.fromJson(outcome.graphJson);
    etag = outcome.etag;
    savedRev = graph.rev;
    loaded = true;
    if (onReplaced) {
      try {
        onReplaced(graph);
      } catch {
        // User-provided callbacks remain fail-open.
      }
      noHandlerWarned = false;
    } else {
      warnReplacedWithoutHandlerOnce();
    }
    status = "idle";
    backoffMs = INITIAL_BACKOFF_MS;
    errorReportedForCurrentFailure = false;
  }

  async function handleConflict(): Promise<void> {
    const outcome = await doGet(null);
    if (outcome.kind === "ok") {
      adoptGraphFromCloud(outcome);
      return;
    }
    if (outcome.kind === "auth") {
      status = "error";
      authFailed = true;
      reportErrorOnce({
        kind: "auth",
        status: 401,
        message: "Ratel Cloud rejected the API key while fetching the newer graph after a conflict",
      });
      return;
    }
    // The re-fetch itself failed — keep the stale graph/etag and retry on the
    // normal backoff; the next confirmed invoke (or this retry) picks it up.
    status = "error";
    reportErrorOnce({
      kind: "network",
      status: null,
      message: "failed to fetch the newer graph after a conflict",
    });
    scheduleRetryOnFailure(undefined);
  }

  async function runLoadRetryOnce(): Promise<void> {
    status = "syncing";
    const outcome = await doGet(null);
    if (outcome.kind === "ok") {
      if (firstAttemptDone) {
        // A retry after a prior failure: the app already holds `sync.graph`
        // and may have mutated it, so this is a genuine replacement.
        adoptGraphFromCloud(outcome);
      } else {
        // The very first attempt: nothing has been exposed to the app yet.
        graph = IntentGraphCtor.fromJson(outcome.graphJson);
        etag = outcome.etag;
        savedRev = graph.rev;
        loaded = true;
        status = "idle";
      }
      return;
    }
    if (outcome.kind === "not_found") {
      loaded = true;
      // Whatever the local graph accumulated while unreachable becomes the
      // first version to persist — nothing was stored to conflict with.
      savedRev = graph.rev;
      status = "idle";
      backoffMs = INITIAL_BACKOFF_MS;
      errorReportedForCurrentFailure = false;
      return;
    }
    if (outcome.kind === "feature_disabled") {
      goTerminalDisabled();
      return;
    }
    if (outcome.kind === "auth") {
      status = "error";
      authFailed = true;
      reportErrorOnce({
        kind: "auth",
        status: 401,
        message: "Ratel Cloud rejected the API key — intent graph sync has stopped",
      });
      return;
    }
    const kind: IntentGraphSyncErrorKind =
      outcome.kind === "rate_limited" ? "rate_limited" : "network";
    reportErrorOnce({
      kind,
      status: kind === "rate_limited" ? 429 : null,
      message: "failed to load the intent graph from Ratel Cloud",
    });
    status = "error";
    scheduleRetryOnFailure(outcome.kind === "rate_limited" ? outcome.retryAfterMs : undefined);
  }

  async function handlePutOutcome(outcome: PutOutcome, revAtSend: number): Promise<void> {
    switch (outcome.kind) {
      case "ok": {
        etag = outcome.etag ?? etag;
        savedRev = revAtSend;
        status = "idle";
        backoffMs = INITIAL_BACKOFF_MS;
        errorReportedForCurrentFailure = false;
        return;
      }
      case "conflict": {
        status = "conflict";
        await handleConflict();
        return;
      }
      case "invalid_graph": {
        skippedUntilRev = revAtSend;
        status = "idle";
        reportError({
          kind: "invalid_graph",
          status: 400,
          message: "Ratel Cloud rejected the graph as invalid",
          rev: revAtSend,
        });
        return;
      }
      case "rejected": {
        skippedUntilRev = revAtSend;
        status = "idle";
        reportError({
          kind: "invalid_graph",
          status: null,
          message: "Ratel Cloud rejected the graph payload (size or content type)",
          rev: revAtSend,
        });
        return;
      }
      case "feature_disabled": {
        goTerminalDisabled();
        return;
      }
      case "auth": {
        status = "error";
        authFailed = true;
        reportErrorOnce({
          kind: "auth",
          status: 401,
          message: "Ratel Cloud rejected the API key — intent graph sync has stopped",
        });
        return; // no scheduleRetryOnFailure: waiting never fixes a revoked key
      }
      case "rate_limited": {
        status = "error";
        reportErrorOnce({
          kind: "rate_limited",
          status: 429,
          message: "Ratel Cloud is rate limiting intent graph sync",
        });
        scheduleRetryOnFailure(outcome.retryAfterMs);
        return;
      }
      case "network": {
        status = "error";
        reportErrorOnce({
          kind: "network",
          status: null,
          message: "Ratel Cloud intent graph sync failed",
        });
        scheduleRetryOnFailure(undefined);
        return;
      }
    }
  }

  async function runAttemptOnce(): Promise<void> {
    dirty = false;
    status = "syncing";
    const revAtSend = graph.rev;
    const json = graph.toJson();
    const outcome = await doPut(json, etag);
    await handlePutOutcome(outcome, revAtSend);
  }

  function triggerAttempt(): Promise<void> {
    if (closed || status === "disabled" || authFailed) return Promise.resolve();
    if (inFlightPromise) {
      dirty = true;
      return inFlightPromise;
    }
    clearNextAttemptTimer();
    awaitingBackoff = false;
    const promise = (loaded ? runAttemptOnce() : runLoadRetryOnce()).finally(() => {
      inFlightPromise = undefined;
      if (loaded && dirty && !closed && status !== "disabled") {
        scheduleAttempt(debounceMs);
      }
    });
    inFlightPromise = promise;
    return promise;
  }

  function hasUnsavedChange(): boolean {
    if (graph.rev === savedRev) return false;
    if (skippedUntilRev !== null && graph.rev <= skippedUntilRev) return false;
    return true;
  }

  function onEventsBatch(batch: readonly RuntimeEvent[]): void {
    if (closed || status === "disabled" || authFailed || !loaded) return;
    const qualifies = batch.some((event) => QUALIFYING_EVENT_TYPES.has(event.type));
    if (!qualifies || !hasUnsavedChange()) return;
    dirty = true;
    if (inFlightPromise) return; // the in-flight attempt's completion handler reschedules
    if (awaitingBackoff) return; // a retry is already scheduled; it re-reads rev at fire time
    scheduleAttempt(debounceMs);
  }

  async function flush(): Promise<void> {
    if (status === "disabled" || authFailed) return;
    if (inFlightPromise) {
      await inFlightPromise.catch(() => {});
      return;
    }
    if (!loaded) {
      await triggerAttempt().catch(() => {});
      return;
    }
    if (!hasUnsavedChange() && !dirty) return;
    await triggerAttempt().catch(() => {});
  }

  async function closeSync(): Promise<void> {
    try {
      await flush();
    } catch {
      // Sync lifecycle is fail-open too.
    }
    closed = true;
    clearNextAttemptTimer();
    try {
      subscription.unsubscribe();
    } catch {
      // Detach failures cannot escape into host shutdown.
    }
  }

  function close(): Promise<void> {
    closePromise ??= closeSync();
    return closePromise;
  }

  const subscription = catalog.events.subscribe(onEventsBatch);
  // The initial load is just the first attempt of the same load-retry/save loop:
  // on failure it arms a background retry and resolves anyway, so the caller
  // is never blocked waiting on Cloud (see runLoadRetryOnce for outcomes).
  await triggerAttempt();
  firstAttemptDone = true;

  return {
    get graph() {
      return graph;
    },
    get status() {
      return status;
    },
    flush,
    close,
  };
}

async function loadIntentGraph(): Promise<typeof IntentGraphType> {
  try {
    const sdk = (await import("@ratel-ai/sdk")) as { IntentGraph?: typeof IntentGraphType };
    if (typeof sdk.IntentGraph !== "function") {
      throw new Error("missing IntentGraph export");
    }
    return sdk.IntentGraph;
  } catch (error) {
    throw new Error(
      "@ratel-ai/cloud-sdk/runtime: attachIntentGraphSync requires @ratel-ai/sdk >=0.12.0 " +
        `with IntentGraph (ADR-0014) installed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
