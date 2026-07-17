import { createHash } from "node:crypto";
import type {
  AnalyzeResult,
  Catalog,
  CloudSkill,
  CloudSuggestion,
  ConversationMessage,
  ExtractedIntent,
  ImportReport,
  NewSkillInput,
  NewSkillPatch,
  SkillStatus,
  SuggestionStatus,
  SuggestionType,
  UpdateSkillInput,
  WireSkill,
} from "../types.js";
import { SKILL_STATUSES, SUGGESTION_STATUSES, SUGGESTION_TYPES } from "../types.js";
import { canonicalSet, ifNoneMatchMatches, resolve } from "../wire.js";

/**
 * An in-process mock of the Ratel Cloud v1 surface, exposed as a
 * fetch-compatible handler for `CloudSdkOptions.fetch`. Node-only (SHA-256 via
 * node:crypto).
 *
 * Routes and error bodies mirror ratel-cloud's v1 handlers. The intent
 * *extraction* here is a deterministic fixture — an intent per unique user
 * message, covered when a published skill's name tokens all appear in it — not
 * a reimplementation of the server pipeline.
 */

export interface MockCloudOptions {
  /** Expected Bearer key. Default "rtl_test_key". */
  apiKey?: string;
  /** Seed published skills (global + per-subject layers). */
  catalog?: Catalog;
  /** Seed suggestions. */
  suggestions?: Partial<CloudSuggestion>[];
  /** Injectable clock, default `() => new Date().toISOString()`. */
  now?: () => string;
}

const PROJECT_ID = "proj_mock";

export class MockCloud {
  readonly apiKey: string;
  readonly skills = new Map<string, CloudSkill>();
  readonly suggestions = new Map<string, CloudSuggestion>();
  /** fetch-compatible handler; pass as `CloudSdkOptions.fetch`. */
  readonly fetch: typeof fetch;

  private readonly now: () => string;
  private seq = 0;
  private readonly analyzeCache = new Map<string, AnalyzeResult>();

  constructor(options: MockCloudOptions = {}) {
    this.apiKey = options.apiKey ?? "rtl_test_key";
    this.now = options.now ?? (() => new Date().toISOString());
    if (options.catalog) this.seedCatalog(options.catalog);
    for (const partial of options.suggestions ?? []) this.seedSuggestion(partial);
    this.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      Promise.resolve(this.handle(input, init))) as typeof fetch;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  private seedCatalog(catalog: Catalog): void {
    for (const sk of catalog.global) this.insertSkill(sk, null, "published");
    for (const [subject, skills] of Object.entries(catalog.subjects ?? {})) {
      for (const sk of skills) this.insertSkill(sk, subject, "published");
    }
  }

  private insertSkill(
    wire: Omit<WireSkill, "id"> & { id?: string },
    endUserId: string | null,
    status: SkillStatus,
  ): CloudSkill {
    const ts = this.now();
    const skill: CloudSkill = {
      id: wire.id ?? this.nextId("sk"),
      name: wire.name,
      description: wire.description,
      tags: wire.tags ?? [],
      tools: wire.tools ?? [],
      metadata: wire.metadata ?? {},
      body: wire.body,
      status,
      version: 1,
      endUserId,
      model: null,
      createdAt: ts,
      updatedAt: ts,
      publishedAt: status === "published" ? ts : null,
    };
    this.skills.set(skill.id, skill);
    return skill;
  }

  seedSuggestion(partial: Partial<CloudSuggestion>): CloudSuggestion {
    const ts = this.now();
    const suggestion: CloudSuggestion = {
      id: this.nextId("sug"),
      projectId: PROJECT_ID,
      type: "new_skill",
      signalKind: "coverage_gap",
      status: "pending",
      rationale: "seeded",
      evidence: {},
      targetSkillId: null,
      targetSkillExpectedVersion: null,
      sourceQueryIntentId: null,
      endUserId: null,
      patch: {},
      retrievabilityPreview: {},
      createdSkillId: null,
      model: null,
      createdAt: ts,
      updatedAt: ts,
      reviewedAt: null,
      appliedAt: null,
      ...partial,
    };
    this.suggestions.set(suggestion.id, suggestion);
    return suggestion;
  }

  /* — routing ————————————————————————————————————————————————————————————— */

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? String(input) : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    if (headers.get("authorization") !== `Bearer ${this.apiKey}`) {
      return Response.json({ error: "Invalid or revoked API key." }, { status: 401 });
    }

    // Accept any base prefix; route on the path after "/api/v1" (or the whole path).
    const path = url.pathname.replace(/^.*?\/api\/v1/, "") || url.pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const seg = path.split("/").filter(Boolean);

    if (method === "GET" && path === "/catalog") return this.getCatalog(url, headers);
    if (path === "/skills" && method === "GET") return this.listSkills(url);
    if (path === "/skills" && method === "POST")
      return this.createSkill(body as unknown as NewSkillInput);
    if (path === "/skills/import" && method === "POST")
      return this.importSkills((body.skills ?? []) as NewSkillInput[]);
    if (seg[0] === "skills" && seg.length === 2 && method === "GET")
      return this.getSkill(seg[1] as string);
    if (seg[0] === "skills" && seg.length === 2 && method === "PATCH")
      return this.updateSkill(seg[1] as string, body as unknown as UpdateSkillInput);
    if (seg[0] === "skills" && seg.length === 3 && method === "POST")
      return this.transitionSkill(seg[1] as string, seg[2] as string, body);
    if (path === "/suggestions" && method === "GET") return this.listSuggestions(url);
    if (path === "/suggestions/generate" && method === "POST")
      return Response.json({ jobId: this.nextId("job"), coalesced: false });
    if (seg[0] === "suggestions" && seg.length === 3 && method === "POST")
      return this.reviewSuggestion(seg[1] as string, seg[2] as string);
    if (path === "/intents/analyze" && method === "POST") return this.analyze(body);

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /* — catalog ————————————————————————————————————————————————————————————— */

  /** The published set as a layered source catalog. */
  private publishedCatalog(): Catalog {
    const global: WireSkill[] = [];
    const subjects: Record<string, WireSkill[]> = {};
    for (const sk of this.skills.values()) {
      if (sk.status !== "published") continue;
      const wire: WireSkill = {
        id: sk.id,
        name: sk.name,
        description: sk.description,
        tags: sk.tags,
        tools: sk.tools,
        metadata: sk.metadata,
        body: sk.body,
      };
      if (sk.endUserId === null) {
        global.push(wire);
      } else {
        const layer = subjects[sk.endUserId] ?? [];
        layer.push(wire);
        subjects[sk.endUserId] = layer;
      }
    }
    return { global, subjects };
  }

  private getCatalog(url: URL, headers: Headers): Response {
    const scope = url.searchParams.get("scope");
    const skills = resolve(this.publishedCatalog(), scope);
    const hex = createHash("sha256").update(canonicalSet(skills), "utf8").digest("hex");
    const etag = `"${hex}"`;
    if (ifNoneMatchMatches(headers.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    return Response.json({ catalogVersion: hex, skills }, { headers: { etag } });
  }

  /* — skills —————————————————————————————————————————————————————————————— */

  private listSkills(url: URL): Response {
    const status = url.searchParams.get("status");
    if (status && !SKILL_STATUSES.includes(status as SkillStatus)) {
      return Response.json({ error: "invalid", reason: "invalid_status" }, { status: 400 });
    }
    const endUserId = url.searchParams.get("endUserId");
    const skills = [...this.skills.values()].filter(
      (sk) => (!status || sk.status === status) && (!endUserId || sk.endUserId === endUserId),
    );
    return Response.json({ count: skills.length, skills });
  }

  private getSkill(id: string): Response {
    const skill = this.skills.get(id);
    if (!skill) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ skill });
  }

  private activeNames(): Set<string> {
    return new Set(
      [...this.skills.values()].filter((sk) => sk.status !== "archived").map((sk) => sk.name),
    );
  }

  private createSkill(input: NewSkillInput): Response {
    if (!input.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name)) {
      return Response.json({ error: "invalid", reason: "invalid_name" }, { status: 400 });
    }
    if (this.activeNames().has(input.name)) {
      return Response.json({ error: "conflict", reason: "name_conflict" }, { status: 409 });
    }
    const skill = this.insertSkill(
      {
        ...input,
        tags: input.tags ?? [],
        tools: input.tools ?? [],
        metadata: input.metadata ?? {},
      },
      input.endUserId ?? null,
      input.status ?? "draft",
    );
    return Response.json({ skill }, { status: 201 });
  }

  private updateSkill(id: string, input: UpdateSkillInput): Response {
    const skill = this.skills.get(id);
    if (!skill) return Response.json({ error: "not_found" }, { status: 404 });
    // The version guard is opt-in: absent ⇒ unconditional edit, like the server.
    if (input.expectedVersion !== undefined && skill.version !== input.expectedVersion) {
      return Response.json({ error: "conflict", reason: "version_conflict" }, { status: 409 });
    }
    if (
      input.name !== undefined &&
      input.name !== skill.name &&
      this.activeNames().has(input.name)
    ) {
      return Response.json({ error: "conflict", reason: "name_conflict" }, { status: 409 });
    }
    const { expectedVersion: _v, ...patch } = input;
    Object.assign(skill, stripUndefined(patch as Record<string, unknown>), {
      version: skill.version + 1,
      updatedAt: this.now(),
    });
    return Response.json({ skill });
  }

  private transitionSkill(id: string, action: string, body: Record<string, unknown>): Response {
    if (action !== "publish" && action !== "archive") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const skill = this.skills.get(id);
    if (!skill) return Response.json({ error: "not_found" }, { status: 404 });
    // The version guard is opt-in: absent ⇒ unconditional transition, like the server.
    if (body.expectedVersion !== undefined && skill.version !== body.expectedVersion) {
      return Response.json({ error: "conflict", reason: "version_conflict" }, { status: 409 });
    }
    skill.status = action === "publish" ? "published" : "archived";
    if (action === "publish") skill.publishedAt = this.now();
    skill.version += 1;
    skill.updatedAt = this.now();
    return Response.json({ skill });
  }

  private importSkills(inputs: NewSkillInput[]): Response {
    const report: ImportReport = { created: [], updated: [], unchanged: [] };
    for (const input of inputs) {
      const existing = [...this.skills.values()].find(
        (sk) => sk.status !== "archived" && sk.name === input.name,
      );
      if (!existing) {
        this.insertSkill(
          {
            ...input,
            tags: input.tags ?? [],
            tools: input.tools ?? [],
            metadata: input.metadata ?? {},
          },
          input.endUserId ?? null,
          input.status ?? "draft",
        );
        report.created.push(input.name);
        continue;
      }
      const same =
        existing.description === input.description &&
        existing.body === input.body &&
        JSON.stringify(existing.tags) === JSON.stringify(input.tags ?? []) &&
        JSON.stringify(existing.tools) === JSON.stringify(input.tools ?? []);
      if (same) {
        report.unchanged.push(input.name);
      } else {
        Object.assign(existing, {
          description: input.description,
          body: input.body,
          tags: input.tags ?? [],
          tools: input.tools ?? [],
          version: existing.version + 1,
          updatedAt: this.now(),
        });
        report.updated.push(input.name);
      }
    }
    return Response.json(report);
  }

  /* — suggestions ————————————————————————————————————————————————————————— */

  private listSuggestions(url: URL): Response {
    const status = url.searchParams.get("status");
    if (status && !SUGGESTION_STATUSES.includes(status as SuggestionStatus)) {
      return Response.json({ error: "invalid", reason: "invalid_status" }, { status: 400 });
    }
    const type = url.searchParams.get("type");
    if (type && !SUGGESTION_TYPES.includes(type as SuggestionType)) {
      return Response.json({ error: "invalid", reason: "invalid_type" }, { status: 400 });
    }
    const endUserId = url.searchParams.get("endUserId");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 50, 1), 100);
    const suggestions = [...this.suggestions.values()]
      .filter(
        (s) =>
          (!status || s.status === status) &&
          (!type || s.type === type) &&
          (!endUserId || s.endUserId === endUserId),
      )
      .slice(0, limit);
    return Response.json({ count: suggestions.length, suggestions });
  }

  private reviewSuggestion(id: string, action: string): Response {
    if (action !== "approve" && action !== "reject") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    const suggestion = this.suggestions.get(id);
    if (!suggestion) return Response.json({ error: "not_found" }, { status: 404 });
    if (suggestion.status !== "pending") {
      return Response.json({ error: "conflict", reason: "not_pending" }, { status: 409 });
    }
    const ts = this.now();
    if (action === "reject") {
      Object.assign(suggestion, { status: "rejected", reviewedAt: ts, updatedAt: ts });
      return Response.json({ suggestion });
    }
    if (suggestion.type === "new_skill") {
      const patch = suggestion.patch as unknown as NewSkillPatch;
      const names = this.activeNames();
      let name = patch.name;
      for (let i = 2; names.has(name); i++) name = `${patch.name}-${i}`;
      const skill = this.insertSkill(
        {
          name,
          description: patch.description,
          tags: patch.tags,
          tools: [],
          metadata: {},
          body: patch.body,
        },
        suggestion.endUserId,
        "draft",
      );
      Object.assign(suggestion, {
        status: "approved",
        createdSkillId: skill.id,
        reviewedAt: ts,
        appliedAt: ts,
        updatedAt: ts,
      });
      return Response.json({ suggestion });
    }
    // edit_skill: apply through the version CAS.
    const target = suggestion.targetSkillId ? this.skills.get(suggestion.targetSkillId) : undefined;
    if (!target) return Response.json({ error: "not_found" }, { status: 404 });
    if (target.version !== suggestion.targetSkillExpectedVersion) {
      return Response.json({ error: "conflict", reason: "version_conflict" }, { status: 409 });
    }
    Object.assign(target, stripUndefined(suggestion.patch), {
      version: target.version + 1,
      updatedAt: ts,
    });
    Object.assign(suggestion, { status: "approved", reviewedAt: ts, appliedAt: ts, updatedAt: ts });
    return Response.json({ suggestion });
  }

  /* — intent analysis ————————————————————————————————————————————————————— */

  private analyze(body: Record<string, unknown>): Response {
    const messages = (body.messages ?? []) as ConversationMessage[];
    const endUserId = typeof body.endUserId === "string" ? body.endUserId : null;
    const cacheKey = JSON.stringify([messages, endUserId]);
    const cachedResult = this.analyzeCache.get(cacheKey);
    if (cachedResult) return Response.json({ ...cachedResult, cached: true });

    const published = resolve(this.publishedCatalog(), endUserId);
    const hex = createHash("sha256").update(canonicalSet(published), "utf8").digest("hex");

    const texts = [
      ...new Set(messages.filter((m) => m.role === "user").map((m) => m.content.trim())),
    ];
    const intents: ExtractedIntent[] = [];
    const suggestionIds: string[] = [];
    for (const text of texts) {
      const lower = text.toLowerCase();
      const match = published.find((sk) =>
        sk.name.split("-").every((token) => lower.includes(token)),
      );
      const intent: ExtractedIntent = {
        id: this.nextId("int"),
        text,
        covered: match !== undefined,
        matchedSkillId: match?.id ?? null,
        score: match ? 1 : null,
      };
      intents.push(intent);
      if (!match) {
        const name = slugify(text);
        const suggestion = this.seedSuggestion({
          type: "new_skill",
          signalKind: "coverage_gap",
          status: "pending",
          rationale: `Coverage gap: "${text}"`,
          endUserId,
          patch: {
            name,
            description: text,
            tags: [],
            body: `# ${name}\n\n${text}\n`,
            model: "mock",
          } satisfies NewSkillPatch as unknown as Record<string, unknown>,
        });
        suggestionIds.push(suggestion.id);
      }
    }

    const result: AnalyzeResult = {
      runId: this.nextId("run"),
      cached: false,
      catalogVersion: hex,
      intents,
      suggestionIds,
    };
    this.analyzeCache.set(cacheKey, result);
    return Response.json(result);
  }
}

function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "new-skill";
}

function stripUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
