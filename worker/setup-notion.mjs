/**
 * One-time script to create the Wishlist database in your Notion workspace.
 *
 * Prerequisites:
 *   1. Create an internal integration at https://www.notion.so/my-integrations
 *      and copy its "Internal Integration Secret" (the token).
 *   2. Create (or pick) a Notion page to hold the database, and share that page
 *      with your integration: open the page -> "..." menu -> Connections ->
 *      add your integration.
 *   3. Copy the page's ID from its URL (the 32-char hex string, with or without
 *      dashes).
 *
 * Run:
 *   NOTION_TOKEN=secret_xxx PARENT_PAGE_ID=xxxxxxxx node setup-notion.mjs
 *
 * It prints the new database id — use that as NOTION_DATABASE_ID for the Worker.
 */

const NOTION_VERSION = "2022-06-28";
const token = process.env.NOTION_TOKEN;
const parentPageId = process.env.PARENT_PAGE_ID;

if (!token || !parentPageId) {
  console.error("Missing env. Usage:\n  NOTION_TOKEN=secret_xxx PARENT_PAGE_ID=xxxx node setup-notion.mjs");
  process.exit(1);
}

const res = await fetch("https://api.notion.com/v1/databases", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "Wishlist" } }],
    properties: {
      Name: { title: {} },
      URL: { url: {} },
      Price: { number: { format: "dollar" } },
      Priority: {
        select: {
          options: [
            { name: "High", color: "red" },
            { name: "Medium", color: "yellow" },
            { name: "Low", color: "blue" },
          ],
        },
      },
      Notes: { rich_text: {} },
      Status: {
        select: {
          options: [
            { name: "Wanted", color: "default" },
            { name: "Purchased", color: "green" },
          ],
        },
      },
    },
  }),
});

const data = await res.json();
if (!res.ok) {
  console.error("Failed to create database:", data.message || data);
  process.exit(1);
}

console.log("\n✅ Created Wishlist database.");
console.log("Database ID:", data.id);
console.log("\nSet it for the Worker:");
console.log("  npx wrangler secret put NOTION_DATABASE_ID   # paste the id above\n");
