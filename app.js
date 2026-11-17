"use strict";
/* Jodi's To-Do Hub
   Works offline: everything is kept on this device first, then synced to
   Jodi's Google Sheet through her Apps Script web app when there's a connection. */

const APP_VERSION = "1.0.0";
const LISTS = [
  { key: "tpam", name: "TPAM", sections: [["oct", "October financials"], ["follow", "Follow-ups"], ["other", "Other TPAM"]] },
  { key: "vicki", name: "Vicki's Office", sections: [["office", "Office to-dos"], ["ready", "Ready to work"], ["review", "Needs review"], ["waiting", "Waiting on docs"], ["hold", "On hold"]] },
  { key: "life", name: "Absolute & Life", sections: [["absolute", "Absolute Bookkeeping"], ["money", "Money"], ["errands", "Health, calls & errands"], ["jobs", "Job search"], ["home", "Home"], ["grocery", "Grocery list"]] }
];
const TABS = [["today", "Today"], ["tpam", "TPAM"], ["vicki", "Vicki's"], ["life", "Absolute & Life"], ["close", "Month-end"]];
const STATUS = [["", "To do"], ["waiting", "Waiting on someone"], ["review", "Needs review"], ["hold", "On hold"]];
const STAGES = {
  tpam: ["Statement in", "Reconciled", "Prepared", "IK review", "Sent to CAM", "CAM approved", "Sent to board"],
  vicki: ["Docs in", "Categorized", "Reconciled", "Review", "Filed / sent"],
  absolute: ["Docs in", "Categorized", "Reconciled", "Reports sent", "Invoiced"]
};
const CJOBS = [["tpam", "TPAM"], ["vicki", "Vicki's"], ["absolute", "Absolute"]];
const ROTATION = { 1: [["HCAI", "Hillwood"], ["BPC", "Brighton Place"]], 2: [["MOA", "Marisol"], ["PBH", "Palm Bay"]], 3: [["PTCA", "Palmetto Trace"], ["PWCA", "Palms West"]], 4: [["SGI", "Sawgrass Island"], ["RVE", "Rivers Edge"]] };
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const KINDS = ["items", "close", "time", "rotation", "notes"];
const BOOL = new Set(["done", "star", "void", "manual"]);
const NUM = new Set(["stage", "order"]);

/* ================= storage + sync ================= */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } }
};
const DB = { items: new Map(), close: new Map(), time: new Map(), rotation: new Map(), notes: new Map() };
let queue = {};            // "kind:id" -> { kind, rec }
let config = LS.get("hub:config", null); // { url, token }
let lastSync = LS.get("hub:lastSync", "");
let syncState = { busy: false, error: "", timer: 0 };

function norm(rec) {
  const o = { ...rec };
  for (const k of Object.keys(o)) {
    if (BOOL.has(k)) o[k] = o[k] === true || o[k] === "true" || o[k] === "TRUE";
    else if (NUM.has(k)) o[k] = Number(o[k]) || 0;
    else if (o[k] == null) o[k] = "";
    else o[k] = String(o[k]);
  }
  return o;
}
function loadLocal() {
  const data = LS.get("hub:data", {});
  for (const k of KINDS) DB[k] = new Map((data[k] || []).map(r => [r.id, norm(r)]));
  queue = LS.get("hub:queue", {});
}
function saveLocal() {
  const data = {}; for (const k of KINDS) data[k] = [...DB[k].values()];
  const ok = LS.set("hub:data", data) && LS.set("hub:queue", queue);
  if (!ok) setStatus("This device is out of storage space. Your changes may not be kept.");
}
const nowIso = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* Every change goes through here: save on the device, queue for the Sheet. */
function put(kind, rec) {
  const r = norm({ ...rec, updatedAt: nowIso() });
  DB[kind].set(r.id, r);
  queue[kind + ":" + r.id] = { kind, rec: r };
  saveLocal();
  scheduleSync(1500);
  return r;
}
function scheduleSync(ms) { clearTimeout(syncState.timer); syncState.timer = setTimeout(sync, ms); }

async function sync() {
  renderSync();
  if (!config || !config.url || syncState.busy) return;
  if (!navigator.onLine) { renderSync(); return; }
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
        if (queue[k + ":" + remote.id]) continue;               // our newer change is still on its way up
        if (!local || (remote.updatedAt || "") >= (local.updatedAt || "")) DB[k].set(remote.id, remote);
      }
    }
    lastSync = nowIso(); LS.set("hub:lastSync", lastSync);
    syncState.error = "";
    saveLocal();
  } catch (e) {
    syncState.error = String(e && e.message || e);
  } finally {
    syncState.busy = false;
    render();
    renderSync();
  }
}
async function fetchJson(url, opts) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { ...(opts || {}), signal: ctl.signal, redirect: "follow" });
    const txt = await r.text();
    try { return JSON.parse(txt); } catch (_) { throw new Error(r.ok ? "not_json" : "http_" + r.status); }
  } finally { clearTimeout(t); }
}
function syncText() {
  const n = Object.keys(queue).length;
  if (!config) return { cls: "wait", text: "Not syncing yet. Saved on this device only." };
  if (syncState.busy) return { cls: "", text: "Syncing…" };
  if (!navigator.onLine) return { cls: "wait", text: "Offline." + (n ? " " + n + " change" + (n > 1 ? "s" : "") + " will sync later." : " Everything is saved here.") };
  if (syncState.error) {
    const why = syncState.error === "bad_token" ? "The sync code doesn't match the Sheet." : "Couldn't reach your Google Sheet.";
    return { cls: "err", text: why + (n ? " " + n + " change" + (n > 1 ? "s" : "") + " waiting." : "") };
  }
  if (n) return { cls: "wait", text: n + " change" + (n > 1 ? "s" : "") + " waiting to sync" };
  return { cls: "", text: lastSync ? "Synced " + fmtTime(new Date(lastSync)) : "Not synced yet" };
}
function renderSync() { const s = syncText(), n = $("#sync"); if (n) { n.textContent = s.text; n.className = "sync " + s.cls; } }

/* ================= helpers ================= */
const S = { tab: "today", edit: new Set(), showDone: new Set(), period: "open", cjob: "all", timeOpen: false, confirm: "", dirty: false };
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
function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const shortDate = d => (d.getMonth() + 1) + "/" + d.getDate();
const fmtTime = d => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function periodLabel(p) { const [y, m] = p.split("-").map(Number); return (MONTHS[m - 1] || p) + " " + y; }

/* ================= items ================= */
const listName = k => (LISTS.find(l => l.key === k) || {}).name || k;
const isWaiting = it => it.status === "waiting" || it.section === "waiting";
const isHeld = it => it.status === "hold" || it.section === "hold";
const allItems = () => [...DB.items.values()].filter(i => i.title && !i.void);
const itemsFor = list => allItems().filter(i => i.list === list);
function dueInfo(s) {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const today = parseYmd(ymd(new Date())), d = parseYmd(s), diff = Math.round((d - today) / 864e5);
  if (diff < 0) return { cls: "over", label: "Overdue · " + shortDate(d), diff };
  if (diff === 0) return { cls: "today", label: "Due today", diff };
  if (diff === 1) return { cls: "today", label: "Due tomorrow", diff };
  return { cls: "", label: "Due " + DAYS[d.getDay()].slice(0, 3) + " " + shortDate(d), diff };
}
function sortItems(a, b) {
  const da = a.due || "9999", dbb = b.due || "9999";
  return (a.done - b.done) || ((b.star ? 1 : 0) - (a.star ? 1 : 0)) || (da < dbb ? -1 : da > dbb ? 1 : 0) || ((a.order || 0) - (b.order || 0));
}
function patch(id, fields, keepFocus) {
  const it = DB.items.get(id); if (!it) return;
  if (fields.done) S.edit.delete(id);
  put("items", { ...it, ...fields, updatedBy: "jodi" });
  if (!keepFocus) render(true); else { mark("s-" + id, "Saved"); renderTabs(); }
}

/* ================= time ================= */
function weekStart(d) { const x = new Date(d || new Date()); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - x.getDay()); return x; }
function targetFor(job) { if (job === "tpam") return 20; if (job === "vicki") return new Date() >= new Date(2027, 0, 1) ? 40 : 32; return null; }
const liveTime = () => [...DB.time.values()].filter(e => !e.void && e.start);
const running = () => liveTime().find(e => !e.end);
function weekHours() {
  const ws = weekStart(), out = {};
  for (const e of liveTime()) {
    const s = new Date(e.start), en = e.end ? new Date(e.end) : new Date();
    if (en <= ws) continue;
    out[e.job] = (out[e.job] || 0) + (en - Math.max(s, ws)) / 36e5;
  }
  return out;
}
function fmtH(h) { const m = Math.round(h * 60); return Math.floor(m / 60) + "h " + pad(m % 60) + "m"; }
const jobName = k => (CJOBS.find(j => j[0] === k) || [, k])[1];
function runningText() {
  const r = running(); if (!r) return "Not on the clock.";
  return "On the clock: " + jobName(r.job) + " since " + fmtTime(new Date(r.start)) + " (" + fmtH((Date.now() - new Date(r.start)) / 36e5) + ")";
}

/* ================= render ================= */
function renderTabs() {
  const nav = $("#tabs"); nav.replaceChildren();
  for (const [k, name] of TABS) {
    let ct;
    if (k === "today") ct = todayCount() + " to look at";
    else if (k === "close") ct = closeRows("open", "all").length + " open";
    else ct = itemsFor(k).filter(i => !i.done && !isWaiting(i) && !isHeld(i)).length + " to do";
    nav.append(el("button", { type: "button", "aria-current": S.tab === k ? "page" : null, onclick: () => go(k) }, name, el("span", { class: "ct", text: ct })));
  }
}
function go(k) { S.tab = k; S.confirm = ""; try { history.replaceState(null, "", "#" + k); } catch (_) { location.hash = k; } render(true); window.scrollTo(0, 0); }

function render(force) {
  const ae = document.activeElement;
  if (!force && ae && (ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || (ae.tagName === "INPUT" && ae.type !== "checkbox"))) { S.dirty = true; return; }
  S.dirty = false;
  renderTabs();
  const main = $("#main"); main.replaceChildren();
  if (S.tab === "today") renderToday(main);
  else if (S.tab === "close") renderClose(main);
  else if (S.tab === "settings") renderSettings(main);
  else renderList(main, LISTS.find(l => l.key === S.tab) || LISTS[0]);
  renderSync();
}

/* ---------- Today ---------- */
const doFirst = () => allItems().filter(i => !i.done && i.star).sort(sortItems);
const dueSoon = () => allItems().filter(i => !i.done && !i.star && dueInfo(i.due) && dueInfo(i.due).diff <= 3).sort((a, b) => a.due < b.due ? -1 : a.due > b.due ? 1 : 0);
function rotDone(key) { const r = DB.rotation.get(key); return new Set(r && r.done ? r.done.split(",").filter(Boolean) : []); }
function recOpen() {
  const d = new Date(), dow = d.getDay(), out = [], mon = addDays(weekStart(d), 1);
  for (let i = 0; i < 4; i++) {
    const day = addDays(mon, i); if (day > d) break;
    const done = rotDone(ymd(day));
    for (const [code, name] of ROTATION[day.getDay()]) out.push({ day, key: ymd(day), code, name, done: done.has(code), isToday: ymd(day) === ymd(d) });
  }
  return { dow, list: out };
}
const todayCount = () => doFirst().length + dueSoon().length + recOpen().list.filter(x => !x.done).length;

function renderToday(main) {
  const d = new Date();
  main.append(el("div", { class: "dayline", text: DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate() }));
  if (!config) main.append(el("div", { class: "card" },
    el("div", { class: "hint", text: "This app saves on this device. Connect it to your Google Sheet so your phone and computer stay in sync." }),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Connect my Google Sheet", onclick: () => go("settings") }))));

  const tiles = el("div", { class: "tiles" });
  for (const L of LISTS) {
    const its = itemsFor(L.key).filter(i => !i.done);
    const todo = its.filter(i => !isWaiting(i) && !isHeld(i)).length, wait = its.filter(isWaiting).length;
    tiles.append(el("button", { type: "button", class: "tile", onclick: () => go(L.key) },
      el("b", { text: String(todo) }), el("span", { class: "tn", text: L.name + " to do" }), el("br"),
      el("span", { class: "tw", text: wait ? wait + " waiting on someone" : "Nothing waiting" })));
  }
  tiles.append(el("button", { type: "button", class: "tile", onclick: () => go("close") },
    el("b", { text: String(closeRows("open", "all").length) }), el("span", { class: "tn", text: "Month-end open" }), el("br"),
    el("span", { class: "tw", text: "Clients and associations not finished" })));
  main.append(tiles);

  main.append(listCard("h-df", "Do first", doFirst(), "Nothing marked yet. Tap \"☆ Do first\" on any item to put it here."));
  main.append(recCard());
  main.append(listCard("h-ds", "Due in the next 3 days", dueSoon(), "Nothing due. Give an item a due date and it shows up here."));
  main.append(clockCard());
  const waits = allItems().filter(i => !i.done && i.status === "waiting").sort(sortItems);
  if (waits.length) {
    const det = el("details", { class: "card" }, el("summary", { text: "Waiting on someone (" + waits.length + ")" }));
    const ul = el("ul"); for (const it of waits) ul.append(itemRow(it, { showList: true }));
    det.append(ul); main.append(det);
  }
}
function listCard(hid, title, its, empty) {
  const card = el("section", { class: "card", "aria-labelledby": hid }, el("h2", { id: hid }, el("span", { text: title }), el("small", { text: its.length ? its.length + " left" : "" })));
  const ul = el("ul"); for (const it of its) ul.append(itemRow(it, { showList: true }));
  if (!its.length) ul.append(el("li", { class: "empty", text: empty }));
  card.append(ul); return card;
}
function recCard() {
  const { dow, list } = recOpen();
  const card = el("section", { class: "card", "aria-labelledby": "h-rec" },
    el("h2", { id: "h-rec" }, el("span", { text: "TPAM recs in Vantaca" }), el("small", { text: dow === 5 ? "Friday catch-up" : dow >= 1 && dow <= 4 ? DAYS[dow] + " pair" : "Weekend" })));
  const todays = list.filter(x => x.isToday), missed = list.filter(x => !x.isToday && !x.done);
  if (dow === 0 || dow === 6) card.append(el("div", { class: "hint", text: "No rec pair on weekends. Monday is Hillwood + Brighton Place." }));
  if (dow === 5) card.append(el("div", { class: "hint", text: missed.length ? "Catch up on these from this week:" : "Every rec this week is checked off. Nice." }));
  for (const x of todays) card.append(recRow(x));
  if (dow >= 1 && dow <= 5 && missed.length) {
    if (dow !== 5) card.append(el("div", { class: "subhead", text: "Skipped earlier this week" }));
    for (const x of missed) card.append(recRow(x));
  }
  return card;
}
function recRow(x) {
  const id = "rec-" + x.key + "-" + x.code;
  const cb = el("input", { type: "checkbox", class: "box", id }); cb.checked = x.done;
  cb.addEventListener("change", () => {
    const set = rotDone(x.key); cb.checked ? set.add(x.code) : set.delete(x.code);
    put("rotation", { id: x.key, done: [...set].join(",") }); render(true);
  });
  return el("div", { class: "rec" + (x.done ? " done" : "") }, cb,
    el("label", { for: id }, el("span", { class: "code", text: x.code }), x.name + (x.isToday ? "" : " · " + DAYS[x.day.getDay()].slice(0, 3))));
}

function clockCard() {
  const r = running();
  const card = el("section", { class: "card", "aria-labelledby": "h-clock" },
    el("h2", { id: "h-clock" }, el("span", { text: "Time clock" }), el("small", { text: "Week of " + shortDate(weekStart()) })));
  const btns = el("div", { class: "clockbtns" });
  for (const [k, name] of CJOBS) {
    const on = !!(r && r.job === k);
    btns.append(el("button", { type: "button", class: "clockbtn" + (on ? " on" : ""), "aria-pressed": on ? "true" : "false",
      onclick: () => on ? stopClock() : startClock(k) }, name, el("span", { class: "cb-act", text: on ? "Tap to stop" : "Start" })));
  }
  card.append(btns, el("div", { class: "running", id: "running", text: runningText() }));
  const wk = weekHours(), bars = el("div", { class: "bars" });
  for (const [k, name] of CJOBS) {
    const t = targetFor(k), h = wk[k] || 0;
    const row = el("div", { class: "bar" }, el("span", { text: name }), el("span", { class: "bar-v", id: "wk-" + k, text: fmtH(h) + (t ? " of " + t + "h" : "") }));
    if (t) { const f = el("div", { class: "fill" + (h > t ? " over" : ""), id: "wf-" + k }); f.style.width = Math.min(100, h / t * 100) + "%"; row.append(el("div", { class: "track" }, f)); }
    bars.append(row);
  }
  card.append(bars);

  const det = el("details", {}, el("summary", { text: "Add time by hand or fix an entry" }));
  if (S.timeOpen) det.open = true;
  det.addEventListener("toggle", () => { S.timeOpen = det.open; });
  const job = el("select", { id: "m-job" }, ...CJOBS.map(([k, n]) => el("option", { value: k, text: n })));
  const date = el("input", { type: "date", id: "m-date" }); date.value = ymd(new Date());
  const hrs = el("input", { type: "number", id: "m-hrs", min: "0.25", max: "16", step: "0.25", placeholder: "1.5", inputmode: "decimal" });
  det.append(el("div", { class: "manual" },
    el("div", { class: "field" }, el("label", { for: "m-job", text: "Job" }), job),
    el("div", { class: "field" }, el("label", { for: "m-date", text: "Date" }), date),
    el("div", { class: "field" }, el("label", { for: "m-hrs", text: "Hours" }), hrs),
    el("button", { type: "button", class: "btn", text: "Add", onclick: () => addManual(job.value, date.value, Number(hrs.value)) })));
  const ws = weekStart();
  const entries = liveTime().filter(e => new Date(e.end || Date.now()) > ws).sort((a, b) => a.start < b.start ? 1 : -1);
  const ul = el("ul", { class: "entries" });
  for (const e of entries) {
    const s = new Date(e.start), en = e.end ? new Date(e.end) : null;
    const txt = DAYS[s.getDay()].slice(0, 3) + " " + shortDate(s) + " · " + jobName(e.job) + " · " + (e.manual ? "added by hand" : fmtTime(s) + "–" + (en ? fmtTime(en) : "now")) + " · " + fmtH(((en || new Date()) - s) / 36e5);
    const conf = S.confirm === "t:" + e.id;
    ul.append(el("li", {}, el("span", { text: txt }),
      el("button", { type: "button", class: "link", text: conf ? "Tap again to remove" : "Remove",
        onclick: () => { if (conf) { S.confirm = ""; put("time", { ...e, void: true }); render(true); } else { S.confirm = "t:" + e.id; render(true); } } })));
  }
  if (!entries.length) ul.append(el("li", { class: "empty", text: "No time logged this week yet." }));
  det.append(el("div", { class: "subhead", text: "This week" }), ul);
  card.append(det);
  return card;
}
function tick() {
  const r = $("#running"); if (r) r.textContent = runningText();
  if (!running()) return;
  const wk = weekHours();
  for (const [k] of CJOBS) {
    const v = document.getElementById("wk-" + k), t = targetFor(k), h = wk[k] || 0;
    if (v) v.textContent = fmtH(h) + (t ? " of " + t + "h" : "");
    const f = document.getElementById("wf-" + k); if (f && t) { f.style.width = Math.min(100, h / t * 100) + "%"; f.classList.toggle("over", h > t); }
  }
}
function startClock(job) {
  const t = nowIso(), r = running();
  if (r) put("time", { ...r, end: t });
  put("time", { id: newId(), job, start: t, end: "", void: false, manual: false });
  render(true);
}
function stopClock() { const r = running(); if (r) { put("time", { ...r, end: nowIso() }); render(true); } }
function addManual(job, date, hrs) {
  if (!date || !(hrs > 0) || hrs > 16) { setStatus("Enter the hours as a number, like 1.5."); return; }
  setStatus("");
  const s = parseYmd(date); s.setHours(9, 0, 0, 0);
  put("time", { id: newId(), job, start: s.toISOString(), end: new Date(s.getTime() + hrs * 36e5).toISOString(), void: false, manual: true });
  render(true);
}

/* ---------- lists ---------- */
function renderList(main, L) {
  const all = itemsFor(L.key), known = new Set(L.sections.map(s => s[0]));
  const secs = L.sections.slice();
  if (all.some(i => !known.has(i.section))) secs.push(["_other", "Other"]);
  for (const [key, name] of secs) {
    const its = all.filter(i => key === "_other" ? !known.has(i.section) : i.section === key).sort(sortItems);
    const open = its.filter(i => !i.done), done = its.filter(i => i.done), sk = L.key + ":" + key;
    const ul = el("ul");
    for (const it of open) ul.append(itemRow(it));
    if (S.showDone.has(sk)) for (const it of done) ul.append(itemRow(it));
    if (!open.length) ul.append(el("li", { class: "empty", text: done.length ? "All done here." : "Nothing here right now." }));
    const sec = el("section", { "aria-labelledby": "h-" + sk },
      el("h2", { id: "h-" + sk }, el("span", { text: name }), el("small", { text: its.length ? open.length + " left" : "" })), ul);
    if (done.length) sec.append(el("button", { type: "button", class: "link showdone", "aria-expanded": S.showDone.has(sk) ? "true" : "false",
      text: (S.showDone.has(sk) ? "Hide done (" : "Show done (") + done.length + ")",
      onclick: () => { S.showDone.has(sk) ? S.showDone.delete(sk) : S.showDone.add(sk); render(true); } }));
    if (key !== "_other") sec.append(addRow(L.key, key));
    main.append(sec);
  }
  const note = DB.notes.get(L.key) || {};
  const ta = el("textarea", { id: "notes-" + L.key, placeholder: "New tasks, things that changed, what's done…" });
  ta.value = note.text || "";
  const save = () => put("notes", { id: L.key, text: ta.value });
  ta.addEventListener("input", () => saveLater("note:" + L.key, save, "ns-" + L.key));
  ta.addEventListener("blur", () => flush("note:" + L.key, save, "ns-" + L.key));
  main.append(el("div", { class: "notes" },
    el("label", { for: "notes-" + L.key, text: "Notes for Claude: " + L.name }),
    el("div", { class: "hint", text: "Write anything here, then tell Claude \"check my list.\"" }), ta, el("div", { class: "saved", id: "ns-" + L.key })));
}

function itemRow(it, opts) {
  opts = opts || {};
  const id = it.id, sfx = opts.showList ? "-t" : "", editing = S.edit.has(id), di = dueInfo(it.due);
  const cb = el("input", { type: "checkbox", class: "box", id: "cb-" + id + sfx, "aria-labelledby": "t-" + id + sfx }); cb.checked = !!it.done;
  cb.addEventListener("change", () => patch(id, { done: cb.checked, doneAt: cb.checked ? nowIso() : "" }));
  const st = STATUS.find(s => s[0] && s[0] === it.status);
  const chips = el("div", { class: "chips" },
    opts.showList ? el("span", { class: "chip", text: listName(it.list) }) : null,
    it.star && !opts.showList ? el("span", { class: "chip star", text: "★ Do first" }) : null,
    di ? el("span", { class: "chip " + di.cls, text: di.label }) : null,
    st ? el("span", { class: "chip wait", text: st[1] }) : null);
  const body = el("div", { class: "body" },
    el("label", { class: "title", id: "t-" + id + sfx, for: cb.id, text: it.title }),
    it.detail ? el("div", { class: "detail", text: it.detail }) : null,
    chips.childNodes.length ? chips : null,
    !editing && it.update && it.update.trim() ? el("div", { class: "latest", text: it.update.trim() }) : null);
  if (!it.done) body.append(el("div", { class: "acts" },
    el("button", { type: "button", class: "link", "aria-pressed": it.star ? "true" : "false", text: it.star ? "★ Do first" : "☆ Do first", onclick: () => patch(id, { star: !it.star }) }),
    el("button", { type: "button", class: "link", "aria-expanded": editing ? "true" : "false", text: editing ? "Close" : "Update / due date",
      onclick: () => { editing ? S.edit.delete(id) : S.edit.add(id); render(true); } })));
  if (editing) body.append(editor(it));
  return el("li", { class: "item" + (it.done ? " done" : "") }, cb, body);
}
function editor(it) {
  const id = it.id, L = LISTS.find(l => l.key === it.list) || LISTS[0];
  const ta = el("textarea", { id: "u-" + id, placeholder: "What's the latest?" }); ta.value = it.update || "";
  const save = () => { const cur = DB.items.get(id); if (cur) put("items", { ...cur, update: ta.value, updatedBy: "jodi" }); };
  ta.addEventListener("input", () => saveLater("item:" + id, save, "s-" + id));
  ta.addEventListener("blur", () => flush("item:" + id, save, "s-" + id));
  const due = el("input", { type: "date", id: "d-" + id }); due.value = it.due || "";
  due.addEventListener("change", () => patch(id, { due: due.value }, true));
  const stat = el("select", { id: "st-" + id }, ...STATUS.map(([v, n]) => el("option", { value: v, text: n }))); stat.value = it.status || "";
  stat.addEventListener("change", () => patch(id, { status: stat.value }, true));
  const sec = el("select", { id: "sec-" + id }, ...L.sections.map(([v, n]) => el("option", { value: v, text: n }))); sec.value = it.section;
  sec.addEventListener("change", () => patch(id, { section: sec.value }, true));
  return el("div", { class: "editor" },
    el("div", {}, el("label", { for: ta.id, text: "Latest update" }), ta, el("div", { class: "saved", id: "s-" + id })),
    el("div", { class: "row2" }, el("div", {}, el("label", { for: due.id, text: "Due date" }), due), el("div", {}, el("label", { for: stat.id, text: "Status" }), stat)),
    el("div", {}, el("label", { for: sec.id, text: "Move to" }), sec),
    el("button", { type: "button", class: "btn ghost", text: "Done editing", onclick: () => { S.edit.delete(id); render(true); } }));
}
function addRow(list, section) {
  const inp = el("input", { type: "text", id: "add-" + list + "-" + section, placeholder: "Add an item", "aria-label": "Add an item to this section", maxlength: 200, enterkeyhint: "done" });
  const doAdd = () => {
    const v = inp.value.trim(); if (!v) return; inp.value = "";
    put("items", { id: newId(), list, section, title: v, detail: "", done: false, update: "", order: Date.now(), by: "jodi", createdAt: nowIso() });
    render(true); const n = document.getElementById(inp.id); if (n) n.focus();
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doAdd(); } });
  return el("div", { class: "add" }, inp, el("button", { type: "button", class: "btn", text: "Add", onclick: doAdd }));
}

/* ---------- Month-end close ---------- */
function closeRows(period, job) {
  return [...DB.close.values()].filter(r => !r.void && STAGES[r.job] && r.name &&
    (period === "open" ? r.stage < STAGES[r.job].length : r.period === period) && (job === "all" || r.job === job));
}
function renderClose(main) {
  const periods = [...new Set([...DB.close.values()].filter(r => !r.void && r.period).map(r => r.period))].sort().reverse();
  const sel = el("select", { id: "c-period", "aria-label": "Which month" },
    el("option", { value: "open", text: "Everything still open" }), ...periods.map(p => el("option", { value: p, text: periodLabel(p) })));
  sel.value = S.period; sel.addEventListener("change", () => { S.period = sel.value; render(true); });
  const filters = el("div", { class: "filters", role: "group", "aria-label": "Which job" });
  for (const [k, n] of [["all", "All jobs"], ...CJOBS]) filters.append(el("button", { type: "button", "aria-pressed": S.cjob === k ? "true" : "false", text: n, onclick: () => { S.cjob = k; render(true); } }));
  main.append(el("div", { class: "toolbar" }, el("div", { class: "field" }, el("label", { for: "c-period", text: "Month" }), sel), filters));

  const rows = closeRows(S.period, S.cjob).sort((a, b) =>
    (CJOBS.findIndex(j => j[0] === a.job) - CJOBS.findIndex(j => j[0] === b.job)) ||
    ((a.stage >= STAGES[a.job].length) - (b.stage >= STAGES[b.job].length)) || (a.stage - b.stage) || a.name.localeCompare(b.name));
  const summ = CJOBS.map(([k, n]) => { const r = rows.filter(x => x.job === k); if (!r.length) return null; const d = r.filter(x => x.stage >= STAGES[k].length).length;
    return S.period === "open" ? n + ": " + r.length + " open" : n + ": " + d + " of " + r.length + " done"; }).filter(Boolean);
  main.append(el("div", { class: "summary", text: summ.join(" · ") || "Nothing here." }));
  let lastJob = "";
  for (const r of rows) {
    if (r.job !== lastJob) { lastJob = r.job; main.append(el("section", {}, el("h2", {}, el("span", { text: jobName(r.job) })))); }
    main.append(closeRow(r));
  }
  if (!rows.length) main.append(el("div", { class: "empty", text: S.period === "open" ? "Everything is closed out. Add a client below to start a month." : "No clients for this month and job." }));

  const job = el("select", { id: "c-job" }, ...CJOBS.map(([k, n]) => el("option", { value: k, text: n })));
  if (S.cjob !== "all") job.value = S.cjob;
  const now = new Date(), prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const per = el("input", { type: "text", id: "c-per", inputmode: "numeric" }); per.value = S.period !== "open" ? S.period : prev.getFullYear() + "-" + pad(prev.getMonth() + 1);
  const name = el("input", { type: "text", id: "c-name", placeholder: "Client or association", maxlength: 80, "aria-label": "Client or association" });
  const add = () => {
    const n = name.value.trim(), p = per.value.trim(); if (!n) return;
    if (!/^\d{4}-\d{2}$/.test(p)) { setStatus("Month should look like 2026-11."); return; }
    const id = p + "-" + job.value + "-" + slug(n);
    if (DB.close.has(id) && !DB.close.get(id).void) { setStatus(n + " is already on " + periodLabel(p) + "."); return; }
    setStatus(""); name.value = "";
    put("close", { id, job: job.value, period: p, name: n, sub: "", stage: 0, note: "", void: false, createdAt: nowIso() }); render(true);
  };
  name.addEventListener("keydown", e => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); } });
  main.append(el("section", { class: "card" }, el("h2", {}, el("span", { text: "Add to the board" })),
    el("div", { class: "row2" }, el("div", {}, el("label", { for: "c-job", text: "Job" }), job), el("div", {}, el("label", { for: "c-per", text: "Month (YYYY-MM)" }), per)),
    el("div", { class: "add" }, name, el("button", { type: "button", class: "btn", text: "Add", onclick: add }))));

  if (S.period !== "open" && rows.length) {
    const [y, m] = S.period.split("-").map(Number), nx = new Date(y, m, 1), np = nx.getFullYear() + "-" + pad(nx.getMonth() + 1);
    const conf = S.confirm === "roll:" + S.period;
    main.append(el("div", { class: "card" },
      el("div", { class: "hint", text: "Copy every name on this month into " + periodLabel(np) + ", starting from step one. Nothing here changes." }),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn ghost", text: conf ? "Tap again to start " + periodLabel(np) : "Start " + periodLabel(np),
        onclick: () => {
          if (!conf) { S.confirm = "roll:" + S.period; render(true); return; }
          S.confirm = "";
          for (const r of rows) { const id = np + "-" + r.job + "-" + slug(r.name); if (!DB.close.has(id)) put("close", { id, job: r.job, period: np, name: r.name, sub: r.sub || "", stage: 0, note: "", void: false, createdAt: nowIso() }); }
          S.period = np; render(true);
        } }))));
  }
}
function closeRow(r) {
  const st = STAGES[r.job], n = st.length, complete = r.stage >= n;
  const pills = el("div", { class: "stages", role: "group", "aria-label": "Steps for " + r.name });
  st.forEach((s, i) => pills.append(el("button", { type: "button", class: i < r.stage ? "on" : i === r.stage ? "nextup" : "", "aria-pressed": i < r.stage ? "true" : "false",
    text: s, onclick: () => { put("close", { ...DB.close.get(r.id), stage: r.stage === i + 1 ? i : i + 1 }); render(true); } })));
  const prog = el("div", { class: "prog" }, el("i")); prog.firstChild.style.width = (Math.min(r.stage, n) / n * 100) + "%";
  const note = el("input", { type: "text", id: "cn-" + r.id, placeholder: "Note (waiting on Jeff, missing statement…)", "aria-label": "Note for " + r.name, maxlength: 300 });
  note.value = r.note || "";
  const save = () => { const cur = DB.close.get(r.id); if (cur) put("close", { ...cur, note: note.value }); };
  note.addEventListener("input", () => saveLater("close:" + r.id, save, "cs-" + r.id));
  note.addEventListener("blur", () => flush("close:" + r.id, save, "cs-" + r.id));
  return el("div", { class: "crow" + (complete ? " complete" : "") },
    el("div", { class: "crow-h" }, el("span", { class: "crow-n", text: r.name }),
      el("span", { class: "crow-s", text: [r.sub, S.period === "open" ? periodLabel(r.period) : ""].filter(Boolean).join(" · ") })),
    el("div", { class: "next" }, complete ? el("b", { text: "Done" }) : el("span", {}, "Next: ", el("b", { text: st[r.stage] })), " · step " + Math.min(r.stage, n) + " of " + n),
    prog, pills, note, el("div", { class: "saved", id: "cs-" + r.id }));
}
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "row";

/* ---------- Settings ---------- */
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
    try {
      const got = await fetchJson(u + "?token=" + encodeURIComponent(t) + "&ping=1");
      if (!got.ok) { msg.textContent = got.error === "bad_token" ? "The Sheet answered, but the sync code doesn't match." : "The Sheet answered with an error."; return; }
    } catch (e) { msg.textContent = "Couldn't reach that link. Check you deployed it with access for \"Anyone\"."; return; }
    config = { url: u, token: t }; LS.set("hub:config", config);
    msg.textContent = "Connected. Syncing now…"; await sync(); go("today");
  };
  main.append(el("section", { class: "card" }, el("h2", {}, el("span", { text: "Connect your Google Sheet" })),
    el("div", { class: "hint", text: "Paste the web app link and the sync code from your \"To-Do Hub Sync\" setup. You only do this once per device." }),
    el("div", { class: "field", style: "margin-top:10px" }, el("label", { for: "set-url", text: "Web app link" }), url),
    el("div", { class: "field", style: "margin-top:10px" }, el("label", { for: "set-tok", text: "Sync code" }), tok),
    el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn", text: "Save and connect", onclick: save })), msg));

  if (config) {
    const link = location.origin + location.pathname + "#setup=" + btoa(JSON.stringify(config));
    const cmsg = el("div", { class: "saved" });
    main.append(el("section", { class: "card" }, el("h2", {}, el("span", { text: "Set up your other device" })),
      el("div", { class: "hint", text: "Copy this link, text or email it to yourself, and open it on your phone or computer. It connects that device to the same Sheet. Keep it private: anyone with it can see your lists." }),
      el("div", { class: "btnrow" }, el("button", { type: "button", class: "btn ghost", text: "Copy setup link", onclick: async () => {
        try { await navigator.clipboard.writeText(link); cmsg.textContent = "Copied."; } catch (_) { cmsg.textContent = link; }
      } })), cmsg));
  }

  const n = Object.keys(queue).length;
  main.append(el("section", { class: "card" }, el("h2", {}, el("span", { text: "Sync and backup" })),
    el("div", { class: "hint", text: syncText().text }),
    el("div", { class: "btnrow" },
      el("button", { type: "button", class: "btn", text: "Sync now", disabled: !config, onclick: () => sync() }),
      el("button", { type: "button", class: "btn ghost", text: "Download a backup", onclick: backup })),
    el("div", { class: "hint", style: "margin-top:10px", text: "The backup is a file with every list, close row and time entry, in case you ever want a copy outside the Sheet." })));

  main.append(el("section", { class: "card" }, el("h2", {}, el("span", { text: "Install on this device" })),
    el("ul", { class: "steps" },
      el("li", { text: "iPhone: open this page in Safari, tap Share, then Add to Home Screen." }),
      el("li", { text: "Android: open it in Chrome, tap ⋮, then Install app or Add to Home screen." }),
      el("li", { text: "Dell (Chrome or Edge): click the install icon at the right end of the address bar." })),
    el("div", { class: "hint", style: "margin-top:8px", text: "Version " + APP_VERSION } )));
}
function backup() {
  const data = { exportedAt: nowIso(), version: APP_VERSION }; for (const k of KINDS) data[k] = [...DB[k].values()];
  const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })), download: "todo-hub-backup-" + ymd(new Date()) + ".json" });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ================= saving text as you type ================= */
function mark(id, t) { const n = document.getElementById(id); if (n) n.textContent = t; }
function saveLater(key, fn, statusId) { clearTimeout(timers.get(key)); mark(statusId, "Saving…"); timers.set(key, setTimeout(() => { timers.delete(key); fn(); mark(statusId, "Saved"); }, 700)); }
function flush(key, fn, statusId) { if (timers.has(key)) { clearTimeout(timers.get(key)); timers.delete(key); fn(); mark(statusId, "Saved"); } if (S.dirty) setTimeout(() => render(), 0); }

/* ================= start ================= */
(function start() {
  loadLocal();
  const takeSetup = h => {
    try { const c = JSON.parse(atob(h.slice(6))); if (c.url && c.token) { config = { url: c.url, token: c.token }; LS.set("hub:config", config); setStatus(""); } }
    catch (_) { setStatus("That setup link didn't work. Copy it again from your other device."); }
    history.replaceState(null, "", location.pathname + "#today"); S.tab = "today";
  };
  const h = (location.hash || "").slice(1);
  if (h.startsWith("setup=")) takeSetup(h);
  else if (TABS.some(t => t[0] === h) || h === "settings") S.tab = h;
  addEventListener("hashchange", () => {
    const k = location.hash.slice(1);
    if (k.startsWith("setup=")) { takeSetup(k); render(true); sync(); return; }
    if ((TABS.some(t => t[0] === k) || k === "settings") && k !== S.tab) { S.tab = k; render(true); }
  });
  $("#gear").addEventListener("click", () => go("settings"));
  render(true); renderSync();
  sync();
  setInterval(tick, 20000);
  setInterval(() => { if (document.visibilityState === "visible") sync(); }, 60000);
  addEventListener("online", () => sync());
  addEventListener("offline", renderSync);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") { render(); sync(); } });
  addEventListener("storage", e => { if (e.key === "hub:data") { loadLocal(); render(); } });
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
})();
