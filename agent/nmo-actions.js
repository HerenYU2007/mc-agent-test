// All world observations and actions go through the competition HTTP API.
const { createMovement } = require('./nmo-movement')
const { createOreSurvey } = require('./nmo-ore-survey')
const { ORE_KINDS } = require('./nmo-observer-ores')
const { createDefense, clearSight } = require('./nmo-defense')
const { LOG_NAMES, STONE_TARGETS, STONE_DROPS, RUBBLE } = require('./config')
const blocksByName = require('minecraft-data')('1.21.11').blocksByName
const AIR = new Set(['air', 'cave_air', 'void_air'])
const DANGER = /water|lava|bubble_column|magma|campfire|cactus|powder_snow|fire$/
const retreatSpace = ({name,properties}) => blocksByName[name]?.boundingBox === 'empty' &&
  !DANGER.test(name) && !/cobweb|berry_bush|pointed_dripstone/.test(name) && String(properties?.waterlogged) !== 'true'
const retreatFloor = ({name,properties}) => blocksByName[name]?.boundingBox === 'block' &&
  !DANGER.test(name) && String(properties?.waterlogged) !== 'true'
const SOFT = /^(dirt|grass_block|gravel|andesite|diorite|granite|tuff|stone|deepslate|netherrack|sandstone)$/
const isLeaf = name => name.endsWith('_leaves')
const STAIR_STONE = /^(?:calcite|cobblestone|cobbled_deepslate|(?:deepslate_)?(?:iron|coal|copper|gold|redstone|lapis|emerald|diamond)_ore)$/
const FOOD =
  /^(bread|cooked_.+|apple|carrot|baked_potato|sweet_berries|melon_slice)$/
const RAW_FOOD = /^(beef|mutton|porkchop|chicken|rabbit|cod|salmon|potato)$/
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
  ...ORE_KINDS,
}
const ORE_DROPS = {
  coal: 'coal', iron: 'raw_iron', copper: 'raw_copper', gold: 'raw_gold', diamond: 'diamond',
  lapis: 'lapis_lazuli', redstone: 'redstone', emerald: 'emerald', quartz: 'quartz', debris: 'ancient_debris',
}
const ORE_LEVEL = { coal: 60, iron: 18, copper: 48, gold: -16, diamond: -53,
  lapis: 0, redstone: -48, emerald: 100, quartz: 48, debris: 15 }
const REQUIRED_PICK = { coal: 0, iron: 2, copper: 2, gold: 4, diamond: 4,
  lapis: 2, redstone: 4, emerald: 4, quartz: 0, debris: 5 }
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
function actions(api, memory, save, log, chooseTarget, {
  volumeScan = false, observerOres, oreSurveyPending, forgetObserverOre,
  setMineTarget = () => {}, clearMineTarget = () => {},
} = {}) {
  let status,
    inventory,
    cooldown = new Map(),
    direction = 0
  const oreRouteCooldown = new Map()
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
  let stationExit
  let committedOre
  let survey
  const sightCache = new Map()
  async function exposedThreat(origin, foe) {
    const distance = dist(origin, foe.pos)
    const key = [foe.id, status.dimension, ...origin.map(v => Math.floor(v * 2)), ...foe.pos.map(v => Math.floor(v * 2))].join(',')
    const cached = sightCache.get(key)
    if (cached && cached.until > Date.now()) return cached.result
    if (sightCache.size >= 128) sightCache.clear()
    const lowMob = /spider|slime|silverfish|mite/.test(foe.name || '')
    const heights = lowMob ? [0.45, 0.75] : [0.85, 1.45]
    const result = Promise.all(heights.map((height, i) =>
      clearSight(call, add(origin, [0, i ? 1.55 : 1.1, 0]), add(foe.pos, [0, height, 0]))
    )).then(rays => rays.some(Boolean), error => {
      if (error.code === 'not_loaded') return distance <= 3
      throw error
    })
    sightCache.set(key, { until: Date.now() + 420, result })
    return result
  }
  async function nearThreat(origin, foes, radius = 8) {
    const near = foes.filter(foe => dist(origin, foe.pos) <= radius)
    return (await Promise.all(near.map(foe => exposedThreat(origin, foe)))).some(Boolean)
  }
  const eye = () => add(status.pos, [0,1.62,0])
  const center = pos => add(pos, [.5, .5, .5])
  async function directOre(pos) {
    const from = eye(), to = center(pos)
    if (dist(from,to) > 4.35) return false
    if (await clearSight(call, from, to)) return true
    for (const axis of [0,1,2]) {
      if (Math.abs(from[axis] - to[axis]) < 0.5) continue
      const face = [...to]
      face[axis] += Math.sign(from[axis] - to[axis]) * 0.49
      if (dist(from,face) <= 4.35 && await clearSight(call,from,face)) return true
    }
    return false
  }
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
      dist(fresh.pos, origin) > 3
    )
      return []
    if (fresh.nearest_hostile?.dist <= 8) {
      const { entities } = await call('get_entities', { types: ['hostile'], radius: 8 })
      if (await nearThreat(fresh.pos, entities)) return []
    }
    if (choice === null || choice === 0) return entries
    return [entries[choice], ...entries.filter((_, i) => i !== choice)]
  }
  const explorationTrail = new Map()
  const explorationFailures = new Map()
  async function explore(away) {
    const floor = here()
    const dimension = status.dimension
    const now = Date.now()
    for (const [spot, expiry] of explorationFailures) if (expiry <= now) explorationFailures.delete(spot)
    const recent = (explorationTrail.get(dimension) || []).filter(point => point.until > now)
    if (!away) {
      recent.push({ pos: floor, until: now + 100000 })
      if (recent.length > 40) recent.splice(0, recent.length - 40)
      explorationTrail.set(dimension, recent)
    }
    let choices = DELTAS.map((_, i) => DELTAS[(direction + i) % 4])
    direction = (direction + 1) % 4
    if (away) choices.sort((a, b) => dist(add(floor, b), away) - dist(add(floor, a), away))
    if (!away) choices = await prioritize('explore', choices, (direction) => ({ direction }))
    for (const v of choices) {
      for (const steps of away ? [8, 4, 2] : [8, 14, 4, 2]) {
        const x = floor[0] + steps * v[0],
          z = floor[2] + steps * v[2]
        if (!away && recent.some(point => Math.hypot(point.pos[0]-x, point.pos[2]-z) < 2.6)) continue
        for (const dy of [0, 1, -1, 2, -2]) {
          const pos = [x, floor[1] + dy, z]
          const spot = [dimension, ...pos].join(',')
          if (!away && explorationFailures.has(spot)) continue
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
            if (!away && e.code !== 'movement_interrupted') explorationFailures.set(spot, Date.now() + 12000)
          }
        }
      }
    }
    return false
  }
  async function stair(targetY, {exploreIfBlocked = true, openLanding = false} = {}) {
    const start = here(),
      rise = Math.sign(targetY - start[1])
    if (!rise) return exploreIfBlocked ? explore() : false
    const pick = tool('pickaxe')
    if (pick) await equip(pick)
    const headings = DELTAS.map((_, i) => DELTAS[(direction + i) % DELTAS.length])
    const canCut = b => AIR.has(b.name) ||
      (SOFT.test(b.name) || STAIR_STONE.test(b.name) || isLeaf(b.name)) && b.diggable &&
      (!b.name.endsWith('_ore') || b.harvest_tool_ok)
    let unsupported = 0
    for (const v of headings) {
      const next = add(start, [v[0], rise, v[2]])
      const floor = await block(add(next, [0, -1, 0]))
      if (AIR.has(floor.name)) {
        unsupported++
        continue
      }
      if (DANGER.test(floor.name) || /sand$|gravel/.test(floor.name)) continue
      const cells = [add(next, [0, 1, 0]), next]
      if (openLanding) {
        const clearance = await Promise.all([1, 2].map(height => block(add(next, [0, height, 0]))))
        if (!clearance.every(b => AIR.has(b.name))) continue
      }
      if (rise < 0) cells.unshift(add(next, [0, 2, 0]))
      if (rise > 0) cells.unshift(add(start, [0, 2, 0]))
      const queried = await Promise.all(cells.map(block))
      if (!queried.every(canCut)) continue
      const neighbors = await Promise.all(
        [...DELTAS,[0,1,0]].flatMap((off) => cells.map((p) => block(add(p, off)))),
      )
      if (neighbors.some((b) => DANGER.test(b.name) || /^(gravel|sand|red_sand)$/.test(b.name))) continue
      try {
        for (const b of queried) if (!AIR.has(b.name)) await call('dig', { pos: b.pos, collect: false })
        await move(next, 0)
        direction = DELTAS.indexOf(v)
        return true
      } catch (e) {
        if (!recoverable.has(e.code)) throw e
      }
    }
    if (rise < 0 && unsupported === headings.length && pick && status.dimension === 'overworld') {
      const supported = async (pos, depth) => {
        const floor = await block(add(pos, [0, -depth, 0]))
        return retreatFloor(floor) && !/sand$|gravel|dripstone/.test(floor.name)
      }
      for (const heading of headings) {
        const step = add(start, heading)
        if (!await supported(step, 1)) continue
        let connects = false
        for (const span of [2, 3, 4]) {
          const landing = add(start, heading.map(value => value * span))
          if (await supported(landing, 2)) {
            connects = true
            break
          }
          if (!await supported(landing, 1)) break
        }
        if (!connects) continue
        const cells = [add(step, [0, 1, 0]), step]
        const wall = await Promise.all(cells.map(block))
        if (!wall.every(canCut)) continue
        const neighbors = await Promise.all([...DELTAS, [0, 1, 0]]
          .flatMap(offset => cells.map(cell => block(add(cell, offset)))))
        if (neighbors.some(b => DANGER.test(b.name) || /^(gravel|sand|red_sand|pointed_dripstone)$/.test(b.name))) continue
        try {
          for (const b of wall) {
            if (AIR.has(b.name)) continue
            const receipt = await call('dig', { pos: b.pos, collect: false, stop_on: ['hurt', 'death'] })
            if (receipt.interrupted_by) return false
          }
          await move(step, 0)
          direction = DELTAS.indexOf(heading)
          return true
        } catch (error) {
          if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
        }
      }
    }
    return exploreIfBlocked ? explore() : false
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
        (await nearThreat(s.pos, mobs.entities)) ||
        (await nearThreat(center(pos), mobs.entities, 5))
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
  async function reachSeam(target, observed = false) {
    const feet = here(),
      eye = [status.pos[0], status.pos[1] + 1.62, status.pos[2]]
    const aim = target.map((v) => v + 0.5)
    const length = dist(eye, aim)
    if (length <= 2.8 || (length <= 4.4 && target[1] < feet[1])) {
      const cells = new Map()
      for (let k = 0.12; k < length; k += 0.12) {
        const p = eye.map((v, i) => Math.floor(v + ((aim[i] - v) * k) / length))
        if (p.every((v, i) => v === target[i])) break
        cells.set(p.join(','), p)
      }
      const cover = (await Promise.all([...cells.values()].map(block))).filter(b => !AIR.has(b.name))
      if (!cover.length) return 'reachable'
      if (observed && length <= 1.8 && cover.length === 1 && SOFT.test(cover[0].name) && cover[0].diggable &&
          dist(cover[0].pos, add(feet, [0, -1, 0])) > 0) {
        const borders = await Promise.all([...DELTAS, [0, 1, 0], [0, -1, 0]].map(d => block(add(cover[0].pos, d))))
        if (!borders.some(b => DANGER.test(b.name) || /^(gravel|red_sand|sand)$/.test(b.name))) {
          await guardedDig(cover[0].pos, false)
          return 'approaching'
        }
      }
    }
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

  const lootRetry = new Map()
  let lastLootScan = 0
  const itemName = entity => (entity.item || '').replace(/x\d+$/, '').replace(/^minecraft:/, '')
  async function recoverValuableDrops({target=null,names=['diamond','ancient_debris'],quick=false,shallow=false,preferStand=false} = {}) {
    if (status.in_lava || status.on_fire || status.health < 12) return false
    const at=Date.now()
    if (!target && at-lastLootScan<1200) return false
    if (!target) lastLootScan=at
    for (const [id,expiry] of lootRetry) if (expiry<=at) lootRetry.delete(id)
    const {entities}=await call('get_entities',{types:['item'],radius:shallow?6:target?16:quick?8:32})
    const items=entities.filter(item=>names.includes(itemName(item)) && !lootRetry.has(item.id) &&
      (!target || dist(item.pos,center(target))<=6)).slice(0,quick ? 2 : 4)
    if (!items.length) return false
    const {entities:foes}=await call('get_entities',{types:['hostile'],radius:32})
    if (await nearThreat(status.pos,foes)) return false
    for (const item of items) {
      if (await nearThreat(item.pos,foes,6)) continue
      const name=itemName(item)
      const before=count(name)
      const p=item.pos.map(Math.floor)
      const support=name=>SOFT.test(name)||['cobbled_deepslate','cobblestone','basalt','blackstone',
        'soul_soil','nether_bricks','bedrock','tuff','obsidian'].includes(name)
      const points=[p,...DELTAS.flatMap(d=>[0,-1,1].map(y=>add(p,[d[0],y,d[2]])))]
      const nearby=[]
      for (const stand of points) {
        const foot=[stand[0]+0.5,stand[1],stand[2]+0.5]
        if (shallow && Math.abs(stand[1] - here()[1]) > 1) continue
        if (Math.hypot(foot[0]-item.pos[0],foot[2]-item.pos[2])>0.93 ||
            stand[1]>item.pos[1]+0.65 || stand[1]+1.8<item.pos[1]) continue
        const [floor,body,head,...sides]=await Promise.all([
          block(add(stand,[0,-1,0])),block(stand),block(add(stand,[0,1,0])),
          ...DELTAS.map(d=>block(add(stand,d)))
        ])
        if (!support(floor.name)||!AIR.has(body.name)||!AIR.has(head.name)||sides.some(b=>DANGER.test(b.name))) continue
        nearby.push(stand)
      }
      if (!nearby.length) {
        lootRetry.set(item.id,at+7500)
        continue
      }
      const collision=nearby[0]
      try {
        if (preferStand) await call('move_to',{pos:collision,range:0.25,timeout:1600,stop_on:['hurt','death']})
        else if (collision.every((v,i)=>v===p[i])) {
          try {
            await call('move_to',{entity_id:item.id,range:0.35,timeout:quick ? 1500 : 3800})
          } catch(e) {
            if (!recoverable.has(e.code) && e.code!=='no_such_entity') throw e
          }
        } else if (quick) await call('move_to',{pos:collision,range:0.25,timeout:1500})
        else await move(collision,0)
      } catch(e) {
        if (!recoverable.has(e.code)) throw e
      }
      for (let i=0;i<4;i++) {
        await refresh()
        const gained=count(name)-before
        if (gained>0) {
          log('追回掉落 '+name+' × '+gained+'，原实体 '+item.id+'，坐标 '+item.pos.join(','))
          return true
        }
        if (!quick && i===1 && collision.every((v,index)=>v===p[index]) && dist(status.pos,item.pos)>0.7) {
          try {await move(collision,0)} catch(e) {if(!recoverable.has(e.code))throw e}
        }
        await new Promise(resolve=>setTimeout(resolve,120))
      }
      lootRetry.set(item.id,at+9000)
    }
    return false
  }

  async function approachOreDrop(target, drops) {
    const entities = (await call('get_entities', { types: ['item','hostile'], radius: 16 })).entities
    const item = entities.find(e => drops.includes(itemName(e)) &&
      dist(e.pos, target.map(v => v + 0.5)) < 3)
    if (!item) return
    const foes = entities.filter(e => e.type === 'hostile')
    if ((await nearThreat(status.pos, foes)) || (await nearThreat(item.pos, foes, 5))) return
    const feet = here()
    const pos = item.pos.map(Math.floor)
    if (Math.abs(pos[1] - feet[1]) > 1 || dist(feet, pos) > 5) return
    // Cut a level access into a low ledge so the drop can fall into the corridor.
    // Never remove support beneath the Bot or open a liquid or gravel pocket.
    const stand = [pos[0], Math.min(pos[1], feet[1]), pos[2]]
    if (stand[0] === feet[0] && stand[2] === feet[2] && stand[1] < feet[1]) return
    const support = await block(add(stand, [0,-1,0]))
    if (!SOFT.test(support.name) && !['bedrock','cobbled_deepslate','cobblestone','sea_lantern'].includes(support.name)) return
    const cells = [stand, add(stand,[0,1,0])]
    for (const cell of cells) {
      const around = await Promise.all([...DELTAS,[0,1,0],[0,-1,0]].map(d => block(add(cell,d))))
      if (around.some(b => DANGER.test(b.name) || /^(gravel|red_sand|sand)$/.test(b.name))) return
      const b = await block(cell)
      if (!AIR.has(b.name) && (!SOFT.test(b.name) || !b.diggable || dist(status.pos,cell)>4)) return
    }
    for (const cell of cells) {
      if (!AIR.has((await block(cell)).name)) await guardedDig(cell,false)
    }
    await move(stand,0)
  }

  let missedStone
  async function gather(kind, { nearby = false, recoverDrops = !nearby, within } = {}) {
    if (kind==='wood' && recoverDrops && !nearby &&
        await recoverValuableDrops({names:[...LOG_NAMES],quick:true,preferStand:true})) return true
    const targetNames = ORES[kind],
      before = here(),
      selected = tool(kind === 'wood' ? 'axe' : 'pickaxe')
    if (selected && status.held?.name !== selected) await equip(selected)
    for (const [key, end] of cooldown) if (end <= Date.now()) cooldown.delete(key)
    for (const [key, end] of oreRouteCooldown) if (end <= Date.now()) oreRouteCooldown.delete(key)
    const isOre = Object.hasOwn(ORE_KINDS, kind)
    const basicStone = kind === 'stone' || kind === 'cobble'
    const stoneStand = before.join(',')
    if (basicStone && !nearby && missedStone?.stand === stoneStand && missedStone.attempts >= 2) {
      missedStone = undefined
      return stair(before[1] - 1)
    }
    const nearbyOres = isOre ? await find(targetNames, 7, 32) : []
    const reports = isOre ? (observerOres?.(status, targetNames) || []).filter(point =>
      !nearby || dist(center(point.pos), status.pos) <= 5.5) : []
    const hints = reports.filter(b => !cooldown.has(b.pos.join(',')))
    const pending = isOre && !hints.length && oreSurveyPending?.()
    const scan = isOre && !nearby && !hints.length && !pending && volumeScan ? await prospect(kind, targetNames) : null
    const remote = nearby ? (isOre ? hints : await find(targetNames, 6, 18))
      : pending ? [] : hints.length ? hints : scan ? scan.found
      : await find(targetNames, kind === 'wood' ? 56 : basicStone ? 12 : 32, 40)
    const distinct = new Map(remote.map(point => [point.pos.join(','), point]))
    for(const entry of nearbyOres) distinct.set(entry.pos.join(','), {...entry,exposed:true})
    const found = [...distinct.values()]
    const monsters = (isOre || basicStone) && found.length
      ? (await call('get_entities', { types: ['hostile'], radius: 48 })).entities : []
    const danger = async (pos) => {
      if (!monsters.length) return false
      const delta = pos.map((v, i) => v - before[i])
      const length = delta.reduce((n, v) => n + v * v, 0)
      const near = monsters.filter(enemy => {
        const t = length ? Math.max(0, Math.min(1, delta.reduce((n,v,i)=>n+v*(enemy.pos[i]-before[i]),0)/length)) : 0
        return dist(before.map((v,i)=>v+t*delta[i]), enemy.pos) <= 8
      })
      if (!near.length) return false
      return (await nearThreat(status.pos, near)) || (await nearThreat(center(pos), near))
    }
    const candidates = found.filter(({ pos }) => {
      if (cooldown.has(pos.join(','))) return false
      if (within && dist(pos,within.center) > within.radius) return false
      if (pos[0] === before[0] && pos[2] === before[2] &&
          (isOre ? pos[1] === before[1] - 1 : kind !== 'wood' || pos[1] <= before[1]))
        return false
      return kind !== 'wood' || pos[1] <= before[1] + 5
    })
    if(isOre) {
      const close = await Promise.all(candidates.map(async point => {
        const tilt = Math.abs(point.pos[1] - before[1])
        const distance = dist(center(point.pos), status.pos)
        const direct = distance <= 5.5 && await directOre(point.pos)
        return {...point,distance,direct,cost:distance + tilt * 1.35 + (direct ? 0 : point.exposed ? 3 : 5)}
      }))
      candidates.splice(0,candidates.length,...close
        .filter(point=>point.direct || (!nearby && !oreRouteCooldown.has(point.pos.join(','))))
        .sort((a,b)=>Number(b.direct)-Number(a.direct) ||
          (a.direct && b.direct ? a.distance-b.distance : a.cost-b.cost)))
    }
    const direct = candidates.filter(point=>point.direct)
    let targets = candidates
    if (isOre && !nearby) {
      let ongoing = candidates.find(point=>point.pos.join(',')===committedOre?.key)
      const now = Date.now()
      if (ongoing && !ongoing.direct) {
        if (ongoing.distance < committedOre.distance - 0.35) {
          committedOre.distance=ongoing.distance
          committedOre.lastProgress=now
          committedOre.stale=0
        } else committedOre.stale++
        if (now-committedOre.started >= 105000 || now-committedOre.lastProgress >= 22000 || committedOre.stale >= 3) {
          log('矿点接近没有足够进展，换近处候选 ' + committedOre.key)
          oreRouteCooldown.set(committedOre.key,now+45000)
          clearMineTarget(ongoing.pos)
          targets=candidates.filter(point=>point!==ongoing)
          ongoing=null
        }
      }
      if (!ongoing && committedOre) {
        clearMineTarget(committedOre.pos)
        committedOre=undefined
      }
      if (direct.length) {
        const close=targets.filter(point=>point.direct)
        targets=[...close,...targets.filter(point=>!point.direct)]
      } else if (!nearby && targets.length) {
        if (ongoing && ongoing.cost <= targets[0].cost + 0.75) {
          targets=[ongoing,...targets.filter(point=>point!==ongoing)]
        } else {
          const comparable=targets.filter(point=>point.cost<=targets[0].cost+1.25 &&
            point.distance<=targets[0].distance+1.25)
          const ranked=await prioritize(kind,comparable,point=>({name:point.name,pos:point.pos,
            distance:point.distance,route_cost:Math.round(point.cost)}))
          if (!ranked.length) return false
          targets=[...ranked,...targets.filter(point=>!comparable.includes(point))]
        }
      }
    } else if (basicStone) {
      const local = candidates.filter(point => point.pos[1] >= before[1] - 1 && point.pos[1] <= before[1] + 3)
      const ranked = (await Promise.all(local.map(async point => ({
        ...point,
        direct: await directOre(point.pos),
        cost: dist(point.pos, before) + 2 * Math.abs(point.pos[1] - before[1]),
      })))).sort((a,b) => Number(b.direct) - Number(a.direct) || a.cost - b.cost)
      const close = ranked.filter(point => point.direct)
      targets = await prioritize(kind, (close.length ? close : ranked).slice(0, 3),
        point => ({ name:point.name, pos:point.pos, distance:point.dist, route_cost:Math.round(point.cost) }))
      if (ranked.length && !targets.length) return false
    } else if (!isOre) {
      targets=await prioritize(kind,candidates,({name,pos,dist})=>({name,pos,distance:dist}))
    }
    if (candidates.length && !targets.length && !basicStone) return false
    for (const b of hints.length ? targets.slice(0, 8) : targets) {
      const key = b.pos.join(',')
      try {
        if ((isOre || basicStone) && await danger(b.pos)) continue
        const actual = await block(b.pos)
        if (!targetNames.includes(actual.name) || (b.source === 'observer' && actual.name !== b.name)) {
          if (b.source === 'observer') forgetObserverOre?.(status, b.pos, b.name)
          cooldown.set(key, Date.now() + 15000)
          continue
        }
        if (isOre && b.source !== 'observer' && actual.harvest_tool_ok === false) {
          cooldown.set(key, Date.now() + 15000)
          continue
        }
        if (isOre && b.source === 'observer' &&
            (!selected || gearRank(selected) < (b.name === 'nether_gold_ore' ? 0 : REQUIRED_PICK[kind]))) continue
        if (
          kind !== 'wood' &&
          (await Promise.all((b.source === 'observer' || basicStone ? [...DELTAS,[0,1,0],[0,-1,0]] : DELTAS).map((v) => block(add(b.pos, v))))).some((k) => DANGER.test(k.name))
        )
          continue
        if (isOre) {
          if (nearby && !b.direct) continue
          setMineTarget(b.pos, actual.name)
          const progress = b.direct ? 'reachable' : await reachSeam(b.pos, b.source === 'observer')
          if (progress === 'approaching') {
            if (committedOre?.key !== key) {
              const started = Date.now()
              committedOre = {key,pos:b.pos,started,lastProgress:started,distance:b.distance,stale:0}
              log('已核实矿点 ' + b.name + ' ' + key + '，正在接近')
            }
            return false
          }
          if (progress === 'blocked') {
            clearMineTarget(b.pos)
            oreRouteCooldown.set(key, Date.now() + 30000)
            continue
          }
        }
        const wood = kind === 'wood'
        const closeBy = dist(status.pos,center(b.pos)) <= 4.5
        const ordinaryClose = !nearby && closeBy && (kind==='coal' || kind==='iron') &&
          Math.abs(here()[1]-b.pos[1])<=1
        const drops = wood ? [...LOG_NAMES] : basicStone ? [...STONE_DROPS] :
          isOre ? [b.name,b.name === 'nether_gold_ore' ? 'gold_nugget' : ORE_DROPS[kind]] : []
        const hasDrop = name => drops.includes(name)
        if (committedOre?.key === key) committedOre = undefined
        const beforeLoot = drops.length ? sum(hasDrop) : 0
        if (basicStone) setMineTarget(b.pos, actual.name)
        const res = isOre || basicStone
          ? await guardedDig(b.pos, !((basicStone || ordinaryClose) && closeBy))
          : await call('dig', { pos: b.pos, collect: !wood, timeout: 8500 })
        clearMineTarget(b.pos)
        cooldown.set(key, Date.now() + 15000)
        if (res.interrupted_by) return false
        if (b.source === 'observer') forgetObserverOre?.(status, b.pos, b.name)
        await refresh()
        if (drops.length) {
          for (let i = 0; i < 4 && sum(hasDrop) <= beforeLoot; i++) {
            if (i === 1 && (wood || basicStone || recoverDrops || kind==='diamond' || kind==='debris'))
              await recoverValuableDrops({target:b.pos,names:drops,quick:wood||basicStone||ordinaryClose,
                shallow:basicStone||ordinaryClose,preferStand:wood||ordinaryClose})
            if (i === 2 && isOre && recoverDrops && sum(hasDrop) <= beforeLoot) await approachOreDrop(b.pos, drops)
            await new Promise(resolve => setTimeout(resolve, 250))
            await refresh()
          }
          const gain = sum(hasDrop) - beforeLoot
          if (gain <= 0) {
            if (basicStone) missedStone = {stand:stoneStand,attempts:missedStone?.stand === stoneStand ? missedStone.attempts+1 : 1}
            log('目标已挖掘，尚未在背包确认掉落物 ' + key)
            return false
          }
          if (basicStone) missedStone = undefined
          log((wood ? '已拾取原木 ×' : b.source === 'observer' ? '已拾取旁观者矿点掉落物 ×' : '已拾取矿物 ×') + gain + ' ' + key)
        }
        log(
          '采集 ' +
            b.name +
            ' ' +
            key +
            (wood ? '，原木入包 ' + (sum(hasDrop)-beforeLoot) :
              chooseTarget && res.gained ? '，背包增量 ' + JSON.stringify(res.gained) : ''),
        )
        return true
      } catch (e) {
        clearMineTarget(b.pos)
        if (!recoverable.has(e.code)) throw e
        if (e.code === 'movement_interrupted') throw e
        cooldown.set(key, Date.now() + 90000)
      }
    }
    if (nearby || pending || scan?.pending || hints.length) return false
    if (kind === 'debris' && !found.length) return false
    if (kind === 'wood') return here()[1] < 56 ? stair(80) : explore()
    if (basicStone) {
      await refresh()
      return stair(here()[1] - 1)
    }
    return stair({ stone: 52, cobble: 56, ...ORE_LEVEL }[kind])
  }
  let lastDiscard = 0
  let discardBlocked
  const discardedNames = new Map()
  async function clearBackpack() {
    const returning = memory.woodReturn || (!memory.unlocked && memory.returnTrail) || memory.workshopReturn
    if (!Number.isFinite(inventory.empty_slots) || !status.on_ground ||
        status.in_water || status.in_lava || status.on_fire || status.nearest_hostile?.dist <= 6 ||
        (returning && inventory.empty_slots > 0) || memory.shelter ||
        Date.now()-lastDiscard < 1600) return false
    const items = inventory.items
    const maxUses = {wooden:59,stone:131,copper:190,iron:250,diamond:1561,netherite:2031}
    const held = status.held?.name
    const rubble = sum(name=>RUBBLE.has(name))
    const usableStone = sum(name=>STONE_DROPS.has(name))
    const required = ['pickaxe','axe','sword','shovel','hoe']
    const armorSlot = {helmet:'head',chestplate:'chest',leggings:'legs',boots:'feet'}
    const armorRank = name => ['leather','golden','chainmail','copper','iron','diamond','netherite'].indexOf(name.split('_')[0])
    const protectedStack = stack => stack.enchantments?.length || stack.custom_name || stack.name === held
    const obsolete = stack=>{
      const [material,type]=stack.name.split('_')
      if (stack.name==='golden_boots' && memory.nether && !memory.nether.completed) return false
      // The HTTP drop action selects by item name, so only use it when every copy is unprotected.
      if (items.some(item => item.name === stack.name && protectedStack(item))) return false
      if (armorSlot[type]) {
        const worn=inventory.armor?.[armorSlot[type]]?.name
        return worn && armorRank(worn)>armorRank(stack.name)
      }
      if (!required.includes(type) || !(material in maxUses)) return false
      return items.some(other=>{
        const [tier,kind]=other.name.split('_')
        return kind===type && gearRank(other.name)>gearRank(stack.name) &&
          (maxUses[tier]||0)-(other.durability_used||0)>12
      })
    }
    const ordered=[...new Map(items.map(item=>[item.name,item]).reverse()).values()]
      .filter(item=>(discardedNames.get(item.name) || 0) <= Date.now())
    const scrap=ordered.filter(item=>!protectedStack(item) && RUBBLE.has(item.name) && rubble-item.count>=128 &&
      (!STONE_DROPS.has(item.name)||usableStone-item.count>=32)).sort((x,y)=>y.count-x.count)
    const obsoleteTool=ordered.find(obsolete)
    const target=obsoleteTool || (inventory.empty_slots < 2 ? scrap[0] : undefined)
    if (!target) return false
    const before = count(target.name)
    const freeBefore=inventory.empty_slots
    const origin=here()
    const cellKey = [status.dimension,...origin].join(',')
    if (discardBlocked?.key === cellKey && discardBlocked.until > Date.now()) return false
    const work=committedOre?.pos
    const exits=await Promise.all(DELTAS.map(async dir=>{
      const path = [1,2,3,4].map(step => add(origin,dir.map(v=>v*step)))
      const clear = await Promise.all(path.map(async pos=>{
        const [floor,body,head] = await Promise.all([block(add(pos,[0,-1,0])),block(pos),block(add(pos,[0,1,0]))])
        return (SOFT.test(floor.name) || RUBBLE.has(floor.name) || /^(?:bedrock|.*_planks)$/.test(floor.name)) &&
          (AIR.has(body.name) || /^(?:wall_)?torch$/.test(body.name)) && AIR.has(head.name)
      }))
      return clear.every(Boolean) ? {dir, exit:path.at(-1)} : null
    }))
    const routes = exits.filter(Boolean)
    // Keep routine discards out of corridors the Bot has to retrace. At a T-junction,
    // the branch off the main passage is usable when it leads away from the mine target.
    const available = routes.filter(({dir,exit}) => {
      if (freeBefore < 2 || routes.length === DELTAS.length) return true
      if (routes.length !== DELTAS.length - 1) return false
      const hasOpposite = routes.some(other => other.dir[0] === -dir[0] && other.dir[2] === -dir[2])
      return !hasOpposite && (!work || dist(exit,work) >= dist(origin,work))
    })
    const route = available.sort((x,y) => work ? dist(y.exit,work)-dist(x.exit,work) : 0)[0]
    if (!route) {
      discardBlocked = {key:cellKey,until:Date.now()+8000}
      return false
    }
    const {dir,exit}=route
    try {
      await move(exit,0)
    } catch (error) {
      if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      discardBlocked = {key:cellKey,until:Date.now()+8000}
      return true
    }
    await refresh()
    if (status.nearest_hostile?.dist <= 6 || status.in_water || status.in_lava || !status.on_ground) return true
    await call('look',{pos:add(eye(),[2*dir[0],0.25,2*dir[2]])})
    let amount=target.count
    if (RUBBLE.has(target.name)) {
      const same=items.filter(stack=>stack.name===target.name)
      for(const stack of same.slice(1,3-freeBefore)) {
        const extra=amount+stack.count
        if (rubble-extra<128 || (STONE_DROPS.has(target.name)&&usableStone-extra<32)) break
        amount=extra
      }
    }
    await call('drop',{item:target.name,count:amount})
    lastDiscard=Date.now()
    discardedNames.set(target.name,lastDiscard+60000)
    try {
      await move(origin,0)
    } catch (error) {
      if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      await new Promise(resolve=>setTimeout(resolve,2100))
    }
    await refresh()
    if (dist(status.pos,center(exit)) < 3 || count(target.name) >= before) {
      discardBlocked = {key:cellKey,until:Date.now()+8000}
      return false
    }
    log('清理背包 '+target.name+' × '+(before-count(target.name))+'，空位 '+freeBefore+' → '+inventory.empty_slots)
    return true
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
    if (item === 'crafting_table' && memory.anchor) {
      const depot = add(memory.anchor, [-2, 0, -1])
      if (dist(here(), depot) <= 12 && (await block(depot)).name === 'crafting_table') return depot
    }
    const pos = memory[item]
    const useLocalTable = item === 'crafting_table' && pos && dist(here(), pos) > 4 &&
      (count(item) || sum(name => name.endsWith('_planks')) + 4 * sum(name => LOG_NAMES.has(name)) >= 4)
    if (pos && !useLocalTable) {
      if (dist(here(), pos) > 4) await move(pos)
      if ((await block(pos)).name === item) return pos
      delete memory[item]
      if (item === 'furnace') delete memory.furnaceLoaded
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
    // Only reclaim the confirmed station. A narrow shaft may have no automatic placement site.
    let placed
    try {
      const belowSurface = memory.surface && here()[1] < memory.surface[1] - 5
      if (item !== 'furnace' && !belowSurface) placed = await call('place', { item })
    } catch (error) {
      if (!['no_support','blocked_by_self','occupied','place_failed'].includes(error.code)) throw error
    }
    if (!placed) {
      await refresh()
      const origin = here()
      const exitKey = [status.dimension, ...origin, ...(memory.surface || [])].join(',')
      if (stationExit?.key === exitKey && stationExit.until > Date.now()) return null
      const solid = /^(stone|cobble.*|dirt|grass_block|(?:cobbled_)?deepslate|andesite|diorite|granite|tuff|sandstone|netherrack|.*_planks)$/
      const points = [0,1,-1].flatMap(y => [1,2,3].flatMap(distance =>
        DELTAS.map(dir => add(origin,[dir[0]*distance,y,dir[2]*distance]))))
      for (let i = 0; i < points.length && !placed; i += 12) {
        const supported = await Promise.all(points.slice(i, i + 12).map(async pos => {
          const [floor, feet, head] = await Promise.all([block(add(pos, [0,-1,0])), block(pos), block(add(pos,[0,1,0]))])
          return solid.test(floor.name) && AIR.has(feet.name) &&
            (AIR.has(head.name) || pos[1] === origin[1] && dist(pos, origin) === 1) ? pos : null
        }))
        for (const pos of supported.filter(Boolean)) {
          if (dist(pos, origin) > 3.25) continue
          if (item === 'furnace' && dist(pos, origin) > 1) {
            if (pos[1] !== origin[1]) continue
            const between = pos.map((v,i) => origin[i] + Math.sign(v - origin[i]))
            const path = await Promise.all([block(between),block(add(between,[0,1,0]))])
            if (path.some(cell=>!AIR.has(cell.name))) continue
          }
          try { placed = await placeAt(item, pos); break }
          catch (candidateError) {
            if (!recoverable.has(candidateError.code) && candidateError.code !== 'blocked_by_self') throw candidateError
          }
        }
      }
      if (!placed && item === 'crafting_table' && LOG_NAMES.has((await block(add(origin,[0,-1,0]))).name)) {
        for (const offset of DELTAS) {
          const pos = add(origin,offset)
          const cells = await Promise.all([block(add(pos,[0,-1,0])),block(pos),block(add(pos,[0,1,0]))])
          if (!isLeaf(cells[0].name) || !cells.slice(1).every(b=>AIR.has(b.name) || isLeaf(b.name))) continue
          try {
            for (const leaf of cells.slice(1).filter(b=>isLeaf(b.name))) {
              await call('dig',{pos:leaf.pos,collect:false,stop_on:['hurt','death']})
            }
            placed = await placeAt(item,pos)
            break
          } catch (error) {
            if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
          }
        }
      }
      if (!placed && status.on_ground && !status.in_water && !status.in_lava) {
        const pick = tool('pickaxe')
        const shovel = tool('shovel')
        for (const offset of DELTAS) {
          const pos = add(origin, offset)
          const [floor, wall, ...neighbors] = await Promise.all(
            [[0,-1,0], [0,0,0], [0,1,0], ...DELTAS].map(dir => block(add(pos,dir))),
          )
          const toolName = /^(dirt|grass_block)$/.test(wall.name) ? shovel : pick
          if (!solid.test(floor.name) || !SOFT.test(wall.name) || !wall.diggable ||
            (!toolName && !/^(dirt|grass_block)$/.test(wall.name)) ||
            neighbors.some(cell => !cell.name || DANGER.test(cell.name) || /^(gravel|sand|red_sand)$/.test(cell.name)))
            continue
          try {
            if (toolName) await equip(toolName)
            await guardedDig(pos, false)
            placed = await placeAt(item, pos)
            log('在矿道侧壁开出一格工作站位 ' + pos.join(','))
            break
          } catch (error) {
            if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
          }
        }
      }
      if (!placed) {
        stationExit = { key: exitKey, until: Date.now() + 20000 }
        if (memory.surface && dist(origin, memory.surface) > 6) {
          try {
            await move(memory.surface, 3)
            return null
          } catch (error) {
            if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
          }
        }
        log('附近无法放置工作站，尝试从邻近台阶脱困')
        await stair(origin[1] + 1)
        return null
      }
    }
    if (!Array.isArray(placed.pos) || placed.placed !== item) throw Error('无法确认放置 ' + item)
    memory[item] = placed.pos
    if (item === 'furnace') memory.furnaceLoaded = false
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
        await recoverValuableDrops({target:pos,names:[item]})
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
    if (item === 'furnace') delete memory.furnaceLoaded
    save()
    return true
  }
  async function smelt(raw, fuel, limit = 8) {
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
    const ops = [{ op: 'put', item: raw, count: Math.min(count(raw), limit), to: 'input' }]
    if (fuel && !v.sections.fuel.length && !v.info.burning)
      ops.push({ op: 'put', item: fuel, count: 1, to: 'fuel' })
    memory.furnaceLoaded = true
    save()
    await op(ops)
  }
  async function food({ stock = 0, exploreIfMissing = true, leather = false } = {}) {
    const edible = inventory.items.find((i) => FOOD.test(i.name))
    if (!leather && edible && status.food < 19) {
      await call('use_item', { item: edible.name, stop_on: ['hurt', 'death'] })
      return true
    }
    if (!leather && stock && sum(name => FOOD.test(name)) >= stock) return false
    if (!leather && count('wheat') >= 3) {
      if (await station('crafting_table')) await craft('bread', Math.min(4, Math.floor(count('wheat') / 3)))
      return true
    }
    const raw = inventory.items.find(i => RAW_FOOD.test(i.name))
    if (!leather && raw) {
      if (status.food <= 8 && raw.name !== 'chicken') {
        await call('use_item', { item: raw.name, stop_on: ['hurt', 'death'] })
        return true
      }
      const fuel = inventory.items.find(i => /^(coal|charcoal|.*_planks)$/.test(i.name))
      if (fuel) {
        await smelt(raw.name, fuel.name, /_planks$/.test(fuel.name) ? 2 : 8)
        return true
      }
      if (sum(n => LOG_NAMES.has(n))) {
        await ensurePlanks(2)
        return true
      }
      if (await gather('coal', { nearby:true })) return true
      if (exploreIfMissing) {
        await gather('wood')
        return true
      }
    }
    if (!leather && count('mutton') + count('beef') + count('porkchop') + count('chicken') >= 4 && stock) {
      return false
    }
    const animals = (await call('get_entities', { types: ['animal'], radius: 40 })).entities
    const animal = animals.find((i) =>
      (leather ? ['cow','mushroom_cow'] : ['cow','pig','sheep','rabbit','chicken']).includes(i.name),
    )
    if (animal && (tool('sword') || tool('axe') || status.food <= 8)) {
      await call('attack', { entity_id: animal.id, timeout: 4500, stop_on: ['hurt', 'death'] })
      const drops = findFoodDrop(await call('get_entities', { types: ['item'], radius: 8 }), animal.pos)
      if (drops) await call('move_to', { entity_id: drops.id, range: 0.35, timeout: 2800, stop_on: ['hurt','death'] })
      return true
    }
    const crops = leather ? [] : await find(['sweet_berry_bush', 'wheat', 'carrots', 'potatoes'], 32, 6, { mature: true })
    if (crops.length) {
      await call('dig', { pos: crops[0].pos, collect: true, stop_on: ['hurt', 'death'] })
      return true
    }
    if (!exploreIfMissing) return false
    if (here()[1] < 60) await stair(76)
    else if (!await explore()) {
      await refresh()
      if (status.dimension === 'overworld' && status.on_ground && !status.in_water && !status.in_lava) {
        await stair(here()[1] + 1, {exploreIfBlocked: false, openLanding: true})
      }
    }
    return true
  }

  function findFoodDrop({ entities }, animalPos) {
    return entities.find(e => dist(e.pos, animalPos)<5 && (RAW_FOOD.test(itemName(e)) || itemName(e)==='leather'))
  }

  let encounter,
    retreatState,
    lastMeal = 0,
    lastSwing = 0
  async function battleChoice(enemy, weak) {
    const key = String(enemy.id) + (weak ? ':low' : ':ready')
    if (encounter?.key === key) return encounter
    const low = status.health < 12
    const options = weak
      ? ['撤往掩体', low ? '拉开距离后进食' : '保持距离并重新观察']
      : ['持剑接战', '举盾等待反击']
    const current = { key, choice: options[0] }
    encounter = current
    if (chooseTarget) {
      // The reflex and the first evasive step run immediately while the model chooses the continuation.
      Promise.resolve(
        chooseTarget({
          objective: low ? '低血撤离与补给'
            : enemy.name === 'creeper' ? '避开苦力怕爆炸'
            : weak ? '装备不足，寻找撤离点' : '应对正在接近的怪物',
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
  async function retreat(enemy, position, foes) {
    const s = await call('status'),
      origin = s.pos.map(Math.floor)
    const repeatsRoute = target => {
      const dx = target[0] - origin[0], dz = target[2] - origin[2]
      const length = Math.hypot(dx,dz)
      if (!length) return false
      return retreatState.path.some((pos,index) => {
        const x = pos[0] - origin[0], z = pos[2] - origin[2]
        const forward = (x*dx + z*dz) / length
        const across = Math.abs(x*dz - z*dx) / length
        const reversesLastLeg = index === retreatState.path.length - 2
        return forward > 2 && (reversesLastLeg || forward <= length+1) &&
          across < 2 && Math.abs(pos[1]-target[1]) <= 2
      })
    }
    const distanceFromGroup = dir => {
      const end=add(origin,dir.map(v=>v*3))
      return Math.min(...foes.map(foe=>dist(end,foe.pos)))
    }
    const dirs = [...DELTAS].sort((a,b)=>distanceFromGroup(b)-distanceFromGroup(a))
    if (enemy.dist < 5 && s.on_ground && !s.in_water && s.food > 6) {
      const headings = [...dirs,[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1]]
        .sort((a,b)=>distanceFromGroup(b)-distanceFromGroup(a))
      for (const dir of headings) {
        if (dist(add(origin,dir),position) <= dist(origin,position)) continue
        if (dir[0]&&dir[2]) {
          const corners = await Promise.all([[dir[0],0,0],[0,0,dir[2]]].flatMap(side=>
            [block(add(origin,side)),block(add(origin,add(side,[0,1,0])))]))
          if (!corners.every(cell=>AIR.has(cell.name))) continue
        }
        let clearDistance = 0
        for (const step of [1,2,3,4,5,6]) {
          const p = add(origin,dir.map(v => v*step))
          const [floor,feet,head] = await Promise.all([block(add(p,[0,-1,0])),block(p),block(add(p,[0,1,0]))])
          if (AIR.has(floor.name) || DANGER.test(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name)) {
            break
          }
          clearDistance = step
        }
        if (clearDistance < 3 || repeatsRoute(add(origin,dir.map(v=>v*clearDistance)))) continue
        const direction = Math.atan2(-dir[0],-dir[2])
        const duration = Math.min(1000, 165 * clearDistance)
        const motion=await call('control',{forward:true,sprint:true,yaw:direction,pitch:0,ms:duration,stop_on:['death']})
        if (dist(s.pos,motion.pos) > 1.4) return true
      }
      for (const dir of dirs) {
        const step=add(origin,dir)
        if (dist(step,position) <= dist(origin,position) ||
            repeatsRoute(add(origin,dir.map(v=>v*3)))) continue
        const [floor,feet,head,clearance] = await Promise.all([
          block(step),block(add(step,[0,1,0])),block(add(step,[0,2,0])),block(add(origin,[0,2,0])),
        ])
        if (AIR.has(floor.name) || DANGER.test(floor.name) ||
            ![feet,head,clearance].every(cell=>AIR.has(cell.name))) continue
        const yaw=Math.atan2(-dir[0],-dir[2])
        const motion=await call('control',{forward:true,jump:true,sprint:true,yaw,pitch:0,ms:400,stop_on:['death']})
        if (motion.pos[1] > s.pos[1]+0.4) return true
      }
      for (const dir of dirs) {
        if (dist(add(origin,dir),position) <= dist(origin,position) ||
            repeatsRoute(add(origin,dir.map(v=>v*3)))) continue
        for (const dy of [0,-1]) {
          const p=add(add(origin,dir),[0,dy,0])
          const [floor,feet,head]=await Promise.all([block(add(p,[0,-1,0])),block(p),block(add(p,[0,1,0]))])
          if (AIR.has(floor.name) || DANGER.test(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name)) continue
          const yaw=Math.atan2(-dir[0],-dir[2])
          const motion=await call('control',{forward:true,sprint:true,yaw,pitch:0,ms:260,stop_on:['death']})
          if (dist(s.pos,motion.pos)>0.7) return true
        }
      }
    }
    const safeLanding = async goal => {
      try {
        const [floor, feet, head] = await Promise.all([block(add(goal, [0,-1,0])), block(goal), block(add(goal, [0,1,0]))])
        return blocksByName[floor.name]?.boundingBox === 'block' && !DANGER.test(floor.name) &&
          AIR.has(feet.name) && AIR.has(head.name)
      } catch (error) {
        if (error.code !== 'not_loaded') throw error
        return false
      }
    }
    const useful = goal => dist(goal, position) >= enemy.dist + 2 && !repeatsRoute(goal) &&
      !foes.some(foe => dist(goal, foe.pos) < Math.min(6, foe.dist)) && !retreatState.blocked.has(goal.join(','))
    const walkSegment = async (goal, steps) => {
      let receipt
      try {
        receipt = s.in_water ? await move(goal, 0) : await call('move_to', {
          pos: goal, range: 0, timeout: Math.min(2500, 900 + steps * 135),
        })
      } catch (error) {
        if (error.code === 'movement_interrupted' || error.code === 'interrupted') return true
        if (!recoverable.has(error.code)) throw error
      }
      const updated = await call('status')
      if (receipt?.interrupted_by || !updated.ready || !updated.alive || updated.dimension !== s.dimension || updated.health < s.health) return true
      const target = add(goal, [0.5,0,0.5])
      if (dist(s.pos, updated.pos) > 1.4 && dist(s.pos, target) - dist(updated.pos, target) > 1.4) return true
      retreatState.blocked.set(goal.join(','), Date.now() + 5000)
      return false
    }
    const clearRun = async (start, dir, limit) => {
      let clear = 0
      for (let step = 1; step <= limit; step += 4) {
        const cells = Array.from({ length: Math.min(4, limit - step + 1) }, (_, i) =>
          add(start, dir.map(value => value * (step + i))))
        const checked = await Promise.all(cells.map(safeLanding))
        const blocked = checked.indexOf(false)
        if (blocked >= 0) return clear + blocked
        clear += checked.length
      }
      return clear
    }
    let misses = 0
    if (s.on_ground && !s.in_water) {
      for (const dir of dirs) {
        let clear = await clearRun(origin, dir, 12)
        let goal = add(origin, dir.map(value => value * clear))
        if (clear > 0 && clear <= 3) {
          // Reach a turn while the mob is still behind the bot.
          for (const side of dirs.filter(value => dir[0] * value[0] + dir[2] * value[2] === 0)) {
            const lateral = await clearRun(goal, side, 12 - clear)
            if (lateral < 3) continue
            const beyondTurn = add(goal, side.map(value => value * lateral))
            if (!useful(beyondTurn)) continue
            if (await walkSegment(beyondTurn, clear + lateral)) return true
            if (++misses >= 2) return true
          }
        }
        if (clear < 3) {
          const edge = add(goal, dir)
          for (const rise of [-1, 1]) {
            const landing = add(edge, [0,rise,0])
            if (!await safeLanding(landing)) continue
            const clearance = rise < 0 ? add(edge, [0,1,0]) : add(goal, [0,2,0])
            if (!AIR.has((await block(clearance)).name)) continue
            const beyond = await clearRun(landing, dir, 11 - clear)
            const across = add(landing, dir.map(value => value * beyond))
            if (clear + 1 + beyond < 3 || !useful(across)) continue
            clear += 1 + beyond
            goal = across
            break
          }
        }
        if (clear < 3 || !useful(goal)) continue
        if (await walkSegment(goal, clear)) return true
        if (++misses >= 2) return true
      }
    }
    // A short detour can reach a nearby safe block across a bend or a step.
    for (const dir of dirs) {
      for (const steps of s.in_water ? [20, 14, 8, 5, 3] : [8, 5, 3]) {
        const goal = add(origin, dir.map(value => value * steps))
        if (!useful(goal) || !await safeLanding(goal)) continue
        if (await walkSegment(goal, steps)) return true
        if (++misses >= 2) return true
      }
    }
    return false
  }

  async function continueRetreat(observed) {
    const s = status
    if (retreatState.dimension !== s.dimension || retreatState.death !== s.last_death?.t) {
      retreatState = undefined
      return false
    }
    const now = Date.now()
    const foes = observed ?? (await call('get_entities', {types:['hostile'],radius:32})).entities
    const active = []
    for (const [key,until] of retreatState.blocked) if (until <= now) retreatState.blocked.delete(key)
    for (const foe of foes) {
      const previous = retreatState.tracked.get(foe.id)
      if (previous === undefined && foe.dist > 12) continue
      const visible = foe.dist <= 27 && await exposedThreat(s.pos,foe)
      const following = previous !== undefined && (foe.dist < 9 || foe.dist < previous - 0.6)
      if (visible || following) active.push(foe)
      if (visible || previous !== undefined) retreatState.tracked.set(foe.id,foe.dist)
    }
    const hurt = s.health < retreatState.health
    retreatState.health = s.health
    if (!active.length) {
      if (hurt || !retreatState.calmSince) retreatState.calmSince = now
      if (now - retreatState.calmSince < 2500) return true
      log('已脱离追击，恢复原任务')
      retreatState = undefined
      encounter = null
      if (s.health < 16 && s.food < 20 && now-lastMeal > 2000 &&
          inventory.items.some(item=>FOOD.test(item.name))) {
        lastMeal = now
        await food()
        return true
      }
      return false
    }
    retreatState.calmSince = 0
    if (!retreatState.path.length || dist(s.pos,retreatState.path.at(-1)) > 2) {
      retreatState.path.push(s.pos.map(Math.floor))
      if (retreatState.path.length > 8) retreatState.path.shift()
    }
    const foe = active.sort((a,b)=>a.dist-b.dist)[0]
    if (s.blocking && s.on_ground && !s.in_water && !defense.guarding())
      await call('posture',{shield:false,jump:s.jumping,sneak:s.sneaking})
    if (await retreat(foe,foe.pos,active)) return true
    if (foe.name === 'creeper' || s.health < 4) {
      if (has('shield')) {
        await call('look',{entity_id:foe.id})
        await call('posture',{shield:true,jump:s.jumping})
      }
    } else {
      const weapon = tool('sword') || tool('axe')
      if (weapon && foe.dist <= 2.8) await strikeWithHeldWeapon(foe,weapon)
    }
    return true
  }

  async function strikeWithHeldWeapon(foe, weapon) {
    if (foe.dist > 2.8) {
      try {
        await call('move_to',{entity_id:foe.id,range:2.5,timeout:1000,stop_on:['hurt','death']})
      } catch (error) {
        if (!recoverable.has(error.code) && !['interrupted','no_such_entity'].includes(error.code)) throw error
      }
      return
    }
    const cooldown = weapon?.endsWith('_sword') ? 650 : weapon?.endsWith('_axe') ? 1000 : 260
    if (Date.now()-lastSwing < cooldown) return
    const current = await call('status')
    if (weapon && current.held?.name !== weapon) await equip(weapon)
    if (current.blocking) await call('posture',{shield:false,jump:current.jumping})
    try {
      await call('look',{entity_id:foe.id})
      const hit = await call('control',{hit:true,ms:80,stop_on:['death']})
      lastSwing = Date.now()
      if (hit.hits?.some(swing => swing.entity)) log('近战挥击 '+(hit.held || weapon || '空手'))
    } catch (error) {
      if (!['no_such_entity','interrupted'].includes(error.code)) throw error
    }
  }

  async function safety({recovering=false}={}) {
    if (await require('./nmo-wall-escape').escapeWall(call,block,status,retreatFloor,retreatSpace)) return true
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
    if (retreatState && await continueRetreat()) return true
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
    const foes = (await call('get_entities', { types: ['hostile'], radius: 12 })).entities
      .filter(foe => foe.dist <= 12).sort((a, b) => a.dist - b.dist)
    let foe
    for (const candidate of foes) {
      if (!await exposedThreat(status.pos,candidate)) continue
      foe = candidate
      break
    }
    if (!foe) {
      encounter = null
      if (status.blocking && !defense.guarding()) await call('posture', { shield: false, jump: status.jumping, sneak: status.sneaking })
      return false
    }
    const armed = Boolean(tool('sword') || tool('axe'))
    const protectedLoadout = !recovering || has('shield') ||
      Object.values(inventory.armor || {}).filter(item=>item?.name).length>=2
    if (recovering && (!armed || !protectedLoadout) && foe.dist > 5 && status.health >= 12) return false
    const weak = status.health < 12 || !armed || !protectedLoadout || foe.name === 'creeper'
    const tactical = await battleChoice(foe, weak)
    if (weak) {
      retreatState = {
        dimension:status.dimension, death:status.last_death?.t, health:status.health,
        tracked:new Map([[foe.id,foe.dist]]), blocked:new Map(), path:[], calmSince:0
      }
      log('持续撤离 ' + foe.name)
      return continueRetreat(foes)
    }
    if (foe.name === 'creeper' && has('shield')) {
      await call('look', { entity_id: foe.id })
      await call('posture', { shield: true, jump: status.jumping })
      return true
    }
    if (has('shield') && /^(skeleton|stray|bogged|pillager)$/.test(foe.name)) await defense.tick()
    if (defense.guarding()) return true
    if (tactical.choice === '举盾等待反击' && foe.dist > 3 && foes.length === 1 &&
        !defense.counterReady() && has('shield') && /^(skeleton|stray|bogged|pillager)$/.test(foe.name)) {
      await call('look', { entity_id: foe.id })
      await call('posture', { shield: true, jump: status.jumping })
      return true
    }
    const weapon = tool('sword') || tool('axe')
    await strikeWithHeldWeapon(foe,weapon)
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
    gatherNearby: (kind, options) => gather(kind,{...options,nearby:true}),
    clearBackpack,
    recoverValuableDrops,
    ensurePlanks,
    ensureSticks,
    placeAt,
    station,
    reclaim,
    smelt,
    food,
    safety,
    hasReportedDebris: observerOres ? () => observerOres(status, ORES.debris).length > 0 : undefined,
    startDefense: defense.start,
    get retreating() { return Boolean(retreatState) },
    get status() {
      return status
    },
    get inventory() {
      return inventory
    },
  }
}
module.exports = { actions, add, dist, AIR, FOOD, ORES, recoverable }
