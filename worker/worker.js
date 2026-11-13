/**
 * Jomboy YouTube lookup — feeds the Iconik metadata helper.
 *
 *   GET  /v/<videoId>  → { id, title, channel, publishDate, lengthSeconds, keywords, description, thumbnail, live, short }
 *   POST /suggest      { video, lists } → { oneSentence, sport, sponsor: [..], mlbFootage }
 *                      (Workers AI; it may only answer with values that exist in `lists`)
 *
 * Browsers can't read YouTube's data directly (CORS), so this asks YouTube's player endpoint
 * on the page's behalf. No API key needed. Falls back to scraping the watch page.
 */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
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

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
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
