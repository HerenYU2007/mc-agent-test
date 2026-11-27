const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { setTimeout: delay } = require('node:timers/promises')
const { createNmoPlanner } = require('./nmo-planner')
const { NmoClient, waitReady } = require('./nmo-workbench')
const createProgression = require('./progression')
const createEquipment = require('./equipment')
const { LOG_NAMES, STONE_DROPS, ARMOR_SLOTS } = require('./config')
const { actions, add, dist, AIR, FOOD, recoverable } = require('./nmo-actions')
const { baseStep, climbBackForSupplies } = require('./nmo-base')
const { crossHutDoor, lightTravel, MIN_SMELTING_FUEL } = require('./nmo-base-lighting')
const { followRecordedExit } = require('./nmo-return')
const { createStorageLedger, recordNmoStorage, isStorageBlock } = require('./storage-ledger')
const { startNmoObserver } = require('./nmo-observer')
const OPENING_COAL_TARGET = 32
const OPENING_LOG_TARGET = 12
const BASE_LAPIS_TARGET = 10
const hasNearbyTable = (a, m) => Boolean(m.crafting_table && dist(a.here(), m.crafting_table) <= 4)

function checkpoint(env, api, status) {
  const world = JSON.stringify([
    api.base,
    status.server || '',
    status.username,
    env.MC_NMO_LATE_STAGES ? 'cross-dimension' : status.dimension,
    env.MC_NMO_WORLD || '',
  ])
  const id = createHash('sha256').update(world).digest('hex').slice(0, 24)
  const file = env.MC_NMO_STATE_PATH || path.join(os.homedir(), '.mc-agent', 'nmo', id + '.json')
  let memory = { world, diamonds: 0 }
  try {
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (previous.world !== world) throw Error('存档归属不同，请为这个角色和世界指定独立的 MC_NMO_STATE_PATH')
    memory = previous
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = file + '.' + process.pid + '.tmp'
    fs.writeFileSync(temp, JSON.stringify(memory), { mode: 0o600 })
    fs.renameSync(temp, file)
  }
  return { memory, save }
}
function strategy(a, m) {
  const inventory = {
    get slots() {
      return [...a.inventory.items, ...Object.values(a.inventory.armor || {}), a.inventory.offhand].filter(
        Boolean,
      )
    },
    items: () => a.inventory.items,
  }
  const rt = {
    bot: { inventory },
    supplyBase: { active: () => m.unlocked || m.diamonds >= 10 },
    get nightsSheltered() {
      return m.nights || 0
    },
  }
  const f = {
    inventoryItemCount: a.count,
    inventoryCount: (names) => a.sum((n) => names.has(n)),
    plankCount: () => a.sum((n) => n.endsWith('_planks')),
    findNearestBlock: () => hasNearbyTable(a, m),
    getEdibleFoods: () => a.inventory.items.filter((i) => FOOD.test(i.name)),
    isNightShelterTime: (t) => t >= 12000 && t <= 23500,
  }
  Object.assign(f, createEquipment(rt, f))
  const progression = createProgression(rt, f)
  function snapshot({skipNightShelter = false} = {}) {
    const raw = a.count('raw_iron'),
      iron = raw + a.count('iron_ingot'),
      p = a.here()
    return {
      timeOfDay: a.status.time_of_day,
      food: a.status.food,
      position: { x: p[0], y: p[1], z: p[2] },
      nightShelterTerrain: !skipNightShelter && m.surface && Math.abs(p[1] - m.surface[1]) < 8 ? 'open' : 'covered',
      logs: a.sum((n) => LOG_NAMES.has(n)),
      planks: f.plankCount(),
      sticks: a.count('stick'),
      canCraftWoodenPick: f.plankCount() + 4 * a.sum(n=>LOG_NAMES.has(n)) >=
        3 + (a.count('stick') >= 2 ? 0 : 2) + (a.count('crafting_table') || hasNearbyTable(a, m) ? 0 : 4),
      cobblestone: a.sum((n) => STONE_DROPS.has(n)),
      hasPickaxe: !!a.tool('pickaxe'),
      hasSword: !!a.tool('sword'),
      hasIronPickaxe: /^(iron|diamond|netherite)_/.test(a.tool('pickaxe') || ''),
      iron,
      rawIron: raw,
      coal: a.count('coal'),
      charcoal: a.count('charcoal'),
      openingCoalTarget: m.openingCoalStocked ? 0 : OPENING_COAL_TARGET,
      torches: a.count('torch'),
    }
  }
  return {
    stage: options => progression.computeStage(snapshot(options)),
    gear: f,
    equippedDiamond: () =>
      ['head', 'chest', 'legs', 'feet'].every((k) =>
        /^(diamond|netherite)_/.test(a.inventory.armor?.[k]?.name || ''),
      ),
  }
}
async function removeShelterDoor(a, refuge) {
  for (const piece of (refuge?.doorBlocks || []).slice().reverse()) {
    if (dist(a.here(), piece.pos) < 4 && (await a.block(piece.pos)).name === piece.item)
      await a.call('dig', { pos: piece.pos, collect: true })
  }
}

async function shelter(a, m, save, log) {
  const night = a.status.time_of_day >= 12000 && a.status.time_of_day <= 23500
  if (!night) {
    await removeShelterDoor(a, m.shelter)
    delete m.shelter
    m.nights = (m.nights || 0) + 1
    save()
    return
  }
  const bed = (await a.find(['white_bed', 'red_bed', 'yellow_bed', 'blue_bed', 'brown_bed'], 16, 1))[0]
  if (bed) {
    await a.call('interact', { pos: bed.pos })
    return
  }
  if (!m.shelter) {
    const origin = a.here()
    // Build an emergency refuge around the player on verified supporting ground.
    const offsets = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
      [1, 1, 0],
      [-1, 1, 0],
      [0, 1, 1],
      [0, 1, -1],
      [1, 2, 0],
      [0, 2, 0],
    ]
    m.shelter = { origin, entrance: add(origin, [0, 1, -1]), offsets }
    save()
  }
  if (dist(a.here(), m.shelter.origin) > 2) {
    delete m.shelter
    save()
    return
  }
  const refuge = m.shelter
  const rejected = new Set(refuge.rejected)
  const reject = (key, reason) => {
    rejected.add(key)
    refuge.rejected = [...rejected]
    save()
    log('夜间掩体跳过站不住的墙格 ' + key + '（' + reason + '）')
  }
  for (const offset of refuge.offsets) {
    if (offset[1] > 0 && refuge.offsets.some(base =>
      base[1] === 0 && rejected.has(add(refuge.origin, base).join(',')))) break
    const pos = add(refuge.origin, offset)
    const key = pos.join(',')
    if (rejected.has(key)) continue
    if (!AIR.has((await a.block(pos)).name)) continue
    if (offset[1] === 0) {
      const floor = (await a.block(add(pos, [0,-1,0]))).name
      if (AIR.has(floor) || /^(?:water|lava|bubble_column)$/.test(floor)) {
        reject(key, '无实心墙脚')
        continue
      }
    }
    const item = a.inventory.items.find(
      (i) => STONE_DROPS.has(i.name) || i.name === 'dirt' || i.name.endsWith('_planks'),
    )
    if (!item) {
      if (a.sum((n) => LOG_NAMES.has(n))) {
        await a.ensurePlanks(4)
        return
      }
      const earth = (await a.find(['dirt', 'grass_block'], 5, 16)).find(
        (b) => dist(b.pos, m.shelter.origin) > 2.5,
      )
      if (earth) await a.call('dig', { pos: earth.pos, collect: true })
      else await a.gather('wood')
      return
    }
    try {
      await a.placeAt(item.name, pos)
    } catch (error) {
      if (error.code === 'movement_interrupted' ||
          (!recoverable.has(error.code) && error.code !== 'blocked_by_self')) throw error
      reject(key, error.code)
      continue
    }
    if (offset[0] === 0 && offset[2] === -1 && offset[1] <= 1) {
      m.shelter.doorBlocks ??= []
      m.shelter.doorBlocks.push({ pos, item: item.name })
    }
    save()
    return
  }
  if (rejected.size) {
    await removeShelterDoor(a, refuge)
    m.shelterRetry = { origin: refuge.origin, until: Date.now() + 30000 }
    delete m.shelter
    save()
    log('掩体无法封闭，继续执行原任务，离开该站位后再评估避难')
  }
}
const blockedRecoverySteps = new WeakMap()
const nextRecoverySleep = new WeakMap()
const nextFoodStock = new WeakMap()
const nextFurnaceWork = new WeakMap()
const nextOpeningWoodStock = new WeakMap()

async function leaveHutForRecovery(a, m) {
  if (!m.hut?.complete || !m.nether?.bedVerified) return
  if (a.status.is_sleeping) return '在小屋睡到天亮再回收'
  const center = m.hut.center
  const current = a.here()
  const offset = current.map((coordinate, index) => coordinate - center[index])
  const inside = offset[1] === 0 && Math.abs(offset[0]) <= 1 && Math.abs(offset[2]) <= 1
  const entry = add(center, [0,0,2])
  const outside = add(center, [0,0,3])
  if (!inside && dist(current, entry) !== 0 && dist(current, outside) !== 0) return
  if (inside && a.status.time_of_day >= 12542 && a.status.time_of_day <= 23459 &&
      Date.now() >= (nextRecoverySleep.get(a) ?? 0)) {
    nextRecoverySleep.set(a, Date.now() + 12000)
    const sleep = await a.call('interact', { pos: m.nether.bed })
    if (sleep.slept) return '在小屋睡到天亮再回收'
  }
  const door = await a.block(entry)
  if (!door.name.endsWith('_door')) return
  if (dist(current, outside) === 0) {
    if (door.properties?.open) await a.call('interact', { pos: entry })
    return
  }
  const staging = add(center, [0,0,1])
  if (inside && dist(current, staging) !== 0) await a.move(staging,0)
  if (!door.properties?.open) await a.call('interact', { pos: entry })
  if (!await crossHutDoor(a, entry, outside)) return '重新对准小屋门以便回收'
  if ((await a.block(entry)).properties?.open) await a.call('interact', { pos: entry })
  return '从小屋出门回收并关门'
}

async function advanceToRecovery(a, target) {
  const p = a.here()
  const horizontal = Math.hypot(target[0]-p[0],target[2]-p[2])
  if (horizontal <= 14) return a.move(target,2)
  const dx = (target[0]-p[0])/horizontal
  const dz = (target[2]-p[2])/horizontal
  const {entities} = await a.call('get_entities',{types:['hostile'],radius:28})
  const failed = blockedRecoverySteps.get(a) ?? new Map()
  blockedRecoverySteps.set(a,failed)
  const now = Date.now()
  for (const [key,until] of failed) if (until<=now) failed.delete(key)
  let attempts = 0
  for (const offset of [0,-7,7,-12,12]) {
    const x = Math.round(p[0]+dx*13-dz*offset)
    const z = Math.round(p[2]+dz*13+dx*offset)
    const blocked = entities.some(enemy => {
      if (Math.hypot(enemy.pos[0]-p[0],enemy.pos[2]-p[2])>25 || Math.abs(enemy.pos[1]-p[1])>6) return false
      const stride = [x-p[0],z-p[2]]
      const along = Math.max(0,Math.min(1,
        ((enemy.pos[0]-p[0])*stride[0]+(enemy.pos[2]-p[2])*stride[1])/(stride[0]**2+stride[1]**2)))
      return Math.hypot(enemy.pos[0]-p[0]-along*stride[0],enemy.pos[2]-p[2]-along*stride[1])<5
    })
    if (blocked) continue
    for (const y of [0,1,-1,2,-2,3,-3]) {
      const goal = [x,p[1]+y,z]
      const key=goal.join(',')
      if (failed.has(key)) continue
      try {
        const [beneath,feet,head] = await Promise.all([a.block([x,goal[1]-1,z]),a.block(goal),a.block([x,goal[1]+1,z])])
        if (AIR.has(beneath.name) || /lava|water|magma|cactus|fire/.test(beneath.name) ||
            !AIR.has(feet.name) || !AIR.has(head.name)) continue
        if (++attempts>3) return
        await a.call('move_to',{pos:goal,range:1.2,timeout:4000,allow_partial:true,stop_on:['hurt','death']})
        await a.refresh()
        if (dist(a.here(),p)>1.5) return
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
      failed.set(key,Date.now()+15000)
    }
  }
  return a.move(target,2)
}

async function rebuildLateEquipment(a,m,save,log) {
  if (a.here()[1]<m.anchor[1]-3 && !a.tool('pickaxe')) {
    await climbBackForSupplies(a,m,save,log)
    return '沿已走矿道回地面整备'
  }
  const nearBase = dist(a.here(),m.anchor) <= 8
  const item = !a.tool('pickaxe') ? ['diamond_pickaxe',3,2] :
    !a.tool('sword') ? ['stone_sword',0,1] : null
  if (item) {
    const [name,diamonds,sticks] = item
    if (!await a.ensureSticks(sticks)) return '补充装备制作木棍'
    if (!nearBase) {
      await advanceToRecovery(a,m.anchor)
      return '回基地补齐丢失的装备'
    }
    if (a.count('diamond')<diamonds && !await a.takeStored('diamond',diamonds)) {
      const basic = name.replace('diamond_','wooden_')
      if (await a.ensurePlanks(diamonds) && await a.station('crafting_table')) await a.craft(basic)
      return '制作失装后的应急工具'
    }
    if (name==='stone_sword' && a.sum(block=>STONE_DROPS.has(block))<2) {
      await a.gather('stone',{nearby:true})
      return '为应急石剑采两块圆石'
    }
    if (await a.station('crafting_table')) await a.craft(name)
    return '用已存钻石重做必要装备'
  }
  if (!a.has('shield')) {
    if (!a.count('iron_ingot') && !(nearBase && await a.takeStored('iron_ingot',1))) {
      if (!a.count('raw_iron') && !await a.gather('iron',{nearby:true})) {
        delete m.rearm
        save()
        log('附近没有可直接采集的盾牌用铁，先续建小屋')
        return '剑镐已补齐，继续施工'
      }
      const fuel = a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : null
      if (fuel) await a.smelt('raw_iron',fuel,1)
      else if (await a.ensurePlanks(1)) {
        const wood = a.inventory.items.find(item=>item.name.endsWith('_planks'))
        if (wood) await a.smelt('raw_iron',wood.name,1)
      }
      return '熔炼盾牌用的铁'
    }
    if (!await a.ensurePlanks(6)) return '补充盾牌用木板'
    if (!nearBase) {
      await advanceToRecovery(a,m.anchor)
      return '带着材料回基地制作盾牌'
    }
    if (await a.station('crafting_table')) await a.craft('shield')
    return '补做盾牌后继续施工'
  }
  if (a.inventory.offhand?.name !== 'shield') await a.equip('shield','off-hand')
  delete m.rearm
  save()
  log('剑、镐和盾已重新整备')
  return '装备补齐，继续原有小屋工程'
}

async function runStep(a, m, save, plan, log, expeditionStep) {
  if (!m.surface) {
    m.surface = a.here()
    save()
  }
  const death = a.status.last_death
  if (death?.t && death.t !== m.death) {
    m.death = death.t
    const valuable = !!m.wasArmed
    if (valuable || !m.recoveryPriority || Date.now() >= m.recoveryUntil) {
      m.recovery = valuable ? death.pos : undefined
      m.recoveryPriority = valuable
      m.recoveryUntil = death.t + 480000
    }
    m.wasArmed = false
    delete m.shelter
    save()
  }
  const carryingDiamondTools = m.unlocked && a.inventory.items.some(item=>/^(?:diamond|netherite)_(?:pickaxe|sword)$/.test(item.name))
  if (!m.wasArmed && (carryingDiamondTools || plan.equippedDiamond() || a.tool('sword') && a.tool('pickaxe') &&
      Object.values(a.inventory.armor || {}).filter(item => item?.name).length >= 3)) {
    m.wasArmed = true
    save()
  }
  if (m.recoveryPriority) {
    for (const [slot,kind] of ARMOR_SLOTS) {
      const equipped=slot==='torso'?'chest':slot
      const recovered=['netherite','diamond','iron']
        .map(tier=>tier+'_'+kind).find(item=>a.count(item))
      if (recovered && !a.inventory.armor?.[equipped]) {
        await a.equip(recovered,slot)
        return '立即穿回 '+recovered
      }
    }
    if (a.count('shield') && !a.inventory.offhand) {
      await a.equip('shield','off-hand')
      return '立即装备拾回的盾牌'
    }
    const restored = plan.equippedDiamond() &&
      /^(diamond|netherite)_pickaxe$/.test(a.tool('pickaxe') || '') &&
      /^(diamond|netherite)_sword$/.test(a.tool('sword') || '') &&
      a.inventory.offhand?.name === 'shield'
    if (restored) {
      delete m.recovery
      delete m.recoveryPriority
      delete m.recoveryUntil
      save()
      log('钻套、剑、镐和盾均核实拾回，恢复原任务')
      return '装备已拾回，恢复施工'
    }
  }
  if (m.unlocked && m.anchor && !m.recoveryPriority && !m.rearm &&
      (!a.tool('sword') || !a.tool('pickaxe'))) {
    m.rearm = true
    save()
  }
  const unprotected = m.unlocked && !a.has('shield') &&
    Object.values(a.inventory.armor || {}).filter(item=>item?.name).length<2
  if (await a.safety({recovering:!!(m.recoveryPriority || m.rearm || unprotected)}))
    return a.retreating ? '持续撤离直到脱战' : '应对附近危险'
  if (m.unlocked && a.status.health < 15 && !m.recoveryPriority) {
    if (a.status.food < 18 && a.sum(name=>FOOD.test(name))) {
      await a.food()
      return '脱战后进食回血'
    }
    if (a.status.food < 18 && a.count('wheat')>=3 && m.anchor && dist(a.here(),m.anchor)<12) {
      if (await a.station('crafting_table')) await a.craft('bread',Math.min(4,Math.floor(a.count('wheat')/3)))
      return '用基地储备小麦做恢复用面包'
    }
    if (a.status.food < 18 && a.count('rotten_flesh')) {
      await a.call('use_item',{item:'rotten_flesh',stop_on:['hurt','death']})
      return '危急时补足饱食以恢复生命'
    }
    if (m.hut?.complete && a.status.health < 12 && a.status.food < 18) {
      await a.food()
      return '脱战后寻找食物恢复生命'
    }
    if (a.status.food >= 18) return '脱战恢复生命'
  }
  if (!m.unlocked && plan.equippedDiamond()) {
    const reserve = a.count('diamond')
    if (reserve > (m.diamonds || 0)) {
      m.diamonds = reserve
      save()
    }
  }
  if (await a.clearBackpack?.()) return '清理背包'
  if (a.status.pos[1] < 32 && /^(iron|diamond|netherite)_pickaxe$/.test(a.tool('pickaxe') || '') &&
      await a.recoverValuableDrops?.()) return '拾取附近掉落的贵重矿物'
  if (m.recovery && Date.now() > m.recoveryUntil) {
    delete m.recovery
    delete m.recoveryPriority
    save()
  }
  if (m.recovery) {
    const exit = await leaveHutForRecovery(a,m)
    if (exit) return exit
    if (dist(a.here(), m.recovery) > 4) {
      await advanceToRecovery(a,m.recovery)
      return '优先返回有装备的死亡点'
    }
    const drops = (await a.call('get_entities', { types: ['item'], radius: 8 })).entities
    const dropped = drops.filter(e => dist(e.pos,m.recovery)<8)
      .sort((x,y) => Number(/^(diamond_|netherite_|shieldx)/.test(y.item||'')) -
        Number(/^(diamond_|netherite_|shieldx)/.test(x.item||'')) || x.dist-y.dist)[0]
    if (dropped) {
      await a.call('move_to',{entity_id:dropped.id,range:0.4,timeout:4000,stop_on:['hurt','death']})
      return '拾回掉落物'
    }
    delete m.recovery
    delete m.recoveryPriority
    save()
  }
  for (const [slot, kind] of ARMOR_SLOTS) {
    const armorSlot = slot === 'torso' ? 'chest' : slot
    const worn = a.inventory.armor?.[armorSlot]?.name
    if (armorSlot==='feet' && worn==='golden_boots' && (a.status.dimension==='the_nether' ||
        m.nether?.goldBootsForNether && !m.nether.returning && !m.nether.completed)) continue
    const tiers = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather']
    const better = tiers
      .map((t) => t + '_' + kind)
      .find((n) => a.count(n) && (!worn || tiers.indexOf(n.split('_')[0]) < tiers.indexOf(worn.split('_')[0])))
    if (better) {
      await a.equip(better, slot)
      return '装备 ' + better
    }
  }
  if (a.count('shield') && !a.inventory.offhand) {
    await a.equip('shield', 'off-hand')
    return '装备盾牌'
  }
  if (a.status.food <= 16 && (a.sum(n=>FOOD.test(n)) || !m.furnace)) {
    await a.food()
    return '补给食物'
  }
  if (m.pickup) {
    await a.reclaim(m.pickup.item)
    return '继续回收临时工作站'
  }
  if (a.status.dimension === 'the_nether' && expeditionStep) return expeditionStep(a, m, save)
  if (a.status.dimension === 'the_nether' && a.hasReportedDebris) {
    if (!/^(diamond|netherite)_pickaxe$/.test(a.tool('pickaxe') || '')) return '远古残骸需要钻石级镐'
    if (!a.hasReportedDebris()) return '等待旁观者确认下界矿点'
    await a.gather('debris')
    return '按旁观者矿点采集远古残骸'
  }
  if (!m.openingCoalStocked && a.count('coal') + a.count('charcoal') >= OPENING_COAL_TARGET) {
    m.openingCoalStocked = true
    save()
    log('开局煤储备已达到 ' + OPENING_COAL_TARGET + ' 个')
  }
  const retry = m.shelterRetry
  const skipNightShelter = Boolean(retry && retry.until > Date.now() && dist(a.here(), retry.origin) < 4)
  const stage = plan.stage({skipNightShelter}),
    name = stage.name
  if (name === 'first_night' || m.shelter) {
    await shelter(a, m, save, log)
    return '夜间避难'
  }
  const sitePlank = a.inventory.items.find(item=>item.name.endsWith('_planks'))
  const fuel = a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : sitePlank?.name
  if (m.furnace && m.furnaceFuelNeeded && !fuel) {
    if (a.sum(name=>LOG_NAMES.has(name))) await a.ensurePlanks(Math.ceil(m.furnaceFuelNeeded*2/3))
    else if (m.hut?.complete && m.anchor && a.here()[1]>=m.anchor[1]-7 && !a.status.in_water) {
      const start=a.here()
      if (m.furnaceFuelStuck && dist(start,m.furnaceFuelStuck)<=4 && start[1]<m.furnace[1]+3 &&
          await a.stair(start[1]+1,{exploreIfBlocked:false}))
        return '从低洼熔炉站位挖台阶上地面取燃料'
      await a.gather('wood')
      await a.refresh()
      const stuck=dist(a.here(),start)<1.2 && !a.sum(name=>LOG_NAMES.has(name) || name.endsWith('_planks'))
      if (stuck || m.furnaceFuelStuck) {
        m.furnaceFuelStuck=stuck?start:undefined
        save()
      }
    } else await a.gather('coal')
    return '先补足燃料再回熔炉'
  }
  if (m.furnaceFuelNeeded) {
    delete m.furnaceFuelNeeded
    delete m.furnaceFuelStuck
    save()
  }
  if (m.furnace) {
    const target = { pos: m.furnace }
    let view
    try {
      if (dist(a.here(), m.furnace) > 4) await a.move(m.furnace, 2)
      if ((await a.block(m.furnace)).name !== 'furnace') {
        delete m.furnace
        delete m.furnaceLoaded
        save()
        return '重新定位熔炉'
      }
      view = await a.call('window/view', { target })
    } catch (error) {
      if (!recoverable.has(error.code) || error.code === 'movement_interrupted' || m.furnaceLoaded !== false) throw error
      log('空熔炉无法打开，保留背包原料并改换站位 ' + m.furnace.join(','))
      delete m.furnace
      delete m.furnaceLoaded
      save()
      return '改换空熔炉站位'
    }
    if (view.sections.input.length && !view.info.burning && !view.sections.fuel.length && !fuel) {
      m.furnaceFuelNeeded=view.sections.input.reduce((total,item)=>total+item.count,0)
      save()
      return '补充炉用燃料'
    }
    if (view.info.burning && view.sections.input.length && !view.sections.output.length) {
      if (name === 'find_iron' && a.count('raw_iron') < 8 && Date.now() >= (nextFurnaceWork.get(a) ?? 0)) {
        if (await a.gatherNearby?.('iron',{within:{center:m.furnace,radius:2.5}}))
          return '熔炼期间采集炉边粗铁'
        nextFurnaceWork.set(a,Date.now()+3500)
      }
      return '熔炼、取货和回收临时熔炉'
    }
    await a.smelt(null, fuel)
    return '熔炼、取货和回收临时熔炉'
  }
  if (m.rearm && !m.recoveryPriority) {
    const roofedHut = expeditionStep && m.hut?.index>=75
    const atRoofedHut = roofedHut && dist(a.here(),m.hut.center)<15 && a.here()[1]>=m.hut.center[1]-4
    if (roofedHut && !m.nether?.bedVerified && !atRoofedHut &&
        a.here()[1]>=m.hut.center[1]-4) {
      await advanceToRecovery(a,add(m.hut.center,[0,0,3]))
      return '先回已经封顶的小屋躲避'
    }
    if (atRoofedHut && !m.nether?.bedVerified) return expeditionStep(a,m,save)
    if (atRoofedHut && !m.hut.complete) return await baseStep(a,m,save,log,expeditionStep) || '先封好小屋'
    if (atRoofedHut && (!m.nether?.bedVerified || !m.nether?.bedDoorClosed)) return expeditionStep(a,m,save)
    return rebuildLateEquipment(a,m,save,log)
  }
  const constructingBase = name === 'supply_base' && m.anchor && !m.hut?.complete
  if ((!constructingBase || a.status.food < 17) &&
      Date.now() >= (nextFoodStock.get(a) ?? 0) && /^(stone|iron|diamond|netherite)_/.test(a.tool('sword') || '') &&
      a.sum(n=>FOOD.test(n)) < 8 && (a.here()[1] >= (m.surface?.[1] ?? 60) - 5 || a.count('wheat') >= 3)) {
    nextFoodStock.set(a, Date.now() + 12000)
    if (await a.food({stock:8,exploreIfMissing:false})) return '补充随身食物储备'
  }
  if (!m.openingWoodStocked && a.status.dimension === 'overworld' &&
      ['get_stone','find_coal','find_iron','find_diamond'].includes(name)) {
    const heightBelowSurface = m.surface[1] - a.here()[1]
    if (a.sum(item => LOG_NAMES.has(item)) >= OPENING_LOG_TARGET) {
      m.openingWoodStocked = true
      save()
      log('开局已备好 ' + OPENING_LOG_TARGET + ' 根原木')
    } else if (name === 'get_stone' && heightBelowSurface <= 8 && !plan.gear.hasStoneGradeTool('pickaxe')) {
      if (!a.tool('axe')) {
        if (await a.ensureSticks(2) && await a.station('crafting_table') && await a.ensurePlanks(3)) {
          await a.craft('wooden_axe')
          await a.reclaim('crafting_table')
        }
        return '制作采集备用木材的木斧'
      }
      await a.gather('wood')
      return '进矿前采集备用原木'
    } else if (a.tool('axe') && heightBelowSurface <= 12 && Date.now() >= (nextOpeningWoodStock.get(a) ?? 0)) {
      // A first descent can miss the opening wood task. Resume from real nearby logs,
      // and keep normal progression available if that part of the slope has no trees.
      if (await a.gatherNearby?.('wood')) return '补齐开局备用原木'
      nextOpeningWoodStock.set(a,Date.now()+12000)
    }
  }
  const nextUpgrade = name === 'find_iron' ? plan.gear.nextIronUpgrade() : undefined
  const ironReady = nextUpgrade && a.count('iron_ingot') >= nextUpgrade.cost
  const stonePickReady = name === 'get_stone' && !plan.gear.hasStoneGradeTool('pickaxe') &&
    (m.woodReturn || a.sum(item => STONE_DROPS.has(item)) >= 3)
  const tablePlanks = a.count('crafting_table') || hasNearbyTable(a, m) ? 0 : 4
  if (ironReady || stonePickReady) {
    const sticks = stonePickReady ? 2 : nextUpgrade.sticks || 0
    const otherPlanks = stonePickReady ? 0 : nextUpgrade.planks || 0
    const planksForSticks = a.count('stick') < sticks ? 2 : 0
    const needsWood = a.sum(item => item.endsWith('_planks')) + 4 * a.sum(item => LOG_NAMES.has(item)) <
      planksForSticks + otherPlanks + tablePlanks
    if (needsWood && a.here()[1] < m.surface[1] - 6) {
      const journal = process.env.MC_NMO_RETURN_JOURNAL
      if (journal) {
        const route = m.woodReturn ??= {}
        await followRecordedExit(a, route, m.surface, save, log, journal, '已回到可补充木材的地表')
      } else await a.stair(m.surface[1])
      return '沿原矿道返回补充工具用木材'
    }
    if (m.woodReturn) {
      delete m.woodReturn
      save()
    }
  }
  const light = await lightTravel(a,m)
  if (light) return light
  if (name === 'supply_base') {
    if (!m.unlocked && a.count('lapis_lazuli') < BASE_LAPIS_TARGET) {
      if (!await a.gatherNearby?.('lapis', { recoverDrops: true })) await a.gather('lapis')
      return '回基地前采集青金石 ' + a.count('lapis_lazuli') + '/' + BASE_LAPIS_TARGET
    }
    const result = await baseStep(a, m, save, log, expeditionStep)
    return result || '补给基地与红石工坊'
  }
  const ready = plan.gear.readyGearUpgrades()[0]
  if (ready) {
    if (!(await a.ensureSticks(ready.sticks || 0))) return name
    if (await a.station('crafting_table') && await a.ensurePlanks(ready.planks || 0)) {
      await a.craft(ready.item)
      await a.reclaim('crafting_table')
    }
    return '制作 ' + ready.item
  }
  if (name === 'gather_wood') {
    if (!a.tool('axe') && a.sum((n) => LOG_NAMES.has(n)) * 4 + a.sum((n) => n.endsWith('_planks')) >= 12) {
      if (!(await a.ensureSticks(2))) return name
      if (await a.station('crafting_table') && await a.ensurePlanks(3)) {
        await a.craft('wooden_axe')
        await a.reclaim('crafting_table')
      }
    } else await a.gather('wood')
  } else if (name === 'wood_tools') {
    if (!(await a.ensureSticks(2))) return name
    if (await a.station('crafting_table') && await a.ensurePlanks(3)) {
      await a.craft('wooden_pickaxe')
      if (!a.tool('sword') && a.count('stick') && (await a.ensurePlanks(2))) await a.craft('wooden_sword')
      await a.reclaim('crafting_table')
    }
  } else if (name === 'get_stone') {
    const kind = ['pickaxe', 'sword', 'axe'].find((k) => !plan.gear.hasStoneGradeTool(k))
    const cost = kind === 'sword' ? 2 : 3
    if (a.sum((n) => STONE_DROPS.has(n)) < cost) {
      await a.gather('stone')
      return name
    }
    if (!(await a.ensureSticks(kind === 'sword' ? 1 : 2))) return name
    if (await a.station('crafting_table')) {
      await a.craft('stone_' + kind)
      await a.reclaim('crafting_table')
    }
  } else if (name === 'find_coal') await a.gather('coal')
  else if (name === 'find_iron') {
    if (ironReady) {
      if (await a.ensureSticks(nextUpgrade.sticks || 0))
        await a.ensurePlanks((nextUpgrade.planks || 0) + tablePlanks)
    } else {
      const raw = a.count('raw_iron')
      const remaining = nextUpgrade ? nextUpgrade.cost - a.count('iron_ingot') : 4
      const batchSize = Math.min(8, Math.max(1, remaining))
      if (raw >= batchSize) {
        delete m.ironDryAttempts
        if (fuel) await a.smelt('raw_iron', fuel)
        else await a.gather('coal')
      } else {
        const nearbyIron = await a.gatherNearby?.('iron',{recoverDrops:true})
        if (!nearbyIron && a.count('coal') + a.count('charcoal') < OPENING_COAL_TARGET && await a.gatherNearby?.('coal'))
          return '顺手补足照明和熔炼用煤'
        const progressed = nearbyIron || await a.gather('iron')
        await a.refresh()
        if (a.count('raw_iron') > raw) delete m.ironDryAttempts
        else m.ironDryAttempts = (m.ironDryAttempts || 0) + Number(!progressed)
        if (a.count('raw_iron') && fuel && m.ironDryAttempts >= 4) {
          delete m.ironDryAttempts
          await a.smelt('raw_iron', fuel)
        }
      }
      save()
    }
  } else if (name === 'find_diamond') {
    if (a.count('torch') < 8 && a.count('coal') + a.count('charcoal') > MIN_SMELTING_FUEL) {
      if (await a.ensureSticks(1)) await a.craft('torch')
      return name
    }
    if (
      a.count('diamond') >= 3 &&
      !a.sum((n) => LOG_NAMES.has(n) || n.endsWith('_planks')) &&
      !a.count('stick')
    ) {
      await a.gather('wood')
      return name
    }
    const qualified = plan.equippedDiamond()
    const before = a.count('diamond')
    const immediate = await a.gatherNearby?.('diamond')
    if (!immediate) {
      if (a.count('coal') < 8 && await a.gatherNearby?.('coal')) return '顺手采集可直接挖的煤'
      if (a.count('raw_iron') + a.count('iron_ingot') < 4 && await a.gatherNearby?.('iron'))
        return '顺手采集可直接挖的铁'
      await a.gather('diamond')
    }
    if (qualified) {
      const carried = a.count('diamond')
      m.diamonds = Math.max(m.diamonds + Math.max(0,carried-before), carried)
      save()
    }
  } else if (name === 'eat_food' || name === 'hunt_food') await a.food()
  else throw Error('未知生存阶段 ' + name)
  return name
}
async function runSurvival(env, { log = console.log, sleep = delay, signal } = {}) {
  let stopDefense, observer
  const chooseTarget = createNmoPlanner(env, { log, signal, onModel: result => observer?.observeModel(result) })
  const api = new NmoClient(env),
    ownSession = !api.token
  if (ownSession) {
    if (!env.MC_AGENT_USERNAME || !env.MC_AGENT_PASSWORD) throw Error('需要 MC_AGENT_TOKEN 或本机 NMO 登录凭据')
    api.token = (
      await api.request('auth/login', { username: env.MC_AGENT_USERNAME, password: env.MC_AGENT_PASSWORD })
    ).token
  }
  try {
    const first = await waitReady(api, sleep),
      { memory, save } = checkpoint(env, api, first)
    const observerPort = env.MC_NMO_OBSERVER_PORT ?? 3001
    if (observerPort !== 'off') {
      try {
        observer = await startNmoObserver(api, first, { port: observerPort, log, modelEnabled: Boolean(chooseTarget), tokenStart: Number(env.MC_NMO_TOKEN_START) || 0 })
      } catch (error) {
        log('赛事观察者启动失败：' + error.message)
      }
    }
    const ledger = createStorageLedger(memory.world, { directory: env.MC_STORAGE_LEDGER_DIR, log })
    const recordedApi = { call: async (action, body) => {
      const finish = action === 'move_to' ? observer?.beginMove(body)
        : action === 'dig' ? observer?.beginDig(body) : undefined
      const at = Date.now()
      try {
        const receipt = await api.call(action, body)
        if (action === 'status') observer?.observeStatus(receipt, at)
        if (action === 'inventory') observer?.observeInventory(receipt, at)
        recordNmoStorage(ledger, first.dimension, action, body, receipt)
        return receipt
      } finally {
        finish?.()
      }
    } }
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(new URL(api.base).hostname)
    const a = actions(recordedApi, memory, save, log, chooseTarget, {
      volumeScan: loopback && env.MC_NMO_ORE_SURVEY !== '0',
      observerOres: observer?.oreCandidates,
      oreSurveyPending: observer?.oreSurveyPending,
      forgetObserverOre: observer?.forgetOre,
      setMineTarget: observer?.setMineTarget,
      clearMineTarget: observer?.clearMineTarget,
    }),
      plan = strategy(a, memory)
    stopDefense = a.startDefense()
    a.takeStored = async (item, min) => {
      const records = ledger.find(first.dimension, item, a.here(), 16)
      for (const box of records) {
        try {
          if (!isStorageBlock((await a.block(box.pos)).name)) continue
          const target = { pos: box.pos }
          const view = await a.call('window/view', { target })
          if (!isStorageBlock(view.target)) continue
          const available = (view.sections?.container || []).reduce((n, stack) => n + (stack.name === item ? stack.count : 0), 0)
          if (!available) continue
          const count = Math.min(available, min - a.count(item))
          await a.call('window/act', { target, ops: [{ op: 'take', from: 'container', item, count }] })
          await a.refresh()
          if (a.count(item) >= min) return true
        } catch (error) {
          if (!recoverable.has(error.code) && !['inventory_full', 'no_window', 'missing_item'].includes(error.code)) throw error
        }
      }
      return false
    }
    const lateFile = env.MC_NMO_LATE_STAGES === '1' ? path.join(__dirname, 'nmo-full-route.js') : env.MC_NMO_LATE_STAGES
    const expeditionStep = lateFile ? async (a, m, save) => {
      if (!fs.existsSync(lateFile)) return '等待后段模块'
      return require(lateFile).step(a, m, save, { env, signal, log,
        observeModel: result => observer?.observeModel(result) })
    } : undefined
    let previous,
      nextConnect = 0,
      failures = 0
    while (!signal?.aborted) {
      try {
        const at = Date.now()
        const status = await api.call('status')
        observer?.observeStatus(status, at)
        if (status.gamemode && status.gamemode !== 'survival') throw Error('角色当前模式为 ' + status.gamemode)
        if (status.ready && status.alive !== false && !status.busy) {
          if (status.server !== first.server ||
              (status.dimension !== first.dimension && !(lateFile && memory.nether?.portal)))
            throw Error('角色已切换世界，需重新启动并核对存档')
          await a.refresh()
          const stage = await runStep(a, memory, save, plan, log, expeditionStep)
          observer?.setStage(stage)
          if (stage !== previous) log('当前阶段 ' + stage)
          previous = stage
          failures = 0
        }
      } catch (e) {
        if (signal?.aborted) break
        if (
          ['invalid_token', 'unauthorized', 'invalid_credentials'].includes(e.code) ||
          /角色当前模式|切换世界/.test(e.message)
        )
          throw e
        if (e.code === 'not_connected' && Date.now() >= nextConnect) {
          nextConnect = Date.now() + 15000
          try {
            await api.call('connect', {})
          } catch (connectError) {
            log('等待重新连接 ' + connectError.message)
          }
        }
        log('动作暂停并重新观测 ' + e.message)
        if (
          !recoverable.has(e.code) &&
          ![
            'not_ready',
            'not_connected',
            'interrupted',
            'busy',
            'missing_ingredients',
            'missing_item',
            'no_such_entity',
          ].includes(e.code) &&
          ++failures >= 5
        )
          throw e
      }
      await sleep(650)
    }
  } finally {
    await stopDefense?.()
    await observer?.close()
    if (ownSession && api.token) await api.request('auth/logout', {})
  }
}
if (require.main === module) {
  try {
    process.loadEnvFile()
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const stop = new AbortController()
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => stop.abort())
  runSurvival(process.env, { signal: stop.signal }).catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
}
module.exports = { runSurvival, runStep, strategy, checkpoint }
