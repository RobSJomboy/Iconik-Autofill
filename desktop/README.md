# Push to Iconik (Mac app)

The Stream Deck "PUSH TO ICONIK" button as a double-click app for the whole team.
Install page: https://robsjomboy.github.io/Iconik-Autofill/app/

**What happens on each push**
1. The newest video in your export folder (or one you drop on the app) uploads into the show's folder under Iconik › Channels.
   The worker (`/iconik/upload/start|finish`) makes the asset and a signed upload URL, then the bytes go straight from the Mac to
   Iconik storage. Files over about 4.8 GB use S3 multipart (`/app/upload/parts`, `/app/upload/complete-url`).
2. Every 3 minutes (15 after 6 hours) the app checks the show's YouTube uploads (`/app/youtube/recent`). It matches the export by length
   (±2.5 s), shared title words, and episode number. A sure match goes ahead on its own. A maybe asks you to pick.
3. For long videos with captions connected, it waits 30 minutes after the video goes public so YouTube's captions exist. Then it
   opens Iconik Autofill (`?yt=&asset=&auto=1&me=&role=`) in its own window with the team key filled in. Autofill runs Generate and
   Push, which also covers the monday ad reads. The app hooks the page's `/iconik/push` reply to mark the job done.

**First-run setup:** team key → name and role (from Iconik's Producer/Editor lists) → shows (Iconik channel folders, optional series
folder and filename prefix, monday board, YouTube channel, caption status) → export folder → timecodes and monday → iconik Agent →
Desktop icon.

**Files on each Mac:** `~/Library/Application Support/Push to Iconik/` holds config.json, jobs.json, log.txt, and team-key (mode 600).
It doesn't use the Keychain: ad-hoc signed builds would bring up an "allow access" prompt after every update.

**Build:** `./devbuild.sh` (this Mac only, build/dev), or `VERSION=x.y.z NOTES="…" ./build.sh` (universal, writes ../app/
PushToIconik.zip + version.json). Commit app/ and push, and installed copies show an Update button.
The UI is `ui/index.html` in a WKWebView, and the native bridge is `native(cmd, args)` in `main.swift`.
To drive the UI in tests, launch with `open --env PTI_DEV=1 …`. The app then runs `Support/dev.js` in the page and writes the result to `dev.out`.
