// All world observations and actions go through the competition HTTP API.
const { createMovement } = require('./nmo-movement')
const { createOreSurvey } = require('./nmo-ore-survey')
const { createDefense } = require('./nmo-defense')
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
  cobble: ['stone'],
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
  'movement_interrupted',
  'move_unconfirmed',
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
function actions(api, memory, save, log, chooseTarget, { volumeScan = false } = {}) {
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
    !!count(name) ||
    [...Object.values(inventory.armor || {}), inventory.offhand].some((i) => i?.name === name)
  const tool = (kind) =>
    inventory.items
      .filter((i) => i.name.endsWith('_' + kind))
      .sort((a, b) => gearRank(b.name) - gearRank(a.name))[0]?.name
  const here = () => status.pos.map(Math.floor)
  const block = (pos) => call('get_block', { pos })
  const find = async (types, radius = 32, limit = 24, opts = {}) =>
    (await call('find_blocks', { types, radius, limit, ...opts })).blocks
  const move = createMovement(call)
  const defense = createDefense(call)
  let survey
  async function prospect(kind, names) {
    const origin = here()
    if (
      !survey ||
      survey.kind !== kind ||
      survey.dimension !== status.dimension ||
      dist(origin, survey.origin) > 4
    ) {
      survey = {
        origin,
        kind,
        dimension: status.dimension,
        found: new Map(),
        scan: createOreSurvey(origin, names),
      }
    }
    const part = await survey.scan(block, { budget: 72 })
    for (const b of part.found) survey.found.set(b.pos.join(','), b)
    const found = [...survey.found.values()]
      .map((b) => ({ ...b, dist: dist(b.pos, origin) }))
      .sort((a, b) => a.dist - b.dist)
    const pending = !part.done
    if (!pending) survey = null
    return { found, pending }
  }
  const equip = (item, slot = 'hand') => call('equip', { item, slot })
  async function craft(item, quantity = 1) {
    const before = count(item)
    await call('craft', { item, count: quantity })
    await refresh()
    if (count(item) <= before) throw Error('合成后未在背包确认 ' + item)
    log('已合成 ' + item + ' × ' + (count(item) - before))
  }
  async function prioritize(objective, entries, describe) {
    if (!chooseTarget || entries.length < 2) return entries
    const origin = here()
    const health = status.health
    const options = entries.slice(0, 12).map(describe)
    const choice = await chooseTarget({ objective, position: origin, health, food: status.food, options })
    if (choice === undefined) return entries
    const fresh = await call('status')
    if (
      !fresh.ready ||
      fresh.alive === false ||
      fresh.busy ||
      fresh.gamemode !== 'survival' ||
      fresh.dimension !== status.dimension ||
      fresh.health < health ||
      fresh.nearest_hostile?.dist <= 8 ||
      dist(fresh.pos, origin) > 3
    )
      return []
    if (choice === null || choice === 0) return entries
    return [entries[choice], ...entries.filter((_, i) => i !== choice)]
  }
  async function explore(away) {
    const floor = here()
    let choices = DELTAS.map((_, i) => DELTAS[(direction + i) % 4])
    direction = (direction + 1) % 4
    if (away) choices.sort((a, b) => dist(add(floor, b), away) - dist(add(floor, a), away))
    if (!away) choices = await prioritize('explore', choices, (direction) => ({ direction }))
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
            const moved = await move(pos, 1)
            if (chooseTarget && moved?.pos) log('探索移动至 ' + moved.pos.join(','))
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

  async function guardedDig(pos, collect) {
    const unsafe = async () => {
      const [s, mobs] = await Promise.all([
        call('status'),
        call('get_entities', { types: ['hostile'], radius: 36 }),
      ])
      return (
        !s.ready ||
        !s.alive ||
        s.dimension !== status.dimension ||
        mobs.entities.some((e) => dist(e.pos, pos) <= 8 || dist(e.pos, s.pos) <= 8)
      )
    }
    if (await unsafe()) throw Object.assign(Error('矿点附近有怪物'), { code: 'movement_interrupted' })
    let active = true,
      interrupted = false
    const monitor = (async () => {
      while (active) {
        await new Promise((resolve) => setTimeout(resolve, 120))
        if (!active) return
        if (await unsafe()) {
          interrupted = true
          if (active && (await call('status')).busy === 'dig') await call('stop', {})
          return
        }
      }
    })().catch(() => {
      interrupted = true
    })
    try {
      const result = await call('dig', { pos, collect, timeout: 8500 })
      if (interrupted || result.interrupted_by)
        throw Object.assign(Error('采矿中断'), { code: 'movement_interrupted' })
      return result
    } finally {
      active = false
      await monitor
    }
  }
  async function reachSeam(target) {
    const feet = here(),
      eye = [status.pos[0], status.pos[1] + 1.62, status.pos[2]]
    const aim = target.map((v) => v + 0.5)
    const length = dist(eye, aim)
    const keys = new Set()
    let obstructed = false
    for (let k = 0.18; k < length; k += 0.3) {
      const p = eye.map((v, i) => Math.floor(v + ((aim[i] - v) * k) / length))
      if (p.every((v, i) => v === target[i])) break
      const key = p.join(',')
      if (keys.has(key)) continue
      keys.add(key)
      if (!AIR.has((await block(p)).name)) {
        obstructed = true
        break
      }
    }
    if (!obstructed && length <= 2.8) return 'reachable'
    if (!obstructed && length <= 4.4 && target[1] < feet[1]) return 'reachable'
    const rise = Math.max(-1, Math.min(1, target[1] - feet[1] - (target[1] > feet[1] ? 1 : 0)))
    const candidates = DELTAS.map((d) => add(feet, [d[0], rise, d[2]])).sort(
      (a, b) => dist(a, target) - dist(b, target),
    )
    for (const next of candidates) {
      if (next.every((v, i) => v === target[i]) || dist(next, target) >= dist(feet, target)) continue
      const support = await block(add(next, [0, -1, 0]))
      if (
        !SOFT.test(support.name) &&
        !['cobblestone', 'bedrock', 'cobbled_deepslate', 'sea_lantern'].includes(support.name)
      )
        continue
      const cells = [add(next, [0, 1, 0]), next]
      if (rise > 0) cells.unshift(add(feet, [0, 2, 0]))
      if (rise < 0) cells.unshift(add(next, [0, 2, 0]))
      const blocks = await Promise.all(cells.map(block))
      if (blocks.some((b) => !AIR.has(b.name) && (!b.diggable || !SOFT.test(b.name)))) continue
      const borders = await Promise.all(
        cells.flatMap((p) => [...DELTAS, [0, 1, 0], [0, -1, 0]].map((d) => block(add(p, d)))),
      )
      if (borders.some((b) => DANGER.test(b.name) || /^(sand|gravel|red_sand)$/.test(b.name))) continue
      for (const b of blocks) if (!AIR.has(b.name)) await guardedDig(b.pos, false)
      await move(next, 0)
      return 'approaching'
    }
    return 'blocked'
  }

  async function gather(kind) {
    const targetNames = ORES[kind],
      before = here(),
      selected = tool(kind === 'wood' ? 'axe' : 'pickaxe')
    if (selected && status.held?.name !== selected) await equip(selected)
    for (const [key, end] of cooldown) if (end <= Date.now()) cooldown.delete(key)
    const isOre = ['iron', 'coal', 'redstone', 'diamond'].includes(kind)
    const scan = isOre && volumeScan ? await prospect(kind, targetNames) : null
    const found = scan ? scan.found : await find(targetNames, kind === 'wood' ? 56 : 32, 40)
    const monsters =
      isOre && found.length ? (await call('get_entities', { types: ['hostile'], radius: 48 })).entities : []
    const threatensRoute = (pos, enemy) => {
      const delta = pos.map((v, i) => v - before[i])
      const length = delta.reduce((n, v) => n + v * v, 0)
      const t = length
        ? Math.max(0, Math.min(1, delta.reduce((n, v, i) => n + v * (enemy[i] - before[i]), 0) / length))
        : 0
      return (
        dist(
          before.map((v, i) => v + t * delta[i]),
          enemy,
        ) <= 8
      )
    }
    const candidates = found.filter(({ pos }) => {
      if (cooldown.has(pos.join(',')) || monsters.some((e) => threatensRoute(pos, e.pos))) return false
      if (pos[0] === before[0] && pos[2] === before[2] && (kind !== 'wood' || pos[1] <= before[1]))
        return false
      return kind !== 'wood' || pos[1] <= before[1] + 5
    })
    const targets = await prioritize(kind, candidates, ({ name, pos, dist }) => ({
      name,
      pos,
      distance: dist,
    }))
    if (candidates.length && !targets.length) return false
    for (const b of targets) {
      const key = b.pos.join(',')
      try {
        if (!targetNames.includes((await block(b.pos)).name)) continue
        if (
          kind !== 'wood' &&
          (await Promise.all(DELTAS.map((v) => block(add(b.pos, v))))).some((k) => DANGER.test(k.name))
        )
          continue
        if (isOre) {
          const progress = await reachSeam(b.pos)
          if (progress === 'approaching') return false
          if (progress === 'blocked') {
            cooldown.set(key, Date.now() + 30000)
            continue
          }
        }
        const res = isOre
          ? await guardedDig(b.pos, true)
          : await call('dig', { pos: b.pos, collect: true, timeout: 8500 })
        cooldown.set(key, Date.now() + 15000)
        if (res.interrupted_by) return false
        await refresh()
        log(
          '采集 ' +
            b.name +
            ' ' +
            key +
            (chooseTarget && res.gained ? '，背包增量 ' + JSON.stringify(res.gained) : ''),
        )
        return true
      } catch (e) {
        if (!recoverable.has(e.code)) throw e
        cooldown.set(key, Date.now() + 90000)
      }
    }
    if (scan?.pending) return false
    if (kind === 'wood') return here()[1] < 56 ? stair(80) : explore()
    return stair({ stone: 52, cobble: 56, coal: 60, iron: 18, redstone: -48, diamond: -53 }[kind])
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
  async function placeAt(item, pos) {
    try {
      return await call('place', { item, pos })
    } catch (error) {
      if (error.code !== 'blocked_by_self') throw error
    }
    await refresh()
    const feet = here()
    for (const side of DELTAS) {
      const step = add(feet, side)
      const [floor, body, head] = await Promise.all(
        [
          [0, -1, 0],
          [0, 0, 0],
          [0, 1, 0],
        ].map((v) => block(add(step, v))),
      )
      if (AIR.has(floor.name) || DANGER.test(floor.name) || !AIR.has(body.name) || !AIR.has(head.name))
        continue
      try {
        await move(step, 0)
        return await call('place', { item, pos })
      } catch (e) {
        if (e.code !== 'blocked_by_self' && !recoverable.has(e.code)) throw e
      }
    }
    throw Object.assign(Error('施工格被角色占用，附近没有可站立的空位'), { code: 'stalled' })
  }
  async function station(item) {
    if (memory[item]) {
      const pos = memory[item]
      if (dist(here(), pos) > 4) await move(pos)
      if ((await block(pos)).name === item) return pos
      delete memory[item]
      save()
    }
    if (item === 'crafting_table' && memory.anchor) {
      const depot = add(memory.anchor, [-2, 0, -1])
      if (dist(here(), depot) <= 12 && (await block(depot)).name === 'crafting_table') return depot
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
        const view = await call('window/view', { target: { pos } })
        if (Object.values(view.sections).some((section) => section.length)) return false
        const pick = tool('pickaxe')
        if (!pick) return false
        await equip(pick)
      }
      if (!memory.pickup) {
        memory.pickup = { item, before: count(item), attempts: 0 }
        save()
      }
      await call('dig', { pos, collect: true })
      await refresh()
      if ((await block(pos)).name === item) return false
    }
    if (memory.pickup?.item === item) {
      const job = memory.pickup
      if (count(item) <= job.before) {
        const { entities } = await call('get_entities', { types: ['item'], radius: 8 })
        const drop = entities.find((e) => e.item?.startsWith(item + 'x') && dist(e.pos, pos) < 4)
        try {
          await move(drop?.pos || pos, 0)
        } catch (e) {
          if (!recoverable.has(e.code)) throw e
        }
        await refresh()
        if (count(item) <= job.before) {
          job.attempts++
          save()
          if (job.attempts < 3) return false
          log('空工作站已拆除，掉落物三次未拾到 ' + item + ' ' + pos.join(','))
        }
      }
      delete memory.pickup
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

  let encounter,
    lastMeal = 0
  async function battleChoice(enemy, weak) {
    const key = String(enemy.id) + (weak ? ':low' : ':ready')
    if (encounter?.key === key) return encounter
    const options = weak ? ['撤往掩体', '拉开距离后进食'] : ['持剑接战', '举盾等待反击']
    const current = { key, choice: options[0] }
    encounter = current
    if (chooseTarget) {
      // The reflex and the first evasive step run immediately while the model chooses the continuation.
      Promise.resolve(
        chooseTarget({
          objective: weak ? '低血撤离与补给' : '应对正在接近的怪物',
          position: status.pos,
          health: status.health,
          food: status.food,
          enemy: enemy.name,
          distance: enemy.dist,
          options,
        }),
      )
        .then((i) => {
          if (encounter === current && Number.isInteger(i) && options[i]) current.choice = options[i]
        })
        .catch(() => {})
    }
    return current
  }
  async function retreat(enemy, position) {
    const s = await call('status'),
      origin = s.pos.map(Math.floor)
    const dirs = [...DELTAS].sort((a, b) => dist(add(origin, b), position) - dist(add(origin, a), position))
    for (const d of dirs) {
      for (const steps of [8, 5, 3]) {
        const goal = origin.map((v, i) => v + d[i] * steps)
        if (dist(goal, position) < enemy.dist + 2) continue
        const [floor, feet, head] = await Promise.all(
          [
            [0, -1, 0],
            [0, 0, 0],
            [0, 1, 0],
          ].map((o) => block(add(goal, o))),
        )
        if (AIR.has(floor.name) || DANGER.test(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name))
          continue
        try {
          await move(goal, 0)
          const updated = await call('status')
          if (updated.alive && dist(s.pos, updated.pos) > 2) return true
        } catch (e) {
          if (!recoverable.has(e.code) && e.code !== 'interrupted') throw e
        }
      }
    }
    return false
  }

  async function safety() {
    if (status.submerged && status.oxygen < 12) {
      await call('posture', { jump: true })
      return true
    }
    if (status.jumping && !status.in_water) await call('posture', { jump: false })
    if (status.in_lava || status.on_fire) {
      const water = (await find(['water'], 16, 8))[0]
      if (water) {
        await move(water.pos, 0)
        return true
      }
    }
    if (status.dimension === 'overworld' && status.velocity?.[1] < -13 && count('water_bucket')) {
      for (const depth of [2, 3]) {
        const landing = add(here(), [0, -depth, 0]),
          floor = await block(landing)
        if (!AIR.has(floor.name) && !DANGER.test(floor.name)) {
          await call('interact', { pos: landing, item: 'water_bucket' })
          return true
        }
      }
    }
    const enemy = status.nearest_hostile
    if (!enemy || enemy.dist > 12) {
      if (
        encounter?.key.endsWith(':low') &&
        status.health < 16 &&
        status.food < 20 &&
        Date.now() - lastMeal > 2000 &&
        inventory.items.some((i) => FOOD.test(i.name))
      ) {
        lastMeal = Date.now()
        await food()
        return true
      }
      encounter = null
      return false
    }
    const weak = status.health < 12 || !tool('sword') || enemy.name === 'creeper'
    const tactical = await battleChoice(enemy, weak)
    const foe = (await call('get_entities', { types: ['hostile'], radius: 20 })).entities.find(
      (e) => e.id === enemy.id,
    )
    if (!foe) return false
    if (weak && (await retreat(enemy, foe.pos))) return true
    if (enemy.name === 'creeper' && has('shield')) {
      await call('look', { entity_id: enemy.id })
      await call('posture', { shield: true, jump: status.jumping })
      return true
    }
    if (has('shield') && /^(skeleton|stray|bogged|pillager)$/.test(enemy.name)) await defense.tick()
    if (defense.guarding()) return true
    if (tactical.choice === '举盾等待反击' && foe.dist > 3 && !defense.counterReady() && has('shield')) {
      await call('look', { entity_id: enemy.id })
      await call('posture', { shield: true, jump: status.jumping })
      return true
    }
    const weapon = tool('sword') || tool('axe')
    if (weapon) await equip(weapon)
    if (status.blocking) await call('posture', { shield: false, jump: status.jumping })
    await call('attack', { entity_id: enemy.id, max_hits: defense.counterReady() ? 1 : 2, timeout: defense.counterReady() ? 650 : 3500 })
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
    placeAt,
    station,
    reclaim,
    smelt,
    food,
    safety,
    startDefense: defense.start,
    get status() {
      return status
    },
    get inventory() {
      return inventory
    },
  }
}
module.exports = { actions, add, dist, AIR, FOOD, ORES, recoverable }
