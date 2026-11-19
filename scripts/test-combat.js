const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { meleeExchange } = require('../agent/combat')
const createCombatInterruption = require('../agent/combat-interruption')

const exchange = { shield: true, inReach: true, ready: true, guarding: 300,
  recentBlock: false, incoming: true, recover: false, defensive: false, firstStrike: true }
assert.equal(meleeExchange(exchange), 'guard')
assert.equal(meleeExchange({ ...exchange, recentBlock: true }), 'strike')
assert.equal(meleeExchange({ ...exchange, recentBlock: true, ready: false }), 'guard')
assert.equal(meleeExchange({ ...exchange, recentBlock: true, inReach: false }), 'guard')
assert.equal(meleeExchange({ ...exchange, incoming: false, guarding: 610 }), 'strike')
assert.equal(meleeExchange({ ...exchange, shield: false }), 'strike')

async function testInterruption() {
  const original = { isEnd: () => false }
  const connection = Object.assign(new EventEmitter(), { game: { dimension: 'overworld' },
    entity: { position: new Vec3(0, 64, 0) }, health: 20, pathfinder: { goal: original },
    inventory: { items: () => [{ name: 'iron_pickaxe' }] } })
  const state = { bot: connection, impactGuards: new WeakSet(), navigationState: { target: { x: 30, z: 4 }, label: 'explore' } }
  const calls = []
  const features = { log() {}, closeCombatPlan: () => null,
    gotoWithTimeout: async goal => { calls.push(goal) } }
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
  state.mineMode = false
  state.committedMineTarget = null
  assert.equal(await actions.resumeCombatTask(), true)
  assert.equal(state.mineMode, true)
  assert.equal(state.currentMineOrder, order)
  assert.equal(state.committedMineTarget, target)
  actions.pauseCombatTask(connection)
  connection.emit('death')
  assert.equal(await actions.resumeCombatTask(), false)
}

testInterruption().then(() => console.log('通过：格挡反击时序、原路点与采矿目标恢复、死亡清除战前任务。'))
  .catch(error => { console.error(error); process.exitCode = 1 })
