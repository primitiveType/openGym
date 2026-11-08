import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSocialClient, sharedWorkouts, socialRoutes } from '../social.js';

test('shared workout projection excludes body, notes, media, credentials and private state', () => {
  const state = { unit: 'kg', bodyweight: [{ w: 80 }], secret: 'private', workouts: [{ id: 'w1', d: '2026-11-08', name: 'Test', bw: 80, note: 'private note', entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 5, hr: 150, media: ['private'] }] }] }] };
  const out = sharedWorkouts(state);
  assert.equal(out[0].exercises[0].sets[0].weight, 60);
  assert.doesNotMatch(JSON.stringify(out), /bodyweight|private|heart|media|secret|note|150/);
});

test('social linking survives restart, retries source revisions and durably removes deleted accounts', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-client-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const secret = path.join(dataDir, 'token'); fs.writeFileSync(secret, 'x'.repeat(40));
  let offline = false;
  const sent = [], state = { _wid: 'one', workouts: [{ id: '1', d: '2026-11-08', entries: [] }] };
  const transport = async (_url, request) => { if (offline) throw new Error('offline'); sent.push(JSON.parse(request.body)); return Response.json({ ok: true }); };
  const options = { dataDir, users: () => [{ id: 'alice' }], readState: () => state,
    env: { SOCIAL_URL: 'http://social:3100', SOCIAL_TOKEN_FILE: secret }, transport };
  let client = createSocialClient(options);
  await client.call({ id: 'alice', admin: false }, 'profile', { uid: 'victim', admin: true, consent: true });
  assert.equal(sent[0].uid, 'alice'); assert.equal(sent[0].admin, false);
  assert.equal(sent[1].op, 'sync'); assert.equal(sent[1].initial, true);
  offline = true; state._wid = 'two'; client.onStateWrite('alice');
  await assert.rejects(client.reconcile(), /offline/);
  client = createSocialClient(options); offline = false;
  await client.reconcile();
  assert.equal(sent.at(-1).op, 'sync'); assert.equal(sent.at(-1).initial, false);
  client.remove('alice'); offline = true;
  await assert.rejects(client.reconcile());
  client = createSocialClient(options); offline = false; await client.reconcile();
  assert.equal(sent.at(-1).op, 'delete');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'social-links.json'))), {});
});

test('routes require a session and strip forged account, operation and admin fields', async () => {
  let user = { id: 'alice', admin: false }, called;
  const routes = socialRoutes({ json: (res, status, body) => Object.assign(res, { status, body }), readBody: async () => ({ action: 'like', id: 'post', uid: 'victim', op: 'delete', admin: true }), readSession: () => user,
    isAdmin: () => false, client: { enabled: true, call: async (...args) => { called = args; return { ok: true }; } } });
  const res = {};
  await routes['POST /api/social']({}, res);
  assert.deepEqual(called, [{ id: 'alice', admin: false }, 'like', { id: 'post' }]);
  user = null; await routes['POST /api/social']({}, res); assert.equal(res.status, 401);
});
