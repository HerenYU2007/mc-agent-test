const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { strategy, runStep, checkpoint } = require('../agent/nmo-survival')
const { actions } = require('../agent/nmo-actions')
const { fits } = require('../agent/nmo-base')
const { WORKSHOP } = require('../supply-base')

function scenario(names, overrides = {}) {
  const operations = []
  const items = Object.entries(names).map(([name, count], i) => ({ slot: 36 + i, name, count }))
  const inventory = { items, armor: {}, offhand: null }
  const a = {
    inventory,
    status: { food: 20, health: 20, time_of_day: 4000, pos: [0, 64, 0] },
    here: () => [0, 64, 0],
    count: (n) => names[n] || 0,
    sum: (fn) => items.reduce((v, i) => v + (fn(i.name) ? i.count : 0), 0),
    tool: (k) => items.find((i) => i.name.endsWith('_' + k))?.name,
    safety: async () => false,
    gather: async (k) => operations.push(['gather', k]),
    ensureSticks: async () => true,
    ensurePlanks: async () => true,
    station: async (n) => {
      operations.push(['station', n])
      return [1, 64, 0]
    },
    craft: async (n) => {
      operations.push(['craft', n])
      names[n] = (names[n] || 0) + 1
    },
    reclaim: async (n) => operations.push(['reclaim', n]),
    smelt: async (...args) => operations.push(['smelt', ...args]),
    ...overrides,
  }
  const m = { diamonds: 0, surface: [0, 64, 0] }
  return {
    a,
    m,
    operations,
    next: () =>
      runStep(
        a,
        m,
        () => {},
        strategy(a, m),
        () => {},
      ),
  }
}
test('空背包到木镐和石镐沿用同一个阶段判断', async () => {
  const empty = scenario({})
  assert.equal(await empty.next(), 'gather_wood')
  assert.deepEqual(empty.operations, [['gather', 'wood']])
  const wood = scenario({ oak_log: 12, wooden_axe: 1 })
  assert.equal(await wood.next(), 'wood_tools')
  assert.ok(wood.operations.some((op) => op[1] === 'wooden_pickaxe'))
  const stone = scenario({ wooden_pickaxe: 1, cobblestone: 3 })
  await stone.next()
  assert.ok(stone.operations.some((op) => op[1] === 'stone_pickaxe'))
})
test('补煤、熔铁、装备和钻石后资格来自实际背包', async () => {
  const tools = { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1, stick: 6, oak_planks: 10 }
  const coal = scenario({ ...tools, raw_iron: 3 })
  await coal.next()
  assert.deepEqual(coal.operations, [['gather', 'coal']])
  const iron = scenario({ ...tools, coal: 3, raw_iron: 3 })
  await iron.next()
  assert.deepEqual(iron.operations, [['smelt', 'raw_iron', 'coal']])
  const pick = scenario({ ...tools, iron_ingot: 3, coal: 4 })
  await pick.next()
  assert.ok(pick.operations.some((op) => op[1] === 'iron_pickaxe'))
  const diamond = scenario({ ...tools, iron_pickaxe: 1, iron_sword: 1, bucket: 1, coal: 4, torch: 12 })
  for (const [k, type] of Object.entries({
    head: 'helmet',
    chest: 'chestplate',
    legs: 'leggings',
    feet: 'boots',
  }))
    diamond.a.inventory.armor[k] = { name: 'diamond_' + type }
  diamond.a.inventory.offhand = { name: 'shield' }
  const count = diamond.a.count
  let diamonds = 0
  diamond.a.count = (n) => (n === 'diamond' ? diamonds : count(n))
  diamond.a.gather = async (k) => {
    assert.equal(k, 'diamond')
    diamonds++
  }
  diamond.m.diamonds = 9
  await diamond.next()
  assert.equal(diamond.m.diamonds, 10)
  assert.equal(strategy(diamond.a, diamond.m).stage().name, 'supply_base')
})
test('熔炉内仍有成品时不拆，取货后验证清空和拾取', async () => {
  const inventory = { items: [{ name: 'iron_pickaxe', count: 1 }], armor: {} }
  const pos = [2, 64, 0],
    memory = { furnace: pos },
    ops = []
  let pending = true,
    block = 'furnace'
  const api = {
    async call(name, body) {
      ops.push(name)
      if (name === 'status') return { pos: [0, 64, 0] }
      if (name === 'inventory') return inventory
      if (name === 'get_block') return { name: block }
      if (name === 'window/view')
        return {
          sections: { fuel: [], input: [], output: pending ? [{ name: 'iron_ingot', count: 1 }] : [] },
          info: {},
        }
      if (name === 'window/act') {
        assert.equal(body.ops[0].from, 'output')
        inventory.items.push({ name: 'iron_ingot', count: 1 })
        pending = false
        return {}
      }
      if (name === 'equip') return {}
      if (name === 'dig') {
        block = 'air'
        inventory.items.push({ name: 'furnace', count: 1 })
        return {}
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    memory,
    () => {},
    () => {},
  )
  await a.refresh()
  assert.equal(await a.reclaim('furnace'), false)
  assert.equal(ops.includes('dig'), false)
  await a.smelt(null, null)
  await a.smelt(null, null)
  assert.equal(memory.furnace, undefined)
  assert.equal(a.count('furnace'), 1)
  assert.equal(a.count('iron_ingot'), 1)
})
test('工坊必须验证漏斗朝向和红石壁灯', () => {
  const feed = WORKSHOP.find((p) => p.id === 'fuel-feed'),
    indicator = WORKSHOP.find((p) => p.id === 'indicator')
  assert.equal(fits(feed, { name: 'hopper', properties: { facing: 'down' } }), false)
  assert.equal(fits(feed, { name: 'hopper', properties: { facing: 'west' } }), true)
  assert.equal(fits(indicator, { name: 'redstone_wall_torch', properties: { facing: 'south' } }), true)
})
test('重启保留进度且禁止误用其他存档', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmo-state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { MC_NMO_STATE_PATH: path.join(dir, 'state.json') },
    api = { base: 'http://localhost:1234/api/v1' },
    s = { username: 'A', dimension: 'overworld' }
  const prior = checkpoint(env, api, s)
  prior.memory.diamonds = 8
  prior.save()
  assert.equal(checkpoint(env, api, s).memory.diamonds, 8)
  assert.throws(() => checkpoint(env, api, { ...s, username: 'B' }), /存档归属/)
})
