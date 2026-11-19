const { goals } = require('mineflayer-pathfinder')
const { hutItem } = require('../starter-hut')

const SAND = new Set(['sand', 'red_sand'])
const WOOL = /_wool$/
const CONVERTED = { wooden_slab: '_slab', wooden_door: '_door' }

async function collectSand(bot, work, features) {
  const ids = [...SAND].map(name => bot.registry.blocksByName[name]?.id).filter(Number.isInteger)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: 64 })
  for (const position of positions) {
    if (!work.ready()) return false
    if (work.protected(position)) continue
    let block = bot.blockAt(position)
    const above = bot.blockAt(position.offset(0, 1, 0))
    if (!SAND.has(block?.name) || !above || above.shapes?.length || /water|lava/.test(above.name)) continue
    if ((!bot.canDigBlock(block) || !bot.canSeeBlock(block)) &&
        !await work.walk(new goals.GoalLookAtBlock(position, bot.world, { reach: 4 }), 11000)) continue
    block = bot.blockAt(position)
    if (!work.ready() || !SAND.has(block?.name) || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) continue
    const before = features.inventoryCount(SAND)
    work.log('starter hut sand selected', { block: block.name, position })
    if (!await features.digWithExposure(block, SAND)) continue
    if (!await features.pickUpBlockDrop(SAND, position, before)) continue
    work.log('starter hut sand collected', { position, count: features.inventoryCount(SAND) })
    return true
  }
  return false
}

async function collectWool(bot, work, features) {
  const sheep = Object.values(bot.entities).filter(entity => entity.name === 'sheep' && entity.position && entity.isValid !== false)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
  if (!sheep) return work.explore()
  const last = sheep.position.clone()
  if (!await work.walk(new goals.GoalNear(last.x, last.y, last.z, 1), 6500) || !work.ready()) return false
  const sword = bot.inventory.items().find(item => item.name.endsWith('_sword'))
  if (sword) await bot.equip(sword, 'hand')
  for (let strike = 0; strike < 5 && work.ready() && sheep.isValid && sheep.position.distanceTo(bot.entity.position) <= 3; strike++) {
    await bot.lookAt(sheep.position.offset(0, 0.6, 0), true)
    bot.attack(sheep)
    await bot.waitForTicks(13)
  }
  const names = new Set(Object.keys(bot.registry.itemsByName).filter(name => WOOL.test(name)))
  return features.pickUpBlockDrop(names, last, features.inventoryCount(names))
}

async function starterHutMaterials(bot, materials, work, features) {
  const remaining = { ...materials, torch: materials.wall_torch ?? 0 }
  const items = () => bot.inventory.items()
  for (const material of ['wooden_slab', 'wooden_door', 'bed']) {
    const count = items().filter(item => hutItem(item.name, material)).reduce((sum, item) => sum + item.count, 0)
    if (count < (materials[material] ?? 0)) {
      let name
      if (material === 'bed') {
        const wool = items().find(item => WOOL.test(item.name) && features.inventoryItemCount(item.name) >= 3)
        if (!wool) {
          await collectWool(bot, work, features)
          return null
        }
        name = wool.name.replace(/_wool$/, '_bed')
      } else {
        const needed = material === 'wooden_door' ? 6 : 3
        const wood = items().find(item => item.name.endsWith('_planks') && features.inventoryItemCount(item.name) >= needed)
        if (!wood) {
          const preferred = items().find(item => item.name.endsWith('_planks'))?.name
          if (!await features.makePlanksFor(needed, preferred)) await features.collectWoodWithPlan()
          return null
        }
        name = wood.name.replace(/_planks$/, CONVERTED[material])
      }
      const table = await features.ensureCraftingTable()
      if (table && work.ready()) await features.craftNamed(name, table)
      await features.reclaimTemporaryCraftingTable()
      return null
    }
    delete remaining[material]
  }
  delete remaining.wall_torch
  const missingGlass = (materials.glass ?? 0) - features.inventoryItemCount('glass')
  if (missingGlass > 0) {
    if (features.inventoryCount(SAND) < missingGlass) {
      work.phase('找沙制玻璃')
      if (!await collectSand(bot, work, features) && work.ready()) await work.explore()
      return null
    }
    if (!features.hasTool('pickaxe')) {
      await features.prepareStarterGear()
      return null
    }
    const planksForFuel = Math.ceil(missingGlass * 10 / 15)
    if (!items().some(item => ['coal', 'charcoal'].includes(item.name)) && features.plankCount() < planksForFuel) {
      if (!await features.makePlanksFor(planksForFuel)) await features.collectWoodWithPlan()
      return null
    }
    work.phase('熔炉烧玻璃')
    await features.processFurnaceBatch(SAND, 'starter hut glass collected', 30000,
      item => ['coal', 'charcoal'].includes(item.name) || item.name.endsWith('_planks'), missingGlass)
    return null
  }
  return remaining
}

module.exports = { starterHutMaterials }
