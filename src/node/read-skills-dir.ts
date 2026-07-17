import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NewSkillInput } from "../types.js";

/**
 * Read a SKILL.md folder into `NewSkillInput[]` for `skills.import()`.
 * Node-only (import from `@ratel-ai/cloud-sdk/node`).
 *
 * Layout: each direct subdirectory containing a `SKILL.md` is one skill. The
 * skill name is the directory name (must be kebab-case). SKILL.md may open
 * with a minimal frontmatter block (`---` … `---`) of `key: value` lines —
 * `description`, `tags`, `tools` (inline `[a, b]` or comma-separated) — and
 * everything after it is the body. Without frontmatter the whole file is the
 * body and the first non-heading line becomes the description.
 */
export async function readSkillsFromDir(dir: string): Promise<NewSkillInput[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const skills: NewSkillInput[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await readFile(join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue; // no SKILL.md ⇒ not a skill directory
    }
    skills.push(parseSkillMd(entry.name, raw));
  }
  return skills;
}

function parseSkillMd(name: string, raw: string): NewSkillInput {
  const fm = matchFrontmatter(raw);
  if (!fm) {
    const body = raw.trim();
    const description =
      body
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0 && !l.startsWith("#")) ?? name;
    return { name, description, body };
  }
  const fields = new Map<string, string>();
  for (const line of fm.header.split("\n")) {
    const m = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (m) fields.set((m[1] as string).toLowerCase(), (m[2] as string).trim());
  }
  const input: NewSkillInput = {
    name: fields.get("name") ?? name,
    description: fields.get("description") ?? name,
    body: fm.body.trim(),
  };
  const tags = parseList(fields.get("tags"));
  if (tags) input.tags = tags;
  const tools = parseList(fields.get("tools"));
  if (tools) input.tools = tools;
  return input;
}

function matchFrontmatter(raw: string): { header: string; body: string } | null {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { header: m[1] as string, body: m[2] as string } : null;
}

function parseList(value: string | undefined): string[] | null {
  if (value === undefined || value === "") return null;
  const inner = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  const items = inner
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : null;
}
