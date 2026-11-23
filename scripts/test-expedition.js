const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { Vec3 } = require('vec3')
const { createVillageExpedition, expeditionReadiness, retreatReason } = require('../agent/expedition')
const { shelterGeometry } = require('../agent/expedition-shelter')
const { createVillageVisit } = require('../agent/expedition-village')
const { farmPlots, farmTask } = require('../agent/base-farm')

const root = fs.realpathSync.native(os.tmpdir())
const prefix = 'nmo-village-expedition-test-'
const work = fs.mkdtempSync(path.join(root, prefix))
const origin = new Vec3(10, 70, 20)
const point = (...coordinates) => new Vec3(...coordinates)

function setup(name, health, village = false) {
  const statePath = path.join(work, `${name}.jsonl`)
  const route = [[10, 70, 20], [20, 71, 20], [30, 70, 20], [40, 69, 20]]
  fs.writeFileSync(statePath, JSON.stringify({ version: 1, world: 'test', phase: 'searching', base: [10, 70, 20], route }))
  const bot = new EventEmitter()
  const pack = [{ name: 'iron_pickaxe' }, { name: 'diamond_sword' }, { name: 'torch', count: 16 }]
  const equipment = { head: { name: 'diamond_helmet' }, torso: { name: 'diamond_chestplate' }, legs: { name: 'diamond_leggings' },
    feet: { name: 'diamond_boots' }, 'off-hand': { name: 'shield' } }
  Object.assign(bot, { health, food: 20, game: { dimension: 'overworld' }, time: { timeOfDay: 7000 },
    inventory: { slots: equipment, items: () => pack, emptySlotCount: () => 5 }, getEquipmentDestSlot: slot => slot,
    entity: { position: point(40, 69, 20) }, pathfinder: {}, entities: {},
    blockAt: position => ({ name: position.x === 50 ? 'bell' : 'farmland' }),
    findBlocks: ({ matching }) => (village ? [point(50, 69, 20), point(51, 69, 21)] : [])
      .filter(position => matching(bot.blockAt(position))) })
  const visited = [], logs = []
  const api = { statePath, world: 'test', log: (event, data) => logs.push({ event, ...data }),
    safe: () => true, foodReserve: () => 8, durability: () => 100, eat: async () => {},
    travel: async (_bot, goal) => { visited.push([goal.x, goal.y, goal.z]); bot.entity.position = point(goal.x, goal.y, goal.z) } }
  return { bot, api, route, visited, logs }
}

async function testBlockedReturn() {
  const route = [[10, 70, 20], [20, 70, 20], [30, 70, 20], [40, 70, 20]]
  const stalled = setup('stalled-return', 20)
  const checkpoint = { version: 1, world: 'test', phase: 'returning', reason: 'nightfall',
    base: [10, 70, 20], route, returnIndex: 2 }
  fs.writeFileSync(stalled.api.statePath, JSON.stringify(checkpoint))
  const attempts = []
  stalled.api.travel = async (_, goal, label, timeout, options) => {
    assert.equal(options.returnWaypoint, true)
    attempts.push([goal.x, options.recoverStep])
    if (goal.x === 30) throw new Error('blocked step')
    stalled.bot.entity.position = point(goal.x, goal.y, goal.z)
  }
  const read = () => JSON.parse(fs.readFileSync(stalled.api.statePath, 'utf8'))
  const expedition = createVillageExpedition(stalled.api)
  await expedition.continueTrip(stalled.bot, origin)
  assert.equal(read().returnIndex, 2)
  assert.equal(read().returnRetry, 2)
  const resumed = createVillageExpedition(stalled.api)
  await resumed.continueTrip(stalled.bot, origin)
  assert.deepEqual(attempts, [[30, false], [30, true]])
  assert.equal(read().returnIndex, 1)
  assert(stalled.logs.some(log => log.event === 'expedition blocked return waypoint bypassed'))
  await resumed.continueTrip(stalled.bot, origin)
  assert.equal(resumed.status().phase, 'awaiting-resupply')
  assert.deepEqual(resumed.status().lastReturnRoute, [[40, 69, 20], [20, 70, 20], [10, 70, 20]])

  const detour = setup('return-detour', 20)
  fs.writeFileSync(detour.api.statePath, JSON.stringify(checkpoint))
  detour.api.travel = async (_, goal) => {
    assert(!goal.isEnd(point(30, 72, 20)), '另一层不能当成到达')
    detour.bot.entity.position = point(44, 70, 27)
    detour.bot.emit('move')
    throw new Error('still detouring')
  }
  const detoured = createVillageExpedition(detour.api)
  await detoured.continueTrip(detour.bot, origin)
  const pending = JSON.parse(fs.readFileSync(detour.api.statePath, 'utf8'))
  assert.equal(pending.returnRetry, null)
  assert.equal(pending.returnIndex, 2)
  assert.deepEqual(detoured.status().returnRoute.at(-1), [44, 70, 27])
}

async function testBlockedFirstStep() {
  const createBaseProgression = require('../agent/base-progression')
  const { HOST, PORT, USERNAME } = require('../agent/config')
  const registry = require('prismarine-registry')('1.21.11')
  const Block = require('prismarine-block')(registry)
  const Move = require('mineflayer-pathfinder/lib/move')
  const { bot } = setup('base-first-step', 20)
  const start = point(40, 69, 20)
  const badStep = start.offset(-1, 0, 0)
  const otherStep = start.offset(0, 0, -1)
  const world = JSON.stringify([HOST, PORT, USERNAME])
  const baseFile = path.join(work, 'base-first-step.json')
  fs.writeFileSync(baseFile, JSON.stringify({ version: 2, world, position: [10, 69, 20],
    qualificationDiamonds: 10, unlocked: true }))
  fs.writeFileSync(baseFile + '.expedition.jsonl', JSON.stringify({ version: 1, world, phase: 'returning',
    base: [10, 69, 20], returnIndex: 1, route: [[10, 69, 20], [30, 69, 20], [40, 69, 20]] }))
  bot.registry = registry
  bot.blockAt = position => {
    const data = registry.blocksByName[position.y < start.y ? 'stone' : 'air']
    const block = Block.fromStateId(data.defaultState, 0)
    block.position = position
    return block
  }
  bot.pathfinder.setGoal = goal => { bot.pathfinder.goal = goal }
  bot.pathfinder.setMovements = movements => { bot.pathfinder.movements = movements }
  const initialMovements = {}
  const state = { bot, movements: initialMovements }
  const runs = []
  const log = []
  let firstGoalCanceled = false
  const features = { canWorkHere: () => true, damageInterruptActive: () => false, closeCombatPlan: () => null,
    toolDurability: () => 100, foodReserve: () => 8, log: event => log.push(event), gotoWithTimeout: async (goal, label, ms, options) => {
      bot.pathfinder.setGoal(goal)
      if (bot.entity.position.equals(start)) {
        const neighbors = bot.pathfinder.movements.getNeighbors(new Move(start.x, start.y, start.z, 0, 0))
        runs.push({ bad: neighbors.some(step => badStep.equals(step)), alternate: neighbors.some(step => otherStep.equals(step)),
          clutch: options.allowClutch })
        if (runs.length === 1) {
          bot.emit('path_update', { path: [badStep] })
          for (let i = 0; i < 3; i++) bot.emit('forcedMove')
          firstGoalCanceled = bot.pathfinder.goal === null
          throw new Error('test server rejected the first step')
        }
      }
      bot.entity.position = point(goal.x, goal.y, goal.z)
    } }
  const previousBase = process.env.MC_BASE_STATE_PATH
  const previousExpedition = process.env.MC_EXPEDITION_STATE_PATH
  process.env.MC_BASE_STATE_PATH = baseFile
  delete process.env.MC_EXPEDITION_STATE_PATH
  try { createBaseProgression(state, features).initializeSupplyBase() }
  finally {
    if (previousBase === undefined) delete process.env.MC_BASE_STATE_PATH
    else process.env.MC_BASE_STATE_PATH = previousBase
    if (previousExpedition !== undefined) process.env.MC_EXPEDITION_STATE_PATH = previousExpedition
  }
  await state.supplyBase.run(bot)
  await state.supplyBase.run(bot)
  assert.deepEqual(runs, [{ bad: true, alternate: true, clutch: true }, { bad: false, alternate: true, clutch: false }])
  assert.equal(firstGoalCanceled, true)
  assert(log.includes('expedition return first step blocked'))
  assert.equal(bot.pathfinder.movements, initialMovements)
  assert.equal(state.supplyBase.status().expedition.phase, 'awaiting-resupply')
}

async function test() {
  await testBlockedFirstStep()
  await testBlockedReturn()
  const front = point(0, 0, 1)
  const layout = shelterGeometry({ center: origin, front, entry: origin.plus(front.scaled(3)), supports: [] })
  assert.equal(layout.cells.length, 80)
  assert.equal(layout.cells.filter(cell => cell.block === 'wooden_slab').length, 25)
  assert.equal(layout.cells.filter(cell => cell.block === 'wall_torch').length, 4)
  assert.equal(layout.cells.filter(cell => cell.block === 'glass').length, 2)
  assert(layout.cells.find(cell => cell.block === 'wooden_door').position.equals(layout.door))
  assert.equal(layout.foot.distanceTo(layout.head), 1)
  assert.equal(farmPlots(origin).length, 8)
  assert(farmPlots(origin).every(plot => plot.distanceTo(origin) <= Math.SQRT2 && !plot.equals(origin)))
  assert.equal(farmTask({ name: 'farmland' }, { name: 'wheat', getProperties: () => ({ age: 6 }) }, true), null)
  assert.equal(farmTask({ name: 'farmland' }, { name: 'wheat', getProperties: () => ({ age: 7 }) }, false), 'harvest')
  assert.equal(farmTask({ name: 'farmland' }, { name: 'air' }, true), 'plant')

  const injured = setup('injured', 11)
  assert.equal(retreatReason(expeditionReadiness(injured.bot, injured.api)), 'health-low')
  assert.equal(retreatReason({ ...expeditionReadiness(injured.bot, injured.api), health: 20, food: 1 }), 'food-low')
  assert.equal(retreatReason({ ...expeditionReadiness(injured.bot, injured.api), health: 20, armor: 3 }), 'equipment-worn')
  injured.api.safe = () => injured.visited.length === 0
  const trip = createVillageExpedition(injured.api)
  assert.equal(trip.active(injured.bot, origin), true)
  assert.equal(await trip.continueTrip(injured.bot, origin), true)
  assert.equal(trip.status().phase, 'returning')
  assert.equal(trip.status().reason, 'health-low')
  injured.api.safe = () => true
  const resumed = createVillageExpedition(injured.api)
  for (let i = 0; i < 4; i++) await resumed.continueTrip(injured.bot, origin)
  assert.deepEqual(injured.visited, [[30, 70, 20], [20, 71, 20], [10, 70, 20]])
  assert.deepEqual(resumed.status().lastRoute, injured.route)
  assert.equal(resumed.status().phase, 'awaiting-resupply')

  const scout = setup('village', 20, true)
  let decisions = 0
  scout.api.selectVillage = async () => { decisions++; return 'observe_village' }
  const expedition = createVillageExpedition(scout.api)
  await expedition.continueTrip(scout.bot, origin)
  assert.equal(expedition.status().phase, 'visiting')
  assert.equal(expedition.status().reason, 'village-found')
  assert.deepEqual(expedition.status().village, [50, 69, 20])
  assert.deepEqual(expedition.status().landmarks.map(landmark => landmark.type), ['bell', 'farmland', 'village'])
  await expedition.continueTrip(scout.bot, origin)
  assert.equal(decisions, 1)
  assert.equal(expedition.status().villageAction, 'observe_village')
  scout.bot.health = 11
  for (let i = 0; i < 4; i++) await expedition.continueTrip(scout.bot, origin)
  assert.equal(expedition.status().phase, 'awaiting-resupply')
  assert.equal(expedition.status().reason, 'health-low')
  assert.deepEqual(expedition.status().lastRoute, scout.route)

  const disconnected = setup('disconnected', 20, true)
  let online = true
  disconnected.api.safe = () => online
  disconnected.api.foodReserve = () => online ? 8 : 0
  disconnected.api.selectVillage = async () => { online = false; return null }
  const reconnectable = createVillageExpedition(disconnected.api)
  await reconnectable.continueTrip(disconnected.bot, origin)
  assert.equal(reconnectable.status().phase, 'visiting')

  const approach = setup('approach', 20, true)
  const start = point(30, 69, 20)
  approach.bot.entity.position = start
  approach.bot.blockAt = position => ({
    name: position.x === 50 ? 'bell' : position.x === 51 ? 'farmland' : position.y === 68 ? 'grass_block' : 'air',
    boundingBox: position.y === 68 ? 'block' : 'empty',
  })
  approach.api.selectScout = async (_, targets, village) => {
    assert.deepEqual(village, point(50, 69, 20))
    return targets[1]
  }
  approach.api.travel = async (_, goal) => {
    approach.visited.push([goal.x, goal.z])
    approach.bot.entity.position = point(goal.x, 69, goal.z)
  }
  const outbound = createVillageExpedition(approach.api)
  await outbound.continueTrip(approach.bot, origin)
  assert.equal(outbound.status().phase, 'searching')
  assert.deepEqual(outbound.status().route.at(-1).filter((_, index) => index !== 1), approach.visited[0])
  await outbound.continueTrip(approach.bot, origin)
  assert.equal(outbound.status().reason, 'village-found')
  assert.equal(outbound.status().phase, 'visiting')

  const resources = setup('resources', 20)
  const testBed = point(43, 69, 20)
  const blocks = new Map([[point(41, 69, 20).toString(), { name: 'wheat', getProperties: () => ({ age: 5 }) }],
    [point(42, 69, 20).toString(), { name: 'wheat', getProperties: () => ({ age: 7 }) }],
    [testBed.toString(), { name: 'red_bed', getProperties: () => ({ part: 'head', occupied: false }) }],
    [point(44, 69, 20).toString(), { name: 'white_bed', getProperties: () => ({ part: 'head', occupied: true }) }]])
  resources.bot.blockAt = position => blocks.get(position.toString())
  resources.bot.findBlocks = ({ matching }) => Array.from({ length: 4 }, (_, i) => point(41 + i, 69, 20))
    .filter(position => matching(resources.bot.blockAt(position)))
  const visit = createVillageVisit(resources.api)
  const owns = position => position.equals(testBed)
  assert.deepEqual(visit.plan(resources.bot, point(40, 69, 20), false, owns).choices, ['enter_village', 'observe_village'])
  const inside = visit.plan(resources.bot, point(40, 69, 20), true, owns)
  assert.equal(inside.crops.length, 1)
  assert.equal(inside.beds.length, 0)
  assert(inside.choices.includes('harvest_wheat'))

  console.log('通过：临时基地结构、装备整备判定、低血/缺粮触发返程、断点恢复、村庄证据与路线保留。')
}

test().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  const resolved = fs.realpathSync.native(work)
  if (resolved === work && path.dirname(resolved) === root && path.basename(resolved).startsWith(prefix)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
