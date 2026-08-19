import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { describe, expect, it } from "vitest";
import { RatelLogRecordProcessor } from "./log-processor.js";

interface ReceivedRequest {
  authorization: string | undefined;
  body: Buffer;
  contentType: string | undefined;
  url: string | undefined;
}

describe("OTLP Logs wire behavior", () => {
  it("POSTs protobuf to /api/v1/logs with Bearer auth", async () => {
    let receive: (request: ReceivedRequest) => void = () => undefined;
    const received = new Promise<ReceivedRequest>((resolve) => {
      receive = resolve;
    });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receive({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks),
          contentType: request.headers["content-type"],
          url: request.url,
        });
        response.statusCode = 202;
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const provider = new LoggerProvider({
      processors: [
        new RatelLogRecordProcessor({
          apiKey: "rtl_wire_test",
          baseUrl: `http://127.0.0.1:${port}/api/v1`,
        }),
      ],
    });

    try {
      provider.getLogger("test").emit({ eventName: "ratel.search.result", body: "sent" });
      await provider.forceFlush();
      const request = await received;

      expect(request.url).toBe("/api/v1/logs");
      expect(request.authorization).toBe("Bearer rtl_wire_test");
      expect(request.contentType).toBe("application/x-protobuf");
      expect(request.body.byteLength).toBeGreaterThan(0);
    } finally {
      await provider.shutdown();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
