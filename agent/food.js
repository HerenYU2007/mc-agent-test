const { goals } = require('mineflayer-pathfinder')
const { FOOD_RECOVERY_START, LOG_NAMES, RANGED_HOSTILES } = require('./config')

const FOOD_RECOVERY_END = 14
const SURFACE_FOOD_TARGET = 8
const HARMFUL_FOODS = new Set(['pufferfish', 'spider_eye', 'poisonous_potato', 'chorus_fruit', 'suspicious_stew'])
const PASSIVE_FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const RAW_MEAT_NAMES = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'potato'])
const VILLAGE_FOOD_BLOCKS = new Set(['wheat', 'hay_block'])

function createFood(runtimeState, features) {
  function getEdibleFoods() {
    if (!runtimeState.bot?.inventory) return []
    return runtimeState.bot.inventory.items().filter(item => {
      if (!item || item.count <= 0) return false
      if (HARMFUL_FOODS.has(item.name)) return false
      if (item.name === 'rotten_flesh' && runtimeState.bot.food > 4) return false
      return Boolean(runtimeState.mcData?.foodsByName?.[item.name])
    })
  }

  function foodRecoveryNeeded(connection = runtimeState.bot) {
    if (connection !== runtimeState.bot || !Number.isFinite(connection?.food)) return false
    if (connection.food <= FOOD_RECOVERY_START) runtimeState.recoveringFood = true
    if (connection.food >= FOOD_RECOVERY_END) runtimeState.recoveringFood = false
    return runtimeState.recoveringFood
  }

  function monitorFood(connection = runtimeState.bot) {
    if (!runtimeState.botEnabled || !connection?.entity || connection.health <= 0 || !runtimeState.movements ||
        !foodRecoveryNeeded(connection) || features.waterOwnsMovement() || runtimeState.emergencyRetreating || runtimeState.fleeingActive ||
        runtimeState.isEating || runtimeState.isSmelting || runtimeState.shelterBusy || runtimeState.emergencyShelteredUntil || runtimeState.shelteredUntilDawn ||
        features.damageInterruptActive(connection)) return
    if (runtimeState.mineBusy && !runtimeState.miningPausedForFood) {
      runtimeState.miningPausedForFood = true
      features.log('mining paused for food', { food: connection.food, target: runtimeState.currentMineTarget })
      features.stopPathfinder()
      if (connection.targetDigBlock) connection.stopDigging()
    }
    if (!runtimeState.busy && !runtimeState.mineBusy && Date.now() >= runtimeState.nextFoodSearchAt) void features.decideAndAct('food-urgent')
  }

  async function recoverFoodSupply() {
    const connection = runtimeState.bot
    runtimeState.lastDecision = 'hunt-food'
    features.log('food recovery priority', { food: connection.food, target: runtimeState.committedMineTarget?.position ?? null })
    if (!foodReserve() && await runtimeState.supplyBase.recoverFood(connection) && !foodRecoveryNeeded(connection)) {
      features.log('food recovery complete', { food: connection.food, source: 'supply-base' })
      return
    }
    if (!await huntNearbyAnimalsOrForage() && foodRecoveryNeeded(connection) &&
        features.canWorkHere(connection) && !features.closeCombatPlan()) {
      if (features.nightShelterTerrain() === 'covered') {
        await approachFoodSurface(connection)
      } else {
        await features.exploreOneStep()
      }
    }
    if (features.canWorkHere(connection) && !foodRecoveryNeeded(connection)) {
      features.log('food recovery complete', { food: connection.food, target: runtimeState.committedMineTarget?.position ?? null })
    }
  }

  function safeToEatOnRetreat(connection) {
    return connection === runtimeState.bot && connection?.entity && connection.health > 0 && !features.waterOwnsMovement() &&
      !features.nearbyThreatSignature().threats.some(({ id, distance, name }) => distance < 7 ||
        (distance < (RANGED_HOSTILES.has(name) ? 17 : 11) && connection.entities[id] && features.hostileSight(connection.entities[id]).visible))
  }

  async function eatFoodIfNeeded({ retreat = false, moving = false } = {}) {
    const connection = runtimeState.bot
    if (!connection?.entity || runtimeState.isEating || runtimeState.isDiggingBlock || runtimeState.isSmelting ||
        (!retreat && (runtimeState.emergencyRetreating || runtimeState.fleeingActive)) || (retreat && !safeToEatOnRetreat(connection)) ||
        (runtimeState.meleeConnection === connection && !(retreat && runtimeState.fleeingActive)) ||
        runtimeState.raisedShields.has(connection) || runtimeState.impactGuards.has(connection)) return false
    const currentFood = Number(connection.food ?? 20)
    const currentHealth = Number(connection.health ?? 20)
    if (currentFood >= 18 && currentHealth >= 20) return false

    const restorative = item => /^(enchanted_)?golden_apple$/.test(item.name)
    const foods = getEdibleFoods().filter(item => currentFood < 20 || (retreat && currentHealth < 20 && restorative(item)))
    if (foods.length === 0) return false

    foods.sort((a, b) => {
      const fa = runtimeState.mcData?.foodsByName?.[a.name] || {}
      const fb = runtimeState.mcData?.foodsByName?.[b.name] || {}
      const cookedA = a.name.startsWith('cooked_') ? 10 : 0
      const cookedB = b.name.startsWith('cooked_') ? 10 : 0
      if (retreat && currentHealth <= 8 && restorative(a) !== restorative(b)) return restorative(a) ? -1 : 1
      return (cookedB + (fb.foodPoints || 0)) - (cookedA + (fa.foodPoints || 0))
    })

    const food = foods[0]
    runtimeState.isEating = true
    let safetyWatch
    let onHurt
    try {
      if (!moving) features.stopPathfinder()
      await connection.equip(food, 'hand')
      if (connection !== runtimeState.bot || (retreat && !safeToEatOnRetreat(connection))) return false
      features.log(retreat ? moving ? 'retreat food while moving' : 'retreat food stop' : 'eating food',
        { item: food.name, currentFood, health: currentHealth })
      if (retreat) {
        const danger = new Promise((_, reject) => {
          const cancel = () => {
            if (connection === runtimeState.bot) connection.deactivateItem()
            reject(new Error('追兵靠近，停止进食'))
          }
          onHurt = entity => { if (entity?.id === connection.entity?.id) cancel() }
          connection.on('entityHurt', onHurt)
          safetyWatch = setInterval(() => { if (!safeToEatOnRetreat(connection)) cancel() }, 75)
        })
        await Promise.race([connection.consume(), danger])
      } else await connection.consume()
      features.log('food consumed successfully', { item: food.name, newFood: connection.food, newHealth: connection.health, retreat, moving })
      return true
    } catch (error) {
      features.log('eating failed', { item: food.name, message: error.message })
      return false
    } finally {
      clearInterval(safetyWatch)
      if (onHurt) connection.removeListener('entityHurt', onHurt)
      runtimeState.isEating = false
    }
  }

  async function restAfterRetreat(connection) {
    if (connection.health >= 20 || !safeToEatOnRetreat(connection)) return
    features.lowerCombatShield(connection)
    const ate = await eatFoodIfNeeded({ retreat: true })
    if (ate || connection.food >= 18) {
      const deadline = Date.now() + 4500
      while (Date.now() < deadline && connection.health < 20 && safeToEatOnRetreat(connection)) {
        await new Promise(resolve => setTimeout(resolve, 150))
      }
    }
  }

  async function cookRawMeatInFurnace() {
    return features.processFurnaceBatch(RAW_MEAT_NAMES, 'collected cooked food from furnace', 30000)
  }

  function findNearestPassiveAnimal(maxDistance = 36) {
    if (!runtimeState.bot?.entity) return null
    const origin = runtimeState.bot.entity.position
    let nearest = null
    let bestDist = maxDistance
    for (const entity of Object.values(runtimeState.bot.entities)) {
      if (!entity || !entity.position) continue
      const name = String(entity.name || entity.displayName || '').toLowerCase().replaceAll(' ', '_')
      if (!PASSIVE_FOOD_ANIMALS.has(name)) continue
      const dist = entity.position.distanceTo(origin)
      if (dist < bestDist) {
        bestDist = dist
        nearest = entity
      }
    }
    return nearest
  }

  async function forageVillageBread() {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection) || features.closeCombatPlan()) return false
    let progress = false
    if (features.inventoryItemCount('hay_block') > 0) progress = await features.craftNamed('wheat')
    if (features.inventoryItemCount('wheat') < 3) {
      const crops = connection.findBlocks({ maxDistance: 28, count: 16,
        matching: block => block.name === 'hay_block' || (block.name === 'wheat' && Number(block.getProperties().age) === 7) })
      for (const position of crops.slice(0, 4)) {
        if (!features.canWorkHere(connection) || features.closeCombatPlan() || features.inventoryItemCount('wheat') >= 3) break
        const crop = connection.blockAt(position)
        if (!crop || !VILLAGE_FOOD_BLOCKS.has(crop.name) ||
            (crop.name === 'wheat' && Number(crop.getProperties().age) !== 7)) continue
        try {
          if (!connection.canDigBlock(crop) || !connection.canSeeBlock(crop)) {
            await features.gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world, { reach: 4.2 }), 'village crop path', 5000)
          }
          const drops = new Set([crop.name])
          const before = features.inventoryCount(drops)
          if (!features.canWorkHere(connection) || features.closeCombatPlan() || !await features.digWithExposure(crop, VILLAGE_FOOD_BLOCKS)) continue
          progress = (await features.pickUpBlockDrop(drops, position, before)) || progress
          if (crop.name === 'hay_block' && features.inventoryItemCount('hay_block')) progress = (await features.craftNamed('wheat')) || progress
          features.log('village crop harvested', { item: crop.name, position })
        } catch (error) {
          features.log('village crop unreachable', { position, message: error.message })
        }
      }
    }
    if (features.inventoryItemCount('wheat') < 3 || !features.canWorkHere(connection) || features.closeCombatPlan()) return progress
    try {
      const table = await features.ensureCraftingTable()
      if (!table) return progress
      while (features.canWorkHere(connection) && !features.closeCombatPlan() && features.inventoryItemCount('wheat') >= 3 &&
             features.inventoryItemCount('bread') < SURFACE_FOOD_TARGET) {
        if (!await features.craftNamed('bread', table)) break
        progress = true
      }
    } finally {
      await features.reclaimTemporaryCraftingTable()
    }
    return progress
  }

  function foodReserve() {
    return getEdibleFoods().reduce((count, item) => count + (item.name === 'rotten_flesh' ? 0 : item.count), 0)
  }

  async function approachFoodSurface(connection) {
    if (!features.canWorkHere(connection) || features.closeCombatPlan() || connection.game?.dimension !== 'overworld') return
    const feet = connection.entity.position.floored()
    if (features.openSurfaceAt(connection, feet)) return

    runtimeState.lastDecision = 'surface-resupply'
    const known = runtimeState.lastDrySurface?.dimension === connection.game.dimension && runtimeState.lastDrySurface.feet.distanceTo(feet) <= 82
      ? runtimeState.lastDrySurface.feet : null
    features.log('food surface route started', { from: feet, knownSurface: known })
    runtimeState.surfaceRouteActive = true
    try {
      if (known) {
        await features.gotoWithTimeout(new goals.GoalBlock(known.x, known.y, known.z), 'resupply known surface', 15000).catch(() => {})
      }
      for (const rise of [8, 4, 2]) {
        if (!features.canWorkHere(connection) || features.closeCombatPlan()) return
        const currentFeet = connection.entity.position.floored()
        if (features.openSurfaceAt(connection, currentFeet)) break
        const maxY = connection.game.minY + connection.game.height - 2
        const goalY = Math.min(currentFeet.y + rise, maxY)
        if (goalY <= currentFeet.y) break
        const reached = await features.gotoWithTimeout(new goals.GoalY(goalY), 'resupply climb towards open sky', 14000)
          .then(() => true, () => false)
        if (reached || !features.canWorkHere(connection) || connection.entity.position.floored().y > currentFeet.y) break
      }
      if (features.canWorkHere(connection) && features.openSurfaceAt(connection, connection.entity.position.floored())) {
        features.log('food surface reached', { position: connection.entity.position.floored() })
      }
    } finally {
      runtimeState.surfaceRouteActive = false
    }
  }

  async function surfaceResupply() {
    const connection = runtimeState.bot
    await eatFoodIfNeeded()
    if (!features.canWorkHere(connection) || features.closeCombatPlan()) return
    const feet = connection.entity.position.floored()
    if (!features.openSurfaceAt(connection, feet)) {
      await approachFoodSurface(connection)
      return
    }
    runtimeState.lastDecision = 'hunt-food'
    if (foodReserve() < SURFACE_FOOD_TARGET && !await huntNearbyAnimalsOrForage({ stockUp: true }) &&
        features.canWorkHere(connection) && !features.closeCombatPlan()) await features.exploreOneStep()
    const foodItems = foodReserve()
    if (features.canWorkHere(connection) && !features.closeCombatPlan() && foodItems >= SURFACE_FOOD_TARGET &&
        features.openSurfaceAt(connection, connection.entity.position.floored()) && runtimeState.supplyBase.completeResupply()) {
      const { diamonds } = runtimeState.supplyBase.qualification()
      features.log('surface resupply complete', { foodItems, diamonds })
      features.log('supply base unlocked after resupply', { foodItems, diamonds })
    }
  }

  async function huntNearbyAnimalsOrForage({ stockUp = false } = {}) {
    if (!runtimeState.bot?.entity || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false

    if (!stockUp && await eatFoodIfNeeded()) return true

    if (await forageVillageBread()) {
      await eatFoodIfNeeded()
      return true
    }

    const hasRaw = runtimeState.bot.inventory.items().some(item => RAW_MEAT_NAMES.has(item.name))
    if (hasRaw && !stockUp) {
      await cookRawMeatInFurnace()
      if (await eatFoodIfNeeded()) return true
    }

    const animal = findNearestPassiveAnimal(36)
    if (animal) {
      const animalName = String(animal.name || animal.displayName || 'animal').toLowerCase()
      features.log('hunting passive animal for food', { animal: animalName, position: animal.position, distance: Number(animal.position.distanceTo(runtimeState.bot.entity.position).toFixed(1)) })
      await features.equipCombatItem()

      const chaseDeadline = Date.now() + 15000
      while (Date.now() < chaseDeadline && runtimeState.bot.entities[animal.id] && features.canWorkHere(runtimeState.bot) && !runtimeState.emergencyRetreating) {
        const dist = animal.position.distanceTo(runtimeState.bot.entity.position)
        if (dist <= 3.2) {
          try {
            await runtimeState.bot.lookAt(animal.position.offset(0, (animal.height || 1) * 0.5, 0), true)
            runtimeState.bot.attack(animal)
          } catch {}
        } else {
          try {
            await features.gotoWithTimeout(new goals.GoalFollow(animal, 2.0), 'hunt chase', 2500)
          } catch {}
        }
        await new Promise(resolve => setTimeout(resolve, 300))
      }

      await features.collectNearbyDrops(16)

      const woolCount = runtimeState.bot.inventory.items().filter(i => i.name.endsWith('_wool')).reduce((sum, i) => sum + i.count, 0)
      if (woolCount >= 3 && features.inventoryItemCount('white_bed') === 0 && (features.plankCount() >= 3 || features.inventoryCount(LOG_NAMES) >= 1)) {
        if (features.plankCount() < 3) await features.makePlanksFor(3)
        const table = await features.ensureCraftingTable()
        if (table) {
          const bedItem = runtimeState.bot.inventory.items().find(i => i.name.endsWith('_wool'))
          const bedColor = bedItem?.name?.split('_')?.[0] || 'white'
          await features.craftNamed(`${bedColor}_bed`, table)
          await features.reclaimTemporaryCraftingTable()
        }
      }

      await eatFoodIfNeeded()
      return true
    }

    return false
  }

  return {
    getEdibleFoods,
    foodRecoveryNeeded,
    monitorFood,
    recoverFoodSupply,
    safeToEatOnRetreat,
    eatFoodIfNeeded,
    restAfterRetreat,
    cookRawMeatInFurnace,
    foodReserve,
    approachFoodSurface,
    surfaceResupply,
    huntNearbyAnimalsOrForage,
  }
}

module.exports = createFood
