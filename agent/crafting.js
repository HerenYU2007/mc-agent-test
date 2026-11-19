const { goals } = require('mineflayer-pathfinder')
const { LOG_NAMES, TABLE_NAME, TABLE_NAMES, TABLE_TOP, EMPTY_BLOCK, TUNNEL_SAFE_BLOCKS } = require('./config')

function createCrafting(runtimeState, features) {
  let temporaryCraftingTable = null

  let lastTorchAttemptAt = 0

  const deferredCraftingTables = []

  async function craftNamed(name, table = null) {
    const connection = runtimeState.bot
    const item = runtimeState.mcData?.itemsByName?.[name]
    if (!item) return false
    const inventory = connection.inventory
    for (let attempt = 0; attempt < 3 && features.canWorkHere(connection); attempt += 1) {
      if (connection.currentWindow) connection.closeWindow(connection.currentWindow)
      await features.clearBackpack(connection, 'crafting')
      await connection._syncWindow?.(inventory)
      // Clear inputs left in the backpack crafting grid after a refused click.
      if (inventory.selectedItem) {
        const empty = inventory.firstEmptyInventorySlot()
        if (empty == null) return false
        await connection.clickWindow(empty, 0, 0)
      }
      for (let slot = 1; slot <= 4; slot += 1) {
        if (inventory.slots[slot]) await connection.clickWindow(slot, 0, 1)
      }
      const recipe = connection.recipesFor(item.id, null, 1, table)[0]
      if (!recipe || !features.canWorkHere(connection)) return false
      const before = features.inventoryItemCount(name)
      let error
      try {
        await connection.craft(recipe, 1, table)
      } catch (failure) {
        error = failure
      }
      await connection._syncWindow?.(inventory)
      if (connection !== runtimeState.bot) return false
      const gained = features.inventoryItemCount(name) - before
      if (gained >= recipe.result.count) {
        features.log('crafted', { item: name, count: gained })
        return true
      }
      features.log('craft result not confirmed', { item: name, gained, attempt: attempt + 1, message: error?.message })
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    return false
  }

  function plankCount() {
    return runtimeState.bot.inventory.items().reduce((sum, item) => sum + (item.name.endsWith('_planks') ? item.count : 0), 0)
  }

  async function makePlanksFor(required, exact = null) {
    while ((exact ? features.inventoryItemCount(exact) : plankCount()) < required) {
      const logItem = runtimeState.bot.inventory.items().find(item => LOG_NAMES.has(item.name) &&
        (!exact || item.name.replace(/_log$/, '_planks') === exact))
      if (!logItem || !await craftNamed(logItem.name.replace(/_log$/, '_planks'))) return false
    }
    return true
  }

  function isTableSite(connection, position) {
    const support = connection.blockAt(position.offset(0, -1, 0))
    const isSolidSupport = support?.shapes?.some(shape => shape[0] === 0 && shape[1] === 0 && shape[2] === 0 &&
      shape[3] === 1 && shape[4] === 1 && shape[5] === 1) || support?.boundingBox === 'block'
    return Boolean(isSolidSupport &&
      !runtimeState.movements.interactableBlocks.has(support.name) && !runtimeState.movements.blocksToAvoid.has(support.type) &&
      EMPTY_BLOCK.test(connection.blockAt(position)?.name))
  }

  async function maybePlaceTorch(duringMining = false) {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection, duringMining) || runtimeState.isSmelting || runtimeState.isEating || runtimeState.isDiggingBlock ||
        !connection.entity.onGround || features.furnaceThreat() || Date.now() - lastTorchAttemptAt < 1500) return false
    const torch = connection.inventory.items().find(item => item.name === 'torch')
    if (!torch) return false
    const feet = connection.entity.position.floored()
    const current = connection.blockAt(feet)
    if (!current || !Number.isFinite(current.light) || !Number.isFinite(current.skyLight)) return false
    const sky = Math.max(0, current.skyLight - (connection.time.isDay ? 0 : 11))
    const light = Math.max(current.light, sky)
    if (light >= 8) return false
    lastTorchAttemptAt = Date.now()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const position = feet.offset(dx, 0, dz)
      if (!isTableSite(connection, position)) continue
      const support = connection.blockAt(position.offset(0, -1, 0))
      const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      const ray = position.offset(0.5, -0.02, 0.5).minus(eyes)
      if (!connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
      try {
        await connection.equip(torch, 'hand')
        if (!features.canWorkHere(connection, duringMining) || features.furnaceThreat()) return false
        await connection.placeBlock(support, TABLE_TOP)
        if (connection.blockAt(position)?.name !== 'torch') continue
        features.log('dark area torch placed', { position, light })
        return true
      } catch (error) {
        features.log('torch placement deferred', { position, message: error.message })
      }
    }
    return false
  }

  async function clearSpaceForCraftingTable(connection, base) {
    if (!connection?.entity || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const candidates = []
    for (const [dx, dz] of directions) {
      const pos = base.offset(dx, 0, dz)
      const support = connection.blockAt(pos.offset(0, -1, 0))
      if (!support || (support.boundingBox !== 'block' && !support.shapes?.some(shape =>
        shape[0] === 0 && shape[1] === 0 && shape[2] === 0 && shape[3] === 1 && shape[4] === 1 && shape[5] === 1))) continue
      const block = connection.blockAt(pos)
      if (!block) continue
      if (EMPTY_BLOCK.test(block.name)) {
        const above = connection.blockAt(pos.offset(0, 1, 0))
        if (above && above.boundingBox === 'block' && TUNNEL_SAFE_BLOCKS.has(above.name) && connection.canDigBlock(above)) {
          candidates.push({ pos, toDig: [above], cost: 1 })
        }
        continue
      }
      if (TUNNEL_SAFE_BLOCKS.has(block.name) && connection.canDigBlock(block)) {
        const above = connection.blockAt(pos.offset(0, 1, 0))
        const toDig = [block]
        if (above && above.boundingBox === 'block' && TUNNEL_SAFE_BLOCKS.has(above.name) && connection.canDigBlock(above)) {
          toDig.push(above)
        }
        const isSoft = /^(dirt|grass_block|sand|gravel|podzol|coarse_dirt)$/.test(block.name)
        candidates.push({ pos, toDig, cost: isSoft ? 1 : 5 })
      }
    }
    candidates.sort((a, b) => a.cost - b.cost)
    for (const candidate of candidates) {
      try {
        for (const b of candidate.toDig) {
          if (!connection.canDigBlock(b)) continue
          await features.equipBestToolFor(b)
          features.log('digging clearance for crafting table', { block: b.name, position: b.position })
          await connection.dig(b, true)
        }
        return true
      } catch (error) {
        features.log('clearance dig failed', { position: candidate.pos, message: error.message })
      }
    }
    return false
  }

  async function ensureCraftingTable(allowRelocate = true) {
    const connection = runtimeState.bot
    if (!features.canWorkHere(connection)) return null
    const table = features.findNearestBlock(TABLE_NAMES, 4)
    if (table && table.position.offset(0.5, 0.5, 0.5).distanceTo(connection.entity.position.offset(0, 1.62, 0)) <= 4) {
      if (connection.canSeeBlock(table)) {
        const old = deferredCraftingTables.findIndex(entry => entry.dimension === connection.game.dimension &&
          entry.position.equals(table.position))
        if (!temporaryCraftingTable && old >= 0) temporaryCraftingTable = deferredCraftingTables.splice(old, 1)[0]
        return table
      }
    }
    if (temporaryCraftingTable) {
      deferredCraftingTables.push(temporaryCraftingTable)
      features.log('distant crafting table deferred', { position: temporaryCraftingTable.position })
      temporaryCraftingTable = null
    }
    if (features.inventoryItemCount(TABLE_NAME) === 0 && !await makePlanksFor(4)) return null
    if (features.inventoryItemCount(TABLE_NAME) === 0 && !await craftNamed(TABLE_NAME)) return null
    const held = runtimeState.bot.inventory.items().find(item => item.name === TABLE_NAME)
    if (!held) return null
    const base = connection.entity.position.floored()
    const spots = []
    for (const y of [0, -1, 1, -2, 2]) {
      for (let x = -3; x <= 3; x += 1) {
        for (let z = -3; z <= 3; z += 1) {
          if (x === 0 && z === 0) continue
          spots.push(base.offset(x, y, z))
        }
      }
    }
    spots.sort((a, b) => a.distanceTo(base) - b.distanceTo(base))
    for (const position of spots) {
      if (!features.canWorkHere(connection)) return null
      if (!isTableSite(connection, position)) continue
      const support = connection.blockAt(position.offset(0, -1, 0))
      const hit = position.offset(0.5, -0.02, 0.5)
      const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      const ray = hit.minus(eyes)
      if (ray.norm() > 4 || !connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
      try {
        await connection.equip(held, 'hand')
        if (!features.canWorkHere(connection)) return null
        await connection.placeBlock(support, TABLE_TOP)
      } catch (error) {
        features.log('crafting table placement skipped', { position, message: error.message })
      }
      const placed = connection.blockAt(position)
      if (placed?.name === TABLE_NAME) {
        temporaryCraftingTable = { position, dimension: connection.game.dimension, broken: false }
        features.log('temporary crafting table placed', { position })
        return placed
      }
      if (!connection.inventory.items().some(item => item.name === TABLE_NAME)) return null
    }
    if (allowRelocate && features.canWorkHere(connection)) {
      const groundNames = new Set(['grass_block', 'dirt', 'coarse_dirt', 'stone', 'sand', 'podzol', 'moss_block'])
      const candidates = connection.findBlocks({
        maxDistance: 14,
        count: 16,
        matching: block => groundNames.has(block.name),
        useExtraInfo: block => isTableSite(connection, block.position.offset(0, 1, 0)) &&
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => isTableSite(connection, block.position.offset(x, 1, z))),
      })
      if (candidates.length) {
        const goal = new goals.GoalCompositeAny(candidates.map(({ x, y, z }) => new goals.GoalBlock(x, y + 1, z)))
        try {
          await features.gotoWithTimeout(goal, 'crafting table ground', 6000)
          return await ensureCraftingTable(false)
        } catch (error) {
          features.log('crafting table relocation failed', { message: error.message })
        }
      }
    }
    if (features.canWorkHere(connection)) {
      const cleared = await clearSpaceForCraftingTable(connection, base)
      if (cleared) {
        return await ensureCraftingTable(false)
      }
    }
    features.log('crafting table placement skipped', { message: 'no reachable clear space beside the bot' })
    return null
  }

  async function pickUpBlockDrop(names, position, countBefore, duringMining = false) {
    const connection = runtimeState.bot
    for (let attempt = 0; attempt < 2 && features.canWorkHere(connection, duringMining); attempt += 1) {
      // Drops usually fly into reach within ~150ms; the old fixed 400ms wait was
      // the visible "hitch" after every block. Poll briefly instead of sleeping.
      const waitUntil = Date.now() + (attempt === 0 ? 200 : 400)
      while (Date.now() < waitUntil && features.inventoryCount(names) <= countBefore) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      if (!features.canWorkHere(connection, duringMining)) return false
      if (features.inventoryCount(names) > countBefore) return true
      await features.clearBackpack(connection, 'block-drop', { duringMining, keep: names })
      const drop = features.findNearbyDrops(8).find(({ entity }) => {
        if (entity.position.distanceTo(position.offset(0.5, 0.5, 0.5)) > 4) return false
        try { return names.has(entity.getDroppedItem()?.name) } catch { return false }
      })?.entity
      if (drop) {
        const feet = drop.position.offset(0, 0.05, 0).floored()
        try {
          await features.gotoWithTimeout(new goals.GoalBlock(feet.x, feet.y, feet.z), 'drop pickup', 2500)
        } catch (error) {
          features.log('drop approach interrupted', { position: feet, message: error.message })
        }
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
    return connection === runtimeState.bot && features.inventoryCount(names) > countBefore
  }

  async function reclaimTemporaryCraftingTable() {
    const pending = temporaryCraftingTable
    const connection = runtimeState.bot
    if (!pending || !features.canWorkHere(connection) || pending.dimension !== connection.game.dimension) return false
    const { position } = pending
    try {
      if (!pending.broken) {
        let table = connection.blockAt(position)
        if (!table) return false
        if (table.name !== TABLE_NAME) {
          temporaryCraftingTable = null
          return false
        }
        if (!connection.canDigBlock(table) || !connection.canSeeBlock(table)) {
          await features.gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world), 'crafting table reclaim path', 5000)
          table = connection.blockAt(position)
        }
        if (!features.canWorkHere(connection) || table?.name !== TABLE_NAME || !connection.canDigBlock(table) ||
            !connection.canSeeBlock(table)) return false
        await features.clearBackpack(connection, 'crafting-table-recovery')
        pending.countBefore = features.inventoryItemCount(TABLE_NAME)
        await features.equipBestToolFor(table)
        if (!features.canWorkHere(connection)) return false
        let timer
        try {
          const tableDigTime = Math.max(250, Number(connection.digTime(table) || 1000))
          const tableTimeout = Math.max(8000, Math.ceil(tableDigTime * 2) + 3000)
          await Promise.race([
            connection.dig(table, true),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                reject(new Error('crafting table dig timeout'))
                if (connection.targetDigBlock?.position.equals(position)) connection.stopDigging()
              }, tableTimeout)
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
        if (connection.blockAt(position)?.name === TABLE_NAME) return false
        pending.broken = true
      }
      if (!await pickUpBlockDrop(TABLE_NAMES, position, pending.countBefore)) {
        features.log('crafting table pickup pending', { position })
        return false
      }
      temporaryCraftingTable = null
      features.log('temporary crafting table reclaimed', { position })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'reclaim-table', experience: '工具合成完成后拆下临时工作台，已确认工作台进入背包' })
      return true
    } catch (error) {
      features.log('crafting table reclaim failed', { position, message: error.message })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'reclaim-table', experience: `临时工作台回收失败：${error.message}` })
      return false
    }
  }

  return {
    craftNamed,
    plankCount,
    makePlanksFor,
    isTableSite,
    maybePlaceTorch,
    ensureCraftingTable,
    pickUpBlockDrop,
    reclaimTemporaryCraftingTable,
  }
}

module.exports = createCrafting
