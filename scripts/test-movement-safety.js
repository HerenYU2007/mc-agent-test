const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { Vec3 } = require('vec3')
const { CorrectedWalkError, guardDrySteps, watchPath } = require('../agent/movement-safety')

function fixture(leaves = null) {
  const connection = new EventEmitter()
  const from = new Vec3(0, 63, 0)
  const straight = new Vec3(0, 64, 1)
  const diagonal = new Vec3(1, 64, 1)
  const movements = { getNeighbors: () => [straight, diagonal] }
  const goal = {}
  connection.entity = { position: from.offset(0.5, 0, 0.5) }
  connection.blockAt = p => p.equals(leaves ?? new Vec3(-1, 0, -1)) ?
    { name: 'birch_leaves', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }
  connection.pathfinder = { goal, setGoal(next) { this.goal = next } }
  return { connection, from, straight, diagonal, movements, goal }
}

test('rejects a diagonal rise beside low leaves and preserves a straight rise', () => {
  const { connection, from, straight, movements } = fixture(new Vec3(1, 65, 0))
  guardDrySteps(connection, movements)
  assert.deepEqual(movements.getNeighbors(from), [straight])
})

test('three corrections retire the failed edge and leave the other direction available', async () => {
  const { connection, from, straight, diagonal, movements, goal } = fixture()
  guardDrySteps(connection, movements)
  const cause = watchPath(connection, goal, async () => {
    connection.emit('path_update', { path: [straight] })
    connection.emit('forcedMove')
    connection.emit('forcedMove')
    assert.equal(connection.pathfinder.goal, goal)
    connection.emit('forcedMove')
    assert.equal(connection.pathfinder.goal, null)
  })
  await assert.rejects(cause, CorrectedWalkError)
  assert.deepEqual(movements.getNeighbors(from), [diagonal])
  assert.equal(connection.listenerCount('forcedMove'), 0)
})
