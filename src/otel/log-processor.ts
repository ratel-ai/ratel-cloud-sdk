/** The Ratel Cloud OTLP Logs destination for a host-owned LoggerProvider. */

import type { Context } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import {
  BatchLogRecordProcessor,
  type ForceFlushOptions,
  type LogRecordExporter,
  type LogRecordProcessor,
  type SdkLogRecord,
} from "@opentelemetry/sdk-logs";
import { type RatelOtlpLogsOptions, resolveOtlpLogsConfig } from "./config.js";
import { type LogFilter, ratelEventFilter } from "./filters.js";

type LogRecordProcessorEnabledOptions = Parameters<NonNullable<LogRecordProcessor["enabled"]>>[0];

/** Options for {@link RatelLogRecordProcessor}. */
export interface RatelLogRecordProcessorOptions extends RatelOtlpLogsOptions {
  /** Set `false` for a strict no-op that resolves no endpoint, auth, or exporter. */
  enabled?: boolean;
  /** Override {@link ratelEventFilter}; `() => true` forwards every record. */
  logFilter?: LogFilter;
  /** Replace the default OTLP exporter. Supplying one bypasses config resolution. */
  exporter?: LogRecordExporter;
}

/** A filtered `BatchLogRecordProcessor` over the Ratel Cloud OTLP Logs exporter. */
export class RatelLogRecordProcessor implements LogRecordProcessor {
  private readonly inner: LogRecordProcessor | undefined;
  private readonly logFilter: LogFilter;

  constructor(options: RatelLogRecordProcessorOptions = {}) {
    const { enabled = true, logFilter = ratelEventFilter, exporter, ...otlp } = options;
    this.logFilter = logFilter;
    this.inner = enabled
      ? new BatchLogRecordProcessor({ exporter: exporter ?? logExporter(otlp) })
      : undefined;
  }

  enabled(options: LogRecordProcessorEnabledOptions): boolean {
    if (!this.inner) return false;
    return this.inner.enabled?.(options) ?? true;
  }

  onEmit(logRecord: SdkLogRecord, context?: Context): void {
    if (this.inner && this.logFilter(logRecord)) this.inner.onEmit(logRecord, context);
  }

  forceFlush(options?: ForceFlushOptions): Promise<void> {
    return this.inner?.forceFlush(options) ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.inner?.shutdown() ?? Promise.resolve();
  }
}

/** Build the OTLP `http/protobuf` Logs exporter at the resolved Cloud route. */
export function ratelLogExporter(options: RatelOtlpLogsOptions = {}): OTLPLogExporter {
  return logExporter(options);
}

function logExporter(options: RatelOtlpLogsOptions): OTLPLogExporter {
  const { url, headers } = resolveOtlpLogsConfig(options);
  return new OTLPLogExporter({ url, headers });
}
