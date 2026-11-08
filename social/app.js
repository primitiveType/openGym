import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createFederation, generateCryptoKeyPair, exportJwk, importJwk } from '@fedify/fedify';
import { Person, Note, Source, Follow, Accept, Reject, Create, Update, Delete, Undo, Like, Tombstone, PUBLIC_COLLECTION, isActor } from '@fedify/vocab';
import { SqliteKvStore } from '@fedify/sqlite';
import { Temporal } from 'temporal-polyfill';
import { openStore } from './store.js';
import { cleanWorkout, hash, fail, text, escape, originOf, MEDIA_TYPE } from './model.js';

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const stamp = () => new Date().toISOString();
const instant = v => Temporal.Instant.from(v);
const equal = (a, b) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const PAGE = 30;

/** Private commands and public ActivityPub share storage, never authentication. */
export function createSocial({ origin, token, dataDir, testMode = false, paused = false, allowedDomains = [], blockedDomains = [] }) {
  const base = new URL(origin);
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password) throw new Error('SOCIAL_ORIGIN must be an origin without a path');
  if (base.protocol !== 'https:' && !(testMode && base.hostname === '127.0.0.1')) throw new Error('SOCIAL_ORIGIN requires HTTPS');
  if (typeof token !== 'string' || token.length < 32) throw new Error('Social shared secret must be at least 32 characters');
  origin = base.origin;
  const store = openStore(dataDir);
  const existingOrigin = store.get('config', 'origin');
  if (existingOrigin && existingOrigin !== origin) { store.close(); throw new Error('Social origin changed; restore the existing domain before starting'); }
  store.put('config', 'origin', origin);
  const federation = createFederation({ kv: new SqliteKvStore(store.db), allowPrivateAddress: testMode, signatureTimeWindow: { minutes: 5 } });
  const context = () => federation.createContext(new URL(origin), undefined);
  const newer = prior => new Date(Math.max(Date.now(), (Date.parse(prior) || 0) + 1)).toISOString();
  const actorUrl = p => `${origin}/users/${p.handle}`;
  const profiles = () => store.all('profile');
  const profile = uid => store.get('profile', uid);
  const byHandle = h => profiles().find(p => p.handle === h);
  const byActor = a => profiles().find(p => actorUrl(p) === a);
  const domainAllowed = a => {
    try { const host = new URL(a).hostname.toLowerCase(); return !blockedDomains.includes(host) && (!allowedDomains.length || allowedDomains.includes(host) || host === base.hostname); }
    catch { return false; }
  };
  const relKey = (uid, actor) => hash(uid + '\n' + actor);
  const relation = (uid, actor) => store.get('relation', relKey(uid, actor)) || { uid, actor };
  const saveRel = r => store.put('relation', relKey(r.uid, r.actor), r);
  const blocked = (owner, viewer) => {
    if (viewer && !domainAllowed(viewer)) return true;
    if (owner && !domainAllowed(owner)) return true;
    const a = byActor(owner), b = byActor(viewer);
    return !!((a && relation(a.uid, viewer).blocked) || (b && relation(b.uid, owner).blocked));
  };
  const approved = (owner, viewer) => {
    const p = byActor(owner);
    return !!(p && relation(p.uid, viewer).incoming === 'accepted' && !blocked(owner, viewer));
  };
  const canRead = (item, viewer) => {
    if (!item || item.deleted || blocked(item.owner, viewer)) return false;
    if (item.parent && !canRead(store.get('item', item.parent), viewer)) return false;
    if (item.owner === viewer || item.rootOwner === viewer || item.visibility === 'public') return true;
    if (item.visibility !== 'friends') return false;
    return item.remote ? (item.readers || []).includes(viewer) : approved(item.rootOwner || item.owner, viewer);
  };
  const followers = p => store.all('relation').filter(r => r.uid === p.uid && r.incoming === 'accepted' && !r.blocked).map(r => r.actor);
  const audience = item => {
    const p = byActor(item.rootOwner || item.owner);
    return [...new Set([...(p ? followers(p) : item.recipients || []), ...(item.rootOwner ? [item.rootOwner] : [])])].filter(a => a !== item.owner && !blocked(item.owner, a));
  };
  const notice = (uid, kind, actor, object) => {
    const id = hash([uid, kind, actor, object].join('\n'));
    store.put('notice', id, { id, uid, kind, actor, object, at: stamp() });
    const old = store.all('notice').filter(n => n.uid === uid).sort((a, b) => b.at.localeCompare(a.at)).slice(200);
    for (const n of old) store.remove('notice', n.id);
  };
  const schedule = (p, recipient, verb, object, extra = {}) => {
    store.job(randomUUID(), { uid: p.uid, recipient, verb, object, event: `${origin}/activities/${randomUUID()}`, at: stamp(), ...extra });
  };
  const publish = (p, item, verb = 'Update') => {
    for (const a of audience(item)) schedule(p, a, verb, item.id);
  };
  const retract = (p, item, recipients = audience(item)) => {
    for (const a of recipients) schedule(p, a, 'Delete', item.id, { force: true, at: item.updated });
  };
  const scrub = p => ({ actor: actorUrl(p), handle: `@${p.handle}@${base.host}`, displayName: p.displayName, bio: p.bio, publicProfile: !!p.publicProfile });
  const actor = async (ctx, p) => {
    if (!p) return null;
    // Keep public verification keys available until every signed deletion has been delivered.
    if (p.deleted && !store.db.prepare("SELECT 1 FROM jobs WHERE json_extract(value,'$.uid')=? LIMIT 1").get(p.uid)) return new Tombstone({ id: new URL(actorUrl(p)), formerType: Person, deleted: instant(p.deleted) });
    const keys = await ctx.getActorKeyPairs(p.handle);
    const viewer = typeof ctx.getSignedKeyOwner === 'function' ? (await ctx.getSignedKeyOwner())?.id?.href : null;
    const showProfile = p.publicProfile || viewer === actorUrl(p) || approved(actorUrl(p), viewer);
    return new Person({ id: new URL(actorUrl(p)), preferredUsername: p.handle,
      name: showProfile ? p.displayName : p.handle, summary: showProfile ? escape(p.bio) : '',
      inbox: ctx.getInboxUri(p.handle), outbox: ctx.getOutboxUri(p.handle), manuallyApprovesFollowers: true,
      publicKey: keys[0]?.cryptographicKey, assertionMethods: keys.map(k => k.multikey),
    });
  };
  const note = (item, viewer = null) => {
    const recipients = audience(item);
    const w = item.workout;
    const content = w ? `<p>${escape(w.name || 'Workout')} · ${escape(w.date)} · ${w.totals.sets} sets · ${w.totals.volume} ${w.unit}</p>` : `<p>${escape(item.text)}</p>`;
    return new Note({ id: new URL(item.id), attribution: new URL(item.owner),
      name: w ? w.name : null, content, mediaType: 'text/html',
      source: new Source({ mediaType: MEDIA_TYPE, content: JSON.stringify({ version: 1, kind: item.kind,
        ...(w ? { workout: w,
          comments: store.all('item').filter(c => c.parent === item.id && !c.deleted && (item.visibility !== 'public' || c.visibility === 'public')).slice(-200).map(c => ({ id: c.id, owner: c.owner, text: c.text, published: c.published })),
          likes: store.all('like').filter(l => l.object === item.id && (item.visibility !== 'public' || l.visibility === 'public')).slice(-1000).map(l => l.actor),
        } : { text: item.text }) }) }),
      published: instant(item.published), updated: instant(item.updated),
      replyTarget: item.parent ? new URL(item.parent) : null,
      tos: item.visibility === 'public' ? [PUBLIC_COLLECTION] : (viewer ? [new URL(viewer)] : recipients.map(a => new URL(a))),
    });
  };
  federation.setActorDispatcher('/users/{identifier}', (ctx, identifier) => actor(ctx, byHandle(identifier)))
    .setKeyPairsDispatcher(async (_ctx, identifier) => {
      const p = byHandle(identifier);
      if (!p) return [];
      return [{ publicKey: await importJwk(p.keys.publicKey, 'public'), privateKey: await importJwk(p.keys.privateKey, 'private') }];
    });
  const requestViewer = async ctx => (await ctx.getSignedKeyOwner())?.id?.href || null;
  federation.setObjectDispatcher(Note, '/objects/{id}', async (ctx, { id }) => {
    const item = store.get('item', `${origin}/objects/${id}`);
    if (!item) return null;
    if (item.deleted) return new Tombstone({ id: new URL(item.id), formerType: Note, deleted: instant(item.deleted) });
    return note(item, await requestViewer(ctx));
  }).authorize(async (ctx, { id }) => canRead(store.get('item', `${origin}/objects/${id}`), await requestViewer(ctx)));
  federation.setOutboxDispatcher('/users/{identifier}/outbox', async (ctx, identifier, options) => {
    const p = byHandle(identifier);
    if (!p || p.deleted) return null;
    const viewer = await requestViewer(ctx);
    const all = store.all('item').filter(i => i.owner === actorUrl(p) && i.kind === 'workout' && canRead(i, viewer)).sort((a, b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id));
    const offset = /^\d{1,6}$/.test(options.cursor || '') ? Number(options.cursor) : 0;
    return { items: all.slice(offset, offset + PAGE).map(i => new Create({ id: new URL(`${i.id}/create`), actor: new URL(i.owner), object: note(i, viewer), tos: note(i, viewer).toIds })),
      nextCursor: offset + PAGE < all.length ? String(offset + PAGE) : null };
  }).setFirstCursor(() => '0');

  async function receive(ctx, activity, backfill = false) {
    const p = byHandle(ctx.recipient);
    const sender = activity.actorId?.href;
    if (!p || p.deleted || !sender || !activity.id || blocked(actorUrl(p), sender)) return;
    const me = actorUrl(p), r = relation(p.uid, sender);
    if (activity instanceof Follow) {
      if (activity.objectId?.href !== me) return;
      saveRel({ ...r, incoming: r.incoming === 'accepted' ? 'accepted' : 'pending', follow: activity.id.href });
      notice(p.uid, 'follow', sender, activity.id.href);
      return;
    }
    if (activity instanceof Accept || activity instanceof Reject) {
      if (r.outgoing !== 'pending' || activity.objectId?.href !== r.request) return;
      saveRel({ ...r, outgoing: activity instanceof Accept ? 'accepted' : 'rejected' });
      notice(p.uid, 'accepted', sender, activity.id.href);
      return;
    }
    if (activity instanceof Undo) {
      const obj = await activity.getObject(ctx);
      if (obj?.actorId?.href !== sender) return;
      if (obj instanceof Follow && obj.objectId?.href === me && obj.id?.href === r.follow) {
        saveRel({ ...r, incoming: null });
      } else if (obj instanceof Like) {
        const key = hash(sender + '\n' + obj.objectId?.href);
        if (store.get('like', key)?.activity === obj.id?.href) {
          store.remove('like', key);
          const root = store.get('item', obj.objectId?.href);
          if (root && !root.remote) { const changed = { ...root, updated: newer(root.updated) }; store.put('item', root.id, changed); publish(p, changed); }
        }
      }
      return;
    }
    if (activity instanceof Delete) {
      const old = store.get('item', activity.objectId?.href);
      if (old?.owner !== sender) return;
      const at = activity.published?.toString() || stamp();
      if (Date.parse(at) < Date.parse(old.updated)) return;
      const readers = (old.readers || []).filter(a => a !== me);
      const gone = old.visibility === 'public' || readers.length === 0;
      store.put('item', old.id, { ...old, readers, revoked: { ...old.revoked, [me]: at },
        ...(gone ? { updated: at, deleted: at, workout: null, text: '' } : {}) });
      return;
    }
    if (activity instanceof Like) {
      const target = store.get('item', activity.objectId?.href);
      if (!target || target.remote || !canRead(target, sender)) return;
      store.put('like', hash(sender + '\n' + target.id), { actor: sender, object: target.id, activity: activity.id.href, visibility: target.visibility });
      notice(p.uid, 'like', sender, target.id);
      const changed = { ...target, updated: newer(target.updated) };
      store.put('item', target.id, changed); publish(p, changed);
      return;
    }
    if (!(activity instanceof Create || activity instanceof Update)) return;
    const obj = await activity.getObject(ctx);
    if (!(obj instanceof Note) || !obj.id || obj.attributionId?.href !== sender || originOf(obj.id.href) !== originOf(sender)) return;
    if (obj.source?.mediaType !== MEDIA_TYPE || typeof obj.source.content !== 'string' || obj.source.content.length > 150000) return;
    let data;
    try { data = JSON.parse(obj.source.content); } catch { return; }
    if (data.version !== 1 || !['workout', 'comment'].includes(data.kind)) return;
    const parent = obj.replyTargetId?.href;
    const root = parent && store.get('item', parent);
    if (data.kind === 'comment' && (!root || !canRead(root, sender) || !canRead(root, me))) return;
    const publicPost = obj.toIds.some(a => a.href === PUBLIC_COLLECTION.href) || obj.ccIds.some(a => a.href === PUBLIC_COLLECTION.href);
    if (data.kind === 'workout' && r.outgoing !== 'accepted' && !(backfill && publicPost)) return;
    if (!publicPost && !obj.toIds.some(a => a.href === me)) return;
    if (root && root.visibility !== 'public' && publicPost) return;
    const old = store.get('item', obj.id.href);
    const updated = obj.updated?.toString() || obj.published?.toString();
    if (!updated || !obj.published || Date.parse(updated) > Date.now() + 300000) return;
    if (old && (old.owner !== sender || Date.parse(updated) < Date.parse(old.updated) || Date.parse(updated) <= Date.parse(old.revoked?.[me] || 0) || (old.deleted && Date.parse(updated) <= Date.parse(old.deleted)))) return;
    const item = { id: obj.id.href, owner: sender, remote: true, kind: data.kind,
      parent: parent || null, rootOwner: root?.owner || null, visibility: publicPost ? 'public' : 'friends',
      readers: [...new Set([...(old?.visibility === 'public' && !publicPost ? [] : old?.readers || []), me])], revoked: old?.revoked,
      published: old?.published || obj.published.toString(), updated,
      ...(data.kind === 'workout' ? { workout: cleanWorkout(data.workout),
        interactions: { comments: (Array.isArray(data.comments) ? data.comments : []).slice(0, 200).map(c => ({ id: text(c?.id, 1000), owner: text(c?.owner, 1000), text: text(c?.text, 2000), published: text(c?.published, 40) })),
          likes: (Array.isArray(data.likes) ? data.likes : []).slice(0, 1000).filter(a => typeof a === 'string' && a.length < 1000) },
      } : { text: text(data.text, 2000) }),
    };
    store.put('item', item.id, item);
    if (item.kind === 'comment' && !old) {
      notice(p.uid, 'comment', sender, parent);
      if (!root.remote) { const changed = { ...root, updated: newer(root.updated) }; store.put('item', root.id, changed); publish(p, changed); }
    }
  }
  const inbox = federation.setInboxListeners('/users/{identifier}/inbox');
  for (const cls of [Follow, Accept, Reject, Create, Update, Delete, Undo, Like]) inbox.on(cls, receive);

  async function lookup(p, target) {
    if (typeof target !== 'string' || target.length > 1000) fail(400, 'Invalid account');
    const domain = target.startsWith('https://') || target.startsWith('http://') ? target : `https://${target.split('@').filter(Boolean).at(-1)}`;
    if (!domainAllowed(domain)) fail(403, 'This server is not allowed to federate');
    const ctx = context();
    const found = await ctx.lookupObject(target, { documentLoader: await ctx.getDocumentLoader({ identifier: p.handle }) });
    if (!isActor(found) || !found.id || !found.inboxId || !domainAllowed(found.id.href) || !['https:', ...(testMode ? ['http:'] : [])].includes(found.id.protocol)) fail(400, 'Account not found');
    return found;
  }
  function itemView(i, viewer) {
    const likes = store.all('like').filter(l => l.object === i.id && (i.visibility !== 'public' || l.visibility === 'public'));
    const comments = new Map((i.interactions?.comments || []).map(c => [c.id, c]));
    for (const c of store.all('item').filter(c => c.parent === i.id && canRead(c, viewer) && (i.visibility !== 'public' || c.visibility === 'public'))) comments.set(c.id, { id: c.id, owner: c.owner, text: c.text, published: c.published });
    return { ...i, readers: undefined, recipients: undefined, revoked: undefined,
      likes: new Set([...likes.map(l => l.actor), ...(i.interactions?.likes || [])]).size, liked: likes.some(l => l.actor === viewer) || (i.interactions?.likes || []).includes(viewer),
      comments: [...comments.values()], interactions: undefined,
    };
  }
  function sync(p, input) {
    if (!Array.isArray(input.workouts) || input.workouts.length > 10000) fail(400, 'Too many workouts or invalid shared history');
    const all = input.workouts.map(cleanWorkout), ids = new Set();
    store.transaction(() => {
      store.put('profile', p.uid, { ...p, sharing: input.sharing === true });
      for (const workout of all) {
        const id = `${origin}/objects/${hash(p.uid + '\n' + workout.id)}`;
        ids.add(id);
        const old = store.get('item', id);
        if (!old && input.sharing !== true) continue;
        if (old && JSON.stringify(old.workout) === JSON.stringify(workout) && !old.deleted) continue;
        const updated = newer(old?.updated);
        const item = { id, owner: actorUrl(p), kind: 'workout', visibility: old?.visibility || 'friends',
          workout, published: old?.published || (/^\d{4}-\d{2}-\d{2}$/.test(workout.date) && Number.isFinite(Date.parse(workout.date)) ? new Date(workout.date + 'T12:00:00Z').toISOString() : updated), updated };
        store.put('item', id, item);
        if (old || !input.initial) publish(p, item, old ? 'Update' : 'Create');
      }
      for (const old of store.all('item').filter(i => i.owner === actorUrl(p) && i.kind === 'workout' && !i.deleted && !ids.has(i.id))) {
        const item = { ...old, updated: stamp(), deleted: stamp(), workout: null };
        store.put('item', old.id, item);
        retract(p, item);
      }
    });
    return { ok: true };
  }
  const budgets = new Map();
  async function command(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, 'Invalid social command');
    const uid = text(input.uid, 80);
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(uid)) fail(400, 'Invalid local account');
    if (!['sync', 'status'].includes(input.op)) {
      const key = uid + (['feed', 'history', 'export'].includes(input.op) ? ':read' : ':write');
      const budget = budgets.get(key), now = Date.now();
      const entry = !budget || now - budget.at > 60000 ? { at: now, n: 0 } : budget;
      budgets.set(key, entry);
      if (++entry.n > (key.endsWith(':read') ? 120 : 60)) fail(429, 'Too many social actions; try again in a minute');
    }
    let p = profile(uid);
    if (input.op === 'profile') {
      if (input.consent !== true) fail(400, 'Sharing consent is required');
      const handle = text(input.handle, 40).toLowerCase();
      if (!/^[a-z][a-z0-9_]{2,39}$/.test(handle)) fail(400, 'Use 3–40 lowercase letters, digits or underscores for your handle');
      if (p && p.handle !== handle) fail(400, 'A social handle cannot be changed');
      if (p?.deleted) fail(409, 'This social account has been deleted');
      let keys = p?.keys;
      if (!keys) { const pair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5'); keys = { publicKey: await exportJwk(pair.publicKey), privateKey: await exportJwk(pair.privateKey) }; }
      // Key generation awaits; check handle ownership again after it completes.
      if (profiles().some(other => other.uid !== uid && other.handle === handle)) fail(409, 'Handle already exists');
      const current = profile(uid);
      if (current && (current.deleted || current.handle !== handle)) fail(409, 'Social identity changed; reload your profile');
      if (current) keys = current.keys;
      p = store.put('profile', uid, { ...p, uid, handle, keys, displayName: text(input.displayName, 80) || handle, bio: text(input.bio, 500), publicProfile: input.publicProfile === true });
      return { profile: scrub(p) };
    }
    if (input.op === 'status') return { enabled: true, profile: p && !p.deleted ? scrub(p) : null,
      relations: store.all('relation').filter(r => r.uid === uid), notifications: store.all('notice').filter(n => n.uid === uid).sort((a, b) => b.at.localeCompare(a.at)),
      ...(input.admin ? { reports: store.all('report') } : {}) };
    if (!p || p.deleted) fail(404, 'Enable your social profile first');
    const me = actorUrl(p), ctx = context();
    if (input.op === 'sync') return sync(p, input);
    if (input.op === 'feed' || input.op === 'history') {
      let owner = input.actor || me;
      if (typeof owner !== 'string' || owner.length > 1000) fail(400, 'Invalid profile');
      const local = byActor(owner);
      const offset = Number.isInteger(input.offset) && input.offset >= 0 && input.offset <= 100000 ? input.offset : 0;
      let remoteProfile, remoteIds = null, remoteHasNext = false;
      if (input.op === 'history' && !local) {
        const remote = await lookup(p, owner);
        if (remote.id.href !== owner) fail(400, 'Profile identity changed');
        remoteProfile = { actor: owner, displayName: text(String(remote.name || remote.preferredUsername || owner), 100), bio: text(String(remote.summary || ''), 500) };
        const loader = await ctx.getDocumentLoader({ identifier: p.handle });
        const options = { documentLoader: loader, contextLoader: ctx.contextLoader };
        const collection = await remote.getOutbox(options);
        let page = collection?.firstId ? await collection.getFirst(options) : collection;
        remoteIds = [];
        // One remote page per requested page bounds network work and avoids crawling a whole account.
        for (let n = 0; page && n < Math.min(100, Math.floor(offset / PAGE) + 1); n++) {
          if (n === Math.floor(offset / PAGE)) for await (const activity of page.getItems(options)) {
            if (activity instanceof Create && activity.actorId?.href === owner) {
              await receive({ ...ctx, recipient: p.handle, documentLoader: loader, contextLoader: ctx.contextLoader }, activity, true);
              remoteIds.push(activity.objectId?.href);
            }
          }
          if (n === Math.floor(offset / PAGE)) remoteHasNext = !!page.nextId;
          if (n < Math.floor(offset / PAGE)) page = page.nextId ? await page.getNext(options) : null;
        }
      }
      const following = store.all('relation').filter(r => r.uid === uid && r.outgoing === 'accepted' && !r.muted && !r.blocked).map(r => r.actor);
      const items = store.all('item').filter(i => i.kind === 'workout' && canRead(i, me) && (input.op === 'history' ? i.owner === owner : i.owner === me || following.includes(i.owner))).sort((a, b) => b.published.localeCompare(a.published) || a.id.localeCompare(b.id));
      const viewProfile = local && !local.deleted && (local.publicProfile || owner === me || approved(owner, me)) ? scrub(local) : remoteProfile || { actor: owner, displayName: owner };
      if (remoteIds) return { profile: viewProfile, items: remoteIds.map(id => store.get('item', id)).filter(i => i?.kind === 'workout' && canRead(i, me)).map(i => itemView(i, me)), next: remoteHasNext ? offset + PAGE : null };
      return { profile: viewProfile, items: items.slice(offset, offset + PAGE).map(i => itemView(i, me)), next: offset + PAGE < items.length ? offset + PAGE : null };
    }
    if (input.op === 'follow') {
      const target = await lookup(p, input.actor);
      const a = target.id.href;
      if (a === me || blocked(me, a)) fail(400, 'Cannot follow this account');
      const r = relation(uid, a);
      if (r.outgoing === 'accepted' || r.outgoing === 'pending') return { ok: true };
      const request = `${origin}/activities/${randomUUID()}`;
      saveRel({ ...r, name: text(String(target.name || target.preferredUsername || a), 100), outgoing: 'pending', request });
      schedule(p, a, 'Follow', a, { event: request });
      return { ok: true };
    }
    if (['accept', 'reject', 'unfollow', 'remove-friend', 'mute', 'block'].includes(input.op)) {
      const a = text(input.actor, 1000), r = relation(uid, a);
      if (input.op === 'accept' || input.op === 'reject') {
        if (r.incoming !== 'pending' || !r.follow) fail(400, 'No pending follow request');
        saveRel({ ...r, incoming: input.op === 'accept' ? 'accepted' : null });
        schedule(p, a, input.op === 'accept' ? 'Accept' : 'Reject', r.follow);
      }
      if (input.op === 'unfollow' && r.request) {
        saveRel({ ...r, outgoing: null });
        schedule(p, a, 'UndoFollow', r.request);
        for (const item of store.all('item').filter(i => i.owner === a && i.remote)) store.put('item', item.id, { ...item, readers: (item.readers || []).filter(v => v !== me) });
      }
      if (input.op === 'remove-friend' || input.op === 'block') {
        saveRel({ ...r, incoming: null, ...(input.op === 'block' ? { blocked: input.value !== false, outgoing: null } : {}) });
        for (const item of store.all('item').filter(i => i.owner === me && i.visibility !== 'public' && !i.deleted)) retract(p, { ...item, updated: stamp() }, [a]);
      }
      if (input.op === 'mute') saveRel({ ...r, muted: input.value !== false });
      return { ok: true };
    }
    if (input.op === 'visibility') {
      const item = store.get('item', input.id);
      if (!item || item.owner !== me || item.deleted || item.kind !== 'workout') fail(404, 'Workout not found');
      if (!['private', 'friends', 'public'].includes(input.visibility)) fail(400, 'Invalid audience');
      const oldAudience = audience(item);
      const next = { ...item, visibility: input.visibility, updated: newer(item.updated) };
      store.put('item', item.id, next);
      // Retract the old representation before publishing to its new audience.
      if (next.visibility === 'private') retract(p, next, oldAudience);
      else if (item.visibility === 'public' && next.visibility === 'friends') retract(p, next, oldAudience.filter(a => !approved(me, a)));
      if (next.visibility !== 'private') publish(p, next);
      return { ok: true };
    }
    if (input.op === 'like' || input.op === 'comment') {
      const parent = store.get('item', input.id);
      if (!canRead(parent, me) || parent.kind !== 'workout') fail(404, 'Workout not found');
      if (input.op === 'like') {
        const key = hash(me + '\n' + parent.id), old = store.get('like', key);
        if (old) { store.remove('like', key); schedule(p, parent.owner, 'UndoLike', parent.id, { original: old.activity }); }
        else {
          const event = `${origin}/activities/${randomUUID()}`;
          store.put('like', key, { actor: me, object: parent.id, activity: event, visibility: parent.visibility });
          schedule(p, parent.owner, 'Like', parent.id, { event });
        }
      } else {
        const content = text(input.text, 2000).trim();
        if (!content) fail(400, 'Write a comment');
        const item = { id: `${origin}/objects/${randomUUID()}`, owner: me, kind: 'comment', text: content, parent: parent.id,
          rootOwner: parent.owner, visibility: parent.visibility, published: stamp(), updated: stamp(), recipients: [parent.owner] };
        store.put('item', item.id, item);
        publish(p, item, 'Create');
        if (!parent.remote) { const changed = { ...parent, updated: newer(parent.updated) }; store.put('item', parent.id, changed); publish(p, changed); }
      }
      return { ok: true };
    }
    if (input.op === 'report') {
      const target = store.get('item', input.id);
      if (!canRead(target, me)) fail(404, 'Workout not found');
      const reason = text(input.reason, 1000).trim();
      if (!reason) fail(400, 'Give a reason for the report');
      const id = randomUUID();
      store.put('report', id, { id, uid, object: target.id, actor: target.owner, reason, at: stamp() });
      return { ok: true };
    }
    if (input.op === 'export') return { profile: scrub(p), relations: store.all('relation').filter(r => r.uid === uid), items: store.all('item').filter(i => i.owner === me).map(i => itemView(i, me)) };
    if (input.op === 'delete') {
      for (const item of store.all('item').filter(i => i.owner === me && !i.deleted)) {
        const gone = { ...item, updated: stamp(), deleted: stamp(), workout: null, text: '' };
        store.put('item', item.id, gone); retract(p, gone);
      }
      for (const a of followers(p)) schedule(p, a, 'DeleteActor', me);
      store.put('profile', uid, { ...p, displayName: '', bio: '', deleted: stamp() });
      return { ok: true };
    }
    fail(400, 'Unknown social action');
  }

  let pumping = false;
  async function pump() {
    if (pumping || paused) return;
    pumping = true;
    try {
      for (const job of store.jobs()) {
        const j = job.value, p = profile(j.uid), item = store.get('item', j.object);
        try {
          if (!p || (p.deleted && !['Delete', 'DeleteActor'].includes(j.verb))) { store.finish(job.id); continue; }
          if (j.verb === 'Create' && p.sharing === false) { store.finish(job.id); continue; }
          if (['Create', 'Update', 'Like', 'UndoLike'].includes(j.verb) && (!item || item.deleted || !canRead(item, j.recipient))) { store.finish(job.id); continue; }
          if (['Create', 'Update'].includes(j.verb) && !audience(item).includes(j.recipient)) { store.finish(job.id); continue; }
          if (j.verb === 'Delete' && item && !item.deleted && item.visibility !== 'private' && canRead(item, j.recipient) && Date.parse(item.updated) > Date.parse(j.at)) { store.finish(job.id); continue; }
          const ctx = context(), sender = new URL(actorUrl(p));
          let activity;
          const common = { id: new URL(j.event), actor: sender, to: new URL(j.recipient), published: instant(j.at) };
          if (j.verb === 'Follow') {
            if (relation(p.uid, j.recipient).outgoing !== 'pending') { store.finish(job.id); continue; }
            activity = new Follow({ ...common, object: new URL(j.object) });
          } else if (j.verb === 'Accept' || j.verb === 'Reject') activity = new (j.verb === 'Accept' ? Accept : Reject)({ ...common, object: new URL(j.object) });
          else if (j.verb === 'Delete' || j.verb === 'DeleteActor') activity = new Delete({ ...common, object: new URL(j.object) });
          else if (j.verb === 'UndoFollow') activity = new Undo({ ...common, object: new Follow({ id: new URL(j.object), actor: sender, object: new URL(j.recipient) }) });
          else if (j.verb === 'Like') activity = new Like({ ...common, object: new URL(j.object) });
          else if (j.verb === 'UndoLike') activity = new Undo({ ...common, object: new Like({ id: new URL(j.original), actor: sender, object: new URL(j.object) }) });
          else activity = new (j.verb === 'Create' ? Create : Update)({ ...common, object: note(item, j.recipient) });
          const recipient = await lookup(p, j.recipient);
          // Discovery awaits the network: consent, audience, or the object may have changed meanwhile.
          if (['Create', 'Update', 'Like', 'UndoLike'].includes(j.verb)) {
            const latest = store.get('item', j.object), current = profile(p.uid);
            if (!current || current.deleted || (j.verb === 'Create' && current.sharing === false) || !latest || latest.updated !== item.updated || !canRead(latest, j.recipient) || blocked(actorUrl(p), j.recipient) || (['Create', 'Update'].includes(j.verb) && !audience(latest).includes(j.recipient))) { store.finish(job.id); continue; }
          }
          await ctx.sendActivity({ identifier: p.handle }, recipient, activity, { preferSharedInbox: false });
          store.finish(job.id);
        } catch (e) {
          store.retry(job.id, job.attempts + 1);
          console.error('Social delivery failed', j.verb, originOf(j.recipient), e.message);
        }
      }
    } finally { pumping = false; }
  }
  async function handle(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, paused });
      if (url.pathname === '/internal' && request.method === 'POST') {
        if (!equal(request.headers.get('authorization') || '', `Bearer ${token}`)) return json({ error: 'Unauthorized' }, 401);
        return json(await command(await request.json()));
      }
      if (url.pathname.startsWith('/internal')) return json({ error: 'Not found' }, 404);
      // Actor keys and public profile routing stay discoverable; foreign requests never reach the private API.
      return await federation.fetch(request, { contextData: undefined,
        onNotFound: () => json({ error: 'Not found' }, 404), onNotAcceptable: () => json({ error: 'Use an ActivityPub client' }, 406) });
    } catch (e) {
      if (!e.status && !(e instanceof SyntaxError)) console.error('Social request failed', e);
      return json({ error: e.status ? e.message : e instanceof SyntaxError ? 'Invalid JSON' : 'Social request failed' }, e.status || (e instanceof SyntaxError ? 400 : 500));
    }
  }
  return { origin, handle, pump, store, federation, command, canRead, close: () => store.close() };
}
