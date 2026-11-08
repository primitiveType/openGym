/* The private API owns consent and reads the canonical training log. The public service only
   receives this allowlisted projection, never a session token or the profile state document. */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './durable.js';
import { workoutPayload } from './integrations/events.js';

export function sharedWorkouts(state) {
  return (Array.isArray(state?.workouts) ? state.workouts : []).filter(w => w && w.id != null).map(w => {
    const { bodyweight, note, ...shared } = workoutPayload(w, state);
    return shared;
  });
}

export function createSocialClient({ dataDir, users, readState, env = process.env, transport = fetch }) {
  const enabled = !!env.SOCIAL_URL;
  if (!enabled) return { enabled: false, call: async () => ({ enabled: false }), reconcile: async () => {}, remove: () => {}, onStateWrite: () => {} };
  const base = new URL(env.SOCIAL_URL);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Invalid SOCIAL_URL');
  const token = fs.readFileSync(env.SOCIAL_TOKEN_FILE || '/run/secrets/opengym_social', 'utf8').trim();
  if (token.length < 32) throw new Error('Social shared secret must be at least 32 characters');
  const file = path.join(dataDir, 'social-links.json');
  let links;
  try { links = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; links = {}; }
  if (!links || Array.isArray(links) || typeof links !== 'object') throw new Error('Invalid social-links.json');
  const save = () => atomicWrite(file, JSON.stringify(links), 0o600);
  const dirty = new Set(Object.keys(links));
  const revisions = new Map();
  let reconciling = false;
  async function send(uid, op, input = {}) {
    const response = await transport(new URL('/internal', base), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, uid, op }), signal: AbortSignal.timeout(15000), redirect: 'error' });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'Social service unavailable'), { status: response.status });
    return data;
  }
  async function reconcile() {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const uid of Object.keys(links)) {
        const user = users().find(u => u.id === uid);
        if (links[uid].deleted || !user) {
          await send(uid, 'delete'); delete links[uid]; save(); continue;
        }
        const state = readState(uid);
        if (!state) continue; // An unreadable/missing profile never empties shared history.
        const revision = state._wid || JSON.stringify(state);
        if (!dirty.has(uid) && revisions.get(uid) === revision) continue;
        await send(uid, 'sync', { workouts: sharedWorkouts(state), sharing: state.modules?.social !== false, initial: links[uid].initial === true });
        links[uid].initial = false; save();
        revisions.set(uid, revision); dirty.delete(uid);
      }
    } finally { reconciling = false; }
  }
  return { enabled,
    async call(user, op, input = {}) {
      const allowed = ['status', 'profile', 'feed', 'history', 'follow', 'accept', 'reject', 'unfollow', 'remove-friend', 'mute', 'block', 'visibility', 'like', 'comment', 'report', 'export', 'delete'];
      if (!allowed.includes(op)) throw Object.assign(new Error('Unknown social action'), { status: 400 });
      // admin comes from the authenticated account, never from request JSON.
      const out = await send(user.id, op, { ...input, admin: user.admin === true });
      if (op === 'profile') { links[user.id] = { initial: !links[user.id] }; save(); dirty.add(user.id); await reconcile(); }
      if (op === 'delete') { delete links[user.id]; save(); }
      return out;
    },
    reconcile,
    remove(uid) { if (links[uid]) { links[uid].deleted = true; save(); dirty.add(uid); } },
    onStateWrite(uid) { if (links[uid]) dirty.add(uid); },
  };
}

export function socialRoutes({ json, readBody, readSession, client, isAdmin }) {
  const route = fn => async (req, res) => {
    const user = readSession(req);
    if (!user) return json(res, 401, { error: 'not signed in' });
    try { await fn(req, res, { ...user, admin: isAdmin(user) }); }
    catch (e) { json(res, e.status && e.status < 500 ? e.status : 503, { error: e.status && e.status < 500 ? e.message : 'Social service unavailable. Your training log is safe.' }); }
  };
  return {
    'GET /api/social': route(async (req, res, user) => {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const view = params.get('view') || 'status';
      if (!['status', 'feed', 'history', 'export'].includes(view)) return json(res, 400, { error: 'Invalid social view' });
      json(res, 200, await client.call(user, view, { actor: params.get('actor') || undefined, offset: Number(params.get('offset') || 0) }));
    }),
    'POST /api/social': route(async (req, res, user) => {
      if (!client.enabled) return json(res, 404, { error: 'Social is not enabled on this server' });
      const body = await readBody(req);
      // readBody awaits; an account disabled/deleted meanwhile cannot publish.
      if (readSession(req)?.id !== user.id) return json(res, 401, { error: 'not signed in' });
      const { action, uid, op, admin, ...input } = body;
      json(res, 200, await client.call(user, action, input));
    }),
  };
}
