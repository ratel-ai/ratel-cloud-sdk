import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudSdkError, RatelCloudSdk } from "./index.js";
import type { Job, SuggestJobResult } from "./types.js";

/** SDK whose fetch serves each response once, then repeats the last forever. */
function makeSdk(bodies: Array<Partial<Job>>): RatelCloudSdk {
  let i = 0;
  const fetchFn: typeof fetch = async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return Response.json({
      id: "job_1",
      kind: "suggest_skill",
      status: "queued",
      result: null,
      error: null,
      ...body,
    });
  };
  return new RatelCloudSdk({ apiKey: "rtl_test", fetch: fetchFn });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("JobsClient.get", () => {
  it("reads a job once, typed by the caller", async () => {
    const sdk = makeSdk([{ status: "done", result: { suggestionId: "sug_1" } }]);
    const job = await sdk.jobs.get<SuggestJobResult>("job_1");
    expect(job.status).toBe("done");
    expect(job.result?.suggestionId).toBe("sug_1");
  });
});

describe("JobsClient.waitFor", () => {
  it("polls through queued/running until done", async () => {
    vi.useFakeTimers();
    const sdk = makeSdk([
      { status: "queued" },
      { status: "running" },
      { status: "done", result: { suggestionId: "sug_1" } },
    ]);
    const pending = sdk.jobs.waitFor<SuggestJobResult>("job_1", { intervalMs: 100 });
    await vi.advanceTimersByTimeAsync(250);
    const job = await pending;
    expect(job.status).toBe("done");
    expect(job.result?.suggestionId).toBe("sug_1");
  });

  it('returns a job with status "error" instead of throwing', async () => {
    const sdk = makeSdk([{ status: "error", error: "drafting model unavailable" }]);
    const job = await sdk.jobs.waitFor("job_1");
    expect(job.status).toBe("error");
    expect(job.error).toBe("drafting model unavailable");
  });

  it('throws code "unavailable" / reason "poll_timeout" when the job never settles', async () => {
    vi.useFakeTimers();
    const sdk = makeSdk([{ status: "running" }]);
    const pending = sdk.jobs.waitFor("job_1", { intervalMs: 100, timeoutMs: 300 });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "CloudSdkError",
      status: null,
      code: "unavailable",
      reason: "poll_timeout",
    });
    await vi.advanceTimersByTimeAsync(400);
    await rejection;
  });

  it("propagates transport errors from a poll", async () => {
    const fetchFn: typeof fetch = async () =>
      Response.json({ error: "not_found" }, { status: 404 });
    const sdk = new RatelCloudSdk({ apiKey: "rtl_test", fetch: fetchFn });
    await expect(sdk.jobs.waitFor("job_missing")).rejects.toThrowError(CloudSdkError);
    await expect(sdk.jobs.waitFor("job_missing")).rejects.toMatchObject({ code: "not_found" });
  });
});
