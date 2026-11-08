// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, test, vi } from 'vitest'
import { WorkoutCard } from './Social.jsx'
vi.mock('../sheets.jsx', () => ({ confirmSheet: vi.fn() }))

let root, host
afterEach(() => { if (root) act(() => root.unmount()); host?.remove() })
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
