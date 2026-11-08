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
