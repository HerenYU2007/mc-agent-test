const assert = require('node:assert/strict')
const test = require('node:test')
const { Vec3 } = require('vec3')
const createSmelting = require('../agent/smelting')

function fixture() {
  const position = new Vec3(-6, 45, -1)
  const bot = {
    game: { dimension: 'overworld' },
    entity: { position: new Vec3(-5.5, 43, -2.5), eyeHeight: 1.62 },
    world: { raycast: () => null },
    blockAt: () => ({ name: 'air', position }),
  }
  const records = []
  const features = {
    canWorkHere: () => true,
    findNearestHostile: () => null,
    log: message => records.push(message),
    persistExperience: () => {},
    pickUpBlockDrop: async () => false,
  }
  const runtime = { bot, cycle: 1 }
  const furnace = { broken: true, position, dimension: bot.game.dimension, countBefore: 0 }
  return { position, bot, records, features, runtime, furnace, smelting: createSmelting(runtime, features) }
}

test('an unreachable empty furnace drop stops blocking survival after bounded retries', async () => {
  const { records, runtime, furnace, smelting } = fixture()
  runtime.temporaryFurnace = furnace
  assert.equal(await smelting.finishFurnaceWork(runtime.bot), false)
  assert.equal(runtime.temporaryFurnace, furnace)
  assert.equal(furnace.pickupFailures, 1)
  assert.equal(await smelting.finishFurnaceWork(runtime.bot), true)
  assert.equal(runtime.temporaryFurnace, null)
  assert(records.includes('empty furnace drop unreachable; resuming survival'))
  assert(!records.includes('temporary furnace reclaimed'))
})

test('an empty workshop station can still be recovered on its second attempt', async () => {
  const { records, features, runtime, furnace, smelting } = fixture()
  runtime.pendingIronWorkshop = { dimension: furnace.dimension, stations: [furnace], collected: 2 }
  assert.equal(await smelting.recoverIronWorkshop(runtime.bot), false)
  features.pickUpBlockDrop = async () => true
  assert.equal(await smelting.recoverIronWorkshop(runtime.bot), true)
  assert.equal(runtime.pendingIronWorkshop, null)
  assert(records.includes('temporary furnace reclaimed'))
  assert(!records.includes('empty furnace drop unreachable; resuming survival'))
})

test('an inaccessible furnace with contents remains pending and is never marked as an empty drop', async () => {
  const { position, bot, features, runtime, furnace, smelting } = fixture()
  bot.blockAt = () => ({ name: 'furnace', position })
  const station = { ...furnace, broken: false, loaded: true }
  runtime.pendingIronWorkshop = { dimension: station.dimension, stations: [station], collected: 0 }
  features.pickUpBlockDrop = async () => assert.fail('must not attempt recovery of an unbroken station drop')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal(await smelting.recoverIronWorkshop(bot), false)
  }
  assert.deepEqual(runtime.pendingIronWorkshop.stations, [station])
  assert.equal(station.pickupFailures, undefined)
})
