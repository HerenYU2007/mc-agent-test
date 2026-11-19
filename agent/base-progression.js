const path = require('node:path')
const { Movements } = require('mineflayer-pathfinder')
const { createSupplyBase } = require('../supply-base')
const { createVillageExpedition } = require('./expedition')
const { PROJECT_ROOT, HOST, PORT, USERNAME, LOG_NAMES, IRON_FUEL_NAMES } = require('./config')

const POST_ARMOR_DIAMONDS = 10

function createBaseProgression(runtimeState, features) {
  function initializeSupplyBase() {
    const api = {
      statePath: process.env.MC_BASE_STATE_PATH || path.join(PROJECT_ROOT, 'supply-base-state.json'),
      world: JSON.stringify([HOST, PORT, USERNAME]),
      diamondTarget: POST_ARMOR_DIAMONDS,
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
    api.expedition = createVillageExpedition({
      ...api,
      statePath: process.env.MC_EXPEDITION_STATE_PATH || `${api.statePath}.expedition.jsonl`,
      acquireBed: async () => {
        if (await features.acquireShelterBed()) return true
        if (api.safe(runtimeState.bot)) await features.exploreOneStep()
        return false
      },
      regear: async () => {
        await features.craftAvailableGear()
        await features.autoEquipArmor()
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
      travel: async (connection, goal, label, timeout) => {
        const walking = new Movements(connection)
        walking.canDig = false
        walking.allow1by1towers = false
        walking.allowParkour = false
        walking.maxDropDown = 2
        walking.scafoldingBlocks = []
        connection.pathfinder.setMovements(walking)
        try { await api.goto(goal, label, timeout) }
        finally { if (connection === runtimeState.bot) connection.pathfinder.setMovements(runtimeState.movements) }
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
