import { ROOT_CONTEXT } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { describe, expect, it, vi } from "vitest";
import { RatelLogRecordProcessor } from "./log-processor.js";

describe("RatelLogRecordProcessor — filtering", () => {
  it("exports ratel.* events and drops all other log records", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [new RatelLogRecordProcessor({ exporter })],
    });
    const logger = provider.getLogger("test");

    logger.emit({ eventName: "ratel.search.result", body: "keep" });
    logger.emit({ eventName: "gen_ai.client.inference.operation.details", body: "drop" });
    logger.emit({ body: "unnamed" });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual(["keep"]);
    await provider.shutdown();
  });

  it("honours a per-instance filter override", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [
        new RatelLogRecordProcessor({
          exporter,
          logFilter: (record) => record.eventName === "custom.keep",
        }),
      ],
    });
    const logger = provider.getLogger("test");

    logger.emit({ eventName: "custom.keep", body: "keep" });
    logger.emit({ eventName: "ratel.search.result", body: "drop" });
    await provider.forceFlush();

    expect(exporter.getFinishedLogRecords().map((record) => record.body)).toEqual(["keep"]);
    await provider.shutdown();
  });
});

describe("RatelLogRecordProcessor — lifecycle and coexistence", () => {
  it("is a strict no-op when disabled", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const processor = new RatelLogRecordProcessor({ enabled: false, exporter });
    const provider = new LoggerProvider({ processors: [processor] });

    provider.getLogger("test").emit({ eventName: "ratel.search.result", body: "drop" });
    await expect(provider.forceFlush()).resolves.toBeUndefined();
    expect(exporter.getFinishedLogRecords()).toHaveLength(0);
    expect(
      processor.enabled({ context: ROOT_CONTEXT, instrumentationScope: { name: "test" } }),
    ).toBe(false);
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });

  it("constructs disabled without resolving endpoint or auth", () => {
    expect(() => new RatelLogRecordProcessor({ enabled: false })).not.toThrow();
  });

  it("coexists with another processor on the host-owned provider", async () => {
    const cloud = new InMemoryLogRecordExporter();
    const everything = new InMemoryLogRecordExporter();
    const provider = new LoggerProvider({
      processors: [
        new RatelLogRecordProcessor({ exporter: cloud }),
        new SimpleLogRecordProcessor({ exporter: everything }),
      ],
    });
    const logger = provider.getLogger("test");

    logger.emit({ eventName: "ratel.search.result", body: "ratel" });
    logger.emit({ eventName: "host.audit", body: "host" });
    await provider.forceFlush();

    expect(cloud.getFinishedLogRecords().map((record) => record.body)).toEqual(["ratel"]);
    expect(everything.getFinishedLogRecords().map((record) => record.body)).toEqual([
      "ratel",
      "host",
    ]);
    await provider.shutdown();
  });

  it("reports enabled, delegates lifecycle, and registers no global provider", async () => {
    const setGlobal = vi.spyOn(logs, "setGlobalLoggerProvider");
    const processor = new RatelLogRecordProcessor({
      exporter: new InMemoryLogRecordExporter(),
    });
    expect(
      processor.enabled({ context: ROOT_CONTEXT, instrumentationScope: { name: "test" } }),
    ).toBe(true);
    await expect(processor.forceFlush({ timeoutMillis: 50 })).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
    expect(setGlobal).not.toHaveBeenCalled();
    setGlobal.mockRestore();
  });
});
