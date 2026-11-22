const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { avoidWetCorners, avoidWetSteps, dryFooting, fluidBeside, nearbyHostiles, pathHazard, safeStepUp, threatNear } = require('./movement-safety')
const {
  STONE_DROPS, STONE_TARGETS, COAL_TARGETS, DEFAULT_MINE_TARGET_NAMES, WATER_BLOCK_NAMES, STONE_TARGET,
  IRON_INPUT_NAMES, ORE_SCAN_RADIUS, BLOCK_MINE_RADIUS, TUNNEL_SAFE_BLOCKS,
} = require('./config')

const COAL_DROPS = new Set(['coal'])
const ORE_CACHE_LIMIT = 128

function createMining(runtimeState, features) {
  let nextMineSearchAt = 0
  let activeMineRun = null

  function interruptMiningForCombat(connection) {
    if (runtimeState.bot !== connection || (!runtimeState.mineMode && !runtimeState.mineBusy)) return
    const run = activeMineRun
    if (run?.interrupted) return
    runtimeState.mineMode = false
    if (run) {
      run.interrupted = true
      run.releaseStep?.()
      run.restoreMovements?.()
    }
    features.stopPathfinder()
    if (connection.targetDigBlock) connection.stopDigging()
    runtimeState.currentMineTarget = null
    features.clearNavigation('mine-combat-handoff')
    features.log('mining control yielded to combat', { target: runtimeState.currentMineOrder?.target })
  }

  function mineCombatInterrupted(connection, run = activeMineRun) {
    return Boolean(run?.interrupted) || runtimeState.bot !== connection || connection.health <= 0 ||
      !runtimeState.mineMode || runtimeState.emergencyRetreating || runtimeState.fleeingActive ||
      runtimeState.meleeConnection === connection || runtimeState.impactGuards.has(connection)
  }
  let routeFailures = 0
  const missedRoutes = new Map()
  const recentMinePositions = []
  const recentApproaches = new Map()
  const recentMiningSteps = new Map()
  let modelMineHint = null

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

    return !fluidBeside(runtimeState.bot, position)
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
    const threats = miningThreats(runtimeState.bot)
    let unsafeTargets = 0
    for (const position of positions) {
      const block = runtimeState.bot.blockAt(position)
      if (runtimeState.supplyStation.protects(runtimeState.bot, position) || !runtimeState.mineTargetNames.has(block?.name) || !isPlausibleMineTarget(position, block)) continue
      if (threatNear(position.offset(0.5, 0.5, 0.5), threats, 8)) {
        unsafeTargets++
        continue
      }
      let exposedFaces = 0
      for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
        if (isTransparentForMine(runtimeState.bot.blockAt(position.offset(dx, dy, dz)))) exposedFaces += 1
      }
      candidates.push({ position, block, exposedFaces })
    }
    if (unsafeTargets) features.log('mine targets skipped near hostile', { count: unsafeTargets })
    return candidates
  }

  function miningThreats(connection) {
    return nearbyHostiles(connection, features.isHostileEntity)
  }

  function mineRouteHazard(connection, path, options = {}, threats = miningThreats(connection)) {
    return pathHazard(connection, path, { ...options, threats })
  }

  function mineRouteOptions(connection) {
    return {
      allowClutch: false,
      validateRoute: (path, options) => mineRouteHazard(connection, path, options),
    }
  }

  function gotoMineRoute(connection, goal, label, timeoutMs) {
    return features.gotoWithTimeout(goal, label, timeoutMs, mineRouteOptions(connection))
  }

  function mineInReach(connection, block) {
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight || 1.62, 0)
    return eyes.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.2 &&
      connection.canDigBlock(block) && connection.canSeeBlock(block)
  }

  async function previewMinePath(connection, goal, deadline, {
    movements = runtimeState.movements, budget = 240, searchRadius = 42,
  } = {}) {
    if (performance.now() >= deadline) return null
    const search = connection.pathfinder.getPathFromTo(movements, connection.entity.position, goal, {
      timeout: Math.min(budget, Math.max(12, deadline - performance.now())),
      tickTimeout: 15, searchRadius, optimizePath: false,
    })
    let preview
    try {
      do {
        preview = search.next().value?.result ?? preview
        if (preview?.status !== 'partial' || performance.now() >= deadline) return preview
        await new Promise(resolve => setImmediate(resolve))
      } while (runtimeState.bot === connection && connection.entity && connection.health > 0)
      return null
    } finally {
      search.return()
    }
  }

  function remainingMineDistance(position, target) {
    return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z)
  }

  function noteMineFailure(plan, message, kind = 'path') {
    runtimeState.committedMineTarget = null
    routeFailures += 1
    const key = minePositionKey(plan.position)
    const misses = Math.min(3, (missedRoutes.get(key) || 0) + 1)
    missedRoutes.set(key, misses)
    runtimeState.mineBlacklist.set(key, Date.now() + 90000 * misses)
    features.log('mine target paused after failure', {
      block: plan.block.name, position: plan.position, message, kind, consecutive: routeFailures, cooldownMs: 90000 * misses,
    })
    features.persistExperience({ cycle: runtimeState.cycle, action: 'mine-replan',
      experience: plan.block.name + ' 的路线或站位失败，先换其他矿点，连续失败后换位置再规划。' })
  }


  function adjacentMiningSteps(connection, target, {allowClear = false} = {}) {
    const origin = connection.entity.position.floored()
    const result = []
    const threats = miningThreats(connection)
    const passable = block => block && block.boundingBox === 'empty' &&
      !WATER_BLOCK_NAMES.has(block.name) && !/lava|fire|cactus|powder_snow/.test(block.name)
    for (const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      for (const dy of [0,1,-1]) {
        const pos = origin.offset(dx,dy,dz)
        if (!dryFooting(connection, pos) || threatNear(pos, threats, 6)) continue
        const support = connection.blockAt(pos.offset(0,-1,0))
        if (!support || support.boundingBox !== 'block' ||
            /lava|fire|cactus|magma|powder_snow/.test(support.name) || WATER_BLOCK_NAMES.has(support.name)) continue
        const blocks = [connection.blockAt(pos.offset(0,1,0)),connection.blockAt(pos)]
        if (dy === 1 && !passable(connection.blockAt(origin.offset(0,2,0)))) continue
        if (dy === -1 && !passable(connection.blockAt(pos.offset(0,2,0)))) continue
        const obstacles = blocks.filter(block => !passable(block))
        if (obstacles.length) {
          if (!allowClear || obstacles.some(block => !block || !TUNNEL_SAFE_BLOCKS.has(block.name) ||
            isOreName(block.name) || runtimeState.supplyStation.protects(connection,block.position) ||
            runtimeState.supplyBase.owns(connection,block.position) || fluidBeside(connection, block.position) ||
            !connection.canDigBlock(block))) continue
          if (/sand|gravel|concrete_powder|lava/.test(connection.blockAt(pos.offset(0,2,0))?.name ?? '')) continue
        }
        const key = minePositionKey(pos)
        if (recentApproaches.get(key) > Date.now()) continue
        result.push({pos,dy,obstacles,score:(target ? pos.distanceTo(target) : 0) + obstacles.length * 4 + (dy === 0 ? 0 : 0.35)})
      }
    }
    return result.sort((a,b)=>a.score-b.score)
  }

  async function walkAdjacentMiningStep(connection, step, interrupted) {
    const from = connection.entity.position.clone()
    const unsafe = () => !dryFooting(connection, step.pos) || threatNear(step.pos, miningThreats(connection), 6)
    for (const block of step.obstacles) {
      if (unsafe() || fluidBeside(connection, block.position)) return false
      if (interrupted() || !await features.digWithExposure(block,new Set([block.name]),{interrupted})) return false
    }
    if (interrupted() || unsafe() || (step.dy === 1 && !safeStepUp(connection, step.pos))) return false
    features.stopPathfinder()
    const target = step.pos.offset(0.5,0,0.5)
    const started = Date.now()
    let moved = false
    const run = activeMineRun
    const release = () => {
      if (run.releaseStep !== release) return
      run.releaseStep = null
      connection.setControlState('forward',false)
      connection.setControlState('jump',false)
    }
    run.releaseStep = release
    try {
      while (!interrupted() && !unsafe() && Date.now()-started < 1050) {
        const pos = connection.entity.position
        const dx = target.x-pos.x, dz = target.z-pos.z
        if (Math.hypot(dx,dz) <= 0.23) break
        await connection.look(Math.atan2(-dx,-dz),0,true)
        if (interrupted() || unsafe()) return false
        connection.setControlState('forward',true)
        connection.setControlState('jump',step.dy === 1 && pos.y < step.pos.y - 0.05)
        await new Promise(resolve=>setTimeout(resolve,70))
      }
      moved = !interrupted() && connection.entity.position.floored().equals(step.pos) &&
        connection.entity.position.distanceTo(from) >= 0.55
      features.log(moved ? 'mine close step moved' : 'mine close step stalled', {
        from, to: connection.entity.position.clone(), expected:step.pos, cleared:step.obstacles.map(block=>block.name),
      })
      return moved
    } finally {
      release()
      if (!moved && !interrupted()) recentApproaches.set(minePositionKey(step.pos),Date.now()+30000)
    }
  }

  async function relocateMining(connection) {
    const origin = connection.entity.position.floored()
    // Recovery walks through known safe ground, so one failed ore approach
    // cannot trigger a second tunnel into the same wall.
    const run = activeMineRun
    const interrupted = () => mineCombatInterrupted(connection,run) || !runtimeState.botEnabled ||
      features.foodRecoveryNeeded() || features.closeCombatPlan() || features.waterOwnsMovement()
    const closeSteps = adjacentMiningSteps(connection, null, {allowClear:true})
      .filter(step => !recentMinePositions.some(previous=>step.pos.equals(previous)))
    features.log('mine recovery examines nearby exits',{
      position:connection.entity.position.clone(),
      onGround:connection.entity.onGround,
      options:closeSteps.map(step=>({pos:step.pos,obstacles:step.obstacles.map(block=>block.name)})),
    })
    for (const step of closeSteps.slice(0,3)) {
      if (interrupted()) break
      if (!await walkAdjacentMiningStep(connection,step,interrupted)) continue
      recentMinePositions.push(origin.clone())
      if (recentMinePositions.length > 6) recentMinePositions.shift()
      return true
    }
    const movements = new Movements(connection, runtimeState.mcData)
    movements.canDig = false
    movements.maxDropDown = 3
    movements.infiniteLiquidDropdownDistance = false
    avoidWetCorners(movements, connection)
    avoidWetSteps(movements, connection)
    movements.allow1by1towers = false
    movements.allowParkour = false
    movements.liquidCost = 500
    const recent = recentMinePositions.some(position => origin.distanceTo(position) < 2)
    if (!recent) {
      recentMinePositions.push(origin.clone())
      if (recentMinePositions.length > 6) recentMinePositions.shift()
    }
    const head = position => connection.blockAt(position)
    const dryClear = block => block && block.boundingBox === 'empty' &&
      !WATER_BLOCK_NAMES.has(block.name) && block.name !== 'lava'
    const nearby = []
    const offsets = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]
    for (const distance of [2, 3, 5, 8]) {
      for (const [dx,dz] of offsets) {
        for (const dy of [0,1,-1,2,-2,3,-3,4,-4]) {
          const pos = origin.offset(dx*distance,dy,dz*distance)
          if (recentMinePositions.some(previous => pos.distanceTo(previous) < 2)) continue
          const ground = head(pos.offset(0,-1,0))
          if (ground?.boundingBox === 'block' && !features.isWaterAdjacent(pos) &&
              dryClear(head(pos)) && dryClear(head(pos.offset(0,1,0)))) nearby.push(pos)
        }
      }
    }

    const deadline = performance.now() + 1200
    for (const pos of nearby.slice(0, 16)) {
      if (performance.now() >= deadline || features.closeCombatPlan() || features.foodRecoveryNeeded()) break
      const goal = new goals.GoalBlock(pos.x,pos.y,pos.z)
      const result = await previewMinePath(connection,goal,deadline,{movements,budget:90,searchRadius:16})
      if (interrupted()) return false
      if (result?.status !== 'success' || !result.path.length || mineRouteHazard(connection, result.path)) continue
      const old = connection.pathfinder.movements
      const restore = () => {
        if (run.restoreMovements !== restore) return
        run.restoreMovements = null
        if (connection.pathfinder.movements === movements) connection.pathfinder.setMovements(old)
      }
      run.restoreMovements = restore
      connection.pathfinder.setMovements(movements)
      try {
        runtimeState.lastDecision = 'explore'
        runtimeState.navigationState = { target: pos, waypoints: result.path, label: 'mine-relocate' }
        await gotoMineRoute(connection,goal,'mine scouting route',5200)
        if (interrupted()) return false
        if (connection.entity.position.distanceTo(origin) < 2) continue
        features.log('mine scouting relocated', { from: origin, to: connection.entity.position.floored() })
        recentMinePositions.push(connection.entity.position.floored())
        if (recentMinePositions.length > 6) recentMinePositions.shift()
        return true
      } catch (error) {
        features.log('mine scouting route failed', { target: pos, message: error.message })
        if (features.closeCombatPlan() || features.foodRecoveryNeeded() || !runtimeState.botEnabled) break
      } finally {
        restore()
      }
    }
    return false
  }


  async function planMineTarget() {
    const connection = runtimeState.bot
    if (!connection?.entity || !runtimeState.movements) return null
    const scanned = searchMineCandidates()
    const hintCost = position => modelMineHint ? Math.min(20,Math.hypot(position.x-modelMineHint.x,position.z-modelMineHint.z)) * 0.3 : 0
    const inReach = scanned.find(candidate => mineInReach(connection,candidate.block))
    if (inReach) return { ...inReach, result: {status:'success',path:[]}, score:0 }

    const origin = connection.entity.position.clone()
    const candidates = scanned.sort((a,b) =>
      (a.exposedFaces > 0 ? 0 : 1) - (b.exposedFaces > 0 ? 0 : 1) ||
      a.position.distanceTo(origin) + hintCost(a.position) - b.position.distanceTo(origin) - hintCost(b.position)).slice(0,18)
    let bestComplete = null
    let bestProgress = null
    let evaluated = 0
    const blockedRoutes = {}
    const statusCounts = {}
    const deadline = performance.now() + 1400
    for (const candidate of candidates) {
      if (performance.now() >= deadline || runtimeState.bot !== connection ||
          !runtimeState.mineMode || (bestComplete && evaluated >= 5)) break
      evaluated++
      try {
        const result = await previewMinePath(connection,mineGoalForBlock(candidate.position),deadline)
        const status = result?.status || 'none'
        statusCounts[status] = (statusCounts[status] || 0) + 1
        if (!result?.path?.length || status === 'noPath') continue
        const hazard = mineRouteHazard(connection, result.path)
        if (hazard) {
          blockedRoutes[hazard] = (blockedRoutes[hazard] || 0) + 1
          if (hazard !== '路线太靠近怪物') {
            runtimeState.mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 30000)
          }
          continue
        }
        const score = scoreMinePath(candidate, result) + hintCost(candidate.position)
        if (status === 'success') {
          if (!bestComplete || score < bestComplete.score) bestComplete = {...candidate,result,score}
          continue
        }
        const end = result.path.at(-1)
        const netAdvance = remainingMineDistance(origin,candidate.position) - remainingMineDistance(end,candidate.position)
        if (netAdvance < 1.5 || remainingMineDistance(end,origin) < 2) continue
        const progressScore = remainingMineDistance(end,candidate.position) * 1.8 + result.path.length * 0.2 + hintCost(candidate.position)
        if (!bestProgress || progressScore < bestProgress.score) bestProgress = {...candidate,result,score:progressScore}
      } catch (error) {
        features.log('mine candidate path search failed',{position:candidate.position,message:error.message})
      }
    }
    features.log('mine scan evaluated',{plausible:scanned.length,evaluated,blockedRoutes,statusCounts,complete:Boolean(bestComplete)})
    return bestComplete ?? bestProgress
  }

  async function approachMinePlan(connection, plan, interrupted) {
    const target = plan.position
    if (mineInReach(connection,plan.block)) return true

    const first = plan.result.path[0]
    if (first) {
      const firstPos = new Vec3(Math.floor(first.x),Math.floor(first.y),Math.floor(first.z))
      const origin = connection.entity.position.floored()
      const adjacent = adjacentMiningSteps(connection,firstPos,{allowClear:true})
      const exact = adjacent.find(step=>step.pos.equals(firstPos))
      // A diagonal ascent can repeatedly time out even after its blocks
      // have been cleared. Walk an independently verified cardinal stair
      // before looking for the remaining path from the new position.
      const toward = adjacent.filter(step => step !== exact &&
        step.pos.distanceTo(firstPos)+0.2 < origin.distanceTo(firstPos) &&
        step.pos.distanceTo(target) <= origin.distanceTo(target)+0.6 &&
        (recentMiningSteps.get(minePositionKey(step.pos)) || 0) <= Date.now())
      for (const next of [...(exact ? [exact] : []),...toward.slice(0,2)]) {
        if (interrupted()) return false
        if (await walkAdjacentMiningStep(connection,next,interrupted)) {
          recentMiningSteps.set(minePositionKey(origin),Date.now()+4500)
          if (next !== exact) features.log('mine diagonal approach split into verified steps',{
            ore:target,original:firstPos,step:next.pos,
          })
          return mineInReach(connection,plan.block) || mineGoalForBlock(target).isEnd(connection.entity.position.floored())
        }
      }
    }
    if (interrupted()) return false
    const path = plan.result.path
    if (plan.result.status === 'success' && path.length <= 3) {
      await gotoMineRoute(connection,mineGoalForBlock(target),'mine target approach',6500)
      return true
    }
    // Follow a bounded prefix of the candidate's dry route. Searching for its
    // first few steps is cheaper than restarting A* for a buried ore each tick.
    const origin = connection.entity.position.clone()
    const prefix = path.slice(0,3).filter(node => remainingMineDistance(node,origin) >= 1.1)
    let failure
    for (const node of prefix.reverse().slice(0,2)) {
      if (interrupted()) return false
      const goal = new goals.GoalBlock(Math.floor(node.x),Math.floor(node.y),Math.floor(node.z))
      try {
        await gotoMineRoute(connection,goal,'mine route segment',3100)
        if (connection.entity.position.distanceTo(origin) < 1) continue
        features.log('mine route segment moved',{from:origin.floored(),to:connection.entity.position.floored(),ore:target})
        return mineInReach(connection,plan.block) || mineGoalForBlock(target).isEnd(connection.entity.position.floored())
      } catch (error) {
        if (interrupted()) return false
        failure = error
      }
    }
    throw failure ?? Error('短段路线未产生有效位移')
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
    const connection = runtimeState.bot
    const run = { interrupted: false, releaseStep: null, restoreMovements: null }
    activeMineRun = run
    const cancelled = () => mineCombatInterrupted(connection,run)
    runtimeState.mineBusy = true
    runtimeState.miningPausedForFood = false
    runtimeState.lastMineSearchAt = Date.now()
    nextMineSearchAt = runtimeState.lastMineSearchAt + 750
    let objectiveReached = false
    let replanRequested = false
    try {
      await features.clearBackpack(runtimeState.bot, 'mining', { duringMining: true })
      if (!runtimeState.bot?.entity || !runtimeState.mineMode || features.foodRecoveryNeeded() || features.closeCombatPlan()) return false
      await features.autoEquipArmor(true)
      if (cancelled()) return false
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

      const advanceDecision = async reason => {
        const connection = runtimeState.bot
        routeFailures = 0
        runtimeState.committedMineTarget = null
        runtimeState.currentMineTarget = null
        features.clearNavigation('mine-replan')
        features.log('mine route released for replanning',{reason})
        const moved = connection?.entity && !features.closeCombatPlan() &&
          !features.foodRecoveryNeeded() && await relocateMining(connection)
        if (cancelled()) return
        runtimeState.mineNeedsNewGround = !moved
        runtimeState.mineMode = false
        if (runtimeState.activeGoal?.type === 'mine') runtimeState.activeGoal = null
        nextMineSearchAt = Date.now() + 3200
        replanRequested = true
      }
      if (routeFailures >= 2) {
        await advanceDecision('consecutive-route-failures')
        return false
      }
      // A committed ore remains the objective across useful short movements,
      // but after moving, the stand/path must be calculated from the new feet.
      let plan
      const previous = runtimeState.committedMineTarget
      const seen = previous && runtimeState.bot.blockAt(previous.position)
      if (seen && seen.type === previous.block.type && runtimeState.mineTargetNames.has(seen.name) &&
          !fluidBeside(connection, previous.position) &&
          !threatNear(previous.position.offset(0.5, 0.5, 0.5), miningThreats(connection), 8)) {
        if (mineInReach(runtimeState.bot,seen)) {
          plan = {...previous,block:seen,result:{status:'success',path:[]}}
        } else {
          const preview = await previewMinePath(runtimeState.bot,mineGoalForBlock(previous.position),performance.now()+340)
          if (cancelled()) return false
          const end = preview?.path?.at(-1)
          if (end && !mineRouteHazard(connection, preview.path) && (preview.status === 'success' ||
              remainingMineDistance(runtimeState.bot.entity.position,previous.position) - remainingMineDistance(end,previous.position) >= 1.5)) {
            plan = {...previous,block:seen,result:preview}
          } else {
            noteMineFailure(previous,'重新评估后没有可继续推进的路线')
          }
        }
      } else if (previous) {
        runtimeState.committedMineTarget = null
        features.log('mine commitment released; target changed or became unsafe', { position: previous.position })
      }
      if (routeFailures >= 2) {
        await advanceDecision('consecutive-route-failures')
        return false
      }
      plan ??= await planMineTarget()
      if (cancelled()) return false
      if (!plan) {
        features.log('mine planner found no reachable target',{oreRadius:ORE_SCAN_RADIUS,blockRadius:BLOCK_MINE_RADIUS})
        recordMineAudit('no-reachable-target')
        await advanceDecision('no-reachable-target')
        return false
      }
      const resumed = Boolean(previous && previous.position.equals(plan.position))

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


      const interrupted = () => {
        if (cancelled() || runtimeState.miningPausedForFood || features.foodRecoveryNeeded() ||
            features.waterOwnsMovement() || features.damageInterruptActive(connection)) return true
        if (!threatNear(target.offset(0.5, 0.5, 0.5), miningThreats(connection), 8) && !fluidBeside(connection, target)) return false
        if (runtimeState.committedMineTarget === plan) {
          runtimeState.committedMineTarget = null
          features.log('mine interrupted; target became unsafe', { position: target })
        }
        return true
      }
      try {
        const arrived = await approachMinePlan(runtimeState.bot,plan,interrupted)
        if (!arrived) {
          if (!interrupted()) routeFailures = 0
          return false
        }
      } catch (error) {
        if (!interrupted()) noteMineFailure(plan,error.message)
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
      if (!await features.digWithExposure(current, runtimeState.mineTargetNames, { interrupted })) {
        if (interrupted()) return false
        noteMineFailure(plan,'站位已到达但挖掘失败','dig')
        return false
      }
      if (interrupted()) return false
      runtimeState.committedMineTarget = null
      runtimeState.mineBlacklist.delete(minePositionKey(target))
      missedRoutes.delete(minePositionKey(target))
      routeFailures = 0
      features.log('mine target mined', { block: current.name, position: target })
      const pickedUp = await features.pickUpBlockDrop(drops, target, before, true)
      features.log('mine pickup result', { block: current.name, pickedUp })
      if (interrupted()) return false
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
      activeMineRun = null
      runtimeState.mineBusy = false
      if (!run.interrupted) runtimeState.currentMineTarget = null
      if (run.interrupted) features.log('mining task unwound after combat handoff')
      if (runtimeState.miningPausedForFood) setImmediate(() => features.monitorFood())
      if (replanRequested && !runtimeState.urgentThreatQueued) setImmediate(() => void features.decideAndAct('mine-replan'))
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
    // Once the ore is in hand, let progression handle fuel and smelting.
    const ironReady = targets.every(name => IRON_INPUT_NAMES.has(name)) && upgrade && raw + ingots >= upgrade.cost
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
    modelMineHint = modelTarget && Number.isFinite(modelTarget.x) && Number.isFinite(modelTarget.z) ? modelTarget : null
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
    mineRouteOptions,
    interruptMiningForCombat,
    finishMineObjective,
    recordMineAudit,
    mineForGear,
  }
}

module.exports = createMining
