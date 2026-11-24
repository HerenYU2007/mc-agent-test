const mineflayer = require('mineflayer')
const { observeToolTags } = require('./mining-speed')
const { observeLight } = require('./home-light')
const minecraftData = require('minecraft-data')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const pvp = require('mineflayer-pvp').plugin
const {
  VERSION, HOST, PORT, USERNAME, VIEWER_PORT, LOG_NAMES, WATER_BLOCK_NAMES, TABLE_NAME,
} = require('./config')

const { avoidWetCorners, avoidWetSteps, fluidBeside } = require('./movement-safety')

const NORMAL_DECISION_INTERVAL_MS = 10000

function createLifecycle(runtimeState, features) {
  let loopsStarted = false

  function installAsyncErrorHandler() {
    process.on('unhandledRejection', error => {
      const message = error?.message || String(error)
      if (message.includes('GoalChanged') || message.includes('goal was changed')) {
        console.error(`[agent ${new Date().toISOString()}] recovered path interruption: ${message}`)
        try { features.stopPathfinder() } catch {}
        return
      }
      console.error(`[agent ${new Date().toISOString()}] unhandled async error: ${message}`)
    })
  }

  function createBotConnection() {
    if (runtimeState.bot) return runtimeState.bot
    const connection = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION })
    observeLight(connection)
    observeToolTags(connection)
    runtimeState.bot = connection
    const pile = new Set()
    const repicked = new Set()
    runtimeState.discardPiles.set(connection, pile)
    runtimeState.repickedDiscards.set(connection, repicked)
    connection.on('entityGone', entity => pile.delete(entity))
    connection.on('playerCollect', (collector, entity) => {
      if (collector?.id !== connection.entity?.id || !runtimeState.discardedEntities.has(entity)) return
      const item = features.droppedStack(entity)
      if (item) repicked.add(item.name)
    })
    connection.loadPlugin(pathfinder)
    connection.loadPlugin(collectBlock)
    connection.loadPlugin(toolPlugin)
    connection.loadPlugin(pvp)

    connection.once('spawn', () => {
      if (runtimeState.bot !== connection) return
      features.trackCombatImpacts(connection)
      features.trackWaterClutch(connection)
      // digTime is defined by mineflayer's digging plugin, so it only exists here.
      if (typeof connection.digTime === 'function') features.installDigTimeFix(connection)
      else features.log('digTime not available; dig timing fix not installed')
      const dig = connection.dig.bind(connection)
      connection.dig = async (block, ...args) => {
        const watchingMine = connection === runtimeState.bot && runtimeState.mineBusy && runtimeState.currentMineTarget && block
        if (connection === runtimeState.bot && runtimeState.mineBusy && block && fluidBeside(connection, block.position)) {
          throw new Error('采矿取消，待挖方块贴近流体')
        }
        if (!watchingMine) return dig(block, ...args)
        const targetHit = block.name === runtimeState.currentMineTarget.name && block.position.equals(runtimeState.currentMineTarget)
        if (!targetHit && features.isOreName(block.name)) {
          features.recordMineAudit('unexpected-ore', block)
          throw new Error('Mining order excludes ' + block.name)
        }
        await dig(block, ...args)
        if (connection.blockAt(block.position)?.type !== block.type) {
          features.recordMineAudit(targetHit ? 'target-mined' : 'path-clearance', block)
        }
      }
      runtimeState.mcData = minecraftData(connection.version)
      runtimeState.movements = new Movements(connection, runtimeState.mcData)
      runtimeState.movements.canDig = true
      runtimeState.movements.maxDropDown = 3
      runtimeState.movements.infiniteLiquidDropdownDistance = false
      avoidWetCorners(runtimeState.movements, connection)
      avoidWetSteps(runtimeState.movements, connection, () => runtimeState.mineBusy)
      runtimeState.movements.exclusionAreasBreak.push(block =>
        runtimeState.supplyStation.protects(connection, block?.position) || !(runtimeState.mineBusy || runtimeState.surfaceRouteActive || runtimeState.baseProspecting) ? 100 : 0)
      runtimeState.movements.allow1by1towers = true
      runtimeState.movements.allowParkour = true
      runtimeState.movements.placeCost = 2.5
      // liquidCost of 40 was not enough to deter the pathfinder from entering
      // water. 500 effectively forbids a water step unless there is no dry path.
      runtimeState.movements.liquidCost = 500
      // Never bridge over open water: placing on the surface made the bot build
      // onto the sea, fall in, get pulled ashore by the swim controller, repeat.
      runtimeState.movements.exclusionAreasPlace.push(block => (features.isWaterAdjacent(block?.position) ? 500 : 0))
      // Walking INTO a water block also costs a lot; the shore-walking swim step
      // itself was free before.
      runtimeState.movements.exclusionAreasStep.push(block => (block && WATER_BLOCK_NAMES.has(block.name) ? 500 : 0))
      runtimeState.movements.exclusionAreasStep.push(block => features.discardTileCost(connection, block))
      runtimeState.movements.blocksCantBreak.add(runtimeState.mcData.blocksByName[TABLE_NAME].id)
      runtimeState.movements.exclusionAreasBreak.push(block => runtimeState.supplyBase.owns(connection, block?.position) ? Infinity : 0)
      for (const block of runtimeState.mcData.blocksArray) {
        if (LOG_NAMES.has(block.name) || features.isOreName(block.name)) runtimeState.movements.blocksCantBreak.add(block.id)
      }
      // Let the pathfinder choose safe solid inventory blocks when a route
      // needs a one-block tower or a bridge. Falling sand/gravel and fluids are
      // intentionally excluded.
      runtimeState.movements.scafoldingBlocks = [
        'dirt', 'cobblestone', 'stone', 'deepslate',
        'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
        'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
        'cherry_planks', 'pale_oak_planks',
      ].map(name => runtimeState.mcData.itemsByName[name]?.id).filter(Number.isInteger)
      connection.pathfinder.setMovements(runtimeState.movements)
      if (process.env.MC_VIEWER !== '0') {
        const { supportedVersions } = require('prismarine-viewer/viewer')
        if (supportedVersions.includes(connection.version)) {
          require('prismarine-viewer').mineflayer(connection, { port: VIEWER_PORT, firstPerson: false })
          features.log('viewer started', { url: `http://127.0.0.1:${VIEWER_PORT}` })
        } else {
          features.log('当前游戏版本请使用原生 Fabric 旁观客户端', { version: connection.version })
        }
      }
      features.startDashboard()
      features.log('spawned', { version: connection.version, position: connection.entity.position })
      void features.decideAndAct('spawn')
      if (!loopsStarted) {
        loopsStarted = true
        setInterval(() => void features.decideAndAct('scheduled'), NORMAL_DECISION_INTERVAL_MS)
        setInterval(() => {
          if (runtimeState.supplyStation.pending && !runtimeState.busy && !runtimeState.mineMode && !runtimeState.mineBusy && !features.waterOwnsMovement() &&
              !runtimeState.shelteredUntilDawn && !runtimeState.emergencyShelteredUntil && !runtimeState.isEating && !runtimeState.isSmelting && !runtimeState.isDiggingBlock &&
              !features.foodRecoveryNeeded()) void features.decideAndAct('station')
        }, 1600)
        // MineProcess-style local replanning. This is deliberately independent
        // from the slower DeepSeek loop and only searches when the previous
        // plan is idle, invalid, or has just finished mining.
        setInterval(() => void features.minePlannerTick('periodic'), 750)
        setInterval(features.monitorThreats, 500)
        setInterval(() => features.monitorFood(), 500)
        setInterval(() => void features.monitorSwimming(), 250)
        setInterval(() => void features.escapeIfStranded().catch(error => features.log('stranded escape failed', { message: error.message })), 2000)
        setInterval(features.emitNavigationParticles, 500)
      }
    })

    const recordDeath = features.trackDeathRecoveryInventory(connection)
    connection.on('health', () => {
      if (connection.health < 8) features.log('health critical', { health: connection.health, food: connection.food })
      features.monitorFood(connection)
    })

    connection.on('death', () => {
      runtimeState.emergencyShelteredUntil = 0
      runtimeState.shelteredUntilDawn = false
      runtimeState.shelterInfo = null
      runtimeState.activeGoal = null
      runtimeState.mineMode = false
      runtimeState.committedMineTarget = null
      runtimeState.recoveringFood = false
      runtimeState.miningPausedForFood = false
      runtimeState.swimmingMode = false
      runtimeState.swimShore = runtimeState.swimProgress = runtimeState.swimFailedShore = null
      runtimeState.supplyStation.interrupt(features.log, 'death')
      recordDeath()
      features.log('agent died; waiting for respawn')
      connection.pvp.stop()
      setTimeout(() => {
        if (!runtimeState.botEnabled || runtimeState.bot !== connection) return
        try {
          connection.respawn()
          features.log('respawn requested')
        } catch (error) {
          features.log('respawn failed', { message: error.message })
        }
      }, 1200)
    })

    connection.on('startedAttacking', () => features.log('started attacking', { target: features.entityNameOf(connection.pvp.target) }))
    connection.on('attackedTarget', () => features.log('attack landed', { target: features.entityNameOf(connection.pvp.target) }))
    connection.on('stoppedAttacking', () => features.log('stopped attacking'))
    connection.on('goal_reached', () => features.clearNavigation('goal-reached'))
    connection.on('path_stop', () => features.clearNavigation('path-stopped'))
    connection.on('path_update', result => {
      if (!result?.path || result.path.length === 0) {
        if (result?.status === 'success' || result?.status === 'noPath') features.clearNavigation(`path-${result.status}`)
        return
      }
      const toPlace = result.path.flatMap(point => Array.isArray(point.toPlace) ? point.toPlace : [])
      runtimeState.navigationState = {
        ...runtimeState.navigationState,
        waypoints: result.path.map(point => ({ x: point.x, y: point.y, z: point.z })),
      }
      if (toPlace.length > 0) {
        const scaffoldCount = features.inventoryCount(new Set(['dirt', 'cobblestone', 'stone', 'sand', 'gravel']))
        features.log('path plan requires scaffolding', { placements: toPlace.length, scaffoldBlocksAvailable: scaffoldCount, positions: toPlace.slice(0, 6) })
        features.persistExperience({ cycle: runtimeState.cycle, action: 'path-scaffold', experience: `寻路发现 ${toPlace.length} 个高度差，使用库存方块自动垫路；库存不足时放弃该分支` })
      }
      features.log('real path updated', { nodes: result.path.length, cost: result.cost ?? null, placements: toPlace.length })
    })
    connection.on('kicked', reason => features.log('kicked', { reason }))
    connection.on('error', error => features.log('connection error', { message: error.message }))
    connection.on('end', reason => {
      runtimeState.supplyStation.interrupt(features.log, 'disconnect')
      features.log('connection ended', { reason })
      if (runtimeState.bot === connection) {
        runtimeState.swimmingMode = false
        runtimeState.swimShore = runtimeState.swimProgress = runtimeState.swimFailedShore = null
        runtimeState.bot = null
      }
    })
    return connection
  }

  return {
    installAsyncErrorHandler,
    createBotConnection,
  }
}

module.exports = createLifecycle
