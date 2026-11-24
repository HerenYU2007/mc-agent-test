const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { blockForTool } = require('./mining-speed')
const { EMPTY_BLOCK } = require('./config')
const { supportsClutch } = require('./water-clutch')

const sides = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const neighbors = [...sides, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]
const pickaxe = item => /^(diamond|netherite)_pickaxe$/.test(item.name)
const obsidian = new Set(['obsidian'])
const blockAt = (bot, p) => bot.blockAt(p, false)
const air = block => EMPTY_BLOCK.test(block?.name)
const source = (block, fluid) => block?.name === fluid && Number(block.getProperties().level) === 0
const amount = (bot, name) => bot.inventory.items().reduce((n, item) => n + (item.name === name ? item.count : 0), 0)

function lavaAround(bot, p) {
  return neighbors.some(offset => {
    const next = blockAt(bot, p.plus(offset))
    return !next || next.name === 'lava'
  })
}

function dryFooting(bot, p) {
  return air(blockAt(bot, p)) && air(blockAt(bot, p.offset(0, 1, 0))) &&
    supportsClutch(blockAt(bot, p.offset(0, -1, 0))) && !lavaAround(bot, p)
}

function aim(bot, p, from, placing) {
  const point = placing ? p.offset(0.5, -0.02, 0.5) : p.offset(0.5, 0.5, 0.5)
  const ray = point.minus(from)
  if (ray.norm() > 4.4) return null
  const hit = bot.world.raycast(from, ray.normalize(), placing ? 4.4 : ray.norm())
  if (placing) return hit?.position.equals(p.offset(0, -1, 0)) && hit.face === 1 ? point : null
  return !hit || hit.position.equals(p) ? point : null
}

function find(bot, name, maxDistance) {
  const id = bot.registry.blocksByName[name]?.id
  if (id === undefined) return []
  return bot.findBlocks({ matching: id, maxDistance, count: 64 })
}

function createHomeObsidian(api) {
  const retries = new Map()
  const safe = bot => api.safe(bot) && bot.health >= 10 && !bot.entity.isInWater
  const eye = bot => bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const now = () => Date.now()
  const waitFor = async (bot, done, ticks = 16) => {
    for (let i = 0; i < ticks && safe(bot) && !done(); i++) await bot.waitForTicks(1)
    return done()
  }

  async function approach(bot, target, placing) {
    // Stand above the new source so sideways water flow cannot cut off recovery.
    const minY = target.y + Number(placing)
    const ready = () => safe(bot) && bot.entity.onGround && bot.entity.position.y >= minY &&
      dryFooting(bot, bot.entity.position.floored()) && aim(bot, target, eye(bot), placing)
    if (ready()) return true
    const stands = []
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dy = Number(placing); dy <= 2; dy++) {
          if (!(dx || dz)) continue
          const feet = target.offset(dx, dy, dz)
          if (dryFooting(bot, feet) && aim(bot, target, feet.offset(0.5, bot.entity.eyeHeight ?? 1.62, 0.5), placing))
            stands.push(new goals.GoalBlock(feet.x, feet.y, feet.z))
        }
    if (stands.length === 0) return false
    await api.travel(bot, new goals.GoalCompositeAny(stands), '从干燥位置接近水源或岩浆', 6500,
      { allowClutch: false }).catch(() => {})
    return Boolean(ready())
  }

  async function useBucket(bot, name, target, placing, stillValid) {
    if (!safe(bot) || !stillValid()) return false
    const item = bot.inventory.items().find(stack => stack.name === name)
    const offhand = !item && bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === name
    if (!offhand && !item) return false
    if (!offhand) await bot.equip(item, 'hand')
    const point = aim(bot, target, eye(bot), placing)
    if (!point || !safe(bot) || !dryFooting(bot, bot.entity.position.floored())) return false
    await bot.lookAt(point, true)
    if (!safe(bot) || !stillValid()) return false
    bot.activateItem(Boolean(offhand))
    return true
  }

  const hasBucket = (bot, name) => amount(bot, name) > 0 ||
    bot.inventory.slots[bot.getEquipmentDestSlot('off-hand')]?.name === name

  async function fill(bot) {
    for (const p of find(bot, 'water', 48).filter(p =>
      source(blockAt(bot, p), 'water') && !api.reserved(p) && !lavaAround(bot, p)).slice(0, 4)) {
      if (!safe(bot)) return
      if (!(await approach(bot, p, false))) continue
      if (!(await useBucket(bot, 'bucket', p, false, () => source(blockAt(bot, p), 'water')))) continue
      if (await waitFor(bot, () => hasBucket(bot, 'water_bucket'))) return true
    }
    if (safe(bot)) await api.explore()
    return false
  }

  async function recover(bot, state, save) {
    const { water, lava } = state.obsidianWater
    const p = new Vec3(...water)
    const converted = new Vec3(...lava)
    if (!blockAt(bot, p)) {
      await api.travel(bot, new goals.GoalNear(p.x, p.y, p.z, 5), '返回收回造黑曜石的水', 8500,
        { allowClutch: false }).catch(() => {})
      if (!blockAt(bot, p)) return false
    }
    if (source(blockAt(bot, p), 'water')) {
      if (!(await approach(bot, p, false)) ||
          !(await useBucket(bot, 'bucket', p, false, () => source(blockAt(bot, p), 'water')))) return false
      if (!(await waitFor(bot, () => !source(blockAt(bot, p), 'water') && hasBucket(bot, 'water_bucket')))) return false
      api.log('收回造黑曜石的水源', { position: p })
    }
    if (blockAt(bot, converted)?.name === 'obsidian') {
      retries.delete(String(converted))
      api.log('用水浇成黑曜石', { position: converted })
    }
    state.obsidianWater = null
    save()
    return true
  }

  function validPour(bot, lava, water) {
    return source(blockAt(bot, lava), 'lava') && !api.reserved(lava) && !api.reserved(water) &&
      air(blockAt(bot, water)) && supportsClutch(blockAt(bot, water.offset(0, -1, 0))) &&
      sides.every(side => !api.reserved(water.plus(side)))
  }

  async function convert(bot, state, save) {
    const sources = find(bot, 'lava', 96).filter(p =>
      source(blockAt(bot, p), 'lava') && (retries.get(String(p)) || 0) < now()).slice(0, 12)
    let attempts = 0
    for (const lava of sources) {
      const pours = [0, 1].flatMap(dy => sides.map(side => lava.plus(side).offset(0, dy, 0)))
        .filter(water => validPour(bot, lava, water))
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
      retries.set(String(lava), now() + 20000)
      for (const water of pours.slice(0, 2)) {
        if (!safe(bot)) return true
        if (++attempts > 4) return false
        if (!(await approach(bot, water, true)) || !validPour(bot, lava, water)) continue
        state.obsidianWater = { water: water.toArray(), lava: lava.toArray() }
        save()
        if (await useBucket(bot, 'water_bucket', water, true, () => validPour(bot, lava, water))) {
          await waitFor(bot, () => source(blockAt(bot, water), 'water') && blockAt(bot, lava)?.name === 'obsidian', 32)
        }
        if (safe(bot)) await recover(bot, state, save)
        return true
      }
    }
    return false
  }

  async function mine(bot) {
    for (const p of find(bot, 'obsidian', 96).filter(p => !lavaAround(bot, p) && !api.reserved(p) &&
      (retries.get(String(p)) || 0) < now()).slice(0, 4)) {
      if (!safe(bot)) return true
      retries.set(String(p), now() + 15000)
      if (!(await approach(bot, p, false))) continue
      const block = blockAt(bot, p)
      if (block?.name !== 'obsidian' || lavaAround(bot, p) || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) continue
      const pick = bot.inventory.items().find(pickaxe)
      if (!pick) return false
      await bot.equip(pick, 'hand')
      if (!safe(bot) || lavaAround(bot, p) || blockAt(bot, p)?.name !== 'obsidian') return true
      const before = amount(bot, 'obsidian')
      const guard = setInterval(() => {
        if ((!safe(bot) || lavaAround(bot, p)) && bot.targetDigBlock?.position.equals(p)) bot.stopDigging()
      }, 100)
      try {
        await bot.dig(blockForTool(bot, block, bot.heldItem), true)
      } finally {
        clearInterval(guard)
      }
      if (safe(bot) && !lavaAround(bot, p)) await api.pickup(obsidian, p, before)
      return true
    }
    return false
  }

  return { fill, recover, convert, mine, hasBucket }
}

module.exports = createHomeObsidian
