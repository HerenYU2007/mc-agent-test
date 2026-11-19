const { goals } = require('mineflayer-pathfinder')
const { LOG_NAMES } = require('./config')

function createCanopy(runtimeState, features) {
  let nextCanopyAttemptAt = 0

  function isCanopyBlock(block) {
    return LOG_NAMES.has(block?.name) || /_leaves$/.test(block?.name ?? '')
  }

  function canopyColumn(connection, feet) {
    let platformY = feet.y
    const steps = []
    for (let depth = 1; depth <= 24; depth += 1) {
      const block = connection.blockAt(feet.offset(0, -depth, 0))
      if (!block || features.isWaterBlock(block) || /lava|magma|cactus|campfire|powder_snow/.test(block.name)) return null
      if (block.boundingBox !== 'block') continue
      if (platformY - block.position.y - 1 > 3) return null
      if (!isCanopyBlock(block)) {
        const landing = block.position.offset(0, 1, 0)
        return steps.length && feet.y - landing.y >= 4 ? { feet, steps, landing } : null
      }
      steps.push(block.position)
      platformY = block.position.y + 1
    }
    return null
  }

  async function leaveSpawnCanopy() {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection) || features.closeCombatPlan() || Date.now() < nextCanopyAttemptAt) return false
    const feet = connection.entity.position.floored()
    if (!connection.entity.onGround && connection.entity.position.y - feet.y > 0.15) return false
    if (!isCanopyBlock(connection.blockAt(feet.offset(0, -1, 0)))) return false
    nextCanopyAttemptAt = Date.now() + 2500
    let plan = canopyColumn(connection, feet)
    if (!plan) {
      const options = []
      for (let dx = -3; dx <= 3; dx += 1) {
        for (let dz = -3; dz <= 3; dz += 1) {
          for (const dy of [0, -1, -2]) {
            const point = feet.offset(dx, dy, dz)
            if (!features.walkableAt(point.x, point.y, point.z) || !isCanopyBlock(connection.blockAt(point.offset(0, -1, 0)))) continue
            const candidate = canopyColumn(connection, point)
            if (candidate) options.push(candidate)
          }
        }
      }
      for (const candidate of options.sort((a, b) => a.feet.distanceTo(feet) - b.feet.distanceTo(feet)).slice(0, 3)) {
        try {
          await features.gotoWithTimeout(new goals.GoalBlock(candidate.feet.x, candidate.feet.y, candidate.feet.z), 'canopy descent approach', 3000)
          plan = candidate
          break
        } catch (error) {
          features.log('canopy approach unavailable', { position: candidate.feet, message: error.message })
        }
      }
    }
    if (!plan || !features.canWorkHere(connection)) return false
    features.stopPathfinder()
    const center = plan.feet.offset(0.5, 0, 0.5)
    const offCenter = () => Math.hypot(connection.entity.position.x - center.x, connection.entity.position.z - center.z)
    if (offCenter() > 0.28) {
      await connection.lookAt(center.offset(0, connection.entity.eyeHeight, 0), true)
      connection.setControlState('sneak', true)
      connection.setControlState('forward', true)
      const deadline = Date.now() + 900
      try {
        while (features.canWorkHere(connection) && offCenter() > 0.2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
      } finally {
        connection.clearControlStates()
      }
    }
    if (!features.canWorkHere(connection) || offCenter() > 0.35) return false
    runtimeState.lastDecision = 'canopy-descent'
    features.log('canopy descent planned', { from: plan.feet, landing: plan.landing, steps: plan.steps.length })
    let progress = false
    for (const position of plan.steps) {
      if (!features.canWorkHere(connection) || features.closeCombatPlan() || offCenter() > 0.4) break
      const block = connection.blockAt(position)
      if (!isCanopyBlock(block) || position.y !== connection.entity.position.floored().y - 1 || !connection.canDigBlock(block)) break
      runtimeState.isDiggingBlock = true
      try {
        if (!await features.equipBestToolFor(block)) break
        await connection.dig(block, true)
        progress = true
        const landingDeadline = Date.now() + 1350
        while (features.canWorkHere(connection) && Date.now() < landingDeadline &&
            (!connection.entity.onGround || connection.entity.position.y >= position.y + 0.9)) {
          await new Promise(resolve => setTimeout(resolve, 60))
        }
      } catch (error) {
        features.log('canopy descent interrupted', { position, message: error.message })
        break
      } finally {
        runtimeState.isDiggingBlock = false
      }
    }
    if (features.canWorkHere(connection) && connection.entity.position.floored().equals(plan.landing)) {
      features.log('canopy descent reached ground', { position: plan.landing, health: connection.health })
    }
    return progress
  }

  return {
    leaveSpawnCanopy,
  }
}

module.exports = createCanopy
