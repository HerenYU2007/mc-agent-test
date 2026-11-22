const { DEPOT, WORKSHOP } = require('../supply-base')
const { AIR, FOOD, add, dist } = require('./nmo-actions')
const { Vec3 } = require('vec3')
const { farmPlots } = require('./base-farm')
const parts = [...DEPOT, ...WORKSHOP]
const valuable = /^(diamond|emerald|gold_ingot|lapis_lazuli)$/
const cooked = {
  beef: 'cooked_beef',
  porkchop: 'cooked_porkchop',
  mutton: 'cooked_mutton',
  chicken: 'cooked_chicken',
  potato: 'baked_potato',
}
const fits = (p, b) =>
  (p.names.includes(b.name) || (p.id === 'indicator' && b.name === 'redstone_wall_torch')) &&
  Object.entries(p.properties).every(([key, value]) => b.properties?.[key] === value)
const location = (anchor, id) => add(anchor, parts.find((p) => p.id === id).offset)
const woodTypes = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak']
const { hutBlueprint, hutItem, hutBlockMatches } = require('../starter-hut')
const { expeditionReadiness, retreatReason } = require('./expedition')
const catalog = require('minecraft-data')('1.21.11')
const durability = (i) =>
  i?.durability?.[0] ?? (catalog.itemsByName[i?.name]?.maxDurability || 0) - (i?.durability_used || 0)
const recipes = {
  hopper: { iron_ingot: 5, chest: 1 },
  chest: { planks: 8 },
  crafting_table: { planks: 4 },
  furnace: { stone: 8 },
  barrel: { wooden_slab: 2, planks: 6 },
  lever: { stick: 1, stone: 1 },
  redstone_torch: { stick: 1, redstone: 1 },
  iron_pickaxe: { iron_ingot: 3, stick: 2 },
  iron_sword: { iron_ingot: 2, stick: 1 },
  shield: { iron_ingot: 1, planks: 6 },
  wooden_hoe: { planks: 2, stick: 2 },
  bucket: { iron_ingot: 3 },
  torch: { fuel: 1, stick: 1 },
}
async function material(a, item, min = 1) {
  if (a.count(item) >= min) return true
  if (item === 'planks') return a.ensurePlanks(min)
  if (item === 'stick') return a.ensureSticks(min)
  if (item === 'stone' || item === 'cobblestone') {
    if (item === 'stone' && a.count('cobblestone') + a.count('cobbled_deepslate') >= min) return true
    await a.gather(item === 'stone' ? 'stone' : 'cobble')
    return false
  }
  if (item === 'fuel' || item === 'redstone') {
    if (item === 'fuel' && a.count('coal') + a.count('charcoal') >= min) return true
    await a.gather(item === 'fuel' ? 'coal' : 'redstone')
    return false
  }
  if (item === 'iron_ingot' || item === 'glass') {
    const raw = item === 'glass' ? 'sand' : 'raw_iron'
    if (!a.count(raw)) {
      if (item === 'glass') {
        const sand = (await a.find(['sand'], 32, 4))[0]
        if (sand) await a.call('dig', { pos: sand.pos, collect: true })
        else await a.explore()
      } else await a.gather('iron')
    } else if (await material(a, 'fuel')) await a.smelt(raw, a.count('coal') ? 'coal' : 'charcoal')
    return false
  }
  if (item === 'wooden_slab' || item === 'wooden_door') {
    if (a.sum((n) => hutItem(n, item)) >= min) return true
    const unit = item === 'wooden_slab' ? 3 : 6
    let wood = woodTypes.find((w) => a.count(w + '_planks') >= unit)
    if (!wood) {
      wood = woodTypes.find((w) => a.count(w + '_log'))
      if (wood) await a.craft(wood + '_planks', Math.min(unit, 4 * a.count(wood + '_log')))
      else await a.gather('wood')
      return false
    }
    if (await a.station('crafting_table'))
      await a.craft(wood + (item === 'wooden_slab' ? '_slab' : '_door'), min)
    return a.sum((n) => hutItem(n, item)) >= min
  }
  if (item === 'bed') {
    if (a.sum((n) => n.endsWith('_bed'))) return true
    const wool = a.inventory.items.find((i) => i.name.endsWith('_wool') && i.count >= 3)
    if (!wool) {
      const sheep = (await a.call('get_entities', { types: ['animal'], radius: 40 })).entities.find(
        (e) => e.name === 'sheep',
      )
      if (sheep) await a.call('attack', { entity_id: sheep.id, timeout: 8000 })
      else await a.explore()
      return false
    }
    if ((await a.ensurePlanks(3)) && (await a.station('crafting_table')))
      await a.craft(wool.name.replace('_wool', '_bed'))
    return a.sum((n) => n.endsWith('_bed')) > 0
  }
  if (item === 'wall_torch') return material(a, 'torch', min)
  const needs = recipes[item]
  if (!needs) throw Error('缺少材料方案 ' + item)
  for (const [ingredient, qty] of Object.entries(needs)) if (!(await material(a, ingredient, qty))) return false
  if (!(await a.station('crafting_table'))) return false
  await a.craft(item)
  return a.count(item) >= min
}
async function chooseSite(a) {
  const origin = a.here()
  for (const offset of [
    [5, 0, 0],
    [-5, 0, 0],
    [0, 0, 5],
    [0, 0, -5],
  ]) {
    const anchor = add(origin, offset)
    const below = await Promise.all(
      parts.filter((p) => p.offset[1] === 0).map((p) => a.block(add(add(anchor, p.offset), [0, -1, 0]))),
    )
    if (
      below.some(
        (b) =>
          ![
            'stone',
            'dirt',
            'grass_block',
            'podzol',
            'coarse_dirt',
            'sandstone',
            'granite',
            'andesite',
            'diorite',
          ].includes(b.name),
      )
    )
      continue
    const blocks = await Promise.all(parts.map((p) => a.block(add(anchor, p.offset))))
    if (blocks.every((b) => AIR.has(b.name))) return anchor
  }
  return null
}
async function farm(a, m, save) {
  const center = add(m.anchor, [-6, -1, 3])
  const ground = await a.block(center)
  if (ground.name !== 'water') {
    if (!/^(dirt|grass_block|farmland|air)$/.test(ground.name)) return false
    if (!a.count('water_bucket')) {
      if (!a.count('bucket')) {
        await material(a, 'bucket')
        return true
      }
      const water = (await a.find(['water'], 32, 16)).find((b) => Number(b.properties.level) === 0)
      if (!water) return false
      await a.call('interact', { pos: water.pos, item: 'bucket' })
      return true
    }
    if (!AIR.has(ground.name)) await a.call('dig', { pos: center, collect: false })
    await a.call('interact', { pos: center, item: 'water_bucket' })
    return true
  }
  for (const p of farmPlots(new Vec3(...center))) {
    const pos = p.toArray(),
      above = add(pos, [0, 1, 0]),
      crop = await a.block(above),
      soil = await a.block(pos)
    if (crop.name === 'wheat' && Number(crop.properties.age) === 7) {
      await a.call('dig', { pos: above, collect: true })
      return true
    }
    if (!AIR.has(crop.name) || !['farmland', 'grass_block', 'dirt'].includes(soil.name)) continue
    if (!a.count('wheat_seeds')) {
      const grass = (await a.find(['short_grass', 'tall_grass'], 20, 8))[0]
      if (!grass) return false
      await a.call('dig', { pos: grass.pos, collect: true })
      return true
    }
    if (soil.name !== 'farmland') {
      if (!a.tool('hoe')) {
        await material(a, 'wooden_hoe')
        return true
      }
      await a.call('interact', { pos, item: a.tool('hoe') })
      return true
    }
    await a.call('interact', { pos, item: 'wheat_seeds' })
    return true
  }
  return false
}
async function hutStep(a, m, save) {
  if (m.hut?.complete) return false
  if (!m.hut) {
    for (const delta of [
      [7, 0, 0],
      [0, 0, 7],
      [-8, 0, -5],
      [0, 0, -8],
    ]) {
      const center = add(m.anchor, delta)
      const squares = Array.from({ length: 25 }, (_, i) => add(center, [(i % 5) - 2, 0, Math.floor(i / 5) - 2]))
      const floors = await Promise.all(squares.map((p) => a.block(add(p, [0, -1, 0]))))
      if (
        floors.some(
          (b) =>
            !['grass_block', 'dirt', 'stone', 'granite', 'andesite', 'diorite', 'sandstone', 'podzol'].includes(
              b.name,
            ),
        )
      )
        continue
      let free = true
      for (let h = 0; h <= 3 && free; h++)
        free = (await Promise.all(squares.map((p) => a.block(add(p, [0, h, 0]))))).every((b) => AIR.has(b.name))
      if (free) {
        m.hut = { center, index: 0 }
        save()
        break
      }
    }
    if (!m.hut) return false
  }
  const cells = hutBlueprint({ center: new Vec3(...m.hut.center), front: new Vec3(0, 0, 1), supports: [] })
  const cell = cells[m.hut.index]
  if (!cell) {
    m.hut.complete = true
    save()
    return false
  }
  const pos = cell.position.toArray()
  if (dist(a.here(), pos) > 5) await a.move(pos, 3)
  async function matches() {
    const observed = new Map()
    for (const point of [cell.position, cell.pair].filter(Boolean)) {
      const b = await a.block(point.toArray())
      observed.set(point.toString(), { ...b, getProperties: () => b.properties })
    }
    return hutBlockMatches({ blockAt: (p) => observed.get(p.toString()) }, cell)
  }
  if (!(await matches())) {
    const item = a.inventory.items.find((i) => hutItem(i.name, cell.block))
    if (!item) {
      m.needed = cell.block
      save()
      return true
    }
    const current = await a.block(pos)
    if (!AIR.has(current.name)) throw Error('小屋施工位置被占用 ' + pos.join(',') + ' ' + current.name)
    if (cell.look) await a.move(add(pos, cell.look.scaled(-2).toArray()), 0)
    await a.placeAt(item.name, pos)
    if (!(await matches())) throw Error('小屋方块未通过朝向或配对检查 ' + cell.block + ' ' + pos)
  }
  m.hut.index++
  save()
  return true
}
function readiness(a) {
  const armor = a.inventory.armor || {},
    gear = {
      head: armor.head,
      torso: armor.chest,
      legs: armor.legs,
      feet: armor.feet,
      'off-hand': a.inventory.offhand,
    }
  const bot = {
    health: a.status.health,
    food: a.status.food,
    inventory: { items: () => a.inventory.items, slots: gear },
    getEquipmentDestSlot: (slot) => slot,
  }
  return expeditionReadiness(bot, { durability, foodReserve: () => a.sum((n) => FOOD.test(n)) })
}
async function expedition(a, m, save) {
  const condition = retreatReason(readiness(a)) || (!a.status.is_day ? 'nightfall' : null)
  if (!m.trip) {
    if (condition) return
    m.trip = { route: [m.anchor], returning: false, visits: 0 }
    save()
  }
  const trip = m.trip
  if (condition) trip.returning = true
  if (trip.returning) {
    const waypoint = trip.route.at(-1) || m.anchor
    if (dist(a.here(), waypoint) > 4) await a.move(waypoint, 2)
    else trip.route.pop()
    if (!trip.route.length) {
      delete m.trip
      m.nextTrip = Date.now() + 60000
    }
  } else if (trip.village) {
    if (dist(a.here(), trip.village) > 5) await a.move(trip.village, 3)
    else if (trip.visits++ >= 5) trip.returning = true
    else if (a.count('wheat') >= 3) {
      if (await a.station('crafting_table')) {
        await a.craft('bread', Math.floor(a.count('wheat') / 3))
        await a.reclaim('crafting_table')
      }
    } else if (a.count('hay_block')) await a.craft('wheat', 9)
    else {
      const crops = await a.find(['wheat'], 18, 6, { mature: true }),
        hay = await a.find(['hay_block'], 18, 4)
      const crop = crops[0] || hay[0]
      if (crop) {
        await a.call('dig', { pos: crop.pos, collect: true })
        await a.refresh()
        if (crop.name === 'wheat' && a.count('wheat_seeds'))
          await a.call('interact', { pos: add(crop.pos, [0, -1, 0]), item: 'wheat_seeds' })
      } else {
        const bed = (await a.find(['white_bed', 'red_bed', 'yellow_bed', 'blue_bed', 'brown_bed'], 16, 4))[0]
        if (bed && !a.sum((n) => n.endsWith('_bed'))) await a.call('dig', { pos: bed.pos, collect: true })
        else trip.returning = true
      }
    }
  } else {
    const markers = (
      await a.find(['bell', 'hay_block', 'composter', 'farmland', 'white_bed', 'yellow_bed'], 40, 24)
    ).filter((b) => dist(b.pos, m.anchor) > 18)
    const marker = markers.find((b) =>
      markers.some((other) => other.name !== b.name && dist(other.pos, b.pos) < 16),
    )
    if (marker) {
      trip.village = marker.pos
      m.village = marker.pos
      trip.route.push(a.here())
    } else if (trip.route.length >= 16) trip.returning = true
    else {
      await a.explore()
      await a.refresh()
      if (dist(trip.route.at(-1), a.here()) >= 3) trip.route.push(a.here())
      else trip.returning = true
    }
  }
  save()
}
async function baseStep(a, m, save, log) {
  if (!m.unlocked) {
    const surface = m.surface
    if (surface && dist(a.here(), surface) > 8) {
      await a.move(surface, 3)
      return
    }
    if (a.sum((n) => FOOD.test(n)) < 8) {
      await a.food()
      return
    }
    m.unlocked = true
    save()
  }
  if (m.trip) {
    await expedition(a, m, save)
    return
  }
  if (!m.anchor) {
    const anchor = await chooseSite(a)
    if (!anchor) {
      await a.explore()
      return
    }
    m.anchor = anchor
    save()
  }
  if (m.needed) {
    if (!(await material(a, m.needed))) return
    delete m.needed
    save()
  }
  if (dist(a.here(), m.anchor) > 7) {
    await a.move(m.anchor, 3)
    return
  }
  for (const piece of parts) {
    const pos = add(m.anchor, piece.offset),
      current = await a.block(pos)
    if (fits(piece, current)) continue
    if (!AIR.has(current.name))
      throw Error('基地施工受阻 ' + piece.id + ' ' + pos.join(',') + ' 当前方块 ' + current.name)
    const item = piece.names.find((name) => a.count(name)) || piece.names[0]
    if (!a.count(item)) {
      m.needed = item
      save()
      return
    }
    await a.placeAt(item, pos)
    if (!fits(piece, await a.block(pos))) throw Error('工坊方块朝向未确认 ' + piece.id)
    log('基地施工 ' + piece.id)
    return
  }
  const pos = (id) => location(m.anchor, id)
  const view = async (id) => (await a.call('window/view', { target: { pos: pos(id) } })).sections.container
  const transfer = (id, op) => a.call('window/act', { target: { pos: pos(id) }, ops: [op] })
  const take = (item, count) => ({ op: 'take', from: 'container', item, count })
  const put = (item, count) => ({ op: 'put', to: 'container', item, count })
  const lever = await a.block(pos('switch')),
    feed = await a.block(pos('fuel-feed'))
  const lamp = await a.block(pos('indicator'))
  if (lever.properties.powered === true) {
    const locked = feed.properties.enabled === false && lamp.properties.lit === false
    await a.call('interact', { pos: pos('switch') })
    if (!locked) throw Error('拉杆通电，漏斗或指示灯状态与蓝图不符')
    m.sawFuelLock = true
    save()
    return
  }
  if (feed.properties.enabled !== true || lamp.properties.lit !== true)
    throw Error('工坊解锁后未观察到送料和亮灯状态')
  if (!m.sawFuelLock) {
    await a.call('interact', { pos: pos('switch') })
    return
  }
  if (!m.switchChecked) {
    m.switchChecked = true
    save()
    log('红石开关、燃料漏斗和指示灯双向验证通过')
  }
  const product = (await view('output'))[0]
  if (product) {
    await transfer('output', take(product.name, product.count))
    return
  }
  const stock = await view('storage')
  const deposit = a.inventory.items.find((i) => valuable.test(i.name))
  if (deposit) {
    await transfer('storage', put(deposit.name, deposit.count))
    return
  }
  const food = a.sum((n) => FOOD.test(n))
  if (food < 8) {
    const stored = stock.find((i) => FOOD.test(i.name))
    if (stored) {
      await transfer('storage', take(stored.name, Math.min(stored.count, 8 - food)))
      return
    }
    await a.food()
    return
  }
  if (a.count('torch') < 16) {
    const stored = stock.find((i) => i.name === 'torch')
    if (stored) await transfer('storage', take('torch', Math.min(stored.count, 16 - a.count('torch'))))
    else if (await a.ensureSticks(1)) {
      if (a.count('coal') || a.count('charcoal')) await a.craft('torch', 4)
      else await a.gather('coal')
    }
    return
  }
  if (food > 10) {
    const surplus = a.inventory.items.find((i) => FOOD.test(i.name))
    await transfer('storage', put(surplus.name, Math.min(surplus.count, food - 10)))
    return
  }
  if (a.count('torch') > 20) {
    await transfer('storage', put('torch', a.count('torch') - 20))
    return
  }
  const fuel = a.inventory.items.find((i) => ['coal', 'charcoal'].includes(i.name))
  if (fuel && !(await view('fuel')).length) {
    await transfer('fuel', put(fuel.name, Math.min(8, fuel.count)))
    return
  }
  const raw = a.inventory.items.find((i) => i.name === 'raw_iron' || cooked[i.name])
  if (raw) {
    await transfer('input', put(raw.name, raw.count))
    return
  }
  for (const item of ['iron_pickaxe', 'iron_sword', 'shield']) {
    const accepts = (n) =>
      n === item ||
      (item !== 'shield' && n.endsWith('_' + item.split('_')[1]) && /^(diamond|netherite)_/.test(n))
    const equipped =
      item === 'shield' && a.inventory.offhand?.name === 'shield' && durability(a.inventory.offhand) > 24
    const carried = a.inventory.items.filter((i) => accepts(i.name) && durability(i) > 24)
    const stored = stock.find((i) => i.name === item)
    if (!equipped && !carried.length && stored) {
      await transfer('storage', take(item, 1))
      return
    }
    if (stored) continue
    if (!equipped && item === 'shield' && carried.length) {
      await a.equip(item, 'off-hand')
      return
    }
    const min = equipped || carried.some((i) => i.name !== item) ? 1 : 2
    if (a.count(item) < min) {
      await material(a, item, min)
      return
    }
    await transfer('storage', put(item, 1))
    return
  }
  if (await farm(a, m, save)) return
  if (await hutStep(a, m, save)) return
  if (Date.now() >= (m.nextTrip || 0)) await expedition(a, m, save)
}
module.exports = { baseStep, fits }
