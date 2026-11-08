import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSocial } from '../app.js';
import { listen } from '../server.js';
import { DatabaseSync } from 'node:sqlite';

const token = 'test-secret-'.repeat(4);
async function instance(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opengym-social-test-'));
  let app;
  const server = await listen({ get origin() { return app.origin; }, handle: req => app.handle(req) }, { port: 0 });
  app = createSocial({ origin: `http://127.0.0.1:${server.address().port}`, token, dataDir: dir, testMode: true });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return app;
}
const cmd = (app, uid, op, input = {}) => app.command({ ...input, uid, op });
const account = (app, uid) => cmd(app, uid, 'profile', { handle: uid, displayName: uid.toUpperCase(), bio: 'Training together', consent: true });
const workout = (name = 'Leg day') => ({ id: 'w1', name, date: '2026-11-08', unit: 'kg', durationMin: 45,
  totals: { sets: 1, reps: 5, volume: 500 }, exercises: [{ id: 'squat', name: 'Squat', sets: [{ weight: 100, reps: 5 }] }],
  bodyweight: 80, note: 'private note', heartRate: 150 });
async function drain(...apps) {
  for (let i = 0; i < 5; i++) for (const app of apps) await app.pump();
  for (const app of apps) assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM jobs').get().n, 0, 'Delivery queue must drain without failures');
}

test('two servers exchange signed follows, current history, interactions and revocation', async t => {
  const a = await instance(t), b = await instance(t);
  const alice = (await account(a, 'alice')).profile.actor;
  const bob = (await account(b, 'bob')).profile.actor;
  await account(b, 'stranger');
  await cmd(a, 'alice', 'sync', { workouts: [workout()], sharing: true, initial: true });
  const item = (await cmd(a, 'alice', 'history')).items[0];
  assert.equal(item.workout.bodyweight, undefined);
  assert.equal(item.workout.note, undefined);
  const unauth = await fetch(item.id, { headers: { Accept: 'application/activity+json' } });
  assert.equal(unauth.status, 401, 'Private object must reject anonymous reads');
  assert.equal((await cmd(b, 'stranger', 'history', { actor: alice })).items.length, 0);
  await cmd(b, 'bob', 'follow', { actor: alice });
  await drain(a, b);
  assert.equal((await cmd(a, 'alice', 'status')).relations[0].incoming, 'pending');
  await cmd(a, 'alice', 'accept', { actor: bob });
  await drain(a, b);
  assert.equal((await cmd(b, 'bob', 'status')).relations[0].outgoing, 'accepted');
  const history = await cmd(b, 'bob', 'history', { actor: alice });
  assert.equal(history.items.length, 1, 'Friends can browse workouts predating the follow');
  assert.equal(history.items[0].workout.name, 'Leg day');
  assert.equal(history.profile.displayName, 'ALICE');
  await cmd(a, 'alice', 'sync', { workouts: [workout('Updated session')], sharing: true });
  await drain(a, b);
  assert.equal((await cmd(b, 'bob', 'feed')).items[0].workout.name, 'Updated session');
  await cmd(b, 'bob', 'comment', { id: item.id, text: '<script>Good work</script>' });
  await cmd(b, 'bob', 'like', { id: item.id });
  await drain(a, b);
  const updated = (await cmd(a, 'alice', 'history')).items[0];
  assert.equal(updated.comments.length, 1);
  assert.equal(updated.comments[0].text, '<script>Good work</script>');
  assert.equal(updated.likes, 1);
  assert.equal((await cmd(b, 'bob', 'feed')).items[0].comments.length, 1);
  await cmd(a, 'alice', 'visibility', { id: item.id, visibility: 'public' });
  await drain(a, b);
  assert.equal((await fetch(item.id, { headers: { Accept: 'application/activity+json' } })).status, 200);
  const publicNote = await (await fetch(item.id, { headers: { Accept: 'application/activity+json' } })).text();
  assert.ok(!publicNote.includes('Good work'), 'Making a workout public must not expose earlier friends-only comments');
  assert.equal((await cmd(b, 'stranger', 'history', { actor: alice })).items.length, 1);
  await cmd(a, 'alice', 'visibility', { id: item.id, visibility: 'friends' });
  await drain(a, b);
  assert.equal((await fetch(item.id, { headers: { Accept: 'application/activity+json' } })).status, 401);
  assert.equal((await cmd(b, 'stranger', 'history', { actor: alice })).items.length, 0, 'An earlier public read does not authorize later private updates');
  const carol = (await account(b, 'carol')).profile.actor;
  await cmd(b, 'carol', 'follow', { actor: alice }); await drain(a, b);
  await cmd(a, 'alice', 'accept', { actor: carol }); await drain(a, b);
  assert.equal((await cmd(b, 'carol', 'history', { actor: alice })).items.length, 1);
  await cmd(a, 'alice', 'remove-friend', { actor: bob });
  await drain(a, b);
  assert.equal((await cmd(b, 'bob', 'history', { actor: alice })).items.length, 0);
  assert.equal((await cmd(b, 'carol', 'history', { actor: alice })).items.length, 1, 'Revocation for one local recipient must not revoke another');
  await cmd(a, 'alice', 'visibility', { id: item.id, visibility: 'private' }); await drain(a, b);
  assert.equal((await cmd(b, 'carol', 'feed')).items.length, 0);
  await cmd(a, 'alice', 'visibility', { id: item.id, visibility: 'friends' }); await drain(a, b);
  assert.equal((await cmd(b, 'carol', 'history', { actor: alice })).items.length, 1, 'Explicit re-sharing publishes a newer authorized version');
  await cmd(a, 'alice', 'delete'); await drain(a, b);
  assert.equal((await cmd(a, 'alice', 'status')).deleted, true);
  assert.equal((await cmd(b, 'carol', 'feed')).items.length, 0, 'Account deletion removes shared workout history');
});

test('consent, account ownership, module-off behavior, durable state and internal authentication', async t => {
  const a = await instance(t);
  await assert.rejects(cmd(a, 'alice', 'profile', { handle: 'alice' }), /consent/);
  await account(a, 'alice');
  await account(a, 'other');
  await cmd(a, 'alice', 'sync', { sharing: true, workouts: [workout()] });
  const item = (await cmd(a, 'alice', 'history')).items[0];
  await assert.rejects(cmd(a, 'other', 'visibility', { id: item.id, visibility: 'public' }), /not found/);
  await cmd(a, 'alice', 'sync', { sharing: false, workouts: [workout('Edited while off'), { ...workout(), id: 'new' }] });
  const history = await cmd(a, 'alice', 'history');
  assert.equal(history.items.length, 1);
  assert.equal(history.items[0].workout.name, 'Edited while off');
  assert.equal((await fetch(`${a.origin}/internal`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${a.origin}/internal`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: 'null' })).status, 400);
  assert.equal((await fetch(`${a.origin}/internal`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ uid: 'alice', op: 'status' }) })).status, 200);
  await cmd(a, 'alice', 'sync', { sharing: false, workouts: [] });
  assert.equal((await cmd(a, 'alice', 'history')).items.length, 0);
});

test('production refuses HTTP origins and protects private-network federation fetches', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => createSocial({ origin: 'http://example.com', token, dataDir: dir }), /HTTPS/);
  const app = createSocial({ origin: 'https://social.example.com', token, dataDir: dir });
  t.after(() => app.close());
  await account(app, 'alice');
  await assert.rejects(cmd(app, 'alice', 'follow', { actor: 'http://127.0.0.1:1/users/bob' }));
  const r = await app.handle(new Request('https://social.example.com/users/alice/inbox', { method: 'POST', headers: { 'Content-Type': 'application/activity+json' }, body: JSON.stringify({ '@context': 'https://www.w3.org/ns/activitystreams', type: 'Follow', id: 'https://bad.example/1', actor: 'https://bad.example/users/evil', object: 'https://social.example.com/users/alice' }) }));
  assert.notEqual(r.status, 202, 'Unsigned activities are refused');
  assert.equal((await cmd(app, 'alice', 'status')).relations.length, 0);
});

test('a consistent backup restores identity, audience choices and pending delivery without replaying while paused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'social-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { origin: 'https://social.example.com', token, dataDir: path.join(root, 'original') };
  const app = createSocial(config);
  const alice = (await account(app, 'alice')).profile.actor;
  await cmd(app, 'alice', 'sync', { sharing: true, workouts: [workout()] });
  const item = (await cmd(app, 'alice', 'history')).items[0];
  app.store.job('pending', { uid: 'alice', recipient: 'https://friend.example/users/bob', verb: 'Update', object: item.id, at: new Date().toISOString() });
  const before = await (await app.handle(new Request(alice, { headers: { Accept: 'application/activity+json' } }))).json();
  app.close();
  const restoredDir = path.join(root, 'restored');
  fs.cpSync(config.dataDir, restoredDir, { recursive: true });
  const restored = createSocial({ ...config, dataDir: restoredDir, paused: true });
  t.after(() => restored.close());
  const after = await (await restored.handle(new Request(alice, { headers: { Accept: 'application/activity+json' } }))).json();
  assert.deepEqual(after.publicKey, before.publicKey);
  assert.equal((await cmd(restored, 'alice', 'history')).items[0].visibility, 'friends');
  assert.equal(restored.store.jobs().length, 1);
  await restored.pump();
  assert.equal(restored.store.jobs().length, 1);
  assert.doesNotMatch(JSON.stringify(await cmd(restored, 'alice', 'export')), /privateKey|secret|keys/);
  assert.throws(() => createSocial({ ...config, dataDir: restoredDir, origin: 'https://new.example.com' }), /origin changed/);
});

test('newer schemas are refused without rewriting the version', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'social-newer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(path.join(dir, 'social.sqlite')); db.exec('PRAGMA user_version=99'); db.close();
  assert.throws(() => createSocial({ origin: 'https://social.example.com', token, dataDir: dir }), /newer/);
  const check = new DatabaseSync(path.join(dir, 'social.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); check.close();
});
