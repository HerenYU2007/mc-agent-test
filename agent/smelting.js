const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { STONE_DROPS, FURNACE_NAME, TABLE_TOP, IRON_INPUT_NAMES, IRON_FUEL_NAMES, EMPTY_BLOCK, WATER_BLOCK_NAMES } = require('./config')

const FURNACE_NAMES = new Set([FURNACE_NAME])
const FURNACE_PICKUP_LIMIT = 2
const FURNACE_CLEARANCE_BLOCKS = new Set(['stone', 'cobblestone', 'granite', 'diorite', 'andesite', 'deepslate',
  'cobbled_deepslate', 'tuff', 'dirt', 'coarse_dirt'])
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function createSmelting(runtimeState, features) {
  async function ensureFurnace(stations = null, allowClearance = true) {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection)) return null
    if (!stations) {
      const existing = features.findNearestBlock(FURNACE_NAMES, 4)
      if (furnaceReachable(connection, existing) && !runtimeState.supplyBase.owns(connection, existing.position)) return existing
      if (runtimeState.temporaryFurnace) return null
    }
    // A furnace broken without a pickaxe will not drop as an item.
    if (!features.hasTool('pickaxe')) return null

    // Ensure we have a furnace in inventory:
    if (features.inventoryItemCount(FURNACE_NAME) === 0) {
      if (features.inventoryCount(STONE_DROPS) < 8) {
        features.log('cannot craft furnace; need 8 cobblestone', { cobblestone: features.inventoryCount(STONE_DROPS) })
        return null
      }
      const table = await features.ensureCraftingTable(!stations?.length)
      if (!table) return null
      const crafted = await features.craftNamed(FURNACE_NAME, table)
      if (!crafted && features.inventoryItemCount(FURNACE_NAME) === 0) return null
    }

    const held = runtimeState.bot.inventory.items().find(item => item.name === FURNACE_NAME)
    if (!held) return null

    const base = connection.entity.position.floored()
    const spots = []
    for (const y of [0, -1, 1]) {
      for (let x = -3; x <= 3; x += 1) {
        for (let z = -3; z <= 3; z += 1) {
          if (x === 0 && z === 0) continue
          spots.push(base.offset(x, y, z))
        }
      }
    }
    spots.sort((a, b) => Math.abs(a.y - base.y) - Math.abs(b.y - base.y) || a.distanceTo(base) - b.distanceTo(base))
    for (const position of spots) {
      if (!features.canWorkHere(connection)) return null
      if (!features.isTableSite(connection, position)) continue
      const support = connection.blockAt(position.offset(0, -1, 0))
      const hit = position.offset(0.5, -0.02, 0.5)
      const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      const ray = hit.minus(eyes)
      if (ray.norm() > 4 || !connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
      if (!isRecoverableFurnaceSite(connection, position, eyes)) continue
      try {
        await connection.equip(held, 'hand')
        if (!features.canWorkHere(connection)) return null
        await connection.placeBlock(support, TABLE_TOP)
      } catch (error) {
        features.log('furnace placement skipped', { position, message: error.message })
      }
      const placed = connection.blockAt(position)
      if (placed?.name === FURNACE_NAME) {
        const fixture = { position, dimension: connection.game.dimension, broken: false }
        if (stations) stations.push(fixture)
        else runtimeState.temporaryFurnace = fixture
        features.log('temporary furnace placed', { position })
        return placed
      }
      if (!connection.inventory.items().some(item => item.name === FURNACE_NAME)) return null
    }
    if (allowClearance && await clearFurnaceAlcove(connection, base)) return ensureFurnace(stations, false)
    features.log('furnace placement skipped: no reachable, recoverable site')
    return null
  }

  function isRecoverableFurnaceSite(connection, position, eyes) {
    if (!EMPTY_BLOCK.test(connection.blockAt(position.offset(0, 1, 0))?.name)) return false
    const center = position.offset(0.5, 0.5, 0.5).minus(eyes)
    if (center.norm() > 4 || connection.world.raycast(eyes, center.unit(), center.norm())) return false
    // Plan to stand on the drop after breaking the furnace, using the existing terrain.
    const goal = new goals.GoalBlock(position.x, position.y, position.z)
    const { result: path } = connection.pathfinder.getPathFromTo(runtimeState.movements, connection.entity.position, goal,
      { timeout: 200, searchRadius: 8, optimizePath: false }).next().value
    return path.status === 'success' && path.path.every(step => !step.toBreak.length && !step.toPlace.length)
  }

  async function clearFurnaceAlcove(connection, base) {
    for (const [x, z] of SIDES) {
      const position = base.offset(x, 0, z)
      const support = connection.blockAt(position.offset(0, -1, 0))
      if (support?.boundingBox !== 'block' || runtimeState.movements.blocksToAvoid.has(support.type)) continue
      // Keep the tunnel floor and roof intact. Only open a two-block side pocket in dry, stable rock.
      const blocks = [position, position.offset(0, 1, 0)].map(point => connection.blockAt(point))
      if (blocks.some(block => !block || !(EMPTY_BLOCK.test(block.name) || FURNACE_CLEARANCE_BLOCKS.has(block.name)) ||
          runtimeState.supplyBase.owns(connection, block.position) || runtimeState.supplyStation.protects(connection, block.position))) continue
      const blockers = blocks.filter(block => FURNACE_CLEARANCE_BLOCKS.has(block.name)).toReversed()
      if (!blockers.length || !furnaceBlockVisible(connection, blockers[0])) continue
      const exposed = blocks.flatMap(({ position: point }) => [
        ...SIDES.map(([dx, dz]) => connection.blockAt(point.offset(dx, 0, dz))),
        connection.blockAt(point.offset(0, 1, 0)),
      ])
      if (exposed.some(block => !block || WATER_BLOCK_NAMES.has(block.name) || /^(lava|gravel|.*sand|.*concrete_powder)$/.test(block.name) ||
          block.getProperties?.().waterlogged === true)) continue
      for (const block of blockers) {
        if (!features.canWorkHere(connection) || furnaceThreat() || !furnaceBlockVisible(connection, block) ||
            !await features.digWithExposure(block, FURNACE_CLEARANCE_BLOCKS)) return false
      }
      features.log('cleared safe alcove for furnace', { position, blocks: blockers.map(block => block.name) })
      return true
    }
    return false
  }

  async function reclaimTemporaryFurnace(pending = runtimeState.temporaryFurnace) {
    if (!pending) return true
    const connection = runtimeState.bot
    if (runtimeState.pendingFurnaceBatch || !features.canWorkHere(connection) || connection.game.dimension !== pending.dimension) return false
    const position = new Vec3(pending.position.x, pending.position.y, pending.position.z)
    try {
      if (!pending.broken) {
        const furnace = connection.blockAt(position)
        if (!furnace) return false
        if (furnace.name !== FURNACE_NAME) {
          if (runtimeState.temporaryFurnace === pending) runtimeState.temporaryFurnace = null
          return true
        }
        pending.countBefore = features.inventoryItemCount(FURNACE_NAME)
        const pickaxe = connection.inventory.items().find(item => item.name.endsWith('_pickaxe'))
        if (!pickaxe) return false
        await features.clearBackpack(connection, 'furnace-recovery')
        const inventory = connection.inventory
        const room = inventory.slots.slice(inventory.inventoryStart, inventory.inventoryEnd)
          .some(item => !item || (item.name === FURNACE_NAME && item.count < item.stackSize))
        if (!room) {
          features.log('furnace reclaim deferred; inventory full', { position })
          return false
        }
        await connection.equip(pickaxe, 'hand')
        if (!features.canWorkHere(connection) || !connection.heldItem?.name.endsWith('_pickaxe')) return false
        let timer
        try {
          const digTime = Math.max(500, Number(connection.digTime(furnace) || 1500))
          const timeoutMs = Math.max(10000, Math.ceil(digTime * 2) + 4000)
          await Promise.race([
            connection.dig(furnace, true),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error('furnace dig timeout'))
                if (connection.targetDigBlock?.position.equals(position)) connection.stopDigging()
              }, timeoutMs)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (connection.blockAt(position)?.name === FURNACE_NAME) return false
        pending.broken = true
      }
      if (!await features.pickUpBlockDrop(FURNACE_NAMES, position, pending.countBefore)) {
        if (!features.canWorkHere(connection) || furnaceThreat()) return false
        pending.pickupFailures = (pending.pickupFailures ?? 0) + 1
        if (pending.pickupFailures < FURNACE_PICKUP_LIMIT) {
          features.log('furnace pickup pending', { position, attempts: pending.pickupFailures })
          return false
        }
        // Only empty, already-broken fixtures reach this branch. Leave the item in the world.
        if (runtimeState.temporaryFurnace === pending) runtimeState.temporaryFurnace = null
        features.log('empty furnace drop unreachable; resuming survival', { position, attempts: pending.pickupFailures })
        features.persistExperience({ cycle: runtimeState.cycle, action: 'reclaim-furnace-deferred',
          experience: '空熔炉掉落无法拾取，有限重试后继续生存，避免反复卡在回收任务' })
        return true
      }
      if (runtimeState.temporaryFurnace === pending) runtimeState.temporaryFurnace = null
      features.log('temporary furnace reclaimed', { position })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'reclaim-furnace', experience: '冶炼完成后使用镐子拆下并捡回熔炉' })
      return true
    } catch (error) {
      features.log('furnace reclaim failed', { position, message: error.message })
      return false
    }
  }

  function furnaceFuelSeconds(item) {
    if (!item) return 0
    if (item.name === 'coal' || item.name === 'charcoal') return 80
    if (item.name === 'stick') return 5
    if (/_(planks|log|wood)$/.test(item.name)) return 15
    return 0
  }

  function furnaceInventory(window) {
    return window.slots.slice(window.inventoryStart, window.inventoryEnd)
  }

  async function takeFurnaceSlot(connection, window, read, take, slot) {
    let item = window[read]()
    if (!item) return 0
    if (connection.currentWindow !== window) throw new Error('furnace window was closed')
    await features.clearBackpack(connection, 'furnace-contents', { window, keep: new Set([item.name]) })
    if (connection.currentWindow !== window) throw new Error('furnace window was closed')
    item = window[read]()
    if (!item) return 0
    const room = furnaceInventory(window).reduce((total, stack) => {
      if (!stack) return total + item.stackSize
      return total + (item.constructor.equal(item, stack, false, true) ? stack.stackSize - stack.count : 0)
    }, 0)
    if (room < item.count) throw new Error('inventory has no room for furnace ' + slot)
    await window[take]()
    const remaining = window[read]()
    if (remaining) throw new Error('furnace ' + slot + ' did not clear')
    return item.count
  }

  async function drainFurnace(connection, window) {
    const recovered = { input: 0, output: 0, fuel: 0 }
    // Take input first to stop the furnace making more output during cleanup.
    for (const [slot, read, take] of [
      ['input', 'inputItem', 'takeInput'],
      ['output', 'outputItem', 'takeOutput'],
      ['fuel', 'fuelItem', 'takeFuel'],
    ]) {
      try {
        recovered[slot] = await takeFurnaceSlot(connection, window, read, take, slot)
      } catch (error) {
        features.log('furnace slot recovery deferred', { slot, message: error.message })
      }
    }
    return recovered
  }

  function furnaceBlockVisible(connection, block) {
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const ray = block.position.offset(0.5, 0.5, 0.5).minus(eyes)
    const distance = ray.norm()
    return distance <= 4 && Boolean(connection.world.raycast(eyes, ray.unit(), distance)?.position.equals(block.position))
  }

  function furnaceReachable(connection, block) {
    return block?.name === FURNACE_NAME && furnaceBlockVisible(connection, block)
  }

  function furnaceThreat() {
    const hostile = features.findNearestHostile(8)
    return hostile && features.hostileSight(hostile).visible
  }

  async function finishFurnaceWork(connection, openWindow = null, mayApproach = false) {
    const pending = runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace
    if (!pending || !features.canWorkHere(connection) || connection.game.dimension !== pending.dimension || furnaceThreat()) return false
    const { position } = pending
    let window = openWindow
    try {
      let block = connection.blockAt(position)
      if (mayApproach && !furnaceReachable(connection, block) && !runtimeState.temporaryFurnace?.broken) {
        await features.gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world), 'furnace recovery path', 6000)
        block = connection.blockAt(position)
      }
      if (!features.canWorkHere(connection) || furnaceThreat()) return false
      if (runtimeState.pendingFurnaceBatch) {
        if (block && block.name !== FURNACE_NAME) {
          features.log('furnace batch block missing', { position })
          runtimeState.pendingFurnaceBatch = null
        } else {
          if (connection.currentWindow !== window) window = null
          if (!window) {
            if (!furnaceReachable(connection, block)) return false
            window = await connection.openFurnace(block)
          }
          const recovered = await drainFurnace(connection, window)
          runtimeState.pendingFurnaceBatch.collected += recovered.output
          features.log('furnace contents recovered', { position, ...recovered })
          if (window.inputItem() || window.outputItem() || window.fuelItem()) return false
          runtimeState.pendingFurnaceBatch = null
        }
      }
    } catch (error) {
      features.log('furnace cleanup deferred', { position, message: error.message })
      return false
    } finally {
      if (window && connection.currentWindow === window) window.close()
    }
    return reclaimTemporaryFurnace()
  }

  async function processFurnaceBatch(inputNames, outputEvent, timeLimit, acceptsFuel = () => true, maxInput = Infinity) {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection) || runtimeState.isSmelting || runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace || runtimeState.pendingIronWorkshop) return false
    if (!connection.inventory.items().some(item => inputNames.has(item.name)) ||
        !connection.inventory.items().some(item => acceptsFuel(item) && furnaceFuelSeconds(item) > 0) || furnaceThreat()) return false

    runtimeState.isSmelting = true
    runtimeState.mineMode = false
    let window = null
    let batch = null
    try {
      const block = await ensureFurnace()
      if (!block || !features.canWorkHere(connection)) return false
      window = await connection.openFurnace(block)
      // Borrow an existing furnace only if the player has left it empty.
      if (window.inputItem() || window.outputItem() || window.fuelItem()) {
        features.log('furnace batch skipped; furnace slots are occupied', { position: block.position })
        return false
      }
      const raw = furnaceInventory(window).find(item => item && inputNames.has(item.name))
      if (!raw) return false
      batch = { position: block.position, dimension: connection.game.dimension, collected: 0 }
      runtimeState.pendingFurnaceBatch = batch
      const batchSize = Math.min(raw.count, maxInput)
      await window.putInput(raw.type, null, batchSize)
      features.log('furnace batch started', { item: raw.name, count: batchSize, position: block.position })
      const deadline = Date.now() + Math.min(timeLimit, batchSize * 11000 + 5000)
      while (Date.now() < deadline && features.canWorkHere(connection) && connection.currentWindow === window) {
        if (furnaceThreat()) {
          features.log('furnace batch interrupted by nearby threat')
          break
        }
        batch.collected += await takeFurnaceSlot(connection, window, 'outputItem', 'takeOutput', 'output')
        const input = window.inputItem()
        if (!input) break
        const burning = connection.blockAt(block.position)?.getProperties().lit ?? ((window.fuel ?? 0) > 0)
        if (!window.fuelItem() && !burning) {
          const fuel = furnaceInventory(window).filter(Boolean)
            .filter(item => acceptsFuel(item) && furnaceFuelSeconds(item) > 0)
            .sort((a, b) => furnaceFuelSeconds(b) - furnaceFuelSeconds(a) ||
              Number(b.name === 'coal') - Number(a.name === 'coal'))[0]
          if (!fuel) {
            features.log('furnace fuel exhausted; recovering unprocessed input', { remaining: input.count })
            break
          }
          const count = Math.min(fuel.count, Math.ceil(input.count * 10 / furnaceFuelSeconds(fuel)))
          await window.putFuel(fuel.type, null, count)
          features.log('replenished furnace fuel', { item: fuel.name, count, remaining: input.count })
        }
        await new Promise(resolve => setTimeout(resolve, 800))
      }
    } catch (error) {
      features.log('furnace batch interrupted', { message: error.message })
    } finally {
      try {
        await finishFurnaceWork(connection, window)
      } finally {
        if (window && connection.currentWindow === window) window.close()
        runtimeState.isSmelting = false
      }
    }
    if (!batch?.collected) return false
    features.log(outputEvent, { count: batch.collected })
    return true
  }

  async function withIronFurnace(connection, station, visit) {
    const block = connection.blockAt(station.position)
    if (!features.canWorkHere(connection) || furnaceThreat() || !furnaceReachable(connection, block)) return false
    const window = await connection.openFurnace(block)
    try {
      return await visit(window)
    } finally {
      if (connection.currentWindow === window) window.close()
    }
  }

  async function recoverIronWorkshop(connection, mayApproach = false) {
    const workshop = runtimeState.pendingIronWorkshop
    if (!workshop || !features.canWorkHere(connection) || workshop.dimension !== connection.game.dimension || furnaceThreat()) return false
    for (const station of [...workshop.stations]) {
      if (!features.canWorkHere(connection) || furnaceThreat()) break
      try {
        let block = connection.blockAt(station.position)
        if (mayApproach && !station.broken && !furnaceReachable(connection, block)) {
          await features.gotoWithTimeout(new goals.GoalLookAtBlock(station.position, connection.world), 'iron workshop recovery path', 6000)
          block = connection.blockAt(station.position)
        }
        if (!features.canWorkHere(connection) || furnaceThreat()) break
        if (station.loaded && !station.broken && (!block || block.name === FURNACE_NAME)) {
          const cleared = await withIronFurnace(connection, station, async window => {
            const recovered = await drainFurnace(connection, window)
            workshop.collected += recovered.output
            features.log('furnace contents recovered', { position: station.position, ...recovered })
            return !window.inputItem() && !window.outputItem() && !window.fuelItem()
          })
          if (!cleared) continue
          station.loaded = false
        }
        if (await reclaimTemporaryFurnace(station)) workshop.stations.splice(workshop.stations.indexOf(station), 1)
      } catch (error) {
        features.log('iron workshop recovery deferred', { position: station.position, message: error.message })
      }
    }
    if (workshop.stations.length) return false
    runtimeState.pendingIronWorkshop = null
    features.log('iron workshop recovered', { collected: workshop.collected })
    return true
  }

  async function smeltRawIron() {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection) || runtimeState.isSmelting || runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace || runtimeState.pendingIronWorkshop || furnaceThreat() || features.foodRecoveryNeeded()) return false
    const rawCount = features.inventoryCount(IRON_INPUT_NAMES)
    const fuelCount = features.inventoryCount(IRON_FUEL_NAMES)
    if (!rawCount || !fuelCount) return false
    const stations = []
    const workshop = { dimension: connection.game.dimension, stations, collected: 0 }
    runtimeState.pendingIronWorkshop = workshop
    runtimeState.isSmelting = true
    runtimeState.mineMode = false
    let crafted = false
    try {
      const count = Math.min(3, Math.ceil(rawCount / 8), fuelCount)
      while (stations.length < count && !furnaceThreat()) {
        if (!await ensureFurnace(stations)) break
      }
      let longestBatch = 0
      for (let i = 0; i < stations.length; i += 1) {
        const station = stations[i]
        await withIronFurnace(connection, station, async window => {
          if (window.inputItem() || window.outputItem() || window.fuelItem()) return
          const items = furnaceInventory(window).filter(Boolean)
          const raw = items.find(item => IRON_INPUT_NAMES.has(item.name))
          const coal = items.find(item => item.name === 'coal') || items.find(item => item.name === 'charcoal')
          if (!raw || !coal) return
          const totalRemaining = features.inventoryCount(IRON_INPUT_NAMES)
          const remainingStations = stations.length - i
          const portion = Math.min(raw.count, Math.ceil(totalRemaining / remainingStations), coal.count * 8,
            Math.max(1, features.inventoryCount(IRON_FUEL_NAMES) - remainingStations + 1) * 8)
          station.loaded = true
          await window.putFuel(coal.type, null, Math.ceil(portion / 8))
          await window.putInput(raw.type, null, portion)
          longestBatch = Math.max(longestBatch, portion)
          features.log('iron furnace started', { position: station.position, input: raw.name, count: portion, fuel: coal.name })
        })
      }
      features.log('iron workshop started', { furnaces: stations.filter(station => station.loaded).length, rawCount })
      const deadline = Date.now() + longestBatch * 11000 + 8000
      while (longestBatch && Date.now() < deadline && features.canWorkHere(connection) && !furnaceThreat() && !features.foodRecoveryNeeded()) {
        let running = false
        for (const station of stations.filter(entry => entry.loaded)) {
          const result = await withIronFurnace(connection, station, async window => {
            const collected = await takeFurnaceSlot(connection, window, 'outputItem', 'takeOutput', 'output')
            if (collected) {
              workshop.collected += collected
              features.log('iron furnace output collected', { position: station.position, count: collected })
            }
            return { running: Boolean(window.inputItem()) }
          })
          running ||= Boolean(result?.running)
        }
        if (!furnaceThreat()) crafted = (await features.craftAvailableGear(false)) || crafted
        if (!running) break
        await new Promise(resolve => setTimeout(resolve, 1200))
      }
    } catch (error) {
      features.log('iron workshop interrupted', { message: error.message })
    } finally {
      try { await recoverIronWorkshop(connection) } finally { runtimeState.isSmelting = false }
    }
    if (workshop.collected) features.log('collected smelted iron ingots from furnace', { count: workshop.collected })
    return crafted || workshop.collected > 0
  }

  return {
    furnaceThreat,
    finishFurnaceWork,
    processFurnaceBatch,
    recoverIronWorkshop,
    smeltRawIron,
  }
}

module.exports = createSmelting
