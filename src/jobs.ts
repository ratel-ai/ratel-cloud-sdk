import { CloudSdkError } from "./errors.js";
import type { Transport } from "./transport.js";
import type { Job } from "./types.js";

export interface WaitForJobOptions {
  /** Poll interval in ms, default 1000. */
  intervalMs?: number;
  /** Give up after this long in ms, default 120000. */
  timeoutMs?: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll async jobs (`GET /jobs/{id}`, Bearer project key). The drafting flow
 * enqueues a job via `IntentsClient.suggest`; poll it here until it reaches a
 * terminal state. `MockCloud` serves the same wire contract for tests.
 */
export class JobsClient {
  constructor(private readonly transport: Transport) {}

  /** Read a job once. */
  async get<TResult = unknown>(id: string): Promise<Job<TResult>> {
    return this.transport.json<Job<TResult>>("GET", `/jobs/${id}`);
  }

  /**
   * Poll until the job is terminal (`done` or `error`) or the timeout elapses.
   * Returns the terminal job — it does NOT throw on `status: "error"` (inspect
   * `job.error`); it throws only on transport failures or when the timeout is
   * exceeded before the job settles.
   */
  async waitFor<TResult = unknown>(
    id: string,
    opts: WaitForJobOptions = {},
  ): Promise<Job<TResult>> {
    const intervalMs = opts.intervalMs ?? 1000;
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.get<TResult>(id);
      if (job.status === "done" || job.status === "error") return job;
      if (Date.now() >= deadline) {
        throw new CloudSdkError(`Job ${id} did not finish within ${timeoutMs}ms`, {
          status: null,
          code: "unavailable",
        });
      }
      await delay(intervalMs);
    }
  }
}
