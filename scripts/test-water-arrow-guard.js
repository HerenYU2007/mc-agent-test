const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { setTimeout: delay, setImmediate: flush } = require('node:timers/promises')
const { Vec3 } = require('vec3')
const createCombatDefence = require('../agent/combat-defence')
const createSwimming = require('../agent/swimming')

function fixture(compact = false) {
  const controls = new Map()
  const logs = []
  const events = { resumes: 0, looks: 0 }
  const inventory = Object.assign(new EventEmitter(), { slots: [{ name: 'shield' }] })
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    version: '1.21.11',
    supportFeature: name => compact && name === 'entityVelocityIsLpVec3',
    registry: { entitiesByName: {} },
    entity: { position: new Vec3(0, 0, 0), isInWater: true, eyeHeight: 1.62 },
    health: 20,
    oxygenLevel: 20,
    inventory,
    entities: {},
    world: { raycast: () => null },
    getEquipmentDestSlot: () => 0,
    activateItem(offhand) { assert.equal(offhand, true); this.usingHeldItem = true },
    deactivateItem() { this.usingHeldItem = false },
    setControlState: (key, value) => controls.set(key, value),
    look: async () => {},
    lookAt: async () => { events.looks++ },
  })
  const state = { bot, botEnabled: true, swimmingMode: true, impactGuards: new WeakSet(), raisedShields: new WeakMap(),
    swimShore: new Vec3(0, 0, 6), swimProgress: { distance: 6, at: 0 } }
  const features = {
    waterOwnsMovement: () => true,
    isActuallyInWater: () => true,
    isWaterClutchActive: () => false,
    entityNameOf: e => e.name,
    pauseCombatTask: () => assert.fail('游泳时不应打断原任务'),
    cancelCombatBow() {},
    monitorSwimming: () => { events.resumes++ },
    log: (name, data) => logs.push({ name, data }),
  }
  Object.assign(features, createCombatDefence(state, features))
  features.trackCombatImpacts(bot)
  const fire = () => {
    const arrow = { id: 10, name: 'arrow', position: new Vec3(4, 1.5, 0),
      velocity: new Vec3(-0.7 / (compact ? 8000 : 1), 0, 0) }
    bot.entities[arrow.id] = arrow
    bot.emit('entitySpawn', arrow)
    if (compact) bot._client.emit('spawn_entity', { entityId: arrow.id, velocity: new Vec3(-0.7, 0, 0) })
    bot.emit('physicsTick')
  }
  return { controls, logs, events, inventory, bot, state, features, fire }
}

test('水中来箭会举盾并保留上浮；氧气危险立即恢复游泳', async () => {
  const f = fixture(true)
  f.fire()
  await flush()
  assert(f.features.isSwimmingArrowGuardActive(f.bot))
  assert.equal(f.bot.usingHeldItem, true)
  assert.equal(f.controls.get('jump'), true)
  assert.equal(f.controls.get('forward'), false)
  assert(f.logs.some(log => log.name === 'incoming arrow guard' && log.data.swimming))

  const shore = f.state.swimShore
  createSwimming(f.state, f.features).monitorSwimming()
  assert.equal(f.events.looks, 1)
  assert.equal(f.state.swimShore, shore)
  assert(f.state.swimProgress.at > 0)

  f.bot.oxygenLevel = 6
  await delay(90)
  assert.equal(f.bot.usingHeldItem, false)
  assert.equal(f.features.isSwimmingArrowGuardActive(f.bot), false)
  assert.equal(f.events.resumes, 1)
})

test('低氧或正在落地水时，不会夺取移动控制去挡箭', async () => {
  for (const mode of ['low air', 'clutch']) {
    const f = fixture()
    if (mode === 'low air') f.bot.oxygenLevel = 6
    else f.features.isWaterClutchActive = () => true
    f.fire()
    await flush()
    assert.equal(f.events.looks, 0)
    assert.equal(f.features.isSwimmingArrowGuardActive(f.bot), false)
  }
})

test('氧气低于 12 时上浮，恢复到 18 后才恢复找岸', () => {
  const f = fixture()
  const swim = createSwimming(f.state, f.features)
  const shore = f.state.swimShore
  f.bot.oxygenLevel = 11
  swim.monitorSwimming()
  assert.equal(f.controls.get('jump'), true)
  assert.equal(f.controls.get('forward'), false)
  f.bot.oxygenLevel = 14
  swim.monitorSwimming()
  assert.equal(f.controls.get('jump'), true)
  assert.equal(f.controls.get('forward'), false)
  f.bot.oxygenLevel = 18
  swim.monitorSwimming()
  assert.equal(f.controls.get('forward'), true)
  assert.equal(f.state.swimShore, shore)
})
