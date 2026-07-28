/* Wishlist frontend — talks to the Cloudflare Worker API. */

const cfg = window.WISHLIST_CONFIG || {};
const API = (cfg.API_BASE || "").replace(/\/$/, "");

const els = {
  title: document.getElementById("page-title"),
  list: document.getElementById("list"),
  status: document.getElementById("status"),
  form: document.getElementById("add-form"),
  unlock: document.getElementById("unlock-btn"),
  name: document.getElementById("f-name"),
  url: document.getElementById("f-url"),
  notes: document.getElementById("f-notes"),
};

// The write key is kept only in memory + sessionStorage (never in the repo).
let editKey = sessionStorage.getItem("wishlist_key") || "";

document.title = cfg.TITLE || document.title;
els.title.textContent = cfg.TITLE || els.title.textContent;

init();

function init() {
  if (!API || API.includes("YOUR-SUBDOMAIN")) {
    setStatus("Set your Worker URL in config.js to load the wishlist.", true);
    return;
  }
  // Validate any cached key before trusting it; drop it if it's stale/wrong.
  if (editKey) verifyKey(editKey).then((ok) => (ok ? enableEditing() : clearEditKey()));
  els.unlock.addEventListener("click", onUnlock);
  els.form.addEventListener("submit", onAdd);
  loadItems();
}

async function verifyKey(key) {
  try {
    const res = await fetch(`${API}/auth`, { headers: { "x-wishlist-key": key } });
    return res.ok;
  } catch {
    return false;
  }
}

async function loadItems() {
  setStatus("Loading…");
  try {
    const res = await fetch(`${API}/items`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");
    render(data.items || []);
    setStatus("");
  } catch (err) {
    setStatus("Could not load wishlist: " + err.message, true);
  }
}

function render(items) {
  els.list.innerHTML = "";
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nothing here yet. 🎁";
    els.list.appendChild(li);
    return;
  }
  for (const item of items) els.list.appendChild(renderCard(item));
}

function renderCard(item) {
  const li = document.createElement("li");
  li.className = "card";

  if (item.image) {
    const link = item.url ? document.createElement("a") : document.createElement("div");
    link.className = "thumb-wrap";
    if (item.url) {
      link.href = item.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.image;
    img.alt = item.name || "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => link.remove(); // hide broken/hotlink-blocked images
    link.appendChild(img);
    li.appendChild(link);
  }

  const body = document.createElement("div");
  body.className = "body";

  const titleRow = document.createElement("div");
  titleRow.className = "title-row";

  const name = document.createElement(item.url ? "a" : "span");
  name.className = "name";
  name.textContent = item.name || "(untitled)";
  if (item.url) {
    name.href = item.url;
    name.target = "_blank";
    name.rel = "noopener noreferrer";
  }
  titleRow.appendChild(name);

  if (item.price != null) {
    const price = document.createElement("span");
    price.className = "price";
    price.textContent = formatPrice(item.price);
    titleRow.appendChild(price);
  }
  body.appendChild(titleRow);

  if (item.notes) {
    const notes = document.createElement("p");
    notes.className = "notes";
    notes.textContent = item.notes;
    body.appendChild(notes);
  }

  li.appendChild(body);

  const remove = document.createElement("button");
  remove.className = "remove-btn";
  remove.textContent = "Remove";
  remove.hidden = !editKey;
  remove.addEventListener("click", () => onRemove(item, remove));
  li.appendChild(remove);

  return li;
}

async function onUnlock() {
  const key = prompt("Enter your editing key:", editKey || "");
  if (!key) return;
  setStatus("Checking key…");
  const ok = await verifyKey(key);
  if (!ok) {
    setStatus("Wrong key — try again.", true);
    return;
  }
  editKey = key;
  sessionStorage.setItem("wishlist_key", key);
  setStatus("");
  enableEditing();
  // Re-render so remove buttons appear.
  loadItems();
}

function enableEditing() {
  els.form.hidden = false;
  els.unlock.textContent = "🔓 Editing on (change key)";
  // Keep the button enabled so a wrong key can always be re-entered.
  els.unlock.disabled = false;
  // Bring the add-item form (top of the page) into view and focus it.
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
  els.name.focus();
}

// Called when the Worker rejects a write with 401 — the cached key is wrong.
function clearEditKey() {
  editKey = "";
  sessionStorage.removeItem("wishlist_key");
  els.unlock.textContent = "✏️ Edit";
}

async function onAdd(e) {
  e.preventDefault();
  const item = {
    name: els.name.value.trim(),
    url: els.url.value.trim(),
    notes: els.notes.value.trim(),
  };
  if (!item.name) return;

  setStatus("Adding…");
  try {
    const res = await fetch(`${API}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-wishlist-key": editKey },
      body: JSON.stringify(item),
    });
    const data = await res.json();
    if (res.status === 401) {
      clearEditKey();
      throw new Error("Wrong key — click ✏️ Edit and enter it again");
    }
    if (!res.ok) throw new Error(data.error || "Add failed");
    els.form.reset();
    setStatus("Added ✓");
    loadItems();
  } catch (err) {
    setStatus("Could not add: " + err.message, true);
  }
}

async function onRemove(item, btn) {
  if (!confirm(`Remove "${item.name}"?`)) return;
  btn.disabled = true;
  setStatus("Removing…");
  try {
    const res = await fetch(`${API}/items/${item.id}`, {
      method: "DELETE",
      headers: { "x-wishlist-key": editKey },
    });
    const data = await res.json();
    if (res.status === 401) {
      clearEditKey();
      throw new Error("Wrong key — click ✏️ Edit and enter it again");
    }
    if (!res.ok) throw new Error(data.error || "Remove failed");
    setStatus("Removed ✓");
    loadItems();
  } catch (err) {
    btn.disabled = false;
    setStatus("Could not remove: " + err.message, true);
  }
}

function formatPrice(n) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
    }).format(n);
  } catch {
    return "$" + n;
  }
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}
