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
        if (url.searchParams.get("debug")) return json(await debugFetch(target));
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

  // Try with the scraped fields; if the Image/Price columns are missing or the
  // wrong type, retry with just the core fields so the item still saves.
  let { res, data } = await createPage(env, { ...core, ...extra });
  if (!res.ok && Object.keys(extra).length && isPropertyError(data)) {
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

// Notion 400s if a column is missing ("X is not a property that exists") or is
// the wrong type ("Price is expected to be rich_text.").
function isPropertyError(data) {
  const m = data?.message || "";
  return /is not a property that exists/i.test(m) || /is expected to be/i.test(m);
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
  const empty = { image: "", price: null };
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
    if (!res.ok) return empty;
    html = await res.text();
  } catch {
    return empty;
  }

  return parseProductMeta(html, url);
}

/**
 * Parse product metadata separately from fetching so site-specific markup can
 * be covered by tests. Coupang may expose the selected option only in its
 * embedded page state rather than in standard meta tags.
 */
export function parseProductMeta(html, url) {
  const out = { image: "", price: null };
  const ld = parseJsonLd(html);
  const product = findNodeByType(ld, "Product");
  const coupang = isCoupangUrl(url) ? parseCoupangState(html) : null;

  // Image: Product image (JSON-LD) → Open Graph → site-specific state/markup.
  // Skip Amazon placeholder/logo images that appear on bot-blocked pages.
  const candidates = [
    pickImage(product?.image),
    metaContent(html, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]),
    coupang?.image,
    coupangImage(html),
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
    coupang?.price ||
    coupangPrice(html) ||
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
  return /share-icons|previewdoh|\/images\/G\/|sprite|transparent|grey-pixel|1x1|amazon\.(png|jpg)|\/www\/error\/|logo-coupang/i.test(u);
}

function isCoupangUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "coupang.com" || host.endsWith(".coupang.com");
  } catch {
    return false;
  }
}

/**
 * Coupang embeds the selected product option in exports.sdp or one of its
 * application bootstrap objects. These fields are more reliable than display
 * text and preserve prices such as "79,000" as KRW 79000.
 */
function parseCoupangState(html) {
  const states = extractEmbeddedJson(html, [
    "exports.sdp",
    "window.__INITIAL_STATE__",
    "window.__INITIAL_STATE",
    "window.__NEXT_DATA__",
  ]);

  const nextData = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (nextData) {
    try {
      states.push(JSON.parse(nextData[1].trim()));
    } catch {
      // Ignore malformed bootstrap state and continue with markup fallbacks.
    }
  }

  const priceKeys = ["salePrice", "finalPrice", "sellingPrice", "currentPrice", "discountPrice"];
  const imageKeys = [
    "imageUrl",
    "imageURL",
    "thumbnailUrl",
    "thumbnail",
    "productImage",
    "detailImage",
    "image",
  ];

  return {
    price: findFirstKey(states, priceKeys, isPriceValue),
    image: pickImage(findFirstKey(states, imageKeys, isImageValue)),
  };
}

function extractEmbeddedJson(html, markers) {
  const out = [];
  for (const marker of markers) {
    let from = 0;
    while (from < html.length) {
      const markerAt = html.indexOf(marker, from);
      if (markerAt < 0) break;
      const start = findJsonStart(html, markerAt + marker.length);
      if (start < 0) break;
      const raw = readBalancedJson(html, start);
      if (raw) {
        try {
          out.push(JSON.parse(raw));
        } catch {
          // Ignore JavaScript object literals that are not valid JSON.
        }
      }
      from = start + Math.max(raw.length, 1);
    }
  }
  return out;
}

function findJsonStart(text, from) {
  for (let i = from; i < Math.min(text.length, from + 200); i++) {
    if (text[i] === "{" || text[i] === "[") return i;
    if (text[i] === ";" || text[i] === "<") return -1;
  }
  return -1;
}

function readBalancedJson(text, start) {
  const pairs = { "{": "}", "[": "]" };
  const stack = [];
  let quote = "";
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  return "";
}

function findFirstKey(nodes, keys, accept) {
  for (const key of keys) {
    for (const node of nodes) {
      const value = findAcceptedValue(node, key, accept, 0);
      if (value != null) return value;
    }
  }
  return null;
}

function findAcceptedValue(node, key, accept, depth) {
  if (node == null || depth > 12) return null;
  if (Array.isArray(node)) {
    for (const value of node) {
      const found = findAcceptedValue(value, key, accept, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  if (node[key] != null && accept(node[key])) return node[key];
  for (const value of Object.values(node)) {
    const found = findAcceptedValue(value, key, accept, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function isPriceValue(value) {
  return toPrice(value) != null;
}

function isImageValue(value) {
  const image = pickImage(value);
  return /^https?:\/\/[^"' ]+\.(?:avif|gif|jpe?g|png|webp)(?:[?#]|$)/i.test(image);
}

function coupangImage(html) {
  const m =
    html.match(
      /class=["'][^"']*prod-image__detail[^"']*["'][^>]*(?:src|data-src)=["']([^"']+)["']/i
    ) ||
    html.match(
      /(?:src|data-src)=["']([^"']+)["'][^>]*class=["'][^"']*prod-image__detail[^"']*["']/i
    );
  return m ? decodeHtml(m[1]) : "";
}

function coupangPrice(html) {
  const m =
    html.match(
      /class=["'][^"']*(?:total-price|prod-sale-price|price-value)[^"']*["'][^>]*>[\s\S]{0,300}?([0-9][0-9,]*)\s*원/i
    ) ||
    html.match(
      /(?:salePrice|finalPrice|sellingPrice|currentPrice)["']?\s*:\s*["']?([0-9][0-9,]*)/i
    );
  return m ? m[1] : "";
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
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

// Diagnostic: fetch a URL and report what the Worker actually received.
async function debugFetch(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    redirect: "follow",
  });
  const html = await res.text();
  const types = [...html.matchAll(/"@type"\s*:\s*"([^"]+)"/g)].map((m) => m[1]);
  const priceHits = [
    ...html.matchAll(
      /("currentPrice"\s*:\s*[0-9.]+|"customerPrice"\s*:\s*[0-9.]+|"regularPrice"\s*:\s*[0-9.]+|itemprop=["']price["'][^>]*content=["'][0-9.]+["'])/gi
    ),
  ].map((m) => m[0]);
  return {
    status: res.status,
    bytes: html.length,
    title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "",
    ogImage: metaContent(html, ["og:image:secure_url", "og:image"]),
    jsonLdTypes: [...new Set(types)].slice(0, 20),
    priceHits: priceHits.slice(0, 5),
    looksBlocked: /access denied|are you a robot|captcha|unusual traffic|akamai|reference #/i.test(
      html.slice(0, 4000)
    ),
    head: html.slice(0, 600),
  };
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
