import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { t, tn } from '../lib/i18n.js'
import { fmtDate, fmtDur, fmtNum } from '../lib/format.js'
import { isOn } from '../lib/modules.js'
import { Button, Segmented } from '../components/ui.jsx'
import Icon from '../components/Icon.jsx'
import EmptyState from '../components/EmptyState.jsx'
import { confirmSheet } from '../sheets.jsx'

const post = (action, input = {}) => api('/api/social', { method: 'POST', body: JSON.stringify({ ...input, action }) })
const accountName = actor => { try { const u = new URL(actor); return `${decodeURIComponent(u.pathname.split('/').pop())}@${u.host}` } catch { return actor } }

export function WorkoutCard({ item, me, act, openProfile, busy }) {
  const [comment, setComment] = useState('')
  const [reason, setReason] = useState('')
  const [showComments, setShowComments] = useState(false)
  const discussionId = useId()
  const w = item.workout
  const handle = accountName(item.owner)
  const name = handle.split('@')[0]
  const audience = item.visibility === 'public' ? t('Public') : item.visibility === 'friends' ? t('Friends') : t('Only me')
  return <article className="card social-workout">
    <header className="social-post-header">
      <button className="social-author" onClick={() => openProfile(item.owner)}>
        <span className="social-avatar" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>
        <span className="social-author-text"><strong>{name}</strong><span>@{handle}</span></span>
      </button>
      <span className="social-audience-badge"><Icon name={item.visibility === 'public' ? 'globe' : item.visibility === 'friends' ? 'person' : 'lock'} />{audience}</span>
    </header>
    <div className="social-post-title"><time dateTime={w.date}>{fmtDate(w.date, true, true)}</time><h2>{w.name || t('Workout')}</h2></div>
    <dl className="social-stats">
      <div><dt><Icon name="clock" />{t('Duration')}</dt><dd>{w.durationMin != null ? fmtDur(w.durationMin * 60000) : '–'}</dd></div>
      <div><dt><Icon name="dumbbell" />{t('Sets')}</dt><dd>{fmtNum(w.totals.sets)}</dd></div>
      <div><dt><Icon name="barbell" />{t('Volume')}</dt><dd>{fmtNum(w.totals.volume)} <small>{w.unit}</small></dd></div>
    </dl>
    {!!w.records?.length && <p className="social-records"><Icon name="trophy" /><span>{t('Personal records')}: {w.records.map(r => r.name).join(', ')}</span></p>}
    <details className="social-exercises"><summary><Icon name="list" /><span>{t('Exercises')}</span><span className="social-count">{fmtNum(w.exercises.length)}</span><Icon name="chevronDown" className="social-chevron" /></summary>
      {w.exercises.map((e, n) => <section className="social-exercise" key={e.id + '-' + n}><h3>{e.name}</h3>
        <ol>{e.sets.map((s, k) => <li key={k}><span className="social-set-number" aria-hidden="true">{k + 1}</span><span>{s.weight != null ? s.weight + ' ' + w.unit + ' × ' : ''}{s.reps ?? (s.seconds != null ? s.seconds + ' s' : s.minutes != null ? s.minutes + ' min' : '–')}
          {s.sides && ' L: ' + (s.sides.left.weight ?? '') + ' × ' + (s.sides.left.reps ?? '') + '; R: ' + (s.sides.right.weight ?? '') + ' × ' + (s.sides.right.reps ?? '')}</span></li>)}</ol>
      </section>)}
    </details>
    <ul className="social-exercise-preview">{w.exercises.slice(0, 3).map((e, n) => <li key={e.id + '-' + n}><span>{e.name}</span><span>{tn('{0} set', '{0} sets', e.sets.length)}</span></li>)}
      {w.exercises.length > 3 && <li className="social-more-exercises">{tn('+{0} more exercise', '+{0} more exercises', w.exercises.length - 3)}</li>}
    </ul>
    <div className="social-engagement">
      <Button size="sm" icon="heart" className="social-like" disabled={busy} aria-pressed={item.liked} onClick={() => act('like', { id: item.id })}>{item.liked ? t('Unlike') : t('Like')} ({item.likes})</Button>
      <Button size="sm" icon="chat" aria-expanded={showComments} aria-controls={discussionId} onClick={() => setShowComments(!showComments)}>{t('Comments')} ({item.comments.length})</Button>
    </div>
    <section className="social-discussion" id={discussionId} hidden={!showComments}>
      <ul className="social-comments">{item.comments.map(c => <li key={c.id}><button className="social-comment-author" onClick={() => openProfile(c.owner)}>{accountName(c.owner)}</button><p>{c.text}</p></li>)}</ul>
      <form className="social-comment-form" onSubmit={async e => { e.preventDefault(); if (await act('comment', { id: item.id, text: comment })) setComment('') }}>
        <label className="social-field">{t('Comment')}<textarea rows={2} maxLength={2000} value={comment} onChange={e => setComment(e.target.value)} /></label>
        <Button size="sm" variant="tinted" icon="arrowUp" type="submit" disabled={busy || !comment.trim()}>{t('Send')}</Button>
      </form>
    </section>
    <div className="social-post-tools">
      {item.owner === me && <details><summary><Icon name="shield" />{t('Who can see this workout?')}</summary>
        <label className="social-field"><span>{t('Who can see this workout?')}</span><select value={item.visibility} disabled={busy} onChange={e => act('visibility', { id: item.id, visibility: e.target.value })}>
          <option value="private">{t('Only me')}</option><option value="friends">{t('Friends')}</option><option value="public">{t('Public')}</option>
        </select></label>
      </details>}
      {item.owner !== me && <details><summary><Icon name="flag" />{t('Report')}</summary><form onSubmit={async e => { e.preventDefault(); if (await act('report', { id: item.id, reason })) setReason('') }}>
        <label className="social-field">{t('Reason')}<input maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></label>
        <Button size="sm" type="submit" disabled={busy || !reason.trim()}>{t('Report')}</Button>
      </form></details>}
    </div>
  </article>
}

function ProfileEditor({ profile, busy, act }) {
  const [handle, setHandle] = useState(profile?.handle?.split('@')[1] || '')
  const [displayName, setName] = useState(profile?.displayName || '')
  const [bio, setBio] = useState(profile?.bio || '')
  const [publicProfile, setPublic] = useState(profile?.publicProfile || false)
  const [consent, setConsent] = useState(!!profile)
  const update = useStore(s => s.update)
  return <form className="card social-profile-editor" onSubmit={async e => {
    e.preventDefault()
    if (await act('profile', { handle, displayName, bio, publicProfile, consent }) && !profile) update(s => { s.modules = { ...s.modules, social: true } })
  }}>
    <div className="social-section-heading"><Icon name={profile ? 'personCircle' : 'shield'} /><h2>{profile ? t('Your social profile') : t('Enable your social profile')}</h2></div>
    <label className="social-field">{t('Handle')}<input autoCapitalize="none" autoComplete="off" required pattern="[a-z][a-z0-9_]{2,39}" maxLength={40} value={handle} disabled={!!profile || busy} onChange={e => setHandle(e.target.value.toLowerCase())} /></label>
    <label className="social-field">{t('Display name')}<input maxLength={80} value={displayName} onChange={e => setName(e.target.value)} /></label>
    <label className="social-field">{t('Bio')}<textarea maxLength={500} value={bio} onChange={e => setBio(e.target.value)} /></label>
    <label className="social-check"><input type="checkbox" checked={publicProfile} onChange={e => setPublic(e.target.checked)} />{t('Make my display name and bio public')}</label>
    <p>{t('Approved friends can read your existing workout history and future workouts. You can keep individual workouts private or make them public.')}</p>
    <p className="muted">{t('Recipients and their server operators can retain shared data, even after you delete it.')}</p>
    {!profile && <label className="social-check"><input type="checkbox" required checked={consent} onChange={e => setConsent(e.target.checked)} />{t('I agree to share my workout logs with approved friends.')}</label>}
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
  const [loading, setLoading] = useState(true)
  const request = useRef(0)
  const pageKey = JSON.stringify([view, actor, offset])
  const changingPage = page.key !== pageKey
  const load = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    try {
      const current = await api('/api/social')
      const result = current.profile && on && view !== 'manage'
        ? await api('/api/social?view=' + view + '&offset=' + offset + (actor ? '&actor=' + encodeURIComponent(actor) : ''))
        : { items: [] }
      if (id !== request.current) return
      setStatus(current); setPage({ ...result, key: pageKey }); setError('')
    } finally { if (id === request.current) setLoading(false) }
  }, [on, view, actor, offset, pageKey])
  useEffect(() => {
    if (!user) return
    let active = true
    const refresh = () => load().catch(e => { if (active) setError(e.message) })
    refresh()
    const timer = on ? setInterval(refresh, 30000) : null
    return () => { active = false; request.current++; clearInterval(timer) }
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
    <div className="hdr social-header"><div><h1 id="social-heading">{t('Social')}</h1><p className="sub">{t('Workouts from people you follow.')}</p></div><Button size="sm" icon="house" onClick={() => nav('/home')}>{t('Home')}</Button></div>
    {error && <p className="card social-error" role="alert"><Icon name="warning" />{error}</p>}
    {!user ? <p>{t('Sign in to use Social.')}</p> : status?.enabled === false ? <p>{t('Social is not enabled on this server.')}</p> : !status ? <p role="status">{t('Loading…')}</p> : <>
      {me && <div className="social-toolbar">
        <Segmented ariaLabelledby="social-heading" className={view === 'manage' || (view === 'history' && actor !== me) ? 'social-no-selection' : ''} options={[{ value: 'feed', label: t('Feed') }, { value: 'history', label: t('Your workouts') }]} value={view === 'manage' || (view === 'history' && actor !== me) ? '' : view} onChange={value => { if (!busy) { setView(value); setActor(value === 'history' ? me : ''); setOffset(0) } }} />
        <Button size="sm" icon="gear" aria-label={t('Manage social profile')} title={t('Manage social profile')} aria-pressed={view === 'manage'} disabled={busy} onClick={() => setView('manage')} />
        <Button size="sm" icon="reset" className="social-refresh" aria-label={t('Refresh')} disabled={busy || loading} onClick={() => load().catch(e => setError(e.message))}>{t('Refresh')}</Button>
      </div>}
      {!on && <p className="card social-notice"><Icon name="pause" />{t('Social is switched off. Existing shares remain available; you can manage or remove them here.')}</p>}
      {status.deleted ? <p>{t('Your social profile was deleted. Your private training log is unchanged.')}</p>
        : (!me || view === 'manage' || !on) && <ProfileEditor key={me || 'new'} profile={status.profile} busy={busy} act={act} />}
      {me && (view === 'manage' || !on) && <>
        <div className="card social-account"><p className="social-handle">{status.profile.handle}</p><div className="social-actions"><Button size="sm" icon="download" onClick={exportData}>{t('Export social data')}</Button>
          <Button size="sm" variant="danger" icon="trash" disabled={busy} onClick={() => confirmSheet({ title: t('Delete social profile?'), message: t('Shared workouts will be removed and deletion requests sent to other servers. You cannot reactivate Social on this training account. Your private training log stays.'), confirmText: t('Delete'), onConfirm: () => act('delete') })}>{t('Delete social profile')}</Button></div>
        </div>
        <section className="card social-connections"><div className="social-section-heading"><Icon name="person" /><h2>{t('Connections')}</h2></div>
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
        <section className="card social-notifications"><div className="social-section-heading"><Icon name="bell" /><h2>{t('Notifications')}</h2></div><ul>{status.notifications.map(n => <li key={n.id}>{n.kind} · {accountName(n.actor)} · {n.at}</li>)}</ul></section>
        {status.reports && <section className="card social-reports"><div className="social-section-heading"><Icon name="flag" /><h2>{t('Reports')}</h2></div>{status.reports.map(r => <div key={r.id}><p>{r.reason}</p><p>{r.actor}</p><Button disabled={busy} onClick={() => act('block', { actor: r.actor })}>{t('Block')}</Button></div>)}</section>}
      </>}
      {me && on && view !== 'manage' && <>
        {view === 'history' && !changingPage && <div className="card social-profile-heading"><span className="social-avatar" aria-hidden="true">{accountName(actor || me).slice(0, 1).toUpperCase()}</span><div><h2>{page.profile?.displayName || accountName(actor || me)}</h2><p className="social-handle">@{accountName(actor || me)}</p>{page.profile?.bio && <p>{page.profile.bio}</p>}</div></div>}
        {loading && changingPage && <p className="social-loading" role="status">{t('Loading…')}</p>}
        {!loading && !changingPage && !page.items.length && <EmptyState icon={view === 'feed' ? 'person' : 'dumbbell'} title={t('No shared workouts yet.')} text={view === 'feed' ? t('Follow people across openGym servers to see their workouts here.') : undefined}>
          {view === 'feed' && <Button size="sm" variant="tinted" icon="plus" onClick={() => setView('manage')}>{t('Connections')}</Button>}
        </EmptyState>}
        <div className="social-feed" aria-busy={loading}>{!changingPage && page.items.map(item => <WorkoutCard key={item.id} item={item} me={me} act={act} openProfile={openProfile} busy={busy} />)}</div>
        {!changingPage && (offset > 0 || page.next != null) && <nav className="social-pagination" aria-label={t('Feed')}>
          {offset > 0 && <Button size="sm" icon="chevronLeft" disabled={busy} onClick={() => setOffset(Math.max(0, offset - 30))}>{t('Previous')}</Button>}
          {page.next != null && <Button size="sm" trailingIcon="chevronRight" disabled={busy} onClick={() => setOffset(page.next)}>{t('Next')}</Button>}
        </nav>}

      </>}
    </>}
  </div>
}
