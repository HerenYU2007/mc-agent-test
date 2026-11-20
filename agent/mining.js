const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const {
  STONE_DROPS, STONE_TARGETS, COAL_TARGETS, DEFAULT_MINE_TARGET_NAMES, WATER_BLOCK_NAMES, STONE_TARGET,
  IRON_INPUT_NAMES, ORE_SCAN_RADIUS, BLOCK_MINE_RADIUS,
} = require('./config')

const COAL_DROPS = new Set(['coal'])
const ORE_CACHE_LIMIT = 128

function createMining(runtimeState, features) {
  let nextMineSearchAt = 0

  const knownOres = new Map()

  let lastOreScan = null

  // This flag describes an active mining task, not whether night shelter is safe.
  function miningUnderground() {
    return features.isUndergroundNow() && (runtimeState.mineMode || runtimeState.mineBusy || runtimeState.lastDecision === 'mine' ||
      runtimeState.lastDecision === 'gather-stone-for-tools' || runtimeState.lastDecision === 'gather-coal-for-torches') &&
      runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
  }

  function mineTargetSetFromName(targetName = '') {
    const normalized = String(targetName || '').trim().toLowerCase().replace(/^minecraft:/, '')
    if (!normalized) return new Set(DEFAULT_MINE_TARGET_NAMES)
    if (normalized === 'coal') return COAL_TARGETS
    if (normalized === 'stone') return STONE_TARGETS
    const aliases = {
      coal: ['coal_ore', 'deepslate_coal_ore'],
      iron: ['iron_ore', 'deepslate_iron_ore'],
      copper: ['copper_ore', 'deepslate_copper_ore'],
      gold: ['gold_ore', 'deepslate_gold_ore'],
      redstone: ['redstone_ore', 'deepslate_redstone_ore'],
      lapis: ['lapis_ore', 'deepslate_lapis_ore'],
      diamond: ['diamond_ore', 'deepslate_diamond_ore'],
      emerald: ['emerald_ore', 'deepslate_emerald_ore'],
    }
    const translated = { 煤: 'coal', 煤炭: 'coal', 煤矿: 'coal', 铁: 'iron', 铁矿: 'iron',
      钻石: 'diamond', 钻石矿: 'diamond', 青金石: 'lapis', 青金石矿: 'lapis', 石头: 'stone' }[normalized] || normalized
    if (translated === 'stone') return STONE_TARGETS
    return aliases[translated] ? new Set(aliases[translated]) :
      runtimeState.mcData?.blocksByName?.[translated] ? new Set([translated]) : new Set()
  }

  function minePositionKey(position) {
    return `${position.x},${position.y},${position.z}`
  }

  function pruneMineBlacklist(now = Date.now()) {
    for (const [key, expiresAt] of runtimeState.mineBlacklist) {
      if (expiresAt <= now) runtimeState.mineBlacklist.delete(key)
    }
  }

  function isTransparentForMine(block) {
    return !block || block.name === 'air' || block.boundingBox === 'empty' || block.name === 'water' || block.name === 'bubble_column'
  }

  function isPlausibleMineTarget(position, block) {
    if (!position || !block || block.name === 'air' || block.name === 'bedrock' || block.name === 'lava') return false
    if (block.name.includes('copper')) return false
    if (block.boundingBox !== 'block') return false
    const key = minePositionKey(position)
    if (runtimeState.mineBlacklist.has(key)) return false
    const origin = runtimeState.bot.entity.position
    if (Math.abs(position.y - origin.y) > (isOreName(block.name) ? 40 : 16)) return false

    // Match MineProcess.prune(): reject targets touching fluids and retain a
    // nearby transparent face so the final dig can be performed safely.
    const offsets = [
      [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    ]
    for (const [dx, dy, dz] of offsets) {
      const neighbour = runtimeState.bot.blockAt(position.offset(dx, dy, dz))
      if (neighbour?.name === 'lava') return false
      // Do not select an underwater face as a normal mine target. The movement
      // controller deliberately takes over in water, so a mine plan there would
      // fight the surfacing logic and repeatedly cancel itself.
      if (neighbour?.name === 'water' || neighbour?.name === 'bubble_column') return false
    }
    // Baritone's normal MineProcess allows non-exposed targets; exposure is
    // only an optional legit-mine setting. Keep buried stone/ore candidates and
    // let the pathfinder/digWithExposure decide whether a safe approach exists.
    return true
  }

  function mineGoalForBlock(position) {
    return new goals.GoalCompositeAny([
      new goals.GoalLookAtBlock(position, runtimeState.bot.world, { reach: 4.5 }),
      new goals.GoalGetToBlock(position.x, position.y, position.z),
    ])
  }

  function scoreMinePath(candidate, result) {
    const pathLength = Array.isArray(result?.path) ? result.path.length : 9999
    const distance = runtimeState.bot.entity.position.distanceTo(candidate.position)
    const oreBonus = /_ore$/.test(candidate.block.name) ? -2 : 0
    const exposedBonus = candidate.exposedFaces > 1 ? -1 : 0
    return pathLength + distance * 0.4 + (result.status === 'success' ? 0 : 8) + oreBonus + exposedBonus
  }

  function scanBlockIds(names) {
    return [...names].map(name => runtimeState.mcData.blocksByName[name]?.id).filter(Number.isInteger)
  }

  function isOreName(name) {
    return /_ore$/.test(name) || name === 'ancient_debris'
  }

  function scanOres() {
    const wanted = new Set([...runtimeState.mineTargetNames].filter(isOreName))
    if (wanted.size === 0) return []
    const origin = runtimeState.bot.entity.position
    const signature = [...wanted].sort().join(',')
    if (lastOreScan?.connection !== runtimeState.bot || lastOreScan.dimension !== runtimeState.bot.game.dimension) knownOres.clear()
    if (!lastOreScan || lastOreScan.connection !== runtimeState.bot || lastOreScan.dimension !== runtimeState.bot.game.dimension ||
        lastOreScan.signature !== signature || Date.now() - lastOreScan.time > 2600 ||
        origin.distanceTo(lastOreScan.position) >= 6) {
      const ids = scanBlockIds(wanted)
      const found = ids.length ? runtimeState.bot.findBlocks({ maxDistance: ORE_SCAN_RADIUS, count: 96, matching: ids }) : []
      for (const position of found) knownOres.set(minePositionKey(position), position)
      lastOreScan = { connection: runtimeState.bot, dimension: runtimeState.bot.game.dimension, signature, time: Date.now(), position: origin.clone() }
    }
    // Forget cached positions that are mined out, or no longer an ore we want.
    for (const [key, position] of knownOres) {
      const block = runtimeState.bot.blockAt(position)
      if (origin.distanceTo(position) > ORE_SCAN_RADIUS || (block && !wanted.has(block.name))) knownOres.delete(key)
    }
    const ranked = [...knownOres.entries()].sort((a, b) => a[1].distanceTo(origin) - b[1].distanceTo(origin))
    for (const [key] of ranked.slice(ORE_CACHE_LIMIT)) knownOres.delete(key)
    return ranked.slice(0, ORE_CACHE_LIMIT).map(([, position]) => position)
  }

  function searchMineCandidates() {
    pruneMineBlacklist()
    const nonOreIds = scanBlockIds([...runtimeState.mineTargetNames].filter(name => !isOreName(name)))
    const stonePositions = nonOreIds.length ? runtimeState.bot.findBlocks({
      maxDistance: BLOCK_MINE_RADIUS,
      count: 64,
      matching: nonOreIds,
    }) : []
    const seen = new Set()
    const positions = []
    for (const position of [...scanOres(), ...stonePositions]) {
      const key = minePositionKey(position)
      if (seen.has(key)) continue
      seen.add(key)
      positions.push(position)
    }
    const candidates = []
    for (const position of positions) {
      const block = runtimeState.bot.blockAt(position)
      if (runtimeState.supplyStation.protects(runtimeState.bot, position) || !runtimeState.mineTargetNames.has(block?.name) || !isPlausibleMineTarget(position, block)) continue
      let exposedFaces = 0
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        if (isTransparentForMine(runtimeState.bot.blockAt(position.offset(dx, dy, dz)))) exposedFaces += 1
      }
      candidates.push({ position, block, exposedFaces })
    }
    return candidates
  }

  // True when any node of a planned path stands in, or directly above, water.
  function pathTouchesWater(path) {
    for (const node of path) {
      const feet = runtimeState.bot.blockAt(new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)))
      const below = runtimeState.bot.blockAt(new Vec3(Math.floor(node.x), Math.floor(node.y) - 1, Math.floor(node.z)))
      if ((feet && WATER_BLOCK_NAMES.has(feet.name)) || (below && WATER_BLOCK_NAMES.has(below.name))) return true
    }
    return false
  }

  function planMineTarget() {
    if (!runtimeState.bot?.entity || !runtimeState.movements) return null
    const scanned = searchMineCandidates()
    const candidates = scanned
      // Buried targets (no transparent face) can never pass canSeeBlock from the
      // surface, so rank exposed candidates first and only then fall back to distance.
      .sort((a, b) => (isOreName(a.block.name) ? 0 : 1) - (isOreName(b.block.name) ? 0 : 1) ||
        (a.exposedFaces > 0 ? 0 : 1) - (b.exposedFaces > 0 ? 0 : 1) ||
        a.position.distanceTo(runtimeState.bot.entity.position) - b.position.distanceTo(runtimeState.bot.entity.position))
      // Baritone keeps a bounded known-location list; do the same so a local
      // search never monopolizes the Mineflayer event loop.
      .slice(0, 14)
    let best = null
    let noPath = 0
    let wetTargets = 0
    let evaluated = 0
    const statusCounts = {}
    const evaluationDeadline = performance.now() + 320
    for (const candidate of candidates) {
      // Stop once a reasonable target is in hand; keep going a little further so
      // the oreBonus in scoreMinePath can promote a slightly worse-looking ore
      // over a flat stone candidate.
      if ((best && evaluated >= 6) || (evaluated > 0 && performance.now() >= evaluationDeadline)) break
      evaluated += 1
      try {
        const result = runtimeState.bot.pathfinder.getPathTo(runtimeState.movements, mineGoalForBlock(candidate.position), 75)
        statusCounts[result?.status ?? 'none'] = (statusCounts[result?.status ?? 'none'] || 0) + 1
        const alreadyReachable = result?.status === 'success' && runtimeState.bot.canDigBlock(candidate.block) &&
          runtimeState.bot.canSeeBlock(candidate.block) && runtimeState.bot.entity.position.distanceTo(candidate.position) <= 5
        if (!result || !Array.isArray(result.path) || (!result.path.length && !alreadyReachable) || result.status === 'noPath') {
          runtimeState.mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 15000)
          noPath += 1
          continue
        }
        // A single getPathTo call gets only 40ms per tick, so medium-distance
        // targets usually come back as "partial". Accept partial paths — the dig
        // step will stop if the bot does not actually arrive — but still reject
        // paths that cross water, which was the real problem.
        if (pathTouchesWater(result.path) || features.isWaterAdjacent(candidate.position)) {
          runtimeState.mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 120000)
          wetTargets += 1
          continue
        }
        const score = scoreMinePath(candidate, result)
        if (!best || score < best.score) best = { ...candidate, result, score }
      } catch (error) {
        runtimeState.mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 15000)
        features.log('mine candidate path search failed', { position: candidate.position, message: error.message })
      }
    }
    features.log('mine scan evaluated', { plausible: scanned.length, evaluated, noPath, wetTargets, statusCounts })
    return best
  }

  async function minePlannerTick(reason = 'tick') {
    if (!runtimeState.mineMode || runtimeState.mineBusy || runtimeState.busy || !runtimeState.botEnabled || !runtimeState.bot?.entity || !runtimeState.movements) return false
    if (runtimeState.emergencyRetreating || runtimeState.fleeingActive || features.waterOwnsMovement() || features.foodRecoveryNeeded() || runtimeState.bot.health <= 0) return false
    if (runtimeState.supplyBase.active(runtimeState.bot) && !['base', 'station'].includes(runtimeState.currentMineOrder?.source)) {
      finishMineObjective()
      void features.decideAndAct('mine-complete')
      return false
    }
    if (!['base', 'station'].includes(runtimeState.currentMineOrder?.source) && finishMineObjective()) {
      void features.decideAndAct('mine-complete')
      return false
    }
    if (Date.now() < nextMineSearchAt) return false
    if (!['base', 'station'].includes(runtimeState.currentMineOrder?.source) &&
        Date.now() >= runtimeState.nextGearCraftRetryAt && features.readyGearUpgrades().length && !features.closeCombatPlan()) {
      void features.decideAndAct('gear-ready')
      return false
    }
    runtimeState.mineBusy = true
    runtimeState.miningPausedForFood = false
    runtimeState.lastMineSearchAt = Date.now()
    nextMineSearchAt = runtimeState.lastMineSearchAt + 750
    let objectiveReached = false
    try {
      await features.clearBackpack(runtimeState.bot, 'mining', { duringMining: true })
      if (!runtimeState.bot?.entity || !runtimeState.mineMode || features.foodRecoveryNeeded() || features.closeCombatPlan()) return false
      await features.autoEquipArmor(true)
      const pickaxes = runtimeState.bot.inventory.items().filter(item => item.name.endsWith('_pickaxe'))
      const hasHarvestTool = pickaxes.length > 0 && [...runtimeState.mineTargetNames].some(name => {
        const required = runtimeState.mcData.blocksByName[name]?.harvestTools
        return !required || pickaxes.some(item => required[item.type])
      })
      if (!hasHarvestTool) {
        features.log('mine planner paused; suitable pickaxe required', { targets: [...runtimeState.mineTargetNames] })
        runtimeState.mineMode = false
        runtimeState.activeGoal = null
        runtimeState.committedMineTarget = null
        objectiveReached = true
        return false
      }
      features.log('mine planner search', { reason, targets: [...runtimeState.mineTargetNames].slice(0, 12) })
      const savedTarget = runtimeState.committedMineTarget && runtimeState.bot.blockAt(runtimeState.committedMineTarget.position)
      if (!savedTarget || savedTarget.type !== runtimeState.committedMineTarget.block.type || !runtimeState.mineTargetNames.has(savedTarget.name)) {
        if (runtimeState.committedMineTarget) features.log('mine commitment released', { reason: 'target-changed', position: runtimeState.committedMineTarget.position })
        runtimeState.committedMineTarget = null
      }
      const resumed = Boolean(runtimeState.committedMineTarget)
      const plan = runtimeState.committedMineTarget ?? planMineTarget()
      if (!plan) {
        runtimeState.mineNeedsNewGround = true
        runtimeState.mineMode = false
        runtimeState.navigationState = { target: null, waypoints: [], label: 'mine-search-empty' }
        nextMineSearchAt = Date.now() + 3000
        features.log('mine planner found no reachable target', { oreRadius: ORE_SCAN_RADIUS, blockRadius: BLOCK_MINE_RADIUS })
        recordMineAudit('no-reachable-target')
        features.persistExperience({ cycle: runtimeState.cycle, action: 'mine-search', experience: '扫描到的目标没有可行路径，已跳过并等待环境变化后重搜' })
        return false
      }

      runtimeState.committedMineTarget = plan
      runtimeState.lastDecision = 'mine'
      const target = plan.position
      runtimeState.currentMineTarget = { x: target.x, y: target.y, z: target.z, name: plan.block.name }
      runtimeState.navigationState = {
        target: { x: target.x, y: target.y, z: target.z, name: plan.block.name },
        waypoints: resumed ? [] : plan.result.path.map(point => ({ x: point.x, y: point.y, z: point.z })),
        label: 'baritone-mine',
      }
      features.log(resumed ? 'mine commitment resumed' : 'mine planner selected target', {
        block: plan.block.name,
        position: target,
        pathNodes: plan.result.path.length,
        pathStatus: plan.result.status,
        score: Number(plan.score.toFixed(2)),
      })

      const startPosition = runtimeState.bot.entity.position.clone()
      const distance = startPosition.distanceTo(target)
      const interrupted = () => !runtimeState.mineMode || runtimeState.miningPausedForFood || features.foodRecoveryNeeded() ||
        features.waterOwnsMovement() || runtimeState.emergencyRetreating || runtimeState.fleeingActive || features.damageInterruptActive(runtimeState.bot)
      try {
        await features.gotoWithTimeout(mineGoalForBlock(target), 'mine target path', Math.min(22000, 7000 + distance * 230))
      } catch (error) {
        if (interrupted()) return false
        if (/timeout/i.test(error.message) && startPosition.distanceTo(runtimeState.bot.entity.position) >= 3 && (plan.retries ?? 0) < 2) {
          plan.retries = (plan.retries ?? 0) + 1
          features.log('mine path still progressing; retrying same target', { position: target, retry: plan.retries })
          return false
        }
        runtimeState.committedMineTarget = null
        runtimeState.mineBlacklist.set(minePositionKey(target), Date.now() + 20000)
        features.log('mine target unreachable; blacklisted', { block: plan.block.name, position: target, message: error.message })
        features.persistExperience({ cycle: runtimeState.cycle, action: 'mine-replan', experience: `目标 ${plan.block.name} 不可达，已临时加入黑名单并改搜其他目标` })
        return false
      }

      if (interrupted()) return false
      const current = runtimeState.bot.blockAt(target)
      if (!current || current.type !== plan.block.type || !runtimeState.mineTargetNames.has(current.name)) {
        features.log('mine target changed before dig; rescanning', { position: target })
        runtimeState.committedMineTarget = null
        recordMineAudit('target-changed', current)
        return false
      }
      const drops = STONE_TARGETS.has(current.name) ? STONE_DROPS : COAL_TARGETS.has(current.name) ? COAL_DROPS :
        /^(deepslate_)?iron_ore$/.test(current.name) ? new Set(['raw_iron']) :
        /^(deepslate_)?copper_ore$/.test(current.name) ? new Set(['raw_copper']) :
        /^(deepslate_)?gold_ore$/.test(current.name) ? new Set(['raw_gold']) :
        /^(deepslate_)?diamond_ore$/.test(current.name) ? new Set(['diamond']) :
        /^(deepslate_)?redstone_ore$/.test(current.name) ? new Set(['redstone']) :
        /^(deepslate_)?lapis_ore$/.test(current.name) ? new Set(['lapis_lazuli']) :
        /^(deepslate_)?emerald_ore$/.test(current.name) ? new Set(['emerald']) : new Set([current.name])
      const before = features.inventoryCount(drops)
      const countedDiamond = drops.has('diamond') && features.needsPostArmorDiamonds(runtimeState.bot)
      await features.maybePlaceTorch(true)
      if (interrupted()) return false
      if (!await features.digWithExposure(current, runtimeState.mineTargetNames)) {
        if (interrupted()) return false
        runtimeState.committedMineTarget = null
        runtimeState.mineBlacklist.set(minePositionKey(target), Date.now() + 10000)
        features.log('mine dig failed; target blacklisted for replan', { block: current.name, position: target })
        features.persistExperience({ cycle: runtimeState.cycle, action: 'mine-replan', experience: `目标 ${current.name} 无法从当前站位挖到，重新搜索可达目标` })
        return false
      }
      runtimeState.committedMineTarget = null
      runtimeState.mineBlacklist.delete(minePositionKey(target))
      features.log('mine target mined', { block: current.name, position: target })
      const pickedUp = await features.pickUpBlockDrop(drops, target, before, true)
      features.log('mine pickup result', { block: current.name, pickedUp })
      if (countedDiamond && pickedUp && runtimeState.supplyBase.recordDiamonds(features.inventoryItemCount('diamond') - before)) {
        const { diamonds, target, needsResupply } = runtimeState.supplyBase.qualification()
        features.log('post-armor diamonds collected', { count: diamonds, target })
        if (needsResupply) {
          runtimeState.mineMode = false
          runtimeState.activeGoal = null
          features.log('surface resupply required after diamonds', { diamonds })
          objectiveReached = true
        }
      }
      if (!objectiveReached) objectiveReached = finishMineObjective()
      features.persistExperience({ cycle: runtimeState.cycle, action: 'mine', experience: `按实际寻路节点到达 ${current.name} 的可见面并完成挖掘` })
      return true
    } finally {
      runtimeState.mineBusy = false
      runtimeState.currentMineTarget = null
      if (runtimeState.miningPausedForFood) setImmediate(() => features.monitorFood())
      if (objectiveReached && !runtimeState.urgentThreatQueued) setImmediate(() => void features.decideAndAct('mine-complete'))
      if (runtimeState.urgentThreatQueued) {
        runtimeState.urgentThreatQueued = false
        setImmediate(() => void features.decideAndAct('urgent-queued'))
      }
    }
  }

  function finishMineObjective() {
    if (!runtimeState.mineMode || !runtimeState.bot?.entity || !runtimeState.mineTargetNames.size) return false
    if (runtimeState.supplyBase.active(runtimeState.bot) && runtimeState.currentMineOrder?.source !== 'station') {
      const objective = runtimeState.currentMineOrder?.objective
      if (objective && Date.now() < objective.until && features.foodReserve() >= 3 &&
          features.inventoryCount(new Set(objective.names)) < objective.target) return false
      runtimeState.mineMode = false
      runtimeState.committedMineTarget = null
      runtimeState.activeGoal = null
      return true
    }
    const targets = [...runtimeState.mineTargetNames]
    const coal = features.inventoryItemCount('coal')
    const fuel = coal + features.inventoryItemCount('charcoal')
    const raw = features.inventoryCount(IRON_INPUT_NAMES)
    const ingots = features.inventoryItemCount('iron_ingot')
    const ironPick = runtimeState.bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name))
    const stock = runtimeState.currentMineOrder?.stoneDrop ? features.inventoryItemCount(runtimeState.currentMineOrder.stoneDrop) : features.inventoryCount(STONE_DROPS)
    const stoneReady = targets.every(name => STONE_TARGETS.has(name)) && stock >= (runtimeState.currentMineOrder?.stoneLimit ?? STONE_TARGET)
    const coalReady = targets.every(name => COAL_TARGETS.has(name)) &&
      (coal >= 4 || (raw > 0 && fuel > 0) || (ironPick && features.inventoryItemCount('torch') < 8 && coal >= 1))
    const upgrade = features.nextIronUpgrade()
    const ironReady = targets.every(name => IRON_INPUT_NAMES.has(name)) && upgrade &&
      (ingots >= upgrade.cost || (fuel > 0 && raw + ingots >= upgrade.cost))
    const diamondPriority = runtimeState.currentMineOrder?.source !== 'station' && features.needsPostArmorDiamonds(runtimeState.bot) && features.hasDiamondMiningTool(runtimeState.bot) &&
      !targets.every(name => /^(deepslate_)?diamond_ore$/.test(name))
    if (!stoneReady && !coalReady && !ironReady && !diamondPriority) return false
    runtimeState.mineMode = false
    runtimeState.committedMineTarget = null
    runtimeState.mineNeedsNewGround = false
    if (runtimeState.activeGoal?.type === 'mine') runtimeState.activeGoal = null
    features.log('mine objective ready; advancing', {
      resource: diamondPriority ? 'post-armor diamonds' : stoneReady ? 'stone' : coalReady ? 'coal' : 'iron', coal, raw, ingots,
    })
    return true
  }

  function recordMineAudit(result, block = null) {
    if (!runtimeState.currentMineOrder) return
    runtimeState.lastMineAudit = { time: new Date().toISOString(), ...runtimeState.currentMineOrder, result,
      planned: runtimeState.currentMineTarget, actual: block ? { name: block.name, position: block.position } : null }
    features.log('mine command audit', runtimeState.lastMineAudit)
    features.persistExperience({ ...runtimeState.lastMineAudit, action: 'mine-audit', experience: {
      'command': `采矿目标 ${runtimeState.currentMineOrder.target}`,
      'target-mined': `已挖到目标方块 ${block?.name}`,
      'path-clearance': `清除挡路方块 ${block?.name}`,
      'unexpected-ore': `实际挖掘矿物 ${block?.name} 与指令不一致，暂停采矿并重新规划`,
      'no-reachable-target': `暂时没有可达的 ${runtimeState.currentMineOrder.target}，移动后重搜`,
      'target-changed': `计划坐标的方块已变化，取消挖掘并重搜`,
      'invalid-target': `无效的采矿目标 ${runtimeState.currentMineOrder.target}，等待新指令`,
    }[result] })
  }

  async function mineForGear(modelTarget = null, targetName = '', requested = null,
    { objective = null, stoneLimit = null, stoneDrop = null } = {}) {
    if (features.foodRecoveryNeeded()) return false
    if (!runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) {
      features.log('mining refused; no pickaxe equipped or available')
      features.persistExperience({ cycle: runtimeState.cycle, action: 'mine-blocked', experience: '没有镐，禁止进入挖矿执行器' })
      return false
    }
    const exactStone = stoneDrop ?? (objective?.kind === 'stone' && objective.names.length === 1 ? objective.names[0] : null)
    const targets = exactStone ? new Set([exactStone === 'cobbled_deepslate' ? 'deepslate' : 'stone']) : mineTargetSetFromName(targetName)
    if (runtimeState.committedMineTarget && !targets.has(runtimeState.committedMineTarget.block.name)) runtimeState.committedMineTarget = null
    runtimeState.mineTargetNames = targets
    runtimeState.currentMineOrder = { cycle: runtimeState.cycle, requested, target: targetName || 'general',
      source: objective ? 'base' : stoneLimit ? 'station' : requested ? 'model' : 'survival' }
    if (objective) runtimeState.currentMineOrder.objective = objective
    if (stoneLimit) runtimeState.currentMineOrder.stoneLimit = stoneLimit
    if (stoneDrop) runtimeState.currentMineOrder.stoneDrop = stoneDrop
    runtimeState.mineMode = runtimeState.mineTargetNames.size > 0
    recordMineAudit(runtimeState.mineMode ? 'command' : 'invalid-target')
    if (!runtimeState.mineMode) return false
    runtimeState.lastDecision = 'mine'
    features.log('mine mode enabled', { targetName, targets: [...runtimeState.mineTargetNames] })
    // The actual search and dig are performed by minePlannerTick.  It is
    // intentionally separate from the DeepSeek action so path replanning can
    // continue after a high-level decision has finished.
    return true
  }

  return {
    miningUnderground,
    minePositionKey,
    scanBlockIds,
    isOreName,
    minePlannerTick,
    finishMineObjective,
    recordMineAudit,
    mineForGear,
  }
}

module.exports = createMining
