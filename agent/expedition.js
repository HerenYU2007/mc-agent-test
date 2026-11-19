const fs = require('node:fs')
const path = require('node:path')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createExpeditionShelter, shelterGeometry } = require('./expedition-shelter')

const DIRECTIONS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]
const PHASES = new Set(['preparing', 'searching', 'returning', 'awaiting-resupply', 'mapped'])
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
  let state = { phase: 'preparing', room: null, spawn: null, reason: null, route: [], lastRoute: [], landmarks: [],
    visited: [], base: null, village: null, returnIndex: 0, steps: 0, nextAfter: 0 }
  try {
    const saved = JSON.parse(fs.readFileSync(api.statePath, 'utf8'))
    if (saved.version === 1 && saved.world === api.world && PHASES.has(saved.phase) && isPosition(saved.base)) {
      state = { ...state, ...saved, route: (saved.route || []).filter(isPosition), lastRoute: (saved.lastRoute || []).filter(isPosition),
        room: isPosition(saved.room) ? saved.room : null, spawn: isPosition(saved.spawn) ? saved.spawn : null,
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
  const sameBase = base => isPosition(state.base) && vector(state.base).equals(base)
  const active = (bot, base) => bot.game?.dimension === 'overworld' && sameBase(base) && ['searching', 'returning'].includes(state.phase)
  const nearBase = (bot, base) => horizontal(bot.entity.position, base) <= 5 && Math.abs(bot.entity.position.y - base.y) <= 4
  const daylight = bot => Number(bot.time?.timeOfDay) >= 0 && Number(bot.time?.timeOfDay) < 11800
  const gear = bot => expeditionReadiness(bot, api)

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

  function routePoint(position) {
    const last = state.route.at(-1)
    if (last && vector(last).distanceTo(position) < 6) return
    state.route.push(pos(position))
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
    const anchor = visible.find(entity => marks.some(marker => marker.position.distanceTo(entity.position) < 26))?.position ??
      marks.find(marker => marker.name === 'bell' && marks.some(other => kind(other) !== 'bell' &&
        other.position.distanceTo(marker.position) < 26))?.position ?? marks.find(marker => {
        const types = new Set(marks.filter(other => other.position.distanceTo(marker.position) < 25).map(kind))
        return types.size >= 3 && (types.has('bed') || types.has('hay_block'))
      })?.position
    if (!anchor) return null
    mark('village', anchor, { villagers: visible.length, evidence: [...new Set(marks.filter(marker => marker.position.distanceTo(anchor) < 24).map(kind))] })
    return anchor.floored()
  }

  function beginReturn(bot, reason) {
    routePoint(bot.entity.position)
    state.returnIndex = state.route.length - 1
    update('returning', reason)
  }

  async function move(bot, target, returning, signal = null) {
    const goal = returning ? new goals.GoalNear(target.x, target.y, target.z, 2) : new goals.GoalNearXZ(target.x, target.z, 3)
    const watch = setInterval(() => {
      if (bot.pathfinder.goal === goal && (!api.safe(bot) || (signal && signal()))) bot.pathfinder.setGoal(null)
    }, 250)
    const remember = () => routePoint(bot.entity.position)
    if (!returning) bot.on('move', remember)
    try {
      await api.travel(bot, goal, returning ? 'expedition return waypoint' : 'expedition scout', 17000)
      return goal.isEnd(bot.entity.position.floored())
    } catch (error) {
      api.log('expedition path deferred', { target, returning, message: error.message })
      return false
    } finally {
      clearInterval(watch)
      if (!returning) { bot.removeListener('move', remember); remember() }
    }
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

  async function continueTrip(bot, base) {
    if (!active(bot, base) || !api.safe(bot)) return false
    if (state.phase === 'searching') {
      const stop = retreatReason(gear(bot)) || (!daylight(bot) ? 'nightfall' : null)
      if (stop) beginReturn(bot, stop)
      else {
        const village = discover(bot, base)
        if (village && horizontal(village, bot.entity.position) <= 12) {
          state.village = pos(village)
          beginReturn(bot, 'village-found')
        }
        else {
          const approaches = village ? villageApproaches(bot, village) : []
          const targets = approaches.length ? approaches : targetsFor(bot, base)
          if (!targets.length || state.steps >= 10) beginReturn(bot, 'search-radius-reached')
          else {
            const suggested = state.steps % 3 === 0 ? await api.selectScout?.(bot, targets, village) : null
            const stop = retreatReason(gear(bot)) || (!daylight(bot) ? 'nightfall' : null)
            if (stop) { beginReturn(bot, stop); return true }
            if (!api.safe(bot)) return true
            const target = suggested ?? targets[0]
            state.steps++
            state.visited.push(pos(target))
            state.visited = state.visited.slice(-100)
            persist()
            await move(bot, target, false, () => retreatReason(gear(bot)) || !daylight(bot))
            const interrupted = retreatReason(gear(bot))
            if (interrupted) beginReturn(bot, interrupted)
            return true
          }
        }
      }
    }
    if (nearBase(bot, base)) {
      state.lastRoute = state.route
      state.route = []
      state.nextAfter = Date.now() + 90000
      update(state.village ? 'mapped' : 'awaiting-resupply', state.reason)
      api.log('expedition returned to supply base', { position: bot.entity.position, waypoints: state.lastRoute.length,
        reason: state.reason, health: bot.health, food: api.foodReserve() })
      return true
    }
    if (api.foodReserve() && bot.food < 16) await api.eat()
    if (!api.safe(bot)) return true
    state.returnIndex = Math.min(Number.isSafeInteger(state.returnIndex) ? state.returnIndex : state.route.length - 1, state.route.length - 1)
    while (state.returnIndex >= 0 && bot.entity.position.distanceTo(vector(state.route[state.returnIndex])) <= 4) state.returnIndex--
    const next = state.returnIndex >= 0 ? vector(state.route[state.returnIndex]) : base.offset(0, 0, 2)
    const before = bot.entity.position.distanceTo(next)
    const reached = await move(bot, next, true)
    if (reached || (state.returnIndex >= 0 && api.safe(bot) && bot.entity.position.distanceTo(next) >= before - 0.75)) state.returnIndex--
    persist()
    return true
  }

  async function prepare(bot, base, services) {
    if (!sameBase(base)) {
      state = { phase: 'preparing', room: null, spawn: null, reason: null, route: [], lastRoute: [], landmarks: [],
        visited: [], base: pos(base), village: null, returnIndex: 0, steps: 0, nextAfter: 0 }
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
      await shelter.leave(bot, vector(state.room))
      await api.regear()
      update('awaiting-resupply', needs)
      return needs
    }
    if (ready.torches < 16) { await shelter.leave(bot, vector(state.room)); return 'torches-low' }
    if (ready.food < 8 || ready.hunger < 16) { await shelter.leave(bot, vector(state.room)); return 'food-low' }
    if (state.village || !daylight(bot) || ready.health < 16 || Date.now() < state.nextAfter) {
      await shelter.enter(bot, vector(state.room))
      update(state.village ? 'mapped' : 'awaiting-resupply', state.village ? 'village-found' : !daylight(bot) ? 'wait-for-daylight' : 'resting')
      return state.phase
    }
    if (!await shelter.leave(bot, vector(state.room))) return 'shelter-doorway'
    state.steps = 0
    state.route = [pos(bot.entity.position)]
    update('searching', 'village-search')
    api.log('expedition departed', { position: bot.entity.position, ...ready })
    await continueTrip(bot, base)
    return state.phase
  }

  const owns = position => {
    if (!state.room || !position) return false
    const layout = shelterGeometry(vector(state.room))
    return [...layout.shell, ...layout.lights, layout.door, layout.door.offset(0, 1, 0), layout.foot, layout.head]
      .some(target => target.equals(position))
  }

  return { active, continueTrip, prepare, owns, inside: bot => Boolean(state.room && shelter.within(bot, vector(state.room))),
    buildingShelter: () => Boolean(state.room && state.phase === 'preparing' &&
      !['shelter-materials', 'shelter-needs-torches', 'shelter-acquiring-bed'].includes(state.reason)),
    leave: bot => state.room ? shelter.leave(bot, vector(state.room)) : true,
    status: () => ({ phase: state.phase, reason: state.reason, room: state.room, spawn: state.spawn,
      village: state.village, landmarks: state.landmarks, route: state.route, lastRoute: state.lastRoute }) }
}

module.exports = { createVillageExpedition, expeditionReadiness, retreatReason }
