# To-Do Hub

A small installable web app (works offline) for Jodi's daily to-dos across TPAM, Vicki's office and Absolute Bookkeeping:
Today screen, job lists, TPAM rec rotation, month-end close board, and a time clock.

- The app itself (index.html, app.js, styles.css, sw.js, icons/) (plain HTML/CSS/JS, no build step). Served by GitHub Pages.
- `apps-script/Code.gs` – the Google Apps Script that syncs the app with a Google Sheet. The real sync code is never stored in this repo.

No list data lives in this repository. Everything is kept on the device and in the owner's Google Sheet.
