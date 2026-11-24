const http = require('node:http')

const STATUS_INTERVAL = 300
const INVENTORY_INTERVAL = 950
const SAMPLE_TIMEOUT = 1800
const MAX_AGE = 4000
const TRACE_LENGTH = 8

function position(value) {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every(Number.isFinite)) return null
  const [x, y, z] = value
  return { x, y, z }
}

function targetOf(body) {
  const point = position(body?.pos)
  if (point) return point
  if (!Number.isFinite(body?.x) || !Number.isFinite(body?.z)) return null
  return { x: body.x, y: Number.isFinite(body.y) ? body.y : null, z: body.z }
}

function itemSlot(item) {
  if (!item?.name || !(item.count > 0)) return null
  return {
    id: item.name.includes(':') ? item.name : 'minecraft:' + item.name,
    count: item.count,
    damage: item.durability_used ?? (Array.isArray(item.durability) ? item.durability[1] - item.durability[0] : 0),
    enchanted: Boolean(item.enchantments?.length),
  }
}

function inventorySlots(inv) {
  const slots = new Map((inv?.items || []).map(item => [item.slot, itemSlot(item)]))
  const row = (start, length) => Array.from({ length }, (_, i) => slots.get(start + i) || null)
  return {
    backpack: row(9, 27),
    hotbar: row(36, 9),
    armor: ['head', 'chest', 'legs', 'feet'].map(name => itemSlot(inv?.armor?.[name])),
    offhand: itemSlot(inv?.offhand),
    selected: inv?.held?.slot >= 36 && inv.held.slot < 45 ? inv.held.slot - 36 : -1,
  }
}

function createObserverCache(initial, { now = Date.now, modelEnabled = false } = {}) {
  const identity = [initial.username, initial.server, initial.dimension]
  let status, inventory, statusAt, inventoryAt, movement
  let stage = ''

  function observeStatus(next, at = now()) {
    if ([next?.username, next?.server, next?.dimension].some((value, index) => value != null && value !== identity[index])) {
      status = inventory = movement = undefined
      return
    }
    if (!next?.ready || next.alive === false || !position(next.pos) || at < (statusAt ?? -Infinity)) return
    if (status?.last_death?.t !== next.last_death?.t && next.last_death?.t != null) {
      inventory = movement = undefined
    }
    status = next
    statusAt = at
    if (!movement) return
    if (next.busy !== 'move_to') {
      movement.trace.length = 0
      return
    }
    const point = position(next.pos)
    const last = movement.trace.at(-1)
    const distance = last ? Math.hypot(last.x - point.x, last.y - point.y, last.z - point.z) : Infinity
    if (distance < 0.25) return
    if (last && distance > 12) movement.trace.length = 0
    movement.trace.push(point)
    if (movement.trace.length > TRACE_LENGTH) movement.trace.shift()
  }

  function observeInventory(next, at = now()) {
    if (!status || !Array.isArray(next?.items) || at < (inventoryAt ?? -Infinity) || at < (status.last_death?.t ?? -Infinity)) return
    inventory = next
    inventoryAt = at
  }

  function beginMove(body, verifiedWaypoints = []) {
    const move = { target: targetOf(body), waypoints: verifiedWaypoints.map(position).filter(Boolean), trace: [] }
    movement = move
    return () => { if (movement === move) movement = undefined }
  }

  function frame() {
    if (!status || now() - statusAt > MAX_AGE) return { username: identity[0], connected: false }
    return {
      username: identity[0],
      connected: true,
      sampledAt: statusAt,
      inventoryFresh: Boolean(inventory && now() - inventoryAt <= MAX_AGE),
      position: position(status.pos),
      positionCentered: true,
      health: status.health,
      food: status.food,
      experienceLevel: status.xp_level,
      freeSlots: inventory?.empty_slots,
      shieldRaised: Boolean(status.blocking),
      modelEnabled,
      action: status.busy === 'move_to' ? '移动' : stage || status.busy || '等待',
      navigation: {
        target: movement?.target ?? null,
        waypoints: movement?.waypoints ?? [],
        trace: movement?.waypoints.length ? [] : movement?.trace ?? [],
        routeSource: movement?.waypoints.length ? 'planned' : movement ? 'official-goal' : '',
      },
      inventory: inventorySlots(inventory),
    }
  }

  observeStatus(initial)
  return { observeStatus, observeInventory, beginMove, frame, setStage: next => { stage = next } }
}

async function startNmoObserver(api, initial, { port, log = console.log, modelEnabled = false }) {
  if (!/^\d+$/.test(String(port)) || Number(port) > 65535) throw Error('MC_NMO_OBSERVER_PORT 需为 0–65535 的整数')
  const cache = createObserverCache(initial, { modelEnabled })
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/observer') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify(cache.frame()))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const endpoint = `http://127.0.0.1:${server.address().port}/observer`
  log('赛事观察者数据已开启 ' + endpoint)
  const controller = new AbortController()
  const timers = new Set()

  function sample(path, interval, observe) {
    const tick = async () => {
      const at = Date.now()
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(SAMPLE_TIMEOUT)])
        const result = await api.call(path, undefined, { signal })
        if (!controller.signal.aborted) observe(result, at)
      } catch {
        // Each source keeps the last confirmed response until its own freshness limit.
      } finally {
        if (!controller.signal.aborted) {
          const timer = setTimeout(() => { timers.delete(timer); void tick() }, interval)
          timers.add(timer)
        }
      }
    }
    void tick()
  }

  sample('status', STATUS_INTERVAL, cache.observeStatus)
  sample('inventory', INVENTORY_INTERVAL, cache.observeInventory)
  return {
    ...cache,
    endpoint,
    close() {
      controller.abort()
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      return new Promise(resolve => server.close(resolve))
    },
  }
}

module.exports = { createObserverCache, startNmoObserver }
