import type { Transport } from "./transport.js";
import type {
  CloudSuggestion,
  GenerateSuggestionsResult,
  ListSuggestionsResult,
  SuggestionStatus,
  SuggestionType,
} from "./types.js";

export interface ListSuggestionsOptions {
  status?: SuggestionStatus;
  type?: SuggestionType;
  /** Page size, 1–100. Server default 50. */
  limit?: number;
  /** Filter to proposals scoped to one opaque end-user. */
  endUserId?: string;
}

/** Suggestions generation can run signal detection + model drafting synchronously. */
const GENERATE_TIMEOUT_MS = 300_000;

/**
 * Review surface for machine-drafted catalog proposals
 * (`/suggestions*`, Bearer project key).
 */
export class SuggestionsClient {
  constructor(private readonly transport: Transport) {}

  /** Fetch one proposal by id (e.g. the `suggestionId` a suggest job produced). */
  async get(id: string): Promise<CloudSuggestion> {
    const body = await this.transport.json<{ suggestion: CloudSuggestion }>(
      "GET",
      `/suggestions/${id}`,
    );
    return body.suggestion;
  }

  async list(options: ListSuggestionsOptions = {}): Promise<ListSuggestionsResult> {
    return this.transport.json<ListSuggestionsResult>("GET", "/suggestions", {
      query: {
        status: options.status,
        type: options.type,
        limit: options.limit !== undefined ? String(options.limit) : undefined,
        endUserId: options.endUserId,
      },
    });
  }

  /**
   * Trigger a generation run. Drains synchronously server-side — a resolved
   * promise means `list()` will already see the results. `coalesced: true`
   * means an in-flight run absorbed this request.
   */
  async generate(): Promise<GenerateSuggestionsResult> {
    return this.transport.json<GenerateSuggestionsResult>("POST", "/suggestions/generate", {
      timeoutMs: GENERATE_TIMEOUT_MS,
    });
  }

  /**
   * Approve a pending proposal: an `edit_skill` applies through the version
   * CAS; a `new_skill` lands as a draft skill (inheriting any `endUserId`).
   * Throws `conflict` with reason `not_pending` | `version_conflict` |
   * `name_conflict` on state races.
   */
  async approve(id: string): Promise<CloudSuggestion> {
    const body = await this.transport.json<{ suggestion: CloudSuggestion }>(
      "POST",
      `/suggestions/${id}/approve`,
    );
    return body.suggestion;
  }

  async reject(id: string): Promise<CloudSuggestion> {
    const body = await this.transport.json<{ suggestion: CloudSuggestion }>(
      "POST",
      `/suggestions/${id}/reject`,
    );
    return body.suggestion;
  }
}
