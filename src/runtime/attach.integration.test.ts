import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const e2e = process.env.RATEL_E2E === "1" ? it : it.skip;

describe("runtime attach with local Ratel Cloud", () => {
  e2e(
    "publishes facts and catalog state, surfaces rejects, and deduplicates OTLP overlap",
    async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["examples/runtime-attach-e2e.mjs"],
        {
          cwd: process.cwd(),
          env: process.env,
          timeout: 120_000,
        },
      );
      const summary = JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");

      expect(summary).toMatchObject({
        factsLanded: true,
        snapshotLanded: true,
        oversizedEventDropped: true,
        otlpDeduplicated: true,
      });
    },
    120_000,
  );
});
