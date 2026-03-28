import { db } from "./firebase.js";
import { adminPin } from "./config.js";
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
const DEFAULT_SLOT_CAPACITY = 25;

const pinScreen = document.getElementById("pin-screen");
const dashboard = document.getElementById("dashboard");
const pinForm = document.getElementById("pin-form");
const pinInput = document.getElementById("pin-input");
const pinError = document.getElementById("pin-error");
const lockBtn = document.getElementById("lock-btn");
const ordersList = document.getElementById("orders-list");
const ordersEmpty = document.getElementById("orders-empty");

let dashboardInited = false;
let dashboardTeardown = null;

function tearDownDashboard() {
  if (dashboardTeardown) {
    dashboardTeardown();
    dashboardTeardown = null;
  }
}

function showPinScreen() {
  tearDownDashboard();
  dashboardInited = false;
  pinScreen.hidden = false;
  dashboard.hidden = true;
  lockBtn.hidden = true;
}

function openDashboard() {
  pinScreen.hidden = true;
  dashboard.hidden = false;
  lockBtn.hidden = false;
  if (!dashboardInited) {
    dashboardInited = true;
    initDashboard();
  }
}

async function runDashboardTask(task, fallbackMessage) {
  try {
    await task();
    return true;
  } catch (err) {
    console.error(err);
    alert(err?.message || fallbackMessage);
    return false;
  }
}

function initDashboard() {
  tearDownDashboard();
  const unsubs = [];

  unsubs.push(
    onSnapshot(
      query(collection(db, "orders"), orderBy("createdAt", "desc")),
      (snap) => {
        ordersList.innerHTML = "";
        if (snap.empty) {
          ordersEmpty.hidden = false;
          ordersEmpty.textContent = "No orders yet.";
          return;
        }
        ordersEmpty.hidden = true;
        for (const d of snap.docs) {
          ordersList.appendChild(renderOrderRow(d.id, d.data()));
        }
      },
      (err) => {
        console.error(err);
        ordersEmpty.hidden = false;
        ordersEmpty.textContent = "Could not load orders.";
      }
    )
  );

  const slotsListEl = document.getElementById("slots-list");
  unsubs.push(
    onSnapshot(
      query(collection(db, "slots"), orderBy("sortOrder", "asc")),
      (snap) => {
        slotsListEl.innerHTML = "";
        const slots = snap.docs.map((x) => ({ id: x.id, ...x.data() }));
        if (slots.length === 0) {
          slotsListEl.innerHTML = '<p class="muted" style="margin:0">No slots. Add one above.</p>';
          return;
        }
        for (const slot of slots) {
          slotsListEl.appendChild(renderSlotRow(slot));
        }
      },
      (err) => {
        console.error(err);
        slotsListEl.innerHTML = '<p class="muted" style="margin:0">Could not load slots.</p>';
      }
    )
  );

  const onSlot = async (e) => {
    e.preventDefault();
    const labelInput = document.getElementById("new-slot-label");
    const capacityInput = document.getElementById("new-slot-capacity");
    const label = labelInput.value.trim();
    const capacity = clampCapacity(capacityInput.value);
    if (!label) return;

    const ok = await runDashboardTask(
      () =>
        addDoc(collection(db, "slots"), {
          label,
          enabled: true,
          capacity,
          activeCount: 0,
          sortOrder: Date.now(),
          updatedAt: serverTimestamp(),
        }),
      "Could not add pickup slot."
    );

    if (ok) {
      labelInput.value = "";
      capacityInput.value = String(DEFAULT_SLOT_CAPACITY);
    }
  };

  const slotForm = document.getElementById("add-slot-form");
  slotForm.addEventListener("submit", onSlot);

  dashboardTeardown = () => {
    unsubs.forEach((u) => u());
    slotForm.removeEventListener("submit", onSlot);
  };
}

(async function boot() {
  const bad =
    (await import("./config.js").then(
      (m) => !m.firebaseConfig?.projectId || m.firebaseConfig.projectId === "YOUR_PROJECT_ID",
      () => true
    )) || adminPin == null;

  if (bad) {
    pinError.textContent = "Set firebase config and adminPin in js/config.js.";
    pinForm.querySelector("button[type='submit']").disabled = true;
    return;
  }

  if (sessionStorage.getItem(SESSION_KEY) === "1") {
    openDashboard();
  } else {
    showPinScreen();
  }

  pinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    pinError.textContent = "";
    if (pinInput.value === String(adminPin)) {
      sessionStorage.setItem(SESSION_KEY, "1");
      pinInput.value = "";
      openDashboard();
    } else {
      pinError.textContent = "Incorrect PIN.";
    }
  });

  lockBtn.addEventListener("click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    location.reload();
  });
})();

function renderOrderRow(id, order) {
  const wrap = document.createElement("div");
  wrap.className = "order-row";

  const status = order.status || "pending";
  const badgeClass =
    status === "ready"
      ? "badge-ready"
      : status === "collected"
        ? "badge-collected"
        : status === "cancelled"
          ? "badge-cancelled"
          : "badge-pending";

  const title = document.createElement("div");
  title.innerHTML = `<strong>${esc(order.displayId || id)}</strong> <span class="badge ${badgeClass}">${esc(status)}</span>`;

  const meta = document.createElement("div");
  meta.className = "order-meta";
  const displayName = order.studentUsername ? `@${order.studentUsername}` : order.studentName || "-";
  meta.innerHTML = `${esc(displayName)} | ${esc(formatOrderItems(order))} | ${esc(order.slotLabel || "")}`;

  const actions = document.createElement("div");
  actions.className = "row-actions";

  if (status === "pending") {
    actions.appendChild(mkBtn("Mark ready", "btn-secondary btn-small", () => setStatus(id, "ready")));
    actions.appendChild(mkBtn("Cancel", "btn-danger btn-small", () => setStatus(id, "cancelled")));
  } else if (status === "ready") {
    actions.appendChild(mkBtn("Mark collected", "btn-secondary btn-small", () => setStatus(id, "collected")));
    actions.appendChild(mkBtn("Cancel", "btn-danger btn-small", () => setStatus(id, "cancelled")));
  }

  wrap.appendChild(title);
  wrap.appendChild(meta);
  if (actions.childNodes.length) wrap.appendChild(actions);
  return wrap;
}

async function setStatus(id, status) {
  await runTransaction(db, async (tx) => {
    const orderRef = doc(db, "orders", id);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) {
      throw new Error("Order not found.");
    }

    const order = orderSnap.data();
    const prevStatus = order.status || "pending";
    if (prevStatus === status) return;
    if (!canTransition(prevStatus, status)) {
      throw new Error("That order can no longer move to this status.");
    }

    const wasActive = prevStatus === "pending" || prevStatus === "ready";
    const becomesTerminal = status === "collected" || status === "cancelled";

    let slotRef = null;
    let slotSnap = null;
    let studentRef = null;
    let studentSnap = null;

    if (wasActive && becomesTerminal && order.slotId) {
      slotRef = doc(db, "slots", order.slotId);
      slotSnap = await tx.get(slotRef);
    }

    if (wasActive && becomesTerminal && order.studentUsername) {
      studentRef = doc(db, "students", order.studentUsername);
      studentSnap = await tx.get(studentRef);
    }

    tx.update(orderRef, { status, updatedAt: serverTimestamp() });

    if (!wasActive || !becomesTerminal) {
      return;
    }

    if (slotRef && slotSnap?.exists()) {
      const slotData = slotSnap.data() || {};
      tx.set(
        slotRef,
        {
          capacity: clampCapacity(slotData.capacity),
          activeCount: Math.max(0, safeInt(slotData.activeCount) - 1),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    }

    if (studentRef && studentSnap?.exists() && studentSnap.data()?.activeOrderId === id) {
      tx.set(studentRef, { activeOrderId: null }, { merge: true });
    }
  });
}

function renderSlotRow(slot) {
  const row = document.createElement("div");
  row.className = "list-editor-item" + (slot.enabled === false ? " pill-off" : "");

  const left = document.createElement("div");
  left.className = "stack";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.value = slot.label || "";
  labelInput.addEventListener("change", async () => {
    const label = labelInput.value.trim();
    if (!label) {
      labelInput.value = slot.label || "";
      return;
    }
    const ok = await runDashboardTask(
      () => updateSlot(slot.id, { label, updatedAt: serverTimestamp() }),
      "Could not update pickup slot label."
    );
    if (!ok) labelInput.value = slot.label || "";
  });
  left.appendChild(labelInput);

  const stats = document.createElement("div");
  stats.className = "list-subtext";
  const activeCount = Math.max(0, safeInt(slot.activeCount));
  const capacity = clampCapacity(slot.capacity, activeCount || 1);
  stats.textContent = `${activeCount} active of ${capacity} total`;
  left.appendChild(stats);

  const capacityInput = document.createElement("input");
  capacityInput.type = "number";
  capacityInput.min = String(Math.max(1, activeCount));
  capacityInput.max = "500";
  capacityInput.value = String(capacity);
  capacityInput.title = "Slot capacity";
  capacityInput.addEventListener("change", async () => {
    const nextCapacity = clampCapacity(capacityInput.value, Math.max(1, activeCount));
    capacityInput.value = String(nextCapacity);
    const ok = await runDashboardTask(
      () => updateSlot(slot.id, { capacity: nextCapacity, updatedAt: serverTimestamp() }),
      "Could not update slot capacity."
    );
    if (!ok) capacityInput.value = String(capacity);
  });

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "btn-secondary btn-small";
  toggle.textContent = slot.enabled === false ? "Off" : "On";
  toggle.addEventListener("click", async () => {
    await runDashboardTask(
      () =>
        updateSlot(slot.id, {
          enabled: slot.enabled === false,
          updatedAt: serverTimestamp(),
        }),
      "Could not update slot status."
    );
  });

  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-danger btn-small";
  del.textContent = "Delete";
  del.addEventListener("click", async () => {
    if (activeCount > 0) {
      alert("This slot still has active orders. Finish or cancel them first.");
      return;
    }
    if (!confirm("Remove this pickup slot?")) return;
    await runDashboardTask(() => deleteDoc(doc(db, "slots", slot.id)), "Could not remove pickup slot.");
  });

  row.appendChild(left);
  const grp = document.createElement("div");
  grp.className = "row-actions";
  grp.appendChild(capacityInput);
  grp.appendChild(toggle);
  grp.appendChild(del);
  row.appendChild(grp);
  return row;
}

function mkBtn(label, cls, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = cls;
  button.textContent = label;
  button.addEventListener("click", async () => {
    try {
      await onClick();
    } catch (err) {
      console.error(err);
      alert(err?.message || "Action failed.");
    }
  });
  return button;
}

function formatOrderItems(order) {
  if (Array.isArray(order.items) && order.items.length > 0) {
    return order.items
      .map((item) => {
        const name = item && typeof item.menuItemName === "string" ? item.menuItemName : "Item";
        const quantity = Math.max(1, safeInt(item?.quantity, 1));
        return `${name} x ${quantity}`;
      })
      .join(", ");
  }

  const fallbackName = typeof order.menuItemName === "string" ? order.menuItemName : "Item";
  return `${fallbackName} x ${Math.max(1, safeInt(order.quantity, 1))}`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/\"/g, "&quot;");
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampCapacity(value, minimum = 1) {
  const raw = safeInt(value, DEFAULT_SLOT_CAPACITY);
  return Math.max(minimum, Math.min(500, raw || DEFAULT_SLOT_CAPACITY));
}

function canTransition(prevStatus, nextStatus) {
  if (prevStatus === "pending") return nextStatus === "ready" || nextStatus === "cancelled";
  if (prevStatus === "ready") return nextStatus === "collected" || nextStatus === "cancelled";
  return false;
}

async function updateSlot(id, patch) {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, "slots", id);
    const snap = await tx.get(ref);
    if (!snap.exists()) throw new Error("Pickup slot not found.");

    const current = snap.data() || {};
    const minimum = Math.max(1, safeInt(current.activeCount));
    const nextCapacity = Object.prototype.hasOwnProperty.call(patch, "capacity")
      ? clampCapacity(patch.capacity, minimum)
      : clampCapacity(current.capacity, minimum);

    tx.set(
      ref,
      {
        capacity: nextCapacity,
        activeCount: Math.max(0, safeInt(current.activeCount)),
        ...patch,
      },
      { merge: true }
    );
  });
}