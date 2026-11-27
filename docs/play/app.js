/* app — the Mail Merge page. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * (c) 2026 Dr Sohil Momin
 *
 * Wiring only. Every decision about what a merge is lives in merge-core.js, which the
 * tests exercise directly. This file reads the DOM, keeps the status file, and opens
 * mailto: links. It has no transport: there is no code here that could send anything.
 */
(function () {
  "use strict";

  var Core = window.MergeCore;
  var $ = function (id) { return document.getElementById(id); };

  var K_STATUS = "mailmerge:status";
  var K_SHEET = "mailmerge:sheet";
  var K_TEMPLATE = "mailmerge:template";
  var K_MAPPING = "mailmerge:mapping";

  var els = {
    sheet: $("sheetText"), file: $("file"), drop: $("drop"), sheetInfo: $("sheetInfo"),
    example: $("example"), status: $("status"),
    subject: $("subject"), body: $("body"), addressCol: $("addressCol"), prepare: $("prepare"),
    messages: $("messages"), msgEmpty: $("msgEmpty"), msgStats: $("msgStats"), msgExport: $("msgExport"),
    cTotal: $("cTotal"), cPrepared: $("cPrepared"), cOpened: $("cOpened"), cMarked: $("cMarked"), cExcluded: $("cExcluded"),
    exportMessages: $("exportMessages"), exportStatus: $("exportStatus"), exportNote: $("exportNote"),
    reportTpl: $("reportTpl"), assemble: $("assemble"), saveMapping: $("saveMapping"),
    exportReport: $("exportReport"), mappingInfo: $("mappingInfo"),
    reportOutCard: $("reportOutCard"), reportOut: $("reportOut"), provBody: $("provTable").querySelector("tbody")
  };

  var state = {
    csv: null,
    sheetName: "",
    messages: [],
    excluded: [],
    entries: [],
    report: null,
    mapping: null,
    when: ""
  };

  /* ------------------------------------------------------------- helpers */

  function today() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + "/" + d.getFullYear();
  }

  function now() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return today() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function setStatus(kind, msg) {
    els.status.className = "status show " + kind;
    els.status.textContent = msg;
  }

  function clearStatus() { els.status.className = "status"; els.status.textContent = ""; }

  function node(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* Storage is optional and never assumed. A refusal is reported, not swallowed. */
  /* store() used to return a failure nobody printed: every handler went on to say the work was done. It now
   * reports, and okStatus() refuses to overwrite the report. */
  var lastStoreFailed = false;
  function store(key, value) {
    try {
      window.localStorage.setItem(key, value);
      lastStoreFailed = false;
      return { ok: true };
    } catch (e) {
      lastStoreFailed = true;
      var why = e && e.name === "QuotaExceededError" ? "storage is full" : "storage is unavailable";
      setStatus("bad", "NOT SAVED: " + why + ". What is on screen will not survive a reload.");
      return { ok: false, reason: why };
    }
  }
  function okStatus(message) { if (!lastStoreFailed) setStatus("ok", message); }

  function load(key) {
    try { return { ok: true, value: window.localStorage.getItem(key) }; }
    catch (e) { return { ok: false, value: null }; }
  }

  function remove(key) {
    try { window.localStorage.removeItem(key); return { ok: true }; }
    catch (e) { return { ok: false }; }
  }

  /* ---------------------------------------------------------------- sheet */

  function readSheet(text, name) {
    var csv = Core.parseCSV(text);
    state.csv = csv.ok ? csv : null;
    state.sheetName = name || "(pasted)";
    if (!csv.ok) {
      els.sheetInfo.textContent = "Not read.";
      els.addressCol.innerHTML = "";
      els.addressCol.appendChild(node("option", null, "— read a sheet first —"));
      els.addressCol.firstChild.value = "";
      setStatus("bad", csv.reason);
      return false;
    }
    els.sheetInfo.textContent = csv.header.length + " columns · " + csv.rows.length + " rows · " + state.sheetName;

    els.addressCol.innerHTML = "";
    csv.header.forEach(function (h) {
      var o = node("option", null, h);
      o.value = h;
      els.addressCol.appendChild(o);
    });
    var guess = Core.pickAddressColumn(csv.header);
    if (guess) els.addressCol.value = guess;

    var saved = store(K_SHEET, text);
    if (!saved.ok) setStatus("warn", "The sheet was read, but it could not be saved on this device: " + saved.reason + ". It stays in this tab only.");

    /* A saved mapping is checked before anything is assembled from a new file. */
    var m = load(K_MAPPING);
    if (m.ok && m.value) {
      var parsed = null;
      try { parsed = JSON.parse(m.value); } catch (e) { parsed = null; }
      if (parsed) {
        state.mapping = parsed;
        var check = Core.checkMapping(parsed, csv);
        if (!check.ok) setStatus("bad", check.reason);
        else els.mappingInfo.textContent = "Columns match the saved mapping (" + parsed.columns.length + " columns, saved " + (parsed.sourceName || "earlier") + ").";
      }
    }
    return true;
  }

  function loadSaved() {
    var s = load(K_SHEET);
    if (s.ok && s.value) { els.sheet.value = s.value; readSheet(s.value, "(saved)"); }
    var t = load(K_TEMPLATE);
    if (t.ok && t.value) {
      try {
        var parsed = JSON.parse(t.value);
        if (parsed.subject) els.subject.value = parsed.subject;
        if (parsed.body) els.body.value = parsed.body;
        if (parsed.report) els.reportTpl.value = parsed.report;
      } catch (e) { /* a template that cannot be read is simply not restored */ }
    }
  }

  function saveTemplate() {
    var saved = store(K_TEMPLATE, JSON.stringify({
      subject: els.subject.value, body: els.body.value, report: els.reportTpl.value
    }));
    if (!saved.ok) setStatus("warn", "The template could not be saved on this device: " + saved.reason + ".");
    return saved;
  }

  /* ------------------------------------------------------------- messages */

  function renderMessages() {
    els.messages.textContent = "";
    var live = state.messages.filter(function (m) {
      return !state.entries.length || state.entries.some(function (e) { return e.row === m.row; });
    });
    if (!state.messages.length) {
      els.msgEmpty.hidden = false;
      els.msgStats.hidden = true;
      els.msgExport.hidden = true;
      return;
    }
    els.msgEmpty.hidden = true;
    els.msgStats.hidden = false;
    els.msgExport.hidden = false;

    state.messages.forEach(function (m) {
      var entry = state.entries.filter(function (e) { return e.row === m.row; })[0];
      var status = entry ? entry.status : Core.STATUS.PREPARED;
      var li = node("li", "msg");

      var head = node("div", "head");
      head.appendChild(node("span", "to", m.to));
      head.appendChild(node("span", "chip " + (status === Core.STATUS.MARKED ? "marked" : status === Core.STATUS.OPENED ? "opened" : ""), status));
      head.appendChild(node("span", null, "row " + m.row));
      li.appendChild(head);

      if (m.subject) li.appendChild(node("div", "says", "Subject: " + m.subject));
      li.appendChild(node("div", "body", m.body));

      var bar = node("div", "bar");
      var open = node("a", "small", "Open in mail client");
      open.href = Core.mailtoFor(m);
      open.setAttribute("role", "button");
      open.style.cssText = "font:inherit;font-size:12px;padding:4px 9px;border:1px solid var(--line);border-radius:7px;text-decoration:none;color:inherit;background:#fff";
      open.addEventListener("click", function () { mark(m.row, Core.STATUS.OPENED); });
      bar.appendChild(open);

      var copy = node("button", "small", "Copy text");
      copy.addEventListener("click", function () { copyText(m.body, copy); });
      bar.appendChild(copy);

      var sent = node("button", "small", status === Core.STATUS.MARKED ? "Marked sent ✓" : "I sent this");
      sent.addEventListener("click", function () {
        mark(m.row, status === Core.STATUS.MARKED ? Core.STATUS.OPENED : Core.STATUS.MARKED);
        renderMessages();
        renderCounts();
      });
      bar.appendChild(sent);
      li.appendChild(bar);
      els.messages.appendChild(li);
    });

    els.cExcluded.textContent = state.excluded.length;
    void live;
  }

  function renderCounts() {
    var c = Core.counts(state.entries);
    els.cTotal.textContent = state.messages.length;
    els.cPrepared.textContent = c.prepared;
    els.cOpened.textContent = c.opened;
    els.cMarked.textContent = c.marked;
  }

  function mark(row, status) {
    var hit = false;
    state.entries.forEach(function (e) { if (e.row === row) { e.status = status; e.at = now(); hit = true; } });
    if (!hit) {
      var m = state.messages.filter(function (x) { return x.row === row; })[0];
      if (m) state.entries.push({ row: row, to: m.to, subject: m.subject, status: status, at: now() });
    }
    persistStatus();
    renderCounts();
    renderMessages();
  }

  function persistStatus() {
    var saved = store(K_STATUS, Core.serializeStatus({ savedOn: now(), batch: state.sheetName, entries: state.entries }));
    if (!saved.ok) setStatus("warn", "The status could not be saved on this device: " + saved.reason + ". The messages are still on screen; export the status before closing the tab.");
    else if (els.exportNote) els.exportNote.textContent = "Status saved on this device (" + state.entries.length + " entries).";
    return saved;
  }

  function prepare() {
    clearStatus();
    if (!state.csv) { setStatus("bad", "Read a sheet first — there is nothing to merge."); return; }
    var result = Core.buildMessages({
      csv: state.csv,
      template: els.body.value,
      subjectTemplate: els.subject.value,
      addressColumn: els.addressCol.value
    });
    if (!result.ok) {
      els.messages.textContent = "";
      state.messages = [];
      state.excluded = result.excluded || [];
      els.msgEmpty.hidden = false;
      els.msgEmpty.textContent = result.reason;
      els.msgStats.hidden = true;
      els.msgExport.hidden = true;
      setStatus("bad", result.reason);
      return;
    }
    state.messages = result.messages;
    state.excluded = result.excluded;
    state.when = today();
    state.entries = result.messages.map(function (m) {
      return { row: m.row, to: m.to, subject: m.subject, status: Core.STATUS.PREPARED, at: now() };
    });
    var st = persistStatus();
    renderMessages();
    renderCounts();
    var tpl2 = saveTemplate();

    var msg = state.messages.length + " message(s) prepared from " + state.csv.rows.length + " row(s). They were composed here and not sent — open each one in your mail client.";
    if (state.excluded.length) {
      msg += " " + state.excluded.length + " row(s) were excluded: " +
        state.excluded.map(function (e) { return "row " + e.row + " (" + e.reason + ")"; }).join("; ") + ".";
    }
    /* a cheerful line here would overwrite the two warnings above: "prepared" is only true if it was kept */
    if (st.ok && tpl2 && tpl2.ok) okStatus(msg);
  }

  function copyText(text, button) {
    var done = function () { button.textContent = "Copied"; setTimeout(function () { button.textContent = "Copy text"; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { setStatus("warn", "The browser refused the clipboard. Select the text and copy it by hand."); });
      return;
    }
    setStatus("warn", "This browser has no clipboard access. Select the text and copy it by hand.");
  }

  /* --------------------------------------------------------------- report */

  function assemble() {
    clearStatus();
    if (!state.csv) { setStatus("bad", "Read a sheet first — there is nothing to assemble a report from."); return; }
    var r = Core.buildReport({ csv: state.csv, template: els.reportTpl.value, sourceName: state.sheetName });
    if (!r.ok) {
      els.reportOutCard.hidden = true;
      setStatus("bad", r.reason);
      return;
    }
    state.report = r;
    els.reportOutCard.hidden = false;
    els.reportOut.textContent = r.text;
    els.provBody.textContent = "";
    r.figures.forEach(function (f) {
      var tr = node("tr");
      tr.appendChild(node("td", null, "{{" + f.placeholder + "}}"));
      tr.appendChild(node("td", null, f.column));
      tr.appendChild(node("td", null, f.value));
      tr.appendChild(node("td", null, f.rows.join(", ")));
      tr.appendChild(node("td", null, f.sourceName));
      els.provBody.appendChild(tr);
    });
    els.exportReport.hidden = false;
    /* the template save reports its own failure; a cheerful line here would overwrite it */
    var tpl = saveTemplate();
    if (!tpl || tpl.ok) okStatus("Report assembled from " + r.rows + " row(s) of " + r.sourceName + ", with " + r.figures.length + " figure(s), each traced to its column and rows.");
  }

  function saveMapping() {
    if (!state.csv) { setStatus("bad", "Read a sheet first — there are no columns to remember."); return; }
    var mapping = Core.makeMapping(state.csv, state.sheetName);
    var saved = store(K_MAPPING, JSON.stringify(mapping));
    if (!saved.ok) { setStatus("bad", "The mapping could not be saved: " + saved.reason + "."); return; }
    state.mapping = mapping;
    els.mappingInfo.textContent = "Mapping saved: " + mapping.columns.length + " columns from " + mapping.sourceName + ".";
    okStatus("This file's columns are remembered. Next month's file is checked against them before anything is assembled.");
  }

  /* --------------------------------------------------------------- export */

  function writer(name, text, mime) {
    if (!window.Export || typeof window.Export.save !== "function") throw new Error("the export kit did not load");
    window.Export.save(name, text, mime);
    return true;
  }

  function doExport(what) {
    var payload;
    if (what === "status") payload = { entries: state.entries, produced: state.messages.length };
    else if (what === "messages") payload = { messages: state.messages, produced: state.messages.length };
    else payload = Object.assign({}, state.report || {}, { produced: state.report ? state.report.figures.length : 0 });

    var outcome = Core.exportAll(what, payload, { when: state.when || today() }, writer);
    if (outcome.ok) {
      els.exportNote.textContent = "Wrote " + outcome.filename + " (" + outcome.bytes + " bytes).";
      okStatus("Wrote " + outcome.filename + ". The messages are still not sent — the file is the record, your mail client is the sender.");
    } else {
      els.exportNote.textContent = "";
      setStatus("bad", "The batch is intact, but " + outcome.reason + ".");
    }
  }

  /* ---------------------------------------------------------------- files */

  function acceptFile(file) {
    if (!file) return;
    var okType = /\.(csv|tsv|txt)$/i.test(file.name) || /^text\//.test(file.type || "");
    if (!okType) {
      setStatus("bad", "refused: " + file.name + " is not a CSV or text file. Nothing was merged.");
      return;
    }
    var reader = new FileReader();
    reader.onerror = function () { setStatus("bad", "The file " + file.name + " could not be read. Nothing was merged."); };
    reader.onload = function () {
      var text = String(reader.result);
      els.sheet.value = text;
      if (readSheet(text, file.name)) okStatus("Read " + file.name + ": " + state.csv.header.length + " columns, " + state.csv.rows.length + " rows.");
    };
    reader.readAsText(file);
  }

  ["dragenter", "dragover"].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (ev) {
    els.drop.addEventListener(ev, function (e) { e.preventDefault(); els.drop.classList.remove("over"); });
  });
  els.drop.addEventListener("drop", function (e) {
    acceptFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  els.file.addEventListener("change", function () {
    acceptFile(els.file.files && els.file.files[0]);
    els.file.value = "";
  });

  /* ------------------------------------------------------------- example */

  var EXAMPLE = "Name,Email,Amount,Month\n" +
    "Asha Kulkarni,asha@example.com,\"1,00,000\",November\n" +
    "Ravi Deshmukh,ravi@example.com,\"45,000\",November\n" +
    "Meera Iyer,meera@example.com,\"12,500\",November";

  /* ----------------------------------------------------------------- wire */

  els.sheet.addEventListener("input", function () { readSheet(els.sheet.value, "(pasted)"); });
  els.prepare.addEventListener("click", prepare);
  els.assemble.addEventListener("click", assemble);
  els.saveMapping.addEventListener("click", saveMapping);
  els.exportMessages.addEventListener("click", function () { doExport("messages"); });
  els.exportStatus.addEventListener("click", function () { doExport("status"); });
  els.exportReport.addEventListener("click", function () { doExport("report"); });
  els.example.addEventListener("click", function () {
    els.sheet.value = EXAMPLE;
    els.subject.value = "Invoice for {{Name}}";
    els.body.value = "Dear {{Name}},\n\nYour invoice for Rs {{Amount}} for {{Month}} is ready.\n\nThank you.";
    els.reportTpl.value = "Amount invoiced: Rs {{Amount}}\nPrepared for: {{Name}}\nMonth: {{Month}}";
    readSheet(EXAMPLE, "(example)");
    okStatus("Example loaded: three invented rows. Press Prepare messages, or Assemble report.");
  });

  ["messages", "report"].forEach(function (name) {
    var tab = $("tab-" + name);
    tab.addEventListener("click", function () {
      ["messages", "report"].forEach(function (other) {
        var on = other === name;
        $("tab-" + other).setAttribute("aria-selected", on ? "true" : "false");
        $("panel-" + other).hidden = !on;
      });
    });
  });

  /* ---------------------------------------------------------- start up */

  var statusRaw = load(K_STATUS);
  if (statusRaw.ok && statusRaw.value) {
    var parsed = Core.parseStatus(statusRaw.value);
    if (parsed.ok) {
      state.entries = parsed.data.entries;
    } else {
      /* A damaged status file is reported and offered for export; the sheet and the
         template are kept under their own keys, so neither is lost with it. */
      setStatus("bad", parsed.reason);
      els.msgExport.hidden = false;
      els.exportNote.textContent = "The saved status file is unreadable — export it to keep it, or clear it.";
      var keep = node("button", "small", "Export the unreadable status file");
      keep.addEventListener("click", function () {
        var out = Core.exportAll("status", { entries: [{ row: "-", to: "-", subject: "unreadable status file", status: Core.STATUS.PREPARED, at: "" }], produced: 0 }, { when: today() }, writer);
        void out;
        try {
          writer("mail-merge-unreadable-status.txt", parsed.raw, "text/plain;charset=utf-8");
          els.exportNote.textContent = "Wrote mail-merge-unreadable-status.txt.";
        } catch (e) {
          setStatus("bad", "The unreadable status file was not written: " + (e && e.message ? e.message : "storage is unavailable") + ".");
        }
      });
      els.exportNote.parentNode.insertBefore(keep, els.exportNote);
      var clear = node("button", "small", "Clear the saved status");
      clear.addEventListener("click", function () {
        remove(K_STATUS);
        state.entries = [];
        okStatus("The saved status was cleared. The sheet and the template are untouched.");
        renderCounts();
        renderMessages();
      });
      els.exportNote.parentNode.insertBefore(clear, els.exportNote);
    }
  }

  loadSaved();
  if (state.entries.length) { renderCounts(); renderMessages(); }
  if (window.Loom && window.Loom.pwa) window.Loom.pwa.register("sw.js");
})();
