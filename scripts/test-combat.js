const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { meleeExchange, jumpAttackStep, opponentMissedSwing, hasRaisedShield } = require('../agent/combat')
const createCombatInterruption = require('../agent/combat-interruption')
const createCombatBow = require('../agent/combat-bow')
const { bowAim, clearArrowPath, retreatMotion } = createCombatBow

const exchange = { shield: true, inReach: true, ready: true, guarding: 300,
  recentBlock: false, incoming: true, recover: false, defensive: false, firstStrike: true }
assert.equal(meleeExchange(exchange), 'guard')
assert.equal(meleeExchange({ ...exchange, recentBlock: true }), 'strike')
assert.equal(meleeExchange({ ...exchange, recentBlock: true, ready: false }), 'guard')
assert.equal(meleeExchange({ ...exchange, recentBlock: true, inReach: false }), 'guard')
assert.equal(meleeExchange({ ...exchange, incoming: false, guarding: 610 }), 'strike')
assert.equal(meleeExchange({ ...exchange, shield: false }), 'strike')

const jump = { safe: true, elapsed: 320, onGround: false, rose: true, descending: false, ready: true, inReach: true }
assert.equal(jumpAttackStep(jump), 'wait')
assert.equal(jumpAttackStep({ ...jump, descending: true }), 'strike')
assert.equal(jumpAttackStep({ ...jump, descending: true, inReach: false }), 'wait')
assert.equal(jumpAttackStep({ ...jump, descending: true, safe: false }), 'cancel')
assert.equal(jumpAttackStep({ ...jump, onGround: true }), 'fallback')
assert.equal(jumpAttackStep({ ...jump, elapsed: 600, inReach: false }), 'cancel')
const missedSwing = { swingAge: 110, hurtAfterSwing: false, guardReady: true }
assert.equal(opponentMissedSwing(missedSwing), true)
assert.equal(opponentMissedSwing({ ...missedSwing, swingAge: 40 }), false)
assert.equal(opponentMissedSwing({ ...missedSwing, swingAge: 240 }), false)
assert.equal(opponentMissedSwing({ ...missedSwing, hurtAfterSwing: true }), false)
const sword = { name: 'iron_sword' }
const shield = { name: 'shield' }
assert.equal(hasRaisedShield(0, [sword, shield]), false)
assert.equal(hasRaisedShield(3, [sword, shield]), true)
assert.equal(hasRaisedShield(1, [shield, sword]), true)
assert.equal(hasRaisedShield(1, [sword, shield]), false)

const arrowOrigin = new Vec3(0, 65.5, 0)
const arrowTarget = new Vec3(16, 65.5, 0)
const straight = bowAim(arrowOrigin, arrowTarget)
const leading = bowAim(arrowOrigin, arrowTarget, new Vec3(0, 0, 0.24))
assert.ok(straight.ticks > 5 && straight.ticks < 6)
assert.ok(straight.velocity.y > 0)
assert.ok(leading.velocity.z > 0.2)
assert.equal(clearArrowPath({ raycast: () => null }, arrowOrigin, straight), true)
assert.equal(clearArrowPath({ raycast: start => start.x > 5 ? {} : null }, arrowOrigin, straight), false)

const trail = offsets => offsets.map(([x, z], index) => ({ at: index * 100, position: new Vec3(x, 65.5, z) }))
const lateralMotion = retreatMotion(arrowOrigin, trail([[16, 0], [15.5, 0.4], [15, 0.9]]))
assert.equal(lateralMotion.reversing, false)
assert.ok(lateralMotion.velocity.x < 0 && lateralMotion.velocity.z > 0.2)
const turned = retreatMotion(arrowOrigin, trail([[16, 0], [15.5, 0.4], [15, -0.1]]))
assert.equal(turned.reversing, true)
assert.ok(turned.velocity.z < 0)
assert.equal(retreatMotion(arrowOrigin, trail([[16, 0], [15, 0.4]])).velocity.norm(), 0)

const rangedBot = {
  entity: { position: arrowOrigin, onGround: true },
  inventory: { items: () => [{ name: 'bow' }, { name: 'arrow' }], slots: [] },
  health: 8, food: 20, getEquipmentDestSlot: () => 45,
}
const retreat = { bot: rangedBot, botEnabled: true, fleeingActive: true, impactGuards: new WeakSet() }
let flanked = false
const { canUseCombatBow } = createCombatBow(retreat, {
  hostileSight: () => ({ visible: true }), toolDurability: () => 300,
  findNearestHostile: () => flanked ? {} : null,
})
assert.equal(canUseCombatBow(rangedBot, { position: arrowTarget }), false)
assert.equal(canUseCombatBow(rangedBot, { position: arrowTarget }, true), true)
assert.equal(canUseCombatBow(rangedBot, { position: arrowOrigin.offset(12, 0, 0) }, true), false)
assert.equal(canUseCombatBow(rangedBot, { position: arrowOrigin.offset(12, 0, 0) }, true, true), true)
assert.equal(canUseCombatBow(rangedBot, { position: arrowOrigin.offset(9, 0, 0) }, true, true), false)
flanked = true
assert.equal(canUseCombatBow(rangedBot, { position: arrowTarget }, true), false)

async function testInterruption() {
  const original = { isEnd: () => false }
  const connection = Object.assign(new EventEmitter(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0) }, health: 20, pathfinder: { goal: original },
    inventory: { items: () => [{ name: 'iron_pickaxe' }] } })
  const state = { bot: connection, impactGuards: new WeakSet(), navigationState: { target: { x: 30, z: 4 }, label: 'explore' } }
  const calls = []
  const features = { log() {}, closeCombatPlan: () => null,
    gotoWithTimeout: async goal => { calls.push(goal) },
    interruptMiningForCombat: bot => {
      assert.equal(bot, connection)
      state.mineMode = false
    } }
  const actions = createCombatInterruption(state, features)
  actions.pauseCombatTask(connection)
  connection.pathfinder.goal = { isEnd: () => false }
  actions.pauseCombatTask(connection)
  assert.equal(await actions.resumeCombatTask(), true)
  assert.deepEqual(calls, [original])
  assert.equal(await actions.resumeCombatTask(), false)
  assert.equal(state.lastCombatDecision, null)

  const order = { target: 'diamond' }
  const target = { position: new Vec3(40, -48, 10) }
  state.mineMode = true
  state.currentMineOrder = order
  state.committedMineTarget = target
  state.mineTargetNames = new Set(['diamond_ore'])
  actions.pauseCombatTask(connection)
  assert.equal(state.mineMode, false)
  state.committedMineTarget = null
  assert.equal(await actions.resumeCombatTask(), true)
  assert.equal(state.mineMode, true)
  assert.equal(state.currentMineOrder, order)
  assert.equal(state.committedMineTarget, target)
  actions.pauseCombatTask(connection)
  connection.emit('death')
  assert.equal(await actions.resumeCombatTask(), false)
}

testInterruption().then(() => console.log('通过：格挡反击、跳劈时序、弓箭弹道、战后任务恢复与死亡清除。'))
  .catch(error => { console.error(error); process.exitCode = 1 })
