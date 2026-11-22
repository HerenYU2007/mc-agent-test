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
async function material(a, item) {
  if (a.count(item)) return true
  if (item === 'cobblestone') {
    await a.gather('stone')
    return false
  }
  if (item === 'redstone') {
    await a.gather('redstone')
    return false
  }
  if (item === 'iron_ingot') {
    if (!a.count('raw_iron')) await a.gather('iron')
    else if (!a.count('coal') && !a.count('charcoal')) await a.gather('coal')
    else await a.smelt('raw_iron', a.count('coal') ? 'coal' : 'charcoal')
    return false
  }
  const requirements = {
    hopper: { iron_ingot: 5, chest: 1 },
    chest: { planks: 8 },
    crafting_table: { planks: 4 },
    furnace: { stone: 8 },
    barrel: { slabs: 2, planks: 6 },
    lever: { stick: 1, stone: 1 },
    redstone_torch: { stick: 1, redstone: 1 },
    iron_pickaxe: { iron_ingot: 3, stick: 2 },
    iron_sword: { iron_ingot: 2, stick: 1 },
    shield: { iron_ingot: 1, planks: 6 },
    wooden_hoe: { planks: 2, stick: 2 },
    bucket: { iron_ingot: 3 },
    torch: { fuel: 1, stick: 1 },
  }
  for (const [name, n] of Object.entries(requirements[item] || {})) {
    if (name === 'planks') {
      if (!(await a.ensurePlanks(n))) return false
    } else if (name === 'stick') {
      if (!(await a.ensureSticks(n))) return false
    } else if (name === 'stone') {
      if (a.count('cobblestone') + a.count('cobbled_deepslate') < n) {
        await a.gather('stone')
        return false
      }
    } else if (name === 'fuel') {
      if (!a.count('coal') && !a.count('charcoal')) {
        await a.gather('coal')
        return false
      }
    } else if (name === 'slabs') {
      if (a.sum((x) => x.endsWith('_slab')) >= n) continue
      if (!(await a.ensurePlanks(3))) return false
      const wood = woodTypes.find((w) => a.count(w + '_planks') >= 3)
      if (!wood) {
        await a.gather('wood')
        return false
      }
      if (await a.station('crafting_table')) await a.craft(wood + '_slab', n)
      return false
    } else if (a.count(name) < n) {
      if (name === 'iron_ingot' && a.count(name) > 0) {
        if (!a.count('raw_iron')) await a.gather('iron')
        else if (!a.count('coal') && !a.count('charcoal')) await a.gather('coal')
        else await a.smelt('raw_iron', a.count('coal') ? 'coal' : 'charcoal')
      } else await material(a, name)
      return false
    }
  }
  if (!(await a.station('crafting_table'))) return false
  await a.craft(item)
  return true
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
    if (!a.count('wheat_seeds')) return false
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
async function expedition(a, m, save) {
  if (!m.trip) m.trip = { route: [m.anchor], returning: false }
  const trip = m.trip
  if (trip.returning) {
    const waypoint = trip.route.at(-1) || m.anchor
    if (dist(a.here(), waypoint) > 4) await a.move(waypoint, 2)
    else trip.route.pop()
    if (!trip.route.length) {
      delete m.trip
      m.nextTrip = Date.now() + 60000
    }
  } else {
    const markers = await a.find(['bell', 'hay_block', 'composter'], 40, 4)
    if (markers.length || trip.route.length >= 12 || a.status.food < 13) {
      trip.returning = true
      if (markers.length) m.village = markers[0].pos
    } else {
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
    await a.call('place', { item, pos })
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
  if (lever.properties.powered === true) {
    await a.call('interact', { pos: pos('switch') })
    return
  }
  if (feed.properties.enabled === false) throw Error('红石工坊的燃料漏斗仍被锁定')
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
  for (const item of ['iron_pickaxe', 'iron_sword', 'shield']) {
    const kind = item.replace('iron_', '')
    const best = a.inventory.items.filter(
      (i) => i.name === item || (i.name.endsWith('_' + kind) && /^(diamond|netherite)_/.test(i.name)),
    )
    const worn = best.length > 0 && best.every((i) => i.durability && i.durability[0] < 24)
    if ((!a.has(item) && !best.length) || worn) {
      if (stock.some((i) => i.name === item)) {
        await transfer('storage', take(item, 1))
        return
      }
    }
    if (!stock.some((i) => i.name === item)) {
      if (
        a.count(item) >= 2 ||
        (a.count(item) && best.some((i) => i.name !== item)) ||
        (item === 'shield' && a.count(item) && a.inventory.offhand?.name === item)
      ) {
        await transfer('storage', put(item, 1))
        return
      }
      if (item === 'shield' && a.count(item) && !a.inventory.offhand) {
        await a.equip(item, 'off-hand')
        return
      }
      if (!a.count(item)) {
        await material(a, item)
        return
      }
      if (item !== 'shield' && !a.count('iron_ingot')) {
        await a.gather('iron')
        if (a.count('raw_iron') && (a.count('coal') || a.count('charcoal')))
          await a.smelt('raw_iron', a.count('coal') ? 'coal' : 'charcoal')
        return
      }
      const needed = { iron_pickaxe: 3, iron_sword: 2, shield: 1 }[item]
      if (a.count('iron_ingot') < needed) {
        if (!a.count('raw_iron')) await a.gather('iron')
        else if (!a.count('coal') && !a.count('charcoal')) await a.gather('coal')
        else await a.smelt('raw_iron', a.count('coal') ? 'coal' : 'charcoal')
        return
      }
      if (!(await a.ensureSticks(2)) || !(await a.ensurePlanks(item === 'shield' ? 6 : 0))) return
      await a.craft(item)
      return
    }
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
  if (await farm(a, m, save)) return
  if (Date.now() >= (m.nextTrip || 0)) await expedition(a, m, save)
}
module.exports = { baseStep, fits }
