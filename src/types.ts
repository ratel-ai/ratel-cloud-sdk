/**
 * Wire types for the Ratel Cloud v1 API.
 *
 * The shapes here mirror the server serializers in ratel-cloud
 * (`lib/catalog/wire.ts`, `lib/catalog/http.ts` `serializeSkill`,
 * `lib/suggestions/http.ts` `serializeSuggestion`) field-for-field. The catalog
 * wire shape and its ETag algorithm are the frozen `protocol/v1` contract —
 * changing them is a protocol event, not a refactor; conformance is pinned by
 * `wire.test.ts` against the vendored vectors.
 */

/* — protocol/v1 catalog wire ————————————————————————————————————————————— */

/** The frozen v1 content projection: exactly these fields, in this order. */
export const SKILL_FIELDS = [
  "id",
  "name",
  "description",
  "tags",
  "tools",
  "metadata",
  "body",
] as const;

/** One skill as it crosses the wire. */
export interface WireSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
}

/** A source-side catalog: a global layer + optional per-subject layers. */
export interface Catalog {
  global: WireSkill[];
  subjects?: Record<string, WireSkill[]>;
}

/** The `GET /catalog` 200 body. */
export interface CatalogResponse {
  catalogVersion: string;
  skills: WireSkill[];
}

/* — managed skills (write surface) ——————————————————————————————————————— */

export const SKILL_STATUSES = ["draft", "published", "archived"] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** A managed skill row as the write surface serializes it. */
export interface CloudSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  tools: string[];
  metadata: Record<string, string[]>;
  body: string;
  status: SkillStatus;
  /** Optimistic-concurrency guard; mutations compare-and-swap on it. */
  version: number;
  /** Scope: null = project-global; set = tailored to one opaque end-user. */
  endUserId: string | null;
  /** The model that drafted this skill, when machine-generated. */
  model: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

/** Input for creating a skill. `name` must be kebab-case. */
export interface NewSkillInput {
  name: string;
  description: string;
  body: string;
  tags?: string[];
  tools?: string[];
  metadata?: Record<string, string[]>;
  status?: Exclude<SkillStatus, "archived">;
  endUserId?: string | null;
}

/** Input for editing a skill; `expectedVersion` drives the version CAS. */
export interface UpdateSkillInput {
  expectedVersion: number;
  name?: string;
  description?: string;
  body?: string;
  tags?: string[];
  tools?: string[];
  metadata?: Record<string, string[]>;
  endUserId?: string | null;
}

/** The `POST /skills/import` change report. */
export interface ImportReport {
  created: string[];
  updated: string[];
  unchanged: string[];
}

/* — suggestions ——————————————————————————————————————————————————————————— */

export const SUGGESTION_TYPES = ["edit_skill", "new_skill"] as const;
export type SuggestionType = (typeof SUGGESTION_TYPES)[number];

export const SUGGESTION_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "auto_applied",
  "superseded",
] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export const SIGNAL_KINDS = ["coverage_gap", "surfaced_not_invoked", "tool_error"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

/** The partial patch an `edit_skill` proposal carries — never `name`. */
export interface EditSkillPatch {
  description?: string;
  tags?: string[];
  body?: string;
}

/** The full drafted skill a `new_skill` proposal carries. */
export interface NewSkillPatch {
  name: string;
  description: string;
  tags: string[];
  body: string;
  model: string;
}

/** One representative query's rank/score in a catalog snapshot. */
export interface RetrievabilityPreviewHit {
  query: string;
  rank: number | null;
  score: number | null;
}

/** The before/after retrievability preview attached to a proposal. */
export interface RetrievabilityPreview {
  queries: string[];
  before: RetrievabilityPreviewHit[];
  after: RetrievabilityPreviewHit[];
}

/** A suggestion as `serializeSuggestion` emits it. */
export interface CloudSuggestion {
  id: string;
  projectId: string;
  type: SuggestionType;
  signalKind: SignalKind;
  status: SuggestionStatus;
  rationale: string;
  evidence: Record<string, unknown>;
  targetSkillId: string | null;
  targetSkillExpectedVersion: number | null;
  sourceQueryIntentId: string | null;
  /** Proposal scope: null = project-global; set = drafted for one opaque end-user. */
  endUserId: string | null;
  patch: Record<string, unknown>;
  retrievabilityPreview: Record<string, unknown>;
  createdSkillId: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export interface ListSuggestionsResult {
  count: number;
  suggestions: CloudSuggestion[];
}

export interface GenerateSuggestionsResult {
  jobId: string;
  /** True when an in-flight generation run absorbed this request. */
  coalesced: boolean;
}

/* — intent analysis ———————————————————————————————————————————————————————— */

export type MessageRole = "user" | "assistant" | "system" | "tool";

/** One conversation turn submitted for analysis. */
export interface ConversationMessage {
  role: MessageRole;
  content: string;
}

export interface AnalyzeInput {
  messages: ConversationMessage[];
  /** Opaque end-user id; scopes coverage to that user's catalog layer and any
   * gap-drafted skills to that user. Same id space as telemetry. */
  endUserId?: string;
  /** Reference a conversation Cloud already ingested instead of (or alongside)
   * inline messages. */
  conversationId?: string;
}

/** One extracted intent with its skill-coverage verdict. */
export interface ExtractedIntent {
  id: string;
  text: string;
  covered: boolean;
  matchedSkillId: string | null;
  score: number | null;
}

export interface AnalyzeResult {
  runId: string;
  /** True when the conversation was unchanged since the last run and the
   * previous result was returned. */
  cached: boolean;
  /** ETag hex of the catalog the coverage verdicts were computed against. */
  catalogVersion: string | null;
  intents: ExtractedIntent[];
  /** Suggestions drafted from this run's coverage gaps. */
  suggestionIds: string[];
}
