// node --test service/test   (Node 20+; no packages needed)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import worker from '../src/index.js';
import { buildTrace, cleanUpload, findDuplicates, sameLayout, slug } from '../src/layouts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const layout = id => JSON.parse(readFileSync(`${root}layouts/${id}.json`, 'utf8'));
const acw = layout('mcc-acw'), national = layout('mcc-national');

// the same lap driven again: GPS drifts a few metres
const redrive = p => p.map(([a, b], k) => [a + 4 * Math.sin(k / 37) / 111195, b + 4 * Math.cos(k / 53) / 86000]);
const upload = (l, extra = {}) => ({ name: l.name, sf: l.sf, half_width_m: 15, path: l.path, ...extra });

test('same layout: a re-drive matches, the other layout and the reverse do not', () => {
  const a = buildTrace(acw.path);
  assert.equal(sameLayout(a, buildTrace(redrive(acw.path))).same, true);
  assert.equal(sameLayout(a, buildTrace(national.path)).same, false);
  assert.equal(sameLayout(a, buildTrace([...acw.path].reverse())).same, false);
});

test('duplicates: only the matching layout of the venue', () => {
  const t = buildTrace(redrive(national.path));
  const d = findDuplicates(t, [acw, national]);
  assert.deepEqual(d.map(x => x.layout.id), ['mcc-national']);
});

test('upload checks', () => {
  assert.throws(() => cleanUpload({ name: 'x', sf: acw.sf, path: acw.path }), /2 to 60/);
  assert.throws(() => cleanUpload({ name: 'Somewhere', sf: { lat: 1, lon: 2 }, path: acw.path }), /0, 0/);
  assert.throws(() => cleanUpload({ name: 'Open', sf: acw.sf, path: acw.path.slice(0, 120) }), /closed lap/);
  const far = { lat: acw.sf.lat + 0.01, lon: acw.sf.lon };
  assert.throws(() => cleanUpload({ name: 'Elsewhere', sf: far, path: acw.path }), /start\/finish/);
  const ok = cleanUpload(upload(acw, { by: ' Carter\n' }));
  assert.equal(ok.by, 'Carter');
  assert.ok(ok.length_m > 900 && ok.length_m < 1100);
  assert.equal(slug('Autódromo José Carlos Pace!'), 'autodromo-jose-carlos-pace');
});

// ─── the upload flow against a pretend GitHub ────────────────────────────────

function fakeGitHub(layouts) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status });
    if (u.pathname.endsWith('/contents/tracks.json')) return json(200, { venues: [], layouts });
    if (method === 'GET' && u.pathname.includes('/contents/layouts/')) return json(404, {});
    if (method === 'PUT' && u.pathname.includes('/contents/layouts/')) return json(201, {});
    if (u.pathname.endsWith('/git/ref/heads/main')) return json(200, { object: { sha: 'abc' } });
    if (u.pathname.endsWith('/git/refs')) return json(201, {});
    if (u.pathname.endsWith('/pulls')) return json(201, { html_url: 'https://github.com/x/laplogic-tracks/pull/1' });
    return json(404, {});
  };
  return calls;
}

const env = { GITHUB_REPO: 'x/laplogic-tracks', GITHUB_TOKEN: 't' };
const post = body => new Request('https://tracks.example/upload', { method: 'POST', body: JSON.stringify(body) });

test('a new layout at a known venue goes live without asking', async () => {
  const calls = fakeGitHub([acw]);
  const r = await worker.fetch(post(upload(national)), env, {});
  assert.equal(r.status, 201);
  const b = await r.json();
  assert.equal(b.status, 'live');
  assert.equal(b.id, 'mcc-national');
  assert.ok(calls.includes('PUT /repos/x/laplogic-tracks/contents/layouts/mcc-national.json'));
});

test('a track that is already there: 409 with the matches, nothing written', async () => {
  const calls = fakeGitHub([acw, national]);
  const r = await worker.fetch(post(upload({ ...acw, name: 'MCC clockwise?', path: redrive(acw.path) })), env, {});
  assert.equal(r.status, 409);
  const b = await r.json();
  assert.deepEqual(b.duplicates.map(d => d.id), ['mcc-acw']);
  assert.ok(Array.isArray(b.duplicates[0].path));
  assert.ok(!calls.some(c => c.startsWith('PUT')));
});

test('confirmed duplicate: held for review as a pull request', async () => {
  const calls = fakeGitHub([acw]);
  const r = await worker.fetch(post(upload({ ...acw, path: redrive(acw.path) }, { confirm_duplicate: true })), env, {});
  assert.equal(r.status, 202);
  const b = await r.json();
  assert.equal(b.status, 'review');
  assert.equal(b.id, 'mcc-acw-2');
  assert.match(b.pr, /pull\/1$/);
  assert.ok(calls.includes('POST /repos/x/laplogic-tracks/pulls'));
});
