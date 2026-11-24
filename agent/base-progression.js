const path = require('node:path')
const { Movements, goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { createSupplyBase } = require('../supply-base')
const { createVillageExpedition } = require('./expedition')
const { createBaseFarm } = require('./base-farm')
const { PROJECT_ROOT, HOST, PORT, USERNAME, LOG_NAMES, IRON_FUEL_NAMES } = require('./config')

const POST_ARMOR_DIAMONDS = 10
const WOOD_DOOR = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_door$/

class ExpeditionMovements extends Movements {
  getBlock(position, dx, dy, dz) {
    const block = super.getBlock(position, dx, dy, dz)
    if (WOOD_DOOR.test(block.name) && block.getProperties().open) {
      block.safe = true
      block.physical = false
      block.replaceable = false
      block.height = block.position.y
    }
    return block
  }
}

function createBaseProgression(runtimeState, features) {
  function initializeSupplyBase() {
    const api = {
      statePath: process.env.MC_BASE_STATE_PATH || path.join(PROJECT_ROOT, 'supply-base-state.json'),
      world: JSON.stringify([HOST, PORT, USERNAME]),
      diamondTarget: POST_ARMOR_DIAMONDS,
      homeOnly: true,
      log: features.log,
      durability: features.toolDurability,
      safe: connection => features.canWorkHere(connection) && !runtimeState.fleeingActive &&
        !features.damageInterruptActive(connection) && !features.closeCombatPlan(),
      openSurface: features.openSurfaceAt,
      goto: features.gotoWithTimeout,
      woodSupply: () => features.plankCount() + features.inventoryCount(LOG_NAMES) * 4,
      planks: features.makePlanksFor,
      craft: features.craftNamed,
      foodReserve: features.foodReserve,
      eat: features.eatFoodIfNeeded,
      forage: () => features.huntNearbyAnimalsOrForage({ stockUp: true }),
      cookFood: features.cookRawMeatInFurnace,
      wood: features.collectWoodWithPlan,
      surface: features.approachFoodSurface,
      explore: features.exploreOneStep,
      smeltIron: () => features.processFurnaceBatch(new Set(['raw_iron']), 'base materials smelted', 95000,
        item => IRON_FUEL_NAMES.has(item.name)),
      starterGear: features.prepareStarterGear,
      mine: async objective => {
        if (runtimeState.mineNeedsNewGround) {
          runtimeState.mineNeedsNewGround = false
          const y = Math.floor(runtimeState.bot.entity.position.y)
          const floor = objective.kind === 'redstone' ? 8 : objective.kind === 'iron' ? 28 : null
          const riseToStone = objective.kind === 'stone' && objective.names[0] === 'cobblestone' &&
            objective.names.length === 1 && y < 8
          if (riseToStone || (floor !== null && y > floor + 2)) {
            const targetY = riseToStone ? Math.min(8, y + 8) : Math.max(floor, y - 8)
            if (await features.prospectMiningLevel(targetY)) return
          }
          if (!features.canWorkHere(runtimeState.bot) || features.closeCombatPlan()) return
          await features.exploreOneStep()
          return
        }
        await features.mineForGear(null, objective.kind, null, { objective })
      },
    }
    const blockedReturnSteps = new WeakMap()
    const travel = async (connection, goal, label, timeout, { returnWaypoint = false, recoverStep = false } = {}) => {
      const origin = returnWaypoint ? connection.entity.position.floored() : null
      const walking = new ExpeditionMovements(connection)
      walking.canDig = false
      walking.allow1by1towers = false
      walking.allowParkour = false
      walking.maxDropDown = 2
      walking.scafoldingBlocks = []
      const blocked = blockedReturnSteps.get(connection)
      if (recoverStep && blocked?.origin.equals(origin) && blocked.until > Date.now()) {
        const neighbors = walking.getNeighbors.bind(walking)
        walking.getNeighbors = node => {
          const candidates = neighbors(node)
          return origin.equals(node) ? candidates.filter(next => !blocked.step.equals(next)) : candidates
        }
      }
      connection.pathfinder.setMovements(walking)
      let firstStep
      let corrections = 0
      const stillAtOrigin = () => connection.entity?.position.floored().equals(origin)
      const rememberFirstStep = result => {
        if (connection.pathfinder.goal !== goal || !stillAtOrigin()) return
        const node = result.path?.find(point => !origin.equals(new Vec3(point.x, point.y, point.z).floored()))
        if (!node || node.toBreak?.length || node.toPlace?.length) return
        const step = new Vec3(node.x, node.y, node.z).floored()
        if (Math.abs(step.y - origin.y) <= 1 && Math.max(Math.abs(step.x - origin.x), Math.abs(step.z - origin.z)) === 1 &&
            !firstStep?.equals(step)) {
          firstStep = step
          corrections = 0
        }
      }
      const onCorrection = () => {
        if (connection.pathfinder.goal !== goal || !firstStep || !stillAtOrigin()) return
        if (++corrections >= 3) connection.pathfinder.setGoal(null)
      }
      if (returnWaypoint) {
        connection.on('path_update', rememberFirstStep)
        connection.on('forcedMove', onCorrection)
      }
      try {
        await api.goto(goal, label, timeout, { allowClutch: !recoverStep })
      } catch (error) {
        if (firstStep && api.safe(connection) && stillAtOrigin()) {
          blockedReturnSteps.set(connection, { origin, step: firstStep, until: Date.now() + 60000 })
          api.log('expedition return first step blocked', { origin, step: firstStep, corrections })
        }
        throw error
      } finally {
        if (returnWaypoint) {
          connection.off('path_update', rememberFirstStep)
          connection.off('forcedMove', onCorrection)
        }
        if (connection === runtimeState.bot) {
          if (connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
          connection.pathfinder.setMovements(runtimeState.movements)
        }
      }
    }
    const work = { ...api, travel, pickup: features.pickUpBlockDrop, equipTool: features.equipBestToolFor }
    api.farm = createBaseFarm({ ...work, showAction: action => { runtimeState.lastDecision = action } })
    api.expedition = createVillageExpedition({
      ...work,
      statePath: process.env.MC_EXPEDITION_STATE_PATH || `${api.statePath}.expedition.jsonl`,
      buildShelter: features.buildSupplyStation,
      regear: async () => {
        await features.craftAvailableGear()
        await features.autoEquipArmor()
      },
      ensureTable: features.ensureCraftingTable,
      reclaimTable: features.reclaimTemporaryCraftingTable,
      showVillageAction: action => { runtimeState.lastDecision = action },
      selectVillage: async (connection, { choices, supplies, resources }) => {
        if (!runtimeState.modelEnabled || !api.safe(connection)) return null
        return (await features.askDeepSeek({
          cycle: runtimeState.cycle, position: connection.entity.position.floored(), health: connection.health,
          hunger: connection.food, supplies, resources, choices,
        }, 'village-visit'))?.action
      },
      selectScout: async (connection, candidates, village) => {
        if (!runtimeState.modelEnabled || !api.safe(connection)) return null
        const snapshot = features.snapshot()
        const decision = await features.askDeepSeek({
          cycle: runtimeState.cycle, position: snapshot.position, health: connection.health, food: connection.food,
          nearbyEntities: snapshot.nearbyEntities, stage: 'village_expedition',
          stageHint: village
            ? '发现村庄迹象。用 explore 从 scoutCandidates 中选一个 X/Z 坐标，优先靠近 villageObservation，再记录路线。'
            : '现在已完成基地和装备整备。用 explore 从 scoutCandidates 中选择一个 X/Z 坐标，寻找村庄，避开水域和障碍。',
          villageObservation: village && { x: village.x, z: village.z },
          scoutCandidates: candidates.map(({ x, z }) => ({ x, z })),
        }, 'expedition-scout')
        if (decision?.action !== 'explore' || !decision.target) return null
        const selected = candidates.find(candidate => candidate.x === decision.target.x && candidate.z === decision.target.z)
        if (selected) features.log('expedition model direction accepted', { position: selected, reason: decision.reason })
        return selected ?? null
      },
    })
    Object.assign(api, { travel, pickup: features.pickUpBlockDrop,
      show: label => { runtimeState.lastDecision = label },
      prospectObsidian: async bot => {
        const y = Math.floor(bot.entity.position.y)
        if (y > -48 && await features.prospectMiningLevel(Math.max(-48, y - 8))) return
        if (api.safe(bot)) await features.exploreOneStep()
      },
      leather: async bot => {
        const cow = bot.nearestEntity(e => ['cow','mooshroom'].includes(e.name) && e.position.distanceTo(bot.entity.position) <= 64)
        if (!cow) return features.exploreOneStep()
        await features.equipCombatItem()
        const end = Date.now() + 10000
        while (api.safe(bot) && cow.isValid && Date.now() < end) {
          if (cow.position.distanceTo(bot.entity.position) > 3) {
            await travel(bot,new goals.GoalFollow(cow,2),'寻找制书皮革',3500).catch(()=>{})
          } else {
            await bot.lookAt(cow.position.offset(0,0.8,0),true)
            if (api.safe(bot)) bot.attack(cow)
            await bot.waitForTicks(14)
          }
        }
        if (api.safe(bot)) await features.collectNearbyDrops(12)
      },
    })
    runtimeState.supplyBase = createSupplyBase(api)
  }

  function needsPostArmorDiamonds(connection) {
    const milestone = runtimeState.supplyBase.qualification()
    return connection.game?.dimension === 'overworld' && !milestone.unlocked &&
      !milestone.needsResupply && features.hasDiamondArmor(connection)
  }

  async function minePostArmorDiamonds() {
    if (runtimeState.mineNeedsNewGround) {
      runtimeState.mineNeedsNewGround = false
      const y = Math.floor(runtimeState.bot.entity.position.y)
      if (y > -48 && await features.prospectMiningLevel(Math.max(-48, y - 8))) return
      if (features.canWorkHere(runtimeState.bot) && !features.closeCombatPlan()) await features.exploreOneStep()
      return
    }
    await features.mineForGear(null, 'diamond')
  }

  return {
    initializeSupplyBase,
    needsPostArmorDiamonds,
    minePostArmorDiamonds,
  }
}

module.exports = createBaseProgression
