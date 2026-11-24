const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { CorrectedWalkError, guardDrySteps, watchPath } = require('./movement-safety')
const { WATER_BLOCK_NAMES } = require('./config')
const { planClutchStep, executeClutchStep, clutchTimeBudget } = require('./water-clutch-path')

function createNavigation(runtimeState, features) {
  let lastParticleAt = 0

  function stopPathfinder() {
    if (!runtimeState.bot?.pathfinder) return
    try {
      // setGoal(null) clears the current path immediately. Calling
      // pathfinder.stop() leaves its stop flag armed until the next physics
      // tick, which can make the following goto reject instantly.
      runtimeState.bot.pathfinder.setGoal(null)
    } catch {
      try { runtimeState.bot.pathfinder.stop() } catch {}
    }
  }

  function visibleNavigationState() {
    const points = Array.isArray(runtimeState.navigationState.waypoints) ? runtimeState.navigationState.waypoints : []
    if (!runtimeState.bot?.entity) return runtimeState.navigationState
    if (features.waterOwnsMovement()) return { target: runtimeState.swimShore, waypoints: [], label: 'swimming' }
    const digging = runtimeState.bot.targetDigBlock
    if (digging) {
      const { x, y, z } = digging.position
      return { target: { x, y, z, name: digging.name }, waypoints: [], label: 'digging' }
    }
    if (runtimeState.bot.pathfinder && !runtimeState.bot.pathfinder.isMoving() && !runtimeState.mineBusy && !runtimeState.swimmingMode) {
      return { target: null, waypoints: [], label: '' }
    }
    if (points === runtimeState.activePath) {
      return { ...runtimeState.navigationState, waypoints: points.map(({ x, y, z }) => ({ x, y, z })) }
    }
    if (points.length < 2) return runtimeState.navigationState
    const position = runtimeState.bot.entity.position
    let nearestIndex = 0
    let nearestDistance = Infinity
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index]
      const dx = Number(point.x) - position.x
      const dz = Number(point.z) - position.z
      const distance = Math.hypot(dx, dz)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    }
    // Keep one node before the closest point so the line joins the bot while
    // removing all nodes that are already behind it.
    const keepFrom = nearestDistance <= 2.25 ? nearestIndex : Math.max(0, nearestIndex - 1)
    if (keepFrom <= 0) return runtimeState.navigationState
    return { ...runtimeState.navigationState, waypoints: points.slice(keepFrom) }
  }

  function clearNavigation(label = '') {
    runtimeState.activePath = null
    runtimeState.navigationState = { target: null, waypoints: [], label }
  }

  function emitNavigationParticles() {
    // Server-side dust particles are opt-in; the observer mod draws the route client-side.
    if (process.env.MC_VISUALIZE_PATH !== '1' || !runtimeState.bot?.entity || !runtimeState.navigationState.waypoints?.length) return
    if (Date.now() - lastParticleAt < 900) return
    lastParticleAt = Date.now()
    const y = Math.floor(runtimeState.bot.entity.position.y) + 1
    const points = runtimeState.navigationState.waypoints.slice(0, 16)
    for (const point of points) {
      const command = `/particle minecraft:dust{color:[1.0,0.0,0.0],scale:0.7} ${point.x + 0.5} ${y} ${point.z + 0.5} 0.12 0.35 0.12 0 4 force`
      try { runtimeState.bot.chat(command) } catch {}
    }
    const target = runtimeState.navigationState.target
    if (target) {
      const marker = `/particle minecraft:dust{color:[1.0,0.0,0.0],scale:1.4} ${target.x + 0.5} ${y + 0.8} ${target.z + 0.5} 0.2 1.0 0.2 0 12 force`
      try { runtimeState.bot.chat(marker) } catch {}
    }
  }

  function clampModelTarget(target, origin, maxDistance = 64) {
    if (!target || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.z))) return null
    return {
      x: Math.round(Math.max(origin.x - maxDistance, Math.min(origin.x + maxDistance, Number(target.x)))),
      z: Math.round(Math.max(origin.z - maxDistance, Math.min(origin.z + maxDistance, Number(target.z)))),
    }
  }

  async function gotoDestination(target, label = 'path') {
    const { x, z } = target
    const distance = Math.hypot(x - runtimeState.bot.entity.position.x, z - runtimeState.bot.entity.position.z)
    runtimeState.navigationState = { target: { x, z }, waypoints: [], label }
    await gotoWithTimeout(new goals.GoalNearXZ(x, z, 2), label, Math.min(26000, 7500 + distance * 350))
  }

  async function walkWithTimeout(connection, goal, label, timeoutMs, validateRoute) {
    const deadline = Date.now() + timeoutMs
    const movements = connection.pathfinder.movements
    guardDrySteps(connection, movements)
    const canJump = () => runtimeState.bot === connection && !features.waterOwnsMovement() &&
      !features.isWaterClutchActive(connection) && !runtimeState.impactGuards.has(connection)
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await watchPath(connection, goal, () => executeWalk(connection, goal, label, deadline - Date.now()), {
          validate: validateRoute, canJump, log: features.log,
        })
      } catch (error) {
        if (!(error instanceof CorrectedWalkError) || attempt >= 5 || deadline - Date.now() < 450 ||
            !canJump() || connection.pathfinder.goal || connection.pathfinder.movements !== movements) throw error
      }
    }
  }

  async function executeWalk(connection, goal, label, timeoutMs) {
    let timer
    const movement = connection.pathfinder.goto(goal)
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timeout`))
        if (connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([movement, timeout])
      if (!goal.isEnd(connection.entity.position.floored())) throw new Error(`${label}: actual position did not reach goal`)
      return result
    } finally {
      clearTimeout(timer)
      if (connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
    }
  }

  async function gotoWithTimeout(goal, label, timeoutMs, { allowClutch, validateRoute } = {}) {
    if (features.waterOwnsMovement()) throw new Error('movement paused until the bot reaches dry ground')
    const connection = runtimeState.bot
    const movements = connection.pathfinder.movements
    const clutchEnabled = allowClutch ?? movements === runtimeState.movements
    const deadline = Date.now() + timeoutMs
    const canStart = () => runtimeState.bot === connection && runtimeState.botEnabled && connection.entity &&
      connection.health >= 10 && !connection.entity.isInWater && !connection.pathfinder.goal &&
      connection.pathfinder.movements === movements &&
      !runtimeState.fleeingActive && !runtimeState.emergencyRetreating && !features.isWaterClutchActive(connection) &&
      !features.closeCombatPlan()
    while (clutchEnabled && deadline - Date.now() > 3000 && canStart()) {
      const step = planClutchStep(connection, goal, movements)
      if (!step) break
      const approachTime = deadline - Date.now() - clutchTimeBudget(step.height)
      if (approachTime <= 0) break
      const { edge, landing } = step
      if (!connection.entity.position.floored().equals(edge)) {
        await walkWithTimeout(connection, new goals.GoalBlock(edge.x, edge.y, edge.z), label, approachTime)
      }
      if (!canStart()) throw new Error('movement interrupted before water clutch')
      features.log('planned water clutch selected', { edge, landing, height: step.height })
      if (!await executeClutchStep(connection, step,
        { canStart, recoveredAt: () => features.waterClutchRecoveredAt(connection) }, deadline)) break
      if (goal.isEnd(connection.entity.position.floored())) return
    }
    if (deadline <= Date.now()) throw new Error(`${label} timeout`)
    if (runtimeState.bot !== connection || !runtimeState.botEnabled || connection.health <= 0 ||
        features.waterOwnsMovement() || features.isWaterClutchActive(connection)) throw new Error('movement interrupted')
    return walkWithTimeout(connection, goal, label, deadline - Date.now(), validateRoute)
  }

  function canWorkHere(connection, duringMining = false) {
    return connection === runtimeState.bot && runtimeState.botEnabled && connection?.entity && connection.health > 0 &&
      !runtimeState.emergencyRetreating && !features.waterOwnsMovement() && !features.isWaterClutchActive(connection) &&
      (!runtimeState.mineBusy || duringMining)
  }

  async function moveToModelTarget(target, label = 'model target') {
    const origin = runtimeState.bot.entity.position.floored()
    const safeTarget = clampModelTarget(target, origin, 64)
    if (!safeTarget) return false
    try {
      await gotoDestination(safeTarget, label)
      return true
    } catch (error) {
      stopPathfinder()
      features.log('target path failed; using local fallback', { label, target: safeTarget, message: error.message })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'path-replan', experience: `${label} 未到达，改为当前位置附近重新规划：${error.message}` })
      return false
    }
  }

  // Pick an explore direction that leads away from nearby water: sample a ring of
  // candidates and keep the first whose target column and route midpoint are dry.
  function pickDryExploreTarget(origin, minDistance = 12, maxExtra = 18) {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const angle = Math.random() * Math.PI * 2
      const distance = minDistance + Math.floor(Math.random() * maxExtra)
      const x = origin.x + Math.round(Math.cos(angle) * distance)
      const z = origin.z + Math.round(Math.sin(angle) * distance)
      const mx = origin.x + Math.round(Math.cos(angle) * distance / 2)
      const mz = origin.z + Math.round(Math.sin(angle) * distance / 2)
      const column = position => {
        for (let dy = 4; dy >= -6; dy -= 1) {
          const block = runtimeState.bot.blockAt(new Vec3(position.x, origin.y + dy, position.z))
          if (block && block.boundingBox === 'block') return block
        }
        return null
      }
      const end = column({ x, z })
      const mid = column({ x: mx, z: mz })
      if (!end || !mid || WATER_BLOCK_NAMES.has(end.name) || WATER_BLOCK_NAMES.has(mid.name)) continue
      const top = runtimeState.bot.blockAt(end.position.offset(0, 1, 0))
      if (top && WATER_BLOCK_NAMES.has(top.name)) continue
      return { x, z }
    }
    return null
  }

  async function exploreOneStep(modelTarget = null) {
    const origin = runtimeState.bot.entity.position.floored()
    const angle = Math.random() * Math.PI * 2
    const distance = 12 + Math.floor(Math.random() * 18)
    let randomTarget = origin.offset(Math.round(Math.cos(angle) * distance), 0, Math.round(Math.sin(angle) * distance))
    const dryTarget = pickDryExploreTarget(origin)
    if (dryTarget) randomTarget = new Vec3(dryTarget.x, origin.y, dryTarget.z)
    // For a short time after leaving water ignore a model target that is wet or
    // beside water, so the bot does not walk straight back in.
    if (modelTarget && Date.now() - runtimeState.landedAt < 8000) {
      const probe = runtimeState.bot.blockAt(new Vec3(Number(modelTarget.x), origin.y - 1, Number(modelTarget.z)))
      if (!probe || WATER_BLOCK_NAMES.has(probe.name) || features.isWaterAdjacent(probe.position)) {
        features.log('explore target near water right after landing; ignored', { modelTarget })
        modelTarget = null
      }
    }
    let target = clampModelTarget(modelTarget, origin, 64)
    // A model target on top of the bot makes explore a no-op, which is how the
    // bot ended up idling in place. Require real travel, else pick a random one.
    if (target && Math.hypot(target.x - origin.x, target.z - origin.z) < 8) {
      features.log('explore target too close; using random target', { rejected: target })
      target = null
    }
    if (!target) target = { x: randomTarget.x, z: randomTarget.z }
    features.log('exploring', { from: origin, target })
    try {
      // Let the pathfinder choose the reachable surface height. Requiring the
      // random target to have the bot's exact Y coordinate made exploration
      // fail immediately on hills, trees, and uneven terrain.
      await gotoDestination(target, 'explore')
    } catch (firstError) {
      stopPathfinder()
      const fallback = origin.offset(Math.round(Math.cos(angle) * 8), 0, Math.round(Math.sin(angle) * 8))
      features.log('path replan', { reason: firstError.message, fallback: { x: fallback.x, z: fallback.z } })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'path-replan', experience: `目标寻路失败，改用近距离目标：${firstError.message}` })
      await gotoDestination({ x: fallback.x, z: fallback.z }, 'explore fallback')
    }
    await features.maybePlaceTorch()
  }

  async function prospectMiningLevel(y) {
    runtimeState.baseProspecting = true
    try {
      await gotoWithTimeout(new goals.GoalY(y), 'prospect towards mining level', 12000)
      return true
    } catch {
      return false
    } finally {
      runtimeState.baseProspecting = false
    }
  }

  return {
    stopPathfinder,
    visibleNavigationState,
    clearNavigation,
    emitNavigationParticles,
    clampModelTarget,
    gotoWithTimeout,
    canWorkHere,
    moveToModelTarget,
    pickDryExploreTarget,
    exploreOneStep,
    prospectMiningLevel,
  }
}

module.exports = createNavigation
