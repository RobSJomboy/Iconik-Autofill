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
};
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

async function iconikCheck(env) {
  if (!env.ICONIK_APP_ID || !env.ICONIK_AUTH_TOKEN) return { ready: false, why: 'ICONIK_APP_ID / ICONIK_AUTH_TOKEN are not set on the worker yet.' };
  const view = await getView(env);
  const m = mapFields(view);
  return { ready: true, view: { id: view.id, name: view.name }, needsKey: !!env.PUSH_KEY,
    fields: Object.fromEntries(Object.entries(m).map(([k, f]) => [k, f ? { name: f.name, label: f.label, type: f.field_type, multi: !!f.multi, options: (f.options || []).length } : null])) };
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
  const metadata_values = {}, written = [], skipped = [];
  for (const [k, f] of Object.entries(m)) {
    if (!f) { skipped.push({ field: FIELD_LABELS[k], why: 'not in the Iconik view' }); continue; }
    const fv = toFieldValues(f, k, (body.values || {})[k], body);
    if (fv.skip) { if (fv.skip !== 'empty') skipped.push({ field: f.label, why: fv.skip }); continue; }
    metadata_values[f.name] = fv; written.push(f.label);
  }
  if (!body.dryRun) await ik(env, `/metadata/v1/assets/${assetId}/views/${view.id}/`, { method: 'PUT', body: JSON.stringify({ metadata_values }) });
  return [{ ok: true, dryRun: !!body.dryRun, asset: { id: assetId, title: asset.title, url: `https://app.iconik.io/asset/${assetId}` }, written, skipped, ...(body.dryRun ? { payload: { metadata_values } } : {}) }, 200];
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname.startsWith('/iconik/')) {
      const origin = request.headers.get('Origin');
      if (origin && !PAGE_ORIGINS.includes(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) return json({ error: 'Not allowed from ' + origin }, 403);
      try {
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
