const http = require('node:http')
const { createOreFeed } = require('./nmo-observer-ores')
const { createStructureRoutes } = require('./structure-survey')

const STATUS_INTERVAL = 300
const INVENTORY_INTERVAL = 950
const SAMPLE_TIMEOUT = 1800
const MAX_AGE = 4000
const TRACE_LENGTH = 8
const TRACE_IDLE_LIMIT = 1500
const MINE_TARGET_MAX_AGE = 42000

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

function createObserverCache(initial, { now = Date.now, modelEnabled = false, tokenStart = 0 } = {}) {
  const identity = [initial.username, initial.server]
  let dimension = initial.dimension
  let status, inventory, statusAt, inventoryAt, inventoryAfter, movement
  let stage = '', route, decision, mineTarget, currentDig
  let tokens = { total: tokenStart }

  function observeStatus(next, at = now()) {
    if (!next || at < (statusAt ?? -Infinity)) return
    if ([next?.username, next?.server].some((value, index) => value != null && value !== identity[index])) {
      status = inventory = movement = route = mineTarget = currentDig = undefined
      statusAt = inventoryAfter = at
      return
    }
    if (!next.ready || next.alive === false || !position(next.pos)) return
    if (dimension && next.dimension && dimension !== next.dimension) {
      inventory = movement = route = mineTarget = currentDig = undefined
      inventoryAfter = at
    }
    dimension = next.dimension ?? dimension
    if (status?.last_death?.t !== next.last_death?.t && next.last_death?.t != null) {
      inventory = movement = route = mineTarget = currentDig = undefined
      inventoryAfter = at
    }
    status = next
    statusAt = at
    if (Object.hasOwn(next, 'observer_path')) {
      const waypoints = (next.observer_path?.waypoints || []).map(position).filter(Boolean)
      route = waypoints.length ? { waypoints, target: position(next.observer_path.end) } : undefined
    }
    if (!movement || at < movement.startedAt) return
    const point = position(next.pos)
    const separation = other => Math.hypot(other.x - point.x, other.y - point.y, other.z - point.z)
    if (movement.planned) {
      while (movement.waypoints.length && separation(movement.waypoints[0]) <= 0.8) movement.waypoints.shift()
      return
    }
    if (next.busy !== 'move_to') {
      movement.trace.length = 0
      return
    }
    if (at - movement.traceAt > TRACE_IDLE_LIMIT) movement.trace.length = 0
    const last = movement.trace.at(-1)
    const distance = last ? separation(last) : Infinity
    if (distance < 0.25) return
    if (last && distance > 12) movement.trace.length = 0
    movement.trace.push(point)
    movement.traceAt = at
    if (movement.trace.length > TRACE_LENGTH) movement.trace.shift()
  }

  function observeInventory(next, at = now()) {
    if (!status || !Array.isArray(next?.items) || at < (inventoryAt ?? -Infinity) || at < (inventoryAfter ?? -Infinity)) return
    inventory = next
    inventoryAt = at
  }

  function beginMove(body, verifiedWaypoints = []) {
    const waypoints = verifiedWaypoints.map(position).filter(Boolean)
    const move = { startedAt: now(), target: targetOf(body), planned: waypoints.length > 0,
      waypoints, trace: [], traceAt: -Infinity }
    movement = move
    return () => { if (movement === move) movement = undefined }
  }

  function setMineTarget(pos, name) {
    const target = position(pos)
    if (target) mineTarget = { point: {...target, name}, at: now() }
  }

  function clearMineTarget(pos) {
    if (!mineTarget) return
    const target = mineTarget.point
    if (!pos || (target.x === pos[0] && target.y === pos[1] && target.z === pos[2])) mineTarget = undefined
  }

  function beginDig(body) {
    const target = body?.collect === false ? null : targetOf(body)
    if (!target || target.y == null) return () => {}
    const current = { point: target }
    currentDig = current
    return () => { if (currentDig === current) currentDig = undefined }
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
      modelAction: decision?.action,
      modelReason: decision?.reason,
      mineTarget: mineTarget && now() - mineTarget.at <= MINE_TARGET_MAX_AGE
        ? mineTarget.point : currentDig?.point ?? null,
      tokens,
      action: status.busy === 'move_to' ? '移动' : stage || status.busy || '等待',
      navigation: {
        target: movement?.target ?? route?.target ?? null,
        waypoints: route?.waypoints ?? movement?.waypoints ?? [],
        trace: !route && movement && now() - movement.traceAt <= TRACE_IDLE_LIMIT ? movement.trace : [],
        routeSource: route ? 'official-path' : movement?.planned ? 'planned' : movement ? 'official-goal' : '',
      },
      inventory: inventorySlots(inventory),
    }
  }

  function observeModel({ objective, option, usage, plan }) {
    if (usage) {
      tokens = { input: usage.prompt_tokens, output: usage.completion_tokens,
        total: tokens.total + (Number.isSafeInteger(usage.total_tokens) ? usage.total_tokens : 0) }
    }
    if (option === undefined && !plan) return
    const directions = { '1,0,0': '向东', '-1,0,0': '向西', '0,0,1': '向南', '0,0,-1': '向北' }
    const target = typeof option === 'string' ? option
      : option?.name || directions[option?.direction?.join(',')] || option?.label || ''
    const coordinates = Array.isArray(option?.pos) ? '（' + option.pos.join(' / ') + '）' : ''
    decision = { action: objective, reason: plan || 'AIA 选择 ' + target + coordinates }
  }

  observeStatus(initial)
  return { observeStatus, observeInventory, observeModel, beginMove, beginDig, setMineTarget, clearMineTarget, frame,
    setStage(next) {
      stage = next
      if (next === '应对附近危险') clearMineTarget()
    },
  }
}

async function startNmoObserver(api, initial, { port, log = console.log, modelEnabled = false, tokenStart = 0 }) {
  if (!/^\d+$/.test(String(port)) || Number(port) > 65535) throw Error('MC_NMO_OBSERVER_PORT 需为 0–65535 的整数')
  const cache = createObserverCache(initial, { modelEnabled, tokenStart })
  const ores = createOreFeed(initial, cache.frame)
  const structureRoute = createStructureRoutes()
  const server = http.createServer((request, response) => {
    if (structureRoute(request, response)) return
    if (request.method === 'POST' && request.url === '/observer/ores') {
      void ores.handle(request, response)
      return
    }
    if (request.method !== 'GET' || request.url !== '/observer') {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    response.end(JSON.stringify({ ...cache.frame(), surveySession: ores.session, oreSurvey: ores.activeRequest() }))
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
    oreCandidates: ores.candidates,
    oreSurveyPending: ores.pending,
    forgetOre: ores.forget,
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
