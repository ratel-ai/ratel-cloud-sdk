// A tiny, dependency-free backend for the analysis + suggestion-review UI.
//
// Why a backend at all: the project key (`rtl_…`) is a SECRET and must never be
// shipped to a browser. This server holds the key, talks to Ratel Cloud through
// the SDK, and exposes a narrow same-origin JSON API the page can call. The
// browser never sees the key.
//
// Hybrid target, same rule as examples/e2e.mjs:
//   • RATEL_API_KEY set  → the real cloud (RATEL_BASE_URL or cloud.ratel.sh).
//   • RATEL_API_KEY unset → an in-process MockCloud seeded with one published
//     skill ("refund"), so analysis, gap detection, and suggestion approval all
//     work offline with no credentials.
//
//   pnpm run build            # the server imports the built package
//   pnpm run example:ui       # then open http://localhost:8787
//   RATEL_API_KEY=rtl_… pnpm run example:ui
//   PORT=9000 RATEL_API_KEY=rtl_… RATEL_BASE_URL=https://host/api/v1 pnpm run example:ui

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CloudSdkError, RatelCloudSdk } from "../../dist/index.js";
import { MockCloud } from "../../dist/testing/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const apiKey = process.env.RATEL_API_KEY;
const baseUrl = process.env.RATEL_BASE_URL;
const live = Boolean(apiKey);
const effectiveBaseUrl = baseUrl ?? "https://cloud.ratel.sh/api/v1";

let sdk;
if (live) {
  sdk = new RatelCloudSdk({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
} else {
  // Seed a handful of published skills so the presets produce a realistic mix
  // of covered intents (a user message containing the skill's name token) and
  // gaps (everything else) the UI can draft + approve a suggestion for. Mock
  // coverage is a literal token match — single-word names keep it predictable.
  const skill = (name, description) => ({
    name,
    description,
    tags: [],
    tools: [],
    metadata: {},
    body: `## When to use\n${description}\n`,
  });
  const mock = new MockCloud({
    catalog: {
      global: [
        skill("refund", "Issue a refund for a disputed or duplicate charge."),
        skill("shipping", "Explain the shipping status of an order."),
        skill("invoice", "Produce a VAT invoice for an order."),
        skill("password", "Walk a user through resetting their password."),
      ],
    },
  });
  sdk = new RatelCloudSdk({ apiKey: "rtl_test_key", fetch: mock.fetch });
}

/* — helpers ——————————————————————————————————————————————————————————————— */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Turn any thrown SDK error into the same machine-readable shape the browser
// gets from the cloud, so the UI has one error contract to render.
function sendError(res, err) {
  if (err instanceof CloudSdkError) {
    return sendJson(res, err.status ?? 500, {
      error: err.code,
      reason: err.reason,
      message: err.message,
    });
  }
  return sendJson(res, 500, { error: "server_error", message: String(err?.message ?? err) });
}

/* — API ——————————————————————————————————————————————————————————————————— */

async function handleApi(req, res, pathname) {
  const method = req.method ?? "GET";

  if (method === "GET" && pathname === "/api/mode") {
    return sendJson(res, 200, { live, baseUrl: effectiveBaseUrl });
  }

  if (method === "POST" && pathname === "/api/analyze") {
    const body = await readJsonBody(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const endUserId =
      typeof body.endUserId === "string" && body.endUserId.length > 0 ? body.endUserId : undefined;
    const result = await sdk.intents.analyze({ messages, ...(endUserId ? { endUserId } : {}) });
    return sendJson(res, 200, result);
  }

  // Drafting is async: suggest enqueues a job, the browser polls it, then fetches
  // the drafted proposal. Each endpoint maps to exactly one SDK call.
  const suggest = pathname.match(/^\/api\/intents\/([^/]+)\/suggest$/);
  if (method === "POST" && suggest) {
    const [, id] = suggest;
    return sendJson(res, 200, await sdk.intents.suggest(id));
  }

  const job = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && job) {
    const [, id] = job;
    return sendJson(res, 200, await sdk.jobs.get(id));
  }

  const suggestionById = pathname.match(/^\/api\/suggestions\/([^/]+)$/);
  if (method === "GET" && suggestionById) {
    const [, id] = suggestionById;
    return sendJson(res, 200, { suggestion: await sdk.suggestions.get(id) });
  }

  const review = pathname.match(/^\/api\/suggestions\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && review) {
    const [, id, action] = review;
    const suggestion =
      action === "approve" ? await sdk.suggestions.approve(id) : await sdk.suggestions.reject(id);
    return sendJson(res, 200, { suggestion });
  }

  return sendJson(res, 404, { error: "not_found" });
}

/* — server ———————————————————————————————————————————————————————————————— */

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    if (pathname.startsWith("/api/")) return await handleApi(req, res, pathname);

    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      const html = await readFile(join(here, "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    sendError(res, err);
  }
});

server.listen(PORT, () => {
  console.log(
    live
      ? `▶ LIVE  proxying ${effectiveBaseUrl}`
      : "▶ MOCK  in-process MockCloud (set RATEL_API_KEY to go live)",
  );
  console.log(`  open  http://localhost:${PORT}`);
});
