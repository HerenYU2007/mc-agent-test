const assert = require('node:assert/strict')
const test = require('node:test')
const { Vec3 } = require('vec3')
const createNavigation = require('../agent/navigation')

test('observer uses the remaining executor route at bends and overlapping heights', () => {
  const activePath = [
    { x: 4.5, y: 63, z: 5.5, cost: 1 },
    { x: 5.5, y: 63, z: 5.5, cost: 1 },
    { x: 5.5, y: 64, z: 6.5, cost: 2 },
    { x: 4.5, y: 64, z: 5.5, cost: 2 },
  ]
  const state = {
    activePath,
    bot: { entity: { position: new Vec3(4.5, 63, 5.5) }, pathfinder: { isMoving: () => true } },
    navigationState: { waypoints: activePath, target: { x: 4, y: 64, z: 5 } },
  }
  const navigation = createNavigation(state, { waterOwnsMovement: () => false })
  assert.deepEqual(navigation.visibleNavigationState().waypoints.map(p => p.y), [63, 63, 64, 64])
  activePath.splice(0, 2)
  state.bot.entity.position = new Vec3(5.5, 63.25, 5.6)
  assert.deepEqual(navigation.visibleNavigationState().waypoints, [
    { x: 5.5, y: 64, z: 6.5 }, { x: 4.5, y: 64, z: 5.5 },
  ])
  navigation.clearNavigation('path-stopped')
  assert.deepEqual(navigation.visibleNavigationState().waypoints, [])
})
