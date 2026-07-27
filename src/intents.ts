import type { Transport } from "./transport.js";
import type { AnalyzeInput, AnalyzeResult, ListIntentsResult, SuggestResult } from "./types.js";

/** Analysis runs extraction + coverage scoring server-side (no drafting). */
const ANALYZE_TIMEOUT_MS = 120_000;

export interface ListIntentsOptions {
  /** Zero-based page index; the server serves 50 per page. */
  page?: number;
}

/**
 * The intent surface (Bearer project key). `MockCloud` serves the same wire
 * contract for tests.
 *
 * The flow is async: {@link analyze} extracts intents and scores coverage but
 * does NOT draft skills; call {@link suggest} with an intent id to enqueue a
 * drafting job, then poll it with `JobsClient` and fetch the drafted proposal
 * via `SuggestionsClient.get`.
 */
export class IntentsClient {
  constructor(private readonly transport: Transport) {}

  /**
   * Extract the conversation's intents and score each against the (optionally
   * end-user-scoped) published catalog. Re-analyzing an unchanged conversation
   * against an unchanged catalog is a server-side cache hit (`cached: true`), so
   * calling after every turn is cheap.
   */
  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    return this.transport.json<AnalyzeResult>("POST", "/intents/analyze", {
      body: input,
      timeoutMs: ANALYZE_TIMEOUT_MS,
    });
  }

  /** The project's recurring asks (intent ledger), most-frequent first. */
  async list(options: ListIntentsOptions = {}): Promise<ListIntentsResult> {
    return this.transport.json<ListIntentsResult>("GET", "/intents", {
      query: { page: options.page !== undefined ? String(options.page) : undefined },
    });
  }

  /**
   * Enqueue a drafting job for one intent id (from {@link analyze} or
   * {@link list}). Returns immediately with a `jobId` to poll via
   * `JobsClient.get` / `JobsClient.waitFor`; when the job is `done`, its result
   * carries the `suggestionId` to fetch. Throws `not_found` if the intent isn't
   * in the key's project.
   */
  async suggest(intentId: string): Promise<SuggestResult> {
    return this.transport.json<SuggestResult>("POST", `/intents/${intentId}/suggest`);
  }
}
