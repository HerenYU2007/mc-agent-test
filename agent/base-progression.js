const path = require('node:path')
const { createSupplyBase } = require('../supply-base')
const { PROJECT_ROOT, HOST, PORT, USERNAME, LOG_NAMES, IRON_FUEL_NAMES } = require('./config')

const POST_ARMOR_DIAMONDS = 10

function createBaseProgression(runtimeState, features) {
  function initializeSupplyBase() {
    runtimeState.supplyBase = createSupplyBase({
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
    })
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
