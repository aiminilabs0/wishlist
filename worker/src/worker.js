/**
 * Wishlist API — Cloudflare Worker
 *
 * A tiny proxy between the static GitHub Pages site and the Notion API.
 * It holds the Notion integration token as a secret so the token is NEVER
 * shipped to the browser.
 *
 * Routes:
 *   GET    /items          -> list wishlist items (public)
 *   POST   /items          -> create an item        (requires x-wishlist-key)
 *   DELETE /items/:pageId   -> archive an item       (requires x-wishlist-key)
 *
 * Secrets / vars (set with `npx wrangler secret put NAME`):
 *   NOTION_TOKEN        - Notion integration token (secret)
 *   NOTION_DATABASE_ID  - the wishlist database id  (secret or var)
 *   WISHLIST_KEY        - passphrase required for writes (secret)
 *
 * The Notion property names below MUST match your database schema.
 * They match what setup-notion.mjs creates.
 */

const NOTION_VERSION = "2022-06-28";
const NOTION_BASE = "https://api.notion.com/v1";

// Property names in the Notion database. Keep in sync with setup-notion.mjs.
const PROP = {
  name: "Name",
  url: "URL",
  notes: "Notes",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (pathname === "/items" && request.method === "GET") {
        return await listItems(env);
      }
      if (pathname === "/items" && request.method === "POST") {
        requireKey(request, env);
        return await createItem(request, env);
      }
      const del = pathname.match(/^\/items\/([^/]+)$/);
      if (del && request.method === "DELETE") {
        requireKey(request, env);
        return await archiveItem(del[1], env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      const status = err.status || 500;
      return json({ error: err.message || "Server error" }, status);
    }
  },
};

/* ------------------------------ handlers ------------------------------ */

async function listItems(env) {
  const res = await notion(env, `/databases/${env.NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: JSON.stringify({
      page_size: 100,
      sorts: [{ timestamp: "created_time", direction: "descending" }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw httpError(data.message || "Notion query failed", res.status);

  const items = (data.results || []).map(pageToItem);
  return json({ items });
}

async function createItem(request, env) {
  const body = await request.json().catch(() => ({}));
  const name = (body.name || "").trim();
  if (!name) throw httpError("Name is required", 400);

  const properties = {
    [PROP.name]: { title: [{ text: { content: name } }] },
  };
  if (body.url) properties[PROP.url] = { url: body.url };
  if (body.notes) properties[PROP.notes] = { rich_text: [{ text: { content: body.notes } }] };

  const res = await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw httpError(data.message || "Notion create failed", res.status);

  return json({ item: pageToItem(data) }, 201);
}

async function archiveItem(pageId, env) {
  const res = await notion(env, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ archived: true }),
  });
  const data = await res.json();
  if (!res.ok) throw httpError(data.message || "Notion archive failed", res.status);
  return json({ ok: true });
}

/* ------------------------------ helpers ------------------------------ */

function pageToItem(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: readTitle(p[PROP.name]),
    url: p[PROP.url]?.url || "",
    notes: readRichText(p[PROP.notes]),
    createdTime: page.created_time,
  };
}

function readTitle(prop) {
  return (prop?.title || []).map((t) => t.plain_text).join("");
}
function readRichText(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}

function notion(env, path, init = {}) {
  return fetch(NOTION_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function requireKey(request, env) {
  const key = request.headers.get("x-wishlist-key");
  if (!env.WISHLIST_KEY || key !== env.WISHLIST_KEY) {
    throw httpError("Unauthorized", 401);
  }
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,x-wishlist-key",
    "Access-Control-Max-Age": "86400",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

function httpError(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}
