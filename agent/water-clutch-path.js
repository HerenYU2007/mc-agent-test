const Move = require('mineflayer-pathfinder/lib/move')
const { Vec3 } = require('vec3')
const { WATER_BLOCK_NAMES } = require('./config')
const { bucketAvailable, supportsClutch, MIN_FALL_DISTANCE, OPEN } = require('./water-clutch')

const MAX_CLUTCH_DROP = 50
const SEARCH_BUDGET = 50

function clutchTimeBudget(height) {
  return Math.max(2500, 2250 + height * 25)
}

function dropColumnLanding(bot, column) {
  for (let level = 1; level >= -MAX_CLUTCH_DROP - 1; level--) {
    const block = bot.blockAt(column.offset(0, level, 0))
    if (OPEN.has(block?.name)) continue
    const height = -level - 1
    return height >= MIN_FALL_DISTANCE && supportsClutch(block) ? column.offset(0, level + 1, 0) : null
  }
  return null
}

function findClutchDrop(bot, edge, direction) {
  const { x: dx, z: dz } = direction
  const first = edge.offset(dx, 0, dz)
  if (!OPEN.has(bot.blockAt(first.offset(0, -1, 0))?.name) ||
      !supportsClutch(bot.blockAt(edge.offset(0, -1, 0)))) return null
  const landing = dropColumnLanding(bot, first)
  if (!landing) return null
  // The second column allows for momentum after the Bot walks off the edge.
  const alternateLanding = dropColumnLanding(bot, first.offset(dx, 0, dz))
  if (!alternateLanding || Math.abs(landing.y - alternateLanding.y) > 1) return null
  const height = edge.y - Math.min(landing.y, alternateLanding.y)
  return { edge, direction, height, landing, alternateLanding }
}

function planClutchStep(bot, goal, movements) {
  if (!movements || !bot.entity.onGround || bot.game?.gameMode !== 'survival' ||
      bot.game.dimension.includes('nether') || !bucketAvailable(bot, 'water_bucket')) return null
  // Search against a separate Movements instance so ordinary pathfinder goals
  // can never execute a clutch edge as an unprotected drop.
  const search = Object.create(movements)
  search.entityIntersections = {}
  search.getMoveDropDown = function (node, direction, neighbors) {
    const previous = neighbors.length
    movements.getMoveDropDown.call(this, node, direction, neighbors)
    if (neighbors.length !== previous) return
    const step = findClutchDrop(bot, new Vec3(node.x, node.y, node.z), direction)
    if (!step) return
    const { x, y, z } = step.landing
    if ([step.landing, step.alternateLanding].some(position =>
      this.exclusionStep(bot.blockAt(position)) >= 100 || this.getNumEntitiesAt(position, 0, 0, 0) > 0)) return
    const move = new Move(x, y, z, node.remainingBlocks, 3 + step.height * 0.65)
    move.clutch = step
    neighbors.push(move)
  }
  const results = bot.pathfinder.getPathFromTo(search, bot.entity.position, goal,
    { optimizePath: false, timeout: SEARCH_BUDGET, tickTimeout: SEARCH_BUDGET })
  const { value: { result } } = results.next()
  if (result.status !== 'success') return null
  return result.path.find(move => move.clutch)?.clutch ?? null
}

async function executeClutchStep(bot, step, { canStart, recoveredAt }, deadline) {
  const offhand = () => bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'water_bucket'
  const ready = () => {
    if (!canStart() || !bot.entity.onGround || !bot.entity.position.floored().equals(step.edge)) return false
    const current = findClutchDrop(bot, step.edge, step.direction)
    return current?.landing.equals(step.landing) && current.alternateLanding.equals(step.alternateLanding)
  }
  // Pathfinder can finish the approach while the Bot is still descending onto the edge block.
  for (let ticks = 0; ticks < 6 && !bot.entity.onGround; ticks++) {
    if (!canStart() || !bot.entity.position.floored().equals(step.edge) ||
        deadline - Date.now() < clutchTimeBudget(step.height)) return false
    await bot.waitForTicks(1)
  }
  if (!ready()) return false
  if (!offhand() && bot.heldItem?.name !== 'water_bucket') {
    const bucket = bot.inventory.items().find(item => item.name === 'water_bucket')
    if (!bucket) return false
    await bot.equip(bucket, 'hand')
  }
  const { x: dx, z: dz } = step.direction
  const aim = step.edge.offset(0.5 + dx * 1.75, bot.entity.eyeHeight, 0.5 + dz * 1.75)
  await bot.lookAt(aim, true)
  if (!ready() || (!offhand() && bot.heldItem?.name !== 'water_bucket') || deadline - Date.now() < clutchTimeBudget(step.height)) return false

  const priorRecovery = recoveredAt()
  const health = bot.health
  let falling = false
  bot.setControlState('sprint', false)
  bot.setControlState('jump', false)
  bot.setControlState('forward', true)
  try {
    for (let ticks = 0; ticks < 14 && Date.now() < deadline; ticks++) {
      await bot.waitForTicks(1)
      falling = !bot.entity.onGround && bot.entity.velocity.y < -0.06
      if (falling || !canStart()) break
    }
  } finally {
    bot.setControlState('forward', false)
  }
  if (!falling) return false

  const landings = [step.landing, step.alternateLanding]
  for (let ticks = 0; ticks < 80 && bot.health > 0 && Date.now() < deadline; ticks++) {
    await bot.waitForTicks(1)
    const recovered = recoveredAt()
    if (recovered && recovered !== priorRecovery) {
      if (bot.health < health || !landings.some(position => recovered.equals(position))) break
      // A neighboring waypoint can stay flooded for a few ticks after pickup.
      if (bot.entity.onGround && landings.every(position => !WATER_BLOCK_NAMES.has(bot.blockAt(position)?.name))) return true
    }
    if (bot.entity.onGround && bot.health < health) break
  }
  throw new Error('water clutch landing and recovery could not be confirmed')
}

module.exports = { planClutchStep, executeClutchStep, clutchTimeBudget }
