import { test } from 'node:test'
import { strict as assert } from 'node:assert'

test('built host entry imports against installed DSH runtime packages', async () => {
  const plugin = await import('../lib/index.js')
  assert.equal(typeof plugin.default, 'function')
  assert.equal(typeof plugin.default.Config, 'function')
  assert.ok(plugin.default.inject.includes('tools'))
})
