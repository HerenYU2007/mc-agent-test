const { goals } = require('mineflayer-pathfinder')

const VILLAGE_ACTIONS = Object.freeze({
  enter_village: '进入村庄',
  harvest_wheat: '收集小麦',
  craft_bread: '合成面包',
  take_bed: '带走备用床',
  observe_village: '在村边观察',
  'expedition-searching': '寻找村庄',
  'expedition-returning': '沿原路返程',
})
const ACTIONS = ['enter_village', 'harvest_wheat', 'craft_bread', 'take_bed', 'observe_village']
const BED = /_bed$/
const WOOD_DOOR = /^(?!iron_).*_door$/
const BED_DIRECTION = { north: [0, 1], south: [0, -1], east: [-1, 0], west: [1, 0] }
const ripe = block => block?.name === 'wheat' && Number(block.getProperties().age) === 7
const crop = block => ripe(block) || block?.name === 'hay_block'
const bed = block => Boolean(BED.test(block?.name) && block.getProperties().part === 'head' && !block.getProperties().occupied)

function bedTarget(bot, head, position) {
  const offset = BED_DIRECTION[head.getProperties().facing]
  const foot = offset && position.offset(offset[0], 0, offset[1])
  const match = block => bed(bot.blockAt(position)) && block?.name === head.name &&
    (block.position.equals(position) || (foot && block.position.equals(foot) && block.getProperties().part === 'foot'))
  return { match, positions: foot && match(bot.blockAt(foot)) ? [position, foot] : [position] }
}

function createVillageVisit(api) {
  const deferred = new Map()
  const count = (bot, name) => bot.inventory.items().reduce((total, item) => total + (item.name === name ? item.count : 0), 0)
  const scan = (bot, anchor, matching, limit = 16) => bot.findBlocks({ maxDistance: 32, count: limit, matching })
    .filter(position => Math.hypot(position.x - anchor.x, position.z - anchor.z) <= 32 &&
      Math.abs(position.y - bot.entity.position.y) <= 9)
  const available = position => (deferred.get(position.toString()) ?? 0) < Date.now()
  const json = position => ({ x: position.x, y: position.y, z: position.z })

  function plan(bot, anchor, entered, owns) {
    const crops = scan(bot, anchor, crop).filter(available)
    const beds = scan(bot, anchor, bed).filter(position => !owns(position) && available(position))
    const supplies = { food: api.foodReserve(), wheat: count(bot, 'wheat'), hay: count(bot, 'hay_block'),
      bread: count(bot, 'bread'), bed: bot.inventory.items().some(item => BED.test(item.name)) }
    const resources = { wheat: crops.filter(position => bot.blockAt(position)?.name === 'wheat').length,
      hay: crops.filter(position => bot.blockAt(position)?.name === 'hay_block').length, spareBed: beds.length > 0 }
    const choices = ['observe_village']
    if (!entered && (crops.length || beds.length)) choices.unshift('enter_village')
    if (entered && crops.length && supplies.bread < 8 && supplies.wheat + supplies.hay * 9 < 3) choices.unshift('harvest_wheat')
    if (supplies.bread < 8 && supplies.wheat + supplies.hay * 9 >= 3) choices.unshift('craft_bread')
    if (entered && beds.length && !supplies.bed && bot.inventory.emptySlotCount() > 0) choices.unshift('take_bed')
    return { choices, supplies, resources, crops, beds, entry: [...crops, ...beds]
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0] }
  }

  async function approach(bot, candidates, signal) {
    const reach = () => candidates.find(target => {
      const block = bot.blockAt(target)
      return block && bot.canDigBlock(block) && bot.canSeeBlock(block)
    })
    const paths = candidates.map(target => new goals.GoalLookAtBlock(target, bot.world, { reach: 4 }))
    const go = () => api.travel(bot, new goals.GoalCompositeAny(paths), 'village resource approach', 6500)
    if (reach()) return reach()
    await go().catch(() => {})
    if (reach() || signal()) return reach()
    const doorway = bot.findBlocks({ point: candidates[0], maxDistance: 7, count: 12, matching: block =>
      WOOD_DOOR.test(block.name) && block.getProperties().half === 'lower' && !block.getProperties().open })
    for (const door of doorway.slice(0, 2)) {
      if (signal()) return null
      const goal = new goals.GoalLookAtBlock(door, bot.world, { reach: 3 })
      await api.travel(bot, goal, 'village door approach', 4000).catch(() => {})
      const block = bot.blockAt(door)
      if (!block || signal() || !bot.canSeeBlock(block) || bot.entity.position.distanceTo(door) > 3.6) continue
      if (!block.getProperties().open) await bot.activateBlock(block).catch(() => {})
      await bot.waitForTicks(2)
      if (!signal()) await go().catch(() => {})
      if (reach()) return reach()
    }
    return null
  }

  async function gather(bot, candidates, match, signal) {
    if (!candidates.length || signal()) return false
    const target = await approach(bot, candidates, signal)
    if (!target || signal()) return false
    const block = bot.blockAt(target)
    if (!match(block) || !bot.canDigBlock(block) || !bot.canSeeBlock(block)) return false
    const before = count(bot, block.name)
    await api.equipTool?.(block)
    if (signal() || !match(bot.blockAt(target)) || !bot.canSeeBlock(block)) return false
    await bot.dig(block, true)
    if (signal() || bot.blockAt(target)?.name === block.name) return false
    const got = await api.pickup(new Set([block.name]), target, before)
    if (ripe(block) && !signal() && count(bot, 'wheat_seeds')) {
      const soil = bot.blockAt(target.offset(0, -1, 0))
      const seed = bot.inventory.items().find(item => item.name === 'wheat_seeds')
      if (soil?.name === 'farmland' && bot.blockAt(target)?.name === 'air' && bot.canSeeBlock(soil)) {
        await bot.equip(seed, 'hand')
        if (!signal()) await bot.placeBlock(soil, target.minus(soil.position)).catch(() => {})
      }
    }
    return got
  }

  async function act(bot, action, plan, signal) {
    let target
    let progress = false
    let amount = 0
    try {
      switch (action) {
        case 'enter_village': {
          target = plan.entry
          if (!target) break
          const block = bot.blockAt(target)
          const candidates = bed(block) ? bedTarget(bot, block, target).positions : [target]
          progress = Boolean(await approach(bot, candidates, signal) && !signal())
          break
        }
        case 'harvest_wheat':
          for (const candidate of plan.crops.slice(0, 3)) {
            if (signal() || count(bot, 'wheat') + count(bot, 'hay_block') * 9 >= 3) break
            target = candidate
            if (await gather(bot, [target], crop, signal)) progress = true
            else if (!signal()) deferred.set(target.toString(), Date.now() + 90000)
          }
          break
        case 'take_bed': {
          target = plan.beds[0]
          const head = bot.blockAt(target)
          if (!bed(head)) break
          const { positions, match } = bedTarget(bot, head, target)
          progress = await gather(bot, positions, match, signal)
          break
        }
        case 'craft_bread': {
          const before = count(bot, 'bread')
          if (plan.supplies.wheat < 3 && !signal()) await api.craft('wheat')
          if (count(bot, 'wheat') < 3 || signal()) break
          const table = await api.ensureTable()
          try {
            while (table && !signal() && count(bot, 'wheat') >= 3 && count(bot, 'bread') < 8 &&
                await api.craft('bread', table)) {}
          } finally {
            if (!signal()) await api.reclaimTable()
          }
          amount = count(bot, 'bread') - before
          progress = amount > 0
          break
        }
      }
    } catch (error) {
      api.log('village action interrupted', { action, target, message: error.message })
    }
    if (target && !progress && !signal()) deferred.set(target.toString(), Date.now() + 90000)
    api.log('village action result', { action, position: target && json(target), progress, amount })
    return progress
  }

  return { plan, act }
}

module.exports = { createVillageVisit, VILLAGE_ACTIONS, ACTIONS }
