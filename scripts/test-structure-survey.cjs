const test = require('node:test')
const assert = require('node:assert/strict')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync, existsSync } = require('node:fs')
const { once } = require('node:events')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { createStructureStore, createStructureRoutes } = require('../agent/structure-survey')
const { startNmoObserver } = require('../agent/nmo-observer')

const site = { type: 'village', world: 'demo/one', dimension: 'overworld', pos: [10, 64, 10], evidence: ['bell', 'bed', 'workstation'] }
const fortress = { type: 'fortress', world: 'demo/one', dimension: 'the_nether', pos: [10, 64, 10],
  evidence: ['nether_bricks', 'nether_brick_detail'] }
const trial = { ...site, type: 'trial_chambers', pos: [22, -24, -12],
  evidence: ['trial_spawner', 'trial_tuff', 'copper_grate'] }
const endPortal = { ...site, type: 'end_portal', pos: [-680, -23, 875],
  evidence: ['end_portal_frame', 'complete_frame_ring'] }

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'nmo-structure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return join(directory, 'finds.jsonl')
}

test('同一世界附近的同类地标去重，跨世界或结构类型独立保存', t => {
  const file = fixture(t)
  const store = createStructureStore({ file, now: () => 1000 })
  assert.equal(existsSync(file), false)
  const repeated = { ...site, world: ' demo/one ', pos: [33, 66, 11] }
  const farAway = { ...site, pos: [140, 65, 12] }
  assert.deepEqual(store.report([site, repeated, farAway, fortress]), { added: 3, duplicates: 1 })
  assert.deepEqual(store.report([{ ...site, world: 'demo/two' }]), { added: 1, duplicates: 0 })
  const afterRestart = createStructureStore({ file }).list()
  assert.equal(afterRestart.length, 4)
  assert(afterRestart.some(entry => entry.type === 'fortress' && entry.label === '下界要塞'))
  assert.deepEqual(afterRestart[0].pos, site.pos)
  assert.equal(afterRestart[0].seenAt, 1000)
})

test('HTTP 接收批次、拒绝跨维度或来自网页的上报，并提供持久化表', async t => {
  const store = createStructureStore({ file: fixture(t) })
  const route = createStructureRoutes(store)
  const server = createServer((request, response) => {
    if (!route(request, response)) response.writeHead(404).end()
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = 'http://127.0.0.1:' + server.address().port
  const send = (entries, headers = {}) => fetch(url + '/observer/structures', {
    method: 'POST', body: JSON.stringify(entries), headers: { 'content-type': 'application/json', ...headers },
  })
  assert.equal((await send([site], { origin: url })).status, 415)
  assert.equal((await send([{ ...site, dimension: 'the_end' }])).status, 400)
  assert.equal((await send([{ ...site, pos: [1, 64.5, 3] }])).status, 400)
  assert.equal((await send([{ ...site, evidence: ['bell', 'bell'] }])).status, 400)
  assert.equal((await send([site, trial, endPortal,
    { ...endPortal, type: 'stronghold', evidence: ['structure_start', 'structure_bounds'] },
    { ...site, type: 'shipwreck', evidence: ['structure_start', 'structure_bounds'] },
  ])).status, 200)
  assert.equal((await send([{ ...endPortal, dimension: 'the_end' }])).status, 400)
  assert.equal((await send([{ ...trial, pos: [23, -23, -14] }])).status, 200)
  const stored = await (await fetch(url + '/api/structures')).json()
  assert.equal(stored.entries.length, 5)
  assert(stored.entries.some(entry => entry.type === 'trial_chambers' && entry.label === '试炼密室'))
  assert.deepEqual(stored.entries.find(entry => entry.type === 'end_portal').pos, endPortal.pos)
  assert.match(await (await fetch(url + '/structures')).text(), /旁观者结构发现表/)
  assert.equal((await fetch(url + '/villages', { method: 'POST' })).status, 404)
})

test('赛事观察者服务同时提供结构表和原有遥测', async t => {
  const initial = { username: 'Miner', server: 'demo', dimension: 'overworld', pos: [0, 65, 0], ready: true }
  const server = await startNmoObserver({ call: async name => name === 'status' ? initial : { items: [] } },
    initial, { port: 0, log: () => {} })
  t.after(() => server.close())
  assert.equal((await fetch(new URL('/structures', server.endpoint))).status, 200)
  assert.equal((await (await fetch(server.endpoint)).json()).username, 'Miner')
})
