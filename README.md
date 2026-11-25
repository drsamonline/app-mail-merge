# Mail Merge

One sheet, one template. It prepares a personalised message for every row and hands each one
to **your own mail client** — and it assembles a report from the same columns, where every
figure shows the row and the file it came from.

- **Demo (the app itself):** https://drsamonline.github.io/app-mail-merge/play/index.html
- **Landing page:** https://drsamonline.github.io/app-mail-merge/
- **Plan row:** #2 of 37 in `drsamonline/forge` → `QUEUE/PLAN.json`
- **Specs absorbed:** `app-mailmerge` (lead), `app-report-assembler`
- **Licence:** PolyForm Noncommercial 1.0.0

## Status

| | |
|---|---|
| **Built** | CSV reader (quoted commas, doubled quotes, embedded newlines, CRLF, BOM); `{{Column}}` personalisation by column name, case-insensitive; address-column guess and override; one message per row with a `mailto:` handoff; excluded rows listed with the reason; per-recipient status kept on the device; corrupt status reported and offered for export; report assembled from columns with per-figure provenance; saved column mapping that refuses a mismatched file; export of messages, status and report. |
| **Release** | Windows EXE, Android APK and Linux binary, built from this source by `app-builder` in CI, attached to the rolling release: [app-latest](https://github.com/drsamonline/app-mail-merge/releases/tag/app-latest) |
| **Not built** | Attachments. A direct send of any kind — by design, not by omission. |
| **Untested** | Dragging a file from the OS and the file picker (the CSV is tested through the textarea path), the service worker and the install prompt (jsdom implements neither), and what a real mail client does with a long `mailto:` body — Gmail and Outlook truncate around 2,000 characters, and this app does not know your client's limit. |

## The two jobs, one engine

Both specs are the same job — bind columns to a template, once per row — so there is one engine
(`merge-core.js`) and two outputs:

**Messages.** `Dear {{Name}}, your invoice for Rs {{Amount}} is ready.` → one message per row,
each with that row's values, each opened in your mail client.

**Report.** `Amount invoiced: Rs {{Amount}}` → the figure, plus a provenance table naming the
column, the rows and the file. When a column holds several values it lists them
(`[3 values in 3 rows: …]`) instead of computing a total — the app does no arithmetic it cannot show.

## What it will not do

- **Send anything.** No SMTP, no API, no queue, no transport of any kind. The only handoff is a
  `mailto:` URL, and the CR/LF that would allow header injection are percent-encoded.
- **Claim a send it did not perform.** A fresh batch is only ever `prepared`; `marked sent by you`
  is a box the person ticks. A status file claiming an unknown status is coerced back to `prepared`.
- **Do arithmetic it cannot show.** A placeholder is a column name. `{{Amount * 2}}` and
  `{{sum(Amount)}}` are refused as columns that do not exist.
- **Merge with a missing column.** One unknown placeholder refuses the whole merge, naming it, with
  the columns that do exist listed — no half-populated batch is ever returned.
- **Assemble from a mismatched join.** A saved mapping is checked before assembly; a file missing a
  column is refused with the expected and the found columns named.
- **Upload anything.** No `fetch`, no XHR, no WebSocket, no beacon in any shipped file; CSP
  `connect-src 'none'`.

## When things go wrong

| Case | Behaviour |
|---|---|
| **Bad input** | Unknown placeholder → refused by name, merge does not run. Row with no usable address → excluded, listed with the reason and the row number. |
| **No network** | Composing and personalising are local and always work. The app says it composed the messages and did not send them. |
| **Storage full or unavailable** | The output is not written, and the message names how many items had been prepared — a partial batch is never mistaken for a complete one. |
| **Corrupt saved state** | The status file is reported and offered for export; sheet and template live under their own keys, so a broken status cannot lose them. |

## The must-nots, and the test that holds each

| Must not | Test |
|---|---|
| become an email service | `must_not_send_anything` — no fetch/XHR/WebSocket/beacon/SMTP in any shipped file; the only handoff is `mailto:`; no header injection |
| report a send it did not perform | `must_not_report_a_send_it_did_not_perform` — fresh batch is only `prepared`; no bare `sent` status exists; a corrupt status claiming one is coerced |
| merge with a missing column | `must_not_merge_with_a_missing_column` — refused, zero messages, placeholder named |
| do arithmetic it cannot show | `must_not_do_unshown_arithmetic` — `{{Amount * 2}}` and `{{sum(Amount)}}` refused; every figure carries its rows and file |
| assemble from a mismatched join | `must_not_assemble_from_a_mismatched_join` — expected vs found columns named |
| let a partial batch pass as complete | `must_not_hide_a_partial_batch` — the failure names how many were produced |
| lose source data on a corrupt status | `must_not_lose_source_data_on_corrupt_status` — reported, raw text kept, sheet and template unaffected |

Mutation-tested four ways on 25/11/2026: accepting a placeholder with no column (9 failures),
claiming the messages were sent (2), assembling from a mismatched join (3), and reporting a failed
write as written (3) each turned the suite red; restored, 100/100 pass.

## Tests

```bash
npm test                      # all three suites
node tests/self-tests.js      # engine — 100 assertions, every must-not named
node tests/ui-tests.js        # the page in jsdom — 38 assertions (needs the dev-only jsdom)
node tests/page-smoke.js      # every local src/href resolves, nothing off-origin
```

## Layout

```
docs/index.html            landing page
docs/play/index.html       the app (Messages and Report tabs)
docs/play/app.js           DOM wiring, status file, mailto handoff
docs/play/merge-core.js    the engine — CSV, placeholders, messages, report provenance
docs/play/web-kit.js       vendored kit (unmodified) — shell and PWA registration
docs/play/export-kit.js    vendored kit (unmodified) — Blob download
docs/play/sw.js            cache-only service worker
tests/self-tests.js        engine suite
tests/ui-tests.js          page suite (jsdom)
tests/page-smoke.js        shape on disk
PAGES.json                 landing = docs/index.html, app = docs/play/index.html
```

## Where the spec was silent, and what was chosen

- **A column with many values in a report** is listed, not summed. Summing would be arithmetic the
  output cannot show back to a row.
- **Address validation** is deliberately shallow (`x@y.zz`): the app cannot verify an address and
  will not pretend to. It refuses the obviously broken and lets your mail client bounce the rest.
- **The status file** lives under `mailmerge:status`, with the sheet and template under their own
  keys — that separation is what makes "a broken status cannot lose the source data" true.
- **`mailto:` length** is not truncated by the app: silently cutting a message would send half of it.

## What is not built, and why

**Attachments.** A `mailto:` link cannot carry one. Adding attachments would mean writing an `.eml`
file per message, which is a different feature and a different test.
