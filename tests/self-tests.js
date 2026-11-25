#!/usr/bin/env node
/* self-tests — Mail Merge. No framework, no dependencies.
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * (c) 2026 Dr Sohil Momin
 *
 * Every "must not" in both specs is a named test below, so it fails if the app ever
 * starts doing it. Every "when things go wrong" case is a case. The count is printed
 * and checked: a suite of zero assertions is a failure, not a pass.
 *
 *   node tests/self-tests.js
 */
"use strict";

var fs = require("fs");
var path = require("path");

var ROOT = path.join(__dirname, "..");
var C = require(path.join(ROOT, "docs", "play", "merge-core.js"));

var passed = 0;
var failed = [];
var group = "";

function section(n) { group = n; }
function ok(name, cond, detail) { if (cond) { passed++; return; } failed.push(group + " :: " + name + (detail ? " — " + detail : "")); }
function eq(name, a, b) { ok(name, a === b, "expected " + JSON.stringify(b) + ", got " + JSON.stringify(a)); }
function read(f) { return fs.readFileSync(path.join(ROOT, f), "utf8"); }

/* ---------------------------------------------------------------- fixtures */

var SHEET = [
  "Name,Email,Amount,Month",
  'Asha Kulkarni,asha@example.com,"1,00,000",November',
  'Ravi Deshmukh,ravi@example.com,"45,000",November',
  'Meera Iyer,meera@example.com,"12,500",November'
].join("\n");

var BODY = "Dear {{Name}},\n\nYour invoice for Rs {{Amount}} for {{Month}} is ready.";
var SUBJECT = "Invoice for {{Name}}";

var csv = C.parseCSV(SHEET);

/* ============================================================ the mechanic */

section("mechanic — the spec's own 'done means'");
var built = C.buildMessages({ csv: csv, template: BODY, subjectTemplate: SUBJECT, addressColumn: "Email" });
eq("a three-row sheet produces three messages", built.messages.length, 3);
eq("the first message goes to the first address", built.messages[0].to, "asha@example.com");
ok("the first message carries its own values",
  /Dear Asha Kulkarni/.test(built.messages[0].body) && /Rs 1,00,000/.test(built.messages[0].body),
  built.messages[0].body);
eq("the subject is personalised too", built.messages[0].subject, "Invoice for Asha Kulkarni");
ok("every message is distinct", built.messages[1].body !== built.messages[0].body);
eq("a quoted comma survives the CSV reader", built.messages[0].body.indexOf("1,00,000") > 0, true);

section("mechanic — the sheet reader is a CSV reader");
eq("quoted commas stay in one field", C.parseCSV('A,B\n"one, two",3').rows[0].A, "one, two");
eq("doubled quotes become one quote", C.parseCSV('A,B\n"he said ""hi""",2').rows[0].A, 'he said "hi"');
eq("a newline inside quotes stays in the field", C.parseCSV('A,B\n"line1\nline2",2').rows[0].A, "line1\nline2");
eq("CRLF is handled", C.parseCSV("A,B\r\nx,y\r\n").rows.length, 1);
eq("a BOM is stripped from the first header", C.parseCSV("\ufeffA,B\nx,y").header[0], "A");
eq("duplicate column names are refused", C.parseCSV("A,a\n1,2").ok, false);
eq("a one-column sheet is refused", C.parseCSV("Email\nx@y.com").ok, false);
eq("an empty sheet is refused", C.parseCSV("").ok, false);
eq("a header with no data rows is refused", C.parseCSV("A,B").ok, false);
eq("the row number is the file's row, not the index", csv.rows[1]._row, 3);

section("mechanic — placeholders are column names, matched case-insensitively");
eq("placeholders are de-duplicated in order", C.findPlaceholders("{{A}} {{B}} {{A}}").join(","), "A,B");
eq("a column matched in another case still resolves", C.validateTemplate("Hi {{name}}", csv.header).ok, true);
eq("a template with no placeholder is refused", C.validateTemplate("Hi all", csv.header).ok, false);

section("mechanic — the report keeps its provenance");
var rep = C.buildReport({ csv: csv, template: "Month: {{Month}}\nAmount: Rs {{Amount}}", sourceName: "invoices-nov.csv" });
eq("the report assembles", rep.ok, true);
eq("a column with one value prints that value", rep.figures[0].value, "November");
ok("a column with several values lists them instead of computing a total", /3 values in 3 rows/.test(rep.figures[1].value), rep.figures[1].value);
eq("every figure names its column", rep.figures[1].column, "Amount");
eq("every figure names its rows", rep.figures[1].rows.join(","), "2,3,4");
eq("every figure names its file", rep.figures[1].sourceName, "invoices-nov.csv");
ok("the report markdown carries the provenance table", /Where every figure came from/.test(C.reportMarkdown(rep, { when: "25/11/2026" })));

section("mechanic — status and tracking");
var entries = [
  { row: 2, to: "a@x.com", subject: "s", status: C.STATUS.PREPARED },
  { row: 3, to: "b@x.com", subject: "s", status: C.STATUS.OPENED },
  { row: 4, to: "c@x.com", subject: "s", status: C.STATUS.MARKED }
];
var cnt = C.counts(entries);
eq("prepared, opened and marked are counted separately", cnt.prepared + "/" + cnt.opened + "/" + cnt.marked, "1/1/1");
eq("the tracking sheet has a Status column", C.statusCSV(entries).split("\r\n")[0].indexOf("Status") >= 0, true);
var round = C.parseStatus(C.serializeStatus({ savedOn: "25/11/2026", batch: "s.csv", entries: entries }));
eq("a status file round-trips", round.ok && round.data.entries.length, 3);

/* ======================================================== the must-nots */

section("must-not 1 — it must not become an email service");
["docs/play/app.js", "docs/play/merge-core.js", "docs/play/sw.js", "docs/play/web-kit.js", "docs/play/export-kit.js"].forEach(function (f) {
  var src = read(f);
  ok("must_not_send_anything: " + f + " has no fetch call", !/\bfetch\s*\(/.test(src));
  ok("must_not_send_anything: " + f + " has no XHR, WebSocket, beacon or EventSource",
    !/XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(src));
  ok("must_not_send_anything: " + f + " speaks no mail protocol",
    !/smtp|SMTP|navigator\.sendMail|mailgun|sendgrid|postmark/i.test(src));
});
ok("must_not_send_anything: the only handoff is a mailto: URL", C.mailtoFor({ to: "a@x.com", subject: "s", body: "b" }).indexOf("mailto:a%40x.com") === 0);
ok("must_not_send_anything: a message cannot inject a mail header",
  C.mailtoFor({ to: "a@x.com", subject: "s\r\nBcc: evil@x.com", body: "b" }).indexOf("%0D%0A") === -1,
  C.mailtoFor({ to: "a@x.com", subject: "s\r\nBcc: evil@x.com", body: "b" }));
ok("must_not_send_anything: the page forbids connections in its CSP", /connect-src 'none'/.test(read("docs/play/index.html")));
ok("must_not_send_anything: no function in the engine is named like a sender",
  !/function\s+(send|deliver|transmit|post|dispatch)\s*\(/i.test(read("docs/play/merge-core.js")));

section("must-not 2 — it must not report a send it did not perform");
eq("a fresh batch is only ever 'prepared'",
  built.messages.every(function (m) { return m.status === C.STATUS.PREPARED; }), true);
eq("nothing in a fresh batch is marked sent", C.counts(built.messages.map(function (m) {
  return { status: m.status };
})).marked, 0);
ok("no status value is a bare 'sent' — only the person can claim that",
  Object.keys(C.STATUS).every(function (k) { return String(C.STATUS[k]).toLowerCase() !== "sent"; }),
  JSON.stringify(C.STATUS));
var coerced = C.parseStatus(JSON.stringify({ entries: [{ row: 2, to: "a@x.com", status: "sent" }] }));
eq("a status file claiming an unknown status is coerced back to prepared", coerced.data.entries[0].status, C.STATUS.PREPARED);

section("must-not 3 — it must not merge with a missing column");
var missing = C.buildMessages({ csv: csv, template: "Dear {{Surname}}", addressColumn: "Email" });
eq("the merge is refused", missing.ok, false);
eq("no message is produced", missing.messages.length, 0);
ok("the missing placeholder is named", /Surname/.test(missing.reason), missing.reason);
ok("the refusal lists the columns that do exist", /Name, Email, Amount, Month/.test(missing.reason), missing.reason);
var half = C.buildMessages({ csv: csv, template: BODY, subjectTemplate: "Hi {{Nope}}", addressColumn: "Email" });
eq("a bad subject refuses the whole merge too", half.ok, false);
eq("no half-populated batch is returned", half.messages.length, 0);
var noAddr = C.buildMessages({ csv: csv, template: BODY, addressColumn: "" });
eq("a merge with no address column is refused", noAddr.ok, false);

section("must-not 4 — it must not do arithmetic it cannot show");
var expr = C.validateTemplate("{{Amount * 2}}", csv.header);
eq("an expression is refused as a column that does not exist", expr.ok, false);
ok("the refusal names the expression", /\{\{Amount \* 2\}\}/.test(expr.reason), expr.reason);
eq("a sum of a column is refused the same way", C.validateTemplate("{{sum(Amount)}}", csv.header).ok, false);
ok("no figure is ever computed", C.buildReport({ csv: csv, template: "{{Amount}}", sourceName: "f.csv" }).figures[0].kind === "several values");
ok("every figure carries the rows it came from",
  C.buildReport({ csv: csv, template: "{{Amount}} {{Month}}", sourceName: "f.csv" }).figures.every(function (f) { return f.rows.length === 3; }));

section("must-not 5 — it must not assemble from a mismatched join");
var mapping = C.makeMapping(csv, "invoices-nov.csv");
eq("a mapping records the columns", mapping.columns.join(","), "Name,Email,Amount,Month");
var other = C.parseCSV("Name,Email,Total\nx,y,1");
var mismatch = C.checkMapping(mapping, other);
eq("a file with different columns is refused", mismatch.ok, false);
ok("the refusal names what was expected", /Expected columns: Name, Email, Amount, Month/.test(mismatch.reason), mismatch.reason);
ok("the refusal names what was found", /Found: Name, Email, Total/.test(mismatch.reason), mismatch.reason);
eq("the same columns in a new file pass", C.checkMapping(mapping, C.parseCSV(SHEET)).ok, true);
eq("a file with the columns in another order still passes", C.checkMapping(mapping, C.parseCSV("Month,Amount,Email,Name\nNovember,1,a@x.com,A")).ok, true);

section("must-not 6 — a partial batch is never mistaken for a complete one");
var thrown = C.exportAll("messages", { messages: built.messages, produced: 3 }, { when: "25/11/2026" }, function () {
  var e = new Error("quota"); e.name = "QuotaExceededError"; throw e;
});
eq("a failed write is reported as failed", thrown.ok, false);
ok("a failed write says the file was not written", /not written/.test(thrown.reason), thrown.reason);
ok("a failed write says how many were produced", /3 item\(s\) had been prepared/.test(thrown.reason), thrown.reason);
eq("a refused writer is reported too", C.exportAll("status", { entries: entries, produced: 3 }, {}, function () { return false; }).ok, false);
eq("no writer means no file", C.exportAll("status", { entries: entries }, {}, null).ok, false);

section("must-not 7 — a broken status cannot lose the source data");
var broken = C.parseStatus("{ this is not json");
eq("a corrupt status file is reported", broken.ok, false);
ok("the reason says the sheet and template are untouched", /sheet and the template are untouched/.test(broken.reason), broken.reason);
eq("the raw text is kept so it can be exported", broken.raw, "{ this is not json");
eq("an empty status file is reported, not guessed at", C.parseStatus("").ok, false);
eq("a status file with no entries list is refused", C.parseStatus('{"a":1}').ok, false);
eq("the sheet still parses while the status is broken", C.parseCSV(SHEET).ok, true);
eq("the template still validates while the status is broken", C.validateTemplate(BODY, csv.header).ok, true);

/* ================================================== the failure cases */

section("failure case — bad input");
var noAddress = C.parseCSV("Name,Email\nAsha,asha@example.com\nRavi,not-an-email\nMeera,\nSita,sita@example.com");
var mixed = C.buildMessages({ csv: noAddress, template: "Hi {{Name}}", addressColumn: "Email" });
eq("rows with a usable address still merge", mixed.messages.length, 2);
eq("a row with no address is excluded, not merged", mixed.excluded.length, 2);
ok("the excluded row says why", /not an email address/.test(mixed.excluded[0].reason), mixed.excluded[0].reason);
ok("the excluded row is named, not just counted", mixed.excluded[0].who === "Ravi", mixed.excluded[0].who);
var allBad = C.buildMessages({ csv: C.parseCSV("Name,Email\nA,\nB,nope"), template: "Hi {{Name}}", addressColumn: "Email" });
eq("a sheet with no usable address produces nothing and says so", allBad.ok, false);
ok("it says how many rows were excluded", /2 row\(s\) were excluded/.test(allBad.reason), allBad.reason);

section("failure case — no network");
ok("the engine never mentions a host", !/https?:\/\//.test(read("docs/play/merge-core.js")));
ok("the page never mentions a host", !/https?:\/\//.test(read("docs/play/index.html").replace(/https:\/\/drsamonline\.github\.io[^"]*/g, "")));

/* ================================================== the shape on disk */

section("shape — every script the page loads exists beside it");
var page = read("docs/play/index.html");
var srcs = (page.match(/<script[^>]+src="([^"]+)"/g) || []).map(function (t) { return t.replace(/.*src="([^"]+)".*/, "$1"); });
ok("the page loads at least three scripts", srcs.length >= 3, srcs.join(","));
srcs.forEach(function (s) {
  ok("script src resolves: " + s, fs.existsSync(path.join(ROOT, "docs", "play", s.replace(/^\.\//, ""))));
});
ok("the page has a CSP", /Content-Security-Policy/.test(page));
ok("the page declares the manifest", /rel="manifest"/.test(page));
ok("the landing page exists", fs.existsSync(path.join(ROOT, "docs", "index.html")));
ok("the page manifest exists", fs.existsSync(path.join(ROOT, "PAGES.json")));
ok("the licence is present", fs.existsSync(path.join(ROOT, "LICENSE")));

/* ============================================================== summary */

var total = passed + failed.length;
if (!total) { console.error("self-tests: 0 assertions ran. That is a failure, not a pass."); process.exit(1); }
if (failed.length) {
  console.error("self-tests: " + passed + "/" + total + " passed, " + failed.length + " FAILED");
  failed.forEach(function (f) { console.error("  FAIL " + f); });
  process.exit(1);
}
console.log("self-tests: " + passed + "/" + total + " assertions passed");
