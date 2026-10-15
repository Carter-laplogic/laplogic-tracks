// The Lap Logic track upload service (a Cloudflare Worker, see service/README.md).
//
//   GET  /tracks.json   the public database (this repo's tracks.json, cached for a minute)
//   POST /upload        add a track: { name, sf: {lat, lon, heading}, half_width_m, path: [[lat, lon], ...],
//                       by?, confirm_duplicate? }
//        201 { status: "live", id }          a new track or a new layout: it is in the database now
//        409 { duplicates: [...] }           it looks like a track already there; nothing saved
//        202 { status: "review", id, pr }   sent again with confirm_duplicate: held for review (a pull request)
//   POST /upload with replace: "<layout id>"   the same track as that layout, with a better line or
//        lap: a pull request that updates the layout's file (202 as above; 400 if it is not the
//        same track, 404 if the layout is gone)
//        400 / 404 / 429 { error }
//
// It holds the GitHub token, so Lap Logic never does; the token can only write this repo.
import { buildTrace, cleanUpload, distM, findDuplicates, sameLayout, slug } from './layouts.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/tracks.json') return await tracksJson(env, ctx);
      if (request.method === 'GET' && url.pathname === '/') return reply(200, { service: 'Lap Logic tracks', repo: env.GITHUB_REPO });
      if (request.method === 'POST' && url.pathname === '/upload') return await upload(request, env);
      if (request.method === 'OPTIONS')
        return new Response(null, { headers: { ...JSON_HEADERS, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' } });
      return reply(404, { error: 'Not found' });
    } catch (e) {
      return reply(500, { error: 'The track service had a problem: ' + e.message });
    }
  },
};

// ─── GitHub ──────────────────────────────────────────────────────────────────

async function gh(env, path, init = {}) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: init.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
      'user-agent': 'laplogic-tracks-service',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  return r;
}

async function ghJson(env, path, init) {
  const r = await gh(env, path, init);
  if (!r.ok) throw new Error(`GitHub ${r.status} on ${path}`);
  return r.json();
}

function b64(text) {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * The current layouts straight from the repo (not the minute-old cached copy): layouts.json,
 * which leaves out the venues (tracks.json is megabytes with every circuit, too much to parse
 * on every upload); tracks.json for a repo built before layouts.json existed.
 */
async function currentDb(env) {
  const ref = env.GITHUB_BRANCH || 'main';
  let r = await gh(env, `/contents/layouts.json?ref=${ref}`, { raw: true });
  if (r.status === 404) r = await gh(env, `/contents/tracks.json?ref=${ref}`, { raw: true });
  if (!r.ok) throw new Error(`GitHub ${r.status} reading the layouts`);
  return r.json();
}

async function tracksJson(env, ctx) {
  const cache = caches.default;
  const key = new Request('https://cache.laplogic/tracks.json');
  let r = await cache.match(key);
  if (!r) {
    const up = await gh(env, `/contents/tracks.json?ref=${env.GITHUB_BRANCH || 'main'}`, { raw: true });
    if (!up.ok) return reply(502, { error: 'The track database is not reachable right now.' });
    r = new Response(await up.text(), { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=60' } });
    ctx.waitUntil(cache.put(key, r.clone()));
  }
  return r;
}

// ─── uploads ─────────────────────────────────────────────────────────────────

/** A few uploads per address per hour (needs the RATE_LIMIT KV namespace; without it, no limit). */
async function allowed(env, ip) {
  if (!env.RATE_LIMIT) return true;
  const key = `up:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const n = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (n >= (parseInt(env.UPLOADS_PER_HOUR || '10', 10))) return false;
  await env.RATE_LIMIT.put(key, String(n + 1), { expirationTtl: 3700 });
  return true;
}

async function freeId(env, name, layouts) {
  const base = slug(name);
  const taken = new Set((layouts || []).map(l => l.id));
  for (let i = 1; i < 100; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (taken.has(id)) continue;
    const r = await gh(env, `/contents/layouts/${id}.json?ref=${env.GITHUB_BRANCH || 'main'}`);
    if (r.status === 404) return id; // not uploaded since tracks.json was built either
  }
  throw new Error('no free id');
}

function summary(d) {
  const l = d.layout;
  return { id: l.id, name: l.name, venue: l.venue || '', length_m: l.length_m || 0, source: l.source || '',
           uploaded: l.uploaded || '', by: l.by || '', score: +d.score.toFixed(3), sf: l.sf, path: l.path };
}

async function upload(request, env) {
  let body;
  try { body = await request.json(); } catch { return reply(400, { error: 'Send the track as JSON.' }); }
  let layout;
  try { layout = cleanUpload(body); } catch (e) { return reply(400, { error: e.message }); }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await allowed(env, ip))) return reply(429, { error: 'Too many uploads from here this hour. Try again later.' });

  const db = await currentDb(env);
  if (body.replace != null) return await replaceLayout(env, db, String(body.replace), layout);
  const dups = findDuplicates(layout.trace, db.layouts);
  if (dups.length && !body.confirm_duplicate) return reply(409, { duplicates: dups.map(summary) });

  delete layout.trace;
  const id = await freeId(env, layout.name, db.layouts);
  const file = { id, ...layout, uploaded: new Date().toISOString().slice(0, 10) };
  const content = b64(JSON.stringify(file) + '\n');
  const branch = env.GITHUB_BRANCH || 'main';

  if (!dups.length) { // a new track or a new layout of a venue: live straight away
    await ghJson(env, `/contents/layouts/${id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ message: `Add ${layout.name}${layout.by ? ` (from ${layout.by})` : ''}`, content, branch }),
    });
    return reply(201, { status: 'live', id });
  }

  // the uploader says it is not the same as what is there: a pull request for a person to look at
  const head = await ghJson(env, `/git/ref/heads/${branch}`);
  const ref = `upload/${id}-${Date.now().toString(36)}`;
  await ghJson(env, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: head.object.sha }) });
  await ghJson(env, `/contents/layouts/${id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Add ${layout.name} (looks like an existing track)`, content, branch: ref }),
  });
  const list = dups.map(d => `- \`${d.layout.id}\` ${d.layout.name} (${Math.round(d.score * 100)} % on the same line)`).join('\n');
  const pr = await ghJson(env, '/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: `Upload: ${layout.name} (possible duplicate)`,
      head: ref,
      base: branch,
      body: `Uploaded from Lap Logic${layout.by ? ` by ${layout.by}` : ''}. The uploader was shown these tracks and said theirs is different:\n\n${list}\n\nMerge to publish it, close to drop it.`,
    }),
  });
  return reply(202, { status: 'review', id, pr: pr.html_url });
}

/** A better line / lap for a layout already there: a pull request that updates its file. */
async function replaceLayout(env, db, id, layout) {
  const target = (db.layouts || []).find(l => l.id === id);
  if (!target) return reply(404, { error: 'That track is not in the public database any more.' });
  const theirs = Array.isArray(target.path) && target.path.length >= 20 ? buildTrace(target.path) : null;
  const same = theirs ? sameLayout(layout.trace, theirs).same
                      : distM(layout.sf.lat, layout.sf.lon, target.sf.lat, target.sf.lon) < 100; // no lap to compare: the line
  if (!same) return reply(400, { error: `That is not the same track as ${target.name}. Send it as a new track instead.` });

  delete layout.trace;
  const file = { id, ...layout, name: target.name, uploaded: new Date().toISOString().slice(0, 10) };
  const branch = env.GITHUB_BRANCH || 'main';
  const head = await ghJson(env, `/git/ref/heads/${branch}`);
  const ref = `update/${id}-${Date.now().toString(36)}`;
  await ghJson(env, '/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${ref}`, sha: head.object.sha }) });
  const old = await gh(env, `/contents/layouts/${id}.json?ref=${ref}`);
  const sha = old.ok ? (await old.json()).sha : undefined;
  await ghJson(env, `/contents/layouts/${id}.json`, {
    method: 'PUT',
    body: JSON.stringify({ message: `Update ${target.name}${layout.by ? ` (from ${layout.by})` : ''}`, content: b64(JSON.stringify(file) + '\n'), branch: ref, ...(sha ? { sha } : {}) }),
  });
  const was = target.length_m ? `${target.length_m} m` : 'no lap';
  const pr = await ghJson(env, '/pulls', {
    method: 'POST',
    body: JSON.stringify({
      title: `Update: ${target.name}`,
      head: ref,
      base: branch,
      body: `A new start/finish line and lap for \`${id}\` from Lap Logic${layout.by ? `, sent by ${layout.by}` : ''} ` +
            `(${layout.length_m} m; the public one: ${was}). It is the same track by the duplicate rule.\n\nMerge to publish it, close to keep the old one.`,
    }),
  });
  return reply(202, { status: 'review', id, pr: pr.html_url });
}
