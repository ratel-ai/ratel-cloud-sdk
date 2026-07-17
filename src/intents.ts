import type { Transport } from "./transport.js";
import type { AnalyzeInput, AnalyzeResult } from "./types.js";

/** Analysis may run extraction + matching + drafting synchronously. */
const ANALYZE_TIMEOUT_MS = 300_000;

/**
 * Conversation → intents → coverage → suggestions (`POST /intents/analyze`,
 * Bearer project key).
 *
 * NOTE: this route is the ratel-cloud "S3" milestone; the wire contract here is
 * what it implements (and what `MockCloud` serves for tests). Re-analyzing an
 * unchanged conversation is a server-side cache hit (`cached: true`), so
 * calling after every turn is cheap.
 */
export class IntentsClient {
  constructor(private readonly transport: Transport) {}

  async analyze(input: AnalyzeInput): Promise<AnalyzeResult> {
    return this.transport.json<AnalyzeResult>("POST", "/intents/analyze", {
      body: input,
      timeoutMs: ANALYZE_TIMEOUT_MS,
    });
  }
}
