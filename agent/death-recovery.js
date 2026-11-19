const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { THREAT_RADIUS, RANGED_HOSTILES } = require('./config')

const DEATH_DROP_LIFETIME_MS = 5 * 60 * 1000
const DEATH_RECOVERY_ATTEMPTS = 2
const DEATH_RECOVERY_COOLDOWN_MS = 25000
const VALUABLE_DEATH_GEAR = /^(iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/
const VALUABLE_DEATH_ITEMS = new Set([
  'diamond', 'netherite_scrap', 'netherite_ingot', 'ancient_debris', 'elytra',
  'totem_of_undying', 'enchanted_golden_apple',
])

function createDeathRecovery(runtimeState, features) {
  let recoveringDeathDrops = false

  function carriedStackCounts(connection, valuableOnly = false) {
    const inventory = connection.inventory
    const items = [...inventory.items()]
    for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
      const item = inventory.slots[connection.getEquipmentDestSlot(slot)]
      if (item && !items.includes(item)) items.push(item)
    }
    const counts = new Map()
    const wanted = new Set()
    for (const item of items) {
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
      if (VALUABLE_DEATH_GEAR.test(item.name) || VALUABLE_DEATH_ITEMS.has(item.name) || item.enchants?.length) {
        wanted.add(item.name)
      }
    }
    if (!valuableOnly) return counts
    for (const [name, minimum] of [['raw_iron', 4], ['iron_ingot', 4], ['emerald', 4]]) {
      if ((counts.get(name) ?? 0) >= minimum) wanted.add(name)
    }
    return new Map([...wanted].map(name => [name, counts.get(name)]))
  }

  function deathRecoveryDue(connection = runtimeState.bot) {
    return runtimeState.deathPoint && !runtimeState.deathPoint.done && Date.now() >= runtimeState.deathPoint.nextAttemptAt &&
      connection?.entity && connection.health >= 16 && connection.food >= 14
  }

  function finishDeathRecovery(point, reason, details = {}) {
    point.done = true
    features.log('death recovery finished', { reason, attempts: point.attempts, ...details })
  }

  function deferDeathRecovery(point, reason, target = null) {
    if (point.attempts >= DEATH_RECOVERY_ATTEMPTS) {
      finishDeathRecovery(point, reason)
      return
    }
    point.nextAttemptAt = Date.now() + DEATH_RECOVERY_COOLDOWN_MS
    features.log('death recovery deferred', { reason, target, attempts: point.attempts })
  }

  function deathRecoveryThreat(connection, site) {
    const origin = connection.entity.position
    return Object.values(connection.entities).find(entity => {
      if (!entity.position || !features.isHostileEntity(entity)) return false
      const name = features.hostileName(entity)
      const reach = RANGED_HOSTILES.has(name) ? 16 : name === 'creeper' ? 11 : 8
      return entity.position.distanceTo(origin) <= reach || entity.position.distanceTo(site) <= reach
    })
  }

  async function recoverDeathDrops() {
    const point = runtimeState.deathPoint
    const connection = runtimeState.bot
    if (!point || point.done || recoveringDeathDrops || !features.canWorkHere(connection)) return false
    if (point.dimension !== (connection.game?.dimension ?? 'overworld')) {
      finishDeathRecovery(point, 'another-dimension')
      return false
    }
    const expiresAt = point.diedAt + DEATH_DROP_LIFETIME_MS - 15000
    if (Date.now() >= expiresAt) {
      finishDeathRecovery(point, 'expired')
      return false
    }
    if (!deathRecoveryDue(connection)) return false

    const goalPoint = new Vec3(point.x, point.y, point.z)
    const before = carriedStackCounts(connection)
    const missing = new Set([...point.loot].filter(([name, count]) => (before.get(name) ?? 0) < count).map(([name]) => name))
    if (!missing.size) {
      finishDeathRecovery(point, 'gear-already-carried')
      return false
    }
    const siteUnsafe = () => {
      const site = connection.blockAt(goalPoint)
      return goalPoint.y < connection.game.minY || (site && (features.isWaterBlock(site) || /lava|fire/.test(site.name)))
    }
    if (siteUnsafe()) {
      finishDeathRecovery(point, 'unsafe-terrain')
      return false
    }
    const firstThreat = deathRecoveryThreat(connection, goalPoint)
    if (firstThreat) {
      deferDeathRecovery(point, 'hostile-nearby', features.hostileName(firstThreat))
      return false
    }

    const startingHealth = connection.health
    const interruption = () => {
      if (point.done || runtimeState.bot !== connection || !runtimeState.botEnabled || !connection.entity || connection.health <= 0 ||
          Date.now() >= expiresAt) return { reason: 'interrupted' }
      if (connection.health < startingHealth) return { reason: 'damage', urgent: true }
      if (siteUnsafe()) return { reason: 'unsafe-terrain' }
      if (connection.food < 14 || features.waterOwnsMovement() || runtimeState.emergencyRetreating || runtimeState.fleeingActive) return { reason: 'survival-priority' }
      const threat = deathRecoveryThreat(connection, goalPoint)
      if (threat) return { reason: 'hostile-nearby', target: features.hostileName(threat),
        urgent: threat.position.distanceTo(connection.entity.position) <= THREAT_RADIUS }
      return null
    }

    let stopped = null
    const walk = async (goal, label, timeout) => {
      const watch = setInterval(() => {
        stopped ??= interruption()
        if (stopped && runtimeState.bot === connection && connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
      }, 100)
      try {
        await features.gotoWithTimeout(goal, label, timeout)
      } catch (error) {
        if (!stopped) features.log('death recovery path interrupted', { message: error.message })
      } finally {
        clearInterval(watch)
      }
      stopped ??= interruption()
      return !stopped
    }

    const nearbyDeathDrops = () => features.findNearbyDrops(10).filter(({ entity }) =>
      entity.position.distanceTo(goalPoint) <= 8 && missing.has(features.droppedStack(entity)?.name))
    const stillNearby = () => connection.entity.position.distanceTo(goalPoint) <= 4
    const travel = connection.entity.position.distanceTo(goalPoint)
    recoveringDeathDrops = true
    runtimeState.mineMode = false
    point.attempts += 1
    runtimeState.lastDecision = 'death-recovery'
    runtimeState.navigationState = { target: { x: point.x, y: point.y, z: point.z, name: 'death-point' }, waypoints: [], label: 'death-recovery' }
    features.log('recovering death drops', { point: goalPoint, attempt: point.attempts, wanted: [...missing] })
    try {
      if (!stillNearby()) await walk(new goals.GoalNear(point.x, point.y, point.z, 3), 'death recovery path', Math.min(16000, 5000 + travel * 400))
      if (!stopped && stillNearby()) {
        const tried = new Set()
        for (let i = 0; i < 4 && !interruption(); i += 1) {
          const target = nearbyDeathDrops().find(({ entity }) => !tried.has(entity.id))?.entity
          if (!target) break
          tried.add(target.id)
          const feet = target.position.floored()
          if (!await walk(new goals.GoalBlock(feet.x, feet.y, feet.z), 'valuable death drop pickup', 3500)) break
          await new Promise(resolve => setTimeout(resolve, 250))
        }
      }
      stopped ??= interruption()
      if (stopped) {
        if (!point.done) {
          if (stopped.reason === 'unsafe-terrain') finishDeathRecovery(point, stopped.reason)
          else deferDeathRecovery(point, stopped.reason, stopped.target)
        }
        if (stopped.urgent) runtimeState.urgentThreatQueued = true
        return true
      }
      const after = carriedStackCounts(connection)
      const gained = [...missing].reduce((sum, name) => sum + Math.max(0, (after.get(name) ?? 0) - (before.get(name) ?? 0)), 0)
      const reached = stillNearby()
      const dropsLeft = reached ? nearbyDeathDrops().length : null
      features.log('death recovery result', { gained, dropsLeft, reached, attempt: point.attempts })
      const recoveredAll = [...missing].every(name => (after.get(name) ?? 0) >= point.loot.get(name))
      if (gained && (recoveredAll || dropsLeft === 0)) {
        finishDeathRecovery(point, 'valuable-loot-recovered', { gained })
        features.persistExperience({ cycle: runtimeState.cycle, action: 'death-recovery', experience: `回收 ${gained} 个值得取回的掉落物` })
      } else {
        deferDeathRecovery(point, reached ? 'valuable-loot-unconfirmed' : 'unreachable')
      }
      return true
    } finally {
      if (runtimeState.bot === connection && runtimeState.navigationState.label === 'death-recovery') features.clearNavigation('death-recovery-done')
      recoveringDeathDrops = false
    }
  }

  function trackDeathRecoveryInventory(connection) {
    // Inventory-clear packets can arrive just before the death health update.
    let recentRecoveryLoot = null
    let nextLootSampleAt = 0
    connection.on('physicsTick', () => {
      const now = Date.now()
      if (connection.health <= 0 || now < nextLootSampleAt) return
      nextLootSampleAt = now + 100
      const loot = carriedStackCounts(connection, true)
      if (loot.size) recentRecoveryLoot = { loot, at: now }
    })
    return () => {
      const where = connection.entity?.position.floored()
      const loot = carriedStackCounts(connection, true)
      if (recentRecoveryLoot && Date.now() - recentRecoveryLoot.at < 1000) {
        for (const [name, count] of recentRecoveryLoot.loot) loot.set(name, Math.max(count, loot.get(name) ?? 0))
      }
      recentRecoveryLoot = null
      if (runtimeState.deathPoint && !runtimeState.deathPoint.done) {
        if (recoveringDeathDrops || (where && runtimeState.deathPoint.dimension === connection.game?.dimension &&
            where.distanceTo(new Vec3(runtimeState.deathPoint.x, runtimeState.deathPoint.y, runtimeState.deathPoint.z)) <= 12)) {
          finishDeathRecovery(runtimeState.deathPoint, 'died-during-recovery')
        } else {
          deferDeathRecovery(runtimeState.deathPoint, 'died-before-recovery')
        }
      } else if (where) {
        if (loot.size) {
          runtimeState.deathPoint = {
            x: where.x, y: where.y, z: where.z, loot,
            dimension: connection.game?.dimension ?? 'overworld',
            diedAt: Date.now(), attempts: 0, done: false, nextAttemptAt: Date.now() + 1800,
          }
          features.log('death point recorded', { position: where, dimension: runtimeState.deathPoint.dimension, loot: [...loot] })
        } else {
          features.log('death recovery skipped', { reason: 'low-value-loot', position: where })
        }
      }
    }
  }

  return {
    deathRecoveryDue,
    recoverDeathDrops,
    trackDeathRecoveryInventory,
  }
}

module.exports = createDeathRecovery
