import { db } from "./firebase.js";
import {
  collection,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
  runTransaction,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.11.0/firebase-firestore.js";

const SESSION_KEY = "canteen_student_username";
const LAST_ORDER_KEY = "canteen_last_order_v1";
const DEFAULT_SLOT_CAPACITY = 25;
const PRICE_FORMATTER = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 0,
});
const MENU_SECTIONS = {
  snacks: {
    label: "Snacks",
    note: "Snacks are prepared in bulk and ready for quick pickup.",
    detail: "Prepared in advance for quick service.",
  },
  cook_to_order: {
    label: "Made on order",
    note: "These dishes are cooked after you order and should be paid for first.",
    detail: "Cooked after ordering. Please pay first so the kitchen can start.",
  },
  drinks: {
    label: "Drinks",
    note: "Cold and ready-to-serve drinks.",
    detail: "Ready-to-serve beverages for fast pickup.",
  },
};

const menuGrid = document.getElementById("menu-grid");
const menuEmptyEl = document.getElementById("menu-empty");
const menuSectionTabs = document.getElementById("menu-section-tabs");
const slotBlockerEl = document.getElementById("slot-blocker");
const selectionStage = document.getElementById("selection-stage");
const slotSel = document.getElementById("slot");
const slotHelpEl = document.getElementById("slot-help");
const orderItemsEl = document.getElementById("order-items");
const orderItemsEmptyEl = document.getElementById("order-items-empty");
const orderTotalEl = document.getElementById("order-total");
const basketPanel = document.getElementById("basket-panel");
const basketCloseBtn = document.getElementById("basket-close");
const mobileCartFab = document.getElementById("mobile-cart-fab");
const mobileCartCount = document.getElementById("mobile-cart-count");
const mobileCartOverlay = document.getElementById("mobile-cart-overlay");
const orderUsernameEl = document.getElementById("order-username");
const form = document.getElementById("order-form");
const orderApp = document.getElementById("order-app");
const orderHelpEl = document.getElementById("order-help");
const confirmEl = document.getElementById("confirmation");
const confirmIdEl = document.getElementById("confirm-id");
const confirmStatusEl = document.getElementById("confirm-status");
const submitBtn = document.getElementById("submit-btn");
const configErrorEl = document.getElementById("config-error");
const authCard = document.getElementById("auth-card");
const authForm = document.getElementById("auth-form");
const authUsername = document.getElementById("auth-username");
const authPin = document.getElementById("auth-pin");
const authError = document.getElementById("auth-error");
const authSubmit = document.getElementById("auth-submit");
const tabLogin = document.getElementById("tab-login");
const tabRegister = document.getElementById("tab-register");
const studentSignOut = document.getElementById("student-sign-out");
const studentLabel = document.getElementById("student-label");
const activeOrderNote = document.getElementById("active-order-note");

let authMode = "login";
let orderUnsubs = null;
let slotState = new Map();
let menuState = new Map();
let activeMenuSection = "snacks";
let orderItems = [];
let menuLoadFailed = false;
let slotLoadFailed = false;

function normalizeUsername(raw) {
  const u = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);
  if (u.length < 3) {
    throw new Error("Username must be at least 3 letters, numbers, or underscores.");
  }
  return u;
}

function normalizeMenuCategory(raw) {
  return Object.prototype.hasOwnProperty.call(MENU_SECTIONS, raw) ? raw : "snacks";
}

function currentMenuSectionMeta() {
  return MENU_SECTIONS[activeMenuSection] || MENU_SECTIONS.snacks;
}

function currentStudentUsername() {
  return sessionStorage.getItem(SESSION_KEY) || "";
}

function saveLastOrder(docId, forUser) {
  localStorage.setItem(LAST_ORDER_KEY, JSON.stringify({ id: docId, forUser }));
}

function clearLastOrder() {
  localStorage.removeItem(LAST_ORDER_KEY);
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safePrice(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function slotCapacity(slot) {
  return Math.max(1, safeInt(slot?.capacity, DEFAULT_SLOT_CAPACITY));
}

function slotActiveCount(slot) {
  return Math.max(0, safeInt(slot?.activeCount, 0));
}

function slotRemaining(slot) {
  return Math.max(0, slotCapacity(slot) - slotActiveCount(slot));
}

function formatPrice(value) {
  return value == null ? "Price on request" : PRICE_FORMATTER.format(value);
}

function menuItemFromDoc(id, data) {
  return {
    id,
    name: String(data?.name || "Item"),
    imageUrl: typeof data?.imageUrl === "string" ? data.imageUrl.trim() : "",
    price: safePrice(data?.price),
    available: data?.available !== false,
    enabled: data?.enabled !== false,
    category: normalizeMenuCategory(data?.category),
    sortOrder: safeInt(data?.sortOrder, 0),
  };
}

function draftQuantityFor(menuItemId) {
  const match = orderItems.find((item) => item.menuItemId === menuItemId);
  return match ? Math.max(1, safeInt(match.quantity, 1)) : 0;
}

function draftTotalQuantity() {
  return orderItems.reduce((sum, item) => sum + Math.max(1, safeInt(item.quantity, 1)), 0);
}

function draftTotalPrice() {
  return orderItems.reduce((sum, item) => {
    if (item.price == null) return sum;
    return sum + item.price * Math.max(1, safeInt(item.quantity, 1));
  }, 0);
}

function draftTotalLabel() {
  const totalQuantity = draftTotalQuantity();
  if (!totalQuantity) return "0 items";
  const itemWord = totalQuantity === 1 ? "item" : "items";
  const hasFullPricing = orderItems.length > 0 && orderItems.every((item) => item.price != null);
  return hasFullPricing
    ? `${totalQuantity} ${itemWord} • ${formatPrice(draftTotalPrice())}`
    : `${totalQuantity} ${itemWord}`;
}

function updateMobileCartUi() {
  if (!mobileCartFab || !mobileCartCount) return;
  const totalQuantity = draftTotalQuantity();
  mobileCartFab.hidden = totalQuantity === 0;
  mobileCartCount.textContent = draftTotalLabel();
}

function openMobileCart() {
  if (!basketPanel) return;
  basketPanel.classList.add("mobile-cart-open");
  mobileCartOverlay?.removeAttribute("hidden");
  document.body.classList.add("mobile-cart-active");
}

function closeMobileCart() {
  if (!basketPanel) return;
  basketPanel.classList.remove("mobile-cart-open");
  mobileCartOverlay?.setAttribute("hidden", "hidden");
  document.body.classList.remove("mobile-cart-active");
}

function showConfigError(msg) {
  configErrorEl.hidden = false;
  configErrorEl.textContent = msg;
  authCard.hidden = true;
  orderApp.hidden = true;
  menuGrid.innerHTML = "";
  menuEmptyEl.hidden = false;
  menuEmptyEl.textContent = "Unavailable";
  slotSel.innerHTML = '<option value="">Unavailable</option>';
  slotHelpEl.textContent = "";
  menuLoadFailed = true;
  slotLoadFailed = true;
  submitBtn.disabled = true;
}

function setAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle("active", mode === "login");
  tabRegister.classList.toggle("active", mode === "register");
  authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
}

function tearDownOrderListeners() {
  if (orderUnsubs) {
    orderUnsubs.forEach((unsub) => unsub());
    orderUnsubs = null;
  }
}

function setOrderHelp(msg) {
  orderHelpEl.textContent = msg || "";
}

function showConfirmationPanel(displayId, status) {
  confirmIdEl.textContent = displayId || "-";
  confirmStatusEl.textContent =
    status === "ready" ? "Latest order: Ready - come to the counter." : "Latest order: Waiting for the kitchen.";
  confirmEl.hidden = false;
  activeOrderNote.hidden = false;
  activeOrderNote.textContent = "Track your current order here before placing another one.";
}

function hideConfirmationPanel() {
  confirmEl.hidden = true;
  confirmStatusEl.textContent = "";
  activeOrderNote.hidden = true;
}

function updateSlotHelp() {
  if (slotBlockerEl) {
    if (slotState.size === 0) {
      slotBlockerEl.hidden = false;
      slotBlockerEl.textContent = "Pickup times are not available yet. Staff need to add at least one slot before orders can be placed.";
    } else {
      slotBlockerEl.hidden = true;
      slotBlockerEl.textContent = "";
    }
  }

  if (orderItems.length === 0) {
    slotHelpEl.textContent = slotState.size === 0 ? "Pickup times will unlock after staff open slots." : "Add at least one item to unlock pickup time.";
    return;
  }

  const selected = slotState.get(slotSel.value);
  if (!selected) {
    slotHelpEl.textContent = slotState.size === 0 ? "Staff need to add pickup slots first." : "Choose one pickup slot for the whole order.";
    return;
  }

  const remaining = slotRemaining(selected);
  const capacity = slotCapacity(selected);
  slotHelpEl.textContent =
    remaining === 0
      ? "This slot is full. Choose another pickup time."
      : `${remaining} of ${capacity} pickup spots left.`;
}

function fallbackMarkup(item) {
  return `<div class="menu-card-fallback">${escapeText(item.name).slice(0, 1).toUpperCase()}</div>`;
}

function cardImageMarkup(item) {
  if (item.imageUrl) {
    const initial = escapeAttr(String(item.name || "?").slice(0, 1).toUpperCase());
    return `<img src="${escapeAttr(item.imageUrl)}" alt="${escapeAttr(item.name)}" loading="lazy" data-fallback="${initial}" />`;
  }
  return fallbackMarkup(item);
}

function renderMenuSectionTabs() {
  if (!menuSectionTabs) return;
  menuSectionTabs.querySelectorAll("[data-section]").forEach((button) => {
    button.classList.toggle("active", button.dataset.section === activeMenuSection);
    button.setAttribute("aria-selected", button.dataset.section === activeMenuSection ? "true" : "false");
  });
}

function updateMenuSectionNote() {}

function itemsForActiveSection() {
  return [...menuState.values()]
    .filter((item) => item.enabled && item.category === activeMenuSection)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

function cardActionMarkup(item) {
  const quantity = draftQuantityFor(item.id);
  if (!item.available) {
    return '<span class="menu-card-status-inline">Sold out</span>';
  }
  if (quantity > 0) {
    return `
      <div class="menu-card-stepper" data-stepper-id="${escapeAttr(item.id)}">
        <button type="button" class="menu-qty-btn" data-minus-id="${escapeAttr(item.id)}" aria-label="Decrease ${escapeAttr(item.name)}">-</button>
        <span class="menu-qty-count">${quantity}</span>
        <button type="button" class="menu-qty-btn" data-plus-id="${escapeAttr(item.id)}" aria-label="Increase ${escapeAttr(item.name)}">+</button>
      </div>
    `;
  }
  return `<button type="button" class="menu-add-btn" data-add-id="${escapeAttr(item.id)}" aria-label="Add ${escapeAttr(item.name)}">+</button>`;
}

function renderMenuCards() {
  const items = itemsForActiveSection();

  menuGrid.innerHTML = "";
  if (items.length === 0) {
    menuEmptyEl.hidden = false;
    menuEmptyEl.textContent = `No ${currentMenuSectionMeta().label.toLowerCase()} available right now.`;
    return;
  }

  menuEmptyEl.hidden = true;
  menuGrid.innerHTML = items
    .map((item) => {
      const price = item.price == null ? "" : `<p class="menu-card-price">${escapeText(formatPrice(item.price))}</p>`;
      const sectionMeta = MENU_SECTIONS[item.category] || MENU_SECTIONS.snacks;
      return `
        <article class="menu-card menu-card-direct${item.available ? "" : " is-unavailable"}">
          <div class="menu-card-media">${cardImageMarkup(item)}</div>
          <div class="menu-card-body">
            <div class="menu-card-topline">
              <h3>${escapeText(item.name)}</h3>
              <div class="menu-card-actions">${cardActionMarkup(item)}</div>
            </div>
            ${price}
            <p class="menu-card-copy">${escapeText(sectionMeta.detail)}</p>
          </div>
        </article>
      `;
    })
    .join("");

  attachImageFallbacks(menuGrid);
}

function renderDraftItems() {
  const hasItems = orderItems.length > 0;
  orderItemsEmptyEl.hidden = hasItems;
  orderItemsEl.innerHTML = hasItems
    ? orderItems
        .map((item) => {
          const quantity = Math.max(1, safeInt(item.quantity, 1));
          const linePrice = item.price == null ? "" : ` • ${escapeText(formatPrice(item.price * quantity))}`;
          return `
            <article class="draft-order-item draft-order-item-compact">
              <div class="order-item-copy">
                <h4>${escapeText(item.menuItemName)}</h4>
                <p class="order-item-meta">Qty ${quantity}${linePrice}</p>
              </div>
              <div class="basket-stepper">
                <button type="button" class="menu-qty-btn" data-remove-one-id="${escapeAttr(item.menuItemId)}">-</button>
                <span class="menu-qty-count">${quantity}</span>
                <button type="button" class="menu-qty-btn" data-add-one-id="${escapeAttr(item.menuItemId)}">+</button>
              </div>
            </article>
          `;
        })
        .join("")
    : "";
  orderTotalEl.textContent = draftTotalLabel();
  updateMobileCartUi();
}

function updateCheckoutState() {
  const hasItems = orderItems.length > 0;
  slotSel.disabled = !hasItems || slotLoadFailed;
  submitBtn.disabled = !hasItems || slotLoadFailed || menuLoadFailed || slotState.size === 0;
  if ((!hasItems || slotLoadFailed) && slotSel.value) {
    slotSel.value = "";
  }
  orderTotalEl.textContent = draftTotalLabel();
}

function setActiveMenuSection(section) {
  const nextSection = normalizeMenuCategory(section);
  if (nextSection === activeMenuSection) return;
  activeMenuSection = nextSection;
  renderMenuSectionTabs();
  updateMenuSectionNote();
  renderMenuCards();
  setOrderHelp("");
}

function changeDraftItemQuantity(menuItemId, delta) {
  const liveItem = menuState.get(menuItemId);
  if (delta > 0 && (!liveItem || !liveItem.enabled || !liveItem.available)) {
    setOrderHelp("That item is no longer available.");
    return;
  }

  const existing = orderItems.find((item) => item.menuItemId === menuItemId);
  if (!existing && delta > 0 && liveItem) {
    orderItems.push({
      menuItemId: liveItem.id,
      menuItemName: liveItem.name,
      quantity: 1,
      price: liveItem.price,
      imageUrl: liveItem.imageUrl,
    });
  } else if (existing) {
    const nextQuantity = Math.max(0, Math.min(99, existing.quantity + delta));
    if (nextQuantity === 0) {
      orderItems = orderItems.filter((item) => item.menuItemId !== menuItemId);
    } else {
      existing.quantity = nextQuantity;
      if (liveItem) {
        existing.menuItemName = liveItem.name;
        existing.price = liveItem.price;
        existing.imageUrl = liveItem.imageUrl;
      }
    }
  }

  renderMenuCards();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();
}

function reconcileDraftItems() {
  let removedAny = false;
  orderItems = orderItems
    .map((draft) => {
      const live = menuState.get(draft.menuItemId);
      if (!live || !live.enabled || !live.available) {
        removedAny = true;
        return null;
      }
      return {
        ...draft,
        menuItemName: live.name,
        price: live.price,
        imageUrl: live.imageUrl,
      };
    })
    .filter(Boolean);

  if (removedAny) {
    setOrderHelp("One or more items in your basket became unavailable and were removed.");
  }

  renderMenuCards();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();
}

function attachImageFallbacks(root) {
  root.querySelectorAll("img[data-fallback]").forEach((img) => {
    img.addEventListener(
      "error",
      () => {
        const holder = img.parentElement;
        if (!holder) return;
        holder.innerHTML = `<div class="menu-card-fallback">${escapeText(img.dataset.fallback || "?")}</div>`;
      },
      { once: true }
    );
  });
}

function startOrderListeners() {
  tearDownOrderListeners();
  const unsubs = [];

  unsubs.push(
    onSnapshot(
      collection(db, "menu"),
      (snap) => {
        menuLoadFailed = false;
        const items = snap.docs.map((d) => menuItemFromDoc(d.id, d.data()));
        menuState = new Map(items.map((item) => [item.id, item]));
        reconcileDraftItems();
      },
      (err) => {
        console.error(err);
        menuLoadFailed = true;
        menuState = new Map();
        menuGrid.innerHTML = "";
        menuEmptyEl.hidden = false;
        menuEmptyEl.textContent = "Could not load menu right now.";
        setOrderHelp("Could not load the live menu. Refresh and try again.");
        updateCheckoutState();
      }
    )
  );

  unsubs.push(
    onSnapshot(
      collection(db, "slots"),
      (snap) => {
        slotLoadFailed = false;
        const slots = snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((slot) => slot.enabled !== false)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

        slotState = new Map(slots.map((slot) => [slot.id, slot]));
        const current = slotSel.value;
        slotSel.innerHTML =
          slots.length === 0
            ? '<option value="">No pickup slots yet</option>'
            : '<option value="">Choose a time...</option>' +
              slots
                .map((slot) => {
                  const label = escapeAttr(slot.label || "Slot");
                  const remaining = slotRemaining(slot);
                  const capacity = slotCapacity(slot);
                  const suffix = remaining === 0 ? " (Full)" : ` (${remaining}/${capacity} left)`;
                  const disabled = remaining === 0 ? " disabled" : "";
                  return `<option value="${escapeAttr(slot.id)}" data-label="${label}"${disabled}>${label}${suffix}</option>`;
                })
                .join("");
        if ([...slotSel.options].some((option) => option.value === current)) {
          slotSel.value = current;
        }
        updateCheckoutState();
        updateSlotHelp();
      },
      (err) => {
        console.error(err);
        slotLoadFailed = true;
        slotState = new Map();
        slotSel.innerHTML = '<option value="">Could not load pickup slots</option>';
        setOrderHelp("Could not load pickup slots. Refresh and try again.");
        updateCheckoutState();
        updateSlotHelp();
      }
    )
  );

  orderUnsubs = unsubs;
}

function showFormPanel() {
  form.hidden = false;
  if (selectionStage) {
    selectionStage.hidden = true;
  }
  renderMenuSectionTabs();
  updateMenuSectionNote();
  renderMenuCards();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();
}

function resetComposerUi() {
  orderItems = [];
  form.reset();
  slotSel.value = "";
  if (selectionStage) {
    selectionStage.hidden = true;
  }
  renderMenuCards();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();
}

function showOrderChrome() {
  const user = currentStudentUsername();
  authCard.hidden = true;
  orderApp.hidden = false;
  studentSignOut.hidden = false;
  studentLabel.textContent = user ? `@${user}` : "";
  orderUsernameEl.textContent = user ? `@${user}` : "@student";
  startOrderListeners();
  showFormPanel();
}

function showAuthChrome() {
  tearDownOrderListeners();
  clearLastOrder();
  sessionStorage.removeItem(SESSION_KEY);
  authCard.hidden = false;
  orderApp.hidden = true;
  studentSignOut.hidden = true;
  studentLabel.textContent = "";
  orderUsernameEl.textContent = "@student";
  slotState = new Map();
  menuState = new Map();
  activeMenuSection = "snacks";
  orderItems = [];
  slotSel.innerHTML = '<option value="">Loading slots...</option>';
  menuGrid.innerHTML = "";
  menuEmptyEl.hidden = true;
  if (selectionStage) {
    selectionStage.hidden = true;
  }
  hideConfirmationPanel();
  renderMenuSectionTabs();
  updateMenuSectionNote();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();
  setOrderHelp("");
}

tabLogin.addEventListener("click", () => setAuthMode("login"));
tabRegister.addEventListener("click", () => setAuthMode("register"));
slotSel.addEventListener("change", updateSlotHelp);
menuGrid.addEventListener("click", (e) => {
  const addBtn = e.target.closest("[data-add-id]");
  if (addBtn) {
    changeDraftItemQuantity(addBtn.dataset.addId || "", 1);
    return;
  }

  const plusBtn = e.target.closest("[data-plus-id]");
  if (plusBtn) {
    changeDraftItemQuantity(plusBtn.dataset.plusId || "", 1);
    return;
  }

  const minusBtn = e.target.closest("[data-minus-id]");
  if (minusBtn) {
    changeDraftItemQuantity(minusBtn.dataset.minusId || "", -1);
  }
});
menuSectionTabs?.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-section]");
  if (!tab) return;
  setActiveMenuSection(tab.dataset.section || "snacks");
});
orderItemsEl.addEventListener("click", (e) => {
  const addOneBtn = e.target.closest("[data-add-one-id]");
  if (addOneBtn) {
    changeDraftItemQuantity(addOneBtn.dataset.addOneId || "", 1);
    return;
  }

  const removeOneBtn = e.target.closest("[data-remove-one-id]");
  if (removeOneBtn) {
    changeDraftItemQuantity(removeOneBtn.dataset.removeOneId || "", -1);
  }
});
mobileCartFab?.addEventListener("click", () => {
  openMobileCart();
});
basketCloseBtn?.addEventListener("click", () => {
  closeMobileCart();
});
mobileCartOverlay?.addEventListener("click", () => {
  closeMobileCart();
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.textContent = "";
  const pin = authPin.value;
  let studentId;
  try {
    studentId = normalizeUsername(authUsername.value);
  } catch (err) {
    authError.textContent = err.message || "Invalid username.";
    return;
  }
  if (pin.length < 4) {
    authError.textContent = "PIN must be at least 4 characters.";
    return;
  }

  authSubmit.disabled = true;
  try {
    const ref = doc(db, "students", studentId);
    const snap = await getDoc(ref);

    if (authMode === "register") {
      if (snap.exists()) {
        authError.textContent = "That username is taken. Sign in instead.";
        return;
      }
      await setDoc(ref, { pin, createdAt: serverTimestamp(), activeOrderId: null });
    } else {
      if (!snap.exists() || snap.data()?.pin !== pin) {
        authError.textContent = "Wrong username or PIN.";
        return;
      }
    }

    sessionStorage.setItem(SESSION_KEY, studentId);
    authPin.value = "";
    resetComposerUi();
    hideConfirmationPanel();
    showOrderChrome();
  } catch (err) {
    console.error(err);
    authError.textContent = "Could not reach Firestore. Check config and rules.";
  } finally {
    authSubmit.disabled = false;
  }
});

studentSignOut.addEventListener("click", () => {
  showAuthChrome();
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const studentUsername = currentStudentUsername();
  if (!studentUsername) return;
  if (orderItems.length === 0) {
    setOrderHelp("Add at least one item before placing the order.");
    return;
  }

  const slotOption = slotSel.selectedOptions[0];
  if (!slotOption?.value) {
    setOrderHelp("Choose a pickup slot for this order.");
    return;
  }

  const slot = slotState.get(slotOption.value);
  if (!slot || slotRemaining(slot) === 0) {
    setOrderHelp("That pickup slot is full. Choose another one.");
    return;
  }

  const requestedItems = orderItems.map((item) => ({
    menuItemId: item.menuItemId,
    quantity: Math.max(1, Math.min(99, safeInt(item.quantity, 1))),
  }));
  const slotLabel = slotOption.dataset.label || slotOption.textContent || "";
  const orderRef = doc(collection(db, "orders"));
  let placedDisplayId = "";

  submitBtn.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      const counterRef = doc(db, "meta", "counters");
      const slotRef = doc(db, "slots", slotOption.value);
      const studentRef = doc(db, "students", studentUsername);

      const counterSnap = await tx.get(counterRef);
      const slotSnap = await tx.get(slotRef);
      const studentSnap = await tx.get(studentRef);
      const menuSnaps = [];
      for (const item of requestedItems) {
        menuSnaps.push(await tx.get(doc(db, "menu", item.menuItemId)));
      }

      if (!studentSnap.exists()) {
        throw new Error("Please sign in again before placing an order.");
      }
      if (!slotSnap.exists()) {
        throw new Error("That pickup slot no longer exists. Refresh and try again.");
      }

      const slotData = slotSnap.data() || {};
      const capacity = slotCapacity(slotData);
      const activeCount = slotActiveCount(slotData);
      if (activeCount >= capacity) {
        throw new Error("That pickup slot just filled up. Choose another one.");
      }

      const validatedItems = requestedItems.map((requested, index) => {
        const menuSnap = menuSnaps[index];
        if (!menuSnap.exists()) {
          throw new Error("One of the selected items no longer exists. Refresh and try again.");
        }
        const menuData = menuItemFromDoc(menuSnap.id, menuSnap.data());
        if (!menuData.enabled || !menuData.available) {
          throw new Error(`${menuData.name} is no longer available.`);
        }
        return {
          menuItemId: menuSnap.id,
          menuItemName: menuData.name,
          quantity: requested.quantity,
          price: menuData.price,
        };
      });

      const totalQuantity = validatedItems.reduce((sum, item) => sum + item.quantity, 0);
      const currentSeq = counterSnap.exists() && typeof counterSnap.data()?.orderSeq === "number" ? counterSnap.data().orderSeq : 100;
      const nextSeq = currentSeq + 1;
      const displayId = `#A${nextSeq}`;
      placedDisplayId = displayId;

      tx.set(counterRef, { orderSeq: nextSeq }, { merge: true });
      tx.set(
        slotRef,
        {
          capacity,
          activeCount: activeCount + 1,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      tx.set(orderRef, {
        displayId,
        studentUsername,
        studentName: studentUsername,
        items: validatedItems,
        itemCount: validatedItems.length,
        totalQuantity,
        slotId: slotOption.value,
        slotLabel,
        status: "pending",
        createdAt: serverTimestamp(),
      });
    });

    saveLastOrder(orderRef.id, studentUsername);
    resetComposerUi();
    setOrderHelp("");
    showFormPanel();
    showConfirmationPanel(placedDisplayId, "pending");
  } catch (err) {
    console.error(err);
    setOrderHelp(err?.message || "Could not place order. Check Firestore and network.");
  } finally {
    updateCheckoutState();
  }
});

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;");
}

function escapeText(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

(async function init() {
  const bad = await import("./config.js").then(
    (m) => !m.firebaseConfig?.projectId || m.firebaseConfig.projectId === "YOUR_PROJECT_ID",
    () => true
  );
  if (bad) {
    showConfigError("Add your Firebase config in js/config.js (see config.example.js and README).");
    return;
  }

  hideConfirmationPanel();
  if (selectionStage) {
    selectionStage.hidden = true;
  }
  renderMenuSectionTabs();
  updateMenuSectionNote();
  renderMenuCards();
  renderDraftItems();
  updateCheckoutState();
  updateSlotHelp();

  if (currentStudentUsername()) {
    showOrderChrome();
  } else {
    setAuthMode("login");
  }
})();

