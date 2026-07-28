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
// Set RATEL_DEBUG=1 to log every SDK request + response in this server's console.
const debug = Boolean(process.env.RATEL_DEBUG);

let sdk;
if (live) {
  sdk = new RatelCloudSdk({ apiKey, debug, ...(baseUrl ? { baseUrl } : {}) });
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
  //
  // The `subjects` layers exist to show what `endUserId` does: they overlay the
  // global layer by NAME. "refund" under acme-eu shadows the global "refund"
  // for that user only (same name, different id — the analysis matches the
  // scoped one), while "warranty" and "residency" have no global counterpart,
  // so an intent that is a gap for everyone else is covered for that user.
  const mock = new MockCloud({
    catalog: {
      global: [
        skill("refund", "Issue a refund for a disputed or duplicate charge."),
        skill("shipping", "Explain the shipping status of an order."),
        skill("invoice", "Produce a VAT invoice for an order."),
        skill("password", "Walk a user through resetting their password."),
      ],
      subjects: {
        "acme-eu": [
          skill("refund", "EU: reverse the SEPA authorization; funds settle in 3–5 business days."),
          skill("residency", "Confirm EU-only data residency and send the current SOC 2 report."),
        ],
        "acme-us": [
          skill("warranty", "US: transfer an extended warranty to the device's new owner."),
        ],
      },
    },
  });
  sdk = new RatelCloudSdk({ apiKey: "rtl_test_key", debug, fetch: mock.fetch });
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
    const result = await sdk.intents.analyze({
      messages,
      ...(endUserId ? { endUserId } : {}),
      ...(body.noCache === true ? { noCache: true } : {}),
    });
    return sendJson(res, 200, result);
  }

  // Drafting is async: suggest enqueues a job, the browser polls it, then fetches
  // the drafted proposal. Each endpoint maps to exactly one SDK call.
  const suggest = pathname.match(/^\/api\/intents\/([^/]+)\/suggest$/);
  if (method === "POST" && suggest) {
    const [, id] = suggest;
    return sendJson(res, 200, await sdk.intents.suggest(id));
  }

  // A suggest job answers `reason: "exists"` when this intent already has a
  // draft. There's no get-by-intent endpoint, so find it by scanning — proposals
  // carry the intent they were drafted from.
  //
  // Two traps here. `list()` pages (server default 50, max 100), so ask for the
  // max; and the existing draft need not still be `pending` — one already
  // approved or rejected also counts as "exists" — so a pending-only search
  // reports nothing when there is plainly something. Pending first (the
  // reviewable case), then any status so the answer explains itself.
  const pending = pathname.match(/^\/api\/intents\/([^/]+)\/suggestion$/);
  if (method === "GET" && pending) {
    const [, id] = pending;
    const findFor = (list) => list.find((s) => s.sourceQueryIntentId === id);

    const { suggestions: pendingOnes } = await sdk.suggestions.list({
      status: "pending",
      limit: 100,
    });
    let suggestion = findFor(pendingOnes);
    if (!suggestion) {
      const { suggestions: recent } = await sdk.suggestions.list({ limit: 100 });
      suggestion = findFor(recent);
    }
    if (!suggestion) {
      return sendJson(res, 404, {
        error: "not_found",
        message: `the drafting job says a proposal exists for intent ${id}, but none of the 100 most recent suggestions is linked to it`,
      });
    }
    return sendJson(res, 200, { suggestion });
  }

  const job = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && job) {
    const [, id] = job;
    return sendJson(res, 200, await sdk.jobs.get(id));
  }

  // The whole proposal ledger in one call, so the page can tell up front which
  // intents already have a draft instead of offering a button that can't draft.
  if (method === "GET" && pathname === "/api/suggestions") {
    return sendJson(res, 200, await sdk.suggestions.list({ limit: 100 }));
  }

  const suggestionById = pathname.match(/^\/api\/suggestions\/([^/]+)$/);
  if (method === "GET" && suggestionById) {
    const [, id] = suggestionById;
    return sendJson(res, 200, { suggestion: await sdk.suggestions.get(id) });
  }

  // An `edit_skill` proposal carries only a partial patch, so the review modal
  // needs the target skill to show the full text the patch applies to.
  const skillById = pathname.match(/^\/api\/skills\/([^/]+)$/);
  if (method === "GET" && skillById) {
    const [, id] = skillById;
    return sendJson(res, 200, { skill: await sdk.skills.get(id) });
  }

  // A published skill is still editable: `update` applies to any status, and
  // both calls take the version last read so a stale editor loses the CAS
  // (`conflict / version_conflict`) instead of overwriting a newer edit.
  if (method === "PATCH" && skillById) {
    const [, id] = skillById;
    const body = await readJsonBody(req);
    return sendJson(res, 200, { skill: await sdk.skills.update(id, body) });
  }

  const skillAction = pathname.match(/^\/api\/skills\/([^/]+)\/(archive|publish)$/);
  if (method === "POST" && skillAction) {
    const [, id, action] = skillAction;
    const { expectedVersion } = await readJsonBody(req);
    const opts = expectedVersion === undefined ? {} : { expectedVersion };
    const skill =
      action === "archive" ? await sdk.skills.archive(id, opts) : await sdk.skills.publish(id, opts);
    return sendJson(res, 200, { skill });
  }

  // Accept a proposal with the reviewer's edits folded in.
  //
  // There is no endpoint that rewrites a suggestion — the drafted patch is
  // immutable. What makes "edit before accepting" work is that approving is not
  // the same as publishing: an approved `new_skill` lands as a DRAFT skill, and
  // an approved `edit_skill` bumps a skill that may itself still be a draft.
  // So the sequence is approve → read back → PATCH the reviewer's edits under
  // the version CAS → publish. Nothing is live until that last step.
  const accept = pathname.match(/^\/api\/suggestions\/([^/]+)\/accept$/);
  if (method === "POST" && accept) {
    const [, id] = accept;
    const { edits = {}, publish = false } = await readJsonBody(req);
    // Each entry is either a call the page can render as a signature chip
    // ({ call, result }) or a plain remark about one it didn't make ({ note }).
    const steps = [];

    const suggestion = await sdk.suggestions.approve(id);
    steps.push({ call: `sdk.suggestions.approve("${id}")`, result: suggestion.status });

    const skillId = suggestion.createdSkillId ?? suggestion.targetSkillId;
    if (!skillId) return sendJson(res, 200, { suggestion, skill: null, steps });

    let skill = await sdk.skills.get(skillId);
    steps.push({ call: `sdk.skills.get("${skillId}")`, result: `v${skill.version} (${skill.status})` });

    // Only send fields the reviewer actually changed, so an untouched review
    // doesn't burn a version.
    const changed = {};
    for (const field of ["name", "description", "body"]) {
      if (typeof edits[field] === "string" && edits[field] !== skill[field]) {
        changed[field] = edits[field];
      }
    }
    if (Array.isArray(edits.tags) && JSON.stringify(edits.tags) !== JSON.stringify(skill.tags)) {
      changed.tags = edits.tags;
    }

    if (Object.keys(changed).length > 0) {
      skill = await sdk.skills.update(skillId, { expectedVersion: skill.version, ...changed });
      const fields = Object.keys(changed).join(", ");
      steps.push({
        call: `sdk.skills.update("${skillId}", { ${fields} })`,
        result: `v${skill.version}`,
      });
    } else {
      steps.push({ note: "no edits — skipped skills.update" });
    }

    if (publish && skill.status !== "published") {
      skill = await sdk.skills.publish(skillId, { expectedVersion: skill.version });
      steps.push({
        call: `sdk.skills.publish("${skillId}")`,
        result: `${skill.status} v${skill.version}`,
      });
    }

    return sendJson(res, 200, { suggestion, skill, steps });
  }

  const review = pathname.match(/^\/api\/suggestions\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && review) {
    const [, id, action] = review;
    const suggestion =
      action === "approve" ? await sdk.suggestions.approve(id) : await sdk.suggestions.reject(id);
    return sendJson(res, 200, { suggestion });
  }

  return sendJson(res, 404, { error: "not_found", message: `no route for ${method} ${pathname}` });
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
