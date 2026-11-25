/* merge-core — the engine behind Mail Merge.
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * (c) 2026 Dr Sohil Momin
 *
 * One engine, two outputs, because both jobs are the same job: bind COLUMNS to a
 * template, once per row.
 *
 *   messages  a sheet + a template -> one message per row, handed to your own mail
 *             client as a mailto: link. The app never sends anything.
 *   report    a sheet + a template with figures -> one assembled report where every
 *             figure carries the row and the file it came from.
 *
 * Pure functions only: no DOM, no network, no storage. The page does the wiring.
 *
 * The two things it refuses to do, because the specs say it must not:
 *   - become an email service: there is no transport here, only text and mailto:;
 *   - do arithmetic it cannot show: a placeholder is a COLUMN NAME, never an
 *     expression, and every substituted value is recorded with its row and file.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.MergeCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  var STATUS = { PREPARED: "prepared", OPENED: "opened in mail client", MARKED: "marked sent by you" };

  /* ------------------------------------------------------------------ CSV */

  /* A real CSV reader: quotes, doubled quotes, embedded commas, embedded
   * newlines, CRLF and a BOM. Not a split(','). */
  function parseCSV(text) {
    var src = String(text == null ? "" : text);
    if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
    var rows = [];
    var field = "";
    var row = [];
    var inQuotes = false;
    var i = 0;
    var sawAny = false;

    function endField() { row.push(field); field = ""; }
    function endRow() { endField(); rows.push(row); row = []; }

    while (i < src.length) {
      var ch = src.charAt(i);
      if (inQuotes) {
        if (ch === '"') {
          if (src.charAt(i + 1) === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += ch; i++; continue;
      }
      if (ch === '"') { inQuotes = true; sawAny = true; i++; continue; }
      if (ch === ",") { endField(); sawAny = true; i++; continue; }
      if (ch === "\r") { i++; continue; }
      if (ch === "\n") { endRow(); sawAny = true; i++; continue; }
      field += ch; sawAny = true; i++;
    }
    if (field.length || row.length) endRow();
    while (rows.length && rows[rows.length - 1].every(function (c) { return c === ""; })) rows.pop();

    if (!rows.length) {
      return { ok: false, header: [], rows: [], reason: "the sheet is empty \u2014 there is no header row to read" };
    }
    var header = rows[0].map(function (h) { return String(h).replace(/\s+/g, " ").trim(); });
    if (header.length < 2) {
      return { ok: false, header: header, rows: [], reason: "the header row has " + header.length + " column(s); a sheet needs at least two (one of them an address)" };
    }
    var seen = Object.create(null);
    for (var c = 0; c < header.length; c++) {
      if (!header[c]) return { ok: false, header: header, rows: [], reason: "column " + (c + 1) + " has no name in the header row" };
      var key = header[c].toLowerCase();
      if (seen[key]) return { ok: false, header: header, rows: [], reason: "two columns are both called \u201c" + header[c] + "\u201d \u2014 a sheet with duplicate column names cannot be merged safely" };
      seen[key] = true;
    }

    var out = [];
    for (var r = 1; r < rows.length; r++) {
      var obj = { _row: r + 1 };
      for (var k = 0; k < header.length; k++) obj[header[k]] = rows[r][k] == null ? "" : rows[r][k];
      out.push(obj);
    }
    if (!out.length) {
      return { ok: false, header: header, rows: [], reason: "the sheet has a header row and no data rows" };
    }
    return { ok: true, header: header, rows: out, reason: "" };
  }

  function toCSV(header, rows) {
    function cell(v) {
      var s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }
    var lines = [header.map(cell).join(",")];
    rows.forEach(function (r) {
      lines.push(header.map(function (h) { return cell(r[h]); }).join(","));
    });
    return lines.join("\r\n");
  }

  /* --------------------------------------------------------- placeholders */

  /* {{Column}} only. No expressions, no filters, no arithmetic: a placeholder
   * that is not a column name is refused, by name. */
  function findPlaceholders(template) {
    var out = [];
    var seen = Object.create(null);
    var re = /\{\{([^}]*)\}\}/g;
    var m;
    while ((m = re.exec(String(template || "")))) {
      var name = m[1].trim();
      if (!seen[name]) { seen[name] = true; out.push(name); }
    }
    return out;
  }

  function validateTemplate(template, header) {
    var used = findPlaceholders(template);
    var lower = {};
    header.forEach(function (h) { lower[h.toLowerCase()] = h; });
    var missing = [];
    var resolved = {};
    used.forEach(function (name) {
      var hit = lower[name.toLowerCase()];
      if (hit) { resolved[name] = hit; } else { missing.push(name); }
    });
    if (!used.length) {
      return { ok: false, used: [], missing: [], resolved: {}, reason: "the template has no {{placeholder}}, so every row would produce the same text" };
    }
    if (missing.length) {
      return {
        ok: false, used: used, missing: missing, resolved: resolved,
        reason: "the template asks for " + missing.map(function (m) { return "\u201c{{" + m + "}}\u201d"; }).join(", ") +
          " and the sheet has no such column" + (missing.length > 1 ? "s" : "") +
          ". Columns found: " + header.join(", ") + ". The merge did not run."
      };
    }
    return { ok: true, used: used, missing: [], resolved: resolved, reason: "" };
  }

  function bind(template, row, resolved) {
    return String(template).replace(/\{\{([^}]*)\}\}/g, function (whole, name) {
      var col = resolved[name.trim()];
      if (!col) return whole;
      return row[col] == null ? "" : String(row[col]);
    });
  }

  /* -------------------------------------------------------------- address */

  var ADDRESS_HINTS = [/^e-?mail$/i, /e-?mail/i, /^mail$/i, /address/i, /^to$/i];

  function pickAddressColumn(header) {
    for (var h = 0; h < ADDRESS_HINTS.length; h++) {
      for (var c = 0; c < header.length; c++) {
        if (ADDRESS_HINTS[h].test(header[c])) return header[c];
      }
    }
    return "";
  }

  function looksLikeAddress(v) {
    return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(String(v || "").trim());
  }

  /* ------------------------------------------------------------- messages */

  /* One message per row. Status starts at "prepared" and nothing here can move it
   * further: only the person, in the mail client, can send. */
  function buildMessages(opts) {
    var csv = opts.csv;
    var template = opts.template;
    var subjectTemplate = opts.subjectTemplate || "";
    var addressColumn = opts.addressColumn || "";

    if (!csv || !csv.ok) {
      return { ok: false, reason: (csv && csv.reason) || "no sheet was read", messages: [], excluded: [] };
    }
    if (!addressColumn) {
      return { ok: false, reason: "no address column was chosen, so there is nowhere to send a message. The merge did not run.", messages: [], excluded: [] };
    }
    if (csv.header.indexOf(addressColumn) < 0) {
      return { ok: false, reason: "the chosen address column \u201c" + addressColumn + "\u201d is not in the sheet", messages: [], excluded: [] };
    }
    var bodyCheck = validateTemplate(template, csv.header);
    if (!bodyCheck.ok) return { ok: false, reason: bodyCheck.reason, messages: [], excluded: [], missing: bodyCheck.missing };
    var subjectCheck = subjectTemplate ? validateTemplate(subjectTemplate, csv.header) : { ok: true, resolved: {} };
    if (!subjectCheck.ok) return { ok: false, reason: "in the subject: " + subjectCheck.reason, messages: [], excluded: [], missing: subjectCheck.missing };

    var messages = [];
    var excluded = [];
    csv.rows.forEach(function (row) {
      var to = String(row[addressColumn] || "").trim();
      if (!to) {
        excluded.push({ row: row._row, reason: "no address", who: row[csv.header[0]] || "(row " + row._row + ")" });
        return;
      }
      if (!looksLikeAddress(to)) {
        excluded.push({ row: row._row, reason: "not an email address: " + to, who: row[csv.header[0]] || "(row " + row._row + ")" });
        return;
      }
      messages.push({
        row: row._row,
        to: to,
        subject: subjectTemplate ? bind(subjectTemplate, row, subjectCheck.resolved) : "",
        body: bind(template, row, bodyCheck.resolved),
        status: STATUS.PREPARED
      });
    });

    if (!messages.length) {
      return {
        ok: false, messages: [], excluded: excluded,
        reason: "none of the " + csv.rows.length + " rows has a usable address, so there is nothing to prepare. " + excluded.length + " row(s) were excluded."
      };
    }
    return { ok: true, messages: messages, excluded: excluded, reason: "" };
  }

  /* The only handoff in the app: a mailto: URL the browser gives to the user's own
   * mail client. Header injection is impossible by construction — CR, LF and the
   * delimiters are percent-encoded. */
  function mailtoFor(msg) {
    var to = encodeURIComponent(String(msg.to || "").replace(/[\r\n]/g, ""));
    var q = [];
    if (msg.subject) q.push("subject=" + encodeURIComponent(String(msg.subject).replace(/[\r\n]/g, " ")));
    if (msg.body) q.push("body=" + encodeURIComponent(String(msg.body)));
    return "mailto:" + to + (q.length ? "?" + q.join("&") : "");
  }

  /* ----------------------------------------------------------------- report */

  /* Figures are COLUMN REFERENCES, so the provenance is exact: which column, which
   * row of which file. No expression is evaluated anywhere in this file. */
  function buildReport(opts) {
    var csv = opts.csv;
    var template = opts.template;
    var sourceName = opts.sourceName || "(unnamed file)";
    if (!csv || !csv.ok) return { ok: false, reason: (csv && csv.reason) || "no sheet was read" };
    var check = validateTemplate(template, csv.header);
    if (!check.ok) return { ok: false, reason: check.reason, missing: check.missing };

    var figures = [];
    var text = String(template).replace(/\{\{([^}]*)\}\}/g, function (whole, name) {
      var col = check.resolved[name.trim()];
      if (!col) return whole;
      var values = csv.rows.map(function (r) { return r[col] == null ? "" : String(r[col]); });
      var nonEmpty = values.filter(function (v) { return v !== ""; });
      var distinct = {};
      nonEmpty.forEach(function (v) { distinct[v] = 1; });
      var unique = Object.keys(distinct);
      /* One value across the rows can be printed as itself; more than one cannot be
       * printed as "the" figure without arithmetic, and this app does no arithmetic
       * it cannot show. So it says so and lists the rows. */
      var value;
      var kind;
      if (unique.length === 1) { value = unique[0]; kind = "single value"; }
      else if (unique.length === 0) { value = ""; kind = "empty column"; }
      else {
        value = "[" + unique.length + " values in " + nonEmpty.length + " rows: " + unique.join(", ") + "]";
        kind = "several values";
      }
      figures.push({
        placeholder: name.trim(),
        column: col,
        value: value,
        kind: kind,
        sourceName: sourceName,
        rows: csv.rows.map(function (r) { return r._row; }),
        values: nonEmpty
      });
      return value;
    });

    return { ok: true, text: text, figures: figures, rows: csv.rows.length, sourceName: sourceName, reason: "" };
  }

  /* A saved mapping: the columns a report was assembled from, so next month's file
   * can be checked against it before anything is assembled. */
  function makeMapping(csv, sourceName) {
    return { version: VERSION, sourceName: sourceName || "", columns: csv.header.slice(), rows: csv.rows.length };
  }

  function checkMapping(mapping, csv) {
    if (!mapping || !mapping.columns) {
      return { ok: false, reason: "there is no saved mapping to check this file against" };
    }
    var have = {};
    csv.header.forEach(function (h) { have[h.toLowerCase()] = h; });
    var missing = mapping.columns.filter(function (c) { return !have[c.toLowerCase()]; });
    if (missing.length) {
      return {
        ok: false, missing: missing,
        reason: "this file does not match the saved mapping. Expected columns: " + mapping.columns.join(", ") +
          ". Found: " + csv.header.join(", ") + ". Missing: " + missing.join(", ") +
          ". No report was assembled from a mismatched join."
      };
    }
    return { ok: true, missing: [], reason: "" };
  }

  /* --------------------------------------------------------------- status */

  /* The status file is the only thing this app keeps. It is JSON, versioned, and a
   * damaged one is reported rather than silently replaced. */
  function serializeStatus(data) {
    return JSON.stringify({
      version: VERSION,
      savedOn: data.savedOn || "",
      batch: data.batch || "",
      entries: (data.entries || []).map(function (e) {
        return { row: e.row, to: e.to, subject: e.subject, status: e.status, at: e.at || "" };
      })
    }, null, 2);
  }

  function parseStatus(text) {
    var raw = String(text == null ? "" : text);
    if (!raw.trim()) return { ok: false, reason: "the saved status file is empty", raw: raw };
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return { ok: false, reason: "the saved status file is not readable JSON, so it was not used. The sheet and the template are untouched; export this file to keep it, or clear it to start again.", raw: raw };
    }
    if (!data || typeof data !== "object" || !Array.isArray(data.entries)) {
      return { ok: false, reason: "the saved status file has no entries list, so it was not used. The sheet and the template are untouched.", raw: raw };
    }
    var clean = [];
    data.entries.forEach(function (e) {
      if (!e || typeof e !== "object") return;
      var s = String(e.status || "");
      if ([STATUS.PREPARED, STATUS.OPENED, STATUS.MARKED].indexOf(s) < 0) s = STATUS.PREPARED;
      clean.push({ row: e.row, to: String(e.to || ""), subject: String(e.subject || ""), status: s, at: String(e.at || "") });
    });
    return { ok: true, data: { version: data.version || VERSION, savedOn: String(data.savedOn || ""), batch: String(data.batch || ""), entries: clean }, raw: raw };
  }

  /* What the tracking sheet says, and what it refuses to say: there is no "sent"
   * written by the app. Only the person can mark a message sent. */
  function statusCSV(entries) {
    var header = ["Row", "To", "Subject", "Status", "When"];
    var rows = (entries || []).map(function (e) {
      return { Row: e.row, To: e.to, Subject: e.subject, Status: e.status, When: e.at || "" };
    });
    return toCSV(header, rows);
  }

  function counts(entries) {
    var c = { prepared: 0, opened: 0, marked: 0, total: (entries || []).length };
    (entries || []).forEach(function (e) {
      if (e.status === STATUS.MARKED) c.marked++;
      else if (e.status === STATUS.OPENED) c.opened++;
      else c.prepared++;
    });
    return c;
  }

  /* --------------------------------------------------------------- export */

  function stamp(when) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(when || ""));
    return m ? m[3] + "-" + m[2] + "-" + m[1] : "undated";
  }

  /* writer(name, text, mime) is the only thing that touches a file. A partial batch
   * is never mistaken for a complete one: the failure names how many were produced. */
  function exportAll(what, payload, meta, writer) {
    meta = meta || {};
    if (typeof writer !== "function") return { ok: false, reason: "the file was not written: no writer is available in this browser" };
    var name;
    var body;
    var mime = "text/plain;charset=utf-8";
    if (what === "status") {
      name = "mail-merge-status-" + stamp(meta.when) + ".csv";
      body = statusCSV(payload.entries);
      mime = "text/csv;charset=utf-8";
    } else if (what === "messages") {
      name = "mail-merge-messages-" + stamp(meta.when) + ".md";
      body = messagesMarkdown(payload.messages, meta);
      mime = "text/markdown;charset=utf-8";
    } else if (what === "report") {
      name = "mail-merge-report-" + stamp(meta.when) + ".md";
      body = reportMarkdown(payload, meta);
      mime = "text/markdown;charset=utf-8";
    } else {
      return { ok: false, reason: "nothing was written: unknown export \u201c" + what + "\u201d" };
    }
    try {
      var wrote = writer(name, body, mime);
      if (wrote === false) return { ok: false, filename: name, reason: "the file was not written: the browser refused the save", produced: payload.produced };
      return { ok: true, filename: name, bytes: body.length };
    } catch (e) {
      var why = e && e.name === "QuotaExceededError" ? "storage is full" : (e && e.message ? e.message : "storage is unavailable");
      var produced = payload && typeof payload.produced === "number" ? " (" + payload.produced + " item(s) had been prepared)" : "";
      return { ok: false, filename: name, reason: "the file was not written: " + why + produced, produced: payload && payload.produced };
    }
  }

  function messagesMarkdown(messages, meta) {
    var lines = ["# Mail merge \u2014 " + (messages || []).length + " message(s)", ""];
    lines.push("Prepared " + ((meta && meta.when) || "") + ". **These messages were composed on your device and not sent.**");
    lines.push("");
    (messages || []).forEach(function (m, i) {
      lines.push("## " + (i + 1) + ". To: " + m.to);
      if (m.subject) lines.push("**Subject:** " + m.subject);
      lines.push("");
      lines.push(m.body);
      lines.push("");
    });
    return lines.join("\n");
  }

  function reportMarkdown(report, meta) {
    var lines = ["# Assembled report", ""];
    if (meta && meta.when) lines.push("Assembled " + meta.when + " from " + report.sourceName + " (" + report.rows + " row(s)).");
    lines.push("");
    lines.push(report.text);
    lines.push("");
    lines.push("## Where every figure came from");
    lines.push("");
    lines.push("| Figure | Column | Value | Rows | File |");
    lines.push("|---|---|---|---|---|");
    (report.figures || []).forEach(function (f) {
      lines.push("| {{" + f.placeholder + "}} | " + f.column + " | " + String(f.value).replace(/\|/g, "\\|") + " | " + f.rows.join(", ") + " | " + f.sourceName + " |");
    });
    lines.push("");
    lines.push("No arithmetic was performed: each figure is the value in its column, or the list of values when the column holds more than one.");
    return lines.join("\n");
  }

  return {
    version: VERSION,
    STATUS: STATUS,
    parseCSV: parseCSV,
    toCSV: toCSV,
    findPlaceholders: findPlaceholders,
    validateTemplate: validateTemplate,
    bind: bind,
    pickAddressColumn: pickAddressColumn,
    looksLikeAddress: looksLikeAddress,
    buildMessages: buildMessages,
    mailtoFor: mailtoFor,
    buildReport: buildReport,
    makeMapping: makeMapping,
    checkMapping: checkMapping,
    serializeStatus: serializeStatus,
    parseStatus: parseStatus,
    statusCSV: statusCSV,
    counts: counts,
    exportAll: exportAll,
    messagesMarkdown: messagesMarkdown,
    reportMarkdown: reportMarkdown
  };
});
