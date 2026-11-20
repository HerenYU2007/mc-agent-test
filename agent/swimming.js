const { Vec3 } = require('vec3')
const { WATER_BLOCK_NAMES, EMPTY_BLOCK, TUNNEL_SAFE_BLOCKS } = require('./config')

const PLACED_SUPPORT = /(cobblestone|_planks|_slab|_stairs|crafting_table|furnace|scaffolding)$/

function createSwimming(runtimeState, features) {
  let swimDrySince = 0

  let swimBankDig = null

  let nextSwimBankDigAt = 0

  // When set, the swim controller heads for this far shore instead of the
  // nearest ledge (used to leave a platform the bot built in the sea).
  let swimOverride = null

  let swimOverrideUntil = 0
  let swimOverrideConnection = null

  let lastStrandCheckAt = 0

  let lastSwimLogAt = 0
  let lastLanding = null

  function waterSurfaceY(connection, origin) {
    let surface = origin.y
    while (surface - origin.y < 48 && features.isWaterBlock(connection.blockAt(new Vec3(origin.x, surface + 1, origin.z)))) surface += 1
    return surface
  }

  function findNearestLandForSwimming(radius = 12) {
    if (!runtimeState.bot?.entity) return null
    const origin = runtimeState.bot.entity.position.floored()
    const surface = waterSurfaceY(runtimeState.bot, origin)
    let best = null
    let bestDistance = Infinity
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (const y of [surface + 1, surface, surface + 2]) {
          const position = new Vec3(origin.x + dx, y, origin.z + dz)
          if (runtimeState.swimFailedShore && position.distanceTo(runtimeState.swimFailedShore) < 2) continue
          const support = runtimeState.bot.blockAt(position.offset(0, -1, 0))
          if (support?.boundingBox !== 'block' || runtimeState.movements?.blocksToAvoid.has(support.type)) continue
          if (!EMPTY_BLOCK.test(runtimeState.bot.blockAt(position)?.name) ||
              !EMPTY_BLOCK.test(runtimeState.bot.blockAt(position.offset(0, 1, 0))?.name)) continue
          const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
            const water = new Vec3(position.x + x, Math.min(y - 1, surface), position.z + z)
            return features.isWaterBlock(runtimeState.bot.blockAt(water)) &&
              runtimeState.bot.blockAt(water.offset(0, 1, 0))?.boundingBox === 'empty' &&
              runtimeState.bot.blockAt(water.offset(0, 2, 0))?.boundingBox === 'empty'
          })
          if (!edge) continue
          const distance = runtimeState.bot.entity.position.distanceTo(position) + 2 * Math.abs(y - surface - 1)
          if (distance < bestDistance) {
            best = position
            bestDistance = distance
          }
        }
      }
    }
    return best
  }

  async function lowerSwimBank(connection, shore, lip) {
    try {
      if (!await features.equipBestToolFor(lip) || connection !== runtimeState.bot || !isActuallyInWater(connection)) return
      await connection.lookAt(lip.position.offset(0.5, 0.5, 0.5), true)
      if (!connection.blockAtCursor(4.5)?.position.equals(lip.position)) return
      const dig = connection.dig(lip, true)
      const deadline = Date.now() + Math.max(5500, connection.digTime(lip) * 2 + 1000)
      let finished = false
      void dig.then(() => { finished = true }, () => { finished = true })
      while (!finished && connection === runtimeState.bot && connection.health > 0 &&
             Number(connection.oxygenLevel ?? 20) > 6 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      if (!finished && connection.targetDigBlock?.position.equals(lip.position)) connection.stopDigging()
      if (connection === runtimeState.bot && finished && connection.blockAt(lip.position)?.type !== lip.type) {
        runtimeState.swimShore = shore.offset(0, -1, 0)
        if (swimOverride?.equals(shore)) swimOverride = runtimeState.swimShore
        runtimeState.swimProgress = { distance: Infinity, at: Date.now() }
        features.log('swim bank lowered for exit', { block: lip.name, position: lip.position, exit: runtimeState.swimShore })
      }
    } catch (error) {
      features.log('swim bank clearance interrupted', { message: error.message })
    } finally {
      if (swimBankDig?.connection === connection) swimBankDig = null
    }
  }

  function isActuallyInWater(connection = runtimeState.bot) {
    return Boolean(connection?.entity && (connection.entity.isInWater ||
      features.isWaterBlock(connection.blockAt(connection.entity.position.floored()))))
  }

  function waterOwnsMovement() {
    return runtimeState.swimmingMode || isActuallyInWater()
  }

  // Flood fill over dry standable columns (steps of at most one block). Capped,
  // so a real landmass stops the search quickly while a platform returns small.
  function dryComponent(start, cap = 60) {
    const seen = new Map()
    const queue = [{ x: start.x, y: start.y, z: start.z }]
    seen.set(`${start.x},${start.z}`, start.y)
    while (queue.length > 0 && seen.size < cap) {
      const node = queue.shift()
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = node.x + dx
        const nz = node.z + dz
        const key = `${nx},${nz}`
        if (seen.has(key)) continue
        for (const dy of [0, 1, -1]) {
          if (features.walkableAt(nx, node.y + dy, nz)) {
            seen.set(key, node.y + dy)
            queue.push({ x: nx, y: node.y + dy, z: nz })
            break
          }
        }
      }
    }
    return seen
  }

  // Nearest natural, solid landmass outside `platform`. Sampled every 2 blocks to
  // stay cheap; each candidate must be a real landmass (large dry component).
  function findMainlandShore(platform, radius = 48) {
    const origin = runtimeState.bot.entity.position.floored()
    const candidates = []
    for (let dx = -radius; dx <= radius; dx += 2) {
      for (let dz = -radius; dz <= radius; dz += 2) {
        const x = origin.x + dx
        const z = origin.z + dz
        const distance = Math.hypot(dx, dz)
        if (distance < 4 || platform.has(`${x},${z}`)) continue
        for (let y = origin.y + 6; y >= origin.y - 8; y -= 1) {
          const support = runtimeState.bot.blockAt(new Vec3(x, y - 1, z))
          if (!support || support.boundingBox !== 'block') continue
          // First solid block from above is the surface of this column.
          if (PLACED_SUPPORT.test(support.name) || /(leaves|_log)$/.test(support.name) || !features.walkableAt(x, y, z)) break
          let solid = true
          for (let i = -1; i <= 1 && solid; i += 1) {
            for (let j = -1; j <= 1 && solid; j += 1) {
              if (runtimeState.bot.blockAt(new Vec3(x + i, y - 1, z + j))?.boundingBox !== 'block') solid = false
            }
          }
          if (solid) candidates.push({ x, y, z, distance })
          break
        }
      }
    }
    candidates.sort((a, b) => a.distance - b.distance)
    for (const candidate of candidates.slice(0, 12)) {
      if (dryComponent(candidate, 60).size >= 40) return candidate
    }
    return null
  }

  function preferSwimShoreNear(connection, destination) {
    if (connection !== runtimeState.bot || !connection?.entity ||
        ![destination?.x, destination?.y, destination?.z].every(Number.isFinite)) return null
    const center = new Vec3(destination.x, destination.y, destination.z).floored()
    const candidates = []
    for (let x = -14; x <= 14; x++) {
      for (let z = -14; z <= 14; z++) {
        if (Math.hypot(x, z) > 14) continue
        for (let y = -9; y <= 3; y++) {
          const feet = center.offset(x, y, z)
          if (!features.walkableAt(feet.x, feet.y, feet.z)) continue
          const adjoinsWater = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) =>
            [-1, -2].some(dy => {
              const water = feet.offset(dx, dy, dz)
              return features.isWaterBlock(connection.blockAt(water)) &&
                connection.blockAt(water.offset(0, 1, 0))?.boundingBox === 'empty' &&
                connection.blockAt(water.offset(0, 2, 0))?.boundingBox === 'empty'
            }))
          if (adjoinsWater) candidates.push(feet)
        }
      }
    }
    candidates.sort((left, right) => left.distanceTo(center) - right.distanceTo(center))
    const shore = candidates.slice(0, 20).find(feet => dryComponent(feet, 16).size >= 8)
    if (!shore || shore.distanceTo(connection.entity.position) < 3) return null
    swimOverride = shore
    swimOverrideConnection = connection
    swimOverrideUntil = Date.now() + 45000
    features.log('swim destination shore planned', { target: center, shore })
    return shore
  }

  // Standing on a tiny patch (e.g. a platform built over the sea): swim to real land.
  async function escapeIfStranded() {
    if (!runtimeState.bot?.entity || waterOwnsMovement() || swimOverride || runtimeState.emergencyRetreating) return false
    if (Date.now() - lastStrandCheckAt < 5000 || !runtimeState.bot.entity.onGround) return false
    lastStrandCheckAt = Date.now()
    const feet = runtimeState.bot.entity.position.floored()
    if (features.openSurfaceAt(runtimeState.bot, feet)) runtimeState.lastDrySurface = { feet, dimension: runtimeState.bot.game.dimension }
    // A forest floor under leaves also gives a tiny "dry component" because the
    // head-clearance test fails there. Only treat it as a stranded platform when
    // water actually surrounds the bot, which is the real sea-platform case.
    let waterAround = 0
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        for (const dy of [-1, 0]) {
          const block = runtimeState.bot.blockAt(feet.offset(dx, dy, dz))
          if (block && WATER_BLOCK_NAMES.has(block.name)) waterAround += 1
        }
      }
    }
    if (waterAround < 12) return false
    const platform = dryComponent({ x: feet.x, y: feet.y, z: feet.z }, 60)
    if (platform.size >= 40) return false
    const shore = findMainlandShore(platform)
    if (!shore) {
      features.log('stranded on a small platform; no mainland within range', { platformSize: platform.size })
      return false
    }
    features.log('stranded on a small platform; swimming to mainland', { platformSize: platform.size, shore })
    features.persistExperience({ cycle: runtimeState.cycle, action: 'escape-platform', experience: '站在海中的小平台上，寻路不下水会原地踏步；改为游向真正的陆地' })
    swimOverride = new Vec3(shore.x, shore.y, shore.z)
    swimOverrideConnection = runtimeState.bot
    swimOverrideUntil = Date.now() + 90000
    runtimeState.mineMode = false
    features.stopPathfinder()
    features.clearNavigation('escape-platform')
    const deadline = Date.now() + 5000
    try {
      while (Date.now() < deadline && !isActuallyInWater() && runtimeState.bot.health > 0) {
        const dx = shore.x + 0.5 - runtimeState.bot.entity.position.x
        const dz = shore.z + 0.5 - runtimeState.bot.entity.position.z
        await runtimeState.bot.look(Math.atan2(-dx, -dz), 0, true)
        runtimeState.bot.setControlState('forward', true)
        runtimeState.bot.setControlState('sprint', true)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } finally {
      if (!isActuallyInWater()) {
        swimOverride = null
        runtimeState.bot.clearControlStates()
      }
    }
    return true
  }

  function monitorSwimming() {
    if (!runtimeState.botEnabled || !runtimeState.bot?.entity || runtimeState.bot.health <= 0 ||
        features.isWaterClutchActive()) return
    const now = Date.now()
    const inWater = isActuallyInWater()
    if (swimOverride && (swimOverrideConnection !== runtimeState.bot || now > swimOverrideUntil)) swimOverride = null
    if (!inWater) {
      if (!runtimeState.swimmingMode) {
        if (swimOverride && runtimeState.bot.entity.position.distanceTo(swimOverride) <= 3) swimOverride = null
        return
      }
      // Jumping against the shore keeps onGround flickering. Count the bot as
      // standing when it is on the ground or a solid block is directly below,
      // so control is handed back instead of idling in swim-ashore.
      const below = runtimeState.bot.blockAt(runtimeState.bot.entity.position.floored().offset(0, -1, 0))
      const standing = runtimeState.bot.entity.onGround || below?.boundingBox === 'block'
      if (swimOverride) {
        const connection = runtimeState.bot
        const delta = swimOverride.offset(0.5, 0, 0.5).minus(connection.entity.position)
        const distance = Math.hypot(delta.x, delta.z)
        if (distance > 4) {
          const next = connection.entity.position.offset(delta.x * 0.8 / distance, 0, delta.z * 0.8 / distance).floored()
          const floor = connection.blockAt(next.offset(0, -1, 0))
          const step = connection.blockAt(next)
          if (floor?.boundingBox === 'block' || features.isWaterBlock(floor) || features.isWaterBlock(step)) {
            swimDrySince = 0
            connection.setControlState('forward', true)
            connection.setControlState('sprint', true)
            connection.setControlState('jump', step?.boundingBox === 'block')
            void connection.look(Math.atan2(-delta.x, -delta.z), 0, true).catch(() => {})
            return
          }
        }
      }
      if (standing) swimDrySince ||= now
      else swimDrySince = 0
      if (swimDrySince) {
        runtimeState.bot.setControlState('forward', false)
        runtimeState.bot.setControlState('sprint', false)
      }
      if (swimDrySince && now - swimDrySince >= 550) {
        runtimeState.bot.clearControlStates()
        runtimeState.swimmingMode = false
        runtimeState.swimShore = runtimeState.swimProgress = runtimeState.swimFailedShore = null
        features.clearNavigation('landed')
        features.log('swim reached dry ground', { position: runtimeState.bot.entity.position })
        if (swimOverride) {
          // Only finish the override when this is the mainland, not the platform.
          const here = runtimeState.bot.entity.position.floored()
          const reached = Math.hypot(here.x - swimOverride.x, here.z - swimOverride.z) <= 4
          if (reached) swimOverride = null
        }
        runtimeState.landedAt = Date.now()
        lastLanding = { connection: runtimeState.bot, feet: runtimeState.bot.entity.position.floored() }
        setImmediate(() => void features.decideAndAct('landed'))
      } else {
        runtimeState.bot.setControlState('jump', false)
      }
      return
    }

    swimDrySince = 0
    if (!runtimeState.swimmingMode) {
      runtimeState.swimmingMode = true
      runtimeState.lastDecision = 'swim-ashore'
      runtimeState.bot.pvp.stop()
      features.stopPathfinder()
      runtimeState.bot.stopDigging()
      runtimeState.bot.clearControlStates()
      features.clearNavigation('swimming')
      features.log('entered water; fast swim controller enabled', { oxygen: runtimeState.bot.oxygenLevel })
      if (!swimOverride && lastLanding?.connection === runtimeState.bot && now - runtimeState.landedAt < 7000 &&
          runtimeState.bot.entity.position.distanceTo(lastLanding.feet) < 4) {
        const platform = dryComponent(lastLanding.feet, 40)
        runtimeState.swimFailedShore = lastLanding.feet
        const shore = findMainlandShore(platform) ?? findNearestLandForSwimming(32)
        if (shore) {
          swimOverride = new Vec3(shore.x, shore.y, shore.z)
          swimOverrideConnection = runtimeState.bot
          swimOverrideUntil = now + 45000
          features.log('swim seeking alternate land after repeated entry', { previous: lastLanding.feet, shore: swimOverride })
        }
      }
    }

    const oxygen = Number(runtimeState.bot.oxygenLevel ?? 20)
    if (swimBankDig?.connection === runtimeState.bot) {
      runtimeState.bot.setControlState('jump', true)
      runtimeState.bot.setControlState('forward', false)
      if (oxygen <= 6 && runtimeState.bot.targetDigBlock?.position.equals(swimBankDig.position)) runtimeState.bot.stopDigging()
      return
    }
    const position = runtimeState.bot.entity.position
    const horizontalRemaining = runtimeState.swimShore ? Math.hypot(position.x - runtimeState.swimShore.x - 0.5, position.z - runtimeState.swimShore.z - 0.5) : Infinity
    if (runtimeState.swimShore && runtimeState.swimProgress && horizontalRemaining + 0.4 < runtimeState.swimProgress.distance) {
      runtimeState.swimProgress = { distance: horizontalRemaining, at: now }
    }
    if (runtimeState.swimShore && runtimeState.swimProgress && oxygen > 9 && now >= nextSwimBankDigAt &&
        now - runtimeState.swimProgress.at >= 1300 && horizontalRemaining < 3) {
      const feet = position.floored()
      const lip = runtimeState.bot.blockAt(runtimeState.swimShore.offset(0, -1, 0))
      const support = runtimeState.bot.blockAt(runtimeState.swimShore.offset(0, -2, 0))
      if (runtimeState.swimShore.y > waterSurfaceY(runtimeState.bot, feet) + 1 && lip && support?.boundingBox === 'block' &&
          !features.isWaterBlock(support) && TUNNEL_SAFE_BLOCKS.has(lip.name) && !features.isOreName(lip.name) && runtimeState.bot.canDigBlock(lip)) {
        swimBankDig = { connection: runtimeState.bot, position: lip.position }
        nextSwimBankDigAt = now + 4500
        runtimeState.bot.setControlState('jump', true)
        runtimeState.bot.setControlState('forward', false)
        void lowerSwimBank(runtimeState.bot, runtimeState.swimShore, lip)
        return
      }
    }
    if (runtimeState.swimShore && runtimeState.swimProgress && now - runtimeState.swimProgress.at > 3000 && oxygen > 6) {
      runtimeState.swimFailedShore = runtimeState.swimShore
      runtimeState.swimShore = null
      runtimeState.swimProgress = null
    }
    if (swimOverride) {
      // Heading for the mainland: skip the progress-based shore swap so it does
      // not turn back to the platform it just left.
      if (!runtimeState.swimShore || runtimeState.swimShore.x !== swimOverride.x || runtimeState.swimShore.z !== swimOverride.z) {
        runtimeState.swimShore = swimOverride
        runtimeState.swimProgress = { distance: Infinity, at: now }
        features.log('swim shore selected', { position: runtimeState.swimShore, reason: 'mainland override' })
      }
      runtimeState.swimProgress = runtimeState.swimProgress && { ...runtimeState.swimProgress, at: now }
    } else if (!runtimeState.swimShore && (!runtimeState.swimProgress || now - runtimeState.swimProgress.at > 1500)) {
      runtimeState.swimShore = findNearestLandForSwimming(14)
      runtimeState.swimProgress = { distance: Infinity, at: now }
      if (runtimeState.swimShore) features.log('swim shore selected', { position: runtimeState.swimShore })
    }
    runtimeState.bot.setControlState('sprint', true)
    runtimeState.bot.setControlState('forward', oxygen > 6)
    runtimeState.bot.setControlState('jump', oxygen <= 6 || !runtimeState.swimShore ||
      position.y < runtimeState.swimShore.y - 1.4 || horizontalRemaining < 2.5)

    if (oxygen <= 6) {
      // Hold the head upward and keep jumping until the oxygen bar recovers.
      void runtimeState.bot.look(runtimeState.bot.entity.yaw, 1.1, true).catch(() => {})
      if (Date.now() - lastSwimLogAt > 2000) {
        lastSwimLogAt = Date.now()
        features.log('low oxygen; surfacing', { oxygen })
      }
    } else if (runtimeState.swimShore) {
      const dx = runtimeState.swimShore.x + 0.5 - position.x
      const dz = runtimeState.swimShore.z + 0.5 - position.z
      const pitch = position.y < runtimeState.swimShore.y - 1.2 ? 0.32 : 0
      void runtimeState.bot.look(Math.atan2(-dx, -dz), pitch, true).catch(() => {})
    }
  }

  return {
    isActuallyInWater,
    waterOwnsMovement,
    preferSwimShoreNear,
    escapeIfStranded,
    monitorSwimming,
  }
}

module.exports = createSwimming
