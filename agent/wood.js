const { goals } = require('mineflayer-pathfinder')
const { LOG_NAMES, WOOD_TARGET } = require('./config')

const WOOD_SCAN_RADIUS = 72

function createWood(runtimeState, features) {
  // Positions that already failed to path to or dig (unreachable canopy logs,
  // server-rejected digs). Without this the same block is retried every cycle.
  const collectBlacklist = new Map()

  const woodSearchVisits = []

  function pruneCollectBlacklist(now = Date.now()) {
    for (const [key, expiresAt] of collectBlacklist) {
      if (expiresAt <= now) collectBlacklist.delete(key)
    }
  }

  async function collectTreeTrunks(stockTarget = WOOD_TARGET, woodNames = LOG_NAMES) {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection)) return false
    pruneCollectBlacklist()
    const pending = connection.findBlocks({
      maxDistance: 28, count: 64, matching: features.scanBlockIds(woodNames)
    }).filter(position => !collectBlacklist.has(features.minePositionKey(position)))
    let lastTrunk = null
    let collected = 0
    let failures = 0
    while (pending.length && collected < WOOD_TARGET && failures < 3 &&
        features.canWorkHere(connection) && !features.closeCombatPlan() && features.inventoryCount(woodNames) < stockTarget) {
      const here = connection.entity.position
      const candidates = pending.flatMap(position => {
        const block = connection.blockAt(position, false)
        if (!block || !woodNames.has(block.name)) return []
        const ready = connection.canDigBlock(block) && connection.canSeeBlock(block)
        const sameTrunk = lastTrunk && position.x === lastTrunk.x && position.z === lastTrunk.z
        return [{ block, ready, score: here.distanceTo(position) +
          Math.max(0, position.y - here.y) * 2 - (sameTrunk ? 3 : 0) }]
      })
      candidates.sort((a, b) => Number(b.ready) - Number(a.ready) || a.score - b.score)
      const selected = candidates[0]
      if (!selected) break
      const position = selected.block.position
      pending.splice(pending.findIndex(point => point.equals(position)), 1)
      try {
        if (!selected.ready) {
          if (collected && here.distanceTo(position) > 7) break
          const goal = new goals.GoalLookAtBlock(position, connection.world, { reach: 4.2 })
          await features.gotoWithTimeout(goal, 'wood trunk path', collected ? 1600 : 3000)
        }
        if (!features.canWorkHere(connection) || features.closeCombatPlan()) break
        const block = connection.blockAt(position)
        if (!block || block.type !== selected.block.type || !woodNames.has(block.name)) continue
        if (!await features.digWithExposure(block, woodNames)) throw new Error('could not dig chosen trunk')
        collected += 1
        failures = 0
        lastTrunk = position
      } catch (error) {
        if (connection !== runtimeState.bot || !features.canWorkHere(connection) || features.closeCombatPlan()) break
        failures += 1
        features.stopPathfinder()
        collectBlacklist.set(features.minePositionKey(position), Date.now() + 45000)
        features.log('wood trunk skipped', { position, message: error.message })
      }
    }
    if (!features.canWorkHere(connection) || features.closeCombatPlan()) return collected > 0
    const before = features.inventoryCount(LOG_NAMES)
    await collectFallenWood(connection)
    if (!features.canWorkHere(connection)) return collected > 0
    if (collected || features.inventoryCount(LOG_NAMES) > before) {
      features.log('wood batch completed', { broken: collected, logs: features.inventoryCount(LOG_NAMES) })
      await prepareAxeForWoodCollection()
      return true
    }
    return false
  }

  async function collectFallenWood(connection) {
    await features.clearBackpack(connection, 'wood-pickup')
    const drops = features.findNearbyDrops(8).filter(({ entity }) => {
      try { return LOG_NAMES.has(entity.getDroppedItem()?.name) } catch { return false }
    }).slice(0, 4)
    for (const { entity } of drops) {
      if (!features.canWorkHere(connection) || features.closeCombatPlan() || features.inventoryCount(LOG_NAMES) >= WOOD_TARGET) return
      if (!connection.entities[entity.id]) continue
      const point = entity.position.floored()
      // A dropped log can still be falling through the air. Approach a standing
      // position below it rather than waiting for a path to the moving entity.
      let feet = point
      for (let i = 0; i < 4; i += 1) {
        const below = connection.blockAt(feet.offset(0, -1, 0), false)
        if (below?.boundingBox === 'block') break
        feet = feet.offset(0, -1, 0)
      }
      try {
        await features.gotoWithTimeout(new goals.GoalNear(feet.x, feet.y, feet.z, 0.8), 'wood drop pickup', 1200)
      } catch {
        if (!features.canWorkHere(connection)) return
      }
    }
  }

  async function prepareAxeForWoodCollection() {
    // The route is: hand-chop logs first, then table, pickaxe, sword, axe. Crafting
    // an axe mid-chop spent the logs and put the axe ahead of the pickaxe.
    if (!runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe')) && features.inventoryCount(LOG_NAMES) < WOOD_TARGET) return false
    try {
      return await features.ensureWoodAxe()
    } finally {
      await features.reclaimTemporaryCraftingTable()
    }
  }

  async function collectWoodWithPlan(target = null, stockTarget = WOOD_TARGET, woodNames = LOG_NAMES) {
    if (!features.canWorkHere(runtimeState.bot)) return false
    if (await features.leaveSpawnCanopy()) return true
    await prepareAxeForWoodCollection()
    if (await collectTreeTrunks(stockTarget, woodNames)) return true
    if (!features.canWorkHere(runtimeState.bot) || features.closeCombatPlan()) return false

    const origin = runtimeState.bot.entity.position.floored()
    pruneCollectBlacklist()
    const trunks = runtimeState.bot.findBlocks({
      maxDistance: WOOD_SCAN_RADIUS, count: 96,
      matching: features.scanBlockIds(woodNames)
    }).filter(position => !collectBlacklist.has(features.minePositionKey(position)))
    const score = position => Math.hypot(position.x - origin.x, position.z - origin.z) +
      Math.max(0, position.y - origin.y) * 2.5
    trunks.sort((a, b) => score(a) - score(b))
    const tree = trunks.find(position => Math.hypot(position.x - origin.x, position.z - origin.z) >= 5)
    if (tree) {
      const wood = runtimeState.bot.blockAt(tree)
      features.log('wood source found', { block: wood?.name, position: tree, candidates: trunks.length })
      if (await features.moveToModelTarget(tree, 'scout to tree')) {
        if (features.canWorkHere(runtimeState.bot) && await collectTreeTrunks(stockTarget, woodNames)) return true
      }
      if (!features.canWorkHere(runtimeState.bot) || features.closeCombatPlan()) return false
      collectBlacklist.set(features.minePositionKey(tree), Date.now() + 30000)
    }

    const here = runtimeState.bot.entity.position.floored()
    woodSearchVisits.push(here)
    if (woodSearchVisits.length > 16) woodSearchVisits.shift()
    const options = Array.from({ length: 5 }, () => features.pickDryExploreTarget(here, 20, 15)).filter(Boolean)
    const modelTarget = features.clampModelTarget(target, here, 42)
    if (modelTarget && Math.hypot(modelTarget.x - here.x, modelTarget.z - here.z) >= 12) options.push(modelTarget)
    const novelty = candidate => Math.min(...woodSearchVisits.map(point =>
      Math.hypot(candidate.x - point.x, candidate.z - point.z)))
    options.sort((a, b) => novelty(b) - novelty(a))
    features.log('wood search moving to new ground', { from: here, target: options[0] ?? null, scanRadius: WOOD_SCAN_RADIUS })
    await features.exploreOneStep(options[0] ?? null)
    return features.canWorkHere(runtimeState.bot) && !features.closeCombatPlan() && await collectTreeTrunks(stockTarget, woodNames)
  }

  return {
    collectWoodWithPlan,
  }
}

module.exports = createWood
