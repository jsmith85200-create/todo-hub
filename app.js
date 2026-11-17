"use strict";
/* Jodi's To-Do Hub — three job dashboards (TPAM, Vicki's office, Absolute) plus Home and Personal.
   Works offline: everything is saved on this device first, then synced to Jodi's Google Sheet
   through her Apps Script web app. Months are kept forever; each new month starts fresh. */

const APP_VERSION = "2.2.2";
const KINDS = ["items", "time", "rotation", "notes", "settings", "assoc", "tpam", "vclients", "vwork", "aclients", "awork", "social"];
const BOOL = new Set(["done", "star", "void", "manual", "inactive"]);
const NUM = new Set(["stage", "order", "step", "priority", "dueDay", "fee", "camDays"]);

const TABS = [["home", "Home"], ["tpam", "TPAM"], ["vicki", "Vicki's"], ["absolute", "Absolute"], ["personal", "Personal"]];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* ---- TPAM ---- */
const T_STEPS = ["Not started", "In progress", "To CAM", "Corrections", "To CAM again", "To board"];
const T_CLS = ["s0", "s1", "s2", "s3", "s2", "s5"];
const ROTATION = { 1: [["HCAI", "Hillwood"], ["BPC", "Brighton Place"]], 2: [["MOA", "Marisol"], ["PBH", "Palm Bay"]], 3: [["PTCA", "Palmetto Trace"], ["PWCA", "Palms West"]], 4: [["SGI", "Sawgrass Island"], ["RVE", "Rivers Edge"]] };

/* ---- Vicki's ---- */
const V_SVCS = [["books", "Bookkeeping"], ["stax", "Sales tax"], ["ptax", "Payroll tax"], ["pdep", "Payroll deposits"]];
const V_STEPS = [["", "Not started", "s0"], ["progress", "In progress", "s1"], ["docs", "Waiting on docs", "s2"], ["review", "Waiting on review", "s4"]];
const V_SOFT = [["qbo", "QuickBooks Online"], ["desktop", "QuickBooks Desktop"], ["", "Other / not set"]];
const PRIORITY = [[1, "High"], [2, "Normal"], [3, "Low"]];

/* ---- Absolute ---- */
const A_BOOKS = ["Not started", "Reconciled", "Financials sent"];
const A_VA = ["Not started", "Reached out", "Job received", "Job done", "Invoiced"];
const SOCIAL = [["idea", "Idea"], ["drafted", "Drafted"], ["scheduled", "Scheduled"], ["posted", "Posted"]];
const CRM_GAP = { "Met in Person": 3, "Cold Emailed / Outreach": 4, "Currently Working With": 14, "Past Client - Inactive": 90 };

/* ---- To-do lists ---- */
const LISTS = [
  { key: "tpam", name: "TPAM", sections: [["follow", "Follow-ups"], ["other", "Other TPAM"]] },
  { key: "vicki", name: "Vicki's Office", sections: [["office", "Office to-dos"]] },
  { key: "life", name: "Absolute & Life", sections: [["absolute", "Absolute to-dos"], ["money", "Money"], ["errands", "Health, calls & errands"], ["jobs", "Job search"], ["home", "Home"], ["grocery", "Grocery list"]] }
];

/* ================= storage + sync ================= */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } }
};
const DB = {}; for (const k of KINDS) DB[k] = new Map();
let SERVER = { crm: [], wl: [], crmError: "", wlError: "" };
let queue = {};
let config = LS.get("hub:config", null);
let lastSync = LS.get("hub:lastSync", "");
const syncState = { busy: false, error: "", timer: 0 };

function norm(rec) {
  const o = { ...rec };
  for (const k of Object.keys(o)) {
    if (BOOL.has(k)) o[k] = o[k] === true || o[k] === "true" || o[k] === "TRUE";
    else if (NUM.has(k)) o[k] = o[k] === "" || o[k] == null ? 0 : Number(o[k]) || 0;
    else if (o[k] == null) o[k] = "";
    else o[k] = String(o[k]);
  }
  return o;
}
function loadLocal() {
  const data = LS.get("hub:data", {});
  for (const k of KINDS) DB[k] = new Map((data[k] || []).map(r => [r.id, norm(r)]));
  SERVER = LS.get("hub:server", SERVER);
  queue = LS.get("hub:queue", {});
}
function saveLocal() {
  const data = {}; for (const k of KINDS) data[k] = [...DB[k].values()];
  const ok = LS.set("hub:data", data) && LS.set("hub:queue", queue) && LS.set("hub:server", SERVER);
  if (!ok) setStatus("This device is out of storage space. Your changes may not be kept.");
}
const nowIso = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const live = kind => [...DB[kind].values()].filter(r => !r.void);

function put(kind, rec) {
  const r = norm({ ...rec, updatedAt: nowIso() });
  DB[kind].set(r.id, r);
  queue[kind + ":" + r.id] = { kind, rec: r };
  saveLocal(); scheduleSync(1500);
  return r;
}
function crmPut(row, fields) {
  Object.assign(row, fields);
  const key = "crm:" + row.row + ":" + row.company;
  queue[key] = { kind: "crm", rec: { id: key, row: row.row, contact: row.contact, company: row.company, last: row.last, next: row.next, status: row.status } };
  saveLocal(); scheduleSync(1500);
}
function scheduleSync(ms) { clearTimeout(syncState.timer); syncState.timer = setTimeout(sync, ms); }

async function sync() {
  renderSync();
  if (!config || !config.url || syncState.busy || !navigator.onLine) { renderSync(); return; }
  syncState.busy = true; renderSync();
  try {
    const pending = Object.entries(queue);
    if (pending.length) {
      const res = await fetchJson(config.url, { method: "POST", body: JSON.stringify({ token: config.token, changes: pending.map(([, v]) => v) }) });
      if (!res.ok) throw new Error(res.error || "save_failed");
      for (const [key, v] of pending) if (queue[key] && queue[key].rec.updatedAt === v.rec.updatedAt) delete queue[key];
    }
    const got = await fetchJson(config.url + (config.url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(config.token) + "&t=" + Date.now());
    if (!got.ok) throw new Error(got.error || "load_failed");
    for (const k of KINDS) {
      for (const raw of (got.data[k] || [])) {
        if (!raw.id) continue;
        const remote = norm(raw), local = DB[k].get(remote.id);
        if (queue[k + ":" + remote.id]) continue;
        if (!local || (remote.updatedAt || "") >= (local.updatedAt || "")) DB[k].set(remote.id, remote);
      }
    }
    SERVER = { crm: got.crm || [], wl: got.wl || [], crmError: got.crmError || "", wlError: got.wlError || "" };
    for (const v of Object.values(queue)) if (v.kind === "crm") { const r = SERVER.crm.find(x => x.row == v.rec.row); if (r) Object.assign(r, { last: v.rec.last, next: v.rec.next, status: v.rec.status }); }
    lastSync = nowIso(); LS.set("hub:lastSync", lastSync);
    syncState.error = ""; saveLocal();
  } catch (e) {
    syncState.error = String(e && e.message || e);
  } finally {
    syncState.busy = false; render(); renderSync(); notifyIfNew();
  }
}
async function fetchJson(url, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctl.signal, redirect: "follow" });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (_) { throw new Error(r.ok ? "not_json" : "http_" + r.status); }
  } finally { clearTimeout(t); }
}
function syncText() {
  const n = Object.keys(queue).length, ch = n + " change" + (n === 1 ? "" : "s");
  if (!config) return { cls: "wait", text: "Not syncing yet. Saved on this device only." };
  if (syncState.busy) return { cls: "", text: "Syncing…" };
  if (!navigator.onLine) return { cls: "wait", text: "Offline." + (n ? " " + ch + " will sync later." : " Everything is saved here.") };
  if (syncState.error) return { cls: "err", text: (syncState.error === "bad_token" ? "The sync code doesn't match the Sheet." : "Couldn't reach your Google Sheet.") + (n ? " " + ch + " waiting." : "") };
  if (n) return { cls: "wait", text: ch + " waiting to sync" };
  return { cls: "", text: lastSync ? "Synced " + fmtTime(new Date(lastSync)) : "Not synced yet" };
}
function renderSync() { const s = syncText(), n = $("#sync"); if (n) { n.textContent = s.text; n.className = "sync " + s.cls; } }

/* ================= helpers ================= */
const S = { qa: null, tab: "home", edit: new Set(), open: new Set(), showDone: new Set(), m: {}, vsvc: "books", timeOpen: false, confirm: "", dirty: false, crmFilter: "due" };
const $ = s => document.querySelector(s);
const timers = new Map();
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids) if (c != null && c !== false) n.append(c);
  return n;
}
function setStatus(t) { $("#status").textContent = t; }
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const ym = d => d.getFullYear() + "-" + pad(d.getMonth() + 1);
function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d || 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addM(p, n) { const [y, m] = p.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return ym(d); }
const thisMonth = () => ym(new Date());
const prevMonth = () => addM(thisMonth(), -1);
const shortDate = d => (d.getMonth() + 1) + "/" + d.getDate();
const fmtTime = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const mLabel = p => { if (!p) return ""; const [y, m] = p.split("-").map(Number); return MONTHS[m - 1] + " " + y; };
const mShort = p => { const [y, m] = p.split("-").map(Number); return MONTHS[m - 1].slice(0, 3) + (y !== new Date().getFullYear() ? " '" + String(y).slice(2) : ""); };
const todayStr = () => ymd(new Date());
const fmtDay = s => { if (!s) return ""; const d = parseYmd(s); return DAYS[d.getDay()].slice(0, 3) + " " + shortDate(d); };
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
function dueInfo(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const today = parseYmd(todayStr()), d = parseYmd(s), diff = Math.round((d - today) / 864e5);
  if (diff < 0) return { cls: "over", label: "Overdue · " + shortDate(d), diff };
  if (diff === 0) return { cls: "today", label: "Due today", diff };
  if (diff === 1) return { cls: "today", label: "Due tomorrow", diff };
  return { cls: "", label: "Due " + fmtDay(s), diff };
}
const monthOf = key => S.m[key] || prevMonth();
const setting = (id, d) => { const r = DB.settings.get(id); return r ? r.value : d; };

/* ================= render shell ================= */
function renderTabs() {
  const nav = $("#tabs"); nav.replaceChildren();
  const counts = { home: alerts().length + " alerts", tpam: tpamStats(monthOf("tpam")).pct + "% · " + mShort(monthOf("tpam")), vicki: vickiStats(monthOf("vicki")).pct + "% · " + mShort(monthOf("vicki")), absolute: absStats(monthOf("absolute")).pct + "% · " + mShort(monthOf("absolute")), personal: itemsFor("life").filter(i => !i.done && i.section !== "absolute").length + " to do" };
  for (const [k, name] of TABS) nav.append(el("button", { type: "button", "aria-current": S.tab === k ? "page" : null, onclick: () => go(k) }, name, el("span", { class: "ct", text: counts[k] })));
}
function go(k) { S.tab = k; S.confirm = ""; try { history.replaceState(null, "", "#" + k); } catch (_) { location.hash = k; } render(true); window.scrollTo(0, 0); }
function render(force) {
  const ae = document.activeElement;
  if (!force && ae && (ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || (ae.tagName === "INPUT" && !["checkbox", "button"].includes(ae.type)))) { S.dirty = true; return; }
  S.dirty = false;
  renderTabs();
  const main = $("#main"); main.replaceChildren();
  const qp = quickAddPanel(); if (qp) main.append(qp);
  ({ home: renderHome, tpam: renderTpam, vicki: renderVicki, absolute: renderAbsolute, personal: renderPersonal, settings: renderSettings }[S.tab] || renderHome)(main);
  renderSync();
}
function monthPicker(key, label) {
  const m = monthOf(key);
  const isDefault = m === prevMonth();
  return el("div", { class: "mpick" },
    el("button", { type: "button", class: "mbtn", "aria-label": "Previous month", onclick: () => { S.m[key] = addM(m, -1); render(true); } }, "‹"),
    el("div", { class: "mlabel" }, el("b", { text: mLabel(m) }), el("span", { text: label + (isDefault ? "" : " · ") }), isDefault ? null : el("button", { type: "button", class: "link", text: "Back to " + mShort(prevMonth()), onclick: () => { delete S.m[key]; render(true); } })),
    el("button", { type: "button", class: "mbtn", "aria-label": "Next month", disabled: m >= thisMonth(), onclick: () => { S.m[key] = addM(m, 1); render(true); } }, "›"));
}
function bigPct(p, sub, extra) {
  return el("div", { class: "bigpct" },
    el("div", { class: "ring", style: "--p:" + p }, el("b", { text: p + "%" })),
    el("div", { class: "bp-r" }, el("div", { class: "bp-sub", text: sub }), extra || null));
}
function card(title, small, ...kids) {
  const id = "h-" + Math.random().toString(36).slice(2, 7);
  return el("section", { class: "card", "aria-labelledby": id }, el("h2", { id }, el("span", { text: title }), small ? el("small", { text: small }) : null), ...kids);
}
function stepChip(label, cls) { return el("span", { class: "chip step " + cls, text: label }); }
function blockerLine(text) { return text ? el("div", { class: "blocker", text: "Blocker: " + text }) : null; }
function field(label, input) { return el("div", { class: "field" }, el("label", { for: input.id, text: label }), input); }
function textInput(id, value, onSave, ph) {
  const i = el("input", { type: "text", id, placeholder: ph || "", maxlength: 300 }); i.value = value || "";
  i.addEventListener("input", () => saveLater(id, () => onSave(i.value)));
  i.addEventListener("blur", () => flush(id, () => onSave(i.value)));
  return i;
}

/* ================= HOME ================= */
function alerts() {
  const out = [], today = new Date(), dom = today.getDate(), tm = thisMonth(), pm = prevMonth(), dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  for (const c of live("aclients")) {
    if (c.type === "books") {
      const cur = DB.awork.get(c.id + "-" + tm);
      if (!(cur && cur.invoiced)) out.push({ job: "absolute", cls: "over", text: "Invoice " + c.name + " for " + mLabel(tm) + (c.fee ? " ($" + c.fee + ")" : ""), act: () => { put("awork", { ...(cur || { id: c.id + "-" + tm, client: c.id, period: tm, step: 0 }), invoiced: todayStr() }); render(true); }, actLabel: "Mark invoiced" });
      const wd = today.getDay() >= 1 && today.getDay() <= 5;
      if (wd && c.lastClassified !== todayStr()) out.push({ job: "absolute", cls: "today", text: "Classify today's transactions: " + c.name, act: () => { put("aclients", { ...c, lastClassified: todayStr() }); render(true); }, actLabel: "Done today" });
    } else {
      const w = DB.awork.get(c.id + "-" + pm), wc = DB.awork.get(c.id + "-" + tm);
      if (dom >= dim - 2 && !(wc && wc.step >= 1)) out.push({ job: "absolute", cls: "today", text: "Reach out to " + c.name + " for " + mLabel(tm) + "'s job", go: "absolute" });
      if (w && w.step === 3) out.push({ job: "absolute", cls: "over", text: "Invoice " + c.name + " for " + mLabel(pm), go: "absolute" });
      if (!w || w.step < 1) out.push({ job: "absolute", cls: "over", text: "Reach out to " + c.name + " for " + mLabel(pm) + "'s job", go: "absolute" });
    }
  }
  for (const a of assocs()) {
    const r = tpamRec(pm, a.code), dl = tpamDeadline(pm, a, r); if (!dl) continue;
    const d = r.step <= 1 ? toCamBy(pm, a) : tpamDue(pm), di = dueInfo(d);
    if (r.step === 3 || (di && di.diff <= 2)) out.push({ job: "tpam", cls: dl.cls || "today", text: a.code + ": " + dl.label, go: "tpam" });
  }
  for (const c of live("aclients")) {
    const months = absOpenMonths(c), cur = months[months.length - 1];
    if (cur) { const di = dueInfo(absDue(c, cur)); if (di && di.diff <= 3) out.push({ job: "absolute", cls: di.cls || "today", text: c.name + " " + mLabel(cur) + ": " + di.label.toLowerCase(), go: "absolute" }); }
  }
  for (const c of aAll()) if (!c.inactive && c.type === "weekly" && c.nextDate && c.nextDate <= todayStr()) out.push({ job: "absolute", cls: c.nextDate < todayStr() ? "over" : "today", text: "Meeting with " + c.name + (c.nextDate < todayStr() ? " was " + fmtDay(c.nextDate) + ". Set the next one." : " today"), go: "absolute" });
  for (const p of live("social")) if (p.status !== "posted" && p.date && p.date <= todayStr()) out.push({ job: "absolute", cls: p.date < todayStr() ? "over" : "today", text: "Post: " + p.title, go: "absolute" });
  return out;
}
function allBlockers() {
  const out = [], pm = monthOf("tpam");
  for (const a of assocs()) { const r = tpamRec(pm, a.code); if (r.blocker && r.step < 5) out.push(["TPAM", a.code + " · " + r.blocker]); }
  for (const w of live("vwork")) if (w.blocker && !(w.cthru && w.cthru >= monthOf("vicki"))) { const c = DB.vclients.get(w.client); out.push(["Vicki's", (c ? c.name : w.client) + " (" + svcName(w.svc) + ") · " + w.blocker]); }
  for (const c of live("aclients")) { if (c.blocker) out.push(["Absolute", c.name + " · " + c.blocker]); for (const p of absOpenMonths(c)) { const w = DB.awork.get(c.id + "-" + p); if (w && w.blocker) out.push(["Absolute", c.name + " " + mShort(p) + " · " + w.blocker]); } }
  return out;
}
function renderHome(main) {
  const d = new Date();
  main.append(el("div", { class: "dayline", text: DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() }));
  if (!config) main.append(el("div", { class: "card" }, el("div", { class: "hint", text: "This app saves on this device. Connect it to your Google Sheet so your phone and computer stay in sync." }),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Connect my Google Sheet", onclick: () => go("settings") }))));
  const t = tpamStats(monthOf("tpam")), v = vickiStats(monthOf("vicki")), a = absStats(monthOf("absolute"));
  main.append(el("div", { class: "jobs" },
    jobTile("tpam", "TPAM", t.pct, t.board + " of " + t.n + " to board · " + mShort(monthOf("tpam")), t.blockers),
    jobTile("vicki", "Vicki's", v.pct, v.done + " of " + v.total + " done · " + mShort(monthOf("vicki")), v.blockers),
    jobTile("absolute", "Absolute", a.pct, a.done + " of " + a.total + " clients · " + mShort(monthOf("absolute")), a.blockers)));
  const al = alerts();
  const ul = el("ul", { class: "alerts" });
  for (const x of al) ul.append(el("li", { class: "alert " + x.cls }, el("span", { class: "a-job", text: { tpam: "TPAM", vicki: "Vicki's", absolute: "Absolute" }[x.job] }), el("span", { class: "a-text", text: x.text }),
    x.act ? el("button", { type: "button", class: "btn small", text: x.actLabel, onclick: x.act }) : el("button", { type: "button", class: "link", text: "Open", onclick: () => go(x.go) })));
  if (!al.length) ul.append(el("li", { class: "empty", text: "Nothing needs your attention right now." }));
  main.append(card("Needs attention", al.length ? String(al.length) : "", ul, notifyButton()));
  main.append(crmTodayCard());
  const bl = allBlockers();
  if (bl.length) {
    const det = el("details", { class: "card" }, el("summary", { text: "Blockers (" + bl.length + "): " + ["TPAM", "Vicki's", "Absolute"].map(j => j + " " + bl.filter(x => x[0] === j).length).join(" · ") }));
    const ub = el("ul", { class: "blist" }); for (const [j, t2] of bl) ub.append(el("li", {}, el("b", { text: j + ": " }), t2)); det.append(ub); main.append(det);
  }
  main.append(listCard("Do first", allItems().filter(i => !i.done && i.star).sort(sortItems), "Tap \"☆ Do first\" on any to-do to put it here."));
  const ds = allItems().filter(i => !i.done && !i.star && dueInfo(i.due) && dueInfo(i.due).diff <= 3).sort((x, y) => x.due < y.due ? -1 : 1);
  if (ds.length) main.append(listCard("Due in the next 3 days", ds, ""));
  main.append(clockCard());
}
function jobTile(tab, name, p, sub, blockers) {
  return el("button", { type: "button", class: "jobtile", onclick: () => go(tab) },
    el("div", { class: "ring sm", style: "--p:" + p }, el("b", { text: p + "%" })),
    el("div", {}, el("div", { class: "jt-n", text: name }), el("div", { class: "jt-s", text: sub }), blockers ? el("div", { class: "jt-b", text: blockers + " blocker" + (blockers > 1 ? "s" : "") }) : null));
}
function notifyButton() {
  if (!("Notification" in window)) return null;
  if (Notification.permission === "granted") return el("div", { class: "hint small", text: "Phone/computer notifications are on. They show when the app opens and finds something new." });
  return el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn ghost", text: "Turn on notifications", onclick: async () => { try { await Notification.requestPermission(); } catch (_) {} render(true); notifyIfNew(true); } }));
}
async function notifyIfNew(force) {
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const al = alerts().filter(a => a.cls === "over" || /Invoice|Reach out/.test(a.text));
    const fu = crmToday().length; if (fu) al.unshift({ text: fu + " follow-up" + (fu > 1 ? "s" : "") + " to send today" });
    const key = todayStr() + ":" + al.map(a => a.text).join("|");
    if (!al.length || (!force && LS.get("hub:notified", "") === key)) return;
    LS.set("hub:notified", key);
    const body = al.slice(0, 4).map(a => a.text).join("\n");
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) reg.showNotification("To-Do Hub", { body, icon: "icons/icon-192.png", tag: "hub-daily" }); else new Notification("To-Do Hub", { body });
  } catch (_) {}
}

/* ================= TPAM ================= */
const assocs = () => live("assoc").sort((a, b) => (a.order - b.order) || a.code.localeCompare(b.code));
function tpamRec(p, code) { return DB.tpam.get(p + "-" + code) || { id: p + "-" + code, period: p, code, step: 0, blocker: "", note: "" }; }
function tpamDue(p) { return setting("tpamdue-" + p, ymd(new Date(Number(p.slice(0, 4)), Number(p.slice(5)), 15))); }
function bizBack(dateStr, n) { const d = parseYmd(dateStr); let k = 0; while (k < n) { d.setDate(d.getDate() - 1); if (d.getDay() !== 0 && d.getDay() !== 6) k++; } return ymd(d); }
const camDays = a => a.camDays || 2;
function toCamBy(p, a) { return bizBack(tpamDue(p), camDays(a)); }
function tpamDeadline(p, a, r) {
  if (r.step >= 5) return null;
  if (r.step <= 1) { const d = toCamBy(p, a), di = dueInfo(d); return di && { cls: di.cls, label: (di.diff < 0 ? "Late to CAM " : "To CAM by ") + shortDate(parseYmd(d)) }; }
  const di = dueInfo(tpamDue(p)); return di && { cls: r.step === 3 ? "over" : di.cls, label: (r.step === 3 ? "Fix · " : "") + "Board " + (di.diff < 0 ? "late " : "due ") + shortDate(parseYmd(tpamDue(p))) };
}
function tpamStats(p) {
  const as = assocs(), n = as.length; let sum = 0, board = 0, blockers = 0;
  for (const a of as) { const r = tpamRec(p, a.code); sum += r.step; if (r.step >= 5) board++; if (r.blocker && r.step < 5) blockers++; }
  return { n, board, blockers, pct: n ? Math.round(sum / (5 * n) * 100) : 0 };
}
function renderTpam(main) {
  const p = monthOf("tpam"), st = tpamStats(p), due = tpamDue(p), di = dueInfo(due);
  const dueIn = el("input", { type: "date", id: "tpam-due" }); dueIn.value = due;
  dueIn.addEventListener("change", () => { put("settings", { id: "tpamdue-" + p, value: dueIn.value }); render(true); });
  const counts = T_STEPS.map((s, i) => [s, assocs().filter(a => tpamRec(p, a.code).step === i).length, T_CLS[i]]).filter(x => x[1]);
  main.append(monthPicker("tpam", "financials"));
  main.append(el("section", { class: "card" },
    bigPct(st.pct, st.board + " of " + st.n + " sent to board" + (st.blockers ? " · " + st.blockers + " blocked" : ""),
      el("div", { class: "chips" }, ...counts.map(([s, n, c]) => stepChip(n + " " + s, c)))),
    el("div", { class: "duerow" }, field("Due to boards", dueIn), el("span", { class: "hint small", text: "CAMs need 2 business days (4 for the big ones) before the 15th. Corrections take longer." }), di && st.board < st.n ? el("span", { class: "chip " + di.cls, text: di.label }) : st.board === st.n && st.n ? el("span", { class: "chip step s5", text: "All sent" }) : null)));

  const grid = el("div", { class: "agrid" });
  for (const a of assocs()) {
    const r = tpamRec(p, a.code), open = S.open.has("t:" + a.code);
    const tile = el("button", { type: "button", class: "atile " + T_CLS[r.step] + (open ? " sel" : ""), "aria-expanded": open ? "true" : "false", onclick: () => { open ? S.open.delete("t:" + a.code) : S.open.add("t:" + a.code); render(true); } },
      el("span", { class: "at-code", text: a.code }), el("span", { class: "at-name", text: a.name }), stepChip(T_STEPS[r.step], T_CLS[r.step]),
      (dl => dl ? el("span", { class: "chip " + dl.cls, text: dl.label }) : null)(tpamDeadline(p, a, r)),
      r.blocker && r.step < 5 ? el("span", { class: "at-blk", text: "⚠ " + r.blocker }) : null);
    grid.append(tile);
    if (open) grid.append(tpamDetail(p, a, r));
  }
  if (!assocs().length) grid.append(el("div", { class: "empty", text: "No associations yet. Add them below." }));
  main.append(card("Associations", mLabel(p), grid));
  main.append(recCard());
  main.append(todoSection("tpam"));
  main.append(assocManager());
}
function tpamDetail(p, a, r) {
  const save = f => { put("tpam", { ...tpamRec(p, a.code), ...f }); };
  const steps = el("div", { class: "stepper", role: "group", "aria-label": "Step for " + a.code });
  T_STEPS.forEach((s, i) => steps.append(el("button", { type: "button", class: (r.step === i ? "on " : "") + T_CLS[i], "aria-pressed": r.step === i ? "true" : "false",
    onclick: () => { const f = { step: i }; if (i && !r["d" + i]) f["d" + i] = todayStr(); save(f); render(true); } }, s, r["d" + i] && i ? el("small", { text: shortDate(parseYmd(r["d" + i])) }) : null)));
  return el("div", { class: "detail-card" },
    el("div", { class: "dc-h" }, el("b", { text: a.code + " · " + a.name }), el("span", { text: [a.bank, a.cam && "CAM " + a.cam].filter(Boolean).join(" · ") })),
    steps,
    el("div", { class: "hint small", text: "Tap the step it's at. The date is stamped for your Better Financial Checklist." }),
    el("div", { class: "hint", text: "CAM review: " + camDays(a) + " business days · to the CAM by " + fmtDay(toCamBy(p, a)) + " · boards by " + fmtDay(tpamDue(p)) }),
    r.step === 3 ? el("div", { class: "alert over" }, el("span", { class: "a-text", text: "Corrections take longer. Fix and resend as soon as you can." })) : null,
    field("Blocker (what it's waiting on)", textInput("tb-" + p + a.code, r.blocker, v => save({ blocker: v }), "e.g. Waiting on Jeff, missing $430")),
    field("Notes", textInput("tn-" + p + a.code, r.note, v => save({ note: v }), "")));
}
function assocManager() {
  const det = el("details", { class: "card" }, el("summary", { text: "Manage associations" }));
  det.append(el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "+ Add association", onclick: () => openQuickAdd("client") })));
  const ul = el("ul", { class: "entries" });
  for (const a of assocs()) {
    const conf = S.confirm === "a:" + a.id;
    const cd = el("select", { id: "cd-" + a.id, "aria-label": "CAM review days for " + a.code }, el("option", { value: "2", text: "2 business days" }), el("option", { value: "4", text: "4 business days (big)" })); cd.value = String(camDays(a));
    cd.addEventListener("change", () => { put("assoc", { ...a, camDays: Number(cd.value) }); render(true); });
    ul.append(el("li", {}, el("span", { text: a.code + " · " + a.name + (a.cam ? " · CAM " + a.cam : "") }), cd,
      el("button", { type: "button", class: "link", text: conf ? "Tap again to remove" : "Remove", onclick: () => { if (conf) { S.confirm = ""; put("assoc", { ...a, void: true }); } else S.confirm = "a:" + a.id; render(true); } })));
  }
  det.append(el("div", { class: "hint small", text: "Removing hides it from new months. Past months keep their history." }), ul);
  return det;
}
function rotDone(key) { const r = DB.rotation.get(key); return new Set(r && r.done ? r.done.split(",").filter(Boolean) : []); }
function recCard() {
  const d = new Date(), dow = d.getDay(), mon = addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()), 1), list = [];
  for (let i = 0; i < 4; i++) { const day = addDays(mon, i); if (day > d) break; const done = rotDone(ymd(day)); for (const [code, name] of ROTATION[day.getDay()]) list.push({ day, key: ymd(day), code, name, done: done.has(code), isToday: ymd(day) === ymd(d) }); }
  const c = card("Daily Vantaca recs", dow === 5 ? "Friday catch-up" : dow >= 1 && dow <= 4 ? DAYS[dow] + " pair" : "Weekend");
  const todays = list.filter(x => x.isToday), missed = list.filter(x => !x.isToday && !x.done);
  if (dow === 0 || dow === 6) c.append(el("div", { class: "hint", text: "No rec pair on weekends. Monday is Hillwood + Brighton Place." }));
  if (dow === 5) c.append(el("div", { class: "hint", text: missed.length ? "Catch up on these from this week:" : "Every rec this week is checked off." }));
  for (const x of todays) c.append(recRow(x));
  if (dow >= 1 && dow <= 5 && missed.length) { if (dow !== 5) c.append(el("div", { class: "subhead", text: "Skipped earlier this week" })); for (const x of missed) c.append(recRow(x)); }
  return c;
}
function recRow(x) {
  const id = "rec-" + x.key + "-" + x.code, cb = el("input", { type: "checkbox", class: "box", id }); cb.checked = x.done;
  cb.addEventListener("change", () => { const s = rotDone(x.key); cb.checked ? s.add(x.code) : s.delete(x.code); put("rotation", { id: x.key, done: [...s].join(",") }); render(true); });
  return el("div", { class: "rec" + (x.done ? " done" : "") }, cb, el("label", { for: id }, el("span", { class: "code", text: x.code }), x.name + (x.isToday ? "" : " · " + DAYS[x.day.getDay()].slice(0, 3))));
}

/* ================= VICKI'S ================= */
const svcName = k => (V_SVCS.find(s => s[0] === k) || [, k])[1];
function vDue(w, m) { if (w.start && m < w.start) return false; const mo = Number(m.slice(5)); if (w.freq === "q") return mo % 3 === 0; if (w.freq === "a") return mo === 12; return true; }
function vComplete(w) { return w.cthru && w.rthru && w.cthru >= w.rthru; }
function vCell(w, m) {
  if (w.start && m < w.start) return ["", "Not started yet"];
  if (!vDue(w, m)) return ["na", "Not due"];
  if (w.cthru && m <= w.cthru) return ["s5", "Complete"];
  if (w.rthru && m <= w.rthru) { const s = V_STEPS.find(x => x[0] === w.vstep) || V_STEPS[0]; return [s[2], "Received · " + s[1]]; }
  return ["nr", "Not received"];
}
function vickiStats(m, svc) {
  let total = 0, done = 0, blockers = 0;
  for (const w of live("vwork")) { if (svc && w.svc !== svc) continue; if (!DB.vclients.get(w.client) || DB.vclients.get(w.client).void) continue; if (w.blocker && !(w.cthru && w.cthru >= m)) blockers++; if (!vDue(w, m)) continue; total++; if (w.cthru && w.cthru >= m) done++; }
  return { total, done, blockers, pct: total ? pct(done, total) : 100 };
}
function renderVicki(main) {
  const m = monthOf("vicki");
  main.append(monthPicker("vicki", "work month"));
  const q = el("input", { type: "search", id: "vsearch", placeholder: "Search clients (all services)", autocomplete: "off", "aria-label": "Search Vicki's clients" }); q.value = S.vq || "";
  q.addEventListener("input", () => { S.vq = q.value; render(true); const n = document.getElementById("vsearch"); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } });
  main.append(el("div", { class: "searchbar" }, q, S.vq ? el("button", { type: "button", class: "link", text: "Clear", onclick: () => { S.vq = ""; render(true); } }) : null));
  if ((S.vq || "").trim()) {
    const t = S.vq.trim().toLowerCase(), hit = w => { const c = DB.vclients.get(w.client); return c && !c.void && (c.name.toLowerCase().includes(t) || String(w.note || "").toLowerCase().includes(t) || String(w.blocker || "").toLowerCase().includes(t)); };
    const all = [...DB.vwork.values()].filter(hit); let any = false;
    for (const [k, n] of V_SVCS) {
      const g = all.filter(w => w.svc === k && !w.void).sort((a, b) => vName(a).localeCompare(vName(b))), gone = all.filter(w => w.svc === k && w.void);
      if (!g.length && !gone.length) continue; any = true;
      const sec = el("section", {}, el("h2", {}, el("span", { text: n }), el("small", { text: g.length + " found" })));
      for (const w of g) sec.append(vRow(w, m));
      for (const w of gone) sec.append(el("div", { class: "vr-s" }, vName(w) + " (removed from " + n.toLowerCase() + ") ", el("button", { type: "button", class: "link", text: "Put back", onclick: () => { put("vwork", { ...w, void: false }); render(true); } })));
      main.append(sec);
    }
    if (!any) main.append(el("div", { class: "empty", text: "No Vicki's client matches \"" + S.vq.trim() + "\"." }));
    return;
  }
  const ov = vickiStats(m);
  main.append(el("section", { class: "card" }, bigPct(ov.pct, ov.done + " of " + ov.total + " done for " + mLabel(m) + (ov.blockers ? " · " + ov.blockers + " blocked" : ""),
    el("div", { class: "svcbars" }, ...V_SVCS.map(([k, n]) => { const s = vickiStats(m, k); return el("div", { class: "svcbar" }, el("span", { text: n }), el("span", { class: "bar-v", text: s.pct + "%" }), el("div", { class: "track" }, el("div", { class: "fill", style: "width:" + s.pct + "%" }))); })))));
  const seg = el("div", { class: "seg", role: "tablist" });
  for (const [k, n] of V_SVCS) seg.append(el("button", { type: "button", role: "tab", "aria-selected": S.vsvc === k ? "true" : "false", onclick: () => { S.vsvc = k; render(true); } }, n, el("small", { text: vickiStats(m, k).pct + "%" })));
  main.append(seg);
  const svc = S.vsvc; let ws = live("vwork").filter(w => w.svc === svc && DB.vclients.get(w.client) && !DB.vclients.get(w.client).void);
  const legend = el("div", { class: "legend" }, ...[["s5", "Complete"], ["s1", "Received · working"], ["s2", "Waiting on docs"], ["s4", "Waiting on review"], ["nr", "Not received"], ["na", "Not due"]].map(([c, t]) => el("span", {}, el("i", { class: "cell " + c }), t)));
  main.append(legend);
  const lastDueBy = w => { let x = m; for (let i = 0; i < 13 && !vDue(w, x); i++) x = addM(x, -1); return vDue(w, x) ? x : ""; };
  const notDue = w => w.freq && w.freq !== "m" && !vDue(w, m) && (!lastDueBy(w) || (w.cthru && w.cthru >= lastDueBy(w)));
  const later = ws.filter(notDue); ws = ws.filter(w => !notDue(w));
  const blk = w => !!(w.blocker && !(w.cthru && w.cthru >= m));
  const order = (a, b) => (blk(b) - blk(a)) || (a.priority || 2) - (b.priority || 2) || vName(a).localeCompare(vName(b));
  let groups, doneList = [];
  if (svc === "books") {
    const isDone = w => !!(w.cthru && w.cthru >= m), rest = ws.filter(w => !isDone(w));
    doneList = ws.filter(isDone);
    const hasWork = w => !!(w.rthru && (!w.cthru || w.cthru < w.rthru));
    const review = w => w.vstep === "review";
    const canWork = w => !blk(w) && !review(w) && hasWork(w) && w.vstep !== "docs";
    groups = [["Ready to work", rest.filter(canWork), "received and not blocked"], ["Ready for review", rest.filter(review), "waiting on Vicki"],
      ["Not received", rest.filter(w => !blk(w) && !review(w) && !canWork(w)), "or waiting on docs"], ["Blocked", rest.filter(w => blk(w) && !review(w)), ""]];
  } else groups = [["Blocked", ws.filter(blk), ""], ["Everyone else", ws.filter(w => !blk(w)), ""]];
  for (const [sname, g, sub] of groups) {
    const group = g.sort(order);
    if (!group.length) continue;
    const sec = el("section", {}, el("h2", {}, el("span", { text: sname + (svc === "books" ? " (" + group.length + ")" : "") }), el("small", { text: svc === "books" ? sub : group.filter(w => w.cthru && w.cthru >= m || !vDue(w, m)).length + " of " + group.length + " done for " + mShort(m) })));
    for (const w of group) sec.append(vRow(w, m));
    main.append(sec);
  }
  if (doneList.length) { const det = el("details", { class: "card" }, el("summary", { text: "Done for " + mShort(m) + " (" + doneList.length + ")" })); const box = el("div", {});
    for (const w of doneList.sort((a, b) => vName(a).localeCompare(vName(b)))) box.append(vRow(w, m));
    det.append(box); main.append(det); }
  if (later.length) { const det = el("details", { class: "card" }, el("summary", { text: "Quarterly / annual, not due for " + mShort(m) + " (" + later.length + ")" })); const box = el("div", {});
    for (const w of later.sort((a, b) => vName(a).localeCompare(vName(b)))) box.append(vRow(w, m));
    det.append(box); main.append(det); }
  if (!ws.length && !later.length) main.append(el("div", { class: "empty", text: "No " + svcName(svc).toLowerCase() + " clients yet. Add one below." }));
  const gone = [...DB.vwork.values()].filter(w => w.svc === svc && w.void && DB.vclients.get(w.client) && !DB.vclients.get(w.client).void).sort((a, b) => vName(a).localeCompare(vName(b)));
  if (gone.length) { const det = el("details", { class: "card" }, el("summary", { text: "Removed from " + svcName(svc).toLowerCase() + " (" + gone.length + ")" })); const ul = el("ul", { class: "entries" });
    for (const w of gone) ul.append(el("li", {}, el("span", {}, el("b", { text: vName(w) }), w.blocker ? el("div", { class: "vr-s", text: w.blocker }) : null), el("button", { type: "button", class: "link", text: "Put back", onclick: () => { put("vwork", { ...w, void: false }); render(true); } })));
    det.append(ul); main.append(det); }
  if (svc === "books") main.append(workLocatorCard());
  main.append(todoSection("vicki"));
}
const vName = w => (DB.vclients.get(w.client) || {}).name || w.client;
function vRow(w, m) {
  const c = DB.vclients.get(w.client), open = S.open.has("v:" + w.id), months = [];
  for (let i = 11; i >= 0; i--) months.push(addM(m, -i));
  const working = w.rthru && (!w.cthru || w.cthru < w.rthru), stp = V_STEPS.find(x => x[0] === w.vstep) || V_STEPS[0];
  const strip = el("div", { class: "strip", "aria-hidden": "true" }, ...months.map(x => { const [cls, t] = vCell(w, x); return el("i", { class: "cell " + cls + (x === m ? " cur" : ""), title: mLabel(x) + ": " + t }, el("small", { text: MONTHS[Number(x.slice(5)) - 1][0] })); }));
  const status = w.cthru ? "Complete through " + mShort(w.cthru) : "Nothing complete yet";
  const row = el("button", { type: "button", class: "vrow" + (open ? " sel" : ""), "aria-expanded": open ? "true" : "false", onclick: () => { open ? S.open.delete("v:" + w.id) : S.open.add("v:" + w.id); render(true); } },
    el("div", { class: "vr-h" }, el("span", { class: "vr-n", text: c.name }), w.svc === "books" && c.software ? el("span", { class: "chip", text: c.software === "qbo" ? "QBO" : "Desktop" }) : null, w.priority === 1 ? el("span", { class: "chip over", text: "High" }) : w.priority === 3 ? el("span", { class: "chip", text: "Low" }) : null,
      (w.cthru && w.cthru >= m) || (!vDue(w, m) && vComplete(w)) ? stepChip("Printed & complete", "s5") : working || w.vstep ? stepChip(stp[1], stp[2]) : stepChip("Waiting to receive", "nr")),
    strip,
    el("div", { class: "vr-s", text: status + (working ? " · received through " + mShort(w.rthru) : "") + (w.freq === "q" ? " · quarterly" : w.freq === "a" ? " · annual" : "") }),
    blockerLine(!(w.cthru && w.cthru >= m) && w.blocker));
  const wrap = el("div", { class: "vwrap" }, row);
  if (open) wrap.append(vDetail(w, c));
  return wrap;
}
function vDetail(w, c) {
  const save = f => put("vwork", { ...DB.vwork.get(w.id), ...f });
  const lastDue = p => { let x = p; for (let i = 0; i < 13 && !vDue(w, x); i++) x = addM(x, 1); return x; };
  const nextDue = p => lastDue(p ? addM(p, 1) : (w.start || prevMonth()));
  const prevDue = p => { if (!p) return ""; let x = addM(p, -1); for (let i = 0; i < 13 && !vDue(w, x); i++) x = addM(x, -1); return vDue(w, x) ? x : ""; };
  const steps = el("div", { class: "stepper" });
  V_STEPS.forEach(([k, n, cls]) => steps.append(el("button", { type: "button", class: (w.vstep === k ? "on " : "") + cls, "aria-pressed": w.vstep === k ? "true" : "false", onclick: () => { save({ vstep: w.vstep === k ? "" : k }); render(true); } }, n)));
  steps.append(el("button", { type: "button", class: "s5", onclick: () => { if (!w.rthru) { setStatus("Mark a month received first."); return; } save({ cthru: w.rthru, vstep: "" }); render(true); } }, "Printed & complete"));
  const mi = (id, v, f) => { const i = el("input", { type: "month", id }); i.value = v || ""; i.addEventListener("change", () => { save({ [f]: i.value }); render(true); }); return i; };
  const soft = el("select", { id: "vs-" + w.id }, ...V_SOFT.map(([k, n]) => el("option", { value: k, text: n }))); soft.value = c.software || "";
  soft.addEventListener("change", () => { put("vclients", { ...c, software: soft.value }); render(true); });
  const pri = el("select", { id: "vp-" + w.id }, ...PRIORITY.map(([k, n]) => el("option", { value: String(k), text: n }))); pri.value = String(w.priority || 2);
  pri.addEventListener("change", () => { save({ priority: Number(pri.value) }); render(true); });
  const freq = el("select", { id: "vf-" + w.id }, el("option", { value: "m", text: "Monthly" }), el("option", { value: "q", text: "Quarterly" }), el("option", { value: "a", text: "Annual" })); freq.value = w.freq || "m";
  freq.addEventListener("change", () => { save({ freq: freq.value }); render(true); });
  const conf = S.confirm === "vr:" + w.id;
  const links = el("div", { class: "btnrow" },
    w.login ? el("a", { class: "btn linkbtn", href: w.login, target: "_blank", rel: "noopener", text: w.svc === "stax" ? "Login: cert / BP#" : "Login info" }) : null,
    w.info ? el("a", { class: "btn ghost linkbtn", href: w.info, target: "_blank", rel: "noopener", text: w.svc === "stax" ? "Client tab (bank info)" : w.svc === "ptax" ? "Calculations" : "Client info" }) : null);
  return el("div", { class: "detail-card" },
    links.childNodes.length ? links : null,
    el("div", { class: "btnrow" },
      el("button", { type: "button", class: "btn", text: "Received " + mShort(nextDue(w.rthru)), onclick: () => { save({ rthru: nextDue(w.rthru), vstep: w.rthru && w.cthru && w.cthru < w.rthru ? w.vstep : "" }); render(true); } }),
      el("button", { type: "button", class: "btn ghost", text: "Complete " + mShort(nextDue(w.cthru)), onclick: () => { const d = nextDue(w.cthru); save({ cthru: d, rthru: !w.rthru || w.rthru < d ? d : w.rthru, vstep: "" }); render(true); } })),
    (w.cthru || w.rthru) ? el("div", { class: "btnrow" },
      w.cthru ? el("button", { type: "button", class: "btn ghost small", text: "↩ Undo complete " + mShort(w.cthru), onclick: () => { save({ cthru: prevDue(w.cthru) }); setStatus(mShort(w.cthru) + " is back to not complete."); render(true); } }) : null,
      w.rthru ? el("button", { type: "button", class: "btn ghost small", text: "↩ Undo received " + mShort(w.rthru), onclick: () => { const r = prevDue(w.rthru); save({ rthru: r, cthru: w.cthru && (!r || w.cthru > r) ? r : w.cthru, vstep: "" }); setStatus(mShort(w.rthru) + " is back to not received."); render(true); } }) : null) : null,
    el("div", { class: "subhead", text: "Step for the received work" }), steps,
    el("div", { class: "row2" }, field("Complete through", mi("vd-" + w.id, w.cthru, "cthru")), field("Received through", mi("vrc-" + w.id, w.rthru, "rthru")), field("Priority", pri), field("Software", soft), field("How often", freq), field("Started", mi("vst-" + w.id, w.start, "start"))),
    field("Blocker", textInput("vb-" + w.id, w.blocker, v => save({ blocker: v }), "e.g. Missing September statement")),
    field("Notes", textInput("vn-" + w.id, w.note, v => save({ note: v }), "")),
    el("details", { class: "mini" }, el("summary", { text: "Change login / info links" }),
      field("Login link (opens your Google Sheet)", textInput("vl-" + w.id, w.login, v => save({ login: v.trim() }), "https://docs.google.com/…")),
      field("Client info link", textInput("vi-" + w.id, w.info, v => save({ info: v.trim() }), "https://docs.google.com/…"))),
    el("button", { type: "button", class: "link", text: conf ? "Tap again to take " + c.name + " off " + svcName(w.svc) : "Remove from " + svcName(w.svc), onclick: () => { if (conf) { S.confirm = ""; save({ void: true }); } else S.confirm = "vr:" + w.id; render(true); } }));
}
function workLocatorCard() {
  const rows = SERVER.wl || [];
  const c = card("Work Locator (office sheet)", rows.length ? rows.length + " open" : "");
  if (SERVER.wlError) c.append(el("div", { class: "hint", text: "Couldn't read the Work Locator: " + SERVER.wlError }));
  else if (!config) c.append(el("div", { class: "hint", text: "Shows your open rows from the office Work Locator once the app is connected to your Sheet." }));
  else if (!rows.length) c.append(el("div", { class: "hint", text: "No open rows for you or Tori in Bookkeeping 2026." }));
  const ul = el("ul", { class: "wl" });
  for (const r of rows) ul.append(el("li", {}, el("div", { class: "wl-h" }, el("b", { text: r.client }), el("span", { class: "chip", text: r.status })), el("div", { class: "vr-s", text: [r.work, r.bookkeeper !== "Jodi" ? "was " + r.bookkeeper + "'s" : "", r.provided && "provided " + r.provided, r.days && r.days + " days in office"].filter(Boolean).join(" · ") }), r.notes ? el("div", { class: "vr-s", text: r.notes }) : null));
  c.append(ul, el("div", { class: "hint small", text: "Read-only. Update the Work Locator itself at the office." }));
  return c;
}

/* ================= ABSOLUTE ================= */
const aAll = () => live("aclients").sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
const aClients = () => aAll().filter(c => !c.inactive && c.type !== "weekly");
const aSteps = c => c.type === "va" ? A_VA : A_BOOKS;
function aRec(c, p) { return DB.awork.get(c.id + "-" + p) || { id: c.id + "-" + p, client: c.id, period: p, step: 0, blocker: "", note: "", invoiced: "" }; }
const aDone = (c, p) => aRec(c, p).step >= aSteps(c).length - 1;
function absDue(c, p) { const day = c.dueDay || (c.type === "va" ? 3 : 15); return ymd(new Date(Number(p.slice(0, 4)), Number(p.slice(5)), day)); }
function absOpenMonths(c) { const out = [], end = prevMonth(); if (!c.start) return aDone(c, end) ? [] : [end]; for (let p = c.start; p <= end; p = addM(p, 1)) if (!aDone(c, p)) out.push(p); return out; }
function absStats(p) {
  let total = 0, done = 0, blockers = 0;
  for (const c of aClients()) { if (c.start && p < c.start) continue; total++; if (aDone(c, p)) done++; if (c.blocker || aRec(c, p).blocker) blockers++; }
  return { total, done, blockers, pct: pct(done, total) };
}
function renderAbsolute(main) {
  const p = monthOf("absolute"), st = absStats(p);
  main.append(monthPicker("absolute", "month closing"));
  const backlog = aClients().reduce((n, c) => n + absOpenMonths(c).filter(x => x < p).length, 0);
  main.append(el("section", { class: "card" }, bigPct(st.pct, st.done + " of " + st.total + " clients done for " + mLabel(p) + (backlog ? " · " + backlog + " past-due month" + (backlog > 1 ? "s" : "") : "") + (st.blockers ? " · " + st.blockers + " blocked" : ""))));
  const books = aClients().filter(c => c.type !== "va"), va = aClients().filter(c => c.type === "va");
  if (books.length) { const s = el("section", {}, el("h2", {}, el("span", { text: "Bookkeeping clients" }), el("small", { text: "classify daily · reconcile · send financials" }))); for (const c of books) s.append(absBooks(c, p)); main.append(s); }
  if (va.length) { const s = el("section", {}, el("h2", {}, el("span", { text: "Assistant clients" }), el("small", { text: "reach out · do the job · invoice" }))); for (const c of va) s.append(absVa(c, p)); main.append(s); }
  const wk = aAll().filter(c => !c.inactive && c.type === "weekly");
  if (wk.length) { const s = el("section", {}, el("h2", {}, el("span", { text: "Weekly meetings" }))); for (const c of wk) s.append(absWeekly(c)); main.append(s); }
  const ina = aAll().filter(c => c.inactive);
  if (ina.length) { const det = el("details", { class: "card" }, el("summary", { text: "Inactive clients (" + ina.length + ")" })); const ul = el("ul", { class: "entries" });
    for (const c of ina) ul.append(el("li", {}, el("span", {}, el("b", { text: c.name }), c.services ? " · " + c.services : "", c.note ? el("div", { class: "vr-s", text: c.note }) : null), el("button", { type: "button", class: "link", text: "Make active", onclick: () => { put("aclients", { ...c, inactive: false }); render(true); } })));
    det.append(ul); main.append(det); }
  main.append(crmCard());
  main.append(socialCard());
  main.append(todoSection("absolute"));
}
function absHead(c, extra) {
  return el("div", {}, el("div", { class: "ac-h" }, el("div", {}, el("b", { class: "ac-n", text: c.name }), el("div", { class: "vr-s", text: [c.services, c.fee ? "$" + c.fee + (c.type === "va" ? "/job" : "/mo") : ""].filter(Boolean).join(" · ") })), extra || null), blockerLine(c.blocker));
}
const notYet = (c, p) => c.start && p < c.start ? el("div", { class: "hint", text: "Starts " + mLabel(c.start) + ". Nothing due for " + mLabel(p) + "." }) : null;
function absBooks(c, p) {
  const r = aRec(c, p), steps = A_BOOKS, tm = thisMonth(), cur = aRec(c, tm), di = dueInfo(absDue(c, p));
  const save = (per, f) => put("awork", { ...aRec(c, per), ...f });
  const classified = c.lastClassified === todayStr();
  const past = absOpenMonths(c).filter(x => x < p);
  const box = el("div", { class: "acard" },
    absHead(c, notYet(c, p) ? null : aDone(c, p) ? stepChip("Done", "s5") : di ? el("span", { class: "chip " + di.cls, text: di.label }) : null),
    el("div", { class: "acts2" },
      el("button", { type: "button", class: "btn " + (classified ? "ghost" : ""), text: classified ? "✓ Classified today" : "Classify today", onclick: () => { put("aclients", { ...c, lastClassified: classified ? "" : todayStr() }); render(true); } }),
      el("button", { type: "button", class: "btn " + (cur.invoiced ? "ghost" : "warn"), text: cur.invoiced ? "✓ " + mShort(tm) + " invoiced " + shortDate(parseYmd(cur.invoiced)) : "Invoice " + mShort(tm), onclick: () => { save(tm, { invoiced: cur.invoiced ? "" : todayStr() }); render(true); } })),
    notYet(c, p) || el("div", { class: "subhead", text: mLabel(p) + " close" }),
    notYet(c, p) ? null : stepper(steps, r.step, i => { const f = { step: i }; if (i && !r["d" + i]) f["d" + i] = todayStr(); save(p, f); render(true); }, r),
    past.length ? el("div", { class: "pastdue" }, el("b", { text: "Past months still due: " }), ...past.map(x => el("button", { type: "button", class: "chip over", text: mShort(x), onclick: () => { S.m.absolute = x; render(true); } }))) : null,
    notYet(c, p) ? null : field(mShort(p) + " blocker", textInput("ab-" + c.id + p, r.blocker, v => save(p, { blocker: v }), "Anything holding up this month")),
    clientSettings(c));
  return box;
}
function absVa(c, p) {
  const r = aRec(c, p), di = dueInfo(absDue(c, p)), save = f => put("awork", { ...aRec(c, p), ...f });
  if (notYet(c, p)) return el("div", { class: "acard" }, absHead(c), notYet(c, p), clientSettings(c));
  return el("div", { class: "acard" },
    absHead(c, aDone(c, p) ? stepChip("Invoiced", "s5") : di ? el("span", { class: "chip " + di.cls, text: di.label }) : null),
    el("div", { class: "subhead", text: mLabel(p) + " job" }),
    stepper(A_VA, r.step, i => { const f = { step: i }; if (i && !r["d" + i]) f["d" + i] = todayStr(); if (i === 4) f.invoiced = todayStr(); save(f); render(true); }, r),
    r.step === 3 ? el("div", { class: "alert over" }, el("span", { class: "a-text", text: "Job's done. Send the invoice." })) : null,
    field("What's the job?", textInput("aj-" + c.id + p, r.note, v => save({ note: v }), "e.g. Print tracker invoices")),
    field("Blocker", textInput("ab-" + c.id + p, r.blocker, v => save({ blocker: v }), "")),
    clientSettings(c));
}
function absWeekly(c) {
  const save = f => put("aclients", { ...DB.aclients.get(c.id), ...f });
  const days = String(c.days || "").split(/[\s,]+/).filter(Boolean).map(Number).filter(n => n >= 0 && n <= 6);
  const nextOn = (dow, from) => { const d = new Date(from); d.setHours(0, 0, 0, 0); while (d.getDay() !== dow) d.setDate(d.getDate() + 1); return ymd(d); };
  const after = d => { const x = addDays(parseYmd(d), 1); return days.length ? days.map(w => nextOn(w, x)).sort()[0] : ymd(addDays(parseYmd(d), 6)); };
  const di = dueInfo(c.nextDate);
  const nd = el("input", { type: "date", id: "wn-" + c.id }); nd.value = c.nextDate || ""; nd.addEventListener("change", () => { save({ nextDate: nd.value }); render(true); });
  const quick = days.map(w => { const d = nextOn(w, new Date()); return el("button", { type: "button", class: "btn ghost" + (c.nextDate === d ? " on" : ""), text: DAYS[w].slice(0, 3) + " " + shortDate(parseYmd(d)), onclick: () => { save({ nextDate: d }); render(true); } }); });
  const dayPick = el("div", { class: "chks" }, ...[1, 2, 3, 4, 5].map(w => { const cb = el("input", { type: "checkbox", id: "wd-" + c.id + w }); cb.checked = days.includes(w); cb.addEventListener("change", () => { const set = new Set(days); cb.checked ? set.add(w) : set.delete(w); save({ days: [...set].sort().join(" ") }); render(true); }); return el("label", { class: "chk" }, cb, " " + DAYS[w].slice(0, 3)); }));
  return el("div", { class: "acard" },
    absHead(c, c.nextDate ? el("span", { class: "chip " + (di ? di.cls : ""), text: di && di.diff === 0 ? "Meeting today" : di && di.diff < 0 ? "Was " + fmtDay(c.nextDate) : "Next: " + fmtDay(c.nextDate) }) : el("span", { class: "chip", text: "Set the next date" })),
    days.length ? el("div", { class: "vr-s", text: "Usually " + days.map(w => DAYS[w]).join(" or ") }) : null,
    quick.length ? el("div", { class: "btnrow" }, ...quick) : null,
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Met · set next", onclick: () => { save({ lastMet: todayStr(), nextDate: after(todayStr()) }); render(true); } })),
    field("Or pick a date", nd),
    c.lastMet ? el("div", { class: "vr-s", text: "Last met " + fmtDay(c.lastMet) }) : null,
    el("details", { class: "mini" }, el("summary", { text: "Usual meeting days" }), dayPick),
    clientSettings(c));
}
function stepper(steps, cur, onPick, r) {
  const s = el("div", { class: "stepper" });
  steps.forEach((n, i) => s.append(el("button", { type: "button", class: (cur === i ? "on " : "") + (i === steps.length - 1 ? "s5" : i ? "s1" : "s0"), "aria-pressed": cur === i ? "true" : "false", onclick: () => onPick(i) }, n, r && r["d" + i] && i ? el("small", { text: shortDate(parseYmd(r["d" + i])) }) : null)));
  return s;
}
function clientSettings(c) {
  const det = el("details", { class: "mini" }, el("summary", { text: "Client details" }));
  if (S.open.has("ac:" + c.id)) det.open = true;
  det.addEventListener("toggle", () => det.open ? S.open.add("ac:" + c.id) : S.open.delete("ac:" + c.id));
  const save = f => put("aclients", { ...DB.aclients.get(c.id), ...f });
  const start = el("input", { type: "month", id: "acs-" + c.id }); start.value = c.start || ""; start.addEventListener("change", () => { save({ start: start.value }); render(true); });
  const due = el("input", { type: "number", id: "acd-" + c.id, min: "1", max: "28", inputmode: "numeric" }); due.value = c.dueDay || (c.type === "va" ? 3 : 15); due.addEventListener("change", () => { save({ dueDay: Number(due.value) || 15 }); render(true); });
  const fee = el("input", { type: "number", id: "acf-" + c.id, min: "0", step: "1", inputmode: "decimal" }); fee.value = c.fee || ""; fee.addEventListener("change", () => { save({ fee: Number(fee.value) || 0 }); render(true); });
  const conf = S.confirm === "ac:" + c.id;
  det.append(field("What I do for them", textInput("acv-" + c.id, c.services, v => save({ services: v }), "")),
    el("div", { class: "row2" }, field(c.type === "va" ? "First month" : "First month due (cleanup start)", start), field("Due day of next month", due), field(c.type === "va" ? "Fee per job ($)" : "Monthly fee ($)", fee)),
    field("Ongoing blocker", textInput("acb-" + c.id, c.blocker, v => save({ blocker: v }), "")),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn ghost", text: "Mark inactive", onclick: () => { save({ inactive: true }); render(true); } }),
      el("button", { type: "button", class: "link", text: conf ? "Tap again to archive " + c.name : "Archive client", onclick: () => { if (conf) { S.confirm = ""; save({ void: true }); } else S.confirm = "ac:" + c.id; render(true); } })));
  return det;
}
/* ---------- CRM follow-ups ---------- */
const CRM_SKIP = /stalled|inactive|on hold/i;
const crmSkipped = () => { try { return JSON.parse(setting("crmSkip", "[]")) || []; } catch (_) { return []; } };
const crmSetSkip = (r, on) => { const l = crmSkipped().filter(x => x !== r.company); if (on) l.push(r.company); put("settings", { id: "crmSkip", value: JSON.stringify(l) }); };
const crmLive = () => { const sk = crmSkipped(); return (SERVER.crm || []).filter(r => !CRM_SKIP.test(r.status) && !sk.includes(r.company)); };
const crmDue = () => crmLive().filter(r => r.next && r.next <= todayStr()).sort((a, b) => a.next < b.next ? -1 : a.next > b.next ? 1 : a.row - b.row);
const crmNew = () => crmLive().filter(r => !r.last && !r.next).sort((a, b) => a.row - b.row);
const crmToday = () => [...crmDue(), ...crmNew().slice(0, Number(setting("crmNewPerDay", 3)) || 0)];
function crmFirst(r) {
  const n = String(r.contact || "").replace(/\(.*?\)/g, "").split("/")[0].trim();
  if (!n || /^(office|front desk|customer care|owner|individual)\b/i.test(n)) return "";
  return n.split(/\s+/)[0];
}
function crmAudience(r) {
  const sv = (r.service || "") + " " + (r.notes || "");
  if (/association|CAM\b|communit/i.test(sv)) return ["community associations and the companies that manage them", "I already do association financials every month, so I can step in on month-end, reconciliations or overflow when your team is stretched."];
  if (/rental|owner statement|trust|propert/i.test(sv)) return ["property managers", "I can take owner statements, reconciliations and back-office paperwork off your plate."];
  return ["contractors and small businesses", "I can get QuickBooks cleaned up and keep it that way, so you're not buried in receipts at tax time."];
}
function crmWhere(r) { const h = r.how || ""; return /konecki/i.test(h) ? " at the Konecki lunch" : /cheers/i.test(h) ? " at Cheers" : /red'?s/i.test(h) ? " at Red's" : /whitey/i.test(h) ? " at Whitey's" : /networking/i.test(h) ? " at the networking event" : ""; }
function crmMetDate(r) { const m = String(r.how || "").match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2}),? (\d{4})/); if (!m) return ""; const d = new Date(m[1] + " " + m[2] + ", " + m[3]); return isNaN(d) ? "" : ymd(d); }
function crmHelp(r) {
  const sv = (r.service || "") + " " + (r.notes || "");
  if (/referral partner|lender|investor|CFO/i.test(sv)) return ["", "I'd love to grab coffee and talk about how we can send work each other's way."];
  if (/personal/i.test(sv)) return [" to see if you'd still like help with your personal bookkeeping", ""];
  if (/mortgage/i.test(sv)) return [" about getting your mortgages set up right in QuickBooks", ""];
  return ["", ""];
}
function crmDraft(r) {
  const f = crmFirst(r), hi = f ? "Hi " + f + "," : "Hi there,", svc0 = (r.service || "bookkeeping").replace(/\bQBO\b/g, "QuickBooks").replace(/ & /g, " and ").replace(/\s*\(.*?\)/g, "").replace(/\s*\/.*$/, ""), svc = /^[A-Z][a-z]/.test(svc0) && !/^QuickBooks/.test(svc0) ? svc0[0].toLowerCase() + svc0.slice(1) : svc0;
  const sig = "\n\nThanks,\nJodi Smith\nAbsolute Bookkeeping & Virtual Assistant", [aud, pitch] = crmAudience(r);
  const when = r.last ? " from " + shortDate(parseYmd(r.last)) : "";
  if (!r.last) return { text: hi + " this is Jodi with Absolute Bookkeeping in Orange Park. I help " + aud + " with " + svc + ". Would you be open to a quick call this week?",
    subject: "Bookkeeping help for " + r.company, email: hi + "\n\nMy name is Jodi Smith with Absolute Bookkeeping in Orange Park. I work with " + aud + " and help with " + svc + ". " + pitch + "\n\nWould you be open to a quick 10-minute call this week or next?" + sig };
  if (/Currently Working/i.test(r.category)) return { text: hi + " just checking in. Anything you need from me this week?", subject: "Checking in", email: hi + "\n\nJust checking in. Is there anything you need from me this week?" + sig };
  if (/Past Client/i.test(r.category)) return { text: hi + " it's Jodi with Absolute Bookkeeping. Hope you're doing well! Tax season is coming up. If you'd like help getting things ready, I'd be glad to help.", subject: "Getting ready for tax season", email: hi + "\n\nHope you're doing well! Tax season is coming up, and if you'd like help getting your books ready, I'd be glad to help." + sig };
  const met = crmMetDate(r), fresh = /Met in Person/i.test(r.category) && met && r.last && r.last <= ymd(addDays(parseYmd(met), 3));
  const [about, partner] = crmHelp(r), ask = partner || "Do you have time for a quick call or coffee this week?";
  if (/Met in Person/i.test(r.category) && !fresh) return { text: hi + " it's Jodi with Absolute Bookkeeping. Just checking back in" + about + ". " + ask,
    subject: "Checking back in", email: hi + "\n\nJust checking back in" + about + ". " + ask + sig };
  if (/hot|warm/i.test(r.status) && !/Met in Person/i.test(r.category)) return { text: hi + " it's Jodi with Absolute Bookkeeping. Following up on our conversation" + when + ". I'm happy to answer any questions by phone or email, whatever's easiest. When's a good time?",
    subject: "Following up: " + r.company, email: hi + "\n\nFollowing up on our conversation" + when + ". I'm happy to answer any questions by phone or email, whatever's easiest. When's a good time for you?" + sig };
  if (/Met in Person/i.test(r.category)) return { text: hi + " it's Jodi with Absolute Bookkeeping. It was great meeting you" + crmWhere(r) + ". " + (partner || "I'd love to grab coffee or set up a quick call this week. What works for you?"),
    subject: "Great meeting you", email: hi + "\n\nIt was great meeting you" + crmWhere(r) + ". " + (partner || "I'd love to grab coffee or set up a quick call this week to hear more about what you're working on. What works for you?") + sig };
  return { text: hi + " it's Jodi with Absolute Bookkeeping. Just following up on my message" + when + ". If " + svc + " is something you could use help with, I'm happy to take a free 10-minute look at your QuickBooks. No pressure either way!",
    subject: "Following up: " + r.company, email: hi + "\n\nJust following up on my message" + when + ". If " + svc + " is something you could use help with, I'm happy to take a free 10-minute look at your QuickBooks. No pressure either way." + sig };
}
const crmLogId = r => "crmlog:" + r.company;
function crmLog(r, line) { const ex = DB.notes.get(crmLogId(r)); put("notes", { id: crmLogId(r), text: (fmtDay(todayStr()) + ": " + line) + (ex && ex.text ? "\n" + ex.text : "") }); }
async function copyText(t, what) { try { await navigator.clipboard.writeText(t); setStatus(what + " copied. Paste it wherever you're sending it."); } catch (_) { setStatus("Couldn't copy. Select the text and copy it yourself."); } }
function crmDetail(r) {
  const d = crmDraft(r), id = "cm-" + r.row, gap = CRM_GAP[r.category] || 4;
  const useEmail = !r.phone && r.email;
  const ta = el("textarea", { id, rows: "6", class: "draft" }); ta.value = useEmail ? d.email : d.text;
  const phone = String(r.phone || "").replace(/[^\d+]/g, "");
  const send = el("div", { class: "btnrow" },
    el("button", { type: "button", class: "btn", text: "Copy message", onclick: () => copyText(ta.value, "Message") }),
    phone ? el("a", { class: "btn ghost linkbtn", href: "sms:" + phone + "?&body=" + encodeURIComponent(ta.value), text: "Text " + r.phone, onclick: e => { e.currentTarget.href = "sms:" + phone + "?&body=" + encodeURIComponent(ta.value); } }) : null,
    r.email ? el("a", { class: "btn ghost linkbtn", href: "#", text: "Email", onclick: e => { const body = ta.value === d.text ? d.email : ta.value; e.currentTarget.href = "mailto:" + r.email + "?subject=" + encodeURIComponent(d.subject) + "&body=" + encodeURIComponent(body); } }) : null,
    phone ? el("a", { class: "btn ghost linkbtn", href: "tel:" + phone, text: "Call" }) : null);
  const swap = r.phone && r.email ? el("div", { class: "seg2" },
    el("button", { type: "button", class: "link", text: "Text version", onclick: () => { ta.value = d.text; } }),
    el("button", { type: "button", class: "link", text: "Email version", onclick: () => { ta.value = d.email; } })) : null;
  const note = el("input", { type: "text", id: "cl-" + r.row, placeholder: "What happened? (optional)" });
  const nx = el("input", { type: "date", id: "cn-" + r.row }); nx.value = r.next || "";
  const after = n => { const x = addDays(new Date(), n); while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() + 1); return ymd(x); };
  const log = (what, f) => { const fields = { last: todayStr(), ...f }; if ((!r.status || /to contact/i.test(r.status)) && !f.status) fields.status = "Cold Outreach"; crmPut(r, fields); crmLog(r, what + (note.value.trim() ? ". " + note.value.trim().replace(/[.!?]?$/, ".") : ".") + (fields.next ? " Next: " + fmtDay(fields.next) + "." : "")); setStatus(r.company + " logged."); render(true); };
  const outcomes = el("div", { class: "chips2" },
    ...[["Texted", { next: after(gap) }], ["Emailed", { next: after(gap) }], ["Called, no answer", { next: after(2) }],
      ["They replied", { next: after(3), status: "Warm / Reconnect" }], ["Meeting set", { status: "Hot Prospect" }], ["Not interested", { next: "", status: "Stalled / Inactive" }]]
      .map(([t, f]) => el("button", { type: "button", class: "btn ghost small", text: t, onclick: () => log(t, t === "Meeting set" ? { ...f, next: nx.value || after(7) } : f) })));
  const quick = el("div", { class: "chips2" }, ...[["2 days", 2], ["1 week", 7], ["2 weeks", 14], ["1 month", 30], ["3 months", 90]].map(([t, n]) =>
    el("button", { type: "button", class: "btn ghost small", text: t, onclick: () => { crmPut(r, { next: after(n) }); setStatus("Next follow-up: " + fmtDay(after(n)) + "."); render(true); } })));
  nx.addEventListener("change", () => { crmPut(r, { next: nx.value }); render(true); });
  const hist = (DB.notes.get(crmLogId(r)) || {}).text || "";
  return el("div", { class: "detail-card" },
    el("div", { class: "vr-s", text: [r.service, r.status, r.how].filter(Boolean).join(" · ") }),
    r.notes ? el("div", { class: "crm-notes", text: r.notes }) : null,
    !r.phone && !r.email ? el("div", { class: "hint", text: "No phone or email in your CRM for them yet. Add one in the CRM sheet, or copy the message and send it however you reach them." }) : null,
    el("div", { class: "subhead", text: useEmail ? "Ready-to-send email" : "Ready-to-send text" }), swap, ta,
    useEmail ? el("div", { class: "vr-s", text: "Subject: " + d.subject }) : null, send,
    el("div", { class: "subhead", text: "Log what happened" }), note, outcomes,
    el("div", { class: "subhead", text: "Next follow-up" }), quick, field("Or pick a date", nx),
    hist ? el("details", { class: "mini" }, el("summary", { text: "History" }), el("div", { class: "crm-notes", text: hist })) : null,
    el("div", { class: "vr-s", text: "Last contact: " + (r.last ? fmtDay(r.last) : "never") }),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "link", text: "Don't follow up with them", onclick: () => { crmSetSkip(r, true); setStatus(r.company + " won't show in follow-ups. Undo under \"Skipped\" in the CRM card."); render(true); } })));
}
function crmList(list, empty) {
  const ul = el("ul", { class: "crm" });
  for (const r of list) {
    const k = "crm:" + r.row, open = S.open.has(k), di = dueInfo(r.next);
    const li = el("li", {}, el("button", { type: "button", class: "crm-row", "aria-expanded": open ? "true" : "false", onclick: () => { open ? S.open.delete(k) : S.open.add(k); render(true); } },
      el("div", {}, el("b", { text: r.company }), el("div", { class: "vr-s", text: [r.contact, r.service].filter(Boolean).join(" · ") })),
      !r.last && !r.next ? el("span", { class: "chip", text: "New" }) : di ? el("span", { class: "chip " + di.cls, text: di.label }) : null));
    if (open) li.append(crmDetail(r));
    ul.append(li);
  }
  if (!list.length) ul.append(el("li", { class: "empty", text: empty }));
  return ul;
}
function crmTodayCard() {
  const due = crmDue(), fresh = crmNew().slice(0, Number(setting("crmNewPerDay", 3)) || 0);
  const c = card("Follow-ups today", (due.length + fresh.length) ? String(due.length + fresh.length) : "");
  if (SERVER.crmError) { c.append(el("div", { class: "hint", text: "Couldn't read your CRM sheet: " + SERVER.crmError })); return c; }
  if (!config) { c.append(el("div", { class: "hint", text: "Your CRM follow-ups show here once the app is connected to your Sheet." })); return c; }
  if (due.length) c.append(el("div", { class: "subhead", text: "Due or overdue, oldest first" }), crmList(due, ""));
  if (fresh.length) c.append(el("div", { class: "subhead", text: "New outreach: " + fresh.length + " today (" + crmNew().length + " never contacted)" }), crmList(fresh, ""));
  if (!due.length && !fresh.length) c.append(el("div", { class: "empty", text: "No follow-ups due today." }));
  c.append(el("div", { class: "hint small", text: "Tap a name for a ready-to-send message. Logging it updates Last Contact, Next Follow-Up and Status in your CRM sheet." }));
  return c;
}
function crmCard() {
  const rows = SERVER.crm || [];
  const stats = {}; for (const r of rows) { const s = r.status || "No status"; stats[s] = (stats[s] || 0) + 1; }
  const today = crmToday();
  const c = card("CRM follow-ups", rows.length ? today.length + " today" : "");
  if (SERVER.crmError) { c.append(el("div", { class: "hint", text: "Couldn't read your CRM sheet: " + SERVER.crmError })); return c; }
  if (!config) { c.append(el("div", { class: "hint", text: "Your CRM shows here once the app is connected to your Sheet." })); return c; }
  if (!S.crmFilter || S.crmFilter === "due") S.crmFilter = "today";
  const chip = (key, label) => el("button", { type: "button", "aria-pressed": S.crmFilter === key ? "true" : "false", text: label, onclick: () => { S.crmFilter = key; render(true); } });
  c.append(el("div", { class: "filters" }, chip("today", "Today (" + today.length + ")"), chip("new", "Never contacted (" + crmNew().length + ")"), crmSkipped().length ? chip("skipped", "Skipped (" + crmSkipped().length + ")") : null,
    ...Object.entries(stats).sort((a, b) => b[1] - a[1]).map(([s, n]) => chip(s, s + " (" + n + ")"))));
  if (S.crmFilter === "skipped") {
    const ul = el("ul", { class: "entries" });
    for (const r of rows.filter(r => crmSkipped().includes(r.company))) ul.append(el("li", {}, el("span", {}, el("b", { text: r.company }), el("div", { class: "vr-s", text: r.contact || "" })), el("button", { type: "button", class: "link", text: "Follow up again", onclick: () => { crmSetSkip(r, false); render(true); } })));
    c.append(ul); return c;
  }
  const list = S.crmFilter === "today" ? today : S.crmFilter === "new" ? crmNew() : rows.filter(r => (r.status || "No status") === S.crmFilter);
  const per = el("select", { id: "crm-per" }, ...[0, 1, 2, 3, 5, 10].map(n => el("option", { value: String(n), text: n + " new a day" }))); per.value = String(setting("crmNewPerDay", 3));
  per.addEventListener("change", () => { put("settings", { id: "crmNewPerDay", value: per.value }); render(true); });
  c.append(crmList(list, S.crmFilter === "today" ? "No follow-ups due today." : "Nobody in this group."), field("New prospects to add to Today", per));
  return c;
}
function socialCard() {
  const posts = live("social").sort((a, b) => (a.status === "posted") - (b.status === "posted") || (a.date || "9999").localeCompare(b.date || "9999"));
  const open = posts.filter(p => p.status !== "posted");
  const c = card("Social media", open.length + " to post");
  const ul = el("ul", { class: "crm" });
  for (const p of posts) {
    if (p.status === "posted" && !S.showDone.has("social")) continue;
    const k = "so:" + p.id, isOpen = S.open.has(k), di = p.status !== "posted" ? dueInfo(p.date) : null;
    const st = SOCIAL.find(s => s[0] === p.status) || SOCIAL[0];
    const li = el("li", {}, el("button", { type: "button", class: "crm-row", "aria-expanded": isOpen ? "true" : "false", onclick: () => { isOpen ? S.open.delete(k) : S.open.add(k); render(true); } },
      el("div", {}, el("b", { text: p.title }), el("div", { class: "vr-s", text: [p.platform, p.date && fmtDay(p.date)].filter(Boolean).join(" · ") })), el("span", { class: "chip " + (p.status === "posted" ? "step s5" : di ? di.cls : ""), text: di && p.status === "scheduled" ? di.label : st[1] })));
    if (isOpen) {
      const save = f => put("social", { ...DB.social.get(p.id), ...f });
      const date = el("input", { type: "date", id: "sd-" + p.id }); date.value = p.date || ""; date.addEventListener("change", () => { save({ date: date.value }); render(true); });
      const plat = el("select", { id: "sp-" + p.id }, ...["Facebook", "Instagram", "Facebook + Instagram", "LinkedIn", "Google Business"].map(x => el("option", { value: x, text: x }))); plat.value = p.platform || "Facebook";
      plat.addEventListener("change", () => { save({ platform: plat.value }); render(true); });
      li.append(el("div", { class: "detail-card" }, el("div", { class: "stepper" }, ...SOCIAL.map(([k2, n]) => el("button", { type: "button", class: (p.status === k2 ? "on " : "") + (k2 === "posted" ? "s5" : "s1"), onclick: () => { save({ status: k2, date: k2 === "posted" && !p.date ? todayStr() : p.date }); render(true); } }, n))),
        el("div", { class: "row2" }, field("Post date", date), field("Where", plat)), field("Notes", textInput("sn-" + p.id, p.note, v => save({ note: v }), ""))));
    }
    ul.append(li);
  }
  if (!posts.length) ul.append(el("li", { class: "empty", text: "No posts yet." }));
  const nt = el("input", { type: "text", id: "so-new", placeholder: "New post idea", maxlength: 120 });
  const add = () => { const v = nt.value.trim(); if (!v) return; nt.value = ""; put("social", { id: "s" + newId(), title: v, platform: "Facebook", date: "", status: "idea", note: "", void: false }); render(true); };
  nt.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); } });
  const posted = posts.length - open.length;
  c.append(ul, posted ? el("button", { type: "button", class: "link", text: (S.showDone.has("social") ? "Hide" : "Show") + " posted (" + posted + ")", onclick: () => { S.showDone.has("social") ? S.showDone.delete("social") : S.showDone.add("social"); render(true); } }) : null,
    el("div", { class: "add" }, nt, el("button", { type: "button", class: "btn", text: "Add", onclick: add })));
  return c;
}


/* ================= QUICK ADD (tasks + clients) ================= */
const QA_JOBS = [["tpam", "TPAM"], ["vicki", "Vicki's"], ["absolute", "Absolute"], ["personal", "Personal"]];
function openQuickAdd(kind) { S.qa = { kind, job: QA_JOBS.some(j => j[0] === S.tab) ? S.tab : "tpam" }; render(true); const f = document.querySelector("#qa-first"); if (f) f.focus(); }
function quickAddPanel() {
  if (!S.qa) return null;
  const q = S.qa, close = () => { S.qa = null; render(true); };
  const jobSel = el("select", { id: "qa-job" }, ...QA_JOBS.filter(j => q.kind === "task" || j[0] !== "personal").map(([k, n]) => el("option", { value: k, text: n }))); jobSel.value = q.job === "personal" && q.kind === "client" ? "absolute" : q.job;
  jobSel.addEventListener("change", () => { S.qa.job = jobSel.value; render(true); });
  const kinds = el("div", { class: "seg small" }, ...[["task", "New task"], ["client", "New client"]].map(([k, n]) => el("button", { type: "button", "aria-selected": q.kind === k ? "true" : "false", onclick: () => { S.qa.kind = k; render(true); } }, n)));
  const box = el("div", { class: "qa", role: "dialog", "aria-label": "Add" }, el("div", { class: "qa-h" }, kinds, el("button", { type: "button", class: "link", text: "Close", onclick: close })), field(q.kind === "task" ? "For" : "Job", jobSel));
  const job = jobSel.value;
  if (q.kind === "task") {
    const title = el("input", { type: "text", id: "qa-first", placeholder: "What needs doing?", maxlength: 200 });
    const secs = job === "tpam" ? [["follow", "Follow-ups"], ["other", "Other TPAM"]] : job === "vicki" ? [["office", "Office to-dos"]] : job === "absolute" ? [["absolute", "Absolute to-dos"]] : LISTS[2].sections.filter(x => x[0] !== "absolute");
    const sec = el("select", { id: "qa-sec" }, ...secs.map(([k, n]) => el("option", { value: k, text: n })));
    const due = el("input", { type: "date", id: "qa-due" });
    const star = el("input", { type: "checkbox", id: "qa-star" });
    const add = () => { const v = title.value.trim(); if (!v) { setStatus("Type the task first."); return; } setStatus("");
      put("items", { id: newId(), list: job === "absolute" || job === "personal" ? "life" : job, section: sec.value, title: v, detail: "", done: false, update: "", due: due.value, star: star.checked, order: Date.now(), by: "jodi", createdAt: nowIso() });
      title.value = ""; due.value = ""; star.checked = false; setStatus("Added: " + v); title.focus(); renderTabs(); };
    title.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); } });
    box.append(field("Task", title), el("div", { class: "row2" }, field("List", sec), field("Due date (optional)", due)), el("label", { class: "chk" }, star, " Do first"),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Add task", onclick: add }), el("button", { type: "button", class: "btn ghost", text: "Done", onclick: close })));
  } else if (job === "tpam") {
    const code = el("input", { type: "text", id: "qa-first", placeholder: "e.g. BPC", maxlength: 10 }), name = el("input", { type: "text", id: "qa-name", maxlength: 80 }), bank = el("input", { type: "text", id: "qa-bank", maxlength: 40 }), cam = el("input", { type: "text", id: "qa-cam", maxlength: 40 });
    const big = el("input", { type: "checkbox", id: "qa-big" });
    box.append(el("div", { class: "row2" }, field("Code", code), field("Association name", name), field("Bank", bank), field("CAM", cam)), el("label", { class: "chk" }, big, " Big association (CAM needs 4 business days)"),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Add association", onclick: () => { const c = code.value.trim().toUpperCase(); if (!c || !name.value.trim()) { setStatus("Add a code and a name."); return; }
        put("assoc", { id: c, code: c, name: name.value.trim(), bank: bank.value.trim(), cam: cam.value.trim(), camDays: big.checked ? 4 : 2, order: assocs().length + 1, void: false }); setStatus("Added " + c + "."); S.qa = null; go("tpam"); } })));
  } else if (job === "vicki") {
    const existing = live("vclients").sort((a, b) => a.name.localeCompare(b.name));
    const pick = el("select", { id: "qa-pick" }, el("option", { value: "", text: "New client…" }), ...existing.map(c => el("option", { value: c.id, text: c.name })));
    const name = el("input", { type: "text", id: "qa-first", placeholder: "Client name", maxlength: 80 });
    const soft = el("select", { id: "qa-soft" }, ...V_SOFT.map(([k, n]) => el("option", { value: k, text: n })));
    const pri = el("select", { id: "qa-pri" }, ...PRIORITY.map(([k, n]) => el("option", { value: String(k), text: n }))); pri.value = "2";
    const recv = el("input", { type: "month", id: "qa-rec" });
    const boxes = V_SVCS.map(([k, n]) => { const cb = el("input", { type: "checkbox", id: "qa-s-" + k }); if (k === S.vsvc) cb.checked = true; return [k, cb, el("label", { class: "chk" }, cb, " " + n)]; });
    box.append(field("Client name", name), field("Or add a service to an existing client", pick), el("div", { class: "subhead", text: "What you do for them" }), el("div", { class: "chks" }, ...boxes.map(b => b[2])),
      el("div", { class: "row2" }, field("Software", soft), field("Priority", pri), field("Received through (optional)", recv)),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Add client", onclick: () => {
        let cid = pick.value;
        if (!cid) { const n = name.value.trim(); if (!n) { setStatus("Type the client's name."); return; } cid = "c" + newId(); put("vclients", { id: cid, name: n, software: soft.value, void: false }); }
        let any = false;
        for (const [k, cb] of boxes) if (cb.checked) { any = true; const id = k + "-" + cid, ex = DB.vwork.get(id); put("vwork", ex ? { ...ex, void: false } : { id, client: cid, svc: k, freq: "m", start: recv.value || "", cthru: "", rthru: recv.value || "", vstep: "", priority: Number(pri.value), blocker: "", note: "", void: false }); }
        if (!any) { setStatus("Pick at least one service."); return; }
        setStatus("Added."); S.qa = null; go("vicki"); } })));
  } else {
    const name = el("input", { type: "text", id: "qa-first", maxlength: 80 });
    const type = el("select", { id: "qa-type" }, el("option", { value: "books", text: "Monthly bookkeeping" }), el("option", { value: "va", text: "Assistant / per job" }), el("option", { value: "weekly", text: "Weekly meetings" }));
    const svc = el("input", { type: "text", id: "qa-svc", maxlength: 120, placeholder: "e.g. Monthly bookkeeping, payroll records" });
    const fee = el("input", { type: "number", id: "qa-fee", min: "0", inputmode: "decimal" });
    const start = el("input", { type: "month", id: "qa-start" }); start.value = prevMonth();
    box.append(field("Client name", name), el("div", { class: "row2" }, field("Type", type), field("Fee ($)", fee)), field("What I do for them", svc), field("First month due (earlier for cleanup)", start),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Add client", onclick: () => {
        if (!name.value.trim()) { setStatus("Type the client's name."); return; }
        put("aclients", { id: "a" + newId(), name: name.value.trim(), type: type.value, services: svc.value.trim(), start: start.value || prevMonth(), dueDay: type.value === "va" ? 3 : 15, fee: Number(fee.value) || 0, order: aClients().length + 1, void: false });
        setStatus("Added."); S.qa = null; go("absolute"); } })));
  }
  return box;
}

/* ================= TO-DOS (per job + Personal) ================= */
const allItems = () => live("items").filter(i => i.title);
const itemsFor = list => allItems().filter(i => i.list === list);
const listName = k => (LISTS.find(l => l.key === k) || {}).name || k;
function sortItems(a, b) { const da = a.due || "9999", db = b.due || "9999"; return (a.done - b.done) || ((b.star ? 1 : 0) - (a.star ? 1 : 0)) || (da < db ? -1 : da > db ? 1 : 0) || ((a.order || 0) - (b.order || 0)); }
function todoSection(job) {
  const map = { tpam: ["tpam", ["follow", "other"]], vicki: ["vicki", ["office"]], absolute: ["life", ["absolute"]] }[job];
  const [list, secs] = map, L = LISTS.find(l => l.key === list);
  const wrap = el("div", {});
  for (const [key, name] of L.sections.filter(s => secs.includes(s[0]))) wrap.append(listSection(L, key, name));
  return wrap;
}
function renderPersonal(main) {
  const L = LISTS.find(l => l.key === "life");
  for (const [key, name] of L.sections.filter(s => s[0] !== "absolute")) main.append(listSection(L, key, name));
  const note = DB.notes.get("life") || {};
  const ta = el("textarea", { id: "notes-life", placeholder: "New tasks, things that changed, what's done…" }); ta.value = note.text || "";
  const save = () => put("notes", { id: "life", text: ta.value });
  ta.addEventListener("input", () => saveLater("note:life", save, "ns-life")); ta.addEventListener("blur", () => flush("note:life", save, "ns-life"));
  main.append(el("div", { class: "notes" }, el("label", { for: "notes-life", text: "Notes for Claude" }), el("div", { class: "hint", text: "Write anything here, then tell Claude \"check my list.\"" }), ta, el("div", { class: "saved", id: "ns-life" })));
}
function listSection(L, key, name) {
  const its = itemsFor(L.key).filter(i => i.section === key).sort(sortItems), open = its.filter(i => !i.done), done = its.filter(i => i.done), sk = L.key + ":" + key;
  const ul = el("ul");
  for (const it of open) ul.append(itemRow(it));
  if (S.showDone.has(sk)) for (const it of done) ul.append(itemRow(it));
  if (!open.length) ul.append(el("li", { class: "empty", text: done.length ? "All done here." : "Nothing here right now." }));
  const sec = el("section", {}, el("h2", {}, el("span", { text: name }), el("small", { text: its.length ? open.length + " left" : "" })), ul);
  if (done.length) sec.append(el("button", { type: "button", class: "link", text: (S.showDone.has(sk) ? "Hide done (" : "Show done (") + done.length + ")", onclick: () => { S.showDone.has(sk) ? S.showDone.delete(sk) : S.showDone.add(sk); render(true); } }));
  sec.append(addRow(L.key, key));
  return sec;
}
function listCard(title, its, empty) {
  const c = card(title, its.length ? its.length + " left" : ""), ul = el("ul");
  for (const it of its) ul.append(itemRow(it, { showList: true }));
  if (!its.length) ul.append(el("li", { class: "empty", text: empty }));
  c.append(ul); return c;
}
function patch(id, fields, keepFocus) { const it = DB.items.get(id); if (!it) return; if (fields.done) S.edit.delete(id); put("items", { ...it, ...fields, updatedBy: "jodi" }); if (!keepFocus) render(true); else mark("s-" + id, "Saved"); }
function itemRow(it, opts) {
  opts = opts || {};
  const id = it.id, sfx = opts.showList ? "-t" : "", editing = S.edit.has(id), di = dueInfo(it.due);
  const cb = el("input", { type: "checkbox", class: "box", id: "cb-" + id + sfx, "aria-labelledby": "t-" + id + sfx }); cb.checked = !!it.done;
  cb.addEventListener("change", () => patch(id, { done: cb.checked, doneAt: cb.checked ? nowIso() : "" }));
  const chips = el("div", { class: "chips" }, opts.showList ? el("span", { class: "chip", text: it.list === "life" && it.section === "absolute" ? "Absolute" : listName(it.list) }) : null,
    it.star && !opts.showList ? el("span", { class: "chip star", text: "★ Do first" }) : null, di ? el("span", { class: "chip " + di.cls, text: di.label }) : null);
  const body = el("div", { class: "body" }, el("label", { class: "title", id: "t-" + id + sfx, for: cb.id, text: it.title }), it.detail ? el("div", { class: "detail", text: it.detail }) : null,
    chips.childNodes.length ? chips : null, !editing && it.update && it.update.trim() ? el("div", { class: "latest", text: it.update.trim() }) : null);
  if (!it.done) body.append(el("div", { class: "acts" },
    el("button", { type: "button", class: "link", "aria-pressed": it.star ? "true" : "false", text: it.star ? "★ Do first" : "☆ Do first", onclick: () => patch(id, { star: !it.star }) }),
    el("button", { type: "button", class: "link", "aria-expanded": editing ? "true" : "false", text: editing ? "Close" : "Update / due date", onclick: () => { editing ? S.edit.delete(id) : S.edit.add(id); render(true); } })));
  if (editing) {
    const ta = el("textarea", { id: "u-" + id, placeholder: "What's the latest?" }); ta.value = it.update || "";
    const save = () => { const cur = DB.items.get(id); if (cur) put("items", { ...cur, update: ta.value, updatedBy: "jodi" }); };
    ta.addEventListener("input", () => saveLater("item:" + id, save, "s-" + id)); ta.addEventListener("blur", () => flush("item:" + id, save, "s-" + id));
    const due = el("input", { type: "date", id: "d-" + id }); due.value = it.due || ""; due.addEventListener("change", () => patch(id, { due: due.value }, true));
    body.append(el("div", { class: "editor" }, el("div", {}, el("label", { for: ta.id, text: "Latest update" }), ta, el("div", { class: "saved", id: "s-" + id })),
      field("Due date", due), el("button", { type: "button", class: "btn ghost", text: "Done editing", onclick: () => { S.edit.delete(id); render(true); } })));
  }
  return el("li", { class: "item" + (it.done ? " done" : "") }, cb, body);
}
function addRow(list, section) {
  const inp = el("input", { type: "text", id: "add-" + list + "-" + section, placeholder: "Add a to-do", "aria-label": "Add a to-do", maxlength: 200, enterkeyhint: "done" });
  const doAdd = () => { const v = inp.value.trim(); if (!v) return; inp.value = ""; put("items", { id: newId(), list, section, title: v, detail: "", done: false, update: "", order: Date.now(), by: "jodi", createdAt: nowIso() }); render(true); const n = document.getElementById(inp.id); if (n) n.focus(); };
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doAdd(); } });
  return el("div", { class: "add" }, inp, el("button", { type: "button", class: "btn", text: "Add", onclick: doAdd }));
}

/* ================= TIME CLOCK ================= */
function weekStart(d) { const x = new Date(d || new Date()); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
const CJOBS = [["tpam", "TPAM"], ["vicki", "Vicki's"], ["absolute", "Absolute"]];
function targetFor(job) { if (job === "tpam") return 20; if (job === "vicki") return new Date() >= new Date(2027, 0, 1) ? 40 : 32; return null; }
const liveTime = () => live("time").filter(e => e.start);
const running = () => liveTime().find(e => !e.end);
function weekHours() { const ws = weekStart(), out = {}; for (const e of liveTime()) { const s = new Date(e.start), en = e.end ? new Date(e.end) : new Date(); if (en <= ws) continue; out[e.job] = (out[e.job] || 0) + (en - Math.max(s, ws)) / 36e5; } return out; }
function fmtH(h) { const m = Math.round(h * 60); return Math.floor(m / 60) + "h " + pad(m % 60) + "m"; }
const jobName = k => (CJOBS.find(j => j[0] === k) || [, k])[1];
function runningText() { const r = running(); return r ? "On the clock: " + jobName(r.job) + " since " + fmtTime(new Date(r.start)) + " (" + fmtH((Date.now() - new Date(r.start)) / 36e5) + ")" : "Not on the clock."; }
function clockCard() {
  const r = running(), c = card("Time clock", "Week of " + shortDate(weekStart()));
  c.append(el("div", { class: "clockbtns" }, ...CJOBS.map(([k, n]) => { const on = !!(r && r.job === k); return el("button", { type: "button", class: "clockbtn" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false", onclick: () => on ? stopClock() : startClock(k) }, n, el("span", { class: "cb-act", text: on ? "Tap to stop" : "Start" })); })),
    el("div", { class: "running", id: "running", text: runningText() }));
  const wk = weekHours(), bars = el("div", { class: "bars" });
  for (const [k, n] of CJOBS) { const t = targetFor(k), h = wk[k] || 0; const row = el("div", { class: "bar" }, el("span", { text: n }), el("span", { class: "bar-v", id: "wk-" + k, text: fmtH(h) + (t ? " of " + t + "h" : "") })); if (t) { const f = el("div", { class: "fill" + (h > t ? " over" : ""), id: "wf-" + k }); f.style.width = Math.min(100, h / t * 100) + "%"; row.append(el("div", { class: "track" }, f)); } bars.append(row); }
  c.append(bars);
  const det = el("details", {}, el("summary", { text: "Add time by hand or fix an entry" })); if (S.timeOpen) det.open = true; det.addEventListener("toggle", () => { S.timeOpen = det.open; });
  const job = el("select", { id: "m-job" }, ...CJOBS.map(([k, n]) => el("option", { value: k, text: n })));
  const date = el("input", { type: "date", id: "m-date" }); date.value = todayStr();
  const hrs = el("input", { type: "number", id: "m-hrs", min: "0.25", max: "16", step: "0.25", placeholder: "1.5", inputmode: "decimal" });
  det.append(el("div", { class: "manual" }, field("Job", job), field("Date", date), field("Hours", hrs), el("button", { type: "button", class: "btn", text: "Add", onclick: () => addManual(job.value, date.value, Number(hrs.value)) })));
  const ws = weekStart(), entries = liveTime().filter(e => new Date(e.end || Date.now()) > ws).sort((a, b) => a.start < b.start ? 1 : -1), ul = el("ul", { class: "entries" });
  for (const e of entries) { const s = new Date(e.start), en = e.end ? new Date(e.end) : null, conf = S.confirm === "t:" + e.id;
    ul.append(el("li", {}, el("span", { text: DAYS[s.getDay()].slice(0, 3) + " " + shortDate(s) + " · " + jobName(e.job) + " · " + (e.manual ? "added by hand" : fmtTime(s) + "–" + (en ? fmtTime(en) : "now")) + " · " + fmtH(((en || new Date()) - s) / 36e5) }),
      el("button", { type: "button", class: "link", text: conf ? "Tap again to remove" : "Remove", onclick: () => { if (conf) { S.confirm = ""; put("time", { ...e, void: true }); } else S.confirm = "t:" + e.id; render(true); } }))); }
  if (!entries.length) ul.append(el("li", { class: "empty", text: "No time logged this week yet." }));
  det.append(el("div", { class: "subhead", text: "This week" }), ul); c.append(det);
  return c;
}
function tick() { const r = $("#running"); if (r) r.textContent = runningText(); if (!running()) return; const wk = weekHours(); for (const [k] of CJOBS) { const v = document.getElementById("wk-" + k), t = targetFor(k), h = wk[k] || 0; if (v) v.textContent = fmtH(h) + (t ? " of " + t + "h" : ""); const f = document.getElementById("wf-" + k); if (f && t) { f.style.width = Math.min(100, h / t * 100) + "%"; f.classList.toggle("over", h > t); } } }
function startClock(job) { const t = nowIso(), r = running(); if (r) put("time", { ...r, end: t }); put("time", { id: newId(), job, start: t, end: "", void: false, manual: false }); render(true); }
function stopClock() { const r = running(); if (r) { put("time", { ...r, end: nowIso() }); render(true); } }
function addManual(job, date, hrs) { if (!date || !(hrs > 0) || hrs > 16) { setStatus("Enter the hours as a number, like 1.5."); return; } setStatus(""); const s = parseYmd(date); s.setHours(9, 0, 0, 0); put("time", { id: newId(), job, start: s.toISOString(), end: new Date(s.getTime() + hrs * 36e5).toISOString(), void: false, manual: true }); render(true); }

/* ================= SETTINGS ================= */
function renderSettings(main) {
  const url = el("input", { type: "text", id: "set-url", placeholder: "https://script.google.com/macros/s/…/exec", autocomplete: "off", spellcheck: "false" });
  const tok = el("input", { type: "text", id: "set-tok", placeholder: "Sync code", autocomplete: "off", spellcheck: "false" });
  if (config) { url.value = config.url; tok.value = config.token; }
  const msg = el("div", { class: "saved", id: "set-msg" });
  const save = async () => {
    const u = url.value.trim(), t = tok.value.trim();
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) { msg.textContent = "That link should start with https://script.google.com/"; return; }
    if (t.length < 8) { msg.textContent = "Paste the whole sync code."; return; }
    msg.textContent = "Checking…";
    try { const got = await fetchJson(u + "?token=" + encodeURIComponent(t) + "&ping=1"); if (!got.ok) { msg.textContent = got.error === "bad_token" ? "The Sheet answered, but the sync code doesn't match." : "The Sheet answered with an error."; return; } }
    catch (e) { msg.textContent = "Couldn't reach that link. Check you deployed it with access for \"Anyone\"."; return; }
    config = { url: u, token: t }; LS.set("hub:config", config); msg.textContent = "Connected. Syncing now…"; await sync(); go("home");
  };
  main.append(card("Connect your Google Sheet", "", el("div", { class: "hint", text: "Paste the web app link and the sync code. You only do this once per device." }),
    field("Web app link", url), field("Sync code", tok), el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Save and connect", onclick: save })), msg));
  if (config) {
    const link = location.origin + location.pathname + "#setup=" + btoa(JSON.stringify(config)), cmsg = el("div", { class: "saved" });
    main.append(card("Set up your other device", "", el("div", { class: "hint", text: "Copy this link, text or email it to yourself, and open it on your phone or computer. Keep it private: anyone with it can see your lists." }),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn ghost", text: "Copy setup link", onclick: async () => { try { await navigator.clipboard.writeText(link); cmsg.textContent = "Copied."; } catch (_) { cmsg.textContent = link; } } })), cmsg));
  }
  main.append(card("Sync and backup", "", el("div", { class: "hint", text: syncText().text }),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Sync now", disabled: !config, onclick: () => sync() }), el("button", { type: "button", class: "btn ghost", text: "Download a backup", onclick: backup }))));
  main.append(card("Install on this device", "", el("ul", { class: "steps" },
    el("li", { text: "iPhone: open this page in Safari, tap Share, then Add to Home Screen." }),
    el("li", { text: "Android: open it in Chrome, tap ⋮, then Install app." }),
    el("li", { text: "Dell (Chrome or Edge): click the install icon at the right end of the address bar." })), el("div", { class: "hint small", text: "Version " + APP_VERSION })));
}
function backup() {
  const data = { exportedAt: nowIso(), version: APP_VERSION }; for (const k of KINDS) data[k] = [...DB[k].values()];
  const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: "todo-hub-backup-" + todayStr() + ".json" });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= typing saves ================= */
function mark(id, t) { const n = document.getElementById(id); if (n) n.textContent = t; }
function saveLater(key, fn, statusId) { clearTimeout(timers.get(key)); if (statusId) mark(statusId, "Saving…"); timers.set(key, setTimeout(() => { timers.delete(key); fn(); if (statusId) mark(statusId, "Saved"); }, 700)); }
function flush(key, fn, statusId) { if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); fn(); if (statusId) mark(statusId, "Saved"); } if (S.dirty) setTimeout(() => render(), 0); }

/* ================= start ================= */
(function start() {
  loadLocal();
  const valid = k => TABS.some(t => t[0] === k) || k === "settings";
  const takeSetup = h => { try { const c = JSON.parse(atob(h.slice(6))); if (c.url && c.token) { config = { url: c.url, token: c.token }; LS.set("hub:config", config); setStatus(""); } } catch (_) { setStatus("That setup link didn't work. Copy it again from your other device."); } history.replaceState(null, "", location.pathname + "#home"); S.tab = "home"; };
  const h = (location.hash || "").slice(1);
  if (h.startsWith("setup=")) takeSetup(h); else if (valid(h)) S.tab = h;
  addEventListener("hashchange", () => { const k = location.hash.slice(1); if (k.startsWith("setup=")) { takeSetup(k); render(true); sync(); return; } if (valid(k) && k !== S.tab) { S.tab = k; render(true); } });
  $("#gear").addEventListener("click", () => go("settings"));
  $("#fab").addEventListener("click", () => { openQuickAdd(S.tab === "home" ? "task" : (S.tab === "personal" ? "task" : "client")); window.scrollTo(0, 0); });
  render(true); renderSync(); sync();
  let day = todayStr();
  setInterval(() => { tick(); if (todayStr() !== day) { day = todayStr(); render(); } }, 20000);
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);
  addEventListener("online", () => sync()); addEventListener("offline", renderSync);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); sync(); } });
  addEventListener("storage", e => { if (e.key === "hub:data") { loadLocal(); render(); } });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
