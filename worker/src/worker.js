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
      if (pathname === "/auth" && request.method === "GET") {
        requireKey(request, env);
        return json({ ok: true });
      }
      if (pathname === "/preview" && request.method === "GET") {
        requireKey(request, env);
        const target = url.searchParams.get("url");
        if (!target) throw httpError("url query param required", 400);
        return json(await fetchMeta(target));
      }
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

  // Core properties every database is guaranteed to have.
  const core = {
    [PROP.name]: { title: [{ text: { content: name } }] },
  };
  if (body.url) core[PROP.url] = { url: body.url };
  if (body.notes) core[PROP.notes] = { rich_text: [{ text: { content: body.notes } }] };

  // Scrape the URL, but let any manually-provided image/price take precedence.
  let scraped = { image: "", price: null };
  if (body.url) scraped = await fetchMeta(body.url);

  const image = (body.image || "").trim() || scraped.image;
  const manualPrice = toPrice(body.price);
  const price = manualPrice != null ? manualPrice : scraped.price;

  // Optional properties (need Image/Price columns to exist).
  const extra = {};
  if (image) {
    extra[PROP.image] = {
      files: [{ type: "external", name: "preview", external: { url: image } }],
    };
  }
  if (price != null) extra[PROP.price] = { number: price };

  // Try with the scraped fields; if the DB lacks those columns, retry without.
  let { res, data } = await createPage(env, { ...core, ...extra });
  if (!res.ok && Object.keys(extra).length && isMissingPropertyError(data)) {
    ({ res, data } = await createPage(env, core));
  }
  if (!res.ok) throw httpError(data.message || "Notion create failed", res.status);

  return json({ item: pageToItem(data) }, 201);
}

async function createPage(env, properties) {
  const res = await notion(env, "/pages", {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: env.NOTION_DATABASE_ID },
      properties,
    }),
  });
  const data = await res.json();
  return { res, data };
}

// Notion returns a 400 like "X is not a property that exists" if a column is missing.
function isMissingPropertyError(data) {
  return /is not a property that exists/i.test(data?.message || "");
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
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      redirect: "follow",
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return out;
    html = await res.text();
  } catch {
    return out;
  }

  const ld = parseJsonLd(html);
  const product = findNodeByType(ld, "Product");

  // Image: Product image (JSON-LD) → Open Graph → Amazon markup → any JSON-LD image.
  // Skip Amazon placeholder/logo images that appear on bot-blocked pages.
  const candidates = [
    pickImage(product?.image),
    metaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]),
    amazonImage(html),
    pickImage(findInLd(ld, "image")),
  ];
  const image = candidates.find((c) => c && !isJunkImage(c)) || "";
  if (image) {
    try {
      out.image = new URL(image, url).href; // resolve relative URLs
    } catch {
      out.image = image;
    }
  }

  // Price: meta tags, then Product offers (JSON-LD), then itemprop, then Amazon markup.
  const priceRaw =
    metaContent(html, ["product:price:amount", "og:price:amount"]) ||
    (product ? findRaw(product.offers ?? product, "price", 0) : null) ||
    findInLd(ld, "price") ||
    itempropPrice(html) ||
    amazonPrice(html);
  const price = toPrice(priceRaw);
  if (price != null) out.price = price;

  return out;
}

// Reject Amazon site chrome / placeholder images. Real product photos live under
// /images/I/; logos, share icons, and sprites live under /images/G/ etc.
function isJunkImage(u) {
  return /share-icons|previewdoh|\/images\/G\/|sprite|transparent|grey-pixel|1x1|amazon\.(png|jpg)/i.test(u);
}

// Amazon puts the main product image in data-a-dynamic-image (a JSON map of url->[w,h]).
function amazonImage(html) {
  const m =
    html.match(/id=["']landingImage["'][^>]*data-a-dynamic-image=["']([^"']+)["']/i) ||
    html.match(/data-a-dynamic-image=["'](\{&quot;[^"']+)["']/i);
  if (m) {
    try {
      const obj = JSON.parse(m[1].replace(/&quot;/g, '"'));
      const urls = Object.keys(obj);
      if (urls.length) return urls[0];
    } catch {
      // fall through
    }
  }
  const s = html.match(/id=["']landingImage["'][^>]*\bsrc=["']([^"']+)["']/i);
  return s ? s[1] : "";
}

// Amazon renders the price inside <span class="a-offscreen">$21.99</span>.
function amazonPrice(html) {
  const m = html.match(/class=["']a-offscreen["']>\s*([^<]+)</i);
  if (m) return m[1];
  const whole = html.match(/class=["']a-price-whole["']>\s*([0-9,]+)/i);
  const frac = html.match(/class=["']a-price-fraction["']>\s*([0-9]+)/i);
  if (whole) return `${whole[1]}.${frac ? frac[1] : "00"}`;
  return "";
}

// Find the first JSON-LD node whose @type matches (handles arrays and @graph).
function findNodeByType(nodes, type) {
  for (const n of nodes) {
    const r = searchType(n, type, 0);
    if (r) return r;
  }
  return null;
}
function searchType(node, type, depth) {
  if (node == null || depth > 8 || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = searchType(v, type, depth + 1);
      if (r) return r;
    }
    return null;
  }
  const t = node["@type"];
  if (t === type || (Array.isArray(t) && t.includes(type))) return node;
  for (const k of Object.keys(node)) {
    const r = searchType(node[k], type, depth + 1);
    if (r) return r;
  }
  return null;
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

function parseJsonLd(html) {
  const out = [];
  const blocks = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const b of blocks) {
    try {
      out.push(JSON.parse(b[1].trim()));
    } catch {
      // ignore malformed blocks
    }
  }
  return out;
}

// Find the first value for `key` anywhere in the parsed JSON-LD (raw value).
function findInLd(nodes, key) {
  for (const n of nodes) {
    const r = findRaw(n, key, 0);
    if (r != null) return r;
  }
  return null;
}
function findRaw(node, key, depth) {
  if (node == null || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const r = findRaw(v, key, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (typeof node === "object") {
    if (node[key] != null) return node[key];
    for (const k of Object.keys(node)) {
      const r = findRaw(node[k], key, depth + 1);
      if (r != null) return r;
    }
  }
  return null;
}

// Normalize a JSON-LD image value (string | array | {url}) to a URL string.
function pickImage(val) {
  if (!val) return "";
  if (typeof val === "string") return val;
  if (Array.isArray(val)) return pickImage(val[0]);
  if (typeof val === "object") return val.url || val.contentUrl || "";
  return "";
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
