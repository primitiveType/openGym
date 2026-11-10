// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import Social, { WorkoutCard } from './Social.jsx'
import * as apiModule from '../lib/api.js'
import { useStore } from '../store/useStore.js'
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

let root, host, savedStore
afterEach(() => { if (root) act(() => root.unmount()); host?.remove(); vi.restoreAllMocks(); if (savedStore) { useStore.setState(savedStore, true); savedStore = null } })
test('remote content renders as text and audience controls belong only to the owner', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const item = { id: 'https://a.example/objects/1', owner: 'https://a.example/users/alice', visibility: 'friends', likes: 1, liked: false,
    workout: { name: '<img src=x onerror=alert(1)>', date: '2026-11-08', unit: 'kg', totals: { sets: 1, volume: 500 }, exercises: [], records: [] },
    comments: [{ id: 'c1', owner: 'https://b.example/users/bob', text: '<script>bad()</script>' }] };
  const actOn = vi.fn(async () => true);
  await act(async () => root.render(<WorkoutCard item={item} me="https://b.example/users/bob" act={actOn} openProfile={vi.fn()} />))
  expect(host.querySelector('script,img,select')).toBeNull()
  expect(host.textContent).toContain('<script>bad()</script>')
  await act(async () => host.querySelector('[aria-pressed]').click())
  expect(actOn).toHaveBeenCalledWith('like', { id: item.id })
  await act(async () => root.render(<WorkoutCard item={item} me={item.owner} act={actOn} openProfile={vi.fn()} />))
  expect(host.querySelector('select').value).toBe('friends')
});

test('editing an existing profile keeps Social off, and a deleted account cannot offer new profile creation', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  savedStore = useStore.getState()
  const update = vi.fn()
  useStore.setState({ user: { id: 'alice' }, S: { ...savedStore.S, modules: { social: false } }, update })
  const status = { enabled: true, profile: { actor: 'https://a.example/users/alice', handle: '@alice@a.example', displayName: 'Alice' }, relations: [], notifications: [] }
  const request = vi.spyOn(apiModule, 'api').mockResolvedValue(status)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><Social /></MemoryRouter>))
  await act(async () => host.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(request).toHaveBeenCalledWith('/api/social', expect.objectContaining({ method: 'POST' }))
  expect(update).not.toHaveBeenCalled()
  request.mockResolvedValue({ enabled: true, deleted: true, profile: null, relations: [], notifications: [] })
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Refresh').click())
  expect(host.textContent).toContain('Your social profile was deleted.')
  expect(host.querySelector('form')).toBeNull()
});

test('comments collapse without losing a draft, and only a successful send clears it', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  const item = { id: 'post1', owner: 'https://a.example/users/alice', visibility: 'public', likes: 0, liked: false, comments: [],
    workout: { name: 'Upper body', date: '2026-11-08', unit: 'kg', durationMin: 45, totals: { sets: 4, volume: 1200 },
      exercises: ['Bench press', 'Row', 'Pull-up', 'Curl'].map((name, id) => ({ id, name, sets: [{ weight: 50, reps: 6 }] })) } }
  const actOn = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
  await act(async () => root.render(<WorkoutCard item={item} act={actOn} openProfile={vi.fn()} />))
  expect(host.querySelector('.social-audience-badge').textContent).toBe('Public')
  expect(host.querySelectorAll('.social-exercise-preview li')).toHaveLength(4)
  const toggle = host.querySelector('[aria-expanded]'), discussion = document.getElementById(toggle.getAttribute('aria-controls'))
  expect(discussion.hidden).toBe(true)
  await act(async () => toggle.click())
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const textarea = host.querySelector('textarea')
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Nice workout!'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => toggle.click())
  expect(discussion.hidden).toBe(true)
  await act(async () => toggle.click())
  expect(textarea.value).toBe('Nice workout!')
  expect(actOn).not.toHaveBeenCalled()
  await act(async () => host.querySelector('.social-comment-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(actOn).toHaveBeenLastCalledWith('comment', { id: 'post1', text: 'Nice workout!' })
  expect(textarea.value).toBe('Nice workout!')
  await act(async () => host.querySelector('.social-comment-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  expect(textarea.value).toBe('')
})

test('refresh keeps open discussions mounted, and an empty feed links to connections', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  savedStore = useStore.getState()
  useStore.setState({ user: { id: 'alice' }, S: { ...savedStore.S, modules: { social: true } } })
  const status = { enabled: true, profile: { actor: 'https://a.example/users/alice', handle: '@alice@a.example' }, relations: [], notifications: [] }
  const item = { id: 'post1', owner: status.profile.actor, visibility: 'friends', likes: 0, liked: false, comments: [],
    workout: { name: 'Upper body', date: '2026-11-08', unit: 'kg', totals: { sets: 1, volume: 500 }, exercises: [] } }
  const request = vi.spyOn(apiModule, 'api').mockImplementation(async path => path === '/api/social' ? status : { items: [item] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><Social /></MemoryRouter>))
  await act(async () => host.querySelector('[aria-expanded]').click())
  const textarea = host.querySelector('textarea')
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(textarea, 'Keep my draft'); textarea.dispatchEvent(new Event('input', { bubbles: true })) })
  let finish
  request.mockImplementation(path => path === '/api/social' ? Promise.resolve(status) : new Promise(resolve => { finish = resolve }))
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Refresh').click())
  expect(host.querySelector('textarea')).toBe(textarea)
  expect(textarea.value).toBe('Keep my draft')
  await act(async () => finish({ items: [{ ...item, likes: 2 }] }))
  expect(host.querySelector('textarea')).toBe(textarea)
  expect(host.querySelector('[aria-expanded]').getAttribute('aria-expanded')).toBe('true')
  request.mockImplementation(async path => path === '/api/social' ? status : { items: [] })
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Refresh').click())
  expect(host.textContent).toContain('Follow people across openGym servers')
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Connections').click())
  expect(host.querySelector('[aria-label="Manage social profile"]').getAttribute('aria-pressed')).toBe('true')
  expect([...host.querySelectorAll('.seg button')].every(b => b.getAttribute('aria-pressed') === 'false')).toBe(true)
  expect(host.textContent).toContain('Account handle or profile URL')
})

test('a slow feed response cannot replace a newly selected workout history', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  savedStore = useStore.getState()
  useStore.setState({ user: { id: 'alice' }, S: { ...savedStore.S, modules: { social: true } } })
  const status = { enabled: true, profile: { actor: 'https://a.example/users/alice', handle: '@alice@a.example' }, relations: [], notifications: [] }
  let finish
  const request = vi.spyOn(apiModule, 'api').mockImplementation(async path => path === '/api/social' ? status : { items: [] })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(<MemoryRouter><Social /></MemoryRouter>))
  request.mockImplementation(path => path === '/api/social' ? Promise.resolve(status) : path.includes('view=feed') ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ items: [], profile: { displayName: 'Alice history' } }))
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Refresh').click())
  await act(async () => [...host.querySelectorAll('.seg button')].find(b => b.textContent === 'Your workouts').click())
  expect(host.textContent).toContain('Alice history')
  await act(async () => finish({ items: [], profile: { displayName: 'Stale feed' } }))
  expect(host.textContent).toContain('Alice history')
  expect(host.textContent).not.toContain('Stale feed')
})
