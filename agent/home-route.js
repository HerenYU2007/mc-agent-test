const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { blockForTool } = require('./mining-speed')
const { createLightSurvey, rememberTorch } = require('./home-light')

const UP = new Vec3(0, 1, 0)
const AIR = /^(air|cave_air|void_air)$/
const GRASS = /^(short_grass|tall_grass|fern|large_fern)$/
const RAW = /^(beef|porkchop|chicken|mutton|rabbit|cod|salmon)$/
const FOOD = /^(bread|baked_potato|cooked_.+|carrot|apple)$/
const STOCK = 40 // Eight loaves of bread, measured in hunger points.
const phases = [
  '照亮基地周围',
  '钻石回家',
  '摆放分类箱',
  '整理物资',
  '除草取种',
  '开垦麦田',
  '储备口粮',
  '制作附魔台',
  '基地整备完成',
]
const pos = (a) => new Vec3(...a)
const tuple = (p) => [p.x, p.y, p.z]
const count = (bot, name) => bot.inventory.items().reduce((s, i) => s + (i.name === name ? i.count : 0), 0)
const readyFood = (bot) =>
  bot.inventory
    .items()
    .reduce(
      (s, i) => s + (FOOD.test(i.name) ? (bot.registry.foodsByName[i.name]?.foodPoints || 0) * i.count : 0),
      0,
    )
function category(name) {
  if (/^(diamond|emerald|gold_ingot|lapis_lazuli|redstone)$/.test(name)) return 0
  if (/^(cobblestone|cobbled_deepslate|dirt|andesite|diorite|granite|tuff|gravel)$/.test(name)) return 1
  if (/^(feather|bone|gunpowder|string|rotten_flesh|spider_eye|flint|egg)$/.test(name)) return 2
  return -1
}

function createHomeRoute(api) {
  const survey = createLightSurvey()
  const finalSurvey = createLightSurvey()
  const cooldown = new Map()
  let forageTurn = 0
  async function near(bot, p, range = 3) {
    const goal = new goals.GoalNear(p.x, p.y, p.z, range)
    if (!goal.isEnd(bot.entity.position.floored()))
      await api.travel(bot, goal, '基地物资路线', 10000).catch(() => {})
    return api.safe(bot) && goal.isEnd(bot.entity.position.floored())
  }
  function fresh(bot, p) {
    return bot.blockAt(p, false)
  }
  async function plantInReach(bot, p) {
    if (!(await near(bot, p, 2))) return false
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
    const delta = p.offset(0.5, 0.5, 0.5).minus(eye)
    const distance = delta.norm()
    const hit = bot.world.raycast(eye, delta.normalize(), distance)
    return !hit || hit.position.equals(p)
  }
  async function gather(bot, home, names, drop, matchFrom = home, range = 64) {
    const ids = names.map((n) => bot.registry.blocksByName[n]?.id).filter(Number.isInteger)
    const candidates = bot
      .findBlocks({ point: matchFrom, matching: ids, maxDistance: range, count: 128 })
      .filter((p) => (cooldown.get(p.toString()) || 0) < Date.now() && !api.reserved(p))
      .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))
    for (const p of candidates.slice(0, 3)) {
      cooldown.set(p.toString(), Date.now() + 20000)
      if (!api.safe(bot)) return
      if (
        drop === 'obsidian' &&
        [
          UP,
          new Vec3(0, -1, 0),
          new Vec3(1, 0, 0),
          new Vec3(-1, 0, 0),
          new Vec3(0, 0, 1),
          new Vec3(0, 0, -1),
        ].some((v) => /lava/.test(fresh(bot, p.plus(v))?.name || ''))
      )
        continue
      const plant = drop !== 'obsidian'
      if (!(plant ? await plantInReach(bot, p) : await api.approach(bot, p))) continue
      const block = fresh(bot, p)
      if (!block || !names.includes(block.name) || !bot.canDigBlock(block) || (!plant && !bot.canSeeBlock(block)))
        continue
      if (drop === 'obsidian') {
        const pick = bot.inventory.items().find((i) => /^(diamond|netherite)_pickaxe$/.test(i.name))
        if (!pick) return
        await bot.equip(pick, 'hand')
      }
      const before = count(bot, drop)
      if (!api.safe(bot)) return
      const guard =
        drop === 'obsidian'
          ? setInterval(() => {
              if (!api.safe(bot) && bot.targetDigBlock?.position.equals(p)) bot.stopDigging()
            }, 100)
          : null
      try {
        await bot.dig(blockForTool(bot, block, bot.heldItem), true)
      } finally {
        clearInterval(guard)
      }
      if (api.safe(bot)) await api.pickup(new Set([drop]), p, before)
      return
    }
    if (drop === 'obsidian' && api.prospectObsidian) return api.prospectObsidian(bot)
    // Probe new loaded terrain without launching a village search.
    const angle = ++forageTurn * 2.39996
    const radius = Math.min(range, 12 + (forageTurn % Math.max(1, range - 12)))
    const dx = Math.round(Math.cos(angle) * radius),
      dz = Math.round(Math.sin(angle) * radius)
    await api.travel(bot, new goals.GoalXZ(home.x + dx, home.z + dz), '搜索基地所需材料', 7500).catch(() => {})
  }
  function rowSite(bot, home) {
    for (let r = 4; r <= 14; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
          for (const dy of [0, -1, 1, -2, 2])
            for (const [x, z] of [
              [1, 0],
              [0, 1],
            ]) {
              const row = [0, 2, 4, 6].map((n) => home.offset(dx + n * x, dy, dz + n * z))
              if (
                row.every(
                  (p) =>
                    !api.reserved(p) &&
                    AIR.test(fresh(bot, p)?.name) &&
                    AIR.test(fresh(bot, p.plus(UP))?.name) &&
                    fresh(bot, p.minus(UP))?.boundingBox === 'block' &&
                    ![
                      [-1, 0],
                      [1, 0],
                      [0, 1],
                      [0, -1],
                    ].some(([i, j]) => fresh(bot, p.offset(i, 0, j))?.name === 'chest'),
                )
              )
                return row.map(tuple)
            }
        }
    return null
  }
  async function run(bot, home, s, save, table) {
    const stage = s.stage || 0
    const advance = () => {
      s.stage = stage + 1
      save()
      api.log('基地任务阶段完成', { 阶段: phases[stage] })
    }
    api.show(phases[stage])
    if (!api.safe(bot) || bot.isSleeping) return
    const finishing = stage === 8 && !s.finalLightChecked
    if (stage === 0 || finishing) {
      if (finishing) api.show('完工后复查地表暗点')
      const result = (finishing ? finalSurvey : survey)(bot, home)
      if (result.complete) {
        if (!finishing) return advance()
        s.finalLightChecked = true
        save()
        return
      }
      if (result.load)
        return api
          .travel(bot, new goals.GoalXZ(result.load.x, result.load.z), '加载基地照明区域', 9000)
          .catch(() => {})
      const p = result.target
      if (!p) return
      if (!count(bot, 'torch')) {
        if (!count(bot, 'coal') && !count(bot, 'charcoal'))
          return api.collect(bot, 'coal', ['coal', 'charcoal'], 8)
        if (!count(bot, 'stick') && !(await api.makeSticks(bot))) return api.wood()
        return api.craftAt(bot, 'torch', null)
      }
      // Place beside a crop, reserved cell or occupied block without breaking it.
      const options = [p, p.offset(1, 0, 0), p.offset(-1, 0, 0), p.offset(0, 0, 1), p.offset(0, 0, -1)]
      for (const t of options) {
        if (api.reserved(t) || fresh(bot, t.minus(UP))?.boundingBox !== 'block') continue
        if (GRASS.test(fresh(bot, t)?.name) && (await plantInReach(bot, t)) && api.safe(bot))
          await bot.dig(fresh(bot, t), true)
        if (AIR.test(fresh(bot, t)?.name) && (await api.placeAt(bot, t, 'torch'))) {
          rememberTorch(bot, t)
          await bot.waitForTicks(4)
          return
        }
      }
      result.retryLater()
      return
    }
    if (stage === 1) {
      if (!(await near(bot, home, 6))) return
      // Previous versions already deposited diamonds into the depot barrel.
      if (count(bot, 'diamond') < 10) await api.withdrawDepot(bot, 'diamond', 10 - count(bot, 'diamond'))
      if (count(bot, 'diamond') < 10) return api.collect(bot, 'diamond', ['diamond'], 10)
      return advance()
    }
    if (!s.row) {
      if (!(await near(bot, home, 6))) return
      const row = rowSite(bot, home)
      if (!row) {
        api.show('等待房旁可用的平整箱位')
        return
      }
      s.row = row
      save()
    }
    const slots = s.row.map(pos)
    if (stage === 2) {
      for (const p of slots.slice(0, 3)) {
        if (fresh(bot, p)?.name === 'chest') continue
        if (!count(bot, 'chest')) {
          if (!(await api.planks(8))) return api.wood()
          return api.craftAt(bot, 'chest', table)
        }
        return api.placeAt(bot, p, 'chest')
      }
      return advance()
    }
    if (stage === 3) {
      for (let i = 0; i < 3; i++) {
        const p = slots[i]
        if (!(await api.approach(bot, p)) || !api.safe(bot) || fresh(bot, p)?.name !== 'chest') return
        const chest = await bot.openContainer(fresh(bot, p))
        try {
          for (const stack of bot.inventory.items()) {
            if (!api.safe(bot)) return
            if (category(stack.name) !== i) continue
            const quantity = i === 1 ? Math.min(stack.count, count(bot, stack.name) - 32) : stack.count
            if (quantity > 0) await chest.deposit(stack.type, stack.metadata, quantity)
          }
          if (
            i === 0 &&
            chest
              .containerItems()
              .filter((x) => x.name === 'diamond')
              .reduce((a, b) => a + b.count, 0) < 10
          )
            return
        } finally {
          chest.close()
        }
      }
      return advance()
    }
    if (stage === 4) {
      if (count(bot, 'wheat_seeds') >= 8 || api.planted(bot) === 8) return advance()
      return gather(bot, home, ['short_grass', 'tall_grass', 'fern', 'large_fern'], 'wheat_seeds')
    }
    if (stage === 5) {
      if (api.planted(bot) === 8 && api.watered(bot)) return advance()
      if (api.planted(bot) < 8 && !count(bot, 'wheat_seeds'))
        return gather(bot, home, ['short_grass', 'tall_grass'], 'wheat_seeds')
      return api.farmStep(bot, home, table)
    }
    if (stage === 6) {
      if (bot.food < 18) await api.eat()
      if (readyFood(bot) >= STOCK && bot.food >= 18) return advance()
      if (count(bot, 'wheat') >= 3) return api.craftAt(bot, 'bread', table)
      if (bot.inventory.items().some((i) => RAW.test(i.name)) && (await api.cookFood())) return
      if (!(await api.farmStep(bot, home, table)) && api.safe(bot)) await api.forage()
      return
    }
    if (stage !== 7) return
    const target = slots[3]
    if (fresh(bot, target)?.name === 'enchanting_table') return advance()
    if (count(bot, 'enchanting_table')) return api.placeAt(bot, target, 'enchanting_table')
    if (!count(bot, 'book')) {
      if (count(bot, 'paper') < 3) {
        if (count(bot, 'sugar_cane') < 3)
          return gather(bot, home, ['sugar_cane'], 'sugar_cane', bot.entity.position.floored(), 96)
        return api.craftAt(bot, 'paper', table)
      }
      if (!count(bot, 'leather')) return api.leather(bot, home)
      return api.craftAt(bot, 'book', table)
    }
    const hasPick = bot.inventory.items().some((i) => /^(diamond|netherite)_pickaxe$/.test(i.name))
    const needed = !hasPick && count(bot, 'obsidian') < 4 ? 5 : 2
    if (count(bot, 'diamond') < needed) {
      if (!(await api.approach(bot, slots[0])) || !api.safe(bot) || fresh(bot, slots[0])?.name !== 'chest') return
      const chest = await bot.openContainer(fresh(bot, slots[0]))
      try {
        const d = chest.containerItems().find((i) => i.name === 'diamond')
        if (d) await chest.withdraw(d.type, d.metadata, Math.min(d.count, needed - count(bot, 'diamond')))
      } finally {
        chest.close()
      }
      if (count(bot, 'diamond') < needed) await api.collect(bot, 'diamond', ['diamond'], needed)
      return
    }
    if (count(bot, 'obsidian') < 4) {
      if (!hasPick) {
        if (count(bot, 'stick') < 2 && !(await api.makeSticks(bot))) return api.wood()
        return api.craftAt(bot, 'diamond_pickaxe', table)
      }
      return gather(bot, home, ['obsidian'], 'obsidian', bot.entity.position.floored(), 96)
    }
    return api.craftAt(bot, 'enchanting_table', table)
  }
  return { run }
}
module.exports = { createHomeRoute, phases, category, readyFood, STOCK }
