/**
 * Jomboy YouTube lookup — feeds the Iconik metadata helper.
 *
 *   GET  /v/<videoId>  → { id, title, channel, publishDate, lengthSeconds, keywords, description, thumbnail }
 *   POST /suggest      { video, lists } → { oneSentence, topTags, contentTag, videoType, sport, sponsor, mlbFootage }
 *                      (Workers AI; it may only answer with values that exist in `lists`)
 *
 * Browsers can't read YouTube's data directly (CORS), so this asks YouTube's player endpoint
 * on the page's behalf. No API key needed. Falls back to scraping the watch page.
 */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
const json = (b, s = 200) => new Response(JSON.stringify(b), {
  status: s, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300', ...CORS } });

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
  if (!r.ok) return null;
  return shape(id, await r.json());
}

async function viaWatchPage(id) {
  const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36', 'Accept-Language': 'en-US', 'Cookie': 'CONSENT=YES+1' } });
  const html = await r.text();
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script)/s);
  if (!m) return null;
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
KIND: ${(v.lengthSeconds || 0) <= 70 ? 'a Short (vertical, under a minute)' : /\|\s*#?\s*\d{2,5}\s*$/.test(v.title || '') ? 'a full podcast episode (the title ends in its episode number)' : 'a clip cut from an episode (no episode number in the title)'}
YOUTUBE TAGS: ${(v.keywords || []).join(', ')}
DESCRIPTION:
${trimDescription(v.description || '')}

Answer with JSON only, using these keys. Every dropdown answer MUST be copied exactly from its list, or "" if none fits.
- "oneSentence": one complete sentence, 14-30 words, with a subject and a verb, telling a reader what happens in this video, e.g. "The guys react to a blockbuster deadline trade and argue over whether it actually fixes the rotation." (only an example of the style; describe THIS video) Do not just restate the title. Plain and specific, no hype, no hashtags, no host names unless the description names them. Do not start with "In this episode". Never use the word "fans".
- "topTags": array of up to 5 values from [${list('topTags')}]
- "contentTag": one value from [${list('contentTag')}]
- "videoType": one value from [${list('videoType')}]
- "sport": one value from [${list('sport')}]
- "sponsor": one value from [${list('sponsor')}] — the brand the description advertises, or the "none" option
- "mlbFootage": one value from [${list('mlbFootage')}] — only "yes" if the description credits MLB video/footage`;
  const r = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [{ role: 'user', content: prompt }], max_tokens: 400, temperature: 0.2,
    response_format: { type: 'json_object' },
  });
  let out = r.response;
  if (typeof out === 'string') { const m = out.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : {}; }
  // Never hand back a value Iconik doesn't have.
  const pick = (k, val) => (L[k] || []).find((o) => o.toLowerCase() === String(val || '').toLowerCase()) || '';
  return {
    oneSentence: String(out.oneSentence || '').trim(),
    topTags: [...new Set((Array.isArray(out.topTags) ? out.topTags : []).map((t) => pick('topTags', t)).filter(Boolean))],
    contentTag: pick('contentTag', out.contentTag), videoType: pick('videoType', out.videoType),
    sport: pick('sport', out.sport), sponsor: pick('sponsor', out.sponsor), mlbFootage: pick('mlbFootage', out.mlbFootage),
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
    let out = null;
    try { out = await viaPlayer(id); } catch {}
    if (!out) { try { out = await viaWatchPage(id); } catch {} }
    return out ? json(out) : json({ error: 'YouTube did not return this video (private, unlisted-and-blocked, or wrong ID)' }, 404);
  },
};
