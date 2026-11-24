/**
 * Jomboy YouTube lookup — feeds the Iconik metadata helper.
 *
 *   GET  /v/<videoId>  → { id, title, channel, publishDate, lengthSeconds, keywords, description, thumbnail, live, short }
 *   POST /suggest      { video, lists } → { oneSentence, sport, sponsor: [..], mlbFootage }
 *                      (Workers AI; it may only answer with values that exist in `lists`)
 *   GET  /iconik/check → is the Iconik token set, which view it found, how each page field maps to it
 *   POST /iconik/push  { asset?, videoId, title, values, publishedIso, dryRun? } → writes the metadata view on one asset
 *   POST /iconik/upload/start|finish → new asset in a collection; the caller uploads the bytes to the returned URL
 *                      (no asset → searches Iconik by title; one hit is written, several come back as `pick`)
 *
 * Browsers can't read YouTube's data directly (CORS), so this asks YouTube's player endpoint
 * on the page's behalf. No API key needed. Falls back to scraping the watch page.
 */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Push-Key' };
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': s === 200 ? 'public, max-age=300' : 'no-store', ...CORS } });

function shape(id, d) {
  const v = d.videoDetails || {}, m = (d.microformat || {}).playerMicroformatRenderer || {};
  if (!v.title) return null;
  const th = (v.thumbnail && v.thumbnail.thumbnails) || [];
  return {
    id, title: v.title, channel: v.author || m.ownerChannelName || '',
    publishDate: m.publishDate || m.uploadDate || '', lengthSeconds: +v.lengthSeconds || 0,
    keywords: v.keywords || [], description: v.shortDescription || '',
    category: m.category || '', thumbnail: th.length ? th[th.length - 1].url : '',
  };
}

async function viaPlayer(id) {
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ videoId: id, context: { client: { clientName: 'WEB', clientVersion: '2.20250101.00.00', hl: 'en', gl: 'US' } } }),
  });
  if (!r.ok) { lastWhy.push('player HTTP ' + r.status); return null; }
  const d = await r.json();
  const out = shape(id, d);
  if (!out) lastWhy.push('player: ' + JSON.stringify(d.playabilityStatus || {}).slice(0, 200));
  return out;
}
let lastWhy = [];

// Official YouTube Data API v3 — used whenever the YT_KEY secret is set (1 quota unit per lookup, 10,000/day free).
const isoDur = (d) => { const m = (d || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || []; return (+m[1]||0)*86400 + (+m[2]||0)*3600 + (+m[3]||0)*60 + (+m[4]||0); };
async function viaDataApi(id, key) {
  const r = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${id}&key=${key}`);
  const d = await r.json();
  if (!r.ok) { lastWhy.push('data api: ' + ((d.error || {}).message || r.status)); return null; }
  const it = (d.items || [])[0];
  if (!it) { lastWhy.push('data api: no such video'); return null; }
  const sn = it.snippet || {}, th = sn.thumbnails || {};
  return {
    id, title: sn.title || '', channel: sn.channelTitle || '', publishDate: sn.publishedAt || '',
    lengthSeconds: isoDur((it.contentDetails || {}).duration), keywords: sn.tags || [], description: sn.description || '',
    category: '', thumbnail: (th.maxres || th.high || th.default || {}).url || '', via: 'data-api',
    live: !!it.liveStreamingDetails || (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none'),
  };
}

// YouTube serves a Short at /shorts/<id> (200) and redirects anything else to /watch (303).
async function isShort(id) {
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (r.status === 200) return true;
    if (r.status >= 300 && r.status < 400) return false;
  } catch {}
  return null;
}

async function viaWatchPage(id) {
  const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'en-US', 'Cookie': 'CONSENT=YES+1' } });
  const html = await r.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script)/s);
  if (!m) { lastWhy.push('watch HTTP ' + r.status + ' len ' + html.length + ' ' + (html.match(/<title>[^<]*/)||[''])[0]); return null; }
  try { return shape(id, JSON.parse(m[1])); } catch { return null; }
}

// Strip the boilerplate every Jomboy description ends with, so the model reads the episode, not the footer.
function trimDescription(d) {
  const cut = d.search(/Download and subscribe to the pod|Subscribe to our other YouTube channels|Follow us on social media/i);
  return (cut > 0 ? d.slice(0, cut) : d).slice(0, 2500);
}

async function suggest(env, body) {
  const v = body.video || {}, L = body.lists || {};
  const list = (k) => (Array.isArray(L[k]) ? L[k] : []).join(' | ');
  const prompt = `You fill in media-library metadata for Jomboy Media, a sports media company. Video:
TITLE: ${v.title}
CHANNEL: ${v.channel}
LENGTH: ${Math.round((v.lengthSeconds || 0) / 60)} minutes
KIND: ${v.live ? 'a live stream' : v.short ? 'a Short (vertical, under three minutes)' : /\|\s*#?\s*\d{2,5}\s*$/.test(v.title || '') ? 'a full podcast episode (the title ends in its episode number)' : 'a clip cut from an episode (no episode number in the title)'}
YOUTUBE TAGS: ${(v.keywords || []).join(', ')}
DESCRIPTION:
${trimDescription(v.description || '')}

Answer with JSON only, using these keys. Every dropdown answer MUST be copied exactly from its list, or "" if none fits.
- "oneSentence": one complete sentence, 14-30 words, with a subject and a verb, telling a reader what happens in this video, e.g. "The guys react to a blockbuster deadline trade and argue over whether it actually fixes the rotation." (only an example of the style; describe THIS video) Do not just restate the title. Plain and specific, no hype, no hashtags, no host names unless the description names them. Do not start with "In this episode". Never use the word "fans".
- "sport": one value from [${list('sport')}] — the sport and league the video is about
- "sponsor": array of every value from [${list('sponsor')}] that the description runs an ad read for (download this app, use code, visit this site, including brand names inside links like bestwestern.com or seatgeek.com). If the description has no ad, answer ["1. NOT APPLICABLE"]. A team, league or network just being talked about is not a sponsor.
- "mlbFootage": one value from [${list('mlbFootage')}] — only "yes" if the description credits MLB video/footage`;
  const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  let out = r.response;
  if (typeof out === 'string') { const m = out.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : {}; }
  // Never hand back a value Iconik doesn't have.
  const sq = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pick = (k, val) => { const t = sq(val); if (!t) return '';
    const opts = L[k] || []; return opts.find((o) => sq(o) === t) || (t.length >= 6 && opts.find((o) => sq(o).endsWith(t))) || ''; };
  return {
    oneSentence: String(out.oneSentence || '').trim(),
    sport: pick('sport', out.sport), sponsor: [...new Set((Array.isArray(out.sponsor) ? out.sponsor : [out.sponsor]).map((s) => pick('sponsor', s)).filter(Boolean))], mlbFootage: pick('mlbFootage', out.mlbFootage),
  };
}

// ───────────────────────── Iconik ─────────────────────────
// Secrets (set with `npx wrangler secret put ...`, never in code): ICONIK_APP_ID, ICONIK_AUTH_TOKEN.
// Optional: ICONIK_VIEW_ID (else the view named ICONIK_VIEW_NAME, default "Jomboy Metadata"),
//           PUSH_KEY (if set, the page must send it; people enter it once per browser).
const ICONIK = 'https://app.iconik.io/API';
const PAGE_ORIGINS = ['https://robsjomboy.github.io'];

// Page field key → the label it has in Iconik's metadata panel. Matching is by label, so the worker
// finds the real field names and dropdown values itself.
const FIELD_LABELS = {
  title: 'Title', published: 'Date & Time Published', link: 'YouTube Link', episodeId: 'Episode ID',
  sponsor: 'Sponsor', mlbFootage: 'MLB Footage?', topTags: 'Top Tags', oneSentence: 'One Sentence Description',
  episodeNum: 'Episode #', videoType: 'Video Type', sport: 'Sport & League', contentTag: 'Content Tag',
  ytShorts: 'YouTube Shorts Link', facebook: 'Facebook Link', instagram: 'Instagram Link', twitter: 'Twitter Link',
  tiktok: 'TikTok Link', linkedin: 'LinkedIn Link',
  channel: 'Channel', owningCreator: 'Owning Creator', guestCreator: 'Guest Creator',
  series: 'Series', producer: 'Producer', editor: 'Editor',
  metaDone: 'All Metadata Updated?', thumbDone: 'Thumbnails Uploaded?',
};
// Toggles the worker sets itself; the page never sends them.
const TOGGLES = new Set(['metaDone', 'thumbDone']);
const sq = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function ik(env, path, init = {}) {
  const r = await fetch(ICONIK + path, { ...init, headers: {
    'App-ID': env.ICONIK_APP_ID, 'Auth-Token': env.ICONIK_AUTH_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 300) }; }
  if (!r.ok) { const e = new Error(`Iconik ${init.method || 'GET'} ${path.split('?')[0]} → ${r.status}: ${JSON.stringify(body.errors || body).slice(0, 300)}`); e.status = r.status; throw e; }
  return body;
}

let viewCache = null;
async function getView(env) {
  if (viewCache && Date.now() - viewCache.at < 10 * 60 * 1000) return viewCache.view;
  let id = env.ICONIK_VIEW_ID;
  if (!id) {
    const want = sq(env.ICONIK_VIEW_NAME || 'Jomboy Metadata');
    const list = await ik(env, '/metadata/v1/views/?per_page=500');
    const v = (list.objects || []).find((x) => sq(x.name) === want);
    if (!v) throw new Error(`No metadata view named "${env.ICONIK_VIEW_NAME || 'Jomboy Metadata'}". Views this token can see: ${(list.objects || []).map((x) => x.name).join(', ')}`);
    id = v.id;
  }
  const view = await ik(env, `/metadata/v1/views/${id}/`);
  viewCache = { at: Date.now(), view };
  return view;
}

function mapFields(view) {
  const vf = view.view_fields || [];
  const out = {};
  for (const [k, label] of Object.entries(FIELD_LABELS)) {
    out[k] = vf.find((f) => sq(f.label) === sq(label)) || vf.find((f) => sq(f.name) === sq(label)) || null;
  }
  return out;
}

// One page value → Iconik field_values, or a reason it was skipped.
function toFieldValues(f, k, val, body) {
  let vals = Array.isArray(val) ? val : [val];
  vals = vals.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '' && v != null);
  if (k === 'published') vals = body.publishedIso ? [new Date(body.publishedIso).toISOString()] : [];
  if (!vals.length) return { skip: 'empty' };
  const type = String(f.field_type || '').toLowerCase();
  const opts = f.options || [];
  if (opts.length) {
    const bad = [], picked = [];
    for (const v of vals) {
      const o = opts.find((x) => sq(x.label) === sq(v) || sq(x.value) === sq(v));
      o ? picked.push(o.value) : bad.push(v);
    }
    if (bad.length) return { skip: `not an option in Iconik: ${bad.join(', ')}` };
    vals = picked;
  } else if (type === 'integer') {
    vals = vals.map((v) => parseInt(v, 10)).filter((n) => !isNaN(n));
    if (!vals.length) return { skip: 'not a number' };
  } else if (type === 'float') {
    vals = vals.map(Number).filter((n) => !isNaN(n));
  } else if (type === 'boolean') {
    vals = vals.map((v) => /^(yes|true|1)$/i.test(String(v)));
  }
  if (f.multi === false && vals.length > 1) vals = vals.slice(0, 1);
  return { field_values: vals.map((value) => ({ value })) };
}

// Accepts an asset UUID or any Iconik link containing /asset/<uuid>.
const assetIdFrom = (s) => (String(s || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || null;

async function findAssets(env, body) {
  const seen = new Map();
  const run = async (query) => {
    try {
      const r = await ik(env, '/search/v1/search/?per_page=8&generate_signed_url=false', { method: 'POST',
        body: JSON.stringify({ doc_types: ['assets'], query, sort: [{ name: 'date_created', order: 'desc' }] }) });
      for (const o of r.objects || []) if (!seen.has(o.id)) seen.set(o.id, { id: o.id, title: o.title, created: o.date_created });
    } catch (e) { if (e.status === 401 || e.status === 403) throw e; }
  };
  if (body.videoId) await run(`"${body.videoId}"`);          // already linked to this YouTube video
  if (!seen.size && body.title) await run(`"${String(body.title).replace(/"/g, '')}"`);
  return [...seen.values()];
}

// ── Poster (Iconik calls the asset's cover image a "custom keyframe" of type POSTER) ──
// 1. POST files/v1/assets/<id>/custom_keyframe/?content_type=…  → keyframe with a pre-signed upload_url
// 2. upload the bytes there   3. mark it CLOSED   4. POST custom_keyframe/<poster_id>/ to make it the asset's poster
async function thumbBytes(t) {
  if (!t) return null;
  if (t.dataUrl) {
    const m = String(t.dataUrl).match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
    if (!m) throw new Error('thumbnail must be a JPG, PNG or WebP');
    const bin = atob(m[2]); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length > 15 * 1024 * 1024) throw new Error('thumbnail is over 15 MB');
    return { bytes, type: m[1] };
  }
  if (t.youtube) {                                   // YouTube's own thumbnail, only from YouTube's image host
    const u = new URL(t.youtube);
    if (!/^(i\d?\.ytimg\.com|img\.youtube\.com)$/.test(u.hostname)) throw new Error('thumbnail URL is not a YouTube image');
    const r = await fetch(u.toString());
    if (!r.ok) throw new Error('could not fetch the YouTube thumbnail (' + r.status + ')');
    return { bytes: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('Content-Type') || 'image/jpeg' };
  }
  return null;
}

async function uploadPoster(env, assetId, t) {
  const img = await thumbBytes(t);
  if (!img) return null;
  const ext = img.type.split('/')[1].replace('jpeg', 'jpg');
  const kf = await ik(env, `/files/v1/assets/${assetId}/custom_keyframe/?content_type=${encodeURIComponent(img.type)}`, { method: 'POST' });
  if (!kf.upload_url) throw new Error('Iconik gave no upload URL for the poster: ' + JSON.stringify(kf).slice(0, 200));
  const log = (step, x) => console.log(JSON.stringify({ poster: step, asset: assetId, ...x }));
  log('created', { id: kf.id, type: kf.type, status: kf.status, method: kf.upload_method, host: (() => { try { return new URL(kf.upload_url).host; } catch { return null; } })(),
    filename: kf.filename, headerKeys: Object.keys(kf.upload_headers || {}), credKeys: Object.keys(kf.upload_credentials || {}), bytes: img.bytes.length, ct: img.type });
  const headers = { 'Content-Type': img.type, ...(kf.upload_headers || {}) };
  let up = await fetch(kf.upload_url, { method: 'PUT', headers, body: img.bytes });
  if (!up.ok && /gcs/i.test(kf.upload_method || '')) {          // GCS resumable URL: start a session, then PUT
    const init = await fetch(kf.upload_url, { method: 'POST', headers: { ...headers, 'x-goog-resumable': 'start' } });
    const loc = init.headers.get('Location');
    if (loc) up = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': img.type }, body: img.bytes });
  }
  log('uploaded', { status: up.status });
  if (!up.ok) throw new Error(`poster upload ${up.status} (${kf.upload_method || 'PUT'}): ${(await up.text()).slice(0, 200)}`);
  try {
    const p = await ik(env, `/files/v1/assets/${assetId}/keyframes/${kf.id}/`, { method: 'PATCH',
      body: JSON.stringify({ type: 'POSTER', status: 'CLOSED', size: img.bytes.length }) });   // keep Iconik's own filename: renaming it points the poster at a file that isn't there
    log('closed', { status: p.status, url: !!p.url });
  } catch (e) { log('close-failed', { error: String(e.message).slice(0, 300) }); }
  const set = await ik(env, `/files/v1/assets/${assetId}/custom_keyframe/${kf.id}/`, { method: 'POST' });
  log('set', { id: set.id, type: set.type, status: set.status, custom: set.is_custom_keyframe });
  try {
    const all = await ik(env, `/files/v1/assets/${assetId}/keyframes/`);
    log('after', { keyframes: (all.objects || []).map((k) => ({ id: k.id.slice(0, 8), type: k.type, status: k.status, custom: k.is_custom_keyframe, created: k.date_created })) });
  } catch (e) { log('list-failed', { error: String(e.message).slice(0, 200) }); }
  return { id: kf.id, bytes: img.bytes.length };
}

// ── New-file upload (the Companion "PUSH TO ICONIK" button) ──
// The Mac never holds Iconik credentials: the worker makes the asset + file records and hands back a pre-signed
// upload URL, the Mac sends the bytes straight to Iconik's storage, then /upload/finish closes the file and starts proxies.
//   POST /iconik/upload/start  { collection, filename, size, title? } → { assetId, fileId, assetUrl, upload_url, upload_method, upload_headers }
//   POST /iconik/upload/finish { assetId, fileId }                     → { ok, transcode }
const MIME = { mp4: 'video/mp4', mov: 'video/quicktime', mxf: 'application/mxf', mp3: 'audio/mpeg', wav: 'audio/wav' };
async function uploadStart(env, b) {
  const cid = assetIdFrom(b.collection);
  const name = String(b.filename || '').trim(), size = Number(b.size);
  if (!cid) throw new Error('collection id missing');
  if (!name || !(size > 0)) throw new Error('filename and size are required');
  const title = String(b.title || name.replace(/\.[^.]+$/, ''));
  const mime = MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const st = await ik(env, '/files/v1/storages/matching/FILES/');
  const storage = (st.objects && st.objects[0]) || st;
  if (!storage || !storage.id) throw new Error('Iconik has no default FILES storage for this token: ' + JSON.stringify(st).slice(0, 200));
  const asset = await ik(env, '/assets/v1/assets/', { method: 'POST', body: JSON.stringify({ title, type: 'ASSET' }) });
  await ik(env, `/assets/v1/collections/${cid}/contents/`, { method: 'POST', body: JSON.stringify({ object_id: asset.id, object_type: 'assets' }) });
  const fmt = await ik(env, `/files/v1/assets/${asset.id}/formats/`, { method: 'POST',
    body: JSON.stringify({ name: 'ORIGINAL', storage_methods: [storage.method], metadata: [{ internet_media_type: mime }] }) });
  const fs = await ik(env, `/files/v1/assets/${asset.id}/file_sets/`, { method: 'POST',
    body: JSON.stringify({ format_id: fmt.id, storage_id: storage.id, base_dir: '/', name, component_ids: [] }) });
  const now = new Date().toISOString();
  const file = await ik(env, `/files/v1/assets/${asset.id}/files/`, { method: 'POST',
    body: JSON.stringify({ original_name: name, directory_path: '', file_set_id: fs.id, format_id: fmt.id, storage_id: storage.id,
      size, type: 'FILE', file_date_created: now, file_date_modified: now }) });
  if (!file.upload_url) throw new Error('Iconik gave no upload URL: ' + JSON.stringify(file).slice(0, 200));
  console.log(JSON.stringify({ upload: 'start', asset: asset.id, file: file.id, method: file.upload_method || storage.method, size }));
  return { assetId: asset.id, fileId: file.id, assetUrl: `https://app.iconik.io/asset/${asset.id}`, mime,
    upload_url: file.upload_url, upload_method: file.upload_method || storage.method, upload_headers: file.upload_headers || {},
    storage_method: storage.method, multipart_upload_url: file.multipart_upload_url || null };
}
async function uploadFinish(env, b) {
  const a = assetIdFrom(b.assetId), f = assetIdFrom(b.fileId);
  if (!a || !f) throw new Error('assetId and fileId are required');
  await ik(env, `/files/v1/assets/${a}/files/${f}/`, { method: 'PATCH', body: JSON.stringify({ status: 'CLOSED', progress_processed: 100 }) });
  let transcode = 'started';
  try { await ik(env, `/files/v1/assets/${a}/files/${f}/keyframes/`, { method: 'POST', body: '{}' }); }
  catch (e) { transcode = 'not started: ' + String(e.message).slice(0, 200); }
  return { ok: true, assetUrl: `https://app.iconik.io/asset/${a}`, transcode };
}

// Who usually owns each channel, learned from assets already tagged in Iconik (facet counts, read-only).
async function channelOwners(env, only) {
  const view = await getView(env);
  const ch = (view.view_fields || []).find((f) => f.label === 'Channel');
  const oc = (view.view_fields || []).find((f) => f.label === 'Owning Creator');
  const names = only ? [only] : (ch.options || []).map((o) => o.value);
  const out = {};
  await Promise.all(names.map(async (name) => {
    try {
      // Newest 100 assets on the channel that already have an Owning Creator; tally who it is.
      const r = await ik(env, '/search/v1/search/?per_page=100&generate_signed_url=false', { method: 'POST', body: JSON.stringify({
        doc_types: ['assets'], include_fields: ['id', `metadata.${oc.name}`], sort: [{ name: 'date_created', order: 'desc' }],
        filter: { operator: 'AND', terms: [{ name: `metadata.${ch.name}`, value_in: [name] }, { name: `metadata.${oc.name}`, exists: true }] } }) });
      const tally = {};
      for (const o of r.objects || []) {
        const v = ((o.metadata || {})[oc.name]);
        for (const x of (Array.isArray(v) ? v : v ? [v] : [])) tally[x] = (tally[x] || 0) + 1;
      }
      out[name] = { tagged: r.total, sampled: (r.objects || []).length, owners: Object.entries(tally).sort((a, b) => b[1] - a[1]),
        ...(only ? { sample: (r.objects || []).slice(0, 2) } : {}) };
    } catch (e) { out[name] = { error: String(e.message).slice(0, 200) }; }
  }));
  return out;
}


// ── Learned channel profile: what people actually tagged on this channel's recent uploads in Iconik ──
// Only assets someone finished ("All Metadata Updated?" on) count, so half-done uploads teach it nothing.
// Refreshed every 6 hours, so new uploads from anyone on the team keep teaching it.
const LEARN_FIELDS = ['OwningCreater', 'GuestCreator', 'TopTags', 'Series', 'Producer', 'Editor', 'League2', 'MLBFootage'];
const STOP = new Set('the and for with from this that what who how why are was were his her its our your you they them their into over just not but all any can has have had will about after before more most less very than then when where which while out off one get got new episode full'.split(' '));
const words = (t) => [...new Set(String(t || '').toLowerCase().replace(/[’']/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
const asList = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(String);
const vtGroup = (v) => /short/i.test(v) ? 'short' : /live/i.test(v) ? 'live' : 'long';

async function channelProfile(env, channel, fresh) {
  const key = 'prof2:' + sq(channel);
  if (!fresh && env.YT_AUTH) { const c = await env.YT_AUTH.get(key, 'json'); if (c && Date.now() - c.at < 6 * 3600e3) return c; }
  const objs = [];
  for (let page = 1; page <= 3; page++) {
    const r = await ik(env, `/search/v1/search/?per_page=100&page=${page}&generate_signed_url=false`, { method: 'POST', body: JSON.stringify({
      doc_types: ['assets'], include_fields: ['id', 'title', 'metadata.Title', 'metadata.VideoType', ...LEARN_FIELDS.map((f) => 'metadata.' + f)],
      sort: [{ name: 'date_created', order: 'desc' }],
      filter: { operator: 'AND', terms: [{ name: 'metadata.Channel', value_in: [channel] }, { name: 'metadata.FinalMetadataUpdated', value_in: ['true'] }] } }) });
    objs.push(...(r.objects || []));
    if ((r.objects || []).length < 100) break;
  }
  // Tags are free text in Iconik ("MLB" and "mlb" both exist): fold case, keep the most used spelling.
  const spell = {};
  for (const o of objs) for (const t of asList((o.metadata || {}).TopTags)) { const k = t.toLowerCase().trim(); (spell[k] ||= {})[t] = (spell[k][t] || 0) + 1; }
  const tagName = (t) => { const c = spell[t.toLowerCase().trim()]; return c ? Object.entries(c).sort((x, y) => y[1] - x[1])[0][0] : t; };
  const rows = objs.map((o) => {
    const m = o.metadata || {}, f = {};
    for (const k of LEARN_FIELDS) { const v = asList(m[k]); if (v.length) f[k] = k === 'TopTags' ? [...new Set(v.map(tagName))] : v; }
    return { w: words(asList(m.Title)[0] || o.title), vt: vtGroup(asList(m.VideoType)[0] || ''), f };
  });
  const out = { channel, at: Date.now(), n: rows.length, rows };
  if (env.YT_AUTH) await env.YT_AUTH.put(key, JSON.stringify(out), { expirationTtl: 7 * 86400 });
  return out;
}

// Predict a new upload's fields from the past uploads most like it: same kind (Short / Longform / Live),
// weighted by the title words they share (rare words count more). Only values most of them agree on come back.
async function learnPredict(env, b) {
  const prof = await channelProfile(env, b.channel || '');
  const vt = vtGroup(b.videoType || ''), mine = words(b.title);
  let pool = prof.rows.filter((r) => r.vt === vt);
  if (pool.length < 6) pool = prof.rows;
  if (!pool.length) return { channel: prof.channel, n: 0, picks: {} };
  const df = {}; for (const r of pool) for (const w of r.w) df[w] = (df[w] || 0) + 1;
  const idf = (w) => Math.log((pool.length + 1) / ((df[w] || 0) + 1));
  const scored = pool.map((r) => ({ r, s: mine.filter((w) => r.w.includes(w)).reduce((a, w) => a + idf(w), 0) })).sort((x, y) => y.s - x.s);
  // Close matches: within half the best score. Too few close matches → fall back to every upload of this kind.
  const best = scored[0].s, close = best > 1.5 ? scored.filter((x) => x.s >= best * 0.5).slice(0, 20) : [];
  const near = close.length >= 4 ? close : scored;
  const shared = close.length >= 4 ? [...new Set(close.flatMap((x) => mine.filter((w) => x.r.w.includes(w) && idf(w) > 1)))].slice(0, 4) : [];
  const picks = {};
  for (const k of LEARN_FIELDS) {
    const c = {}; let had = 0;
    for (const { r } of near) { const v = r.f[k]; if (!v) continue; had++; for (const x of v) c[x] = (c[x] || 0) + 1; }
    if (had < 3) continue;
    const cut = k === 'TopTags' ? 0.5 : 0.6;
    let vals = Object.entries(c).filter(([, n]) => n / had >= cut).sort((x, y) => y[1] - x[1]);
    // Specific tags (a team, a player) only when this title names them; the show's everyday tags always pass.
    if (k === 'TopTags') {
      const t = String(b.title || '').toLowerCase(), every = {};
      for (const r of pool) for (const x of r.f.TopTags || []) every[x] = (every[x] || 0) + 1;
      const tagged = pool.filter((r) => r.f.TopTags).length || 1;
      vals = vals.filter(([v]) => every[v] / tagged >= 0.3 || words(v).some((w) => w.length >= 4 && t.includes(w)));
    }
    if (vals.length) picks[k] = { values: vals.map(([v]) => v), agree: vals[0][1], of: had };
  }
  return { channel: prof.channel, n: prof.n, kind: vt, matched: near.length, like: shared, picks };
}

async function iconikCheck(env) {
  if (!env.ICONIK_APP_ID || !env.ICONIK_AUTH_TOKEN) return { ready: false, why: 'ICONIK_APP_ID / ICONIK_AUTH_TOKEN are not set on the worker yet.' };
  const view = await getView(env);
  const m = mapFields(view);
  return { ready: true, view: { id: view.id, name: view.name }, needsKey: !!env.PUSH_KEY,
    fields: Object.fromEntries(Object.entries(m).map(([k, f]) => [k, f ? { name: f.name, label: f.label, type: f.field_type, multi: !!f.multi, options: (f.options || []).length } : null])),
    allFields: (view.view_fields || []).map((f) => ({ name: f.name, label: f.label, type: f.field_type, required: !!f.required, multi: !!f.multi, ...(/warning|creator|channel|series|producer|editor/i.test(f.label || '') ? { options: f.options || [] } : {}) })) };
}

async function iconikPush(env, body) {
  if (!env.ICONIK_APP_ID || !env.ICONIK_AUTH_TOKEN) return [{ error: 'Iconik isn’t connected yet: the worker needs ICONIK_APP_ID and ICONIK_AUTH_TOKEN.' }, 503];
  let assetId = assetIdFrom(body.asset);
  if (!assetId) {
    const hits = await findAssets(env, body);
    if (hits.length !== 1) return [{ pick: hits, why: hits.length ? 'More than one Iconik asset matches. Pick the right one.' : 'No Iconik asset matches this title. Paste the Iconik asset link.' }, 200];
    assetId = hits[0].id;
  }
  const asset = await ik(env, `/assets/v1/assets/${assetId}/`);
  const view = await getView(env);
  const m = mapFields(view);
  // Poster first, so "Thumbnails Uploaded?" is only switched on when it really landed.
  let poster = null, posterError = null;
  if (body.thumbnail && !body.dryRun) { try { poster = await uploadPoster(env, assetId, body.thumbnail); } catch (e) { posterError = String(e && e.message || e); } }
  const metadata_values = {}, written = [], skipped = [];
  for (const [k, f] of Object.entries(m)) {
    if (TOGGLES.has(k)) continue;
    if (!f) { skipped.push({ field: FIELD_LABELS[k], why: 'not in the Iconik view' }); continue; }
    const fv = toFieldValues(f, k, (body.values || {})[k], body);
    if (fv.skip) { if (fv.skip !== 'empty') skipped.push({ field: f.label, why: fv.skip }); continue; }
    metadata_values[f.name] = fv; written.push(f.label);
  }
  // "All Metadata Updated?" goes on when every field Iconik requires was written; "Thumbnails Uploaded?" when the poster landed.
  const missingReq = (view.view_fields || []).filter((f) => f.required && Object.values(m).includes(f) && !metadata_values[f.name]).map((f) => f.label);
  const toggles = {};
  if (m.metaDone) { toggles.metaDone = !skipped.length && !missingReq.length; if (toggles.metaDone) { metadata_values[m.metaDone.name] = { field_values: [{ value: true }] }; written.push(m.metaDone.label); } }
  if (m.thumbDone && poster) { metadata_values[m.thumbDone.name] = { field_values: [{ value: true }] }; written.push(m.thumbDone.label); }
  // Clear Iconik's warning badges once the work they flag is done ("FINAL EDIT-NEEDS METADATA", "NEEDS THUMBNAILS").
  const warn = (label) => (view.view_fields || []).find((f) => sq(f.label) === sq(label));
  const cleared = [];
  const fw = warn('Final Asset-Warning'), tw = warn('Needs Thumbnails-Warning');
  if (fw && toggles.metaDone) { metadata_values[fw.name] = { field_values: [] }; cleared.push(fw.label); }
  if (tw && poster) { metadata_values[tw.name] = { field_values: [] }; cleared.push(tw.label); }
  if (!body.dryRun) await ik(env, `/metadata/v1/assets/${assetId}/views/${view.id}/`, { method: 'PUT', body: JSON.stringify({ metadata_values }) });
  return [{ ok: true, dryRun: !!body.dryRun, asset: { id: assetId, title: asset.title, url: `https://app.iconik.io/asset/${assetId}` }, written, skipped,
    missingRequired: missingReq, cleared, poster: poster ? 'uploaded' : posterError ? 'failed: ' + posterError : 'not sent', ...(body.dryRun ? { payload: { metadata_values } } : {}) }, 200];
}

// ───────────────────────── YouTube captions (our own channels) ─────────────────────────
// A channel manager signs in once (/yt/connect). The refresh token is kept in KV per channel, and the worker
// reads that channel's caption tracks with the official API (captions.list + captions.download).
// Secrets: YT_CLIENT_ID, YT_CLIENT_SECRET (an OAuth "Web application" client in the jomboy-tools Google project).
const WORKER_URL = 'https://jomboy-yt.jomboymedia.workers.dev';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const html = (body, s = 200) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>YouTube connection</title><body style="font:16px/1.5 system-ui;max-width:560px;margin:60px auto;padding:0 16px">${body}</body>`, { status: s, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

async function ytConnect(env) {
  if (!env.YT_CLIENT_ID) return html('<h2>Not set up yet</h2><p>The worker needs YT_CLIENT_ID and YT_CLIENT_SECRET first.</p>', 503);
  const state = crypto.randomUUID();
  await env.YT_AUTH.put('state:' + state, '1', { expirationTtl: 600 });
  const q = new URLSearchParams({ client_id: env.YT_CLIENT_ID, redirect_uri: WORKER_URL + '/yt/callback', response_type: 'code',
    scope: YT_SCOPE, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true', state });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}
async function ytCallback(env, url) {
  const code = url.searchParams.get('code'), state = url.searchParams.get('state');
  if (url.searchParams.get('error')) return html(`<h2>Not connected</h2><p>Google said: ${url.searchParams.get('error')}</p>`, 400);
  if (!code || !state || !(await env.YT_AUTH.get('state:' + state))) return html('<h2>That link expired</h2><p>Start again from the Connect link.</p>', 400);
  await env.YT_AUTH.delete('state:' + state);
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, redirect_uri: WORKER_URL + '/yt/callback', grant_type: 'authorization_code' }) })).json();
  if (!t.refresh_token) return html(`<h2>Not connected</h2><p>Google didn't hand back a lasting sign-in (${t.error || 'no refresh token'}). Try again.</p>`, 400);
  const ch = await (await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  const c = (ch.items || [])[0];
  if (!c) return html('<h2>No channel on that account</h2><p>When Google asks which account to use, pick the <b>channel</b> (for example Talkin\' Baseball), not your personal profile.</p>', 400);
  await env.YT_AUTH.put('rt:' + c.id, t.refresh_token);
  await env.YT_AUTH.put('name:' + c.id, c.snippet.title);
  return html(`<h2>Connected ${c.snippet.title} ✅</h2><p>Iconik Autofill can now read this channel's captions to find ad-read timestamps. You can close this tab.</p>`);
}
const tokenCache = {};
async function ytAccess(env, channelId) {
  const c = tokenCache[channelId];
  if (c && c.exp > Date.now() + 60000) return c.token;
  const rt = await env.YT_AUTH.get('rt:' + channelId);
  if (!rt) return null;
  const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env.YT_CLIENT_ID, client_secret: env.YT_CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }) })).json();
  if (!t.access_token) throw new Error('YouTube sign-in for this channel stopped working (' + (t.error || 'no token') + '). Reconnect it.');
  tokenCache[channelId] = { token: t.access_token, exp: Date.now() + (t.expires_in || 3000) * 1000 };
  return t.access_token;
}
// Private / scheduled videos are invisible to the API key. Try each connected channel's sign-in instead.
// Returns { item, channelId } or null.
async function ytOwnedVideo(env, id, parts) {
  const ks = await env.YT_AUTH.list({ prefix: 'rt:' });
  for (const k of ks.keys) {
    const ch = k.name.slice(3);
    try {
      const token = await ytAccess(env, ch);
      if (!token) continue;
      const d = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=${parts}&id=${id}`, { headers: { Authorization: 'Bearer ' + token } })).json();
      const it = (d.items || [])[0];
      if (it) return { item: it, channelId: ch };
    } catch {}
  }
  return null;
}
async function viaOwnedChannel(env, id) {
  const r = await ytOwnedVideo(env, id, 'snippet,contentDetails,liveStreamingDetails,status');
  if (!r) return null;
  const it = r.item, sn = it.snippet || {}, th = sn.thumbnails || {}, st = it.status || {};
  const scheduled = !!st.publishAt && st.privacyStatus !== 'public';
  return {
    id, title: sn.title || '', channel: sn.channelTitle || '', publishDate: scheduled ? st.publishAt : (sn.publishedAt || ''),
    lengthSeconds: isoDur((it.contentDetails || {}).duration), keywords: sn.tags || [], description: sn.description || '',
    category: '', thumbnail: (th.maxres || th.high || th.default || {}).url || '', via: 'channel-signin',
    live: !!it.liveStreamingDetails || (sn.liveBroadcastContent && sn.liveBroadcastContent !== 'none'),
    privacy: st.privacyStatus, scheduled, publishAt: st.publishAt || null,
  };
}
// "00:12:34.560" → seconds
const vttSec = (s) => s.split(':').reduce((a, x) => a * 60 + parseFloat(x), 0);
// Every place each search term is said. reads: [{id, terms:[...]}] → {id: [seconds…]}
async function ytAdTimes(env, videoId, reads) {
  if (!env.YT_KEY) throw new Error('YT_KEY missing');
  const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${env.YT_KEY}`)).json();
  let sn = ((v.items || [])[0] || {}).snippet;
  if (!sn) { const o = await ytOwnedVideo(env, videoId, 'snippet'); sn = o && o.item.snippet; }     // scheduled / private
  if (!sn) throw new Error('video not found');
  const token = await ytAccess(env, sn.channelId);
  if (!token) return { connected: false, channel: sn.channelTitle, connectUrl: WORKER_URL + '/yt/connect' };
  const auth = { Authorization: 'Bearer ' + token };
  const list = await (await fetch(`https://www.googleapis.com/youtube/v3/captions?part=snippet&videoId=${videoId}`, { headers: auth })).json();
  if (list.error) throw new Error('captions.list: ' + list.error.message);
  const tracks = list.items || [];
  const en = (t) => /^en/i.test(t.snippet.language || '');
  const track = tracks.find((t) => en(t) && t.snippet.trackKind !== 'asr') || tracks.find((t) => en(t)) || tracks[0];
  if (!track) return { connected: true, channel: sn.channelTitle, noCaptions: true };
  const r = await fetch(`https://www.googleapis.com/youtube/v3/captions/${track.id}?tfmt=vtt`, { headers: auth });
  if (!r.ok) throw new Error('captions.download ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const vtt = await r.text();
  // Flatten cues into one lowercase string, remembering where each cue starts.
  let text = '', marks = [];
  for (const m of vtt.matchAll(/(\d{1,2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3}) --> [^\n]*\n([\s\S]*?)(?=\n\n|$)/g)) {
    const words = m[2].replace(/<[^>]+>/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!words) continue;
    marks.push([text.length, vttSec(m[1])]);
    text += words + ' ';
  }
  const timeAt = (pos) => { let s = 0; for (const [p, t] of marks) { if (p > pos) break; s = t; } return s; };
  const out = {};
  for (const rd of reads || []) {
    const times = [];
    for (const term of rd.terms || []) {
      const key = String(term).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (key.length < 3) continue;
      const re = new RegExp('\\b' + key.split('').join(' ?') + '\\b', 'g');   // "seatgeek" also matches "seat geek"
      for (const m of text.matchAll(re)) times.push(Math.round(timeAt(m.index)));
    }
    out[rd.id] = [...new Set(times)].sort((a, b) => a - b);
  }
  return { connected: true, channel: sn.channelTitle, track: track.snippet.trackKind, hits: out };
}

// ───────────────────────── monday.com ─────────────────────────
// Secret: MONDAY_TOKEN (a personal API token). Read-only check for now.
async function mon(env, query, variables = {}) {
  const r = await fetch('https://api.monday.com/v2', { method: 'POST',
    headers: { Authorization: env.MONDAY_TOKEN, 'Content-Type': 'application/json', 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }) });
  const d = await r.json();
  if (!r.ok || d.errors || d.error_message) throw new Error('monday: ' + JSON.stringify(d.errors || d.error_message || d).slice(0, 300));
  return d.data;
}
// Ad-read boards by channel. Episodes are items; each ad read is a subitem with YT Link, Timestamp, Production Status.
// Each Iconik channel (same names as the folders under Iconik › Channels) → its monday board(s).
// Standard template columns; Talkin' Giants is the one board built from an older template.
const STD = { itemDate: 'dup__of_recording_date6__1',
  sub: { link: 'text__1', ts: 'text8__1', status: 'status__1', date: 'dup__of_publish_date7__1', tag: 'tags__1', sales: 'status' } };
const MONDAY_SHOWS = [
  { channel: "Talkin' Baseball", board: '7655278256', ...STD },
  { channel: "Talkin' Yanks", board: '7639193705', ...STD },
  { channel: "Talkin' Giants", board: '7581559368', itemDate: 'dup__of_recording_date__1', linkType: 'link',
    sub: { link: 'link__1', ts: 'text8__1', status: 'status__1', date: 'dup__of_date__1', tag: 'tags__1', sales: 'status' } },
  { channel: 'Shea Station', board: '7727385587', ...STD },
  { channel: 'Jolly Olive', board: '7654759133', ...STD },
  { channel: 'Wake n Jake', board: '7704231844', ...STD },
  { channel: 'Jomboy & Jake TV', board: '18406428859', show: 'Jomboy & Jake Radio', ...STD },
  { channel: 'JM Baseball', board: '7631118157', show: 'Baseball Today', ...STD },
  { channel: 'JM Baseball', board: '7646752999', show: 'JM Baseball Trivia', ...STD },
  { channel: 'Jomboy Media', board: '7641237614', show: 'Breakdowns', ...STD },
  { channel: 'JM Football', board: '7705065135', show: 'Football Today', ...STD },
  { channel: 'JM Football', board: '7657595719', show: 'JM Football Trivia', ...STD },
  { channel: 'Shelfy', board: '7714846314', ...STD },
  { channel: 'We Got Ice', board: '7654531987', group: 'We Got Ice', ...STD },
  { channel: 'Jack & Zo', board: '7654531987', group: 'Jack & Zo', ...STD },
  { channel: 'Warehouse Challenges', board: '18336429820', ...STD },
  { channel: 'Cherry Pinstripes', board: '7728401910', ...STD },
];
const PUBLISHED = 'Published';
const showsFor = (channel) => MONDAY_SHOWS.filter((c) => sq(c.channel) === sq(channel));
const dayOf = (t) => (String(t || '').match(/\d{4}-\d{2}-\d{2}/) || [''])[0];

async function boardEpisodes(env, cfg, date) {
  const S = cfg.sub, subCols = JSON.stringify([S.link, S.ts, S.status, S.date, S.tag, S.sales]);
  const gq = await mon(env, `query($ids:[ID!]){ boards(ids:$ids){ name groups{ id title } } }`, { ids: [cfg.board] });
  let groups = gq.boards[0].groups;
  if (cfg.group) groups = groups.filter((g) => g.title.toLowerCase().startsWith(cfg.group.toLowerCase()));
  // Only that year's groups ("2026 Standard", "2026 TPP's") when the board names them by year: keeps it to a second or two.
  const year = date.slice(0, 4), yearly = groups.filter((g) => g.title.includes(year));
  if (yearly.length) groups = yearly;
  const items = [];
  await Promise.all(groups.map(async (g) => {
    const d = await mon(env, `query($ids:[ID!], $g:[String]){ boards(ids:$ids){ groups(ids:$g){ items_page(limit:500){ items{ id name
      column_values(ids:["${cfg.itemDate}"]){ id text } subitems{ id name column_values(ids:${subCols}){ id text } } } } } } }`, { ids: [cfg.board], g: [g.id] });
    const grp = d.boards[0].groups[0];
    if (grp) for (const it of grp.items_page.items) items.push({ ...it, group: g.title });
  }));
  const val = (cols, id) => (cols.find((c) => c.id === id) || {}).text || '';
  // Livestreams and late uploads often land a day off the board's date, so look one day either side; off = 0 is an exact match.
  const shift = (n) => new Date(Date.parse(date + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const offOf = (it) => { const ds = [dayOf(val(it.column_values, cfg.itemDate)), ...(it.subitems || []).map((s) => dayOf(val(s.column_values, S.date)))];
    return ds.includes(date) ? 0 : ds.includes(shift(-1)) || ds.includes(shift(1)) ? 1 : -1; };
  return items.filter((it) => offOf(it) >= 0)
    .map((it) => ({ id: it.id, off: offOf(it), name: it.name, group: it.group, board: cfg.board, show: cfg.show || cfg.group || gq.boards[0].name,
      url: `https://jomboymedia.monday.com/boards/${cfg.board}/pulses/${it.id}`,
      reads: (it.subitems || []).map((s) => ({ id: s.id, name: s.name, tag: val(s.column_values, S.tag), sales: val(s.column_values, S.sales),
        status: val(s.column_values, S.status), link: val(s.column_values, S.link).replace(/^.* - (https?:)/, '$1'), ts: val(s.column_values, S.ts) })) }));
}

// Episode(s) for a publish date across every board that channel uses, with their ad-read subitems.
async function mondayEpisode(env, channel, date) {
  const shows = showsFor(channel);
  if (!shows.length) return { supported: false };
  if (!env.MONDAY_TOKEN) return { supported: true, error: 'MONDAY_TOKEN is not set' };
  const lists = await Promise.all(shows.map((c) => boardEpisodes(env, c, date)));
  return { supported: true, boards: shows.map((c) => c.show || c.channel), published: PUBLISHED, episodes: lists.flat() };
}

// Writes link + timestamp on each ad read, and Production Status → Published where asked.
async function mondayUpdate(env, channel, updates, board) {
  const shows = showsFor(channel);
  const cfg = shows.find((c) => c.board === String(board)) || (shows.length === 1 && shows[0]);
  if (!cfg) throw new Error('No monday board for ' + channel + (board ? ' / ' + board : ''));
  const S = cfg.sub, done = [], failed = [];
  for (const u of updates || []) {
    const cv = {};
    if (u.link) cv[S.link] = cfg.linkType === 'link' ? { url: String(u.link), text: String(u.link) } : String(u.link);
    if (u.ts) cv[S.ts] = String(u.ts);
    if (u.publish) cv[S.status] = { label: PUBLISHED };
    if (!Object.keys(cv).length) continue;
    try {
      // Subitems live on their own board; ask monday which one from the item id.
      const b = await mon(env, `query($id:[ID!]){ items(ids:$id){ board{ id } parent_item{ board{ id } } } }`, { id: [String(u.id)] });
      const it = b.items[0];
      if (!it || (it.parent_item && it.parent_item.board.id !== cfg.board)) throw new Error('That ad read is not on the ' + (cfg.show || channel) + ' board');
      await mon(env, `mutation($b:ID!, $i:ID!, $v:JSON!){ change_multiple_column_values(board_id:$b, item_id:$i, column_values:$v){ id } }`,
        { b: it.board.id, i: String(u.id), v: JSON.stringify(cv) });
      done.push(u.id);
    } catch (e) { failed.push({ id: u.id, why: String(e.message).slice(0, 200) }); }
  }
  return { done, failed };
}

async function mondayCheck(env, boardId) {
  if (!env.MONDAY_TOKEN) return { ready: false, why: 'MONDAY_TOKEN is not set' };
  if (boardId) {
    const d = await mon(env, `query($ids:[ID!]){ boards(ids:$ids){ id name items_count groups{ id title } columns{ id title type settings_str }
      items_page(limit:8){ items{ id name group{ title } column_values{ id text } subitems{ id name column_values{ id text } } } } } }`, { ids: [String(boardId)] });
    const b = d.boards[0];
    const sub = (b.items_page.items.find((i) => i.subitems.length) || {}).subitems?.[0];
    if (sub) {
      const s = await mon(env, `query($id:[ID!]){ items(ids:$id){ board{ id name columns{ id title type settings_str } } } }`, { id: [sub.id] });
      b.subitemBoard = s.items[0].board;
    }
    // Newest episodes: the group most recently added to, last items first.
    const g = await mon(env, `query($ids:[ID!]){ boards(ids:$ids){ groups{ title items_page(limit:100){ items{ id name created_at column_values{ id text } subitems{ id name column_values{ id text } } } } } } }`, { ids: [String(boardId)] });
    const all = g.boards[0].groups.flatMap((gr) => gr.items_page.items.map((i) => ({ ...i, group: gr.title })));
    all.sort((a, c) => String(c.created_at).localeCompare(String(a.created_at)));
    b.newest = all.slice(0, 6);
    return b;
  }
  const d = await mon(env, `{ me { name account { name } } boards(limit:200, order_by:used_at){ id name workspace{ name } } }`);
  return { ready: true, me: d.me.name, account: d.me.account.name,
    boards: d.boards.filter((b) => /ad|read|sponsor|partner|brand|integrat|talkin|production/i.test(b.name)).map((b) => `${b.id} · ${b.name} · ${(b.workspace || {}).name || ''}`) };
}


// ── Push to Iconik desktop app (/app/*, team push key required) ──
// The Mac app never holds Iconik, monday or YouTube credentials; it asks the worker for everything below.
const CHANNELS_FOLDER = '9dde77b6-c4d5-11f0-a7c7-7e333650b221';   // Iconik › Channels
async function collectionKids(env, id) {
  const out = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ik(env, `/assets/v1/collections/${id}/contents/?object_types=collections&per_page=100&page=${page}`);
    for (const o of r.objects || []) if (o.object_type === 'collections' || o.type === 'COLLECTION' || o.title) out.push({ id: o.id, title: o.title });
    if (!r.pages || page >= r.pages) break;
  }
  return out.sort((a, b) => String(a.title).localeCompare(String(b.title)));
}
// Channel folders with their series folders, cached 1 hour.
async function appFolders(env, fresh) {
  const k = 'appfolders';
  if (!fresh) { const c = await env.YT_AUTH.get(k, 'json'); if (c) return c; }
  const chans = await collectionKids(env, CHANNELS_FOLDER);
  const out = await Promise.all(chans.map(async (c) => ({ ...c, series: await collectionKids(env, c.id).catch(() => []) })));
  await env.YT_AUTH.put(k, JSON.stringify(out), { expirationTtl: 3600 });
  return out;
}
// One Iconik channel's status for the setup screen: monday boards, its YouTube channel, whether captions are connected.
async function appShow(env, channel) {
  const boards = showsFor(channel).map((c) => ({ board: c.board, show: c.show || c.group || c.channel, url: `https://jomboymedia.monday.com/boards/${c.board}` }));
  let yt = await env.YT_AUTH.get('ytmap:' + sq(channel), 'json');
  if (!yt && env.YT_KEY) yt = await ytFindChannel(env, channel).catch(() => null);
  if (yt) yt.connected = !!(await env.YT_AUTH.get('rt:' + yt.id));
  return { channel, boards, youtube: yt, connectUrl: WORKER_URL + '/yt/connect' };
}
async function ytFindChannel(env, q) {
  const key = env.YT_KEY, base = 'https://www.googleapis.com/youtube/v3/channels?part=snippet,contentDetails&key=' + key;
  const pick = (c, how) => c && { id: c.id, title: c.snippet.title, handle: c.snippet.customUrl || '', thumb: ((c.snippet.thumbnails || {}).default || {}).url || '', how };
  const h = String(q).trim();
  if (/^UC[\w-]{22}$/.test(h)) { const r = await (await fetch(base + '&id=' + h)).json(); return pick((r.items || [])[0], 'id'); }
  const handle = h.startsWith('@') ? h : '@' + h.replace(/[^A-Za-z0-9._-]/g, '');
  const r1 = await (await fetch(base + '&forHandle=' + encodeURIComponent(handle))).json();
  if ((r1.items || [])[0]) return pick(r1.items[0], 'handle');
  const s = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(h)}&key=${key}`)).json();
  const id = (((s.items || [])[0] || {}).id || {}).channelId;
  if (!id) return null;
  const r2 = await (await fetch(base + '&id=' + id)).json();
  return pick((r2.items || [])[0], 'search');
}
const isoSec = (d) => { const m = String(d || '').match(/P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? ((+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0)) : 0; };
// Newest uploads + livestreams on a channel, with length and live state, so the app can match an export to its video.
async function ytRecent(env, channelId) {
  if (!/^UC[\w-]{22}$/.test(channelId || '')) throw new Error('YouTube channel id needed');
  const key = env.YT_KEY;
  const pl = 'UU' + channelId.slice(2);
  // With the channel's sign-in, the uploads list includes scheduled and private videos (the key only sees public ones).
  let token = null; try { token = await ytAccess(env, channelId); } catch {}
  const auth = token ? { headers: { Authorization: 'Bearer ' + token } } : {};
  const q = token ? '' : '&key=' + key;
  const items = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=30&playlistId=${pl}${q}`, auth)).json();
  if (items.error) throw new Error('YouTube: ' + items.error.message);
  const ids = (items.items || []).map((i) => i.contentDetails.videoId);
  if (!ids.length) return { videos: [], signedIn: !!token };
  const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails,status&id=${ids.join(',')}${q}`, auth)).json();
  return { signedIn: !!token, videos: (v.items || []).map((x) => ({ id: x.id, url: 'https://www.youtube.com/watch?v=' + x.id, title: x.snippet.title,
    published: x.snippet.publishedAt, seconds: isoSec(x.contentDetails.duration), privacy: x.status.privacyStatus,
    publishAt: x.status.publishAt || null, scheduled: !!x.status.publishAt && x.status.privacyStatus !== 'public',
    live: x.snippet.liveBroadcastContent,            // 'none' | 'live' | 'upcoming'
    wasLive: !!x.liveStreamingDetails, ended: (x.liveStreamingDetails || {}).actualEndTime || null,
    thumb: ((x.snippet.thumbnails || {}).medium || {}).url || '' })) };
}
// S3 multipart pieces for exports over 5 GB.
async function uploadParts(env, b) {
  const a = assetIdFrom(b.assetId), f = assetIdFrom(b.fileId);
  if (!a || !f || !b.uploadId) throw new Error('assetId, fileId and uploadId are required');
  const q = new URLSearchParams({ upload_id: b.uploadId, parts_num: String(b.partsNum), per_page: String(b.perPage || 100), page: String(b.page || 1) });
  return await ik(env, `/files/v1/assets/${a}/files/${f}/multipart_url/part/?${q}`);
}
async function uploadCompleteUrl(env, b) {
  const a = assetIdFrom(b.assetId), f = assetIdFrom(b.fileId);
  if (!a || !f || !b.uploadId) throw new Error('assetId, fileId and uploadId are required');
  const q = new URLSearchParams({ upload_id: b.uploadId, type: 'complete_url', max_part_number: String(b.partsNum) });
  return await ik(env, `/files/v1/assets/${a}/files/${f}/multipart_url/?${q}`);
}
// A channel's newest YouTube uploads, each marked with whether Iconik already has it (Episode ID = video id),
// or a likely untagged match by title.
async function appMissing(env, channel, ytChannel, limit, source) {
  if (!/^UC[\w-]{22}$/.test(ytChannel || '')) throw new Error('YouTube channel id needed');
  limit = Math.min(Math.max(Number(limit) || 60, 10), 300);
  let token = null;
  for (let t = 0; t < 2 && !token; t++) { try { token = await ytAccess(env, ytChannel); } catch {} }   // Google's token endpoint blips now and then
  const auth = token ? { headers: { Authorization: 'Bearer ' + token } } : {};
  const q = token ? '' : '&key=' + env.YT_KEY;
  // The channel's playlists, for the source picker (Podcast, etc.).
  let playlists = [];
  try {
    const pl = await (await fetch(`https://www.googleapis.com/youtube/v3/playlists?part=snippet,contentDetails&maxResults=50&channelId=${ytChannel}${q}`, auth)).json();
    playlists = (pl.items || []).map((x) => ({ id: x.id, title: x.snippet.title, count: (x.contentDetails || {}).itemCount || 0 }));
  } catch {}
  const ids = []; let pageToken = '';
  source = source || 'uploads';
  if (source === 'live') {
    // Past livestreams (search, 100 quota units a page).
    while (ids.length < limit) {
      const r = await (await fetch(`https://www.googleapis.com/youtube/v3/search?part=id&type=video&eventType=completed&order=date&maxResults=50&channelId=${ytChannel}${pageToken ? '&pageToken=' + pageToken : ''}&key=${env.YT_KEY}`)).json();
      if (r.error) throw new Error('YouTube: ' + r.error.message);
      ids.push(...(r.items || []).map((i) => i.id.videoId).filter(Boolean));
      if (!r.nextPageToken) break; pageToken = r.nextPageToken;
    }
  } else {
    const plId = source === 'uploads' ? 'UU' + ytChannel.slice(2) : source;
    if (!/^(UU|PL|FL|OL)[\w-]+$/.test(plId)) throw new Error('bad playlist');
    while (ids.length < limit) {
      const r = await (await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?part=contentDetails&maxResults=50&playlistId=${plId}${pageToken ? '&pageToken=' + pageToken : ''}${q}`, auth)).json();
      if (r.error) throw new Error('YouTube: ' + r.error.message);
      ids.push(...(r.items || []).map((i) => i.contentDetails.videoId));
      if (!r.nextPageToken) break; pageToken = r.nextPageToken;
    }
  }
  const vids = [];
  for (let i = 0; i < Math.min(ids.length, limit); i += 50) {
    const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails,status&id=${ids.slice(i, Math.min(i + 50, limit)).join(',')}${q}`, auth)).json();
    for (const x of v.items || []) vids.push({ id: x.id, url: 'https://www.youtube.com/watch?v=' + x.id, title: x.snippet.title, published: x.snippet.publishedAt,
      seconds: isoSec(x.contentDetails.duration), privacy: x.status.privacyStatus, publishAt: x.status.publishAt || null,
      scheduled: !!x.status.publishAt && x.status.privacyStatus !== 'public', live: x.snippet.liveBroadcastContent, wasLive: !!x.liveStreamingDetails,
      thumb: ((x.snippet.thumbnails || {}).medium || {}).url || '' });
  }
  return { channel, source, playlists, signedIn: !!token, videos: vids, studio: `https://studio.youtube.com/channel/${ytChannel}/videos` };
}

// The Worker plan allows 50 outside calls per request, so the app asks for Iconik matches in chunks.
// Linked assets: which videos already have an asset carrying their id (clips share the episode's id, so keep the
// asset whose length matches the video, else the longest). body: { videos: [{id, seconds}] } (≤ 50)
async function appLinked(env, body) {
  const vids = (body.videos || []).slice(0, 50);
  const m = mapFields(await getView(env));
  const ep = m.episodeId && m.episodeId.name, md = m.metaDone && m.metaDone.name;
  const out = {};
  if (!ep || !vids.length) return { linked: out };
  const secsOf = new Map(vids.map((v) => [v.id, v.seconds]));
  const score = (o, vid) => { const d = Math.abs((o.duration_milliseconds || 0) / 1000 - (secsOf.get(vid) || 0)); return d <= 3 ? 1e9 - d : (o.duration_milliseconds || 0) / 1000; };
  for (let page = 1; page <= 40; page++) {
    const r = await ik(env, `/search/v1/search/?per_page=100&page=${page}&generate_signed_url=false`, { method: 'POST', body: JSON.stringify({
      doc_types: ['assets'], include_fields: ['id', 'title', 'duration_milliseconds', `metadata.${ep}`, ...(md ? [`metadata.${md}`] : [])],
      filter: { operator: 'AND', terms: [{ name: `metadata.${ep}`, value_in: vids.map((v) => v.id) }] } }) });
    for (const o of r.objects || []) {
      const vid = String(mval(o, ep) || ''); if (!vid) continue;
      const cur = out[vid], sc = score(o, vid);
      if (!cur || sc > cur.sc) out[vid] = { id: o.id, title: o.title, sc, clips: (cur ? cur.clips : 0), url: 'https://app.iconik.io/asset/' + o.id, metaDone: md ? String(mval(o, md)) === 'true' : true };
      out[vid].clips = (out[vid].clips || 0) + 1;
    }
    if (!r.pages || page >= r.pages) break;
  }
  // Only an asset as long as the video is the episode itself; shorter ones are clips that share its id.
  const linked = {}, clipsOnly = {};
  for (const [vid, a] of Object.entries(out)) { if (a.sc > 1e8) linked[vid] = a; else clipsOnly[vid] = a.clips; }
  return { linked, clipsOnly };
}
const mval = (o, f) => [].concat(((o.metadata || {})[f]) || []).map((x) => (x && typeof x === 'object' && 'value' in x) ? x.value : x)[0];
// Unfilled copies: assets in the channel's Iconik folder with the video's length (±1.5 s) and no Episode ID,
// e.g. the editor's final export when someone else filled a different asset. They count at ±1.5 s when they landed within
// 3 weeks of the video, or at ±10 s when the filename has the episode's date, a day either side ("TB_October 14th…"). body: { cid, videos: [{id, seconds, published}] } (≤ 40)
async function appCopies(env, body) {
  const cid = assetIdFrom(body.cid);
  if (!cid) throw new Error('channel folder id needed');
  const finals = (body.finals || []).map(assetIdFrom).filter(Boolean).slice(0, 60);
  const m = mapFields(await getView(env));
  const ep = m.episodeId && m.episodeId.name;
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const out = {};
  const vids = (body.videos || []).filter((v) => v.seconds > 0).slice(0, 40);
  for (let i = 0; i < vids.length; i += 8) await Promise.all(vids.slice(i, i + 8).map(async (v) => {
    try { const hits = await copiesFor(env, cid, finals, ep, v); if (hits.length) out[v.id] = hits; }
    catch (e) { out[v.id] = { error: String(e.message).slice(0, 120) }; }
  }));
  return { copies: out };
}
async function copiesFor(env, cid, finals, ep, v) {
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const r = await ik(env, '/search/v1/search/?per_page=15&generate_signed_url=false', { method: 'POST', body: JSON.stringify({
    doc_types: ['assets'], include_fields: ['id', 'title', 'duration_milliseconds', 'date_created', 'media_type', ...(ep ? [`metadata.${ep}`] : [])],
    // Only finished exports: inside the show's "Final Edits" folders when it has them (raw recordings share lengths).
    filter: { operator: 'AND', terms: [{ name: 'ancestor_collections', value_in: finals.length ? finals : [cid] },
      { name: 'duration_milliseconds', range: { min: String(Math.round(v.seconds * 1000 - 10000)), max: String(Math.round(v.seconds * 1000 + 10000)) } }] } }) });
  const pub = Date.parse(v.published);
  const days = [-1, 0, 1].map((k) => { const d = new Date(pub - 5 * 3600e3 + k * 864e5); return [MON[d.getUTCMonth()], d.getUTCDate()]; });
  const dated = (t) => { t = String(t || '').toLowerCase(); return days.some(([mo, dd]) => new RegExp(`(^|[^a-z])${mo}[a-z]*\\.?[ _-]*0?${dd}(st|nd|rd|th)?([^0-9a-z]|$)`).test(t)); };   // \\b fails after "_"
  return (r.objects || []).filter((o) => !(ep && mval(o, ep)) && o.media_type !== 'audio' && !/\.(wav|mp3|aif+)$/i.test(o.title || '')
    && ((Math.abs(o.duration_milliseconds / 1000 - v.seconds) <= 1.5 && Math.abs(Date.parse(o.date_created) - pub) < 21 * 864e5)
      || dated(o.title)))                     // exports run a few seconds off a live VOD, so a dated filename gets ±10 s
    .map((o) => ({ id: o.id, title: o.title, url: 'https://app.iconik.io/asset/' + o.id, dated: dated(o.title), created: o.date_created }));
}
// For the Autofill page: which Iconik asset this YouTube video belongs to. Its own linked asset (same length),
// else unfilled exports in the show's Final Edits. GET /iconik/find?v=&seconds=&published=&channel=
async function iconikFind(env, q) {
  const v = { id: q.get('v'), seconds: Number(q.get('seconds')) || 0, published: q.get('published') || new Date().toISOString() };
  if (!/^[\w-]{11}$/.test(v.id || '')) throw new Error('video id needed');
  const m = mapFields(await getView(env));
  const ep = m.episodeId && m.episodeId.name, md = m.metaDone && m.metaDone.name;
  let linked = null;
  if (ep) {
    const r = await ik(env, '/search/v1/search/?per_page=100&generate_signed_url=false', { method: 'POST', body: JSON.stringify({
      doc_types: ['assets'], include_fields: ['id', 'title', 'duration_milliseconds', `metadata.${ep}`, ...(md ? [`metadata.${md}`] : [])],
      filter: { operator: 'AND', terms: [{ name: `metadata.${ep}`, value_in: [v.id] }] } }) });
    const same = (r.objects || []).filter((o) => Math.abs((o.duration_milliseconds || 0) / 1000 - v.seconds) <= 3);
    if (same[0]) linked = { id: same[0].id, title: same[0].title, url: 'https://app.iconik.io/asset/' + same[0].id, metaDone: md ? String(mval(same[0], md)) === 'true' : true };
  }
  let copies = [];
  const chans = await appFolders(env);
  const c = chans.find((x) => sq(x.title) === sq(q.get('channel') || ''));
  if (c && v.seconds > 0) {
    const kids = (await appSubfolders(env, c.series.map((x) => x.id))).kids;
    const finals = Object.values(kids).flat().filter((k) => /^final[ _-]?edits?$/i.test(k.title)).map((k) => k.id);
    copies = (await copiesFor(env, c.id, finals, ep, v)).filter((x) => !linked || x.id !== linked.id);
  }
  return { linked, copies, channelFolder: c ? c.title : null };
}

// Sub-folders for up to 40 folders at once (Channels › channel › series › Final Edits …).
async function appSubfolders(env, ids) {
  const out = {};
  await Promise.all(ids.slice(0, 40).map(async (id) => {
    const k = 'kids:' + id;
    let v = await env.YT_AUTH.get(k, 'json');
    if (!v) { v = await collectionKids(env, id).catch(() => []); await env.YT_AUTH.put(k, JSON.stringify(v), { expirationTtl: 6 * 3600 }); }
    out[id] = v;
  }));
  return { kids: out };
}

async function appRoute(env, url, request) {
  const p = url.pathname, body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  if (p === '/app/key') return { ok: true };
  if (p === '/app/folders') return { channelsFolder: CHANNELS_FOLDER, channels: await appFolders(env, url.searchParams.get('fresh') === '1') };
  if (p === '/app/people') {
    const c = await iconikCheck(env);
    const opts = (label) => ((c.allFields || []).find((f) => sq(f.label) === sq(label)) || {}).options || [];
    return { producers: opts('Producer').map((o) => o.label || o.value), editors: opts('Editor').map((o) => o.label || o.value) };
  }
  if (p === '/app/show') return await appShow(env, url.searchParams.get('channel') || '');
  if (p === '/app/youtube/find') return { channel: await ytFindChannel(env, url.searchParams.get('q') || '') };
  if (p === '/app/youtube/save') {          // the first person to confirm a show's YouTube channel saves it for everyone
    const c = await ytFindChannel(env, body.youtube || '');
    if (!c) throw new Error('No YouTube channel found for ' + body.youtube);
    await env.YT_AUTH.put('ytmap:' + sq(body.channel), JSON.stringify(c));
    return { channel: c };
  }
  if (p === '/app/rules') {                // team filename rules: [{pattern, channel, channelId, series, seriesId}]
    if (request.method === 'POST') {
      const rules = (Array.isArray(body.rules) ? body.rules : []).filter((r) => r && r.pattern && r.channelId).slice(0, 200)
        .map((r) => ({ pattern: String(r.pattern).slice(0, 80), channel: String(r.channel || ''), channelId: String(r.channelId),
          series: String(r.series || ''), seriesId: String(r.seriesId || ''), sub: String(r.sub || ''), subId: String(r.subId || ''), by: String(r.by || '').slice(0, 60) }));
      await env.YT_AUTH.put('app:rules', JSON.stringify({ rules, updated: new Date().toISOString(), by: String(body.by || '').slice(0, 60) }));
      return { ok: true, count: rules.length };
    }
    return (await env.YT_AUTH.get('app:rules', 'json')) || { rules: [] };
  }
  if (p === '/app/linked') return await appLinked(env, body);
  if (p === '/app/copies') return await appCopies(env, body);
  if (p === '/app/subfolders') return await appSubfolders(env, String(url.searchParams.get('ids') || '').split(',').filter(Boolean));
  if (p === '/app/missing') return await appMissing(env, url.searchParams.get('channel') || '', url.searchParams.get('yt') || '', url.searchParams.get('limit'), url.searchParams.get('source'));
  if (p === '/app/youtube/recent') return await ytRecent(env, url.searchParams.get('channel'));
  if (p === '/app/upload/parts') return await uploadParts(env, body);
  if (p === '/app/upload/complete-url') return await uploadCompleteUrl(env, body);
  return null;
}


const INFO_PAGE = (title, body) => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:680px;margin:40px auto;padding:0 16px;color:#1a1a1a}h1{font-size:26px}</style><h1>${title}</h1>${body}`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const HOME_HTML = `<p>Iconik Autofill is an internal Jomboy Media production tool. Producers paste a YouTube link from one of our own channels and it fills in the asset's Iconik metadata, and checks off sponsored ad reads on our monday.com boards.</p><p>The tool lives at <a href="https://robsjomboy.github.io/Iconik-Autofill/">robsjomboy.github.io/Iconik-Autofill</a>. See the <a href="/privacy">privacy policy</a>.</p>`;
const PRIVACY_HTML = `<p>Iconik Autofill is an internal tool used by Jomboy Media staff.</p><p><b>What it accesses.</b> When a Jomboy Media channel manager connects a YouTube channel, the tool reads that channel's video caption tracks (YouTube scope youtube.force-ssl) so it can find where sponsor names are mentioned in our own videos. It does not upload, edit or delete anything on YouTube.</p><p><b>What it stores.</b> Only the channel's ID, name and a refresh token, kept in encrypted Cloudflare storage so the connection keeps working. Caption text is processed on the fly and not stored.</p><p><b>Sharing.</b> Nothing is sold or shared with third parties. Results are written only to Jomboy Media's own Iconik and monday.com workspaces.</p><p><b>Removing access.</b> Revoke it anytime at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>, and the stored token stops working.</p><p>Questions: contact Jomboy Media.</p>`;

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === '/' ) return INFO_PAGE('Iconik Autofill', HOME_HTML);
    if (url.pathname === '/privacy') return INFO_PAGE('Iconik Autofill · Privacy Policy', PRIVACY_HTML);
    if (url.pathname === '/yt/connect') return ytConnect(env);
    if (url.pathname === '/yt/callback') return ytCallback(env, url);
    if (url.pathname === '/yt/ads' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try { const b = await request.json(); const r = json(await ytAdTimes(env, b.videoId, b.reads)); r.headers.set('Cache-Control', 'no-store'); return r; }
      catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    }
    if (url.pathname === '/monday/episode' || url.pathname === '/monday/update') {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try {
        if (url.pathname === '/monday/episode') { const r = json(await mondayEpisode(env, url.searchParams.get('channel'), url.searchParams.get('date'))); r.headers.set('Cache-Control', 'no-store'); return r; }
        if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
        if (env.PUSH_KEY && request.headers.get('X-Push-Key') !== env.PUSH_KEY) return json({ error: 'Push key missing or wrong.', needsKey: true }, 401);
        const body = await request.json();
        const r = json(await mondayUpdate(env, body.channel, body.updates, body.board)); r.headers.set('Cache-Control', 'no-store'); return r;
      } catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    }
    if (url.pathname === '/monday/check') {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try { const r = json(await mondayCheck(env, url.searchParams.get('board'))); r.headers.set('Cache-Control', 'no-store'); return r; }
      catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    }
    if (url.pathname.startsWith('/app/')) {
      if (env.PUSH_KEY && request.headers.get('X-Push-Key') !== env.PUSH_KEY) return json({ error: 'Team push key missing or wrong.', needsKey: true }, 401);
      try { const r = await appRoute(env, url, request); if (!r) return json({ error: 'Unknown app route' }, 404);
        const res = json(r); res.headers.set('Cache-Control', 'no-store'); return res; }
      catch (e) { return json({ error: String(e && e.message || e) }, 502); }
    }
    if (url.pathname.startsWith('/iconik/')) {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try {
        if (url.pathname === '/iconik/channel-owners') { const r = json(await channelOwners(env, url.searchParams.get('channel'))); r.headers.set('Cache-Control', 'no-store'); return r; }
        if (url.pathname === '/iconik/learn' && request.method === 'POST') { const r = json(await learnPredict(env, await request.json())); r.headers.set('Cache-Control', 'no-store'); return r; }
        if (url.pathname === '/iconik/find') { const r = json(await iconikFind(env, url.searchParams)); r.headers.set('Cache-Control', 'no-store'); return r; }
        if (url.pathname === '/iconik/check') { const r = json(await iconikCheck(env)); r.headers.set('Cache-Control', 'no-store'); return r; }
        if ((url.pathname === '/iconik/upload/start' || url.pathname === '/iconik/upload/finish') && request.method === 'POST') {
          if (env.PUSH_KEY && request.headers.get('X-Push-Key') !== env.PUSH_KEY) return json({ error: 'Push key missing or wrong.', needsKey: true }, 401);
          const b = await request.json();
          const r = json(url.pathname.endsWith('start') ? await uploadStart(env, b) : await uploadFinish(env, b)); r.headers.set('Cache-Control', 'no-store'); return r;
        }
        if (url.pathname === '/iconik/push' && request.method === 'POST') {
          if (env.PUSH_KEY && request.headers.get('X-Push-Key') !== env.PUSH_KEY) return json({ error: 'Push key missing or wrong.', needsKey: true }, 401);
          const [b, st] = await iconikPush(env, await request.json());
          const r = json(b, st); r.headers.set('Cache-Control', 'no-store'); return r;
        }
      } catch (e) { return json({ error: String(e && e.message || e) }, 502); }
      return json({ error: 'Unknown Iconik route' }, 404);
    }
    if (url.pathname === '/suggest' && request.method === 'POST') {
      try { return json(await suggest(env, await request.json())); }
      catch (e) { return json({ error: 'AI suggestion failed: ' + (e && e.message || e) }, 502); }
    }
    const m = url.pathname.match(/^\/v\/([A-Za-z0-9_-]{11})\/?$/);
    if (!m) return json({ ok: true, service: 'jomboy-yt', usage: 'GET /v/<11-char videoId>' });
    const id = m[1];
    lastWhy = [];
    let out = null;
    if (env.YT_KEY && url.searchParams.get('via') !== 'owned') { try { out = await viaDataApi(id, env.YT_KEY); } catch { lastWhy.push('data api threw'); } }
    if (!out) { try { out = await viaOwnedChannel(env, id); } catch (e) { lastWhy.push('channel sign-in: ' + e.message); } }
    if (!out) { try { out = await viaPlayer(id); } catch {} }
    if (!out) { try { out = await viaWatchPage(id); } catch {} }
    if (out) out.short = out.lengthSeconds && out.lengthSeconds <= 180 ? await isShort(id) : false;
    if (out && out.scheduled) { const r = json(out); r.headers.set('Cache-Control', 'no-store'); return r; }
    return out ? json(out) : json({ error: 'YouTube did not return this video. If it is private or scheduled, its channel needs connecting once.', connectUrl: WORKER_URL + '/yt/connect', why: lastWhy }, 404);
  },
};
