const { FOOD_RECOVERY_START, WOOD_TARGET, STONE_TARGET } = require('./config')

function createProgression(runtimeState, features) {
  function computeStage(s) {
    if (runtimeState.supplyBase.active(runtimeState.bot)) {
      return { name: 'supply_base', hint: '建立并维护补给基地和红石工坊', allowed: null }
    }
    if (features.isNightShelterTime(s.timeOfDay) && s.nightShelterTerrain === 'open' &&
        (runtimeState.nightsSheltered < 1 || !s.hasSword)) {
      return { name: 'first_night', hint: '天黑了：做床睡觉，没有床就挖三格深的坑并封住头顶，等天亮', allowed: null }
    }
    const currentFood = Number(s.food ?? 20)
    if (currentFood <= FOOD_RECOVERY_START || runtimeState.recoveringFood) {
      const hasFood = features.getEdibleFoods().length > 0
      if (hasFood) {
        return { name: 'eat_food', hint: `饥饿值偏低 (${currentFood}/20)，食用背包食物恢复状态`, allowed: new Set(['gear_up', 'explore']), action: 'gear_up' }
      }
      return { name: 'hunt_food', hint: `饥饿值危险 (${currentFood}/20) 且背包无食物，寻找牛/羊/猪/鸡狩猎获取肉食`, allowed: new Set(['hunt_food', 'explore', 'attack']), action: 'hunt_food' }
    }
    const isUnderground = Boolean(s.mining_underground || s.underground || (s.position && s.position.y < 55))
    if (!s.hasPickaxe) {
      const hasAnyWood = (s.sticks >= 2 || s.planks >= 1 || s.logs >= 1)
      const canMakeStonePick = Number(s.cobblestone || 0) >= 3 && hasAnyWood
      if (canMakeStonePick) {
        return { name: 'get_stone', hint: '补做石镐并升级装备', allowed: new Set(isUnderground ? ['gear_up', 'mine'] : ['gear_up', 'mine', 'explore']), action: 'gear_up', targetName: 'stone' }
      }
      const hasRawOrIngot = Number(s.iron || 0) > 0
      if (hasRawOrIngot && hasAnyWood) {
        return { name: 'find_iron', hint: '熔炼铁矿制作铁镐', allowed: new Set(['gear_up']), action: 'gear_up', targetName: 'iron' }
      }
      const totalWood = s.logs + Math.floor(s.planks / 4)
      if (totalWood < WOOD_TARGET) {
        return { name: 'gather_wood', hint: `缺乏木材制作工具，收集原木 (目标 ${WOOD_TARGET})`, allowed: new Set(isUnderground ? ['collect_wood', 'gear_up'] : ['collect_wood', 'explore']), action: 'collect_wood' }
      }
      return { name: 'wood_tools', hint: '原木转木板，4 木板做工作台，木镐必须先做，再做木剑和木斧', allowed: new Set(['gear_up', 'collect_wood', 'explore']), action: 'gear_up' }
    }
    const stoneTools = ['pickaxe', 'sword', 'axe'].every(kind => features.hasStoneGradeTool(kind))
    if (!stoneTools) {
      const hasEnoughCobble = Number(s.cobblestone || 0) >= STONE_TARGET
      return {
        name: 'get_stone',
        hint: hasEnoughCobble
          ? '已挖够圆石，合成石镐、石剑、石斧（若缺木棍先砍树）'
          : `用木镐挖 ${STONE_TARGET} 块圆石，再合成石镐、石剑、石斧`,
        allowed: new Set(isUnderground ? ['mine', 'gear_up'] : ['mine', 'gear_up', 'collect_wood', 'explore']),
        action: hasEnoughCobble ? 'gear_up' : 'mine',
        targetName: 'stone'
      }
    }
    if (features.needsCoalForIron(s) || (s.coal === 0 && s.torches < 8 && !s.rawIron && s.hasIronPickaxe)) {
      return { name: 'find_coal', hint: '先找煤矿，留煤炭供熔炉使用；火把数量不能替代燃料', allowed: new Set(isUnderground ? ['mine'] : ['mine', 'explore']), action: 'mine', targetName: 'coal' }
    }
    const upgrade = features.nextIronUpgrade()
    if (upgrade) {
      const ingots = features.inventoryItemCount('iron_ingot')
      const ready = ingots >= upgrade.cost || (s.coal + s.charcoal > 0 && s.rawIron + ingots >= upgrade.cost)
      return {
        name: 'find_iron',
        hint: ready ? `铁已够做${upgrade.label}，先制作再继续下矿` :
          `先补铁到 ${upgrade.cost} 个，下一件装备是${upgrade.label}`,
        allowed: new Set(ready ? ['gear_up'] : isUnderground ? ['mine', 'gear_up'] : ['mine', 'explore', 'gear_up', 'collect_wood']),
        action: ready ? 'gear_up' : 'mine',
        targetName: 'iron'
      }
    }
    return { name: 'find_diamond', hint: '用铁镐往深层走，阶梯式一格一格往下挖，钻石必须铁镐或更好', allowed: null }
  }

  return {
    computeStage,
  }
}

module.exports = createProgression
