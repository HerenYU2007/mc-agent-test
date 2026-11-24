const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createStorageLedger, recordNmoStorage } = require('../agent/storage-ledger')

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-storage-ledger-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return directory
}

test('仓储快照可在重启后读取，并按世界和维度隔离', t => {
  const directory = tempDirectory(t)
  const first = createStorageLedger('server-A', { directory })
  const pos = [6101, 64, -6188]
  first.record('overworld', pos, 'barrel', [{ name: 'diamond', count: 4 }, { name: 'diamond', count: 2 }])
  first.record('the_nether', pos, 'chest', [{ name: 'diamond', count: 1 }])
  const restarted = createStorageLedger('server-A', { directory })
  const records = restarted.find('overworld', 'diamond', pos, 5)
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].pos, pos)
  assert.equal(records[0].items.diamond, 6)
  assert.ok(Number.isFinite(Date.parse(records[0].checkedAt)))
  assert.equal(restarted.find('the_nether', 'diamond', pos, 5)[0].items.diamond, 1)
  assert.deepEqual(createStorageLedger('server-B', { directory }).find('overworld', 'diamond', pos, 5), [])
})

test('赛事开箱和存取回执替换同位置库存，并忽略非仓储窗口', t => {
  const directory = tempDirectory(t)
  const ledger = createStorageLedger('official', { directory })
  const pos = [1, 64, 3]
  const body = { target: { pos } }
  const describe = (target, container) => ({ target, sections: { container } })
  recordNmoStorage(ledger, 'overworld', 'window/view', body, describe('chest', [{ name: 'diamond', count: 2 }]))
  assert.equal(ledger.find('overworld', 'diamond', pos, 5).length, 1)
  recordNmoStorage(ledger, 'overworld', 'window/act', body, { window: describe('chest', [{ name: 'book', count: 1 }]) })
  recordNmoStorage(ledger, 'overworld', 'window/view', body, describe('hopper', [{ name: 'diamond', count: 8 }]))
  assert.deepEqual(ledger.find('overworld', 'diamond', pos, 5), [])
  assert.equal(ledger.find('overworld', 'book', pos, 5)[0].items.book, 1)
  const data = JSON.parse(fs.readFileSync(ledger.file, 'utf8'))
  assert.equal(data.containers.length, 1)
  assert.deepEqual(data.containers[0].items, { book: 1 })
})
