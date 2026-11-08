import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { isOn } from '../lib/modules.js'
import { Button } from '../components/ui.jsx'
import { confirmSheet } from '../sheets.jsx'

const post = (action, input = {}) => api('/api/social', { method: 'POST', body: JSON.stringify({ ...input, action }) })
const accountName = actor => { try { const u = new URL(actor); return `${decodeURIComponent(u.pathname.split('/').pop())}@${u.host}` } catch { return actor } }

export function WorkoutCard({ item, me, act, openProfile, busy }) {
  const [comment, setComment] = useState('')
  const [reason, setReason] = useState('')
  const w = item.workout
  return <article className="card social-workout">
    <button className="btn plain" onClick={() => openProfile(item.owner)}>{accountName(item.owner)}</button>
    <h2>{w.name || t('Workout')}</h2>
    <p className="muted">{w.date} · {w.durationMin != null ? `${w.durationMin} min · ` : ''}{w.totals.sets} {t('Sets')} · {w.totals.volume} {w.unit}</p>
    {item.owner === me && <label className="social-field">{t('Who can see this workout?')}
      <select value={item.visibility} disabled={busy} onChange={e => act('visibility', { id: item.id, visibility: e.target.value })}>
        <option value="private">{t('Only me')}</option><option value="friends">{t('Friends')}</option><option value="public">{t('Public')}</option>
      </select>
    </label>}
    <details><summary>{t('Exercises')}</summary>
      {w.exercises.map((e, n) => <div key={`${e.id}-${n}`}><h3>{e.name}</h3>
        <ul>{e.sets.map((s, k) => <li key={k}>{s.weight != null ? `${s.weight} ${w.unit} × ` : ''}{s.reps ?? (s.seconds != null ? `${s.seconds} s` : s.minutes != null ? `${s.minutes} min` : '–')}
          {s.sides && ` L: ${s.sides.left.weight ?? ''} × ${s.sides.left.reps ?? ''}; R: ${s.sides.right.weight ?? ''} × ${s.sides.right.reps ?? ''}`}</li>)}</ul>
      </div>)}
      {!!w.records?.length && <p>{t('Personal records')}: {w.records.map(r => r.name).join(', ')}</p>}
    </details>
    <Button disabled={busy} aria-pressed={item.liked} onClick={() => act('like', { id: item.id })}>{item.liked ? t('Unlike') : t('Like')} ({item.likes})</Button>
    <ul className="social-comments">{item.comments.map(c => <li key={c.id}><button className="btn plain" onClick={() => openProfile(c.owner)}>{accountName(c.owner)}</button><p>{c.text}</p></li>)}</ul>
    <form onSubmit={async e => { e.preventDefault(); if (await act('comment', { id: item.id, text: comment })) setComment('') }}>
      <label className="social-field">{t('Comment')}<input maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} /></label>
      <Button type="submit" disabled={busy || !comment.trim()}>{t('Send')}</Button>
    </form>
    {item.owner !== me && <details><summary>{t('Report')}</summary><form onSubmit={async e => { e.preventDefault(); if (await act('report', { id: item.id, reason })) setReason('') }}>
      <label className="social-field">{t('Reason')}<input maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <Button type="submit" disabled={busy || !reason.trim()}>{t('Report')}</Button>
    </form></details>}
  </article>
}

function ProfileEditor({ profile, busy, act }) {
  const [handle, setHandle] = useState(profile?.handle?.split('@')[1] || '')
  const [displayName, setName] = useState(profile?.displayName || '')
  const [bio, setBio] = useState(profile?.bio || '')
  const [publicProfile, setPublic] = useState(profile?.publicProfile || false)
  const [consent, setConsent] = useState(!!profile)
  const update = useStore(s => s.update)
  return <form className="card" onSubmit={async e => {
    e.preventDefault()
    if (await act('profile', { handle, displayName, bio, publicProfile, consent })) update(s => { s.modules = { ...s.modules, social: true } })
  }}>
    <h2>{profile ? t('Your social profile') : t('Enable your social profile')}</h2>
    <label className="social-field">{t('Handle')}<input autoCapitalize="none" autoComplete="off" required pattern="[a-z][a-z0-9_]{2,39}" maxLength={40} value={handle} disabled={!!profile || busy} onChange={e => setHandle(e.target.value.toLowerCase())} /></label>
    <label className="social-field">{t('Display name')}<input maxLength={80} value={displayName} onChange={e => setName(e.target.value)} /></label>
    <label className="social-field">{t('Bio')}<textarea maxLength={500} value={bio} onChange={e => setBio(e.target.value)} /></label>
    <label className="social-field"><input type="checkbox" checked={publicProfile} onChange={e => setPublic(e.target.checked)} />{t('Make my display name and bio public')}</label>
    <p>{t('Approved friends can read your existing workout history and future workouts. You can keep individual workouts private or make them public.')}</p>
    <p className="muted">{t('Recipients and their server operators can retain shared data, even after you delete it.')}</p>
    {!profile && <label className="social-field"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} />{t('I agree to share my workout logs with approved friends.')}</label>}
    <Button variant="primary" type="submit" disabled={busy || !consent}>{t('Save')}</Button>
  </form>
}

export default function Social() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const on = useStore(s => isOn(s.S, 'social'))
  const [status, setStatus] = useState(null)
  const [view, setView] = useState('feed')
  const [actor, setActor] = useState('')
  const [target, setTarget] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState({ items: [] })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const current = await api('/api/social')
    setStatus(current)
    if (current.profile && on && view !== 'manage') {
      const result = await api(`/api/social?view=${view}&offset=${offset}${actor ? `&actor=${encodeURIComponent(actor)}` : ''}`)
      setPage(result)
    } else setPage({ items: [] })
  }, [on, view, actor, offset])
  useEffect(() => {
    if (!user) return
    let active = true
    const refresh = () => load().catch(e => { if (active) setError(e.message) })
    refresh()
    const timer = on ? setInterval(refresh, 30000) : null
    return () => { active = false; clearInterval(timer) }
  }, [load, user, on])
  const act = async (action, input = {}) => {
    setBusy(true); setError('')
    try { await post(action, input); await load(); return true }
    catch (e) { setError(e.message); return false }
    finally { setBusy(false) }
  }
  const openProfile = value => { setActor(value); setOffset(0); setView('history') }
  const exportData = async () => {
    try {
      const data = await api('/api/social?view=export')
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
      const a = document.createElement('a'); a.href = url; a.download = 'opengym-social.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { setError(e.message) }
  }
  const me = status?.profile?.actor
  return <div className="narrow social">
    <div className="hdr"><h1>{t('Social')}</h1><Button onClick={() => nav('/home')}>{t('Home')}</Button></div>
    {error && <p role="alert">{error}</p>}
    {!user ? <p>{t('Sign in to use Social.')}</p> : status?.enabled === false ? <p>{t('Social is not enabled on this server.')}</p> : !status ? <p role="status">{t('Loading…')}</p> : <>
      {me && <div className="social-actions">
        <Button onClick={() => { setView('feed'); setActor(''); setOffset(0) }}>{t('Feed')}</Button>
        <Button onClick={() => openProfile(me)}>{t('Your workouts')}</Button>
        <Button onClick={() => setView('manage')}>{t('Manage social profile')}</Button>
        <Button disabled={busy} onClick={() => load().catch(e => setError(e.message))}>{t('Refresh')}</Button>
      </div>}
      {!on && <p>{t('Social is switched off. Existing shares remain available; you can manage or remove them here.')}</p>}
      {(!me || view === 'manage' || !on) && <ProfileEditor key={me || 'new'} profile={status.profile} busy={busy} act={act} />}
      {me && (view === 'manage' || !on) && <>
        <div className="card"><p>{status.profile.handle}</p><Button onClick={exportData}>{t('Export social data')}</Button>
          <Button disabled={busy} onClick={() => confirmSheet({ title: t('Delete social profile?'), message: t('Shared workouts will be removed and deletion requests sent to other servers. Your private training log stays.'), confirmText: t('Delete'), onConfirm: () => act('delete') })}>{t('Delete social profile')}</Button>
        </div>
        <section className="card"><h2>{t('Connections')}</h2>
          <form onSubmit={e => { e.preventDefault(); act('follow', { actor: target }) }}>
            <label className="social-field">{t('Account handle or profile URL')}<input value={target} maxLength={1000} onChange={e => setTarget(e.target.value)} /></label>
            <Button type="submit" disabled={busy || !target.trim()}>{t('Follow')}</Button>
            <Button type="button" onClick={() => openProfile(target)} disabled={!target.startsWith('https://')}>{t('View profile')}</Button>
          </form>
          {status.relations.map(r => <div className="social-connection" key={r.actor}>
            <Button onClick={() => openProfile(r.actor)}>{r.name || accountName(r.actor)}</Button>
            <p>{r.incoming === 'accepted' ? t('Friend') : r.incoming === 'pending' ? t('Follow request') : ''} {r.outgoing === 'pending' ? t('Request sent') : ''}</p>
            {r.incoming === 'pending' && <><Button disabled={busy} onClick={() => act('accept', { actor: r.actor })}>{t('Accept')}</Button><Button disabled={busy} onClick={() => act('reject', { actor: r.actor })}>{t('Reject')}</Button></>}
            {r.incoming === 'accepted' && <Button disabled={busy} onClick={() => act('remove-friend', { actor: r.actor })}>{t('Remove friend')}</Button>}
            {r.outgoing && <Button disabled={busy} onClick={() => act('unfollow', { actor: r.actor })}>{t('Unfollow')}</Button>}
            <Button disabled={busy} onClick={() => act('mute', { actor: r.actor, value: !r.muted })}>{r.muted ? t('Unmute') : t('Mute')}</Button>
            <Button disabled={busy} onClick={() => act('block', { actor: r.actor, value: !r.blocked })}>{r.blocked ? t('Unblock') : t('Block')}</Button>
          </div>)}
        </section>
        <section className="card"><h2>{t('Notifications')}</h2><ul>{status.notifications.map(n => <li key={n.id}>{n.kind} · {accountName(n.actor)} · {n.at}</li>)}</ul></section>
        {status.reports && <section className="card"><h2>{t('Reports')}</h2>{status.reports.map(r => <div key={r.id}><p>{r.reason}</p><p>{r.actor}</p><Button disabled={busy} onClick={() => act('block', { actor: r.actor })}>{t('Block')}</Button></div>)}</section>}
      </>}
      {me && on && view !== 'manage' && <>
        {view === 'history' && <div className="card"><h2>{page.profile?.displayName || accountName(actor || me)}</h2><p>{page.profile?.bio}</p></div>}
        {!page.items.length && <p>{t('No shared workouts yet.')}</p>}
        {page.items.map(item => <WorkoutCard key={item.id} item={item} me={me} act={act} openProfile={openProfile} busy={busy} />)}
        {offset > 0 && <Button onClick={() => setOffset(Math.max(0, offset - 30))}>{t('Previous')}</Button>}
        {page.next != null && <Button onClick={() => setOffset(page.next)}>{t('Next')}</Button>}
      </>}
    </>}
  </div>
}
