const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { STONE_DROPS, RUBBLE, SOIL, ARMOR_SLOTS, ARMOR_DEFENSE } = require('./config')

const DEBRIS = new Set(['leaf_litter', 'short_grass', 'dead_bush'])
const INVENTORY_RESERVES = [[RUBBLE, 64], [SOIL, 32]]
const TOOL_TIER = { wooden: 0, golden: 0, stone: 1, copper: 2, iron: 3, diamond: 4, netherite: 5 }

function createInventory(runtimeState, features) {
  let inventoryFullNoticeAt = 0

  function inventoryCount(names) {
    const allowed = names instanceof Set ? names : new Set(names)
    return runtimeState.bot.inventory.items()
      .filter(item => allowed.has(item.name))
      .reduce((sum, item) => sum + item.count, 0)
  }

  function findNearbyDrops(maxDistance = 16) {
    return Object.values(runtimeState.bot.entities || {})
      .filter(entity => entity !== runtimeState.bot.entity && entity.position && !runtimeState.discardedEntities.has(entity))
      .filter(entity => ['item', 'item_stack'].includes(String(entity.name || entity.type || '').toLowerCase()))
      .map(entity => ({ entity, distance: entity.position.distanceTo(runtimeState.bot.entity.position) }))
      .filter(item => item.distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance)
  }

  function inventoryItemCount(name) {
    return runtimeState.bot.inventory.items()
      .filter(item => item.name === name)
      .reduce((sum, item) => sum + item.count, 0)
  }

  function backpackSlots(window) {
    return window.slots.slice(window.inventoryStart, window.inventoryEnd)
  }

  function freeBackpackSlots(window) {
    return backpackSlots(window).filter(item => !item).length
  }

  function discardCandidates(connection, window, keep) {
    const items = backpackSlots(window).filter(Boolean)
    const toolStone = items.reduce((sum, item) => sum + (STONE_DROPS.has(item.name) ? item.count : 0), 0)
    const heldSlot = window.hotbarStart + connection.quickBarSlot
    const reserves = INVENTORY_RESERVES.map(([names, minimum]) => ({ names, minimum,
      count: items.reduce((total, item) => total + (names.has(item.name) ? item.count : 0), 0) }))
    const equipment = connection.inventory.slots.filter(Boolean)
    const reservingBaseGear = runtimeState.supplyBase.active(connection)
    const obsolete = item => {
      if (item.enchants?.length || (reservingBaseGear && runtimeState.supplyBase.keeps(item))) return false
      const [material, type] = item.name.split('_')
      const armorIndex = ARMOR_SLOTS.findIndex(([, kind]) => kind === type)
      if (armorIndex >= 0 && ARMOR_DEFENSE[material]) {
        const worn = connection.inventory.slots[connection.getEquipmentDestSlot(ARMOR_SLOTS[armorIndex][0])]
        return features.toolDurability(worn) > 16 && features.armorScore(worn, armorIndex) > features.armorScore(item, armorIndex)
      }
      const tier = TOOL_TIER[material]
      if (tier === undefined || !['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].includes(type)) return false
      return equipment.some(other => other.name.endsWith(`_${type}`) &&
        TOOL_TIER[other.name.split('_')[0]] > tier && features.toolDurability(other) > 16)
    }
    return items.filter(item => !keep.has(item.name) && item.slot !== heldSlot)
      .flatMap(item => {
        if (DEBRIS.has(item.name)) return [{ item, priority: 0 }]
        if (obsolete(item)) return [{ item, priority: 1 }]
        const reserve = reserves.find(entry => entry.names.has(item.name))
        if (reserve && reserve.count - item.count >= reserve.minimum &&
            (!STONE_DROPS.has(item.name) || toolStone - item.count >= 32)) return [{ item, priority: 2 }]
        return []
      }).sort((a, b) => a.priority - b.priority || a.item.count - b.item.count)
  }

  function droppedStack(entity) {
    try { return entity.getDroppedItem() } catch { return null }
  }

  function aimAwayFromWork(connection) {
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const work = runtimeState.currentMineTarget || runtimeState.committedMineTarget?.position || runtimeState.navigationState.target
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => {
      const ray = new Vec3(x, 0, z)
      const hit = connection.world.raycast(eyes, ray, 3)
      const open = hit?.intersect?.distanceTo(eyes) ?? 3
      const away = work ? -Math.sign((work.x - eyes.x) * x + (work.z - eyes.z) * z) : 0
      return { ray, open, score: open + away * 0.35 }
    }).sort((a, b) => b.score - a.score)
    return directions[0].open >= 0.8 ? eyes.plus(directions[0].ray.scaled(2)) : null
  }

  function discardTileCost(connection, block) {
    const position = block?.position
    const pile = runtimeState.discardPiles.get(connection)
    if (!position || !pile?.size) return 0
    for (const item of pile) {
      if (item.position && Math.abs(item.position.y - position.y) < 1.4 &&
          Math.hypot(item.position.x - position.x - 0.5, item.position.z - position.z - 0.5) < 1.05) return 8
    }
    return 0
  }

  async function clearBackpack(connection, reason, { duringMining = false, window = connection.inventory, keep = new Set() } = {}) {
    const originalFree = freeBackpackSlots(window)
    const repicked = runtimeState.repickedDiscards.get(connection)
    if (originalFree >= 2 && !repicked?.size) return originalFree
    const ready = () => features.canWorkHere(connection, duringMining) && !runtimeState.isEating && !runtimeState.isDiggingBlock && !runtimeState.fleeingActive &&
      !features.damageInterruptActive(connection) && !features.closeCombatPlan() && !window.selectedItem &&
      (connection.currentWindow || connection.inventory) === window
    const discarded = []
    for (let attempt = 0; attempt < 3 && ready(); attempt += 1) {
      const candidates = discardCandidates(connection, window, keep)
      const entry = candidates.find(({ item }) => repicked?.has(item.name)) ||
        (originalFree < 2 && freeBackpackSlots(window) < 3 ? candidates[0] : null)
      if (!entry) break
      const { item } = entry
      const nearbyBefore = new Set(findNearbyDrops(4).map(({ entity }) => entity.id))
      try {
        if (!discarded.length) {
          const aim = aimAwayFromWork(connection)
          if (aim) await connection.lookAt(aim, true)
          if (!ready() || window.slots[item.slot] !== item) break
        }
        // Mode 4 with right mouse button discards one whole stack in a single click.
        await connection.clickWindow(item.slot, 1, 4)
        await new Promise(resolve => setTimeout(resolve, 150))
        if (connection !== runtimeState.bot || !connection.entity || (connection.currentWindow || connection.inventory) !== window || window.slots[item.slot]) break
        for (const { entity } of findNearbyDrops(4)) {
          if (!nearbyBefore.has(entity.id) && droppedStack(entity)?.type === item.type) {
            runtimeState.discardedEntities.add(entity)
            runtimeState.discardPiles.get(connection)?.add(entity)
          }
        }
        repicked?.delete(item.name)
        discarded.push({ item: item.name, count: item.count })
      } catch (error) {
        features.log('inventory cleanup interrupted', { reason, item: item.name, message: error.message })
        break
      }
    }
    const freeSlots = freeBackpackSlots(window)
    if (discarded.length) features.log('inventory cleared', { reason, discarded, freeBefore: originalFree, freeAfter: freeSlots })
    else if (freeSlots === 0 && ready() && Date.now() >= inventoryFullNoticeAt) {
      inventoryFullNoticeAt = Date.now() + 15000
      features.log('inventory full; protected items kept', { reason })
    }
    return freeSlots
  }

  async function collectNearbyDrops(maxDistance = 16, maxCount = 6) {
    if (runtimeState.emergencyRetreating || !runtimeState.bot.entity || runtimeState.bot.health <= 0) return 0
    const connection = runtimeState.bot
    await clearBackpack(connection, 'nearby-drops')
    if (connection !== runtimeState.bot || !connection.entity) return 0
    const capped = INVENTORY_RESERVES.filter(([names, minimum]) => inventoryCount(names) >= minimum)
    const drops = findNearbyDrops(maxDistance).filter(({ entity }) => {
      const name = droppedStack(entity)?.name
      return !DEBRIS.has(name) && !capped.some(([names]) => names.has(name))
    }).slice(0, maxCount)
    if (drops.length === 0) return 0
    let collected = 0
    for (const drop of drops) {
      if (!runtimeState.bot.entities[drop.entity.id]) continue
      try {
        await features.gotoWithTimeout(new goals.GoalNearXZ(drop.entity.position.x, drop.entity.position.z, 1.5), 'drop path', 4500)
        await new Promise(resolve => setTimeout(resolve, 450))
        if (!runtimeState.bot.entities[drop.entity.id]) collected += 1
      } catch (error) {
        features.stopPathfinder()
        features.log('drop pickup skipped', { id: drop.entity.id, message: error.message })
      }
    }
    if (collected > 0) features.log('drops collected', { collected })
    return collected
  }

  return {
    inventoryCount,
    findNearbyDrops,
    inventoryItemCount,
    freeBackpackSlots,
    droppedStack,
    discardTileCost,
    clearBackpack,
    collectNearbyDrops,
  }
}

module.exports = createInventory
