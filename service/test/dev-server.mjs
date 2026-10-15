// The upload service on this PC, against a pretend GitHub that keeps everything in memory:
// nothing leaves the PC. For trying Lap Logic's Publish before the service is deployed.
//
//   node service/test/dev-server.mjs           (http://127.0.0.1:8787)
//   set LAPLOGIC_TRACKS_URL=http://127.0.0.1:8787 before starting Lap Logic
//
// A live upload is added to the in-memory tracks.json at once (the GitHub Action's job);
// a confirmed duplicate becomes a pretend pull request and stays out of it.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { buildTrace } from '../src/layouts.js';

const PORT = Number(process.env.PORT || 8787);
const db = JSON.parse(readFileSync(new URL('../../tracks.json', import.meta.url), 'utf8'));
let pulls = 0;

globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), method = init.method || 'GET';
  const json = (status, body) => new Response(JSON.stringify(body), { status });
  if (u.pathname.endsWith('/contents/tracks.json')) return json(200, db);
  if (u.pathname.endsWith('/contents/layouts.json')) return json(200, { layouts: db.layouts });
  const m = u.pathname.match(/\/contents\/layouts\/(.+)\.json$/);
  if (m && method === 'GET') return json(db.layouts.some(l => l.id === m[1]) ? 200 : 404, {});
  if (m && method === 'PUT') {
    const body = JSON.parse(init.body);
    const file = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
    console.log(`${body.branch === 'main' || !body.branch ? 'LIVE  ' : 'REVIEW'} ${file.id}: ${file.name} (${file.length_m} m, ${file.path.length} points)`);
    if (!body.branch || body.branch === 'main') {
      const t = buildTrace(file.path);
      db.layouts.push({ ...file, short: file.name.slice(0, 31), venue: '', length_m: Math.round(t.lengthM) });
    }
    return json(201, {});
  }
  if (u.pathname.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'dev' } });
  if (u.pathname.endsWith('/git/refs')) return json(201, {});
  if (u.pathname.endsWith('/pulls')) return json(201, { html_url: `https://github.com/example/laplogic-tracks/pull/${++pulls}` });
  return json(404, {});
};

const env = { GITHUB_REPO: 'example/laplogic-tracks', GITHUB_TOKEN: 'dev', GITHUB_BRANCH: 'main' };
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers: req.headers, body }),
                               env, { waitUntil() {} });
  console.log(`${req.method} ${req.url} -> ${r.status}`);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, '127.0.0.1', () => console.log(`upload service (pretend GitHub) on http://127.0.0.1:${PORT}`));
