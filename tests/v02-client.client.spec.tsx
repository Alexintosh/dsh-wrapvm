// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { VmViewer } from '../src/client/viewer.tsx'
import { Environments } from '../src/client/environments.tsx'
import { en } from '../src/client/locales.ts'
import type { RemoteV02, SessionView, Environment } from '../src/client/v02.ts'

afterEach(cleanup)
const t = makeTranslate(en)
function stream<T>() {
  let pending: ((result: IteratorResult<T>) => void) | undefined
  const values: IteratorResult<T>[] = []
  const iterator: AsyncIterator<T> = {
    next: () => new Promise(resolve => { if (values.length) resolve(values.shift()!); else pending = resolve }),
    return: vi.fn(async () => ({ done: true, value: undefined })),
  }
  return { iterator, iterable: { [Symbol.asyncIterator]: () => iterator, dispose: vi.fn(() => { void iterator.return?.() }) }, push(value: IteratorResult<T>) { if (pending) { const resolve = pending; pending = undefined; resolve(value) } else values.push(value) } }
}
const view = (revision: number): SessionView => ({ epoch: 'host', revision, bindingComplete: true, policy: { sessionKey: 's', mode: 'protected', generation: 1, stage: 'ready', environmentId: 'a', reason: null }, binding: { sessionKey: 's', environmentId: 'a', generation: 1, history: [] } })
it('discards a late viewer URL after binding revision changes and closes on stream end', async () => {
  const updates = stream<SessionView>()
  const pending = Promise.withResolvers<{ url: string; epoch: string; revision: number; expiresAt: number | null } | null>()
  const remote = { v02WatchSession: vi.fn(() => updates.iterable), v02ViewerUrl: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ url: 'http://localhost/?token=secret', epoch: 'host', revision: 2, expiresAt: null }) }
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { updates.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.viewer }))
  await act(async () => { updates.push({ done: false, value: view(2) }); pending.resolve({ url: 'http://localhost/?token=old', epoch: 'host', revision: 1, expiresAt: null }) })
  expect(screen.queryByTitle(en.desktopTitle)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: en.viewer }))
  expect(await screen.findByTitle(en.desktopTitle)).toBeTruthy()
  expect(screen.queryByRole('link')).toBeNull()
  await act(async () => { updates.push({ done: true, value: undefined }) })
  expect(screen.queryByTitle(en.desktopTitle)).toBeNull()
  expect(screen.getByRole('alert').textContent).toBe(en.sessionUnavailable)
})
it('discards the frame when the session changes and cancels its stream', async () => {
  const first = stream<SessionView>(), second = stream<SessionView>()
  const remote = { v02WatchSession: vi.fn((session: string) => session === 's' ? first.iterable : second.iterable), v02ViewerUrl: vi.fn().mockResolvedValue({ url: 'http://localhost/?token=secret', epoch: 'host', revision: 1, expiresAt: null }) }
  const rendered = render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { first.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.viewer }))
  await screen.findByTitle(en.desktopTitle)
  rendered.rerender(<VmViewer sessionKey="other" remote={remote} t={t} />)
  expect(screen.queryByTitle(en.desktopTitle)).toBeNull()
  expect(first.iterator.return).toHaveBeenCalledOnce()
})
it('re-previews a changed volume choice and confirms its matching token', async () => {
  const item: Environment = { id: 'a', displayName: 'One', backend: 'docker', ownership: 'plugin', image: 'image', digest: 'sha', createdAt: 1, mounts: [], limits: { cpuMillis: 1000, memoryBytes: 100, diskBytes: null }, internetAccess: false, desiredPhase: 'stopped', observed: { phase: 'stopped', observedAt: 1, shell: { kind: 'unavailable', reason: null }, browser: { kind: 'unavailable', reason: null }, desktop: { kind: 'unavailable', reason: null }, hostControlPlane: { kind: 'unknown', reason: 'not verified' } }, resources: null, bindings: [], bindingsComplete: true, operations: [], uncertainty: null }
  const updates = stream<never>()
  const preview = vi.fn(async (_id: string, deleteVolumes: boolean) => ({ environmentId: 'a', displayName: 'One', containerId: 'container', volumeName: 'volume', networkName: 'network', hostMounts: [], deleteVolumes, confirmToken: deleteVolumes ? 'delete' : 'keep', expiresAt: Date.now() + 60000 }))
  const confirm = vi.fn(async () => ({ state: 'completed' }))
  const remote = { v02Snapshot: vi.fn(async () => ({ environments: [item], policy: null, binding: null, bindingComplete: true })), v02WatchResources: vi.fn(() => updates.iterable), v02PreviewRemoval: preview, v02ConfirmRemoval: confirm } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  expect(await screen.findByText('One')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.remove }))
  fireEvent.click(await screen.findByRole('checkbox', { name: en.deleteVolumes }))
  await waitFor(() => { expect(preview).toHaveBeenLastCalledWith('a', true) })
  fireEvent.click(await screen.findByRole('button', { name: en.confirmRemove }))
  await waitFor(() => { expect(confirm).toHaveBeenCalledWith('a', 'delete', true, expect.any(String)) })
})

it('unwraps unary RemoteResult errors and preserves stream cancellation', async () => {
  const { adaptReadV02, hasReadWire } = await import('../src/client/remote-adapter.ts')
  const { RemoteError } = await import('@deepseek-ai/dsh-typert-protocol')
  const updates = stream<SessionView>()
  const handle = { ...updates.iterable, send: vi.fn(), end: vi.fn() }
  const wire = {
    v02Snapshot: vi.fn().mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'Unavailable', {}) }),
    v02WatchSession: vi.fn(() => handle),
    v02WatchResources: vi.fn(() => ({ ...stream<never>().iterable, send: vi.fn(), end: vi.fn() })),
    v02ViewerUrl: vi.fn().mockResolvedValue({ ok: true, value: null }),
  }
  expect(hasReadWire(wire)).toBe(true)
  const remote = adaptReadV02(wire)
  await expect(remote.v02Snapshot(null)).rejects.toThrow('Unavailable')
  await expect(remote.v02ViewerUrl('s', 'host', 1)).resolves.toBeNull()
  expect(wire.v02ViewerUrl).toHaveBeenCalledWith('s', 'host', 1)
  remote.v02WatchSession('s').dispose()
  expect(updates.iterable.dispose).toHaveBeenCalledOnce()
})

it('discards a pending response across reconnect even when the new baseline matches', async () => {
  const first = stream<SessionView>(), second = stream<SessionView>()
  const pending = Promise.withResolvers<{ url: string; epoch: string; revision: number; expiresAt: null } | null>()
  const oldRemote = { v02WatchSession: () => first.iterable, v02ViewerUrl: () => pending.promise }
  const newRemote = { v02WatchSession: () => second.iterable, v02ViewerUrl: vi.fn() }
  const rendered = render(<VmViewer sessionKey="s" remote={oldRemote} t={t} />)
  await act(async () => { first.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.viewer }))
  rendered.rerender(<VmViewer sessionKey="s" remote={newRemote} t={t} />)
  await act(async () => { second.push({ done: false, value: view(1) }); pending.resolve({ url: 'http://localhost/?token=old', epoch: 'host', revision: 1, expiresAt: null }) })
  expect(screen.queryByTitle(en.desktopTitle)).toBeNull()
  expect(first.iterable.dispose).toHaveBeenCalledOnce()
})

it('shows an error if the session stream cannot open', async () => {
  const remote = { v02WatchSession: () => { throw new Error('disconnected') }, v02ViewerUrl: vi.fn() }
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toBe(en.sessionUnavailable)
  expect(remote.v02ViewerUrl).not.toHaveBeenCalled()
})

it('shows unknown inventory state and disposes the shared resource stream', async () => {
  const { ReadInventory } = await import('../src/client/read-inventory.tsx')
  const updates = stream<import('../src/client/v02.ts').ResourceUpdate>()
  const item: Environment = { id: 'a', displayName: 'One', backend: 'docker', ownership: 'plugin', image: 'image', digest: 'sha', createdAt: 1, mounts: [], limits: { cpuMillis: 1000, memoryBytes: 100, diskBytes: null }, internetAccess: false, desiredPhase: null, observed: null, resources: null, bindings: [], bindingsComplete: false, operations: [], uncertainty: 'reconcile required' }
  const remote = { v02Snapshot: vi.fn().mockResolvedValue({ environments: [item], bindingComplete: false, policy: null, binding: null }), v02WatchResources: vi.fn(() => updates.iterable), v02WatchSession: vi.fn(), v02ViewerUrl: vi.fn() }
  const rendered = render(<ReadInventory remote={remote} t={t} />)
  expect(await screen.findByText(/CPU —%/)).toBeTruthy()
  expect(screen.getByText(`${en.users}: ${en.usersUnknown}`)).toBeTruthy()
  expect(screen.getByText(`${en.managedCount}: 1 · ${en.activeCount}: —`)).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('reconcile required')
  await waitFor(() => { expect(remote.v02WatchResources).toHaveBeenCalledWith(['a']) })
  rendered.unmount()
  expect(updates.iterable.dispose).toHaveBeenCalledOnce()
})


it('selects a conversation environment and opens its desktop', async () => {
  const { SessionDesktop } = await import('../src/client/session.tsx')
  const updates: ReturnType<typeof stream<SessionView>>[] = []
  const environment = { id: 'a', displayName: 'One', observed: { phase: 'running' } } as Environment
  const snapshot = { environments: [environment], binding: null, policy: null, bindingComplete: false }
  const bind = vi.fn().mockResolvedValue({ state: 'completed' })
  const remote = { v02Snapshot: vi.fn().mockResolvedValue(snapshot), v02Bind: bind, v02WatchSession: () => { const sub = stream<SessionView>(); updates.push(sub); return sub.iterable }, v02ViewerUrl: vi.fn().mockResolvedValue({ url: 'http://localhost/?token=fixture', epoch: 'host', revision: 1, expiresAt: null }) }
  render(<SessionDesktop sessionKey="s" remote={remote} t={t} />)
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'a' } })
  fireEvent.click(screen.getByRole('button', { name: en.bind }))
  await waitFor(() => { expect(bind).toHaveBeenCalledWith('s', 'a', expect.any(String)) })
  await act(async () => { updates.forEach(sub => sub.push({ done: false, value: { ...view(1), bindingComplete: false } })) })
  expect(screen.getByText(en.environmentSelected)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.viewer }))
  expect(await screen.findByTitle(en.desktopTitle)).toBeTruthy()
})

it('refreshes the environment after a lifecycle action even when binding completeness is unknown', async () => {
  const updates = stream<never>()
  const item = { id: 'a', displayName: 'One', backend: 'docker', ownership: 'plugin', image: 'image', digest: 'sha', createdAt: 1, mounts: [], limits: { cpuMillis: 1000, memoryBytes: 100, diskBytes: null }, internetAccess: false, desiredPhase: 'stopped', observed: { phase: 'stopped', observedAt: 1, shell: { kind: 'unavailable', reason: null }, browser: { kind: 'unavailable', reason: null }, desktop: { kind: 'unavailable', reason: null }, hostControlPlane: { kind: 'unknown', reason: null } }, resources: null, bindings: [], bindingsComplete: false, operations: [], uncertainty: null } as Environment
  const snapshot = vi.fn().mockResolvedValue({ environments: [item], policy: null, binding: null, bindingComplete: false })
  const start = vi.fn().mockResolvedValue({ state: 'completed' })
  const remote = { v02Snapshot: snapshot, v02WatchResources: () => updates.iterable, v02Start: start } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: en.start }))
  await waitFor(() => { expect(snapshot).toHaveBeenCalledTimes(2) })
  expect(start).toHaveBeenCalledWith('a', expect.any(String))
})


it('keeps the removal dialog open and shows a failed operation', async () => {
  const item = { id: 'a', displayName: 'One', backend: 'docker', ownership: 'plugin', image: 'image', digest: 'sha', createdAt: 1, mounts: [], limits: { cpuMillis: 1000, memoryBytes: 100, diskBytes: null }, internetAccess: false, desiredPhase: 'stopped', observed: { phase: 'stopped' }, resources: null, bindings: [], operations: [], uncertainty: null } as Environment
  const preview = { environmentId: 'a', displayName: 'One', containerId: 'container', volumeName: 'volume', networkName: 'network', hostMounts: [], deleteVolumes: false, confirmToken: 'keep', expiresAt: Date.now() + 60000 }
  const remote = { v02Snapshot: vi.fn().mockResolvedValue({ environments: [item], policy: null, binding: null, bindingComplete: true }), v02PreviewRemoval: vi.fn().mockResolvedValue(preview), v02ConfirmRemoval: vi.fn().mockResolvedValue({ state: 'failed', error: 'selected elsewhere' }) } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: en.remove }))
  fireEvent.click(await screen.findByRole('button', { name: en.confirmRemove }))
  expect((await screen.findByRole('alert')).textContent).toBe('selected elsewhere')
  expect(screen.getByRole('button', { name: en.confirmRemove })).toBeTruthy()
})


it('requires explicit internet access before creating an environment', async () => {
  const create = vi.fn().mockResolvedValue({ state: 'completed' })
  const remote = { v02Snapshot: vi.fn().mockResolvedValue({ environments: [], policy: null, binding: null, bindingComplete: true }), v02Create: create } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.newEnvironment }))
  fireEvent.change(await screen.findByLabelText(en.environmentName), { target: { value: 'Test' } })
  fireEvent.change(screen.getByLabelText(en.image), { target: { value: 'image' } })
  const button = screen.getByRole('button', { name: en.createEnvironment }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(screen.getByText(en.networkDescription)).toBeTruthy()
  fireEvent.click(screen.getByLabelText(en.internet))
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await waitFor(() => { expect(create).toHaveBeenCalledWith(expect.objectContaining({ internetAccess: true }), expect.any(String)) })
})


it('edits limits from the selected environment without borrowing the creation draft', async () => {
  const item = { id: 'a', displayName: 'Existing desktop', image: 'image', limits: { cpuMillis: 2500, memoryBytes: 4 * 1024 ** 3, diskBytes: null }, observed: { phase: 'running' }, resources: null, bindings: [], mounts: [], operations: [], uncertainty: null } as Environment
  const update = vi.fn().mockResolvedValue({ state: 'completed' })
  const remote = { v02Snapshot: vi.fn().mockResolvedValue({ environments: [item] }), v02UpdateLimits: update } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  fireEvent.click(await screen.findByRole('button', { name: en.limits }))
  expect((screen.getByLabelText(en.cpuCores) as HTMLInputElement).value).toBe('2.5')
  expect((screen.getByLabelText(en.memoryGiB) as HTMLInputElement).value).toBe('4')
  fireEvent.change(screen.getByLabelText(en.memoryGiB), { target: { value: '6' } })
  fireEvent.click(screen.getByRole('button', { name: en.save }))
  await waitFor(() => { expect(update).toHaveBeenCalledWith('a', { cpuMillis: 2500, memoryBytes: 6 * 1024 ** 3, diskBytes: null }, expect.any(String)) })
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
})

it('keeps creation input and failure visible until a successful retry', async () => {
  const create = vi.fn().mockResolvedValueOnce({ state: 'failed', error: 'Image not available' }).mockResolvedValueOnce({ state: 'completed' })
  const remote = { v02Snapshot: vi.fn().mockResolvedValue({ environments: [] }), v02Create: create } as RemoteV02
  render(<Environments remote={remote} t={t} />)
  fireEvent.click(screen.getByRole('button', { name: en.newEnvironment }))
  fireEvent.change(screen.getByLabelText(en.environmentName), { target: { value: 'Desktop' } })
  fireEvent.change(screen.getByLabelText(en.image), { target: { value: 'image' } })
  fireEvent.click(screen.getByLabelText(en.internet))
  fireEvent.click(screen.getByRole('button', { name: en.createEnvironment }))
  expect((await screen.findByRole('alert')).textContent).toBe('Image not available')
  expect((screen.getByLabelText(en.environmentName) as HTMLInputElement).value).toBe('Desktop')
  fireEvent.click(screen.getByRole('button', { name: en.createEnvironment }))
  await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ limits: { cpuMillis: 1000, memoryBytes: 1024 ** 3, diskBytes: null } }), expect.any(String))
})

it('updates an already-open session selector and project path after agent preparation, without opening the viewer', async () => {
  const { SessionDesktop } = await import('../src/client/session.tsx')
  const subscriptions: ReturnType<typeof stream<SessionView>>[] = []
  let selected = false
  const item = { id: 'agent-env', displayName: 'Agent project', observed: { phase: 'running' } } as Environment
  const binding = { sessionKey: 's', environmentId: 'agent-env', generation: 1, history: [] }
  const snapshot = vi.fn(async () => ({ environments: selected ? [item] : [], binding: selected ? binding : null, policy: null, bindingComplete: true,
    workspace: selected ? { phase: 'ready' as const, mode: 'copy' as const, guestPath: '/home/user/workspace/projects/prepared', sourceRoot: '/project' } : null }))
  const remote: RemoteV02 = { v02Snapshot: snapshot, v02WatchSession: () => { const sub = stream<SessionView>(); subscriptions.push(sub); return sub.iterable }, v02ViewerUrl: vi.fn() }
  const rendered = render(<SessionDesktop sessionKey="s" remote={remote} t={t} />)
  await screen.findByText(en.noEnvironments)
  selected = true
  await act(async () => { for (const sub of subscriptions) sub.push({ done: false, value: { ...view(2), binding } }) })
  expect((await screen.findByRole('combobox') as HTMLSelectElement).value).toBe('agent-env')
  expect(screen.getByText('/home/user/workspace/projects/prepared')).toBeTruthy()
  expect(remote.v02ViewerUrl).not.toHaveBeenCalled()
  rendered.unmount()
  for (const sub of subscriptions) expect(sub.iterable.dispose).toHaveBeenCalledOnce()
})

afterEach(() => { vi.restoreAllMocks() })
it('opens an authenticated external browser on demand, keeps a fallback link and clears it on selection change', async () => {
  const updates = stream<SessionView>()
  // Electron returns null even when it successfully hands the URL to the host browser.
  const launch = vi.spyOn(window, 'open').mockReturnValue(null)
  const url = 'http://127.0.0.1:55000/?token=external-test'
  const remote = { v02WatchSession: () => updates.iterable, v02ViewerUrl: vi.fn().mockResolvedValue({ url, epoch: 'host', revision: 1, expiresAt: null }) }
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { updates.push({ done: false, value: view(1) }) })
  expect(launch).not.toHaveBeenCalled()
  expect(remote.v02ViewerUrl).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: en.openHostBrowser }))
  await waitFor(() => { expect(launch).toHaveBeenCalledExactlyOnceWith(url, '_blank', 'noopener,noreferrer') })
  expect(remote.v02ViewerUrl).toHaveBeenCalledWith('s', 'host', 1)
  expect(screen.queryByTitle(en.desktopTitle)).toBeNull()
  const link = screen.getByRole('link', { name: en.authenticatedLink })
  expect(link.getAttribute('href')).toBe(url)
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  expect(link.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(link.textContent).not.toContain('external-test')
  await act(async () => { updates.push({ done: false, value: view(2) }) })
  expect(screen.queryByRole('link')).toBeNull()
})
it('never launches an external viewer from a late response after selection changes', async () => {
  const updates = stream<SessionView>(), pending = Promise.withResolvers<unknown>()
  const launch = vi.spyOn(window, 'open').mockReturnValue(null)
  const remote = { v02WatchSession: () => updates.iterable, v02ViewerUrl: vi.fn(() => pending.promise) } as unknown as RemoteV02
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { updates.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.openHostBrowser }))
  await act(async () => { updates.push({ done: false, value: view(2) }); pending.resolve({ url: 'http://localhost/?token=stale', epoch: 'host', revision: 1, expiresAt: null }) })
  expect(launch).not.toHaveBeenCalled()
  expect(screen.queryByRole('link')).toBeNull()
})
it.each(['http://127.0.0.1:55000/', 'http://example.com/?token=secret', 'javascript:alert(1)'])('rejects an unauthenticated or nonlocal external viewer URL: %s', async url => {
  const updates = stream<SessionView>()
  const launch = vi.spyOn(window, 'open').mockReturnValue(null)
  const remote = { v02WatchSession: () => updates.iterable, v02ViewerUrl: vi.fn().mockResolvedValue({ url, epoch: 'host', revision: 1, expiresAt: null }) }
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { updates.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.openHostBrowser }))
  await screen.findByRole('alert')
  expect(launch).not.toHaveBeenCalled()
  expect(screen.queryByRole('link')).toBeNull()
})
it('removes an external link when session access ends', async () => {
  const updates = stream<SessionView>()
  vi.spyOn(window, 'open').mockReturnValue(null)
  const remote = { v02WatchSession: () => updates.iterable, v02ViewerUrl: vi.fn().mockResolvedValue({ url: 'http://localhost/?token=test', epoch: 'host', revision: 1, expiresAt: null }) }
  render(<VmViewer sessionKey="s" remote={remote} t={t} />)
  await act(async () => { updates.push({ done: false, value: view(1) }) })
  fireEvent.click(screen.getByRole('button', { name: en.openHostBrowser }))
  await screen.findByRole('link')
  await act(async () => { updates.push({ done: true, value: undefined }) })
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button', { name: en.openHostBrowser })).toBeNull()
})
