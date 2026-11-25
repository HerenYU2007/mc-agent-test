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
const { baseStep } = require('./nmo-base')
const { createStorageLedger, recordNmoStorage, isStorageBlock } = require('./storage-ledger')
const { startNmoObserver } = require('./nmo-observer')

function checkpoint(env, api, status) {
  const world = JSON.stringify([
    api.base,
    status.server || '',
    status.username,
    status.dimension,
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
    findNearestBlock: () => m.crafting_table && dist(a.here(), m.crafting_table) <= 4,
    getEdibleFoods: () => a.inventory.items.filter((i) => FOOD.test(i.name)),
    isNightShelterTime: (t) => t >= 12000 && t <= 23500,
  }
  Object.assign(f, createEquipment(rt, f))
  const progression = createProgression(rt, f)
  function snapshot() {
    const raw = a.count('raw_iron'),
      iron = raw + a.count('iron_ingot'),
      p = a.here()
    return {
      timeOfDay: a.status.time_of_day,
      food: a.status.food,
      position: { x: p[0], y: p[1], z: p[2] },
      nightShelterTerrain: m.surface && Math.abs(p[1] - m.surface[1]) < 8 ? 'open' : 'covered',
      logs: a.sum((n) => LOG_NAMES.has(n)),
      planks: f.plankCount(),
      sticks: a.count('stick'),
      cobblestone: a.sum((n) => STONE_DROPS.has(n)),
      hasPickaxe: !!a.tool('pickaxe'),
      hasSword: !!a.tool('sword'),
      hasIronPickaxe: /^(iron|diamond|netherite)_/.test(a.tool('pickaxe') || ''),
      iron,
      rawIron: raw,
      coal: a.count('coal'),
      charcoal: a.count('charcoal'),
      torches: a.count('torch'),
    }
  }
  return {
    stage: () => progression.computeStage(snapshot()),
    gear: f,
    equippedDiamond: () =>
      ['head', 'chest', 'legs', 'feet'].every((k) =>
        /^(diamond|netherite)_/.test(a.inventory.armor?.[k]?.name || ''),
      ),
  }
}
async function shelter(a, m, save) {
  const night = a.status.time_of_day >= 12000 && a.status.time_of_day <= 23500
  if (!night) {
    for (const piece of (m.shelter?.doorBlocks || []).slice().reverse()) {
      if (dist(a.here(), piece.pos) < 4 && (await a.block(piece.pos)).name === piece.item)
        await a.call('dig', { pos: piece.pos, collect: true })
    }
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
  for (const offset of m.shelter.offsets) {
    const pos = add(m.shelter.origin, offset)
    if (!AIR.has((await a.block(pos)).name)) continue
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
    await a.placeAt(item.name, pos)
    if (offset[0] === 0 && offset[2] === -1 && offset[1] <= 1) {
      m.shelter.doorBlocks ??= []
      m.shelter.doorBlocks.push({ pos, item: item.name })
    }
    save()
    return
  }
}
async function runStep(a, m, save, plan, log) {
  if (!m.surface) {
    m.surface = a.here()
    save()
  }
  if (await a.safety()) return '应对附近危险'
  const death = a.status.last_death
  if (death?.t && death.t !== m.death) {
    m.death = death.t
    m.recovery = death.pos
    m.recoveryUntil = Date.now() + 240000
    delete m.shelter
    save()
  }
  if (m.recovery && Date.now() > m.recoveryUntil) {
    delete m.recovery
    save()
  }
  if (m.recovery) {
    if (dist(a.here(), m.recovery) > 4) {
      await a.move(m.recovery, 2)
      return '返回死亡位置'
    }
    const drops = (await a.call('get_entities', { types: ['item'], radius: 8 })).entities
    const dropped = drops.find((e) => dist(e.pos, m.recovery) < 6)
    if (dropped) {
      await a.move(dropped.pos, 0)
      return '拾回掉落物'
    }
    delete m.recovery
    save()
  }
  for (const [slot, kind] of ARMOR_SLOTS) {
    const armorSlot = slot === 'torso' ? 'chest' : slot
    const worn = a.inventory.armor?.[armorSlot]?.name
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
  if (a.status.food <= 10) {
    await a.food()
    return '补给食物'
  }
  if (m.pickup) {
    await a.reclaim(m.pickup.item)
    return '继续回收临时工作站'
  }
  if (a.status.dimension === 'the_nether' && a.hasReportedDebris) {
    if (!/^(diamond|netherite)_pickaxe$/.test(a.tool('pickaxe') || '')) return '远古残骸需要钻石级镐'
    if (!a.hasReportedDebris()) return '等待旁观者确认下界矿点'
    await a.gather('debris')
    return '按旁观者矿点采集远古残骸'
  }
  const stage = plan.stage(),
    name = stage.name
  if (name === 'first_night' || m.shelter) {
    await shelter(a, m, save)
    return '夜间避难'
  }
  const fuel = a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : null
  if (m.furnace) {
    const target = { pos: m.furnace }
    if (dist(a.here(), m.furnace) > 4) await a.move(m.furnace, 2)
    if ((await a.block(m.furnace)).name !== 'furnace') {
      delete m.furnace
      save()
      return '重新定位熔炉'
    }
    const view = await a.call('window/view', { target })
    if (view.sections.input.length && !view.info.burning && !view.sections.fuel.length && !fuel) {
      await a.gather('coal')
      return '补充炉用燃料'
    }
    await a.smelt(null, fuel)
    return '熔炼、取货和回收临时熔炉'
  }
  if (name === 'supply_base') {
    await baseStep(a, m, save, log)
    return '补给基地与红石工坊'
  }
  const ready = plan.gear.readyGearUpgrades()[0]
  if (ready) {
    if (!(await a.ensurePlanks(ready.planks || 0)) || !(await a.ensureSticks(ready.sticks || 0))) return name
    if (await a.station('crafting_table')) {
      await a.craft(ready.item)
      await a.reclaim('crafting_table')
    }
    return '制作 ' + ready.item
  }
  if (name === 'gather_wood') {
    if (!a.tool('axe') && a.sum((n) => LOG_NAMES.has(n)) * 4 + a.sum((n) => n.endsWith('_planks')) >= 12) {
      if (!(await a.ensureSticks(2)) || !(await a.ensurePlanks(3))) return name
      if (await a.station('crafting_table')) {
        await a.craft('wooden_axe')
        await a.reclaim('crafting_table')
      }
    } else await a.gather('wood')
  } else if (name === 'wood_tools') {
    if (!(await a.ensureSticks(2)) || !(await a.ensurePlanks(3))) return name
    if (await a.station('crafting_table')) {
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
    const upgrade = plan.gear.nextIronUpgrade()
    if (upgrade && a.count('iron_ingot') >= upgrade.cost) {
      await a.ensureSticks(upgrade.sticks || 0)
      await a.ensurePlanks((upgrade.planks || 0) + (a.count('crafting_table') || m.crafting_table ? 0 : 4))
    } else if (a.count('raw_iron') && fuel) await a.smelt('raw_iron', fuel)
    else await a.gather(a.count('raw_iron') ? 'coal' : 'iron')
  } else if (name === 'find_diamond') {
    if (a.count('torch') < 8 && fuel && a.count(fuel) > 1) {
      if (await a.ensureSticks(2)) await a.craft('torch', 8 - a.count('torch'))
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
    const qualified = plan.equippedDiamond(),
      before = a.count('diamond')
    await a.gather('diamond')
    if (qualified) {
      m.diamonds += Math.max(0, a.count('diamond') - before)
      save()
    }
  } else if (name === 'eat_food' || name === 'hunt_food') await a.food()
  else throw Error('未知生存阶段 ' + name)
  return name
}
async function runSurvival(env, { log = console.log, sleep = delay, signal } = {}) {
  const chooseTarget = createNmoPlanner(env, { log, signal })
  const api = new NmoClient(env),
    ownSession = !api.token
  if (ownSession) {
    if (!env.MC_AGENT_USERNAME || !env.MC_AGENT_PASSWORD) throw Error('需要 MC_AGENT_TOKEN 或本机 NMO 登录凭据')
    api.token = (
      await api.request('auth/login', { username: env.MC_AGENT_USERNAME, password: env.MC_AGENT_PASSWORD })
    ).token
  }
  let stopDefense, observer
  try {
    const first = await waitReady(api, sleep),
      { memory, save } = checkpoint(env, api, first)
    const observerPort = env.MC_NMO_OBSERVER_PORT ?? 3001
    if (observerPort !== 'off') {
      try {
        observer = await startNmoObserver(api, first, { port: observerPort, log, modelEnabled: Boolean(chooseTarget) })
      } catch (error) {
        log('赛事观察者启动失败：' + error.message)
      }
    }
    const ledger = createStorageLedger(memory.world, { directory: env.MC_STORAGE_LEDGER_DIR, log })
    const recordedApi = { call: async (action, body) => {
      const finishMove = action === 'move_to' ? observer?.beginMove(body) : undefined
      const at = Date.now()
      try {
        const receipt = await api.call(action, body)
        if (action === 'status') observer?.observeStatus(receipt, at)
        if (action === 'inventory') observer?.observeInventory(receipt, at)
        recordNmoStorage(ledger, first.dimension, action, body, receipt)
        return receipt
      } finally {
        finishMove?.()
      }
    } }
    const loopback = ['127.0.0.1','localhost','[::1]'].includes(new URL(api.base).hostname)
    const a = actions(recordedApi, memory, save, log, chooseTarget, {
      volumeScan: loopback && env.MC_NMO_ORE_SURVEY !== '0',
      observerOres: observer?.oreCandidates,
      oreSurveyPending: observer?.oreSurveyPending,
      forgetObserverOre: observer?.forgetOre,
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
          if (status.dimension !== first.dimension || status.server !== first.server)
            throw Error('角色已切换世界，需重新启动并核对存档')
          await a.refresh()
          const stage = await runStep(a, memory, save, plan, log)
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
