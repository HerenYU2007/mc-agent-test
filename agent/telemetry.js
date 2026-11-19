const { USERNAME, THREAT_RADIUS, STONE_DROPS, LOG_NAMES, IRON_INPUT_NAMES } = require('./config')
const { VILLAGE_ACTIONS } = require('./expedition-village')
const BOW_ACTIONS = { 'draw-bow': '拉弓瞄准', 'shoot-bow': '放箭' }
const { FARM_LABELS } = require('./base-farm')

function createTelemetry(runtimeState, features) {
  function observerItem(item) {
    if (!item?.name || item.count <= 0) return null
    return { id: item.name.includes(':') ? item.name : `minecraft:${item.name}`,
      count: item.count, damage: item.durabilityUsed ?? 0, enchanted: Boolean(item.enchants?.length) }
  }

  function observerState() {
    const connection = runtimeState.bot
    const status = { username: USERNAME, connected: Boolean(connection?.entity), modelEnabled: runtimeState.modelEnabled }
    if (!status.connected) return status
    const inventory = connection.inventory
    const getEquipment = destination => observerItem(inventory.slots[connection.getEquipmentDestSlot(destination)])
    const lastCall = runtimeState.modelCalls.findLast(call => call.status === 'ok')
    const model = runtimeState.lastModelDecision
    const waiting = runtimeState.modelCalls.at(-1)?.status === 'pending' ? '已启用，正在决策' : '已启用，等待决策'
    const action = runtimeState.fleeingActive && runtimeState.isEating ? '撤离中进食' :
      runtimeState.lastDecision === 'combat-resume' ? '脱战恢复原任务' : runtimeState.lastDecision
    const visiting = runtimeState.supplyBase.status().expedition?.phase === 'visiting'
    const hut = runtimeState.supplyStation.hut && runtimeState.supplyStation.status()
    const hutAction = hut && (action === 'build-structure' || (action === 'explore' && runtimeState.supplyStation.pending))
    const audit = runtimeState.lastMineAudit?.cycle === runtimeState.currentMineOrder?.cycle && runtimeState.lastMineAudit?.target === runtimeState.currentMineOrder?.target
      ? runtimeState.lastMineAudit : null
    return { ...status, position: connection.entity.position.floored(), health: connection.health, food: connection.food,
      freeSlots: features.freeBackpackSlots(inventory), foodRecovery: runtimeState.recoveringFood,
      action: hutAction ? hut.phase : VILLAGE_ACTIONS[action] || FARM_LABELS[action] || BOW_ACTIONS[action] || action,
      shieldRaised: runtimeState.raisedShields.has(connection), navigation: features.visibleNavigationState(), mineTarget: runtimeState.currentMineTarget,
      mineOrder: runtimeState.mineMode ? runtimeState.currentMineOrder?.target : null, committedMineTarget: runtimeState.committedMineTarget?.position,
      actual: audit?.actual, mineResult: audit?.result,
      combatReason: hutAction ? `生存小屋 · ${hut.phase} · ${hut.placed}/${hut.total} 格` :
        visiting && VILLAGE_ACTIONS[action] ? null : runtimeState.lastCombatDecision?.reason,
      modelAction: VILLAGE_ACTIONS[model?.action] || model?.action || (runtimeState.modelEnabled ? waiting : null),
      modelReason: model?.reason,
      tokens: { total: runtimeState.modelUsage.totalTokens, input: lastCall?.promptTokens, output: lastCall?.completionTokens },
      resupply: runtimeState.supplyBase.resupplyStatus(),
      inventory: {
        backpack: inventory.slots.slice(inventory.inventoryStart, inventory.hotbarStart).map(observerItem),
        hotbar: inventory.slots.slice(inventory.hotbarStart, inventory.inventoryEnd).map(observerItem),
        selected: connection.quickBarSlot,
        armor: ['head', 'torso', 'legs', 'feet'].map(getEquipment),
        offhand: getEquipment('off-hand'),
      },
    }
  }

  function snapshot() {
    const entities = Object.values(runtimeState.bot.entities || {})
      .filter(entity => entity !== runtimeState.bot.entity && entity.position)
      .map(entity => {
        const name = features.entityNameOf(entity)
        return {
          id: entity.id,
          name,
          hostile: features.isHostileEntity(entity),
          position: entity.position.floored(),
          distance: Number(entity.position.distanceTo(runtimeState.bot.entity.position).toFixed(1)),
        }
      })
      .filter(entity => entity.distance <= THREAT_RADIUS)
      .sort((a, b) => a.distance - b.distance)

    const blockSurvey = features.surveyNearbyBlocks(6)
    return {
      cycle: runtimeState.cycle,
      position: runtimeState.bot.entity.position.floored(),
      health: runtimeState.bot.health,
      food: runtimeState.bot.food,
      oxygen: runtimeState.bot.oxygenLevel,
      inWater: Boolean(runtimeState.bot.entity.isInWater),
      night: runtimeState.bot.time.timeOfDay >= 12500 && runtimeState.bot.time.timeOfDay <= 23500,
      timeOfDay: runtimeState.bot.time.timeOfDay,
      logs: features.inventoryCount(LOG_NAMES),
      planks: features.inventoryCount(new Set(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks'])),
      sticks: features.inventoryCount(new Set(['stick'])),
      hasTable: features.inventoryCount(new Set(['crafting_table'])) > 0 || Boolean(features.findNearestBlock(new Set(['crafting_table']), 12)),
      hasPickaxe: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe')),
      hasAxe: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_axe')),
      hasSword: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_sword')),
      hasShield: features.inventoryCount(new Set(['shield'])) > 0 || runtimeState.bot.inventory.slots.some(item => item?.name === 'shield'),
      armorPieces: features.equippedArmorCount(),
      iron: features.inventoryItemCount('iron_ingot') + features.inventoryCount(IRON_INPUT_NAMES),
      rawIron: features.inventoryCount(IRON_INPUT_NAMES),
      torches: features.inventoryCount(new Set(['torch'])),
      underground: features.isUndergroundNow(),
      mining_underground: features.miningUnderground(),
      nightShelterTerrain: features.nightShelterTerrain(),
      cobblestone: features.inventoryCount(STONE_DROPS),
      coal: features.inventoryItemCount('coal'),
      charcoal: features.inventoryItemCount('charcoal'),
      hasBed: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_bed')),
      hasIronPickaxe: runtimeState.bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)),
      nearbyBlocks: blockSurvey,
      nearbyEntities: entities.slice(0, 8),
    }
  }

  return {
    observerState,
    snapshot,
  }
}

module.exports = createTelemetry
