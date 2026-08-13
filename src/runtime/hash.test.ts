import { describe, expect, it } from "vitest";
import { hashCatalogSnapshot } from "./hash.js";

describe("hashCatalogSnapshot", () => {
  it("produces the canonical Cloud hash regardless of definition or object-key order", () => {
    const first = {
      source_id: "worker-a",
      tools: [
        {
          id: "weather.lookup",
          name: "weather.lookup",
          description: "Fetch a forecast.",
          inputSchema: {
            required: ["city"],
            properties: { city: { type: "string" } },
            type: "object",
          },
        },
        {
          id: "calendar.create",
          name: "calendar.create",
          description: "Create an event.",
        },
      ],
    };
    const reordered = {
      tools: [
        {
          description: "Create an event.",
          name: "calendar.create",
          id: "calendar.create",
        },
        {
          description: "Fetch a forecast.",
          name: "weather.lookup",
          id: "weather.lookup",
          inputSchema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      ],
      source_id: "worker-a",
    };

    expect(hashCatalogSnapshot(first)).toBe(
      "dc0d168a666020cfe2386f0867d4f1ebe0097034ca424edd477f77317665593e",
    );
    expect(hashCatalogSnapshot(reordered)).toBe(
      "dc0d168a666020cfe2386f0867d4f1ebe0097034ca424edd477f77317665593e",
    );
  });
});
