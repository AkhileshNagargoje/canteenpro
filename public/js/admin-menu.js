import { db, storage } from "./firebase.js";
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
import {
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-storage.js";

const SESSION_KEY = "canteen_admin_unlocked";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
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

let activeEditorItemId = null;

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

function sanitizeFileName(name) {
  return String(name || "image")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "image";
}

async function uploadMenuImage(menuItemId, file) {
  if (!file) {
    throw new Error("Choose an image first.");
  }
  if (!String(file.type || "").startsWith("image/")) {
    throw new Error("Only image files are allowed.");
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error("Image is too large. Use a file under 5 MB.");
  }

  const objectRef = storageRef(storage, `menu-images/${menuItemId}/${Date.now()}-${sanitizeFileName(file.name)}`);
  await uploadBytes(objectRef, file, {
    contentType: file.type || "image/jpeg",
    cacheControl: "public,max-age=3600",
  });
  return await getDownloadURL(objectRef);
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

async function runMenuValueTask(task, fallbackMessage) {
  try {
    hidePageError();
    return await task();
  } catch (err) {
    console.error(err);
    showPageError(err?.message || fallbackMessage);
    return null;
  }
}

function renderMenuRow(item) {
  const wrap = document.createElement("details");
  wrap.className = "menu-editor-card" + (item.enabled === false ? " pill-off" : "");
  wrap.dataset.itemId = item.id;
  wrap.open = activeEditorItemId === item.id;

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

  const renderPreview = (imageUrl, displayName) => {
    preview.innerHTML = "";
    if (imageUrl) {
      const img = document.createElement("img");
      img.src = imageUrl;
      img.alt = displayName;
      img.addEventListener(
        "error",
        () => {
          preview.textContent = String(displayName || "?").slice(0, 1).toUpperCase();
        },
        { once: true }
      );
      preview.appendChild(img);
      return;
    }
    preview.textContent = String(displayName || "?").slice(0, 1).toUpperCase();
  };

  renderPreview(item.imageUrl, item.name);

  const body = document.createElement("div");
  body.className = "menu-editor-body";

  const fields = document.createElement("div");
  fields.className = "menu-editor-fields";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.value = item.name;
  nameInput.placeholder = "Item name";

  const priceInput = document.createElement("input");
  priceInput.type = "number";
  priceInput.min = "0";
  priceInput.step = "1";
  priceInput.value = item.price == null ? "" : String(item.price);
  priceInput.placeholder = "Price";

  const categoryInput = document.createElement("select");
  Object.entries(MENU_CATEGORIES).forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    categoryInput.appendChild(option);
  });
  categoryInput.value = item.category;

  let pendingImageUrl = item.imageUrl;

  fields.appendChild(nameInput);
  fields.appendChild(priceInput);
  fields.appendChild(categoryInput);

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = "image/*";
  fileInput.hidden = true;

  let uploadBusy = false;
  const uploadTools = document.createElement("div");
  uploadTools.className = "menu-upload-tools";

  const uploadBtn = document.createElement("button");
  uploadBtn.type = "button";
  uploadBtn.className = "btn-secondary btn-small";
  uploadBtn.textContent = "Upload image";

  const uploadStatus = document.createElement("div");
  uploadStatus.className = "list-subtext menu-upload-status";
  uploadStatus.textContent = item.imageUrl ? "Image attached." : "No image uploaded yet.";

  const setUploadBusy = (busy) => {
    uploadBusy = busy;
    uploadBtn.disabled = busy;
    uploadBtn.textContent = busy ? "Uploading..." : "Upload image";
    fileInput.disabled = busy;
  };

  uploadBtn.addEventListener("click", () => {
    if (!uploadBusy) fileInput.click();
  });

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    setUploadBusy(true);
    uploadStatus.textContent = `Uploading ${file.name}...`;

    const url = await runMenuValueTask(() => uploadMenuImage(item.id, file), "Could not upload image.");
    if (url) {
      pendingImageUrl = url;
      renderPreview(url, nameInput.value.trim() || item.name);
      uploadStatus.textContent = `${file.name} uploaded. Click Apply to save.`;
    } else {
      uploadStatus.textContent = item.imageUrl ? "Image attached." : "No image uploaded yet.";
    }

    fileInput.value = "";
    setUploadBusy(false);
  });

  uploadTools.appendChild(uploadBtn);
  uploadTools.appendChild(uploadStatus);
  uploadTools.appendChild(fileInput);

  const meta = document.createElement("div");
  meta.className = "list-subtext";
  meta.textContent = `${categoryLabel(item.category)} | ${item.available ? "Available" : "Sold out"} | ${formatPrice(item.price)}`;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const applyBtn = document.createElement("button");
  applyBtn.type = "button";
  applyBtn.className = "btn-primary btn-small";
  applyBtn.textContent = "Apply";
  applyBtn.addEventListener("click", async () => {
    if (uploadBusy) {
      showPageError("Wait for the image upload to finish first.");
      return;
    }

    const name = nameInput.value.trim();
    if (!name) {
      showPageError("Item name cannot be empty.");
      nameInput.focus();
      return;
    }

    const price = parsePriceInput(priceInput.value);
    if (priceInput.value.trim() && price == null) {
      showPageError("Enter a valid price or leave it blank.");
      priceInput.focus();
      return;
    }

    const ok = await runMenuTask(
      () =>
        updateMenu(item.id, {
          name,
          price,
          category: normalizeMenuCategory(categoryInput.value),
          imageUrl: pendingImageUrl,
          updatedAt: serverTimestamp(),
        }),
      "Could not apply changes."
    );

    if (ok) {
      activeEditorItemId = null;
      wrap.open = false;
    }
  });

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

  actions.appendChild(applyBtn);
  actions.appendChild(availabilityBtn);
  actions.appendChild(visibilityBtn);
  actions.appendChild(del);

  body.appendChild(fields);
  body.appendChild(uploadTools);
  body.appendChild(meta);
  body.appendChild(actions);
  bodyWrap.appendChild(preview);
  bodyWrap.appendChild(body);
  wrap.appendChild(summary);
  wrap.appendChild(bodyWrap);
  wrap.addEventListener("toggle", () => {
    if (wrap.open) {
      activeEditorItemId = item.id;
    } else if (activeEditorItemId === item.id) {
      activeEditorItemId = null;
    }
  });
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
      if (activeEditorItemId && !items.some((menuItem) => menuItem.id === activeEditorItemId)) {
        activeEditorItemId = null;
      }
      if (items.length === 0) {
        menuList.innerHTML = '<p class="muted" style="margin:0">No menu items yet.</p>';
        return;
      }
      for (const menuItem of items) {
        menuList.appendChild(renderMenuRow(menuItem));
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
