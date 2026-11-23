const fs = require('node:fs')
const path = require('node:path')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createExpeditionShelter } = require('./expedition-shelter')
const { createVillageVisit } = require('./expedition-village')

const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const ROAD_PHASES = ['searching', 'visiting', 'returning']
const PHASES = new Set([...ROAD_PHASES, 'preparing', 'awaiting-resupply', 'mapped'])
const VILLAGE_MARKER = /^(bell|farmland|hay_block|composter|[a-z_]+_bed)$/
const ARMOR = ['head', 'torso', 'legs', 'feet']
const isPosition = value => Array.isArray(value) && value.length === 3 && value.every(Number.isSafeInteger)
const vector = value => new Vec3(...value)
const pos = value => [Math.floor(value.x), Math.floor(value.y), Math.floor(value.z)]
const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const matching = (items, regex, durability) => items.some(item => item && regex.test(item.name) && durability(item) > 24)

function expeditionReadiness(bot, api) {
  const pack = bot.inventory.items()
  const torches = pack.filter(item => item.name === 'torch').reduce((sum, item) => sum + item.count, 0)
  const worn = slot => bot.inventory.slots[bot.getEquipmentDestSlot(slot)]
  const armor = ARMOR.filter(slot => {
    const item = worn(slot)
    return item && api.durability(item) > 24
  }).length
  const shield = matching([worn('off-hand'), ...pack], /^shield$/, api.durability)
  const tools = matching(pack, /_pickaxe$/, api.durability) && matching(pack, /_sword$/, api.durability)
  return { health: Number(bot.health), hunger: Number(bot.food), food: api.foodReserve(), torches, armor, shield, tools }
}

function retreatReason(status) {
  if (status.health <= 12) return 'health-low'
  if (status.hunger <= 10 || status.food < 3) return 'food-low'
  if (status.torches <= 3) return 'torches-low'
  if (status.armor < 4 || !status.shield || !status.tools) return 'equipment-worn'
  return null
}

function createVillageExpedition(api) {
  const initialState = (base = null) => ({ phase: 'preparing', room: null, spawn: null, reason: null,
    route: [], lastRoute: [], returnRoute: [], lastReturnRoute: [], landmarks: [], visited: [], base, village: null,
    returnIndex: 0, returnRetry: null, steps: 0, nextAfter: 0, entered: false, villageAction: null })
  let state = initialState()
  try {
    const saved = JSON.parse(fs.readFileSync(api.statePath, 'utf8'))
    if (saved.version === 1 && saved.world === api.world && PHASES.has(saved.phase) && isPosition(saved.base)) {
      state = { ...state, ...saved, route: (saved.route || []).filter(isPosition), lastRoute: (saved.lastRoute || []).filter(isPosition),
        returnRoute: Array.isArray(saved.returnRoute) ? saved.returnRoute.filter(isPosition) : [],
        lastReturnRoute: Array.isArray(saved.lastReturnRoute) ? saved.lastReturnRoute.filter(isPosition) : [],
        returnRetry: Number.isSafeInteger(saved.returnRetry) ? saved.returnRetry : null,
        room: isPosition(saved.room) ? saved.room : null, spawn: isPosition(saved.spawn) ? saved.spawn : null,
        legacyRoom: isPosition(saved.legacyRoom) ? saved.legacyRoom : null,
        village: isPosition(saved.village) ? saved.village : null,
        landmarks: (saved.landmarks || []).filter(mark => mark && isPosition(mark.position)), visited: (saved.visited || []).filter(isPosition) }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') api.log('expedition state could not be read', { message: error.message })
  }

  function persist() {
    const temporary = api.statePath + '.tmp.jsonl'
    fs.mkdirSync(path.dirname(api.statePath), { recursive: true })
    fs.writeFileSync(temporary, JSON.stringify({ ...state, version: 1, world: api.world }))
    fs.renameSync(temporary, api.statePath)
  }

  const shelter = createExpeditionShelter(api, persist)
  const visit = createVillageVisit(api)
  let observing = null
  let retryCraftAfter = 0
  const sameBase = base => isPosition(state.base) && vector(state.base).equals(base)
  const active = (bot, base) => bot.game?.dimension === 'overworld' && sameBase(base) && ROAD_PHASES.includes(state.phase)
  const nearBase = (bot, base) => horizontal(bot.entity.position, base) <= 5 && Math.abs(bot.entity.position.y - base.y) <= 4
  const daylight = bot => Number(bot.time?.timeOfDay) >= 0 && Number(bot.time?.timeOfDay) < 11800
  const gear = bot => expeditionReadiness(bot, api)
  const stopReason = bot => retreatReason(gear(bot)) || (!daylight(bot) ? 'nightfall' : null)

  function update(phase, reason) {
    const changed = phase !== state.phase || reason !== state.reason
    state.phase = phase
    state.reason = reason
    if (changed) {
      persist()
      api.log('expedition phase', { phase, reason, waypoints: state.route.length, village: state.village })
    }
  }

  function mark(type, position, details = null) {
    if (state.landmarks.some(item => item.type === type && horizontal(vector(item.position), position) < 15)) return
    const landmark = { type, position: pos(position), details }
    state.landmarks.push(landmark)
    state.landmarks = state.landmarks.slice(-100)
    persist()
    api.log('expedition landmark recorded', landmark)
  }

  function routePoint(route, position, endpoint = false) {
    const last = route.at(-1)
    const point = position.floored()
    if (last && (vector(last).equals(point) || (!endpoint && vector(last).distanceTo(position) < 6))) return
    route.push(pos(point))
    persist()
  }

  function discover(bot, base) {
    const visible = Object.values(bot.entities).filter(entity => entity.name === 'villager' && entity.position &&
      entity.position.distanceTo(bot.entity.position) <= 55 && horizontal(entity.position, base) > 20)
    const points = bot.findBlocks({ matching: block => VILLAGE_MARKER.test(block.name), maxDistance: 42, count: 48 })
    const marks = points.filter(position => horizontal(position, base) > 18).map(position => ({ position, name: bot.blockAt(position)?.name }))
    const kind = marker => marker.name?.endsWith('_bed') ? 'bed' : marker.name
    for (const marker of marks.filter(marker => ['bell', 'farmland', 'hay_block'].includes(marker.name)).slice(0, 8)) {
      mark(marker.name, marker.position)
    }
    const anchor = marks.find(marker => marker.name === 'bell' && marks.some(other => kind(other) !== 'bell' &&
      other.position.distanceTo(marker.position) < 26))?.position ??
      marks.find(marker => visible.some(entity => marker.position.distanceTo(entity.position) < 26))?.position ??
      marks.find(marker => {
        const types = new Set(marks.filter(other => other.position.distanceTo(marker.position) < 25).map(kind))
        return types.size >= 3 && (types.has('bed') || types.has('hay_block'))
      })?.position
    if (!anchor) return null
    mark('village', anchor, { villagers: visible.length, evidence: [...new Set(marks.filter(marker => marker.position.distanceTo(anchor) < 24).map(kind))] })
    return anchor.floored()
  }

  function beginReturn(bot, reason) {
    routePoint(state.route, bot.entity.position)
    state.returnIndex = state.route.length - 1
    state.returnRetry = null
    state.returnRoute = [pos(bot.entity.position)]
    update('returning', reason)
  }

  async function recordTravel(bot, action, route) {
    const remember = () => { if (bot.entity?.position) routePoint(route, bot.entity.position) }
    bot.on('move', remember)
    try { return await action() }
    finally { bot.removeListener('move', remember); remember() }
  }

  async function move(bot, target, returning, signal = null, recoverStep = false) {
    const goal = returning ? new goals.GoalNear(target.x, target.y, target.z, 2) : new goals.GoalNearXZ(target.x, target.z, 3)
    if (returning) {
      const withinRange = goal.isEnd.bind(goal)
      goal.isEnd = position => Math.abs(position.y - target.y) <= 1 && withinRange(position)
    }
    const watch = setInterval(() => {
      if (bot.pathfinder.goal === goal && (!api.safe(bot) || signal?.())) bot.pathfinder.setGoal(null)
    }, 250)
    try {
      const travel = () => api.travel(bot, goal, returning ? 'expedition return waypoint' : 'expedition scout', 17000,
        { returnWaypoint: returning, recoverStep })
      await recordTravel(bot, travel, returning ? state.returnRoute : state.route)
    } catch (error) {
      api.log('expedition path deferred', { target, returning, message: error.message })
    } finally { clearInterval(watch) }
    return Boolean(bot.entity?.position && goal.isEnd(bot.entity.position.floored()))
  }

  function targetsFor(bot, base) {
    const origin = bot.entity.position.floored()
    const targets = DIRECTIONS.map(([x, z]) => origin.offset(x * 30, 0, z * 30))
      .filter(target => horizontal(target, base) <= 175 && horizontal(target, base) > 15 &&
        !state.visited.some(visited => horizontal(vector(visited), target) < 21))
    const score = target => {
      const probe = bot.blockAt(target.offset(0, -1, 0))
      const water = /water|lava|kelp|seagrass/.test(probe?.name)
      return (water ? -80 : 0) + Math.min(horizontal(target, base), 115) * 0.25 +
        (state.route.length && horizontal(target, vector(state.route[0])) > 38 ? 8 : 0)
    }
    return targets.sort((a, b) => score(b) - score(a))
  }

  function villageApproaches(bot, village) {
    const safeGround = /water|lava|magma|fire|cactus|powder_snow|campfire/
    const walkable = block => block?.boundingBox === 'empty' && !safeGround.test(block.name)
    return DIRECTIONS.map(([x, z]) => village.offset(x * 6, 0, z * 6)).filter(target =>
      Array.from({ length: 19 }, (_, index) => target.offset(0, 6 - index, 0)).some(feet => {
        const floor = bot.blockAt(feet.offset(0, -1, 0))
        return floor?.boundingBox === 'block' && !safeGround.test(floor.name) &&
          walkable(bot.blockAt(feet)) && walkable(bot.blockAt(feet.offset(0, 1, 0)))
      }) && !state.visited.some(visited => horizontal(vector(visited), target) <= 3))
      .sort((a, b) => horizontal(a, bot.entity.position) - horizontal(b, bot.entity.position))
  }

  async function visitVillage(bot) {
    const options = visit.plan(bot, vector(state.village), state.entered, owns)
    if (Date.now() < retryCraftAfter) options.choices = options.choices.filter(action => action !== 'craft_bread')
    const observation = JSON.stringify([options.choices, options.resources, options.supplies, Math.floor(bot.health / 4)])
    if (observing === observation) return
    const signal = () => !api.safe(bot) || stopReason(bot)
    const selected = await api.selectVillage?.(bot, options)
    if (signal()) return
    const action = options.choices.includes(selected) ? selected :
      ['enter_village', 'craft_bread', 'harvest_wheat', 'take_bed'].find(choice => options.choices.includes(choice)) ?? 'observe_village'
    state.villageAction = action
    persist()
    api.showVillageAction?.(action)
    if (action === 'observe_village') { observing = observation; return }
    observing = null
    const watch = setInterval(() => {
      if (!signal()) return
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null)
      if (bot.targetDigBlock) bot.stopDigging()
    }, 200)
    try {
      const progress = await recordTravel(bot, () => visit.act(bot, action, options, signal))
      if (action === 'enter_village' && progress) { state.entered = true; persist() }
      if (action === 'craft_bread' && !progress) retryCraftAfter = Date.now() + 90000
    } finally { clearInterval(watch) }
  }

  async function continueTrip(bot, base) {
    if (!active(bot, base) || !api.safe(bot)) return false
    if (state.phase === 'searching') {
      const stop = stopReason(bot)
      if (stop) beginReturn(bot, stop)
      else {
        const village = discover(bot, base) || (state.village && vector(state.village))
        if (village && horizontal(village, bot.entity.position) <= 12) {
          state.village = pos(village)
          update('visiting', 'village-found')
        }
        else {
          const approaches = village ? villageApproaches(bot, village) : []
          const targets = approaches.length ? approaches : targetsFor(bot, base)
          if (!targets.length || state.steps >= 10) beginReturn(bot, 'search-radius-reached')
          else {
            const suggested = state.steps % 3 === 0 ? await api.selectScout?.(bot, targets, village) : null
            if (!api.safe(bot)) return true
            const stop = stopReason(bot)
            if (stop) { beginReturn(bot, stop); return true }
            const target = suggested ?? targets[0]
            state.steps++
            state.visited.push(pos(target))
            state.visited = state.visited.slice(-100)
            persist()
            await move(bot, target, false, () => stopReason(bot))
            if (!api.safe(bot)) return true
            const interrupted = stopReason(bot)
            if (interrupted) beginReturn(bot, interrupted)
            return true
          }
        }
      }
    }
    if (state.phase === 'visiting') {
      if (!stopReason(bot)) await visitVillage(bot)
      if (!api.safe(bot)) return true
      const stop = stopReason(bot)
      if (!stop) return true
      beginReturn(bot, stop)
    }
    routePoint(state.returnRoute, bot.entity.position)
    if (!nearBase(bot, base) && api.foodReserve() && bot.food < 16) await api.eat()
    const until = Date.now() + 11000
    for (let segment = 0; segment < 4 && Date.now() < until && api.safe(bot) && !nearBase(bot, base); segment++) {
      const index = Number.isSafeInteger(state.returnIndex) ? state.returnIndex : state.route.length - 1
      state.returnIndex = Math.max(-1, Math.min(index, state.route.length - 1))
      const before = bot.entity.position.floored()
      while (state.returnIndex >= 0) {
        const waypoint = vector(state.route[state.returnIndex])
        if (Math.abs(before.y - waypoint.y) > 1 || before.distanceTo(waypoint) > 4) break
        state.returnIndex--
      }
      const next = state.returnIndex >= 0 ? vector(state.route[state.returnIndex]) : base.offset(0, 0, 2)
      const retrying = state.returnRetry === state.returnIndex
      const reached = await move(bot, next, true, null, retrying)
      if (!api.safe(bot) || !bot.entity?.position) {
        persist()
        break
      }
      const stationary = before.equals(bot.entity.position.floored())
      if (reached || !stationary) state.returnRetry = null
      if (reached && state.returnIndex >= 0) state.returnIndex--
      if (!reached && stationary) {
        if (retrying && state.returnIndex >= 0) {
          api.log('expedition blocked return waypoint bypassed', { target: next, origin: before })
          state.returnIndex--
          state.returnRetry = null
        } else {
          state.returnRetry = state.returnIndex
        }
      }
      persist()
      if (!reached) break
    }
    if (api.safe(bot) && bot.entity?.position && nearBase(bot, base)) {
      routePoint(state.returnRoute, bot.entity.position, true)
      if (state.returnRoute.length > 1) state.lastReturnRoute = state.returnRoute
      state.returnRoute = []
      state.returnRetry = null
      state.lastRoute = state.route
      state.route = []
      state.nextAfter = Date.now() + 90000
      update('awaiting-resupply', state.reason)
      api.log('expedition returned to supply base', { position: bot.entity.position, waypoints: state.lastRoute.length,
        reason: state.reason, health: bot.health, food: api.foodReserve() })
    }
    return true
  }

  async function prepare(bot, base, services) {
    if (!sameBase(base)) {
      state = initialState(pos(base))
      persist()
    }
    const room = await shelter.prepare(bot, state, base, services)
    if (room !== 'ready') { update('preparing', room); return room }
    if (bot.isSleeping) return 'resting'
    const wornShield = bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]
    if (wornShield?.name !== 'shield' || api.durability(wornShield) <= 24) {
      const shield = bot.inventory.items().find(item => item.name === 'shield' && api.durability(item) > 24)
      if (shield) await bot.equip(shield, 'off-hand').catch(() => {})
    }
    const ready = gear(bot)
    const needs = retreatReason(ready)
    if (needs === 'equipment-worn') {
      await shelter.leave(bot, state)
      await api.regear()
      update('awaiting-resupply', needs)
      return needs
    }
    if (ready.torches < 16) { await shelter.leave(bot, state); return 'torches-low' }
    if (ready.food < 8 || ready.hunger < 16) { await shelter.leave(bot, state); return 'food-low' }
    if (!daylight(bot) || ready.health < 16 || Date.now() < state.nextAfter) {
      await shelter.enter(bot, state)
      update('awaiting-resupply', !daylight(bot) ? 'wait-for-daylight' : 'resting')
      return state.phase
    }
    if (!await shelter.leave(bot, state)) return 'shelter-doorway'
    state.steps = 0
    state.entered = false
    if (state.village) state.visited = []
    state.villageAction = null
    observing = null
    state.route = [pos(bot.entity.position)]
    update('searching', 'village-search')
    api.log('expedition departed', { position: bot.entity.position, ...ready })
    await continueTrip(bot, base)
    return state.phase
  }

  const owns = position => shelter.owns(state, position)
  return { active, continueTrip, prepare, owns, inside: bot => shelter.within(bot, state),
    buildingShelter: () => Boolean(state.hut && !state.hut.completed && state.phase === 'preparing'),
    leave: bot => shelter.leave(bot, state),
    status: () => ({ phase: state.phase, reason: state.reason, room: state.room, spawn: state.spawn,
      hut: shelter.status(state),
      village: state.village, villageAction: state.villageAction, landmarks: state.landmarks, route: state.route, lastRoute: state.lastRoute,
      returnRoute: state.returnRoute, lastReturnRoute: state.lastReturnRoute }) }
}

module.exports = { createVillageExpedition, expeditionReadiness, retreatReason }
