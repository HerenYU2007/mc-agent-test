const { WATER_BLOCK_NAMES } = require('./config')

const MIN_FALL_DISTANCE = 5
const LOOKAHEAD_TICKS = 14
const REACH = 4.45
const OPEN = new Set(['air', 'cave_air', 'void_air'])

function findLanding(bot) {
  let position = bot.entity.position.clone()
  const velocity = bot.entity.velocity.clone()
  for (let tick = 1; tick <= LOOKAHEAD_TICKS; tick++) {
    const next = position.plus(velocity)
    for (let y = Math.ceil(position.y) - 1; y >= Math.floor(next.y) - 1; y--) {
      const column = next.floored()
      column.y = y
      const block = bot.blockAt(column)
      if (!block || WATER_BLOCK_NAMES.has(block.name) || /lava|powder_snow|cobweb/.test(block.name)) return null
      if (!block.shapes.length) continue
      const fullTop = block.shapes.some(([x1, , z1, x2, y2, z2]) =>
        x1 === 0 && z1 === 0 && x2 === 1 && y2 === 1 && z2 === 1)
      if (y + 1 > position.y || y + 1 < next.y) continue
      const above = bot.blockAt(column.offset(0, 1, 0))
      if (!fullTop || !OPEN.has(above?.name) || /slime_block|honey_block/.test(block.name)) return null
      const inset = (coordinate, start) => Math.max(0.14, Math.min(0.86, coordinate - start))
      const point = column.offset(inset(next.x, column.x), 1, inset(next.z, column.z))
      return { block, point, water: above.position }
    }
    position = next
    velocity.x *= 0.91
    velocity.z *= 0.91
    velocity.y = (velocity.y - 0.08) * 0.98
  }
  return null
}

function createWaterClutch(runtimeState, features) {
  const active = new WeakSet()

  function trackWaterClutch(bot) {
    let fall
    let tick = 0
    const reset = () => {
      fall = null
      active.delete(bot)
    }
    const canUse = () => runtimeState.botEnabled && runtimeState.bot === bot && bot.entity && bot.health > 0 &&
      bot.game.gameMode === 'survival' && !bot.game.dimension.includes('nether')
    const offhandFilled = () => bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === 'water_bucket'

    async function intervene(current, bucket) {
      current.busy = true
      try {
        if (!active.has(bot)) {
          active.add(bot)
          features.stopPathfinder()
          bot.pvp?.stop()
          if (bot.targetDigBlock) bot.stopDigging()
          bot.clearControlStates()
        }
        if (!offhandFilled() && bot.heldItem?.name !== 'water_bucket') await bot.equip(bucket, 'hand')
        if (fall !== current || !canUse() || bot.entity.onGround || bot.entity.isInWater) return
        const landing = findLanding(bot)
        if (!landing || current.peak - landing.point.y < MIN_FALL_DISTANCE) return
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        if (eye.distanceTo(landing.point) > REACH) return
        const hit = bot.world.raycast(eye, landing.point.minus(eye).normalize(), REACH)
        if (!hit?.position.equals(landing.block.position) || hit.face !== 1) return
        await bot.lookAt(landing.point, true)
        if (fall !== current || !canUse() || bot.entity.onGround || bot.entity.isInWater) return
        const offhand = offhandFilled()
        if (!offhand && bot.heldItem?.name !== 'water_bucket') return
        current.attempts++
        current.lastAttempt = tick
        current.water = landing.water
        current.height = Number((current.peak - landing.point.y).toFixed(2))
        bot.activateItem(offhand)
        features.log('water clutch attempted', { position: current.water, fallHeight: current.height,
          footingDistance: Number((bot.entity.position.y - landing.point.y).toFixed(2)), attempt: current.attempts })
      } catch (error) {
        features.log('water clutch interrupted', { message: error.message })
        reset()
      } finally {
        current.busy = false
      }
    }

    bot.on('physicsTick', () => {
      tick++
      if (!canUse()) return reset()
      if (fall?.water && !fall.placed && bot.blockAt(fall.water)?.name === 'water') {
        fall.placed = true
        features.log('water clutch placed', { position: fall.water, fallHeight: fall.height })
      }
      const { position, velocity, onGround, isInWater } = bot.entity
      if (onGround || isInWater) {
        if (fall?.placed) features.log('water clutch landed', { position, fallHeight: fall.height, health: bot.health })
        return reset()
      }
      fall ??= { peak: position.y, attempts: 0, lastAttempt: -Infinity }
      fall.peak = Math.max(fall.peak, position.y)
      if (velocity.y >= -0.35 || fall.busy || fall.placed || fall.attempts >= 2 || tick - fall.lastAttempt < 3) return
      const bucket = bot.heldItem?.name === 'water_bucket' ? bot.heldItem :
        bot.inventory.items().find(item => item.name === 'water_bucket')
      if (!bucket && !offhandFilled()) return
      const landing = findLanding(bot)
      if (landing && fall.peak - landing.point.y >= MIN_FALL_DISTANCE) void intervene(fall, bucket)
      else if (!fall.attempts) active.delete(bot)
    })
    bot.on('forcedMove', reset)
    bot.on('death', reset)
    bot.once('end', reset)
  }

  return { trackWaterClutch, isWaterClutchActive: (bot = runtimeState.bot) => active.has(bot) }
}

module.exports = createWaterClutch
