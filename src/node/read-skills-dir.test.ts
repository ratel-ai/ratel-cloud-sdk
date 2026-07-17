import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSkillsFromDir } from "./read-skills-dir.js";

async function scaffold(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skills-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(join(abs, ".."), { recursive: true });
    await writeFile(abs, content, "utf8");
  }
  return root;
}

describe("readSkillsFromDir", () => {
  it("parses frontmatter skills and plain-body skills", async () => {
    const root = await scaffold({
      "deploy-checklist/SKILL.md": [
        "---",
        "description: How to deploy safely.",
        "tags: [ops, deploy]",
        "tools: run-terraform",
        "---",
        "# Deploy",
        "Steps…",
      ].join("\n"),
      "plain-skill/SKILL.md": "# Plain\n\nJust a body, first real line is the description.\n",
      "not-a-skill/README.md": "ignored — no SKILL.md",
      "loose-file.md": "ignored — not a directory",
    });

    const skills = await readSkillsFromDir(root);
    expect(skills.map((s) => s.name)).toEqual(["deploy-checklist", "plain-skill"]);

    const deploy = skills[0];
    expect(deploy?.description).toBe("How to deploy safely.");
    expect(deploy?.tags).toEqual(["ops", "deploy"]);
    expect(deploy?.tools).toEqual(["run-terraform"]);
    expect(deploy?.body).toBe("# Deploy\nSteps…");

    const plain = skills[1];
    expect(plain?.description).toBe("Just a body, first real line is the description.");
    expect(plain?.body).toContain("# Plain");
  });

  it("frontmatter name overrides the directory name", async () => {
    const root = await scaffold({
      "some-dir/SKILL.md": "---\nname: real-name\ndescription: d\n---\nbody",
    });
    const skills = await readSkillsFromDir(root);
    expect(skills[0]?.name).toBe("real-name");
  });
});
