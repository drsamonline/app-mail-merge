# Changelog

All notable changes to Mail Merge are recorded here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates: dd/mm/yyyy.

## [Unreleased]

## [1.0.0] — 25/11/2026

### Added
- Merge engine (`docs/play/merge-core.js`): a real CSV reader (quotes, doubled quotes,
  embedded commas and newlines, CRLF, BOM, duplicate-header refusal), `{{Column}}`
  placeholders resolved by name and case-insensitively, and one message per row.
- Messages: an address-column guess and override, rows with no usable address excluded and
  listed with the reason, and a `mailto:` handoff with CR/LF percent-encoded so a message
  cannot inject a mail header. The app has no transport and cannot send.
- Tracking: a per-recipient status (`prepared`, `opened in mail client`, `marked sent by you`)
  kept on the device under its own key, exported as CSV. A status file claiming an unknown
  status is coerced back to `prepared`.
- Report: assembled from columns, with a provenance table naming the column, the rows and the
  file for every figure. A column holding several values is listed rather than totalled.
- Saved column mapping: a new file is checked against it before assembly, and a mismatched
  file is refused with the expected and found columns named.
- Corruption handling: an unreadable status file is reported and offered for export; the sheet
  and the template live under separate keys and are never lost with it.
- Export failure names how many items had been prepared, so a partial batch is never mistaken
  for a complete one.
- PWA shell: manifest, cache-only service worker, icons. Works from `file://`.
- Tests: `tests/self-tests.js` (100 assertions), `tests/ui-tests.js` (38, in jsdom),
  `tests/page-smoke.js` (the shape on disk). CI runs all three.

### Not built
- A packaged EXE / APK release: `app-builder` is not reachable from the build environment.
- Attachments: a `mailto:` link cannot carry one.
