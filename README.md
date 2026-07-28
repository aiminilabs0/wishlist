# Wishlist 🎁

A static wishlist page you host for free on **GitHub Pages**, backed by a
**Notion database**. Add and remove items right from the page — everything shows
up (and is editable) in your Notion.

```
  Browser (github.io, static)
        │  fetch()
        ▼
  Cloudflare Worker  ──(secret token)──►  Notion API  ◄── you, in Notion
   (holds the token)                       (the database)
```

**Why the Worker?** GitHub Pages is static — it can't keep secrets. A Notion
token in the page would be public in your repo, letting anyone edit your Notion.
The tiny Cloudflare Worker holds the token server-side and is free.

---

## What you'll set up

1. A Notion integration + a **Wishlist** database.
2. A Cloudflare Worker (the API) — holds your Notion token.
3. GitHub Pages serving the `docs/` folder — the public page.

Takes ~15 minutes. You need free accounts at [notion.so](https://notion.so) and
[cloudflare.com](https://dash.cloudflare.com/sign-up).

---

## 1. Notion setup

1. Go to <https://www.notion.so/my-integrations> → **New integration** →
   name it "Wishlist" → **Submit**. Copy the **Internal Integration Secret**
   (starts with `secret_` or `ntn_`) — this is your `NOTION_TOKEN`.
2. In Notion, create a blank page (e.g. "Wishlist"). Open its **•••** menu →
   **Connections** → **Connect to** → pick your "Wishlist" integration.
3. Copy that page's ID from its URL: the 32-character hex chunk, e.g.
   `https://notion.so/My-Page-`**`1a2b3c4d5e6f...`** → that's `PARENT_PAGE_ID`.
4. Create the database automatically:

   ```bash
   cd worker
   npm install
   NOTION_TOKEN=secret_xxx PARENT_PAGE_ID=1a2b3c... npm run setup-notion
   ```

   It prints a **Database ID** — save it (`NOTION_DATABASE_ID`).

The database has these columns: **Name, URL, Notes, Status**.
You can edit items directly in Notion any time and they'll appear on the page.

> Already have a database? Skip step 4 and just make sure its column names match
> those above (or edit the `PROP` map in `worker/src/worker.js`). Grab its ID
> from the database URL.

---

## 2. Deploy the Cloudflare Worker (the API)

```bash
cd worker
npm install

# Log in to Cloudflare (opens a browser once):
npx wrangler login

# Store your secrets (you'll be prompted to paste each value):
npx wrangler secret put NOTION_TOKEN         # the secret_… token
npx wrangler secret put NOTION_DATABASE_ID   # the database id from step 1
npx wrangler secret put WISHLIST_KEY         # any passphrase — needed to add/remove

# Deploy:
npx wrangler deploy
```

Wrangler prints your Worker URL, e.g.
`https://wishlist-api.yourname.workers.dev`. Copy it.

**`WISHLIST_KEY`** is a passphrase that gates adding/removing. Anyone can *view*
the wishlist; only someone with the key can *edit* it. Choose something only you
know.

---

## 3. Point the page at your Worker

Edit **`docs/config.js`**:

```js
window.WISHLIST_CONFIG = {
  API_BASE: "https://wishlist-api.yourname.workers.dev", // ← your Worker URL
  TITLE: "My Wishlist",
};
```

Commit and push.

---

## 4. Turn on GitHub Pages

In your repo: **Settings → Pages** → **Source: Deploy from a branch** →
Branch: `main`, Folder: **`/docs`** → **Save**.

After a minute your page is live at
`https://<your-username>.github.io/<repo-name>/`.

---

## Using it

- **View**: anyone with the link sees your wishlist (read-only).
- **Add / remove**: click **🔒 Unlock editing**, enter your `WISHLIST_KEY`.
  The add form and per-item **Remove** buttons appear. The key is kept only in
  your browser session, never in the repo.
- **Remove** archives the row in Notion (moves it to Notion's trash), so it's
  recoverable.
- Edits you make in Notion directly (price, notes, mark Purchased) show up on the
  page on next load.

---

## Local preview

```bash
# Serve the static page locally
cd docs && python3 -m http.server 8000
# open http://localhost:8000

# Run the Worker locally (in another terminal)
cd worker && npx wrangler dev
# then set API_BASE in docs/config.js to the local wrangler URL to test writes
```

---

## Files

| Path | What |
|------|------|
| `docs/index.html`, `styles.css`, `app.js` | The static wishlist page (GitHub Pages) |
| `docs/config.js` | Your Worker URL + page title (the one file you edit) |
| `worker/src/worker.js` | Cloudflare Worker — Notion proxy (holds the token) |
| `worker/wrangler.toml` | Worker deploy config |
| `worker/setup-notion.mjs` | One-time script to create the Notion database |

## Security notes

- The Notion token lives **only** in Cloudflare Worker secrets — never in the
  repo or the browser.
- Reads are public (it's a wishlist). Writes require `WISHLIST_KEY`.
- CORS is open (`*`) so the page can call the Worker; writes are still
  protected by the key. To lock reads to your domain too, restrict the origin in
  `corsHeaders()` in `worker/src/worker.js`.
