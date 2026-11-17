const $ = id => document.getElementById(id);
const DB_KEY = "lendledger_light_db_v1";
const SESSION_KEY = "lendledger_light_session";

let db = readDB();
let currentUser = null;
let currentPage = "overview";
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = isoDate(new Date());
let toastTimer;

function readDB() {
  try {
    return JSON.parse(localStorage.getItem(DB_KEY)) || { users: [], data: {} };
  } catch {
    return { users: [], data: {} };
  }
}

function writeDB() {
  localStorage.setItem(DB_KEY, JSON.stringify(db));
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function today() {
  return isoDate(new Date());
}

function money(n) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2
  }).format(Number(n) || 0);
}

function safe(s = "") {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function dateLabel(s, opts = { day: "numeric", month: "short", year: "numeric" }) {
  if (!s) return "—";
  return new Date(s + "T12:00:00").toLocaleDateString("en-IN", opts);
}

function initials(name = "U") {
  return name.trim().split(/\s+/).slice(0, 2).map(x => x[0]).join("").toUpperCase();
}

function userData() {
  if (!currentUser) return null;
  const data = db.data[currentUser.email] ||= { loans: [] };
  data.loans ||= [];
  data.notifications ||= [];
  return data;
}

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + password);

  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");
  }

  return btoa(unescape(encodeURIComponent(salt + password)));
}

/* AUTHENTICATION */

function setAuthMode(mode) {
  document.querySelectorAll(".auth-tab").forEach(b =>
    b.classList.toggle("active", b.dataset.auth === mode)
  );

  const reg = mode === "register";

  $("nameField").classList.toggle("hidden", !reg);
  $("authEyebrow").textContent = reg ? "GET STARTED" : "WELCOME BACK";
  $("authTitle").textContent = reg ? "Create your workspace" : "Sign in to your workspace";
  $("authSubtitle").textContent = reg
    ? "Set up your personal lending tracker."
    : "Your lending overview is right where you left it.";

  $("authSubmit").innerHTML = reg
    ? 'Create account <span>→</span>'
    : 'Sign in <span>→</span>';

  $("authPassword").autocomplete = reg ? "new-password" : "current-password";
  $("authError").textContent = "";
  $("authForm").dataset.mode = mode;
}

document.querySelectorAll(".auth-tab").forEach(b =>
  b.addEventListener("click", () => setAuthMode(b.dataset.auth))
);

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();

  const mode = e.currentTarget.dataset.mode;
  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;

  $("authError").textContent = "";

  if (password.length < 6) {
    $("authError").textContent = "Password must contain at least 6 characters.";
    return;
  }

  let user = db.users.find(u => u.email === email);

  if (mode === "register") {
    const name = $("authName").value.trim();

    if (!name) {
      $("authError").textContent = "Please enter your name.";
      return;
    }

    if (user) {
      $("authError").textContent = "An account with this email already exists.";
      return;
    }

    const salt = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

    user = {
      email,
      name,
      salt,
      passwordHash: await hashPassword(password, salt)
    };

    db.users.push(user);
    db.data[email] = { loans: [] };
    writeDB();

  } else {
    if (!user || user.passwordHash !== await hashPassword(password, user.salt)) {
      $("authError").textContent = "Email or password is incorrect.";
      return;
    }
  }

  login(user);
});

function login(user) {
  currentUser = user;
  sessionStorage.setItem(SESSION_KEY, user.email);

  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");

  $("userName").textContent = user.name;
  $("userAvatar").textContent = initials(user.name);
  $("welcomeName").textContent = user.name.split(" ")[0];

  $("todayLabel").textContent = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric"
  });

  renderAll();
  renderNotificationBadges();
  checkDueNotifications();
}

function logout() {
  currentUser = null;
  sessionStorage.removeItem(SESSION_KEY);

  $("app").classList.add("hidden");
  $("authScreen").classList.remove("hidden");

  $("authForm").reset();
  setAuthMode("login");
}

$("logoutBtn").addEventListener("click", logout);

const sessionEmail = sessionStorage.getItem(SESSION_KEY);

if (sessionEmail) {
  const saved = db.users.find(u => u.email === sessionEmail);
  if (saved) login(saved);
}

/* LOAN DATA */

function loans() {
  return userData().loans;
}

function calc(l) {
  const interest = l.principal * l.rate / 100 * l.months;
  const total = l.principal + interest;
  const received = l.payments.reduce((s, p) => s + p.amount, 0);

  return {
    interest,
    total,
    received,
    balance: Math.max(0, total - received)
  };
}

function status(l) {
  const c = calc(l);

  if (c.balance < 0.005) return "paid";
  return l.dueDate < today() ? "overdue" : "active";
}

function addMonths(s, n) {
  const d = new Date(s + "T12:00:00");
  const day = d.getDate();

  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));

  return isoDate(d);
}

function renderAll() {
  renderStats();
  renderBorrowers();
  renderHistory();
  renderUpcoming();
  renderCalendar();
  renderRecent();
  drawChart();
  renderNotificationBadges();

  if (currentPage === "notifications") {
    renderFullNotifications();
  }
}

/* OVERVIEW */

function renderStats() {
  const ls = loans();

  const sum = ls.reduce((a, l) => {
    const c = calc(l);
    a.lent += l.principal;
    a.received += c.received;
    a.balance += c.balance;
    return a;
  }, { lent: 0, received: 0, balance: 0 });

  $("statLent").textContent = money(sum.lent);
  $("statReceived").textContent = money(sum.received);
  $("statOutstanding").textContent = money(sum.balance);
  $("statBorrowers").textContent = ls.filter(l => calc(l).balance > 0.005).length;
}

/* PAGE NAVIGATION */

function goPage(page) {
  currentPage = page;

  document.querySelectorAll(".page").forEach(p =>
    p.classList.toggle("active", p.id === "page-" + page)
  );

  document.querySelectorAll(".nav-link[data-page]").forEach(b =>
    b.classList.toggle("active", b.dataset.page === page)
  );

  $("pageTitle").textContent = ({
    overview: "Overview",
    borrowers: "Borrowers",
    calendar: "Repayment calendar",
    history: "Payment history",
    notifications: "Notifications"
  })[page] || "LendLedger";

  $("sidebar").classList.remove("open");

  if (page === "overview") setTimeout(drawChart, 40);
  if (page === "notifications") renderFullNotifications();
}

document.querySelectorAll(".nav-link[data-page]").forEach(b =>
  b.addEventListener("click", () => goPage(b.dataset.page))
);

document.querySelectorAll("[data-goto]").forEach(b =>
  b.addEventListener("click", () => goPage(b.dataset.goto))
);

$("menuBtn").addEventListener("click", () =>
  $("sidebar").classList.toggle("open")
);

/* MODALS */

function openModal(id) {
  $(id).showModal();
}

document.querySelectorAll("[data-close]").forEach(b =>
  b.addEventListener("click", () => $(b.dataset.close).close())
);

/* ADD BORROWER */

function openLoan() {
  $("loanForm").reset();
  $("loanStart").value = today();
  $("loanRate").value = 2;
  $("loanDuration").value = 1;
  $("loanEstimate").textContent = "Enter an amount to preview the repayment total.";
  openModal("loanModal");
}

$("addLoanBtn").addEventListener("click", openLoan);
$("addLoanTop").addEventListener("click", openLoan);

["loanAmount", "loanRate", "loanDuration", "durationUnit"].forEach(id =>
  $(id).addEventListener("input", previewLoan)
);

function previewLoan() {
  const p = Number($("loanAmount").value);
  const r = Number($("loanRate").value);
  const n = Number($("loanDuration").value);
  const months = n * ($("durationUnit").value === "years" ? 12 : 1);

  if (p > 0 && r >= 0 && months > 0) {
    const i = p * r / 100 * months;

    $("loanEstimate").innerHTML =
      `Estimated interest <b>${money(i)}</b> · Total expected <b>${money(p + i)}</b><br>` +
      `Simple interest: principal × monthly rate × duration in months.`;
  } else {
    $("loanEstimate").textContent = "Enter an amount to preview the repayment total.";
  }
}

$("loanForm").addEventListener("submit", e => {
  e.preventDefault();

  const months = Number($("loanDuration").value) *
    ($("durationUnit").value === "years" ? 12 : 1);

  const principal = Number($("loanAmount").value);
  const rate = Number($("loanRate").value);
  const startDate = $("loanStart").value;

  if (!(principal > 0) || rate < 0 || !(months >= 1) ||
      !Number.isInteger(months) || !startDate) {
    showToast("Please check the loan details.");
    return;
  }

  const l = {
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    name: $("loanName").value.trim(),
    phone: $("loanPhone").value.trim(),
    principal,
    rate,
    months,
    startDate,
    dueDate: addMonths(startDate, months),
    notes: $("loanNotes").value.trim(),
    payments: []
  };

  loans().unshift(l);

  addInAppNotification(
    "Borrower added",
    `${l.name} was added with a loan of ${money(l.principal)}.`,
    "activity"
  );

  writeDB();
  $("loanModal").close();
  renderAll();
  showToast("Borrower and loan added.");
});

/* BORROWERS */

function renderBorrowers() {
  const q = $("borrowerSearch").value.toLowerCase();
  const filter = $("borrowerFilter").value;

  const arr = loans()
    .filter(l => (l.name + " " + l.phone).toLowerCase().includes(q))
    .filter(l => filter === "all" || status(l) === filter);

  $("borrowerGrid").innerHTML = arr.length
    ? arr.map(l => {
      const c = calc(l);
      const st = status(l);

      return `
        <article class="borrower-card">
          <div class="borrower-top">
            <span class="borrower-avatar">${safe(initials(l.name))}</span>
            <div>
              <b>${safe(l.name)}</b>
              <small>${safe(l.phone || "No contact added")}</small>
            </div>
            <span class="status-pill ${st}">
              ${st === "paid" ? "Repaid" : st === "overdue" ? "Overdue" : "Active"}
            </span>
          </div>

          <div class="borrower-numbers">
            <div><span>Outstanding</span><b>${money(c.balance)}</b></div>
            <div><span>Total due</span><b>${money(c.total)}</b></div>
          </div>

          <div class="borrower-meta">
            <span>Due ${dateLabel(l.dueDate, { day: "numeric", month: "short", year: "numeric" })}</span>
            <span>${l.payments.length} payment(s)</span>
          </div>

          <div class="borrower-actions">
            <button class="small-btn" data-profile="${l.id}">View profile</button>
            ${c.balance > 0.005
              ? `<button class="small-btn pay" data-pay="${l.id}">＋ Payment</button>`
              : "<button class='small-btn' disabled>Completed</button>"}
          </div>
        </article>
      `;
    }).join("")
    : `<div class="surface empty-state">No borrowers match your search. Add a borrower to get started.</div>`;
}

$("borrowerSearch").addEventListener("input", renderBorrowers);
$("borrowerFilter").addEventListener("change", renderBorrowers);

$("borrowerGrid").addEventListener("click", e => {
  const p = e.target.closest("[data-profile]");
  const b = e.target.closest("[data-pay]");

  if (p) showProfile(p.dataset.profile);
  if (b) openPayment(b.dataset.pay);
});

/* BORROWER PROFILE */

function showProfile(id) {
  const l = loans().find(x => x.id === id);
  if (!l) return;

  const c = calc(l);

  $("profileTitle").textContent = l.name;
  $("profileSubtitle").textContent =
    (l.phone || "No contact") + " · Added " + dateLabel(l.startDate);

  $("profileBody").innerHTML = `
    <div class="borrower-numbers">
      <div><span>Principal</span><b>${money(l.principal)}</b></div>
      <div><span>Interest</span><b>${money(c.interest)}</b></div>
      <div><span>Total due</span><b>${money(c.total)}</b></div>
      <div><span>Outstanding</span><b>${money(c.balance)}</b></div>
    </div>

    <p class="muted">
      Agreed rate: <b>${l.rate}% per month</b> · Duration: <b>${l.months} months</b><br>
      Due date: <b>${dateLabel(l.dueDate)}</b><br>
      Notes: ${safe(l.notes || "—")}
    </p>

    <h3 style="font:700 13px Manrope;margin:18px 0 8px">Repayment history</h3>

    ${l.payments.length
      ? l.payments.map(p => `
        <div class="payment-row">
          <span class="payment-symbol">↓</span>
          <div class="payment-main">
            <b>${dateLabel(p.date)}</b>
            <small>${safe(p.note || "Repayment")}</small>
          </div>
          <span class="payment-value">${money(p.amount)}</span>
        </div>
      `).join("")
      : `<p class="empty-state">No payments recorded yet.</p>`}

    <div class="modal-actions">
      <button class="btn danger" id="deleteBorrower">Delete record</button>
      ${c.balance > 0.005
        ? `<button class="btn primary" id="profilePay">＋ Record payment</button>`
        : ""}
    </div>
  `;

  openModal("profileModal");

  $("deleteBorrower").addEventListener("click", () => {
    if (confirm("Delete this borrower and all associated payment history?")) {
      addInAppNotification(
        "Borrower deleted",
        `${l.name} and its lending record were deleted.`,
        "activity"
      );

      userData().loans = userData().loans.filter(x => x.id !== id);
      writeDB();
      $("profileModal").close();
      renderAll();
      showToast("Borrower record deleted.");
    }
  });

  $("profilePay")?.addEventListener("click", () => {
    $("profileModal").close();
    openPayment(id);
  });
}

/* RECORD PAYMENT */

function openPayment(id) {
  const l = loans().find(x => x.id === id);
  if (!l) return;

  const c = calc(l);

  $("paymentForm").reset();
  $("paymentLoanId").value = id;
  $("paymentDate").value = today();
  $("paymentAmount").max = c.balance;
  $("paymentContext").textContent = `${l.name} · ${money(c.balance)} outstanding`;

  openModal("paymentModal");
}

$("paymentForm").addEventListener("submit", e => {
  e.preventDefault();

  const l = loans().find(x => x.id === $("paymentLoanId").value);
  if (!l) return;

  const amount = Number($("paymentAmount").value);
  const date = $("paymentDate").value;

  if (!(amount > 0) || amount > calc(l).balance + 0.005) {
    showToast("Payment must be within the outstanding balance.");
    return;
  }

  if (!date) {
    showToast("Choose the payment date.");
    return;
  }

  l.payments.push({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
    amount,
    date,
    note: $("paymentNote").value.trim()
  });

  addInAppNotification(
    "Payment received",
    `${money(amount)} received from ${l.name} on ${dateLabel(date)}.`,
    "payment"
  );

  if (calc(l).balance < 0.005) {
    addInAppNotification(
      "Loan fully repaid",
      `${l.name} has completed the repayment.`,
      "activity"
    );
  }

  writeDB();
  $("paymentModal").close();
  renderAll();
  showToast("Repayment saved successfully.");
});

/* PAYMENT HISTORY */

function allPayments() {
  return loans()
    .flatMap(l => l.payments.map(p => ({ ...p, borrower: l.name, loanId: l.id })))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function paymentRow(p) {
  return `
    <div class="payment-row">
      <span class="payment-symbol">↓</span>
      <div class="payment-main">
        <b>${safe(p.borrower)}</b>
        <small>${dateLabel(p.date)} · ${safe(p.note || "Repayment")}</small>
      </div>
      <span class="payment-value">+ ${money(p.amount)}</span>
    </div>
  `;
}

function renderRecent() {
  $("recentPayments").innerHTML =
    allPayments().slice(0, 5).map(paymentRow).join("") ||
    `<div class="empty-state">No repayments recorded yet.</div>`;
}

function renderHistory() {
  const q = $("historySearch").value.toLowerCase();

  const ps = allPayments().filter(p =>
    (p.borrower + " " + p.note).toLowerCase().includes(q)
  );

  $("historyCount").textContent = `${ps.length} transaction(s)`;

  $("historyTable").innerHTML = ps.length
    ? ps.map(p => `
      <tr>
        <td><b>${safe(p.borrower)}</b></td>
        <td>${dateLabel(p.date)}</td>
        <td>${safe(p.note || "Repayment")}</td>
        <td class="amount-green">+ ${money(p.amount)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="empty-state">No matching payment records.</td></tr>`;
}

$("historySearch").addEventListener("input", renderHistory);

/* UPCOMING REPAYMENTS */

function upcomingLoans() {
  return loans()
    .filter(l => calc(l).balance > 0.005)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function dueItem(l) {
  const c = calc(l);

  return `
    <div class="upcoming-item">
      <div class="date-block">
        <b>${new Date(l.dueDate + "T12:00:00").getDate()}</b>
        <small>${new Date(l.dueDate + "T12:00:00").toLocaleDateString("en-IN", { month: "short" })}</small>
      </div>
      <div class="upcoming-info">
        <b>${safe(l.name)}</b>
        <small>${l.dueDate < today() ? "Overdue" : "Due"} · ${dateLabel(l.dueDate)}</small>
      </div>
      <div class="upcoming-amount">
        ${money(c.balance)}
        <small>remaining</small>
      </div>
    </div>
  `;
}

function renderUpcoming() {
  const items = upcomingLoans().slice(0, 5);

  $("upcomingList").innerHTML =
    items.map(dueItem).join("") ||
    `<div class="empty-state">You’re all caught up. No pending repayments.</div>`;
}

/* CASH FLOW CHART */

function drawChart() {
  const canvas = $("cashChart");
  if (!canvas || !canvas.getContext) return;

  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return;

  const dpr = window.devicePixelRatio || 1;

  canvas.width = rect.width * dpr;
  canvas.height = 235 * dpr;

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const w = rect.width;
  const h = 235;
  const pad = { l: 48, r: 12, t: 14, b: 34 };
  const chartW = w - pad.l - pad.r;
  const chartH = h - pad.t - pad.b;

  const months = [];
  const now = new Date();

  for (let i = 5; i >= 0; i--) {
    months.push(new Date(now.getFullYear(), now.getMonth() - i, 1));
  }

  const data = months.map(d => {
    let key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    let lent = 0;
    let received = 0;

    loans().forEach(l => {
      if (l.startDate.startsWith(key)) lent += l.principal;

      l.payments.forEach(p => {
        if (p.date.startsWith(key)) received += p.amount;
      });
    });

    return {
      lent,
      received,
      label: d.toLocaleDateString("en-IN", { month: "short" })
    };
  });

  const max = Math.max(100, ...data.flatMap(x => [x.lent, x.received])) * 1.2;

  ctx.font = "10px DM Sans";
  ctx.textAlign = "right";

  for (let i = 0; i < 4; i++) {
    let y = pad.t + chartH * i / 3;

    ctx.strokeStyle = "#edf1ee";
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();

    ctx.fillStyle = "#9aa69f";

    let v = max * (1 - i / 3);

    ctx.fillText(
      v >= 1000 ? "₹" + (v / 1000).toFixed(0) + "k" : "₹" + Math.round(v),
      pad.l - 9,
      y + 3
    );
  }

  const group = chartW / 6;
  const bw = Math.min(17, group * 0.25);

  data.forEach((x, i) => {
    let center = pad.l + group * (i + 0.5);
    let a = x.lent / max * chartH;
    let b = x.received / max * chartH;

    ctx.fillStyle = "#197653";
    ctx.beginPath();
    ctx.roundRect(center - bw - 2, pad.t + chartH - a, bw, a, 4);
    ctx.fill();

    ctx.fillStyle = "#b9d9c6";
    ctx.beginPath();
    ctx.roundRect(center + 2, pad.t + chartH - b, bw, b, 4);
    ctx.fill();

    ctx.fillStyle = "#89968e";
    ctx.textAlign = "center";
    ctx.fillText(x.label, center, pad.t + chartH + 22);
  });
}

/* REPAYMENT CALENDAR WITH BORROWER DETAILS */

function renderCalendar() {
  const y = calendarCursor.getFullYear();
  const m = calendarCursor.getMonth();

  $("calendarMonth").textContent = calendarCursor.toLocaleDateString(
    "en-IN",
    { month: "long", year: "numeric" }
  );

  const first = new Date(y, m, 1);
  const start = (first.getDay() + 6) % 7;
  const days = new Date(y, m + 1, 0).getDate();
  const prevDays = new Date(y, m, 0).getDate();

  let html = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    .map(x => `<div class="calendar-weekday">${x}</div>`)
    .join("");

  for (let i = 0; i < 42; i++) {
    let d;
    let month = m;
    let year = y;
    let muted = false;

    if (i < start) {
      d = prevDays - start + i + 1;
      month = m - 1;
      muted = true;

    } else if (i >= start + days) {
      d = i - start - days + 1;
      month = m + 1;
      muted = true;

    } else {
      d = i - start + 1;
    }

    if (month < 0) {
      month = 11;
      year--;
    }

    if (month > 11) {
      month = 0;
      year++;
    }

    const key = isoDate(new Date(year, month, d));
    const matched = loans().filter(l => l.dueDate === key);
    const selected = key === selectedCalendarDate;
    const isToday = key === today();

    const details = matched.map(l => {
      const c = calc(l);
      const st = status(l);

      const statusText = st === "paid"
        ? "Repaid"
        : st === "overdue"
          ? "Overdue"
          : "Active";

      return `
        <span class="calendar-borrower ${st}">
          <b>${safe(l.name)}</b>
          <small>${money(c.balance)} · ${statusText}</small>
        </span>
      `;
    }).join("");

    html += `
      <button class="calendar-day ${muted ? "muted-day" : ""} ${selected ? "selected" : ""} ${isToday ? "today" : ""}"
        data-date="${key}">
        <span class="day-number">${d}</span>
        ${details}
      </button>
    `;
  }

  $("calendarGrid").innerHTML = html;
  renderSelectedDate();
}

$("calendarGrid").addEventListener("click", e => {
  const b = e.target.closest("[data-date]");

  if (b) {
    selectedCalendarDate = b.dataset.date;
    renderCalendar();
  }
});

function renderSelectedDate() {
  const ds = loans().filter(l => l.dueDate === selectedCalendarDate);

  $("selectedDateTitle").textContent = dateLabel(
    selectedCalendarDate,
    { weekday: "long", day: "numeric", month: "long", year: "numeric" }
  );

  $("selectedDateLoans").innerHTML =
    ds.map(dueItem).join("") ||
    `<div class="empty-state">No loan due on this date.</div>`;
}

$("prevMonth").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() - 1);
  renderCalendar();
});

$("nextMonth").addEventListener("click", () => {
  calendarCursor.setMonth(calendarCursor.getMonth() + 1);
  renderCalendar();
});

$("calendarToday").addEventListener("click", () => {
  calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  selectedCalendarDate = today();
  renderCalendar();
});

/* NOTIFICATIONS */

function notificationItems() {
  return userData()?.notifications || [];
}

function addInAppNotification(title, message, type = "activity", key = "") {
  const items = notificationItems();

  if (key && items.some(n => n.key === key)) return;

  items.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
    title,
    message,
    type,
    key,
    createdAt: new Date().toISOString(),
    read: false
  });

  if (items.length > 500) items.length = 500;

  writeDB();
  renderNotificationBadges();

  if (currentPage === "notifications") {
    renderFullNotifications();
  }
}

function renderNotificationBadges() {
  if (!currentUser) return;

  const unread = notificationItems().filter(n => !n.read).length;

  ["notificationCount", "navNotificationCount"].forEach(id => {
    const el = $(id);

    if (el) {
      el.textContent = unread > 99 ? "99+" : String(unread);
      el.hidden = unread === 0;
    }
  });

  const dot = $("notificationDot");
  if (dot) dot.style.display = unread ? "block" : "none";
}

function timeAgo(value) {
  const d = new Date(value);
  const diff = Math.max(0, Date.now() - d.getTime());
  const mins = Math.floor(diff / 60000);

  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;

  return d.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function renderFullNotifications() {
  if (!currentUser) return;

  const items = notificationItems();
  const filter = $("notificationFilter")?.value || "all";
  const unread = items.filter(n => !n.read).length;

  $("moduleTotalCount").textContent = items.length;
  $("moduleUnreadCount").textContent = unread;
  $("moduleReadCount").textContent = items.length - unread;

  let shown = items.filter(n =>
    filter === "all" ||
    (filter === "unread" && !n.read) ||
    (filter === "read" && n.read) ||
    n.type === filter
  );

  const icons = {
    payment: "₹",
    activity: "♙",
    reminder: "◷",
    overdue: "!"
  };

  $("fullNotificationList").innerHTML = shown.length
    ? shown.map(n => `
      <article class="full-notification-item ${n.read ? "" : "unread"}"
        data-notification-id="${safe(n.id)}" tabindex="0">

        <span class="full-notification-icon">${icons[n.type] || "♧"}</span>

        <div class="full-notification-content">
          <h4>${safe(n.title)}</h4>
          <p>${safe(n.message)}</p>
          <small>${timeAgo(n.createdAt)}</small>
        </div>

        <span class="${n.read ? "notification-read-label" : "notification-unread-label"}">
          ${n.read ? "Read" : "Unread"}
        </span>
      </article>
    `).join("")
    : `
      <div class="notification-empty-large">
        <div class="empty-icon">♧</div>
        <h3>No notifications here</h3>
        <p>Updates and repayment reminders will appear here.</p>
      </div>
    `;
}

function markNotificationRead(id) {
  const n = notificationItems().find(x => x.id === id);

  if (n && !n.read) {
    n.read = true;
    writeDB();
    renderNotificationBadges();
    renderFullNotifications();
  }
}

$("notificationFilter").addEventListener("change", renderFullNotifications);

$("fullNotificationList").addEventListener("click", e => {
  const item = e.target.closest("[data-notification-id]");
  if (item) markNotificationRead(item.dataset.notificationId);
});

$("fullNotificationList").addEventListener("keydown", e => {
  if (
    (e.key === "Enter" || e.key === " ") &&
    e.target.matches("[data-notification-id]")
  ) {
    e.preventDefault();
    markNotificationRead(e.target.dataset.notificationId);
  }
});

$("markAllNotificationsRead").addEventListener("click", () => {
  notificationItems().forEach(n => n.read = true);

  writeDB();
  renderNotificationBadges();
  renderFullNotifications();
  showToast("All notifications marked as read.");
});

$("notificationBtn").addEventListener("click", () =>
  goPage("notifications")
);

/* REPAYMENT REMINDERS */

function checkDueNotifications() {
  if (!currentUser) return;

  const now = today();

  loans()
    .filter(l => calc(l).balance > 0.005)
    .forEach(l => {
      const diff = Math.round(
        (new Date(l.dueDate + "T12:00:00") -
          new Date(now + "T12:00:00")) / 86400000
      );

      if (diff === 2) {
        addInAppNotification(
          "Repayment due in 2 days",
          `${l.name}: ${money(calc(l).balance)} is expected on ${dateLabel(l.dueDate)}.`,
          "reminder",
          `${l.id}_due2_${now}`
        );

      } else if (diff === 0) {
        addInAppNotification(
          "Repayment due today",
          `${l.name}: ${money(calc(l).balance)} is due today.`,
          "reminder",
          `${l.id}_due0_${now}`
        );

      } else if (diff < 0) {
        addInAppNotification(
          "Overdue repayment",
          `${l.name}: ${money(calc(l).balance)} is overdue since ${dateLabel(l.dueDate)}.`,
          "overdue",
          `${l.id}_overdue_${now}`
        );
      }
    });

  if ("Notification" in window && Notification.permission === "granted") {
    const latest = notificationItems().find(n =>
      !n.read && ["reminder", "overdue"].includes(n.type)
    );

    if (latest && !sessionStorage.getItem("ll_desktop_" + latest.id)) {
      new Notification("LendLedger · " + latest.title, {
        body: latest.message
      });

      sessionStorage.setItem("ll_desktop_" + latest.id, "1");
    }
  }
}

async function enableNotifications() {
  if (!("Notification" in window)) {
    showToast("This browser does not support notifications.");
    return;
  }

  const p = await Notification.requestPermission();

  if (p === "granted") {
    showToast("Browser notifications enabled.");
    $("notificationDot").style.display = "none";
    checkDueNotifications();
  } else {
    showToast("Notification permission was not granted.");
  }
}

$("settingsNotify").addEventListener("click", enableNotifications);

/* CSV EXPORT
   Available only through Account Settings.
   No Export CSV button or event listener in Payment History.
*/

function exportCSV() {
  const rows = [[
    "Borrower",
    "Phone",
    "Principal",
    "Monthly interest %",
    "Duration months",
    "Interest",
    "Total due",
    "Start date",
    "Due date",
    "Received",
    "Balance",
    "Status",
    "Payment date",
    "Payment amount",
    "Payment note"
  ]];

  loans().forEach(l => {
    const c = calc(l);

    if (l.payments.length) {
      l.payments.forEach(p => rows.push([
        l.name,
        l.phone,
        l.principal,
        l.rate,
        l.months,
        c.interest,
        c.total,
        l.startDate,
        l.dueDate,
        c.received,
        c.balance,
        status(l),
        p.date,
        p.amount,
        p.note
      ]));

    } else {
      rows.push([
        l.name,
        l.phone,
        l.principal,
        l.rate,
        l.months,
        c.interest,
        c.total,
        l.startDate,
        l.dueDate,
        c.received,
        c.balance,
        status(l),
        "",
        "",
        ""
      ]);
    }
  });

  const csv = rows
    .map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\r\n");

  const blob = new Blob(["\uFEFF" + csv], {
    type: "text/csv;charset=utf-8"
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");

  a.href = url;
  a.download = "LendLedger-records.csv";
  a.click();

  URL.revokeObjectURL(url);
  showToast("CSV export downloaded.");
}

/* EXPORT CSV ONLY FROM SETTINGS */

$("settingsExport").addEventListener("click", exportCSV);

/* ACCOUNT SETTINGS */

$("settingsBtn").addEventListener("click", () =>
  openModal("settingsModal")
);

$("clearData").addEventListener("click", () => {
  if (confirm("Permanently delete every lending record for this account?")) {
    userData().loans = [];
    writeDB();
    renderAll();
    $("settingsModal").close();
    showToast("All lending records deleted.");
  }
});

/* WINDOW EVENTS */

window.addEventListener("resize", () => {
  if (currentPage === "overview") drawChart();
});

setInterval(() => {
  if (currentUser) checkDueNotifications();
}, 60 * 60 * 1000);