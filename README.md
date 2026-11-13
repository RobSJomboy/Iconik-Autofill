# Iconik Autofill

Paste a YouTube link, get every Iconik metadata field back in panel order, then hit **Push to Iconik** to write them onto the asset.

- `index.html` — the page (GitHub Pages)
- `worker/` — Cloudflare Worker `jomboy-yt`: `GET /v/<id>` reads YouTube, `POST /suggest` asks Workers AI for the
  one-sentence description and dropdown picks (only ever values from the shared lists)
- `/iconik/check` and `/iconik/push` on the same Worker write the "Jomboy Metadata" view on an asset. Fields are matched
  by their Iconik label, so the worker finds the real field names and dropdown values itself. No asset link → it searches
  Iconik by YouTube ID, then title; several matches come back as a pick list.
- Worker secrets: `ICONIK_APP_ID`, `ICONIK_AUTH_TOKEN`, optional `PUSH_KEY`, `ICONIK_VIEW_ID` (or `ICONIK_VIEW_NAME`)
- Shared dropdown lists live on the relay at `/r/iconik-lists`; edit them from the page's "Dropdown lists" button

Redeploy the Worker: `cd worker && npx wrangler deploy`
First-time Iconik hookup + deploy + push: `bash ship.sh` (later: `bash ship.sh --no-secrets`)
