/**
 * To-Do Hub Sync — paste this whole file into the Sheet's Apps Script editor
 * (Extensions > Apps Script), replacing what's there.
 *
 * It lets the To-Do Hub app read and save your lists in this Google Sheet.
 * Nothing is ever deleted: removed time entries and close rows are only marked void.
 */

// Your private sync code. The app must use the same code. Don't share it.
const TOKEN = "PASTE-YOUR-SYNC-CODE-HERE";

const KINDS = {
  items:    ["id", "list", "section", "title", "detail", "done", "doneAt", "star", "due", "status", "update", "order", "by", "createdAt", "updatedAt", "updatedBy", "void"],
  close:    ["id", "job", "period", "name", "sub", "stage", "note", "void", "createdAt", "updatedAt"],
  time:     ["id", "job", "start", "end", "void", "manual", "updatedAt"],
  rotation: ["id", "done", "updatedAt"],
  notes:    ["id", "text", "updatedAt"]
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
  return out_({ ok: true, now: new Date().toISOString(), data: data });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: "bad_json" }); }
  if (body.token !== TOKEN) return out_({ ok: false, error: "bad_token" });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const byKind = {};
    (body.changes || []).forEach(function (c) {
      if (c && KINDS[c.kind] && c.rec && c.rec.id) (byKind[c.kind] = byKind[c.kind] || []).push(c.rec);
    });
    let applied = 0;
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

// Optional: run this once from the editor to make sure the tabs exist.
function setupTabs() {
  Object.keys(KINDS).forEach(function (k) { headers_(sheetFor_(k), k); });
}
