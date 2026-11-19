const { Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { STONE_DROPS, LOG_NAMES, IRON_FUEL_NAMES } = require('./config')
const { starterHutMaterials } = require('./starter-hut-materials')

function createConstruction(runtimeState, features) {
  const stationBlockedSteps = new Map()

  async function gatherStationStone(count, ready, exact = null) {
    if (!features.hasTool('pickaxe')) {
      if (features.plankCount() + features.inventoryCount(LOG_NAMES) * 4 < 9) await features.collectWoodWithPlan(null, Math.ceil((9 - features.plankCount()) / 4))
      if (ready()) await features.prepareStarterGear()
    } else if (runtimeState.mineNeedsNewGround) {
      runtimeState.mineNeedsNewGround = false
      await features.exploreOneStep()
    } else if (ready()) {
      await features.mineForGear(null, 'stone', null, { stoneLimit: count, stoneDrop: exact })
    }
  }

  async function supplyStationMaterials(connection, materials, ready) {
    for (const [block, count] of Object.entries(materials)) {
      if (!count || ['planks', 'chest', 'furnace', 'torch', 'crafting_table'].includes(block) || features.inventoryItemCount(block) >= count) continue
      const logName = block.replace(/_planks$/, '_log')
      if (block.endsWith('_planks') && LOG_NAMES.has(logName)) {
        const logCount = Math.ceil((count - features.inventoryItemCount(block)) / 4)
        if (features.inventoryItemCount(logName) < logCount) {
          await features.collectWoodWithPlan(null, logCount, new Set([logName]))
          return false
        }
        if (!await features.makePlanksFor(count, block) || !ready()) return false
      } else if (STONE_DROPS.has(block)) {
        await gatherStationStone(count, ready, block)
        return false
      } else {
        features.log('structure material unavailable', { block, missing: count - features.inventoryItemCount(block) })
        return false
      }
    }
    const chestNeeded = materials.chest && !features.inventoryItemCount('chest')
    const furnaceNeeded = materials.furnace && !features.inventoryItemCount('furnace')
    const torchNeeded = materials.torch > features.inventoryItemCount('torch')
    const tableNeeded = materials.crafting_table && !features.inventoryItemCount('crafting_table')
    if (furnaceNeeded && features.inventoryCount(STONE_DROPS) < 8) {
      await gatherStationStone(8, ready)
      return false
    }

    const planks = (materials.planks ?? 0) + (chestNeeded ? 8 : 0) +
      (chestNeeded || furnaceNeeded || tableNeeded ? 4 : 0) + (torchNeeded ? 3 : 0)
    if (features.plankCount() + features.inventoryCount(LOG_NAMES) * 4 < planks) {
      await features.collectWoodWithPlan(null, Math.ceil((planks - features.plankCount()) / 4))
      return false
    }
    if (!await features.makePlanksFor(planks) || !ready()) return false

    if (chestNeeded || furnaceNeeded) {
      try {
        const table = await features.ensureCraftingTable()
        if (!table || !ready()) return false
        if (chestNeeded && !await features.craftNamed('chest', table)) return false
        if (furnaceNeeded && (!ready() || !await features.craftNamed('furnace', table))) return false
      } finally {
        await features.reclaimTemporaryCraftingTable()
      }
    }
    if (torchNeeded && ready()) {
      if (!features.inventoryCount(IRON_FUEL_NAMES)) {
        if (!features.inventoryCount(LOG_NAMES)) {
          await features.collectWoodWithPlan(null, 1)
          return false
        }
        await features.processFurnaceBatch(LOG_NAMES, 'supply station charcoal ready', 16000,
          item => item.name.endsWith('_planks'), 1)
      }
      if (!ready()) return false
      if (!features.inventoryItemCount('stick') && !await features.craftNamed('stick')) return false
      if (!await features.craftNamed('torch')) return false
    }
    if (tableNeeded && !features.inventoryItemCount('crafting_table') && !await features.craftNamed('crafting_table')) return false
    return connection === runtimeState.bot && ready() && Object.entries(materials).every(([block, count]) =>
      (block === 'planks' ? features.plankCount() : features.inventoryItemCount(block)) >= count)
  }

  async function buildSupplyStation() {
    const connection = runtimeState.bot
    const ready = () => features.canWorkHere(connection) && !features.foodRecoveryNeeded(connection) &&
      !features.closeCombatPlan() && !features.damageInterruptActive(connection) && Date.now() >= runtimeState.retreatUntil
    if (!ready()) return
    runtimeState.lastDecision = runtimeState.supplyStation.schematic || runtimeState.supplyStation.hut ? 'build-structure' : 'build-camp'
    const constructionMovement = new Movements(connection)
    constructionMovement.canDig = false
    constructionMovement.scafoldingBlocks = []
    constructionMovement.allow1by1towers = false
    constructionMovement.allowParkour = false
    constructionMovement.maxDropDown = 2
    const now = Date.now()
    for (const [key, until] of stationBlockedSteps) {
      if (until <= now) stationBlockedSteps.delete(key)
    }
    constructionMovement.exclusionAreasStep.push(block => {
      if (!block?.position) return 0
      const key = `${block.position.x},${block.position.z}`
      return features.isWaterBlock(block) || stationBlockedSteps.has(key) ? 100 : 0
    })
    const walk = async (goal, timeout) => {
      if (!ready()) return false
      const target = goal.pos ?? goal
      if ([target.x, target.y, target.z].every(Number.isFinite)) {
        runtimeState.navigationState = { target: { x: target.x, y: target.y, z: target.z }, waypoints: [], label: 'build-structure' }
      }
      connection.pathfinder.setMovements(constructionMovement)
      let lastPosition = connection.entity.position.clone()
      let lastProgress = Date.now()
      const watch = setInterval(() => {
        if (connection.pathfinder.goal !== goal) return
        if (!ready()) {
          connection.pathfinder.setGoal(null)
          return
        }
        const current = connection.entity.position
        if (lastPosition.distanceTo(current) >= 0.4) {
          lastPosition = current.clone()
          lastProgress = Date.now()
          return
        }
        if (Date.now() - lastProgress < 2700) return
        const feet = current.floored()
        const next = features.visibleNavigationState().waypoints.map(point => new Vec3(point.x, point.y, point.z).floored())
          .find(point => point.distanceTo(feet) <= 2 && (point.x !== feet.x || point.z !== feet.z))
        if (!next) return
        stationBlockedSteps.set(`${next.x},${next.z}`, Date.now() + 30000)
        features.log('supply station route replanned', { from: feet, blockedStep: next })
        connection.pathfinder.setGoal(null)
      }, 100)
      try {
        await features.gotoWithTimeout(goal, 'supply station movement', timeout)
        return ready()
      } catch {
        return false
      } finally {
        clearInterval(watch)
        if (connection === runtimeState.bot) connection.pathfinder.setMovements(runtimeState.movements)
      }
    }
    let disconnected
    const connectionEnded = new Promise(resolve => { disconnected = resolve })
    connection.once('end', disconnected)
    try {
      await Promise.race([connectionEnded, runtimeState.supplyStation.step(connection, { ready, walk, log: features.log, explore: features.exploreOneStep,
        materials: async (materials, hutSite) => {
          const remaining = hutSite ? await starterHutMaterials(connection, materials, {
            ready, walk, log: features.log, explore: features.exploreOneStep,
            phase: phase => { runtimeState.supplyStation.phase = phase },
            protected: position => runtimeState.supplyStation.protects(connection, position),
          }, features) : materials
          return remaining ? supplyStationMaterials(connection, remaining, ready) : false
        }, dig: features.digWithExposure })])
    } catch (error) {
      features.log('supply station step interrupted', { ...runtimeState.supplyStation.status(), message: error.message })
    } finally {
      connection.removeListener('end', disconnected)
      if (!ready() && !runtimeState.mineMode) runtimeState.supplyStation.interrupt(features.log, 'survival priority')
    }
  }

  return {
    buildSupplyStation,
  }
}

module.exports = createConstruction
