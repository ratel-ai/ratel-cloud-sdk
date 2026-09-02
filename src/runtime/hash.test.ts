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

  it("preserves JSON omission and array-null semantics for undefined values", () => {
    expect(
      hashCatalogSnapshot({
        source_id: "worker-exotic",
        tools: [
          {
            id: "undefined",
            name: "undefined",
            inputSchema: {
              properties: { kept: { type: "string" }, omitted: undefined },
              required: ["kept", undefined],
            },
          },
        ],
      }),
    ).toBe("e00a087a6859a9ff16708743dafa9266f534f140c3b9b44f26a231cf19ff41b0");
  });

  it("preserves JSON coercion semantics for exotic schema values", () => {
    expect(
      hashCatalogSnapshot({
        source_id: "worker-exotic",
        tools: [
          {
            id: "exotic",
            name: "exotic",
            inputSchema: {
              createdAt: new Date("2026-08-14T00:00:00.000Z"),
              nan: Number.NaN,
              infinity: Number.POSITIVE_INFINITY,
              pattern: /ratel/,
            },
          },
        ],
      }),
    ).toBe("941bde1721281135461e8566e5c6c83dec23ef3db9ee12bea6cc4f2193d75c92");
  });

  it("moves when only the searchable description changes, and again when it is cleared", () => {
    // The publisher skips any snapshot whose hash matches the last one it sent.
    // A tool whose retrieval text changed on its own would otherwise look
    // unchanged and sit unsent until the five-minute reconcile.
    const withText = (searchable?: string) => ({
      source_id: "worker-a",
      tools: [
        {
          id: "add_task_comment",
          name: "add_task_comment",
          description: "Add a markdown comment to a task.",
          ...(searchable === undefined ? {} : { experimentalSearchableDescription: searchable }),
        },
      ],
    });

    const none = hashCatalogSnapshot(withText());
    const edited = hashCatalogSnapshot(withText("comment note retro ping"));
    const rewritten = hashCatalogSnapshot(withText("comment note retro ping followup"));
    const cleared = hashCatalogSnapshot(withText());

    expect(edited).not.toBe(none);
    expect(rewritten).not.toBe(edited);
    // Clearing it returns to the original hash: an absent field and an unset
    // one are the same catalog, which is what keeps old publishers stable.
    expect(cleared).toBe(none);
    // Blank after trimming is also "unset", matching the snapshot serializer.
    expect(hashCatalogSnapshot(withText("   "))).not.toBe(none);
  });
});
