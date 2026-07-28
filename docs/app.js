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
  if (editKey) enableEditing();
  els.unlock.addEventListener("click", onUnlock);
  els.form.addEventListener("submit", onAdd);
  loadItems();
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

function onUnlock() {
  const key = prompt("Enter your editing key:");
  if (!key) return;
  editKey = key;
  sessionStorage.setItem("wishlist_key", key);
  enableEditing();
  // Re-render so remove buttons appear.
  loadItems();
}

function enableEditing() {
  els.form.hidden = false;
  els.unlock.textContent = "🔓 Editing on";
  els.unlock.disabled = true;
  // Bring the add-item form (top of the page) into view and focus it.
  els.form.scrollIntoView({ behavior: "smooth", block: "start" });
  els.name.focus();
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
    if (!res.ok) throw new Error(data.error || "Remove failed");
    setStatus("Removed ✓");
    loadItems();
  } catch (err) {
    btn.disabled = false;
    setStatus("Could not remove: " + err.message, true);
  }
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle("error", isError);
}
