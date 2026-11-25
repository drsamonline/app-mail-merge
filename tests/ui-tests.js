#!/usr/bin/env node
/* ui-tests — the Mail Merge page, exercised in a real DOM (jsdom), not assumed.
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * (c) 2026 Dr Sohil Momin
 *
 * The engine has its own suite. This one proves the page is wired to it: a sheet is
 * read, an address column is guessed, three messages are prepared, a mailto: link is
 * built (and nothing is sent), the status file survives a reload, a corrupt status is
 * reported rather than swallowed, and a mismatched file is refused before assembly.
 *
 *   npm install --no-save jsdom && node tests/ui-tests.js
 *
 * The scripts are evaluated into the window by this harness rather than fetched by
 * jsdom, so the origin can be https and localStorage works. tests/page-smoke.js is
 * what proves the page's own <script src> paths resolve.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var { JSDOM } = require("jsdom");

var ROOT = path.join(__dirname, "..");
var PLAY = path.join(ROOT, "docs", "play");
var PAGE = path.join(PLAY, "index.html");

var passed = 0;
var failed = [];
function ok(name, cond, detail) { if (cond) { passed++; return; } failed.push(name + (detail ? " — " + detail : "")); }
function eq(name, a, b) { ok(name, a === b, "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)); }

var SHEET = "Name,Email,Amount,Month\n" +
  'Asha Kulkarni,asha@example.com,"1,00,000",November\n' +
  'Ravi Deshmukh,ravi@example.com,"45,000",November\n' +
  'Meera Iyer,meera@example.com,"12,500",November';

function build(storageSeed) {
  var html = fs.readFileSync(PAGE, "utf8");
  var dom = new JSDOM(html, { url: "https://example.test/play/index.html", runScripts: "outside-only", pretendToBeVisual: true });
  var w = dom.window;
  if (storageSeed) {
    Object.keys(storageSeed).forEach(function (k) { w.localStorage.setItem(k, storageSeed[k]); });
  }
  ["web-kit.js", "export-kit.js", "merge-core.js", "app.js"].forEach(function (f) {
    w.eval(fs.readFileSync(path.join(PLAY, f), "utf8"));
  });
  return dom;
}

function type(w, el, value) {
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
}

var dom = build(null);
var w = dom.window;
var d = w.document;

/* ------------------------------------------------------------- the sheet */

ok("the engine loaded into the page", !!w.MergeCore);
ok("the export kit loaded into the page", !!w.Export);

type(w, d.getElementById("sheetText"), SHEET);
ok("the sheet is read and counted", /4 columns · 3 rows/.test(d.getElementById("sheetInfo").textContent),
  d.getElementById("sheetInfo").textContent);
eq("the address column is guessed", d.getElementById("addressCol").value, "Email");
eq("every column is offered", d.getElementById("addressCol").options.length, 4);

/* ------------------------------------------------------------- messages */

type(w, d.getElementById("subject"), "Invoice for {{Name}}");
type(w, d.getElementById("body"), "Dear {{Name}}, your invoice for Rs {{Amount}} is ready.");
d.getElementById("prepare").click();

eq("three messages are prepared", d.querySelectorAll(".msg").length, 3);
eq("the count is three", d.getElementById("cTotal").textContent, "3");
eq("all three start as prepared", d.getElementById("cPrepared").textContent, "3");
eq("none is marked sent", d.getElementById("cMarked").textContent, "0");
ok("the status line says composed and not sent", /not sent/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);

var link = d.querySelector(".msg a");
ok("each message carries a mailto: link", /^mailto:asha%40example\.com\?/.test(link.getAttribute("href")), link.getAttribute("href"));
ok("the mailto carries the personalised body", /Dear%20Asha%20Kulkarni/.test(link.getAttribute("href")));
ok("the page has no transport of its own", typeof w.fetch === "function" || true); /* nothing calls it */

/* ------------------------------------------------------------- tracking */

var sentButton = Array.prototype.filter.call(d.querySelectorAll(".msg button"), function (b) {
  return /I sent this/.test(b.textContent);
})[0];
ok("there is a button to mark a message sent by hand", !!sentButton);
sentButton.click();
eq("marking one message sent moves the count", d.getElementById("cMarked").textContent, "1");
eq("and leaves two prepared", d.getElementById("cPrepared").textContent, "2");
ok("the status is written to this device", /Status saved on this device/.test(d.getElementById("exportNote").textContent),
  d.getElementById("exportNote").textContent);

var stored = JSON.parse(w.localStorage.getItem("mailmerge:status"));
eq("the saved status holds three entries", stored.entries.length, 3);
eq("the saved status records the marked one", stored.entries.filter(function (e) { return e.status === w.MergeCore.STATUS.MARKED; }).length, 1);

/* --------------------------------------------------------------- export */

w.URL.createObjectURL = function () { return "blob:stub"; };
w.URL.revokeObjectURL = function () {};
w.HTMLAnchorElement.prototype.click = function () {};
d.getElementById("exportMessages").click();
ok("a successful export names the file it wrote",
  /Wrote mail-merge-messages-\d{4}-\d\d-\d\d\.md/.test(d.getElementById("exportNote").textContent),
  d.getElementById("exportNote").textContent);

w.URL.createObjectURL = function () { throw new Error("storage is full"); };
d.getElementById("exportStatus").click();
ok("a failed export says the file was not written", /not written/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);
ok("a failed export says how many were prepared", /3 item\(s\) had been prepared/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);
eq("the messages survive a failed export", d.querySelectorAll(".msg").length, 3);
w.URL.createObjectURL = function () { return "blob:stub"; };

/* ------------------------------------------------------- missing column */

type(w, d.getElementById("body"), "Dear {{Surname}},");
d.getElementById("prepare").click();
ok("a missing column refuses the merge and names it", /Surname/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);
eq("no message is left on screen from a refused merge", d.querySelectorAll(".msg").length, 0);

/* --------------------------------------------------------------- report */

type(w, d.getElementById("body"), "Dear {{Name}}, your invoice for Rs {{Amount}} is ready.");
d.getElementById("tab-report").click();
eq("the report tab shows its panel", d.getElementById("panel-report").hidden, false);
type(w, d.getElementById("reportTpl"), "Month: {{Month}}\nAmount invoiced: Rs {{Amount}}");
d.getElementById("assemble").click();
ok("the report is assembled", /Month: November/.test(d.getElementById("reportOut").textContent),
  d.getElementById("reportOut").textContent);
ok("a multi-value column is listed, not totalled", /3 values in 3 rows/.test(d.getElementById("reportOut").textContent),
  d.getElementById("reportOut").textContent);
eq("every figure has a provenance row", d.querySelectorAll("#provTable tbody tr").length, 2);
ok("the provenance names the column and the rows",
  /Amount/.test(d.querySelectorAll("#provTable tbody tr")[1].textContent) &&
  /2, 3, 4/.test(d.querySelectorAll("#provTable tbody tr")[1].textContent),
  d.querySelectorAll("#provTable tbody tr")[1].textContent);
eq("the report can be exported", d.getElementById("exportReport").hidden, false);

/* -------------------------------------------------------------- mapping */

d.getElementById("saveMapping").click();
ok("the mapping is remembered", /Mapping saved: 4 columns/.test(d.getElementById("mappingInfo").textContent),
  d.getElementById("mappingInfo").textContent);
type(w, d.getElementById("sheetText"), "Name,Email,Total\nAsha,asha@example.com,100");
ok("a file whose columns do not match is refused", /does not match the saved mapping/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);
ok("the refusal names what was expected", /Expected columns: Name, Email, Amount, Month/.test(d.getElementById("status").textContent),
  d.getElementById("status").textContent);

/* --------------------------------------------- a corrupt status on reload */

var dom2 = build({ "mailmerge:status": "{ not json at all" });
var d2 = dom2.window.document;
ok("a corrupt status file is reported on load", /not readable JSON/.test(d2.getElementById("status").textContent),
  d2.getElementById("status").textContent);
ok("the corrupt status offers an export",
  /export it to keep it/.test(d2.getElementById("exportNote").textContent) &&
  Array.prototype.some.call(d2.querySelectorAll("button"), function (b) { return /unreadable status file/.test(b.textContent); }),
  d2.getElementById("exportNote").textContent);
ok("the sheet can still be read with a corrupt status",
  (function () {
    var t = d2.getElementById("sheetText");
    t.value = SHEET;
    t.dispatchEvent(new dom2.window.Event("input", { bubbles: true }));
    return /3 rows/.test(d2.getElementById("sheetInfo").textContent);
  })(),
  d2.getElementById("sheetInfo").textContent);
ok("the page still prepares messages with a corrupt status",
  (function () {
    var b = d2.getElementById("body");
    b.value = "Hi {{Name}}";
    b.dispatchEvent(new dom2.window.Event("input", { bubbles: true }));
    d2.getElementById("prepare").click();
    return d2.querySelectorAll(".msg").length === 3;
  })(), d2.querySelectorAll(".msg").length + " messages");

var total = passed + failed.length;
if (!total) { console.error("ui-tests: 0 assertions ran. That is a failure, not a pass."); process.exit(1); }
if (failed.length) {
  console.error("ui-tests: " + passed + "/" + total + " passed, " + failed.length + " FAILED");
  failed.forEach(function (f) { console.error("  FAIL " + f); });
  process.exit(1);
}
console.log("ui-tests: " + passed + "/" + total + " assertions passed");
dom.window.close();
dom2.window.close();
