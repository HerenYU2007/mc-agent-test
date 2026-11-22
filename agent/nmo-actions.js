// All world observations and actions go through the competition HTTP API.
const { LOG_NAMES, STONE_TARGETS } = require('./config')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const DANGER = /water|lava|bubble_column|magma|campfire|cactus|powder_snow|fire$/
const SOFT = /^(dirt|grass_block|gravel|andesite|diorite|granite|tuff|stone|deepslate|netherrack|sandstone)$/
const FOOD =
  /^(bread|cooked_.+|apple|carrot|baked_potato|sweet_berries|melon_slice|beef|mutton|porkchop|cod|salmon)$/
const DELTAS = [
  [1, 0, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, 0, -1],
]
const ORES = {
  wood: [...LOG_NAMES],
  stone: [...STONE_TARGETS],
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
}
const add = (a, b) => a.map((v, i) => v + b[i])
const dist = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))
const gearRank = (name) =>
  ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'].indexOf(name.split('_')[0])
const recoverable = new Set([
  'path_not_found',
  'stalled',
  'out_of_reach',
  'not_loaded',
  'nothing_to_dig',
  'undiggable',
  'dig_unconfirmed',
  'protected_region',
  'timeout',
  'path_timeout',
  'no_support',
  'occupied',
  'place_failed',
])
function actions(api, memory, save, log) {
  let status,
    inventory,
    cooldown = new Map(),
    direction = 0
  const call = (name, body) => api.call(name, body)
  async function refresh() {
    ;[status, inventory] = await Promise.all([call('status'), call('inventory')])
  }
  const count = (name) => inventory.items.reduce((v, i) => v + (i.name === name ? i.count : 0), 0)
  const sum = (predicate) => inventory.items.reduce((v, i) => v + (predicate(i.name) ? i.count : 0), 0)
  const has = (name) =>
    !!count(name) || [...Object.values(inventory.armor || {}), inventory.offhand].some((i) => i?.name === name)
  const tool = (kind) =>
    inventory.items
      .filter((i) => i.name.endsWith('_' + kind))
      .sort((a, b) => gearRank(b.name) - gearRank(a.name))[0]?.name
  const here = () => status.pos.map(Math.floor)
  const block = (pos) => call('get_block', { pos })
  const find = async (types, radius = 32, limit = 24, opts = {}) =>
    (await call('find_blocks', { types, radius, limit, ...opts })).blocks
  const move = (pos, range = 2) => call('move_to', { pos, range, timeout: 9000 })
  const equip = (item, slot = 'hand') => call('equip', { item, slot })
  async function craft(item, quantity = 1) {
    const before = count(item)
    await call('craft', { item, count: quantity })
    await refresh()
    if (count(item) <= before) throw Error('合成后未在背包确认 ' + item)
    log('已合成 ' + item + ' × ' + (count(item) - before))
  }
  async function explore(away) {
    const floor = here(),
      choices = DELTAS.map((_, i) => DELTAS[(direction + i) % 4])
    direction = (direction + 1) % 4
    if (away) choices.sort((a, b) => dist(add(floor, b), away) - dist(add(floor, a), away))
    for (const v of choices) {
      for (const steps of [8, 4, 2]) {
        const x = floor[0] + steps * v[0],
          z = floor[2] + steps * v[2]
        for (const dy of [0, 1, -1, 2, -2]) {
          const pos = [x, floor[1] + dy, z]
          const [below, feet, head] = await Promise.all(
            [
              [0, -1, 0],
              [0, 0, 0],
              [0, 1, 0],
            ].map((off) => block(add(pos, off))),
          )
          if (AIR.has(below.name) || DANGER.test(below.name) || !AIR.has(feet.name) || !AIR.has(head.name))
            continue
          try {
            await move(pos, 1)
            return true
          } catch (e) {
            if (!recoverable.has(e.code)) throw e
          }
        }
      }
    }
    return false
  }
  async function stair(targetY) {
    const start = here(),
      rise = Math.sign(targetY - start[1])
    if (!rise) return explore()
    const pick = tool('pickaxe')
    if (pick) await equip(pick)
    for (let i = 0; i < 4; i++) {
      const v = DELTAS[(direction + i) % 4],
        next = add(start, [v[0], rise, v[2]])
      const floor = await block(add(next, [0, -1, 0]))
      if (AIR.has(floor.name) || DANGER.test(floor.name) || /sand$|gravel/.test(floor.name)) continue
      const cells = [add(next, [0, 1, 0]), next]
      if (rise < 0) cells.unshift(add(next, [0, 2, 0]))
      if (rise > 0) cells.unshift(add(start, [0, 2, 0]))
      const queried = await Promise.all(cells.map(block))
      if (queried.some((b) => !AIR.has(b.name) && (!SOFT.test(b.name) || !b.diggable))) continue
      const neighbors = await Promise.all(
        DELTAS.flatMap((off) => [next, add(next, [0, 1, 0])].map((p) => block(add(p, off)))),
      )
      if (neighbors.some((b) => DANGER.test(b.name))) continue
      try {
        for (const b of queried) if (!AIR.has(b.name)) await call('dig', { pos: b.pos, collect: false })
        await move(next, 0)
        direction = (direction + i) % 4
        return true
      } catch (e) {
        if (!recoverable.has(e.code)) throw e
      }
    }
    return explore()
  }
  async function gather(kind) {
    const targetNames = ORES[kind],
      before = here(),
      selected = tool(kind === 'wood' ? 'axe' : 'pickaxe')
    if (selected) await equip(selected)
    for (const [key, end] of cooldown) if (end <= Date.now()) cooldown.delete(key)
    const targets = await find(targetNames, kind === 'wood' ? 56 : 32, 40)
    for (const b of targets) {
      const key = b.pos.join(',')
      if (cooldown.has(key) || (b.pos[0] === before[0] && b.pos[2] === before[2] && b.pos[1] <= before[1]))
        continue
      if (kind === 'wood' && b.pos[1] > before[1] + 5) continue
      try {
        if (!targetNames.includes((await block(b.pos)).name)) continue
        if (
          kind !== 'wood' &&
          (await Promise.all(DELTAS.map((v) => block(add(b.pos, v))))).some((k) => DANGER.test(k.name))
        )
          continue
        const res = await call('dig', { pos: b.pos, collect: true, timeout: 8500 })
        cooldown.set(key, Date.now() + 15000)
        if (res.interrupted_by) return false
        await refresh()
        log('采集 ' + b.name + ' ' + key)
        return true
      } catch (e) {
        if (!recoverable.has(e.code)) throw e
        cooldown.set(key, Date.now() + 90000)
      }
    }
    if (kind === 'wood') return here()[1] < 56 ? stair(80) : explore()
    return stair({ stone: 52, coal: 60, iron: 18, redstone: -48, diamond: -53 }[kind])
  }
  async function ensurePlanks(quantity) {
    if (sum((n) => n.endsWith('_planks')) >= quantity) return true
    const wood = inventory.items.find((i) => LOG_NAMES.has(i.name))
    if (!wood) {
      await gather('wood')
      return false
    }
    await craft(
      wood.name.replace(/_log$/, '_planks'),
      Math.min(wood.count * 4, quantity - sum((n) => n.endsWith('_planks'))),
    )
    return sum((n) => n.endsWith('_planks')) >= quantity
  }
  async function ensureSticks(n) {
    if (count('stick') >= n) return true
    if (!(await ensurePlanks(2))) return false
    await craft('stick', n - count('stick'))
    return count('stick') >= n
  }
  async function station(item) {
    if (memory[item]) {
      const pos = memory[item]
      if (dist(here(), pos) > 4) await move(pos)
      if ((await block(pos)).name === item) return pos
      delete memory[item]
      save()
    }
    if (!count(item)) {
      if (item === 'crafting_table') {
        if (!(await ensurePlanks(4))) return null
      } else {
        if (count('cobblestone') + count('cobbled_deepslate') < 8) {
          await gather('stone')
          return null
        }
        if (!(await station('crafting_table'))) return null
      }
      await craft(item)
    }
    // The server selects a supported empty cell; only reclaim the position it confirms placing.
    const placed = await call('place', { item })
    if (!Array.isArray(placed.pos) || placed.placed !== item) throw Error('无法确认放置 ' + item)
    memory[item] = placed.pos
    save()
    return placed.pos
  }
  async function reclaim(item) {
    const pos = memory[item]
    if (!pos) return true
    if (dist(here(), pos) > 4) await move(pos)
    if ((await block(pos)).name === item) {
      if (item === 'furnace') {
        const v = await call('window/view', { target: { pos } })
        if (Object.values(v.sections).some((section) => section.length)) return false
        const pick = tool('pickaxe')
        if (!pick) return false
        await equip(pick)
      }
      const before = count(item)
      const r = await call('dig', { pos, collect: true })
      await refresh()
      if (r.interrupted_by) return false
      if (count(item) <= before) {
        await move(pos, 0)
        await refresh()
      }
      if (count(item) <= before) return false
    }
    delete memory[item]
    save()
    return true
  }
  async function smelt(raw, fuel) {
    const pos = await station('furnace')
    if (!pos) return
    const target = { pos },
      v = await call('window/view', { target })
    const op = (ops) => call('window/act', { target, ops })
    if (v.sections.output.length) {
      await op([{ op: 'take', from: 'output' }])
      await refresh()
      return
    }
    if (v.sections.input.length) {
      if (!v.info.burning && !v.sections.fuel.length && fuel)
        await op([{ op: 'put', item: fuel, count: 1, to: 'fuel' }])
      return
    }
    if (!raw) {
      if (v.sections.fuel.length) await op([{ op: 'take', from: 'fuel' }])
      await reclaim('furnace')
      return
    }
    if (!fuel && !v.info.burning && !v.sections.fuel.length) return
    const ops = [{ op: 'put', item: raw, count: Math.min(count(raw), 8), to: 'input' }]
    if (fuel && !v.sections.fuel.length && !v.info.burning)
      ops.push({ op: 'put', item: fuel, count: 1, to: 'fuel' })
    await op(ops)
  }
  async function food() {
    const edible = inventory.items.find((i) => FOOD.test(i.name))
    if (edible && status.food < 20) {
      await call('use_item', { item: edible.name })
      return
    }
    const animals = (await call('get_entities', { types: ['animal'], radius: 40 })).entities
    const animal = animals.find((i) =>
      ['cow', 'pig', 'sheep', 'rabbit', 'chicken', 'salmon', 'cod'].includes(i.name),
    )
    if (animal) {
      await call('attack', { entity_id: animal.id, timeout: 9000 })
      return
    }
    const crops = await find(['sweet_berry_bush', 'wheat', 'carrots', 'potatoes'], 32, 6, { mature: true })
    if (crops.length) {
      await call('dig', { pos: crops[0].pos, collect: true })
      return
    }
    if (count('wheat') >= 3) {
      if (await station('crafting_table')) await craft('bread')
      return
    }
    if (here()[1] < 60) await stair(76)
    else await explore()
  }
  async function safety() {
    if (status.submerged && status.oxygen < 12) {
      await call('posture', { jump: true })
      return true
    }
    if (status.jumping && !status.in_water) await call('posture', { jump: false })
    const enemy = status.nearest_hostile
    if (!enemy || enemy.dist > 8) return false
    if (enemy.name === 'creeper' || status.health < 12 || !tool('sword')) {
      const entities = (await call('get_entities', { types: ['hostile'], radius: 16 })).entities
      await explore(entities.find((x) => x.id === enemy.id)?.pos)
    } else {
      await equip(tool('sword'))
      await call('attack', { entity_id: enemy.id, max_hits: 2, timeout: 3500 })
    }
    return true
  }
  return {
    call,
    refresh,
    count,
    sum,
    has,
    here,
    block,
    find,
    move,
    craft,
    equip,
    tool,
    explore,
    stair,
    gather,
    ensurePlanks,
    ensureSticks,
    station,
    reclaim,
    smelt,
    food,
    safety,
    get status() {
      return status
    },
    get inventory() {
      return inventory
    },
  }
}
module.exports = { actions, add, dist, AIR, FOOD, ORES, recoverable }
