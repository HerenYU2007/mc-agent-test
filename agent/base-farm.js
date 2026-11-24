const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const UP = new Vec3(0, 1, 0)
const TOP = new Vec3(0.5, 1, 0.5)
const SOIL = /^(dirt|grass_block|farmland)$/
const CLEAR = /^(air|cave_air|short_grass|fern)$/
const HARVEST = new Set(['wheat', 'wheat_seeds'])
const FARM_LABELS = Object.freeze({
  'farm-water': '给基地农田引水',
  'farm-plant': '在基地播种小麦',
  'farm-harvest': '收割并补种基地小麦',
})
const CENTER_OFFSETS = []
for (let x = -11; x <= 11; x++) {
  for (let z = -11; z <= 11; z++) {
    if (Math.hypot(x, z) >= 5 && Math.hypot(x, z) <= 11) CENTER_OFFSETS.push([x, z])
  }
}
CENTER_OFFSETS.sort(([x, z], [a, b]) => Math.hypot(x, z) - Math.hypot(a, b))

function farmPlots(center) {
  const plots = []
  for (let x = -1; x <= 1; x++) {
    for (let z = -1; z <= 1; z++) if (x || z) plots.push(center.offset(x, 0, z))
  }
  return plots
}

function farmTask(soil, crop, canPlant) {
  if (crop?.name === 'wheat' && Number(crop.getProperties().age) === 7) return 'harvest'
  if (canPlant && SOIL.test(soil?.name) && CLEAR.test(crop?.name)) return 'plant'
  return null
}

function createBaseFarm(api) {
  let nextWaterAttempt = 0
  let retryAt = 0
  const deferredPlots = new Map()
  const item = (bot, match) => bot.inventory.items().find(entry => match.test(entry.name))
  const count = (bot, names) => bot.inventory.items().reduce((n, entry) => n + (names.has(entry.name) ? entry.count : 0), 0)
  const source = block => block?.name === 'water' && Number(block.getProperties().level) === 0
  const bounded = (a, b, range) => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z)) <= range
  const above = position => position.plus(UP)

  function site(bot, base, reserved) {
    for (const [x, z] of CENTER_OFFSETS) {
      for (const y of [-1, -2, 0, -3, 1]) {
        const center = base.offset(x, y, z)
        const suitable = position => SOIL.test(bot.blockAt(position)?.name) && !reserved(position) && !reserved(above(position)) &&
          CLEAR.test(bot.blockAt(above(position))?.name) && (bot.blockAt(above(position))?.skyLight ?? 0) >= 12
        if ([center, ...farmPlots(center)].every(suitable) &&
            bot.blockAt(center.minus(UP))?.boundingBox === 'block') return center
      }
    }
    return null
  }

  function waterSources(bot, center, maxDistance) {
    return bot.findBlocks({ point: center, maxDistance, count: 24, matching: source })
  }

  const irrigated = (bot, center) => source(bot.blockAt(center)) ||
    waterSources(bot, center, 5).some(water => bounded(water, center, 3) && water.y >= center.y && water.y <= center.y + 1)
  const canPlant = bot => Boolean(item(bot, /^wheat_seeds$/))
  const available = position => (deferredPlots.get(position.toString()) ?? 0) <= Date.now()

  function hasWork(bot, center) {
    if (Date.now() < retryAt || !api.safe(bot)) return false
    const seeds = canPlant(bot)
    if (!center) return seeds
    return farmPlots(center).some(position => available(position) && farmTask(bot.blockAt(position), bot.blockAt(above(position)), seeds)) ||
      (seeds && Date.now() >= nextWaterAttempt && !irrigated(bot, center))
  }

  async function approach(bot, position) {
    const accessible = feet => {
      const block = bot.blockAt(position)
      if (!block) return false
      const eye = feet.offset(0, bot.entity.eyeHeight || 1.62, 0)
      const target = position.offset(0.5, block.shapes.length ? Math.max(...block.shapes.map(shape => shape[4])) - 0.01 : 0.4, 0.5)
      const ray = target.minus(eye)
      const distance = ray.norm()
      if (distance > 4.1) return false
      const hit = bot.world.raycast(eye,ray.normalize(),distance+0.01)
      return hit ? hit.position.equals(position) : !block.shapes.length
    }
    if (!accessible(bot.entity.position)) {
      const goal = new goals.GoalNear(position.x,position.y+1,position.z,3)
      const within = goal.isEnd.bind(goal)
      goal.isEnd = p => within(p) && accessible(new Vec3(p.x+0.5,p.y,p.z+0.5))
      await api.travel(bot, goal, 'base farm plot', 6000).catch(() => {})
    }
    return api.safe(bot) && accessible(bot.entity.position)
  }

  async function irrigate(bot, center, table) {
    if (Date.now() < nextWaterAttempt) return false
    nextWaterAttempt = Date.now() + 60000
    api.showAction?.('farm-water')
    let filled = item(bot, /^water_bucket$/)
    if (!filled) {
      const streams = waterSources(bot, center, 40).filter(water => !water.equals(center))
      if (streams.length && !item(bot, /^bucket$/) && table) await api.craft('bucket', table)
      const bucket = item(bot, /^bucket$/)
      if (bucket) {
        for (const water of streams.slice(0, 3)) {
          if (!api.safe(bot)) return false
          await api.travel(bot, new goals.GoalNear(water.x, water.y, water.z, 3), 'fetch farm water', 9500).catch(() => {})
          if (!api.safe(bot) || bot.entity.position.distanceTo(water) > 4) continue
          await bot.equip(bucket, 'hand')
          await bot.lookAt(water.offset(0.5, 0.65, 0.5), true)
          bot.activateItem()
          await bot.waitForTicks(5)
          filled = item(bot, /^water_bucket$/)
          if (filled) { api.log('base farm collected water', { position: water }); break }
        }
      }
    }
    if (!filled || !api.safe(bot)) return false
    const top = bot.blockAt(above(center))
    if (!CLEAR.test(top?.name)) return false
    const bottom = center.minus(UP)
    const cover = bot.blockAt(center)
    if (SOIL.test(cover?.name) && await approach(bot, center) && bot.canDigBlock(cover)) {
      await api.equipTool?.(cover)
      if (!api.safe(bot)) return false
      await bot.dig(cover, true)
      await bot.waitForTicks(2)
    }
    if (bot.blockAt(center)?.boundingBox !== 'empty') return false
    if (!await approach(bot,bottom) || !api.safe(bot)) return false
    await bot.equip(filled, 'hand')
    await bot.lookAt(center.offset(0.5, -0.015, 0.5), true)
    if (!api.safe(bot) || !bot.blockAtCursor(4.5)?.position.equals(bottom)) return false
    bot.activateItem()
    await bot.waitForTicks(5)
    if (!source(bot.blockAt(center))) return false
    api.log('base farm irrigated', { position: center })
    return true
  }

  async function plant(bot, position, table) {
    const crop = bot.blockAt(above(position))
    if (!CLEAR.test(crop?.name)) return false
    const seeds = item(bot, /^wheat_seeds$/)
    if (!seeds) return false
    if (/short_grass|fern/.test(crop.name)) {
      if (!await approach(bot, crop.position) || !bot.canDigBlock(crop)) return false
      await bot.dig(crop, true)
    }
    if (!await approach(bot, position)) return false
    let soil = bot.blockAt(position)
    if (!SOIL.test(soil?.name) || !api.safe(bot)) return false
    if (soil.name !== 'farmland') {
      if (!item(bot, /_hoe$/) && table) await api.craft('stone_hoe', table)
      const hoe = item(bot, /_hoe$/)
      if (!hoe) return false
      await bot.equip(hoe, 'hand')
      if (!api.safe(bot)) return false
      await bot.activateBlock(soil, UP, TOP)
      await bot.waitForTicks(3)
      soil = bot.blockAt(position)
    }
    if (soil?.name !== 'farmland' || !api.safe(bot)) return false
    await bot.equip(seeds, 'hand')
    await bot.activateBlock(soil, UP, TOP)
    await bot.waitForTicks(3)
    if (bot.blockAt(above(position))?.name !== 'wheat') return false
    api.log('base farm planted', { position: above(position) })
    return true
  }

  async function harvest(bot, position, table) {
    const target = above(position)
    if (!await approach(bot, target)) return false
    const ripe = bot.blockAt(target)
    if (farmTask(null, ripe, false) !== 'harvest' || !bot.canDigBlock(ripe)) return false
    const before = count(bot, HARVEST)
    await bot.dig(ripe, true)
    if (bot.blockAt(target)?.name === 'wheat') return false
    if (api.safe(bot)) await api.pickup(HARVEST, target, before)
    api.log('base farm harvested', { position: target, pickup: count(bot, HARVEST) > before })
    if (api.safe(bot) && item(bot, /^wheat_seeds$/)) await plant(bot, position, table)
    return true
  }

  async function run(bot, base, center, table, reserved, save) {
    if (Date.now() < retryAt || !api.safe(bot)) return false
    try {
      const seeds = item(bot, /^wheat_seeds$/)
      if (!center && seeds) {
        center = site(bot, base, reserved)
        if (center) { save(center); api.log('base farm site selected', { position: center }) }
      }
      if (!center || !bot.blockAt(center)) return false
      if ((seeds || farmPlots(center).some(p=>bot.blockAt(above(p))?.name==='wheat')) && !irrigated(bot, center)) {
        if (await irrigate(bot, center, table)) return true
        if (bot.entity.position.distanceTo(base) > 12) {
          api.log('base farm returning from water search', { position: bot.entity.position })
          return true
        }
      }
      const tasks = farmPlots(center).filter(available).map(position => ({
        position, task: farmTask(bot.blockAt(position), bot.blockAt(above(position)), Boolean(seeds)),
      })).filter(entry => entry.task)
      tasks.sort((a, b) => (a.task === 'plant') - (b.task === 'plant') ||
        a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
      for (const next of tasks.slice(0, 2)) {
        if (!api.safe(bot)) return false
        api.showAction?.(`farm-${next.task}`)
        const progressed = next.task === 'harvest' ? await harvest(bot, next.position, table) : await plant(bot, next.position, table)
        if (progressed) return true
        deferredPlots.set(next.position.toString(), Date.now() + 45000)
        api.log('base farm plot deferred', { action: next.task, position: next.position })
      }
      return false
    } catch (error) {
      api.log('base farm interrupted', { message: error.message })
    }
    retryAt = Date.now() + 25000
    return false
  }

  return { run, hasWork, irrigated, owns: (center, position) => Boolean(center && bounded(center, position, 1) &&
    position.y >= center.y - 1 && position.y <= center.y + 1) }
}

module.exports = { createBaseFarm, farmPlots, farmTask, FARM_LABELS }
