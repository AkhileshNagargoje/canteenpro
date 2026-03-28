import { db } from "./firebase.js";
import {
  collection,
  doc,
  addDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

const SESSION_KEY = "canteen_admin_unlocked";
const PRICE_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const MENU_CATEGORIES = {
  snacks: "Snacks",
  cook_to_order: "Made on order",
  drinks: "Drinks",
};

const menuList = document.getElementById("menu-list");
const pageError = document.getElementById("menu-page-error");
const addItemToggle = document.getElementById("add-item-toggle");
const quickAddModal = document.getElementById("quick-add-modal");
const quickAddForm = document.getElementById("quick-add-form");
const quickAddCancel = document.getElementById("quick-add-cancel");
const lockBtn = document.getElementById("lock-btn");

if (sessionStorage.getItem(SESSION_KEY) !== "1") {
  location.replace("admin.html");
}

function showPageError(message) {
  if (!pageError) return;
  pageError.hidden = false;
  pageError.textContent = message;
}

function hidePageError() {
  if (!pageError) return;
  pageError.hidden = true;
  pageError.textContent = "";
}

function normalizeMenuCategory(raw) {
  return Object.prototype.hasOwnProperty.call(MENU_CATEGORIES, raw) ? raw : "snacks";
}

function categoryLabel(category) {
  return MENU_CATEGORIES[normalizeMenuCategory(category)];
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parsePriceInput(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  return safePrice(trimmed);
}

function formatPrice(value) {
  return value == null ? "No price" : PRICE_FORMATTER.format(value);
}

function normalizeMenuDoc(id, data) {
  return {
    id,
    name: String(data?.name || "Item"),
    category: normalizeMenuCategory(data?.category),
    imageUrl: typeof data?.imageUrl === "string" ? data.imageUrl.trim() : "",
    price: safePrice(data?.price),
    available: data?.available !== false,
    enabled: data?.enabled !== false,
    sortOrder: safeInt(data?.sortOrder, 0),
  };
}

function openQuickAdd() {
  hidePageError();
  quickAddModal.hidden = false;
}

function closeQuickAdd() {
  quickAddModal.hidden = true;
  quickAddForm.reset();
  document.getElementById("new-menu-category").value = "snacks";
}

async function runMenuTask(task, fallbackMessage) {
  try {
    hidePageError();
    await task();
    return true;
  } catch (err) {
    console.error(err);
    showPageError(err?.message || fallbackMessage);
    return false;
  }
}

function renderMenuRow(item) {
  const wrap = document.createElement("details");
  wrap.className = "menu-editor-card" + (item.enabled === false ? " pill-off" : "");

  const summary = document.createElement("summary");
  summary.className = "menu-editor-summary";
  summary.innerHTML = `
    <div class="menu-editor-summary-copy">
      <strong>${esc(item.name)}</strong>
      <span class="list-subtext">${esc(categoryLabel(item.category))}</span>
    </div>
    <span class="menu-editor-summary-hint">Open</span>
  `;

  const bodyWrap = document.createElement("div");
  bodyWrap.className = "menu-editor-panel";

  const preview = document.createElement("div");
  preview.className = "menu-editor-preview";
  if (item.imageUrl) {
    const img = document.createElement("img");
    img.src = item.imageUrl;
    img.alt = item.name;
    img.addEventListener(
      "error",
      () => {
        preview.textContent = item.name.slice(0, 1).toUpperCase();
      },
      { once: true }
    );
    preview.appendChild(img);
  } else {
    preview.textContent = item.name.slice(0, 1).toUpperCase();
  }

  const body = document.createElement("div");
  body.className = "menu-editor-body";

  const fields = document.createElement("div");
  fields.className = "menu-editor-fields";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.placeholder = "Item name";
  nameInput.addEventListener("change", async () => {
    const name = nameInput.value.trim();
    if (!name) {
      nameInput.value = item.name;
      return;
    }
    const ok = await runMenuTask(
      () => updateMenu(item.id, { name, updatedAt: serverTimestamp() }),
      "Could not update item name."
    );
    if (!ok) nameInput.value = item.name;
  });

  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.min = "0";
  priceInput.step = "1";
  priceInput.value = item.price == null ? "" : String(item.price);
  priceInput.placeholder = "Price";
  priceInput.addEventListener("change", async () => {
    const nextPrice = parsePriceInput(priceInput.value);
    const ok = await runMenuTask(
      () => updateMenu(item.id, { price: nextPrice, updatedAt: serverTimestamp() }),
      "Could not update item price."
    );
    if (!ok) priceInput.value = item.price == null ? "" : String(item.price);
  });

  const categoryInput = document.createElement("select");
  Object.entries(MENU_CATEGORIES).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    categoryInput.appendChild(option);
  });
  categoryInput.value = item.category;
  categoryInput.addEventListener("change", async () => {
    const nextCategory = normalizeMenuCategory(categoryInput.value);
    const ok = await runMenuTask(
      () => updateMenu(item.id, { category: nextCategory, updatedAt: serverTimestamp() }),
      "Could not update item type."
    );
    if (!ok) categoryInput.value = item.category;
  });

  const imageInput = document.createElement("input");
  imageInput.type = "text";
  imageInput.value = item.imageUrl;
  imageInput.placeholder = "Image URL";
  imageInput.addEventListener("change", async () => {
    const imageUrl = imageInput.value.trim();
    const ok = await runMenuTask(
      () => updateMenu(item.id, { imageUrl, updatedAt: serverTimestamp() }),
      "Could not update item image."
    );
    if (!ok) imageInput.value = item.imageUrl;
  });

  fields.appendChild(nameInput);
  fields.appendChild(priceInput);
  fields.appendChild(categoryInput);
  fields.appendChild(imageInput);

  const meta = document.createElement("div");
  meta.className = "list-subtext";
  meta.textContent = `${categoryLabel(item.category)} | ${item.available ? "Available" : "Sold out"} | ${formatPrice(item.price)}`;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const availabilityBtn = document.createElement("button");
  availabilityBtn.type = "button";
  availabilityBtn.className = "btn-secondary btn-small";
  availabilityBtn.textContent = item.available ? "Available" : "Sold out";
  availabilityBtn.addEventListener("click", async () => {
    await runMenuTask(
      () => updateMenu(item.id, { available: !item.available, updatedAt: serverTimestamp() }),
      "Could not update availability."
    );
  });

  const visibilityBtn = document.createElement("button");
  visibilityBtn.type = "button";
  visibilityBtn.className = "btn-secondary btn-small";
  visibilityBtn.textContent = item.enabled ? "Visible" : "Hidden";
  visibilityBtn.addEventListener("click", async () => {
    await runMenuTask(
      () => updateMenu(item.id, { enabled: !item.enabled, updatedAt: serverTimestamp() }),
      "Could not update visibility."
    );
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-danger btn-small";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (!confirm("Remove this menu item?")) return;
    await runMenuTask(() => deleteDoc(doc(db, "menu", item.id)), "Could not remove menu item.");
  });

  actions.appendChild(availabilityBtn);
  actions.appendChild(visibilityBtn);
  actions.appendChild(del);

  body.appendChild(fields);
  body.appendChild(meta);
  body.appendChild(actions);
  bodyWrap.appendChild(preview);
  bodyWrap.appendChild(body);
  wrap.appendChild(summary);
  wrap.appendChild(bodyWrap);
  return wrap;
}

async function updateMenu(id, patch) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "menu", id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Menu item not found.");
    const merged = normalizeMenuDoc(id, { ...snap.data(), ...patch });
    tx.set(
      ref,
      {
        name: merged.name,
        category: merged.category,
        imageUrl: merged.imageUrl,
        price: merged.price,
        available: merged.available,
        enabled: merged.enabled,
        sortOrder: merged.sortOrder,
        updatedAt: patch.updatedAt ?? serverTimestamp(),
      },
      { merge: false }
    );
  });
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\"/g, "&quot;");
}

async function boot() {
  const bad = await import("./config.js").then(
    (m) => !m.firebaseConfig?.projectId || m.firebaseConfig.projectId === "YOUR_PROJECT_ID",
    () => true
  );

  if (bad) {
    showPageError("Set firebase config in js/config.js before using menu management.");
    addItemToggle.disabled = true;
    return;
  }

  onSnapshot(
    query(collection(db, "menu"), orderBy("sortOrder", "asc")),
    (snap) => {
      hidePageError();
      menuList.innerHTML = "";
      const items = snap.docs.map((x) => normalizeMenuDoc(x.id, x.data()));
      if (items.length === 0) {
        menuList.innerHTML = '<p class="muted" style="margin:0">No menu items yet.</p>';
        return;
      }
      for (const item of items) {
        menuList.appendChild(renderMenuRow(item));
      }
    },
    (err) => {
      console.error(err);
      menuList.innerHTML = '<p class="muted" style="margin:0">Could not load menu items.</p>';
      showPageError("Could not load menu items right now. Refresh and try again.");
    }
  );
}

addItemToggle.addEventListener("click", () => {
  openQuickAdd();
});

quickAddCancel.addEventListener("click", () => {
  closeQuickAdd();
});

quickAddModal?.addEventListener("click", (e) => {
  const target = e.target;
  if (target instanceof HTMLElement && target.dataset.closeModal === "true") {
    closeQuickAdd();
  }
});

quickAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("new-menu-name");
  const priceInput = document.getElementById("new-menu-price");
  const categoryInput = document.getElementById("new-menu-category");
  const name = nameInput.value.trim();
  if (!name) return;

  const price = parsePriceInput(priceInput.value);
  if (priceInput.value.trim() && price == null) {
    showPageError("Enter a valid price or leave it blank.");
    return;
  }

  const ok = await runMenuTask(
    () =>
      addDoc(collection(db, "menu"), {
        name,
        category: normalizeMenuCategory(categoryInput.value),
        imageUrl: "",
        price,
        available: true,
        enabled: true,
        sortOrder: Date.now(),
        updatedAt: serverTimestamp(),
      }),
    "Could not add menu item."
  );

  if (ok) {
    closeQuickAdd();
  }
});

lockBtn.addEventListener("click", () => {
  sessionStorage.removeItem(SESSION_KEY);
  location.replace("admin.html");
});

boot();
