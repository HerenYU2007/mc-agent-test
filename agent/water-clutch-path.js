const Move = require('mineflayer-pathfinder/lib/move')
const { Vec3 } = require('vec3')
const { bucketAvailable, supportsClutch, MIN_FALL_DISTANCE, OPEN } = require('./water-clutch')

const MAX_CLUTCH_DROP = 10
const SEARCH_BUDGET = 50

function findClutchDrop(bot, edge, direction) {
  const { x: dx, z: dz } = direction
  const first = edge.offset(dx, 0, dz)
  if (!OPEN.has(bot.blockAt(first.offset(0, -1, 0))?.name) ||
      !supportsClutch(bot.blockAt(edge.offset(0, -1, 0)))) return null
  // The second column allows for momentum after the Bot walks off the edge.
  const second = first.offset(dx, 0, dz)
  for (let level = 1; level >= -MAX_CLUTCH_DROP - 1; level--) {
    const firstBlock = bot.blockAt(first.offset(0, level, 0))
    const secondBlock = bot.blockAt(second.offset(0, level, 0))
    if (OPEN.has(firstBlock?.name) && OPEN.has(secondBlock?.name)) continue
    const height = -level - 1
    if (height < MIN_FALL_DISTANCE || !supportsClutch(firstBlock) || !supportsClutch(secondBlock)) return null
    return { edge, direction, height, landing: first.offset(0, level + 1, 0) }
  }
  return null
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
    if (this.exclusionStep(bot.blockAt(step.landing)) >= 100 ||
        this.getNumEntitiesAt(step.landing, 0, 0, 0) > 0) return
    const move = new Move(x, y, z, node.remainingBlocks, 4 + step.height)
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
  const ready = () => canStart() && bot.entity.onGround && bot.entity.position.floored().equals(step.edge) &&
    findClutchDrop(bot, step.edge, step.direction)?.landing.equals(step.landing)
  if (!ready()) return false
  if (!offhand() && bot.heldItem?.name !== 'water_bucket') {
    const bucket = bot.inventory.items().find(item => item.name === 'water_bucket')
    if (!bucket) return false
    await bot.equip(bucket, 'hand')
  }
  const { x: dx, z: dz } = step.direction
  const aim = step.edge.offset(0.5 + dx * 1.75, bot.entity.eyeHeight, 0.5 + dz * 1.75)
  await bot.lookAt(aim, true)
  if (!ready() || (!offhand() && bot.heldItem?.name !== 'water_bucket') || deadline - Date.now() < 2500) return false

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

  for (let ticks = 0; ticks < 64 && bot.health > 0 && Date.now() < deadline; ticks++) {
    await bot.waitForTicks(1)
    const recovered = recoveredAt()
    if (recovered && recovered !== priorRecovery) {
      const spareLanding = step.landing.offset(dx, 0, dz)
      return bot.health >= health && (recovered.equals(step.landing) || recovered.equals(spareLanding))
    }
    if (bot.entity.onGround && bot.health < health) break
  }
  throw new Error('water clutch landing and recovery could not be confirmed')
}

module.exports = { planClutchStep, executeClutchStep }
