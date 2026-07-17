import type { Transport } from "./transport.js";
import type {
  CloudSkill,
  ImportReport,
  NewSkillInput,
  SkillStatus,
  UpdateSkillInput,
} from "./types.js";

export interface ListSkillsOptions {
  status?: SkillStatus;
  /** Filter to one opaque end-user's scoped skills. */
  endUserId?: string;
}

export interface ListSkillsResult {
  count: number;
  skills: CloudSkill[];
}

/**
 * The managed-catalog write surface (`/skills`, Bearer project key).
 *
 * NOTE: these routes are the ratel-cloud "S2" milestone; until it ships, the
 * production API serves only the read-side `GET /catalog`. The wire contract
 * here is what the S2 routes implement (and what `MockCloud` serves for tests).
 */
export class SkillsClient {
  constructor(private readonly transport: Transport) {}

  async list(options: ListSkillsOptions = {}): Promise<ListSkillsResult> {
    return this.transport.json<ListSkillsResult>("GET", "/skills", {
      query: { status: options.status, endUserId: options.endUserId },
    });
  }

  async get(id: string): Promise<CloudSkill> {
    const body = await this.transport.json<{ skill: CloudSkill }>("GET", `/skills/${id}`);
    return body.skill;
  }

  async create(input: NewSkillInput): Promise<CloudSkill> {
    const body = await this.transport.json<{ skill: CloudSkill }>("POST", "/skills", {
      body: input,
    });
    return body.skill;
  }

  /** Edit fields; throws `conflict (version_conflict)` when `expectedVersion` is stale. */
  async update(id: string, input: UpdateSkillInput): Promise<CloudSkill> {
    const body = await this.transport.json<{ skill: CloudSkill }>("PATCH", `/skills/${id}`, {
      body: input,
    });
    return body.skill;
  }

  async publish(id: string, opts: { expectedVersion: number }): Promise<CloudSkill> {
    const body = await this.transport.json<{ skill: CloudSkill }>("POST", `/skills/${id}/publish`, {
      body: opts,
    });
    return body.skill;
  }

  async archive(id: string, opts: { expectedVersion: number }): Promise<CloudSkill> {
    const body = await this.transport.json<{ skill: CloudSkill }>("POST", `/skills/${id}/archive`, {
      body: opts,
    });
    return body.skill;
  }

  /**
   * Bulk upsert-by-name for onboarding an existing skill set. The server
   * reports what changed; nothing is archived (cloud stays source of truth —
   * removal is an explicit `archive`). Pair with `readSkillsFromDir` from
   * `@ratel-ai/cloud-sdk/node` to import a SKILL.md folder.
   */
  async import(skills: NewSkillInput[]): Promise<ImportReport> {
    return this.transport.json<ImportReport>("POST", "/skills/import", {
      body: { skills },
    });
  }
}
