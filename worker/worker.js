/**
 * Jomboy YouTube lookup — feeds the Iconik metadata helper.
 *
 *   GET  /v/<videoId>  → { id, title, channel, publishDate, lengthSeconds, keywords, description, thumbnail, live, short }
 *   POST /suggest      { video, lists } → { oneSentence, sport, sponsor: [..], mlbFootage }
 *                      (Workers AI; it may only answer with values that exist in `lists`)
 *   GET  /iconik/check → is the Iconik token set, which view it found, how each page field maps to it
 *   POST /iconik/push  { asset?, videoId, title, values, publishedIso, dryRun? } → writes the metadata view on one asset
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

async function iconikCheck(env) {
  if (!env.ICONIK_APP_ID || !env.ICONIK_AUTH_TOKEN) return { ready: false, why: 'ICONIK_APP_ID / ICONIK_AUTH_TOKEN are not set on the worker yet.' };
  const view = await getView(env);
  const m = mapFields(view);
  return { ready: true, view: { id: view.id, name: view.name }, needsKey: !!env.PUSH_KEY,
    fields: Object.fromEntries(Object.entries(m).map(([k, f]) => [k, f ? { name: f.name, label: f.label, type: f.field_type, multi: !!f.multi, options: (f.options || []).length } : null])),
    allFields: (view.view_fields || []).map((f) => ({ name: f.name, label: f.label, type: f.field_type, required: !!f.required, multi: !!f.multi, ...(/warning|creator|channel|series/i.test(f.label || '') ? { options: f.options || [] } : {}) })) };
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
// "00:12:34.560" → seconds
const vttSec = (s) => s.split(':').reduce((a, x) => a * 60 + parseFloat(x), 0);
// Every place each search term is said. reads: [{id, terms:[...]}] → {id: [seconds…]}
async function ytAdTimes(env, videoId, reads) {
  if (!env.YT_KEY) throw new Error('YT_KEY missing');
  const v = await (await fetch(`https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${videoId}&key=${env.YT_KEY}`)).json();
  const sn = ((v.items || [])[0] || {}).snippet;
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
    if (url.pathname.startsWith('/iconik/')) {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try {
        if (url.pathname === '/iconik/channel-owners') { const r = json(await channelOwners(env, url.searchParams.get('channel'))); r.headers.set('Cache-Control', 'no-store'); return r; }
        if (url.pathname === '/iconik/check') { const r = json(await iconikCheck(env)); r.headers.set('Cache-Control', 'no-store'); return r; }
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
    if (env.YT_KEY) { try { out = await viaDataApi(id, env.YT_KEY); } catch { lastWhy.push('data api threw'); } }
    if (!out) { try { out = await viaPlayer(id); } catch {} }
    if (!out) { try { out = await viaWatchPage(id); } catch {} }
    if (out) out.short = out.lengthSeconds && out.lengthSeconds <= 180 ? await isShort(id) : false;
    return out ? json(out) : json({ error: 'YouTube did not return this video (private, unlisted-and-blocked, or wrong ID)', why: lastWhy }, 404);
  },
};
