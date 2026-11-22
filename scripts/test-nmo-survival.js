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

test('角色占用施工格时，先通过 HTTP 走到安全的相邻格再重试', async () => {
  let pos = [0, 64, 0],
    attempts = 0
  const api = {
    async call(name, body) {
      if (name === 'status') return { pos }
      if (name === 'inventory') return { items: [] }
      if (name === 'get_block') return { name: body.pos[1] < 64 ? 'stone' : 'air' }
      if (name === 'move_to') {
        pos = body.pos
        return { pos }
      }
      if (name === 'place') {
        if (!attempts++) throw Object.assign(Error('self'), { code: 'blocked_by_self' })
        assert.notDeepEqual(pos, body.pos)
        return { placed: body.item, pos: body.pos }
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    {},
    () => {},
    () => {},
  )
  await a.refresh()
  assert.equal((await a.placeAt('hopper', [0, 64, 0])).placed, 'hopper')
  assert.equal(attempts, 2)
})

test('从已有工作台续跑时，新入口只通过 HTTP 完成木镐并拾回工作台', async (t) => {
  const { runSurvival } = require('../agent/nmo-survival')
  const http = require('node:http')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmo-http-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stop = new AbortController(),
    trace = []
  const bag = new Map([
    ['oak_log', 12],
    ['crafting_table', 1],
    ['wooden_axe', 1],
  ])
  const delta = (name, n) => bag.set(name, (bag.get(name) || 0) + n)
  let table = false
  const server = http.createServer(async (req, res) => {
    const path = req.url.replace('/api/v1/', ''),
      chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
    trace.push(path)
    let result
    assert.equal(req.headers.authorization, 'Bearer local-test-token')
    if (path === 'status')
      result = {
        ready: true,
        alive: true,
        username: 'Sim',
        dimension: 'overworld',
        gamemode: 'survival',
        pos: [0, 64, 0],
        food: 20,
        health: 20,
        time_of_day: 3000,
      }
    else if (path === 'inventory')
      result = {
        items: [...bag]
          .filter(([, count]) => count > 0)
          .map(([name, count], slot) => ({ name, count, slot: 36 + slot })),
        armor: {},
      }
    else if (path === 'craft') {
      if (body.item === 'oak_planks') {
        delta('oak_log', -1)
        delta('oak_planks', 4)
      } else if (body.item === 'stick') {
        delta('oak_planks', -2)
        delta('stick', 4)
      } else if (body.item === 'wooden_pickaxe') {
        assert.ok(table)
        delta('oak_planks', -3)
        delta('stick', -2)
        delta(body.item, 1)
      } else if (body.item === 'wooden_sword') {
        assert.ok(table)
        delta('oak_planks', -2)
        delta('stick', -1)
        delta(body.item, 1)
      } else assert.fail(body.item)
      result = {}
    } else if (path === 'place') {
      table = true
      delta('crafting_table', -1)
      result = { placed: 'crafting_table', pos: [2, 64, 0] }
    } else if (path === 'get_block') result = { name: table ? 'crafting_table' : 'air', pos: body.pos }
    else if (path === 'dig') {
      assert.ok(table)
      table = false
      delta('crafting_table', 1)
      stop.abort()
      result = {}
    } else assert.fail(path)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  await runSurvival(
    {
      MC_AGENT_API_URL: 'http://127.0.0.1:' + server.address().port + '/api/v1',
      MC_AGENT_TOKEN: 'local-test-token',
      MC_NMO_STATE_PATH: path.join(dir, 'state.json'),
    },
    { signal: stop.signal, log: () => {}, sleep: async () => {} },
  )
  assert.equal(bag.get('wooden_pickaxe'), 1)
  assert.equal(bag.get('crafting_table'), 1)
  assert.ok(trace.includes('craft'))
  assert.ok(!trace.includes('auth/logout'))
})

test('AIA 选择会改变实际 NMO 挖掘目标，单次预算不会产生第二次推理', async () => {
  const { createNmoPlanner } = require('../agent/nmo-planner')
  const state = { ready: true, gamemode: 'survival', health: 20, food: 20, pos: [0, 68, 0] }
  const blocks = [
    [2, 68, 0],
    [3, 68, 0],
    [4, 68, 0],
  ].map((pos) => ({ name: 'oak_log', pos }))
  const digs = [],
    notes = []
  let requests = 0,
    elapsed = 0
  const choose = createNmoPlanner(
    { LLM_API_KEY: 'mock-credential', LLM_MODEL: 'mock-model', LLM_MAX_CALLS: '1' },
    {
      now: () => elapsed,
      log: (line) => notes.push(line),
      request: async (url, opts) => {
        requests++
        assert.equal(url, 'https://api.nju-aia.com/v1/chat/completions')
        assert.equal(opts.redirect, 'error')
        assert.equal(opts.headers.Authorization, 'Bearer mock-credential')
        const observation = JSON.parse(JSON.parse(opts.body).messages[1].content)
        assert.equal(observation.objective, 'wood')
        assert.deepEqual(observation.options[1].pos, blocks[1].pos)
        return Response.json({
          choices: [{ message: { content: '{"choice":1}' } }],
          usage: { total_tokens: 47 },
        })
      },
    },
  )
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return { items: [], armor: {} }
      if (name === 'find_blocks') return { blocks }
      if (name === 'get_block') return { name: 'oak_log' }
      if (name === 'dig') {
        digs.push(body.pos)
        return { gained: { oak_log: 1 } }
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    {},
    () => {},
    (line) => notes.push(line),
    choose,
  )
  await a.refresh()
  await a.gather('wood')
  elapsed += 60000
  await a.gather('wood')
  assert.deepEqual(digs, [blocks[1].pos, blocks[0].pos])
  assert.equal(requests, 1)
  assert.ok(notes.some((line) => line.includes('47')))
  assert.ok(notes.every((line) => !line.includes('mock-credential')))
})

test('AIA 拒绝越界选择，HTTP 鉴权失败时不把响应正文写入日志', async () => {
  const { createNmoPlanner } = require('../agent/nmo-planner')
  const obs = { options: [{}, {}] },
    model = { LLM_API_KEY: 'mock-credential', LLM_MODEL: 'mock-model' }
  assert.equal(createNmoPlanner({}), null)
  assert.throws(() => createNmoPlanner({ ...model, LLM_BASE_URL: 'https://invalid.example/v1' }), /官方/)
  for (const reply of [
    Response.json({ choices: [{ message: { content: '{"choice":99}' } }] }),
    new Response('private-provider-details', { status: 403 }),
  ]) {
    const lines = []
    const choose = createNmoPlanner(model, { log: (s) => lines.push(s), request: async () => reply })
    assert.equal(await choose(obs), null)
    assert.ok(lines[0].includes('继续本地流程'))
    assert.ok(!lines[0].includes('private-provider-details'))
  }
})
