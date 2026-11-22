const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { once } = require('node:events')
const { runWorkbench } = require('../agent/nmo-workbench')

const tree = { name: 'birch_log', pos: [12, 68, -3], dist: 14 }
const blocked = { name: 'oak_log', pos: [8, 68, -4], dist: 9 }

async function fixture(t, { inventory = {}, trees = [tree], intercept = () => {} } = {}) {
  const calls = []
  const items = { ...inventory }
  const token = 'local-test-only'
  const server = http.createServer(async (req, res) => {
    const route = req.url.slice('/api/v1/'.length)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
    calls.push({ route, body, method: req.method, auth: req.headers.authorization })
    const send = (doc, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(doc))
    const ok = result => send({ ok: true, result })
    const fail = code => send({ ok: false, error: { code } })
    if (route === 'auth/login') {
      if (body.username !== 'tester' || body.password !== 'fixture') return fail('invalid_credentials')
      return send({ ok: true, token })
    }
    if (req.headers.authorization !== 'Bearer ' + token) return send({ ok: false, error: { code: 'invalid_token' } }, 401)
    if (intercept({ route, body, ok, fail, items, res })) return
    switch (route) {
      case 'auth/logout': return send({ ok: true })
      case 'status': return ok({ ready: true, alive: true, busy: null })
      case 'inventory': return ok({ items: Object.entries(items).map(([name, count]) => ({ name, count })) })
      case 'find_blocks': return ok({ blocks: trees.filter(b => body.types.includes(b.name) && b.dist <= body.radius) })
      case 'move_to': return ok({ pos: body.pos })
      case 'get_block': return ok(trees.find(b => String(b.pos) === String(body.pos)))
      case 'dig': {
        const block = trees.find(b => String(b.pos) === String(body.pos))
        if (!block || body.collect !== true) return fail('nothing_to_dig')
        items[block.name] = (items[block.name] || 0) + 1
        return ok({ dug: block.name, gained: { [block.name]: 1 } })
      }
      case 'craft': {
        if (body.item.endsWith('_planks')) {
          const name = body.item.replace(/_planks$/, '_log')
          if (!items[name] || body.count < 1 || body.count > 4) return fail('missing_ingredients')
          items[name]--
          items[body.item] = (items[body.item] || 0) + 4
          return ok({ crafted: body.item, gained: 4 })
        }
        if (body.item === 'crafting_table' && body.count === 1) {
          const planks = Object.keys(items).find(name => name.endsWith('_planks') && items[name] >= 4)
          if (!planks) return fail('missing_ingredients')
          items[planks] -= 4
          items.crafting_table = (items.crafting_table || 0) + 1
          return ok({ crafted: body.item, gained: 1 })
        }
        return fail('no_recipe')
      }
      default: return fail('unknown_api')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
  const env = { MC_AGENT_API_URL: 'http://127.0.0.1:' + server.address().port + '/api/v1',
    MC_AGENT_USERNAME: 'tester', MC_AGENT_PASSWORD: 'fixture' }
  return { calls, items, run: overrides => runWorkbench({ ...env, ...overrides }, { log() {}, sleep: async () => {} }) }
}

test('空背包，经 HTTP 登录、等待就绪、找树、砍木、合成并核对背包', async t => {
  let polls = 0
  const f = await fixture(t, { intercept({ route, ok }) {
    if (route !== 'status' || ++polls > 2) return false
    ok({ ready: polls > 1, busy: polls === 2 ? 'move_to' : null })
    return true
  } })
  assert.equal(await f.run(), 1)
  assert.equal(f.items.crafting_table, 1)
  assert.deepEqual(f.calls.slice(0, 5).map(c => c.route), ['auth/login', 'status', 'status', 'status', 'inventory'])
  const actions = f.calls.filter(c => ['move_to', 'dig', 'craft'].includes(c.route))
  assert.deepEqual(actions.map(c => c.body), [{ pos: tree.pos, range: 2 }, { pos: tree.pos, collect: true },
    { item: 'birch_planks', count: 4 }, { item: 'crafting_table', count: 1 }])
  for (const c of f.calls) assert.equal(c.method, ['status', 'inventory'].includes(c.route) ? 'GET' : 'POST')
  assert.deepEqual(f.calls.slice(-2).map(c => c.route), ['inventory', 'auth/logout'])
})

test('受保护的树换目标，用已有 token 保留会话', async t => {
  const f = await fixture(t, { trees: [blocked, tree], intercept({ route, body, fail }) {
    if (route !== 'dig' || String(body.pos) !== String(blocked.pos)) return false
    fail('protected_region')
    return true
  } })
  assert.equal(await f.run({ MC_AGENT_TOKEN: 'local-test-only' }), 1)
  assert.deepEqual(f.calls.filter(c => c.route === 'dig').map(c => c.body.pos), [blocked.pos, tree.pos])
  assert.ok(f.calls.every(c => !c.route.startsWith('auth/')))
})

test('已有木板直接合成，再运行时识别已有工作台', async t => {
  const f = await fixture(t, { inventory: { oak_planks: 4 } })
  assert.equal(await f.run(), 1)
  assert.equal(await f.run(), 1)
  assert.deepEqual(f.calls.filter(c => ['find_blocks', 'dig', 'craft'].includes(c.route)).map(c => c.route), ['craft'])
})

test('64 格内没有树时停止', async t => {
  const f = await fixture(t, { trees: [] })
  await assert.rejects(f.run(), /没有可采集/)
  assert.deepEqual(f.calls.filter(c => c.route === 'find_blocks').map(c => c.body.radius), [16, 32, 64])
  assert.ok(f.calls.every(c => c.route !== 'dig'))
})

test('合成回执成功但背包没有产物时报告失败', async t => {
  const f = await fixture(t, { inventory: { oak_planks: 4 }, intercept({ route, ok }) {
    if (route !== 'craft') return false
    ok({ crafted: 'crafting_table', gained: 1 })
    return true
  } })
  await assert.rejects(f.run(), /背包未增加 crafting_table/)
  assert.equal(f.calls.filter(c => c.route === 'craft').length, 1)
})

test('动作已生效但连接中断时不重发，重启从背包继续', async t => {
  const f = await fixture(t, { inventory: { oak_planks: 4 }, intercept({ route, items, res }) {
    if (route !== 'craft') return false
    items.oak_planks = 0
    items.crafting_table = 1
    res.destroy()
    return true
  } })
  await assert.rejects(f.run(), /craft 未收到有效响应/)
  assert.equal(await f.run(), 1)
  assert.equal(f.calls.filter(c => c.route === 'craft').length, 1)
})

test('拒绝无效 token，保留调用者已有会话', async t => {
  const f = await fixture(t)
  await assert.rejects(f.run({ MC_AGENT_TOKEN: 'expired' }), /invalid_token/)
  assert.deepEqual(f.calls.map(c => c.route), ['status'])
})

test('在旁观模式下报告服端限制并停止', async t => {
  const f = await fixture(t, { intercept({ route, ok }) {
    if (route !== 'status') return false
    ok({ ready: true, alive: true, gamemode: 'spectator' })
    return true
  } })
  await assert.rejects(f.run(), /spectator/)
  assert.deepEqual(f.calls.map(c => c.route), ['auth/login', 'status', 'auth/logout'])
})
