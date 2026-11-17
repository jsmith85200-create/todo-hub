/**
 * To-Do Hub Sync — paste this whole file into the Sheet's Apps Script editor
 * (Extensions > Apps Script), replacing what's there.
 *
 * It lets the To-Do Hub app read and save your lists in this Google Sheet.
 * Nothing is ever deleted: removed time entries and close rows are only marked void.
 */

// Your private sync code. The app must use the same code. Don't share it.
const TOKEN = "PASTE-YOUR-SYNC-CODE-HERE";

// Your Absolute CRM sheet and Vicki's office Work Locator (read-only).
const CRM_ID = "1iUBV7LmJoXYNEwcg1AZvklSjNAomTnfPPfVHcSBzYGY";
const WORK_LOCATOR_ID = "1rL2Guj2Q9Ru5YLi-auqM0lTVKzvpzy0l8dLpmN20TTA";

const KINDS = {
  items:    ["id", "list", "section", "title", "detail", "done", "doneAt", "star", "due", "status", "update", "order", "by", "createdAt", "updatedAt", "updatedBy", "void"],
  time:     ["id", "job", "start", "end", "void", "manual", "updatedAt"],
  rotation: ["id", "done", "updatedAt"],
  notes:    ["id", "text", "updatedAt"],
  settings: ["id", "value", "updatedAt"],
  assoc:    ["id", "code", "name", "bank", "cam", "camDays", "order", "void", "updatedAt"],
  tpam:     ["id", "period", "code", "step", "d1", "d2", "d3", "d4", "d5", "blocker", "note", "updatedAt"],
  vclients: ["id", "name", "software", "how", "note", "void", "updatedAt"],
  vwork:    ["id", "client", "svc", "freq", "start", "cthru", "rthru", "vstep", "priority", "blocker", "note", "login", "info", "void", "updatedAt"],
  aclients: ["id", "name", "type", "services", "fee", "start", "dueDay", "lastClassified", "nextDate", "lastMet", "days", "inactive", "blocker", "note", "order", "void", "updatedAt"],
  awork:    ["id", "client", "period", "step", "d1", "d2", "d3", "d4", "invoiced", "blocker", "note", "updatedAt"],
  social:   ["id", "title", "platform", "date", "status", "note", "void", "updatedAt"]
};

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sheetFor_(kind) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(kind);
  if (!sh) {
    sh = ss.insertSheet(kind);
    sh.getRange(1, 1, 1, KINDS[kind].length).setValues([KINDS[kind]]).setFontWeight("bold");
    sh.setFrozenRows(1);
  }
  return sh;
}

// Header row of a tab, adding any column the app needs that isn't there yet.
function headers_(sh, kind) {
  const lastCol = Math.max(sh.getLastColumn(), 1);
  let h = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  while (h.length && h[h.length - 1] === "") h.pop();
  const missing = KINDS[kind].filter(function (c) { return h.indexOf(c) < 0; });
  if (missing.length) {
    sh.getRange(1, h.length + 1, 1, missing.length).setValues([missing]).setFontWeight("bold");
    h = h.concat(missing);
  }
  return h;
}

function readAll_(kind) {
  const sh = sheetFor_(kind), h = headers_(sh, kind), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const idCol = h.indexOf("id");
  return sh.getRange(2, 1, n, h.length).getDisplayValues()
    .filter(function (r) { return r[idCol]; })
    .map(function (r) {
      const o = {};
      h.forEach(function (c, i) { if (c && r[i] !== "") o[c] = r[i]; });
      return o;
    });
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.token !== TOKEN) return out_({ ok: false, error: "bad_token" });
  if (p.ping) return out_({ ok: true, ping: true });
  const data = {};
  Object.keys(KINDS).forEach(function (k) { data[k] = readAll_(k); });
  const res = { ok: true, now: new Date().toISOString(), data: data, crm: [], wl: [] };
  try { res.crm = readCrm_(); } catch (err) { res.crmError = String(err.message || err); }
  try { res.wl = readWorkLocator_(); } catch (err) { res.wlError = String(err.message || err); }
  return out_(res);
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_json" }); }
  if (body.token !== TOKEN) return out_({ ok: false, error: "bad_token" });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const byKind = {}, crm = [];
    (body.changes || []).forEach(function (c) {
      if (c && c.kind === "crm" && c.rec) crm.push(c.rec);
      else if (c && KINDS[c.kind] && c.rec && c.rec.id) (byKind[c.kind] = byKind[c.kind] || []).push(c.rec);
    });
    let applied = 0;
    if (crm.length) applied += writeCrm_(crm);
    Object.keys(byKind).forEach(function (kind) {
      const sh = sheetFor_(kind), h = headers_(sh, kind);
      const idCol = h.indexOf("id"), upCol = h.indexOf("updatedAt");
      const n = sh.getLastRow() - 1;
      const rows = n > 0 ? sh.getRange(2, 1, n, h.length).getDisplayValues() : [];
      const rowOf = {};
      rows.forEach(function (r, i) { if (r[idCol]) rowOf[r[idCol]] = i; });
      const appends = [], appendOf = {};
      byKind[kind].forEach(function (rec) {
        const row = h.map(function (c) {
          const v = rec[c];
          return v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
        });
        if (Object.prototype.hasOwnProperty.call(rowOf, rec.id)) {
          const i = rowOf[rec.id];
          if (String(rows[i][upCol] || "") > String(rec.updatedAt || "")) return; // Sheet already has a newer copy
          rows[i] = row;
          sh.getRange(i + 2, 1, 1, h.length).setNumberFormat("@").setValues([row]);
        } else if (Object.prototype.hasOwnProperty.call(appendOf, rec.id)) {
          appends[appendOf[rec.id]] = row;
        } else {
          appendOf[rec.id] = appends.length;
          appends.push(row);
        }
        applied++;
      });
      if (appends.length) {
        sh.getRange(sh.getLastRow() + 1, 1, appends.length, h.length).setNumberFormat("@").setValues(appends);
      }
    });
    return out_({ ok: true, applied: applied });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- CRM (Master CRM tab: headers on row 8, data from row 9, columns B-L) ---------- */
function crmSheet_() { return SpreadsheetApp.openById(CRM_ID).getSheetByName("Master CRM"); }
function readCrm_() {
  const sh = crmSheet_(), n = sh.getLastRow() - 8;
  if (n < 1) return [];
  return sh.getRange(9, 2, n, 11).getDisplayValues().map(function (r, i) {
    return { row: i + 9, contact: r[0], company: r[1], category: r[2], phone: r[3], email: r[4], service: r[5], last: r[6], next: r[7], status: r[8], notes: r[9], how: r[10] };
  }).filter(function (r) { return r.contact || r.company; });
}
function writeCrm_(list) {
  const sh = crmSheet_(), n = sh.getLastRow() - 8;
  if (n < 1) return 0;
  const vals = sh.getRange(9, 2, n, 2).getDisplayValues();
  let done = 0;
  list.forEach(function (c) {
    let i = Number(c.row) - 9;
    if (!(i >= 0 && i < n && vals[i][0] === c.contact && vals[i][1] === c.company)) {
      i = -1;
      for (let j = 0; j < n; j++) if (vals[j][0] === c.contact && vals[j][1] === c.company) { i = j; break; }
    }
    if (i < 0) return;
    sh.getRange(i + 9, 8, 1, 3).setValues([[c.last || "", c.next || "", c.status || ""]]);
    done++;
  });
  return done;
}

/* ---------- Vicki's Work Locator: open Bookkeeping 2026 rows for Jodi (and Tori's old ones) ---------- */
function readWorkLocator_() {
  const sh = SpreadsheetApp.openById(WORK_LOCATOR_ID).getSheetByName("Bookkeeping 2026"), n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, 10).getDisplayValues().filter(function (r) {
    return r[0] && /^(Jodi|Tori)$/i.test(String(r[2]).trim()) && !/^6/.test(String(r[1]).trim());
  }).map(function (r) {
    return { client: r[0], status: r[1], bookkeeper: r[2], work: r[3], provided: r[4], notes: r[5], contacted: r[6], completed: r[7], invoiced: r[8], days: r[9] };
  });
}

// Optional: run this once from the editor to make sure the tabs exist.
function setupTabs() {
  Object.keys(KINDS).forEach(function (k) { headers_(sheetFor_(k), k); });
}
