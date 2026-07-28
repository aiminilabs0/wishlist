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
  image: "Image",
  price: "Price",
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

  // Best-effort: pull an image + price out of the product page's metadata.
  if (body.url) {
    const meta = await fetchMeta(body.url);
    if (meta.image) {
      properties[PROP.image] = {
        files: [{ type: "external", name: "preview", external: { url: meta.image } }],
      };
    }
    if (meta.price != null) properties[PROP.price] = { number: meta.price };
  }

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
    image: readFileUrl(p[PROP.image]),
    price: p[PROP.price]?.number ?? null,
    createdTime: page.created_time,
  };
}

function readTitle(prop) {
  return (prop?.title || []).map((t) => t.plain_text).join("");
}
function readRichText(prop) {
  return (prop?.rich_text || []).map((t) => t.plain_text).join("");
}
function readFileUrl(prop) {
  const f = (prop?.files || [])[0];
  return f?.external?.url || f?.file?.url || "";
}

/**
 * Best-effort scrape of a product page for an image + price.
 * Reads Open Graph / Twitter meta tags, itemprop, and JSON-LD.
 * Returns { image: string, price: number|null } — empty/null if not found.
 */
async function fetchMeta(url) {
  const out = { image: "", price: null };
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; WishlistBot/1.0; +https://workers.dev)",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return out;
    html = await res.text();
  } catch {
    return out;
  }

  // Image: prefer Open Graph, then Twitter.
  const image = metaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]);
  if (image) {
    try {
      out.image = new URL(image, url).href; // resolve relative URLs
    } catch {
      out.image = image;
    }
  }

  // Price: meta tags, then itemprop, then JSON-LD.
  const priceRaw =
    metaContent(html, ["product:price:amount", "og:price:amount"]) ||
    itempropPrice(html) ||
    jsonLdPrice(html);
  const price = toPrice(priceRaw);
  if (price != null) out.price = price;

  return out;
}

function metaContent(html, names) {
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Either attribute order: property/name before content, or after.
    const re1 = new RegExp(
      `<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']+)["']`,
      "i"
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${esc}["']`,
      "i"
    );
    const m = html.match(re1) || html.match(re2);
    if (m && m[1]) return m[1].trim();
  }
  return "";
}

function itempropPrice(html) {
  const m =
    html.match(/itemprop=["']price["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/content=["']([^"']+)["'][^>]*itemprop=["']price["']/i);
  return m ? m[1] : "";
}

function jsonLdPrice(html) {
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const b of blocks) {
    let data;
    try {
      data = JSON.parse(b[1].trim());
    } catch {
      continue;
    }
    const found = findKey(data, "price");
    if (found != null) return found;
  }
  return "";
}

// Recursively find the first value for `key` in a nested object/array.
function findKey(node, key, depth = 0) {
  if (node == null || depth > 6) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findKey(v, key, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    if (node[key] != null && typeof node[key] !== "object") return node[key];
    for (const k of Object.keys(node)) {
      const r = findKey(node[k], key, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

function toPrice(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(String(raw).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
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
