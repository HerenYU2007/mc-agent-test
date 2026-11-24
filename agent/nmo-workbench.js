const { setTimeout: delay } = require('node:timers/promises')

const DEFAULT_URL = 'https://mc-api.windywindie.top/api/v1'
const LOGS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
  .map(wood => wood + '_log')
const SKIP_TARGET = new Set(['path_not_found', 'stalled', 'out_of_reach', 'nothing_to_dig', 'undiggable',
  'not_loaded', 'protected_region', 'dig_unconfirmed'])

class NmoClient {
  constructor(env) {
    const url = new URL(env.MC_AGENT_API_URL || DEFAULT_URL)
    const local = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    if (!(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error('MC_AGENT_API_URL 需要 HTTPS 或本机回环 HTTP 地址')
    }
    this.base = url.href.replace(/\/+$/, '')
    this.token = env.MC_AGENT_TOKEN
  }

  async request(path, body, { signal } = {}) {
    const headers = { Accept: 'application/json' }
    if (this.token) headers.Authorization = 'Bearer ' + this.token
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    let response
    let payload
    try {
      const timeout = AbortSignal.timeout(90000)
      response = await fetch(this.base + '/' + path, {
        method: body === undefined ? 'GET' : 'POST', headers,
        body: JSON.stringify(body), redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      })
      payload = await response.json()
    } catch (cause) {
      const detail = cause.cause?.code || cause.name
      throw new Error(path + ' 未收到有效响应 (' + detail + ')。再次运行时会先核对背包。')
    }
    if (!response.ok || payload?.ok !== true) {
      const code = payload?.error?.code || 'http_' + response.status
      throw Object.assign(new Error(path + ' 失败 (' + code + ', HTTP ' + response.status + ')'), { code })
    }
    return payload
  }

  async call(path, body, options) {
    return (await this.request(path, body, options)).result
  }
}

async function waitReady(api, sleep) {
  for (let poll = 0; poll < 60; poll++) {
    try {
      const state = await api.call('status')
      if (state.ready && state.alive !== false && !state.busy) {
        if (state.gamemode && state.gamemode !== 'survival') {
          throw new Error('角色当前模式为 ' + state.gamemode + '，需要赛事服开放 survival 才能采集')
        }
        return state
      }
    } catch (error) {
      if (!['wrong_server', 'not_ready', 'not_connected'].includes(error.code)) throw error
    }
    await sleep(1000)
  }
  throw new Error('等待角色进入比赛服并空闲超时，请检查角色连接状态')
}

async function readItems(api) {
  const { items } = await api.call('inventory')
  if (!Array.isArray(items)) throw new Error('inventory 缺少 items 数组')
  const counts = new Map()
  for (const { name, count } of items) {
    if (typeof name !== 'string' || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('inventory 物品数据无效')
    }
    counts.set(name, (counts.get(name) || 0) + count)
  }
  return counts
}

async function observeGain(api, name, before, sleep) {
  for (let poll = 0; poll < 5; poll++) {
    const items = await readItems(api)
    if ((items.get(name) || 0) > before) return items
    if (poll < 4) await sleep(500)
  }
  return null
}

async function harvest(api, log, sleep) {
  const attempted = new Set()
  for (const radius of [16, 32, 64]) {
    const { blocks } = await api.call('find_blocks', { types: LOGS, radius, limit: 24 })
    const targets = blocks.filter(b => LOGS.includes(b.name) && Array.isArray(b.pos) &&
      b.pos.length === 3 && b.pos.every(Number.isSafeInteger)).sort((a, b) => a.dist - b.dist)
    for (const { name, pos } of targets) {
      const key = pos.join(',')
      if (attempted.has(key)) continue
      if (attempted.size >= 12) throw new Error('已尝试 12 个树干位置，仍未拾取原木')
      attempted.add(key)
      log('找到 ' + name + '，前往 [' + key + ']')
      try {
        const state = await waitReady(api, sleep)
        const distance = state.pos ? Math.hypot(...pos.map((v, i) => v - state.pos[i])) : Infinity
        if (distance > 3) await api.call('move_to', { pos, range: 2 })
        if ((await api.call('get_block', { pos })).name !== name) continue
        const before = (await readItems(api)).get(name) || 0
        await api.call('dig', { pos, collect: true })
        const items = await observeGain(api, name, before, sleep)
        if (items) {
          log('背包确认拾取 ' + name + ' × ' + (items.get(name) - before))
          return items
        }
        log('背包未收到该原木，检查下一个树干')
      } catch (error) {
        if (!SKIP_TARGET.has(error.code)) throw error
        log('跳过 [' + key + '] (' + error.code + ')')
      }
    }
  }
  throw new Error('64 格内没有可采集的暴露树干')
}

async function craft(api, item, count, inventory, log, sleep) {
  await waitReady(api, sleep)
  await api.call('craft', { item, count })
  const before = inventory.get(item) || 0
  const after = await observeGain(api, item, before, sleep)
  if (!after) throw new Error('合成后背包未增加 ' + item + '，已停止')
  log('背包确认合成 ' + item + ' × ' + (after.get(item) - before))
  return after
}

async function runWorkbench(env, { log = console.log, sleep = delay } = {}) {
  const api = new NmoClient(env)
  const ownSession = !api.token
  if (ownSession) {
    if (!env.MC_AGENT_USERNAME || !env.MC_AGENT_PASSWORD) {
      throw new Error('需在本机 .env 设置 MC_AGENT_TOKEN 或 MC_AGENT_USERNAME 和 MC_AGENT_PASSWORD')
    }
    const login = await api.request('auth/login', {
      username: env.MC_AGENT_USERNAME, password: env.MC_AGENT_PASSWORD
    })
    if (typeof login.token !== 'string' || !login.token) throw new Error('登录未返回 token')
    api.token = login.token
  }
  try {
    await waitReady(api, sleep)
    let items = await readItems(api)
    if (items.get('crafting_table')) {
      log('背包已有工作台 × ' + items.get('crafting_table'))
      return items.get('crafting_table')
    }
    const planks = [...items].reduce((sum, [name, count]) => sum + (name.endsWith('_planks') ? count : 0), 0)
    if (planks < 4) {
      if (!LOGS.some(name => items.get(name))) items = await harvest(api, log, sleep)
      const logName = LOGS.find(name => items.get(name))
      items = await craft(api, logName.replace(/_log$/, '_planks'), 4 - planks, items, log, sleep)
    }
    items = await craft(api, 'crafting_table', 1, items, log, sleep)
    return items.get('crafting_table')
  } finally {
    if (ownSession) {
      try {
        await api.request('auth/logout', {})
      } catch (error) {
        log('关闭本次 NMO 会话失败：' + error.message)
      }
    }
  }
}

if (require.main === module) {
  try {
    process.loadEnvFile()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  runWorkbench(process.env).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}

module.exports = { NmoClient, waitReady, runWorkbench }
