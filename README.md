# Iconik Autofill

Paste a YouTube link, get every Iconik metadata field back in panel order, ready to copy.

- `index.html` — the page (GitHub Pages)
- `worker/` — Cloudflare Worker `jomboy-yt`: `GET /v/<id>` reads YouTube, `POST /suggest` asks Workers AI for the
  one-sentence description and dropdown picks (only ever values from the shared lists)
- Shared dropdown lists live on the relay at `/r/iconik-lists`; edit them from the page's "Dropdown lists" button

Redeploy the Worker: `cd worker && npx wrangler deploy`
