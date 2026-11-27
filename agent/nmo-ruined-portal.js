const { createStructureStore } = require('./structure-survey')
const { AIR, add, dist, recoverable } = require('./nmo-actions')

const resource = 'crying_obsidian'
const pick = /^(diamond|netherite)_pickaxe$/
const unsafe = /water|lava|magma|campfire|fire|cactus|powder_snow|air$/
const directions = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]

function portalCandidates(world, origin, skipped = {}, now = Date.now()) {
  return createStructureStore().list().filter(entry =>
    entry.world === world && entry.dimension === 'overworld' && entry.type === 'ruined_portal' &&
    (skipped[entry.pos.join(',')] || 0) <= now)
    .map(entry => ({
      kind: 'crying_obsidian', key: entry.pos.join(','), label: '前往废弃传送门采集哭泣的黑曜石',
      pos: entry.pos, evidence: entry.evidence, distance: Math.round(dist(entry.pos, origin)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
}

async function approachPortal(a, from, target) {
  const horizontal = Math.hypot(target[0] - from[0], target[2] - from[2])
  if (horizontal <= 20) return a.move(target, 6)
  const dx = (target[0] - from[0]) / horizontal
  const dz = (target[2] - from[2]) / horizontal
  for (const side of [0, 5, -5]) {
    const x = Math.round(from[0] + dx * 14 - dz * side)
    const z = Math.round(from[2] + dz * 14 + dx * side)
    for (const delta of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const p = [x, from[1] + delta, z]
      const [floor, feet, head] = await Promise.all([
        a.block(add(p, [0, -1, 0])), a.block(p), a.block(add(p, [0, 1, 0])),
      ])
      if (unsafe.test(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name)) continue
      try {
        return await a.move(p, 1)
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
    }
  }
  throw Object.assign(Error('遗迹方向未找到安全中转站位'), { code: 'path_not_found' })
}

async function visitPortal(a, n, target, save, log) {
  const state = n.ruinedPortal
  const postpone = reason => {
    state.skipped[target.key] = Date.now() + 120000
    delete state.target
    save()
    log('废弃传送门暂缓 ' + target.key + ' ' + reason)
    return '保留遗迹坐标，继续既定目标'
  }
  const origin = a.here()
  if (!pick.test(a.tool('pickaxe') || '') || a.status.health < 16 || a.status.food < 14 ||
      a.status.in_water || a.status.in_lava || a.status.on_fire || a.status.nearest_hostile?.dist < 8)
    return postpone('装备、补给或附近威胁不满足')

  try {
    if (dist(origin, target.pos) > 10) {
      await approachPortal(a, origin, target.pos)
      return '按目击坐标接近废弃传送门'
    }
    const observed = await a.block(target.pos)
    const candidates = observed.name === resource ? [observed] :
      (await a.find([resource], 16, 8)).filter(block => dist(block.pos, target.pos) <= 12)
    for (const block of candidates) {
      for (const direction of directions) {
        const stand = add(block.pos, direction)
        const [floor, feet, head, below, above, ...adjacent] = await Promise.all([
          a.block(add(stand, [0, -1, 0])), a.block(stand), a.block(add(stand, [0, 1, 0])),
          a.block(add(block.pos, [0, -1, 0])), a.block(add(block.pos, [0, 1, 0])),
          ...directions.map(delta => a.block(add(block.pos, delta))),
        ])
        if (unsafe.test(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name) ||
            [below, above, ...adjacent].some(b => /lava|magma|fire/.test(b.name))) continue
        await a.move(stand, 0)
        await a.refresh()
        if (a.status.health < 16 || a.status.nearest_hostile?.dist < 8) return postpone('采掘前发现威胁')
        if ((await a.block(block.pos)).name !== resource) continue
        const before = a.count(resource)
        await a.equip(a.tool('pickaxe'))
        const result = await a.call('dig', { pos: block.pos, collect: true, timeout: 18000, stop_on: ['hurt', 'death'] })
        await a.refresh()
        if (a.count(resource) === before && !result.interrupted_by)
          await a.recoverValuableDrops({ target: block.pos, names: [resource] })
        if (a.count(resource) <= before) return postpone('尚未在背包确认掉落物')
        state.obtained = { pos: block.pos, count: a.count(resource) - before }
        delete state.target
        save()
        log('确认哭泣的黑曜石入包 ' + block.pos.join(','))
        return '已捡到哭泣的黑曜石'
      }
    }
    return postpone('实地未找到安全采掘站位')
  } catch (error) {
    if (!recoverable.has(error.code) && error.code !== 'movement_interrupted') throw error
    return postpone(error.code)
  }
}

async function ruinedPortalStep(a, n, save, context, choose) {
  if (n.ruinedPortal?.obtained || a.count(resource)) return
  const state = n.ruinedPortal ??= { skipped: {}, deferUntil: 0 }
  if (state.target) return visitPortal(a, n, state.target, save, context.log)
  if (!pick.test(a.tool('pickaxe') || '') || a.status.health < 16 || a.status.food < 14 ||
      a.status.nearest_hostile?.dist < 8 || state.deferUntil > Date.now()) return
  const reports = portalCandidates(context.env.MC_NMO_STRUCTURE_WORLD || context.env.MC_NMO_WORLD, a.here(), state.skipped)
  if (!reports.length) return
  const options = [...reports, { kind: 'continue', label: '继续下界门和基地任务，保留遗迹坐标' }]
  const decision = await choose(a, n, context, options, '主世界遗迹与下界准备')
  if (!decision) return
  if (decision.kind === 'crying_obsidian') state.target = decision
  else state.deferUntil = Date.now() + 180000
  save()
  if (state.target) return visitPortal(a, n, state.target, save, context.log)
}

module.exports = { portalCandidates, ruinedPortalStep }
