/**
 * Inventory tests: fail-closed validation at the durable boundary, serialized
 * transactions, the operation log for crash recovery, ownership labels, and
 * the storage-domain table adapter.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { defineDomain, DomainFacility } from '../../../storage/storage-domain/src/index.ts'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import {
  containerNameFor,
  DomainInventoryStore,
  environmentLabels,
  Inventory,
  MemoryInventoryStore,
  OWNERSHIP_LABEL,
  ENVIRONMENT_ID_LABEL,
  wrapvmInventoryDomainSpec,
  type KvTableLike,
} from '../src/inventory.ts'
import { descriptorFor, env1, env2 } from './fixtures/env-fixtures.ts'

describe('domain declaration', () => {
  it('declares a storage-domain-compatible spec with zod record schemas', () => {
    expect(wrapvmInventoryDomainSpec.name).toBe('wrapvm_environments')
    expect(wrapvmInventoryDomainSpec.version).toBe(1)
    expect(Object.keys(wrapvmInventoryDomainSpec.tables)).toEqual(['snapshots'])
    expect(wrapvmInventoryDomainSpec.tables.snapshots.valueSchema.safeParse({ environments: { [env1]: descriptorFor(env1) }, operations: {} }).success).toBe(true)
  })

  it('labels owned resources with the plugin marker and durable id', () => {
    expect(environmentLabels(env1)).toEqual({ [OWNERSHIP_LABEL]: '1', [ENVIRONMENT_ID_LABEL]: 'env-1' })
    expect(containerNameFor(env1)).toBe('dsh-wrapvm-env-1')
  })
})

describe('inventory validation', () => {
  it('fails closed on a corrupt stored descriptor', async () => {
    const store = new MemoryInventoryStore()
    await store.save({ environments: { 'env-1': { id: 'env-1', backend: 'docker' } as never }, operations: {} })
    const inventory = new Inventory(store)
    await expect(inventory.initialize()).rejects.toThrow(/invalid/)
  })

  it('rejects invalid records at the write boundary', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    await inventory.initialize()
    await expect(inventory.putDescriptor(descriptorFor(env1, { containerId: '' } as never)).catch((error: Error) => error.message)).resolves.toMatch(/invalid/)
    await expect(inventory.putOperation({ id: 'op', environmentId: env1, kind: 'start', state: 'teleported' } as never).catch((error: Error) => error.message)).resolves.toMatch(/invalid/)
  })

  it('refuses to be used before initialize', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    expect(() => inventory.list()).toThrow(/initialize/)
  })
})

describe('inventory mutations', () => {
  it('serializes concurrent transactions into consistent snapshots', async () => {
    const store = new MemoryInventoryStore()
    const inventory = new Inventory(store)
    await inventory.initialize()
    await Promise.all([
      inventory.putDescriptor(descriptorFor(env1)),
      inventory.putDescriptor(descriptorFor(env2, { containerId: 'container-2' })),
    ])
    expect(inventory.list().map(record => record.id)).toEqual([env1, env2])
    const last = store.saves.at(-1)!
    expect(Object.keys(last.environments)).toHaveLength(2)
  })

  it('orders the list by creation time', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env2, { createdAt: 50 }))
    await inventory.putDescriptor(descriptorFor(env1, { createdAt: 60 }))
    expect(inventory.list().map(record => record.id)).toEqual([env2, env1])
  })

  it('finds records by immutable container id, never by name', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env1, { containerId: 'abc123' }))
    expect(inventory.getByContainerId('abc123')?.id).toBe(env1)
    expect(inventory.getByContainerId('dsh-wrapvm-env-1')).toBeUndefined()
  })

  it('tracks pending and idempotency-keyed operations', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    await inventory.initialize()
    await inventory.putOperation({ id: 'op-1', environmentId: env1, kind: 'create', state: 'running', requestedAt: 1, idempotencyKey: 'key-1' })
    await inventory.putOperation({ id: 'op-2', environmentId: env1, kind: 'start', state: 'completed', requestedAt: 2, settledAt: 3 })
    expect(inventory.pendingOperations().map(op => op.id)).toEqual(['op-1'])
    expect(inventory.findByIdempotencyKey('key-1')?.id).toBe('op-1')
    expect(inventory.operationsFor(env1).map(op => op.id)).toEqual(['op-1', 'op-2'])
    await inventory.pruneOperations(env1)
    expect(inventory.list()).toEqual([])
    expect(inventory.pendingOperations()).toEqual([])
  })

  it('deletes descriptors on removal', async () => {
    const inventory = new Inventory(new MemoryInventoryStore())
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env1))
    await inventory.deleteDescriptor(env1)
    expect(inventory.get(env1)).toBeUndefined()
  })
})

/** In-memory KvTable stand-in matching the storage-domain face used. */
class MemoryKvTable<V> implements KvTableLike<V> {
  private readonly records = new Map<string, V>()
  get(key: string): V | undefined {
    return this.records.get(key)
  }
  entries(): IterableIterator<[string, V]> {
    return [...this.records.entries()]
  }
  async put(key: string, value: V): Promise<void> {
    this.records.set(key, value)
  }
  async delete(key: string): Promise<boolean> {
    return this.records.delete(key)
  }
}

describe('storage-domain table adapter', () => {
  it('round-trips the snapshot through table handles', async () => {
    const snapshots = new MemoryKvTable<unknown>()
    const store = new DomainInventoryStore(snapshots)
    const inventory = new Inventory(store)
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env1))
    await inventory.putOperation({ id: 'op-1', environmentId: env1, kind: 'start', state: 'completed', requestedAt: 1, settledAt: 2 })

    const reopened = new Inventory(new DomainInventoryStore(snapshots))
    await reopened.initialize()
    expect(reopened.get(env1)?.containerId).toBe('container-1')
    expect(reopened.operation('op-1')?.state).toBe('completed')
  })

  it('fails closed when a stored record no longer validates', async () => {
    const snapshots = new MemoryKvTable<unknown>()
    await snapshots.put('current', { environments: { 'env-1': { id: 'env-1' } }, operations: {} })
    const inventory = new Inventory(new DomainInventoryStore(snapshots))
    await expect(inventory.initialize()).rejects.toThrow(/invalid/)
  })

  it('prunes removed records from the medium', async () => {
    const snapshots = new MemoryKvTable<unknown>()
    const store = new DomainInventoryStore(snapshots)
    const inventory = new Inventory(store)
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env1))
    await inventory.deleteDescriptor(env1)
    expect((snapshots.get('current') as { environments: object }).environments).toEqual({})
  })
})
describe('snapshot write uncertainty', () => {
  it('quarantines the inventory after a put that commits and then reports failure', async () => {
    class CommitThenFail extends MemoryKvTable<unknown> {
      fail = false
      override async put(key: string, value: unknown): Promise<void> {
        await super.put(key, value)
        if (this.fail) throw new Error('post-commit failure')
      }
    }
    const table = new CommitThenFail()
    const inventory = new Inventory(new DomainInventoryStore(table))
    await inventory.initialize()
    await inventory.putDescriptor(descriptorFor(env1))
    table.fail = true
    await expect(inventory.putDescriptor(descriptorFor(env2))).rejects.toThrow('post-commit failure')
    expect(() => inventory.list()).toThrow(/initialize/)
    await expect(inventory.putDescriptor(descriptorFor(env1))).rejects.toThrow(/initialize/)
    table.fail = false
    const reopened = new Inventory(new DomainInventoryStore(table))
    await reopened.initialize()
    expect(reopened.list().map(value => value.id)).toEqual([env1, env2])
  })
})


describe('real storage-domain integration', () => {
  it('persists descriptor and settled operation together in one table record across reopen', async () => {
    const context = new Context()
    await context.plugin(Storage)
    const pool = new MemoryMediaPool()
    context.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const facility = new DomainFacility(context, { backend: 'memory', routes: {} })
    const spec = defineDomain(wrapvmInventoryDomainSpec)
    const domain = await facility.open(spec)
    const inventory = new Inventory(new DomainInventoryStore(domain.table('snapshots')))
    await inventory.initialize()
    await inventory.commitSettlement({ id: 'op-atomic', environmentId: env1, kind: 'start', state: 'completed' }, {
      apply: records => ({ ...records, [env1]: descriptorFor(env1) }),
    })
    expect([...domain.table('snapshots').entries()]).toHaveLength(1)
    await domain.close()
    const reopenedDomain = await facility.open(spec)
    const reopened = new Inventory(new DomainInventoryStore(reopenedDomain.table('snapshots')))
    await reopened.initialize()
    expect(reopened.get(env1)?.id).toBe(env1)
    expect(reopened.operation('op-atomic')?.state).toBe('completed')
    await reopenedDomain.close()
  })
})
