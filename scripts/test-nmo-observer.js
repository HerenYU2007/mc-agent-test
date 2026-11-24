const test = require('node:test')
const assert = require('node:assert/strict')
const { createObserverCache, startNmoObserver } = require('../agent/nmo-observer')

const base = { username: 'Agent', dimension: 'overworld', server: 'survivaltest', ready: true, alive: true,
  pos: [1.5, 64, -1.5], health: 20, food: 18, xp_level: 5 }

test('竞赛寻路仅显示观测到的实走轨迹，停走后立即清除', () => {
  let at = 100
  const cache = createObserverCache(base, { now: () => at })
  const stop = cache.beginMove({ pos: [5, 64, -4] })
  assert.deepEqual(cache.frame().navigation.waypoints, [])
  cache.observeStatus({ ...base, busy: 'move_to' }, ++at)
  cache.observeStatus({ ...base, pos: [2.5, 64, -2.5], busy: 'move_to' }, ++at)
  assert.deepEqual(cache.frame().navigation, {
    target: { x: 5, y: 64, z: -4 }, waypoints: [], routeSource: 'official-goal',
    trace: [{ x: 1.5, y: 64, z: -1.5 }, { x: 2.5, y: 64, z: -2.5 }],
  })
  at += 1501
  assert.deepEqual(cache.frame().navigation.trace, [])
  cache.observeStatus({ ...base, busy: null }, ++at)
  assert.deepEqual(cache.frame().navigation.trace, [])
  stop()
  assert.equal(cache.frame().navigation.target, null)
  cache.beginMove({ pos: [5, 64, -4] }, [[2.5, 64, -2.5], [3.5, 64, -3.5]])
  assert.deepEqual(cache.frame().navigation.waypoints, [{ x: 2.5, y: 64, z: -2.5 }, { x: 3.5, y: 64, z: -3.5 }])
  cache.observeStatus({ ...base, pos: [2.5, 64, -2.5], busy: 'move_to' }, ++at)
  assert.deepEqual(cache.frame().navigation.waypoints, [{ x: 3.5, y: 64, z: -3.5 }])
  assert.deepEqual(cache.frame().navigation.trace, [])
  assert.equal(cache.frame().positionCentered, true)
})

test('状态和背包独立老化，短暂未就绪保留帧，死亡清除旧库存', () => {
  let at = 1000
  const cache = createObserverCache(base, { now: () => at })
  const inventory = { empty_slots: 34, items: [
    { slot: 36, name: 'diamond_pickaxe', count: 1, durability_used: 4, enchantments: [{}] },
    { slot: 9, name: 'cobblestone', count: 20 },
  ], held: { slot: 36 } }
  cache.observeInventory(inventory)
  at += 500
  cache.observeStatus({ ready: false })
  assert.equal(cache.frame().connected, true)
  assert.equal(cache.frame().inventoryFresh, true)
  assert.equal(cache.frame().inventory.backpack[0].count, 20)
  assert.deepEqual(cache.frame().inventory.hotbar[0], { id: 'minecraft:diamond_pickaxe', count: 1, damage: 4, enchanted: true })
  assert.equal(cache.frame().inventory.selected, 0)
  at += 4500
  cache.observeStatus({ ...base, food: 16 })
  assert.equal(cache.frame().food, 16)
  assert.equal(cache.frame().inventoryFresh, false)
  cache.observeStatus({ ...base, last_death: { t: 21 }, xp_level: 0 }, ++at)
  cache.observeInventory(inventory, at - 1)
  assert.equal(cache.frame().experienceLevel, 0)
  assert.equal(cache.frame().inventory.hotbar[0], null)
  at += 4001
  assert.equal(cache.frame().connected, false)
  cache.observeStatus(base)
  assert.equal(cache.frame().connected, true)
})

test('HTTP 面板读缓存，库存请求挂起也能立即读取最新状态', async t => {
  let startedInventory = false
  const api = { call(endpoint, _body, { signal }) {
    if (endpoint === 'status') return { ...base, health: 18 }
    startedInventory = true
    return new Promise((_resolve, reject) => signal.addEventListener('abort', reject, { once: true }))
  } }
  const observer = await startNmoObserver(api, base, { port: '0', log: () => {} })
  t.after(() => observer.close())
  assert.equal(startedInventory, true)
  const response = await fetch(observer.endpoint, { signal: AbortSignal.timeout(600) })
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const frame = await response.json()
  assert.equal(frame.connected, true)
  assert.equal(frame.health, 18)
  assert.equal(frame.inventoryFresh, false)
})
