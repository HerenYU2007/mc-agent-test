const {
  STONE_DROPS, STONE_TARGETS, COAL_TARGETS, ARMOR_SLOTS, ARMOR_DEFENSE, LOG_NAMES, TABLE_NAME,
  TABLE_NAMES, IRON_INPUT_NAMES, ORE_SCAN_RADIUS, BLOCK_MINE_RADIUS,
} = require('./config')

function createEquipment(runtimeState, features) {
  function needsCoalForIron(state) {
    if (state.rawIron > 0) return state.coal + state.charcoal === 0
    return !state.hasIronPickaxe && state.iron === 0 && state.coal < 4 && state.charcoal === 0
  }

  function armorScore(item, index) {
    const [material, kind] = item?.name.split('_') ?? []
    const defense = ARMOR_DEFENSE[material]?.[index]
    if (kind !== ARMOR_SLOTS[index][1] || !defense || features.toolDurability(item) <= 0) return -1
    const toughness = material === 'netherite' ? 3 : material === 'diamond' ? 2 : 0
    const protection = item.enchants?.find(enchant => /(^|:)protection$/.test(enchant.name ?? ''))?.lvl ?? 0
    return defense + toughness * 0.35 + protection * 0.6
  }

  async function autoEquipArmor(duringMining = false) {
    const connection = runtimeState.bot
    const safe = () => features.canWorkHere(connection, duringMining) && !connection.currentWindow &&
      !connection.inventory.selectedItem && !runtimeState.isEating && !runtimeState.isDiggingBlock && !runtimeState.fleeingActive && !features.closeCombatPlan()
    if (!safe()) return
    for (const [index, [destination, kind]] of ARMOR_SLOTS.entries()) {
      if (!safe()) return
      const slot = connection.getEquipmentDestSlot(destination)
      const current = connection.inventory.slots[slot]
      const best = connection.inventory.items().filter(item => item.name.endsWith(`_${kind}`) &&
        armorScore(item, index) >= 0 && features.toolDurability(item) > 2)
        .sort((a, b) => armorScore(b, index) - armorScore(a, index) || features.toolDurability(b) - features.toolDurability(a))[0]
      if (!best) continue
      if (armorScore(best, index) < armorScore(current, index) ||
          (armorScore(best, index) === armorScore(current, index) && features.toolDurability(best) <= features.toolDurability(current))) continue
      try {
        await connection.equip(best, destination)
        if (connection.inventory.slots[slot]?.name === best.name) features.log('auto equipped armor', { slot: destination, item: best.name })
      } catch (error) {
        features.log('armor swap deferred', { slot: destination, item: best.name, message: error.message })
      }
    }
  }

  async function ensureWoodAxe() {
    if (!features.canWorkHere(runtimeState.bot) || runtimeState.bot.inventory.items().some(item => item.name.endsWith('_axe'))) return false
    const tablePlanks = features.inventoryItemCount(TABLE_NAME) > 0 || features.findNearestBlock(TABLE_NAMES, 4) ? 0 : 4
    const stickPlanks = features.inventoryItemCount('stick') >= 2 ? 0 : 2
    const required = tablePlanks + stickPlanks + 3
    if (features.plankCount() + features.inventoryCount(LOG_NAMES) * 4 < required || !await features.makePlanksFor(required)) return false
    if (stickPlanks && !await features.craftNamed('stick')) return false
    const table = await features.ensureCraftingTable()
    const crafted = Boolean(table && features.canWorkHere(runtimeState.bot) && await features.craftNamed('wooden_axe', table))
    if (crafted) features.log('early wood axe ready', { axe: 'wooden_axe' })
    return crafted
  }

  function gearUpgrades(tier) {
    const names = new Set(runtimeState.bot.inventory.slots.filter(Boolean).map(item => item.name))
    const acceptedTiers = tier === 'iron' ? ['iron', 'diamond', 'netherite'] : ['diamond', 'netherite']
    const resource = tier === 'iron' ? 'iron_ingot' : 'diamond'
    const label = tier === 'iron' ? '铁' : '钻石'
    const plans = [
      { type: 'pickaxe', label: `${label}镐`, cost: 3, sticks: 2 },
      { type: 'sword', label: `${label}剑`, cost: 2, sticks: 1 },
      { type: 'chestplate', label: `${label}胸甲`, cost: 8 },
      { type: 'leggings', label: `${label}护腿`, cost: 7 },
      { type: 'helmet', label: `${label}头盔`, cost: 5 },
      { type: 'boots', label: `${label}靴子`, cost: 4 },
    ].filter(plan => !acceptedTiers.some(material => names.has(`${material}_${plan.type}`)))
      .map(plan => ({ ...plan, resource, item: `${tier}_${plan.type}` }))
    if (tier === 'iron' && !names.has('shield')) {
      plans.splice(plans[0]?.type === 'pickaxe' ? 1 : 0, 0,
        { item: 'shield', type: 'shield', label: '盾牌', resource, cost: 1, planks: 6 })
    }
    if (tier === 'iron' && !names.has('bucket') && !names.has('water_bucket')) {
      const armorIndex = plans.findIndex(plan => ['chestplate', 'leggings', 'helmet', 'boots'].includes(plan.type))
      plans.splice(armorIndex === -1 ? plans.length : armorIndex, 0,
        { item: 'bucket', type: 'bucket', label: '铁桶', resource, cost: 3 })
    }
    return plans
  }

  function nextIronUpgrade() {
    return gearUpgrades('iron')[0] ?? null
  }

  function readyGearUpgrades() {
    const diamond = gearUpgrades('diamond')
    const iron = gearUpgrades('iron')
    const diamondPick = diamond.find(plan => plan.type === 'pickaxe')
    const ironPick = iron.find(plan => plan.type === 'pickaxe')
    // Leave the first three ingots available for the pickaxe across separate smelt batches.
    const priorityIron = ironPick ? [ironPick] : iron
    const candidates = [diamondPick, ...priorityIron.filter(plan => plan.type === 'pickaxe' || plan.type === 'shield'),
      ...(diamondPick ? [] : diamond), ...priorityIron.filter(plan => plan.type !== 'pickaxe' && plan.type !== 'shield')]
      .filter(plan => plan && features.inventoryItemCount(plan.resource) >= plan.cost)
    if (!candidates.length) return []
    const tablePlanks = features.inventoryItemCount(TABLE_NAME) > 0 || features.findNearestBlock(TABLE_NAMES, 4) ? 0 : 4
    const wood = features.plankCount() + features.inventoryCount(LOG_NAMES) * 4
    const sticks = features.inventoryItemCount('stick')
    return candidates.filter(plan => wood >= tablePlanks + (plan.planks || 0) +
      (plan.sticks > sticks ? 2 : 0))
  }

  async function craftAvailableGear(allowRelocate = true) {
    let changed = false
    const failed = new Set()
    while (features.canWorkHere(runtimeState.bot) && !features.foodRecoveryNeeded() && !features.closeCombatPlan()) {
      const next = readyGearUpgrades().find(plan => !failed.has(plan.item))
      if (!next) break
      const table = await features.ensureCraftingTable(allowRelocate)
      if (!table || !features.canWorkHere(runtimeState.bot) || features.foodRecoveryNeeded()) break
      if (next.sticks && features.inventoryItemCount('stick') < next.sticks &&
          (!await features.makePlanksFor(2) || !await features.craftNamed('stick'))) {
        failed.add(next.item)
        continue
      }
      if ((next.planks && !await features.makePlanksFor(next.planks)) || !await features.craftNamed(next.item, table)) {
        failed.add(next.item)
        continue
      }
      changed = true
      features.log('gear upgrade crafted', { item: next.item, material: next.resource })
    }
    if (changed) {
      await autoEquipArmor()
      await features.equipCombatItem()
    }
    return changed
  }

  async function prepareStarterGear() {
    if (!features.canWorkHere(runtimeState.bot) || features.foodRecoveryNeeded()) return false
    let progress = false
    try {
      progress = await craftAvailableGear()
      if (features.foodRecoveryNeeded()) return progress
      const rawIronCount = features.inventoryItemCount('raw_iron') + features.inventoryItemCount('iron_ore') + features.inventoryItemCount('deepslate_iron_ore')
      const ironUpgrade = nextIronUpgrade()
      if (rawIronCount > 0 && (!ironUpgrade || rawIronCount + features.inventoryItemCount('iron_ingot') >= ironUpgrade.cost)) {
        const smelted = await features.smeltRawIron()
        progress = smelted || progress
        if (runtimeState.pendingIronWorkshop || runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace) return progress
      }

      const toolPlans = [['pickaxe', 3, 2], ['sword', 2, 1], ['axe', 3, 2]]
      const canMakeTool = ([tool, heads]) => !hasTool(tool) ||
        (!hasStoneGradeTool(tool) && features.inventoryCount(STONE_DROPS) >= heads)
      const suppliesNeeded = toolPlans.some(canMakeTool)

      const fuelToReserve = !runtimeState.bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)) ||
        features.inventoryCount(IRON_INPUT_NAMES) > 0 ? 1 : 0
      if (features.inventoryItemCount('torch') < 8 && features.inventoryItemCount('coal') > fuelToReserve) {
        if (features.inventoryItemCount('stick') === 0 && await features.makePlanksFor(2)) await features.craftNamed('stick')
        progress = (await features.craftNamed('torch')) || progress
      }
      if (!suppliesNeeded) {
        await autoEquipArmor()
        await features.equipCombatItem()
        return progress
      }
      const hasTableReady = features.inventoryItemCount(TABLE_NAME) > 0 || Boolean(features.findNearestBlock(TABLE_NAMES, 4))
      if (!hasTableReady) {
        const minWoodForTool = features.inventoryCount(STONE_DROPS) >= 3 ? 0 : 3
        if (features.plankCount() + features.inventoryCount(LOG_NAMES) * 4 < 4 + minWoodForTool) {
          features.log('starter gear deferred: insufficient wood for table and tool', {
            planks: features.plankCount(),
            logs: features.inventoryCount(LOG_NAMES),
            required: 4 + minWoodForTool
          })
          return progress
        }
        if (!await features.makePlanksFor(4)) return progress
      }
      const table = await features.ensureCraftingTable()
      if (!table || !features.canWorkHere(runtimeState.bot)) return progress
      for (const [tool, heads, sticks] of toolPlans) {
        if (!features.canWorkHere(runtimeState.bot)) break
        if (!canMakeTool([tool, heads])) continue
        const useStone = features.inventoryCount(STONE_DROPS) >= heads
        const needsSticks = features.inventoryItemCount('stick') < sticks
        if (!await features.makePlanksFor((useStone ? 0 : heads) + (needsSticks ? 2 : 0))) continue
        if (needsSticks && !await features.craftNamed('stick')) continue
        if (!features.canWorkHere(runtimeState.bot)) break
        const crafted = await features.craftNamed(`${useStone ? 'stone' : 'wooden'}_${tool}`, table)
        progress = crafted || progress
      }

      await autoEquipArmor()
      await features.equipCombatItem()

      if (progress) features.log('starter gear prepared', {
        axe: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_axe')),
        pickaxe: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe')),
        sword: runtimeState.bot.inventory.items().some(item => item.name.endsWith('_sword')),
        ironPickaxe: runtimeState.bot.inventory.items().some(item => item.name === 'iron_pickaxe'),
        shield: features.inventoryItemCount('shield') > 0,
        torches: features.inventoryItemCount('torch'),
      })
      return progress
    } finally {
      await features.reclaimTemporaryCraftingTable()
    }
  }

  function hasTool(kind) {
    return runtimeState.bot.inventory.items().some(item => item.name.endsWith(`_${kind}`))
  }

  function hasStoneGradeTool(kind) {
    return runtimeState.bot.inventory.items().some(item =>
      item.name.endsWith(`_${kind}`) && /^(stone|copper|iron|diamond|netherite)_/.test(item.name))
  }

  async function advanceSurvivalGear() {
    if (!features.canWorkHere(runtimeState.bot)) return false
    const stonesNeeded = ['pickaxe', 'sword', 'axe'].reduce((count, kind) =>
      count + (hasStoneGradeTool(kind) ? 0 : kind === 'sword' ? 2 : 3), 0)
    const needsTools = ['pickaxe', 'sword', 'axe'].some(kind => !hasTool(kind))
    const coal = features.inventoryItemCount('coal')
    const charcoal = features.inventoryItemCount('charcoal')
    const needsTorches = features.inventoryItemCount('torch') < 8
    const canUpgrade = stonesNeeded > 0 && features.inventoryCount(STONE_DROPS) >= stonesNeeded
    const rawIron = features.inventoryCount(IRON_INPUT_NAMES)
    const ironIngots = features.inventoryItemCount('iron_ingot')
    const needsCoal = needsCoalForIron({ rawIron, coal, charcoal, iron: rawIron + ironIngots,
      hasIronPickaxe: runtimeState.bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)) })
    const nextIron = nextIronUpgrade()
    const canSmeltUpgrade = rawIron > 0 && coal + charcoal > 0 && (!nextIron || rawIron + ironIngots >= nextIron.cost)
    if (needsTools || canUpgrade || (needsTorches && coal > 0) || canSmeltUpgrade || readyGearUpgrades().length) {
      runtimeState.lastDecision = 'gear-up'
      features.log('survival objective', { action: 'craft', stonesNeeded, needsTools, needsTorches, canSmeltUpgrade })
      if (await prepareStarterGear() || runtimeState.pendingIronWorkshop || runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace) return true
    }
    if (!hasTool('pickaxe')) return false
    const targets = stonesNeeded > 0 && features.inventoryCount(STONE_DROPS) < stonesNeeded
      ? STONE_TARGETS : needsCoal || (needsTorches && coal === 0) ? COAL_TARGETS : null
    if (!targets) return false
    if (runtimeState.mineNeedsNewGround) {
      runtimeState.mineNeedsNewGround = false
      return false
    }
    if (!features.findNearestBlock(targets, targets === COAL_TARGETS ? ORE_SCAN_RADIUS : BLOCK_MINE_RADIUS)) return false
    runtimeState.mineMode = true
    runtimeState.mineTargetNames = targets
    runtimeState.currentMineOrder = { cycle: runtimeState.cycle, requested: null, target: targets === STONE_TARGETS ? 'stone' : 'coal', source: 'survival' }
    runtimeState.lastDecision = targets === STONE_TARGETS ? 'gather-stone-for-tools' :
      needsCoal ? 'gather-coal-for-smelting' : 'gather-coal-for-torches'
    features.log('survival objective', { action: runtimeState.lastDecision, stonesNeeded, stone: features.inventoryCount(STONE_DROPS) })
    return true
  }

  function equippedArmorCount() {
    return runtimeState.bot.inventory.slots.slice(5, 9)
      .filter(item => /_(helmet|chestplate|leggings|boots)$/.test(item?.name || '')).length
  }

  function hasDiamondArmor(connection) {
    return ARMOR_SLOTS.every(([slot, type]) => {
      const name = connection.inventory.slots[connection.getEquipmentDestSlot(slot)]?.name ?? ''
      return name === `diamond_${type}` || name === `netherite_${type}`
    })
  }

  function hasDiamondMiningTool(connection) {
    return connection.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name))
  }

  return {
    needsCoalForIron,
    armorScore,
    autoEquipArmor,
    ensureWoodAxe,
    nextIronUpgrade,
    readyGearUpgrades,
    craftAvailableGear,
    prepareStarterGear,
    hasTool,
    hasStoneGradeTool,
    advanceSurvivalGear,
    equippedArmorCount,
    hasDiamondArmor,
    hasDiamondMiningTool,
  }
}

module.exports = createEquipment
