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

const menuSel = document.getElementById("menu-item");
const slotSel = document.getElementById("slot");
const slotHelpEl = document.getElementById("slot-help");
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
let activeOrderUnsub = null;
let slotState = new Map();

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

function currentStudentUsername() {
  return sessionStorage.getItem(SESSION_KEY) || "";
}

function readLastOrderRef() {
  try {
    const raw = localStorage.getItem(LAST_ORDER_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const user = currentStudentUsername();
    if (!data?.id || !user) return null;
    if (data.forUser !== user) {
      localStorage.removeItem(LAST_ORDER_KEY);
      return null;
    }
    return data;
  } catch {
    localStorage.removeItem(LAST_ORDER_KEY);
    return null;
  }
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

function slotCapacity(slot) {
  return Math.max(1, safeInt(slot?.capacity, DEFAULT_SLOT_CAPACITY));
}

function slotActiveCount(slot) {
  return Math.max(0, safeInt(slot?.activeCount, 0));
}

function slotRemaining(slot) {
  return Math.max(0, slotCapacity(slot) - slotActiveCount(slot));
}

function showConfigError(msg) {
  configErrorEl.hidden = false;
  configErrorEl.textContent = msg;
  authCard.hidden = true;
  orderApp.hidden = true;
  menuSel.innerHTML = '<option value="">Unavailable</option>';
  slotSel.innerHTML = '<option value="">Unavailable</option>';
  slotHelpEl.textContent = "";
  submitBtn.disabled = true;
}

function setAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle("active", mode === "login");
  tabRegister.classList.toggle("active", mode === "register");
  authSubmit.textContent = mode === "login" ? "Sign in" : "Create account";
}

function tearDownActiveOrderListener() {
  if (activeOrderUnsub) {
    activeOrderUnsub();
    activeOrderUnsub = null;
  }
}

function tearDownOrderListeners() {
  if (orderUnsubs) {
    orderUnsubs.forEach((unsub) => unsub());
    orderUnsubs = null;
  }
}

function showFormPanel() {
  confirmEl.hidden = true;
  confirmStatusEl.textContent = "";
  form.hidden = false;
  activeOrderNote.hidden = true;
  setOrderHelp("");
}

function showConfirmationPanel(displayId, status) {
  confirmIdEl.textContent = displayId || "-";
  confirmStatusEl.textContent =
    status === "ready" ? "Status: Ready - come to the counter." : "Status: Waiting for the kitchen.";
  form.hidden = true;
  confirmEl.hidden = false;
  activeOrderNote.hidden = false;
}

function updateSlotHelp() {
  const selected = slotState.get(slotSel.value);
  if (!selected) {
    slotHelpEl.textContent = slotState.size === 0 ? "Staff need to add pickup slots first." : "";
    return;
  }

  const remaining = slotRemaining(selected);
  const capacity = slotCapacity(selected);
  slotHelpEl.textContent =
    remaining === 0
      ? "This slot is full. Choose another pickup time."
      : `${remaining} of ${capacity} spots remaining in this slot.`;
}

function setOrderHelp(msg) {
  orderHelpEl.textContent = msg || "";
}

function startOrderListeners() {
  tearDownOrderListeners();
  const unsubs = [];

  unsubs.push(
    onSnapshot(collection(db, "menu"), (snap) => {
      const items = snap.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((item) => item.enabled !== false)
        .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

      const current = menuSel.value;
      menuSel.innerHTML =
        items.length === 0
          ? '<option value="">No items available yet</option>'
          : '<option value="">Choose an item...</option>' +
            items
              .map((item) => {
                const name = escapeAttr(item.name || "Item");
                return `<option value="${escapeAttr(item.id)}" data-name="${name}">${name}</option>`;
              })
              .join("");
      if ([...menuSel.options].some((option) => option.value === current)) {
        menuSel.value = current;
      }
    })
  );

  unsubs.push(
    onSnapshot(collection(db, "slots"), (snap) => {
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
      updateSlotHelp();
    })
  );

  orderUnsubs = unsubs;
}

function attachActiveOrderListener(orderDocId) {
  tearDownActiveOrderListener();
  const user = currentStudentUsername();
  if (!orderDocId || !user) {
    showFormPanel();
    return;
  }

  activeOrderUnsub = onSnapshot(
    doc(db, "orders", orderDocId),
    (snap) => {
      if (!snap.exists()) {
        clearLastOrder();
        showFormPanel();
        return;
      }
      const data = snap.data();
      if (data.studentUsername !== user) {
        clearLastOrder();
        showFormPanel();
        return;
      }

      const status = data.status || "pending";
      if (status === "collected" || status === "cancelled") {
        clearLastOrder();
        showFormPanel();
        return;
      }

      showConfirmationPanel(data.displayId || "", status);
    },
    () => {
      showFormPanel();
    }
  );
}

function resumePendingOrderUi() {
  const user = currentStudentUsername();
  if (!user) {
    showFormPanel();
    return;
  }

  getDoc(doc(db, "students", user))
    .then((snap) => {
      const activeOrderId = snap.exists() ? snap.data()?.activeOrderId : null;
      const ref = readLastOrderRef();
      const orderId = activeOrderId || ref?.id;
      if (!orderId) {
        showFormPanel();
        return;
      }
      attachActiveOrderListener(orderId);
    })
    .catch(() => {
      showFormPanel();
    });
}

function showOrderChrome() {
  const user = currentStudentUsername();
  authCard.hidden = true;
  orderApp.hidden = false;
  studentSignOut.hidden = false;
  studentLabel.textContent = user ? `@${user}` : "";
  startOrderListeners();
  resumePendingOrderUi();
}

function showAuthChrome() {
  tearDownOrderListeners();
  tearDownActiveOrderListener();
  clearLastOrder();
  sessionStorage.removeItem(SESSION_KEY);
  authCard.hidden = false;
  orderApp.hidden = true;
  studentSignOut.hidden = true;
  studentLabel.textContent = "";
  slotState = new Map();
}

tabLogin.addEventListener("click", () => setAuthMode("login"));
tabRegister.addEventListener("click", () => setAuthMode("register"));
slotSel.addEventListener("change", updateSlotHelp);

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

  const name = form.studentName.value.trim();
  const menuOption = menuSel.selectedOptions[0];
  const slotOption = slotSel.selectedOptions[0];
  const quantity = Number(form.quantity.value);

  if (!name || !menuOption?.value || !slotOption?.value) return;
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 99) return;
  setOrderHelp("");

  const slot = slotState.get(slotOption.value);
  if (!slot || slotRemaining(slot) === 0) {
    setOrderHelp("That pickup slot is full. Choose another one.");
    return;
  }

  const menuItemName = menuOption.dataset.name || menuOption.textContent || "";
  const slotLabel = slotOption.dataset.label || slotOption.textContent || "";
  const orderRef = doc(collection(db, "orders"));

  submitBtn.disabled = true;
  try {
    await runTransaction(db, async (tx) => {
      const counterRef = doc(db, "meta", "counters");
      const slotRef = doc(db, "slots", slotOption.value);
      const studentRef = doc(db, "students", studentUsername);

      const counterSnap = await tx.get(counterRef);
      const slotSnap = await tx.get(slotRef);
      const studentSnap = await tx.get(studentRef);

      if (!studentSnap.exists()) {
        throw new Error("Please sign in again before placing an order.");
      }
      if (studentSnap.data()?.activeOrderId) {
        throw new Error("You already have an active order. Wait until it is collected or cancelled.");
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

      const currentSeq = counterSnap.exists() && typeof counterSnap.data()?.orderSeq === "number" ? counterSnap.data().orderSeq : 100;
      const nextSeq = currentSeq + 1;
      const displayId = `#A${nextSeq}`;

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
      tx.set(studentRef, { activeOrderId: orderRef.id }, { merge: true });
      tx.set(orderRef, {
        displayId,
        studentUsername,
        studentName: name,
        menuItemId: menuOption.value,
        menuItemName,
        quantity,
        slotId: slotOption.value,
        slotLabel,
        status: "pending",
        createdAt: serverTimestamp(),
      });
    });

    saveLastOrder(orderRef.id, studentUsername);
    form.reset();
    form.quantity.value = "1";
    slotSel.value = "";
    updateSlotHelp();
    attachActiveOrderListener(orderRef.id);
  } catch (err) {
    console.error(err);
    setOrderHelp(err?.message || "Could not place order. Check Firestore and network.");
  } finally {
    submitBtn.disabled = false;
  }
});

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/\"/g, "&quot;")
    .replace(/</g, "&lt;");
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

  if (currentStudentUsername()) {
    showOrderChrome();
  } else {
    setAuthMode("login");
  }
})();