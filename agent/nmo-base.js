const { DEPOT, WORKSHOP } = require('../supply-base')
const { AIR, FOOD, add, dist, recoverable } = require('./nmo-actions')
const { torchSupply } = require('./nmo-base-lighting')
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
  if (await a.takeStored?.(item, min)) return true
  if (item === 'torch' || item === 'wall_torch') return torchSupply(a)
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
    if (a.count(raw) < (item === 'iron_ingot' ? min - a.count(item) : 1)) {
      if (item === 'glass') {
        const sand = (await a.find(['sand'], 32, 4))[0]
        if (sand) await a.call('dig', { pos: sand.pos, collect: true })
        else await a.explore()
      } else await a.gather('iron')
    } else {
      const fuel = a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : null
      if (fuel) await a.smelt(raw,fuel)
      else if (item === 'glass') {
        if (await a.ensurePlanks(1)) {
          const wood = a.inventory.items.find(stack=>stack.name.endsWith('_planks'))
          if (wood) await a.smelt(raw,wood.name,1)
        }
      } else await material(a,'fuel')
    }
    return false
  }
  if (item === 'wooden_slab' || item === 'wooden_door') {
    const missing = min-a.sum(n=>hutItem(n,item))
    if (missing<=0) return true
    const unit = item === 'wooden_slab' ? 3*Math.ceil(missing/6) : 6
    let wood = woodTypes.find((w) => a.count(w + '_planks') >= unit)
    if (!wood) {
      wood = woodTypes.filter(w=>a.count(w+'_log')).sort((x,y)=>a.count(y+'_planks')-a.count(x+'_planks'))[0]
      if (wood) await a.craft(wood + '_planks', Math.min(unit-a.count(wood+'_planks'),4*a.count(wood+'_log')))
      else await a.gather('wood')
      return false
    }
    if (await a.station('crafting_table'))
      await a.craft(wood + (item === 'wooden_slab' ? '_slab' : '_door'), missing)
    return a.sum((n) => hutItem(n, item)) >= min
  }
  if (item === 'bed') {
    if (a.sum((n) => n.endsWith('_bed'))) return true
    const wool = a.inventory.items.find((i) => i.name.endsWith('_wool') && i.count >= 3)
    if (!wool) {
      const sheep = (await a.call('get_entities', { types: ['sheep'], radius: 80 })).entities[0]
      if (sheep) {
        if (sheep.dist > 14) {
          await a.move(sheep.pos,6)
          return false
        }
        if (a.tool('sword')) await a.equip(a.tool('sword'))
        await a.call('attack', { entity_id: sheep.id, timeout: 8000, stop_on: ['hurt','death'] })
      }
      else await a.explore()
      return false
    }
    if (!await a.ensurePlanks(3)) return false
    const table = await a.station('crafting_table')
    if (!table) return false
    const planks = a.inventory.items.filter(stack=>stack.name.endsWith('_planks'))
      .flatMap(stack=>Array(Math.min(3,stack.count)).fill(stack.name)).slice(0,3)
    const bed = wool.name.replace('_wool','_bed')
    const grid = [wool.name,wool.name,wool.name,...planks]
    await a.call('window/act',{target:{pos:table},ops:[
      ...grid.map((item,slot)=>({op:'put',to:'grid',item,slot,count:1})),
      {op:'take',from:'output',item:bed,count:1},
    ]})
    await a.refresh()
    return a.sum((n) => n.endsWith('_bed')) > 0
  }
  const needs = recipes[item]
  if (!needs) throw Error('缺少材料方案 ' + item)
  for (const [ingredient, qty] of Object.entries(needs)) if (!(await material(a, ingredient, qty))) return false
  if (!(await a.station('crafting_table'))) return false
  await a.craft(item)
  return a.count(item) >= min
}
const baseGround = /^(stone|dirt|grass_block|dirt_path|podzol|coarse_dirt|sandstone|granite|andesite|diorite|cobblestone|cobbled_deepslate|calcite|tuff|deepslate)$/
const clearable = /^(short_grass|tall_grass|fern|large_fern|dandelion|poppy|cornflower|oxeye_daisy|azure_bluet|lily_of_the_valley|allium|blue_orchid|(?:white|pink|orange|red)_tulip|dead_bush|snow)$/
const siteOffsets = [[0, 0, 0]]
for (const radius of [4, 8, 12, 16, 20]) {
  for (let x = -radius; x <= radius; x += 4) {
    for (let z = -radius; z <= radius; z += 4) {
      if (Math.max(Math.abs(x), Math.abs(z)) === radius) siteOffsets.push([x, 0, z])
    }
  }
}
const foundations = parts.filter(p => p.offset[1] === 0)
const approaches = [[-3, 0, 0], [0, 0, 2], [2, 0, -2], [0, 0, -3]]

async function inspectSite(a, anchor) {
  const floor = await a.block(add(anchor, [0, -1, 0]))
  if (!baseGround.test(floor.name)) return null
  const terrain = await Promise.all(foundations.map(p => a.block(add(add(anchor, p.offset), [0, -1, 0]))))
  if (terrain.some(block => !baseGround.test(block.name))) return null
  const blocks = await Promise.all(parts.map(piece => a.block(add(anchor, piece.offset))))
  if (blocks.some(block => !AIR.has(block.name) && !clearable.test(block.name))) return null
  for (const offset of approaches) {
    const stand = add(anchor, offset)
    const [support, feet, head] = await Promise.all([
      a.block(add(stand, [0, -1, 0])), a.block(stand), a.block(add(stand, [0, 1, 0])),
    ])
    if (baseGround.test(support.name) && [feet, head].every(block => AIR.has(block.name) || clearable.test(block.name))) return stand
  }
  return null
}

async function chooseSite(a, memory, save, log) {
  const origin = a.here()
  const search = memory.siteSearch ??= { origin, index: 0, visited: [] }
  const end = Math.min(search.index + 12, siteOffsets.length)
  for (; search.index < end; search.index++) {
    for (const y of [0, -1, 1, -2, 2]) {
      const anchor = add(add(search.origin, siteOffsets[search.index]), [0, y, 0])
      const stand = await inspectSite(a, anchor)
      if (!stand) continue
      try {
        if (dist(origin, stand) > 2) await a.move(stand, 1)
        await a.refresh()
        if (dist(a.here(), stand) > 2) continue
        delete memory.siteSearch
        log('确认可到达的基地工地 ' + anchor.join(','))
        return anchor
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
    }
  }
  if (search.index === siteOffsets.length) {
    search.visited.push(search.origin)
    const directions = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]
      .sort((x, y) => {
        const nearest = direction => Math.min(...search.visited.map(pos => dist(pos, add(origin, direction.map(v => v * 22)))))
        return nearest(y) - nearest(x)
      })
    await a.explore(add(origin, directions[0].map(v => -v * 24)))
    await a.refresh()
    search.origin = a.here()
    search.index = 0
    if (search.visited.length > 12) search.visited.shift()
  }
  save()
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
async function hutStep(a, m, save, deferLight=false) {
  if (m.hut?.complete) return false
  if (!m.hut) {
    const preferred = [
      [7, 0, 0],
      [0, 0, 7],
      [-8, 0, -5],
      [0, 0, -8],
    ]
    const offsets = [...preferred, ...siteOffsets.filter(([x, , z]) => Math.hypot(x, z) >= 7)]
    const end = Math.min((m.hutSearch ?? 0) + 10, offsets.length)
    for (let i = m.hutSearch || 0; i < end && !m.hut; i++) {
      for (const y of [0, 1, -1, 2, -2, 3, -3]) {
        const center = add(add(m.anchor, offsets[i]), [0, y, 0])
        const foundation = await a.block(add(center, [0, -1, 0]))
        if (!baseGround.test(foundation.name)) continue
        const squares = Array.from({ length: 25 }, (_, i) => [(i % 5) - 2, 0, Math.floor(i / 5) - 2])
        const feet = [...squares.map(p => add(center, p)), add(center, [0, 0, 3])]
        const floors = await Promise.all(feet.map(p => a.block(add(p, [0, -1, 0]))))
        const supports = []
        for (let j = 0; j < floors.length; j++) {
          if (baseGround.test(floors[j].name)) continue
          if (AIR.has(floors[j].name) && baseGround.test((await a.block(add(feet[j], [0, -2, 0]))).name))
            supports.push({ x: feet[j][0] - center[0], z: feet[j][2] - center[2] })
          else supports.push(null)
          if (supports.includes(null) || supports.length > 7) break
        }
        if (supports.includes(null) || supports.length > 7) continue
        let free = true
        for (let h = 0; h <= 3 && free; h++) {
          const blocks = await Promise.all(feet.map(p => a.block(add(p, [0, h, 0]))))
          free = blocks.every(b => AIR.has(b.name) || clearable.test(b.name))
        }
        if (!free) continue
        m.hut = { center, index: 0, supports }
        delete m.hutSearch
        save()
        break
      }
    }
    if (!m.hut) {
      m.hutSearch = end === offsets.length ? 0 : end
      save()
      return '分区检查小屋地形'
    }
  }
  if (!m.hut.prepared) {
    const center = m.hut.center
    const floor = Array.from({length:25}, (_, i) => [(i % 5) - 2,0,Math.floor(i / 5) - 2])
    for (const offset of [...floor,[0,0,3]]) {
      const pos = add(center,offset)
      if (clearable.test((await a.block(pos)).name)) {
        await a.call('dig',{pos,collect:false,stop_on:['hurt','death']})
        return '清理小屋地面和入口'
      }
    }
    m.hut.prepared = true
    save()
  }
  const cells = hutBlueprint({ center: new Vec3(...m.hut.center), front: new Vec3(0, 0, 1), supports: m.hut.supports || [] })
  if (deferLight) while (cells[m.hut.index]?.block==='wall_torch') m.hut.index++
  const cell = cells[m.hut.index]
  if (!cell) {
    m.hut.complete = true
    save()
    return false
  }
  const pos = cell.position.toArray()
  if (dist(a.here(), pos) > 5) await a.move(pos, 3)
  if (pos[1] === m.hut.center[1]) {
    const supports = [pos]
    if (cell.pair?.y === pos[1]) supports.push(cell.pair.toArray())
    for (const foot of supports)
      if (await repairFoundation(a,foot)) return '修补小屋地基'
  }
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
    if (clearable.test(current.name)) {
      await a.call('dig', { pos, collect: false, stop_on: ['hurt', 'death'] })
      return '清理小屋施工植被'
    }
    if (!AIR.has(current.name)) throw Error('小屋施工位置被占用 ' + pos.join(',') + ' ' + current.name)
    if (cell.look) {
      const stand = add(pos,cell.look.scaled(-2).toArray())
      if (cell.block === 'wooden_door' && (!baseGround.test((await a.block(add(stand,[0,-1,0]))).name) ||
          !AIR.has((await a.block(stand)).name))) {
        await a.move(add(pos,cell.look.scaled(-1).toArray()),0)
      } else await a.move(stand,0)
    }
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
const { followRecordedExit } = require('./nmo-return')

async function climbBackForSupplies(a, m, save, log) {
  const journal = process.env.MC_NMO_RETURN_JOURNAL
  if (!journal) return a.stair(m.anchor[1])
  const route = m.workshopReturn ??= {}
  await followRecordedExit(a, route, m.anchor, save, log, journal, '已沿原路回到施工地面')
  if (route.reachedBuildSurface) {
    delete m.workshopReturn
    save()
  }
}

async function repairFoundation(a, pos) {
  const gap = []
  for (const depth of [1,2,3,4]) {
    const p = add(pos,[0,-depth,0])
    const floor = await a.block(p)
    if (baseGround.test(floor.name)) break
    if (!AIR.has(floor.name)) return false
    gap.push(p)
    if (depth===4) return false
  }
  if (!gap.length) return false
  const stone = ['cobblestone','cobbled_deepslate','dirt'].find(item=>a.count(item))
  if (!stone) await a.gather('cobble')
  else await a.placeAt(stone,gap.at(-1))
  return true
}

async function baseStep(a, m, save, log, expeditionStep) {
  if (!m.unlocked) {
    const surface = m.surface
    if (!m.reachedBuildSurface && surface && dist(a.here(), surface) > 8) {
      const trail = process.env.MC_NMO_RETURN_JOURNAL
      if (trail) {
        await followRecordedExit(a,m,surface,save,log,trail)
        return '沿实际矿道返程'
      }
      await a.move(surface, 3)
      return
    }
    m.unlocked = true
    delete m.returnTrail
    save()
  }
  if (m.trip) {
    await expedition(a, m, save)
    return
  }
  if (m.workshopReturn && m.anchor && a.here()[1] >= m.anchor[1] - 3) {
    delete m.workshopReturn
    save()
  }
  if (expeditionStep && m.switchChecked && m.hut?.complete) return expeditionStep(a, m, save)
  if (!m.anchor) {
    const anchor = await chooseSite(a, m, save, log)
    if (!anchor) return '分区核对基地地形'
    m.anchor = anchor
    save()
  }
  if (dist(a.here(),m.anchor)<16 && await a.recoverValuableDrops?.({names:['diamond']}))
    return '追回基地附近掉落的备用钻石'
  if (a.count('diamond') > 0) {
    const storage = location(m.anchor, 'storage')
    if ((await a.block(storage)).name === 'barrel') {
      if (dist(a.here(), storage) > 5) {
        await a.move(storage, 2)
        return '将备用钻石带到基地储物桶'
      }
      const target = { pos: storage }
      await a.call('window/act', { target, ops: [{ op: 'put', to: 'container', item: 'diamond', count: a.count('diamond') }] })
      const { sections } = await a.call('window/view', { target })
      m.diamondsBanked = sections.container.reduce((count, stack) => count + (stack.name === 'diamond' ? stack.count : 0), 0)
      save()
      log('核验基地储物桶内备用钻石 × ' + m.diamondsBanked)
      return '优先存放备用钻石'
    }
  }
  if (a.inventory.empty_slots < 2) {
    const excess = ['cobblestone','cobbled_deepslate'].find(item => a.count(item) >= 128)
    const storage = location(m.anchor, 'storage')
    if (excess && (await a.block(storage)).name === 'barrel') {
      if (dist(a.here(),storage) > 5) {
        await a.move(storage,2)
        return '先回储物桶腾出合成空间'
      }
      const target = { pos: storage }
      try {
        await a.call('window/act', { target, ops: [{ op:'put', to:'container', item:excess, count:64 }] })
        await a.refresh()
        return '存放富余石料，继续施工'
      } catch (error) {
        if (error.code !== 'inventory_full' && error.code !== 'no_room') throw error
      }
    }
  }
  if (m.needed) {
    if (expeditionStep && m.hut && m.needed==='wall_torch') {
      delete m.needed
      save()
      return '先装好小屋门，再完成照明'
    }
    const underground = a.here()[1] < m.anchor[1] - 3
    const smeltReady = m.needed === 'hopper' && a.count('iron_ingot') + a.count('raw_iron') >= 5 &&
      (a.count('iron_ingot') >= 5 || a.count('coal') + a.count('charcoal') > 0)
    const surfaceMaterial = ['planks','wooden_door','wooden_slab','crafting_table','chest','barrel','bed','glass','torch','wall_torch']
      .includes(m.needed) || smeltReady || (m.needed === 'redstone_torch' && a.count('redstone') > 0)
    if (underground && surfaceMaterial) {
      await climbBackForSupplies(a, m, save, log)
      return '回地面采集施工材料'
    }
    const slabStock = m.needed==='wooden_slab' && m.hut
      ? Math.min(12,hutBlueprint({center:new Vec3(...m.hut.center),front:new Vec3(0,0,1),supports:m.hut.supports||[]})
        .slice(m.hut.index).filter(cell=>cell.block==='wooden_slab').length)
      : 1
    if (!(await material(a, m.needed,Math.max(1,slabStock)))) return
    delete m.needed
    save()
  }
  const atHut = m.switchChecked && m.hut && dist(a.here(),m.hut.center) <= 8
  if (dist(a.here(), m.anchor) > 7 && !atHut) {
    if (a.here()[1] < m.anchor[1] - 3) {
      await climbBackForSupplies(a, m, save, log)
      return '携带材料沿矿道回基地'
    }
    await a.move(m.anchor, 3)
    return
  }
  for (const piece of parts) {
    const pos = add(m.anchor, piece.offset),
      current = await a.block(pos)
    if (fits(piece, current)) continue
    if (clearable.test(current.name)) {
      await a.call('dig', { pos, collect: false, stop_on: ['hurt', 'death'] })
      return '清理基地工地植被'
    }
    if (!AIR.has(current.name))
      throw Error('基地施工受阻 ' + piece.id + ' ' + pos.join(',') + ' 当前方块 ' + current.name)
    if (piece.offset[1]===0 && await repairFoundation(a,pos)) return '修补工坊地基'
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
  if (expeditionStep) {
    const building = await hutStep(a, m, save, true)
    if (building) return typeof building === 'string' ? building : '逐块搭建 5×5 小屋'
    if (m.hut?.complete) return expeditionStep(a, m, save)
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
module.exports = { baseStep, fits, climbBackForSupplies }
