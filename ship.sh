#!/usr/bin/env bash
# One-time Iconik hookup + deploy. Run from the repo root:  bash ship.sh
# Prompts for the Iconik secrets (typed into wrangler, never saved in the repo), deploys the worker, pushes the page.
set -euo pipefail
cd "$(dirname "$0")"

cd worker
if [[ "${1:-}" != "--no-secrets" ]]; then
  echo "Paste the Iconik App ID when asked, then the Auth Token (Iconik → Settings → Application Tokens)."
  npx wrangler secret put ICONIK_APP_ID
  npx wrangler secret put ICONIK_AUTH_TOKEN
  read -rp "Set a push key so only your team can write to Iconik? [Y/n] " yn
  if [[ ! "$yn" =~ ^[Nn] ]]; then npx wrangler secret put PUSH_KEY; fi
fi
npx wrangler deploy
cd ..

echo; echo "Checking the Iconik connection…"
curl -s -H "Origin: https://robsjomboy.github.io" https://jomboy-yt.jomboymedia.workers.dev/iconik/check; echo

git add index.html worker/worker.js README.md ship.sh
git commit -m "Push to Iconik: one click writes the metadata view on the asset" || true
git push
echo "Done. GitHub Pages picks up the page in a minute or so."
