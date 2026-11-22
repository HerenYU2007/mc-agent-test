const { goals } = require('mineflayer-pathfinder')
const { EMPTY_BLOCK, TUNNEL_SAFE_BLOCKS } = require('./config')

function createDigging(runtimeState, features) {
  function toolDurability(item) {
    const max = item?.maxDurability ?? runtimeState.mcData?.items[item?.type]?.maxDurability
    return max ? Math.max(0, max - (item.durabilityUsed ?? 0)) : Infinity
  }

  function blockDigTimeWith(connection, block, item) {
    const helmet = connection.inventory.slots[connection.getEquipmentDestSlot('head')]
    const corrected = String(block.material || '').startsWith('incorrect_for_') &&
      connection.registry.materials['mineable/pickaxe']
    // Do not mutate the cached world block when fixing the 26.1 ore material.
    const probe = corrected ? Object.create(block, { material: { value: 'mineable/pickaxe' } }) : block
    return probe.digTime(item?.type ?? null, connection.game.gameMode === 'creative',
      ['water', 'flowing_water'].includes(connection._getBlockAtEyeLevel?.()?.name),
      !connection.entity.onGround, [...(item?.enchants || []), ...(helmet?.enchants || [])], connection.entity.effects)
  }

  async function equipBestToolFor(block) {
    const connection = runtimeState.bot
    if (!block || !connection?.entity) return false
    const held = connection.heldItem
    const items = connection.inventory.items()
    const isTool = item => /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|trident)$/.test(item?.name || '')
    const usable = items.filter(isTool)
    if (!isTool(held)) usable.push(held ?? null)
    else usable.push(items.find(item => !Number.isFinite(toolDurability(item))) ?? null)
    const ranked = usable.filter(item => block.canHarvest(item?.type ?? null)).map(item => ({
      item, duration: blockDigTimeWith(connection, block, item), remaining: toolDurability(item)
    })).filter(choice => Number.isFinite(choice.duration))
    ranked.sort((a, b) => Number(a.remaining <= 2) - Number(b.remaining <= 2) ||
      a.duration - b.duration ||
      Number(a.item !== held) - Number(b.item !== held) ||
      (a.remaining < b.remaining ? 1 : a.remaining > b.remaining ? -1 : 0))
    const best = ranked[0]
    if (!best) {
      features.log('no suitable harvesting tool', { block: block.name })
      return false
    }
    try {
      if (best.item && held?.slot !== best.item.slot) await connection.equip(best.item, 'hand')
      if (!best.item && held) await connection.unequip('hand')
      const tool = connection.heldItem?.name ?? 'hand'
      features.log('tool equipped', { block: block.name, tool, estimatedMs: best.duration })
      return Boolean(block.canHarvest(connection.heldItem?.type ?? null))
    } catch (error) {
      features.log('tool equip failed', { block: block.name, message: error.message })
      return false
    }
  }

  // Dig the first solid block between the bot's eyes and `target`. Gravel/sand
  // (falling blocks), fluids and anything not on the safe list are never touched.
  async function clearBlockerFor(target, interrupted = () => false) {
    const connection = runtimeState.bot
    if (!connection?.entity || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const aim = target.position.offset(0.5, 0.5, 0.5)
    const ray = aim.minus(eyes)
    const range = ray.norm()
    if (range > 5) return false
    const hit = connection.world.raycast(eyes, ray.unit(), range)
    const blocker = hit ? connection.blockAt(hit.position ?? hit) : null
    if (!blocker || blocker.position.equals(target.position)) return false
    if (runtimeState.supplyBase.owns(connection, blocker.position)) return false
    if (runtimeState.mineBusy && features.isOreName(blocker.name)) return false
    if (!TUNNEL_SAFE_BLOCKS.has(blocker.name) || !connection.canDigBlock(blocker)) return false
    // Never dig out the block under the bot's feet.
    const feet = connection.entity.position.floored()
    if (blocker.position.x === feet.x && blocker.position.z === feet.z && blocker.position.y < feet.y) return false
    try {
      if (!await equipBestToolFor(blocker) || interrupted()) return false
      features.log('clearing blocker for target', { blocker: blocker.name, blockerPosition: blocker.position, target: target.name })
      await connection.dig(blocker, true)
      return true
    } catch (error) {
      features.log('blocker dig failed', { blocker: blocker.name, message: error.message })
      return false
    }
  }

  async function digWithExposure(target, allowedNames = null, { interrupted = () => false } = {}) {
    const connection = runtimeState.bot
    if (interrupted() || !target || !connection?.entity || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
    let current = connection.blockAt(target.position)
    if (!current || current.type !== target.type || (allowedNames && !allowedNames.has(current.name)) ||
        !connection.canDigBlock(current)) return false

    runtimeState.isDiggingBlock = true
    let timer
    try {
      await equipBestToolFor(current)
      if (interrupted() || connection !== runtimeState.bot || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
      current = connection.blockAt(target.position)
      if (!current || current.type !== target.type) return false

      if (current.harvestTools && !current.canHarvest(connection.heldItem?.type ?? null)) return false

      // Approach block if too far (> 4.2 blocks)
      let eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      let targetCenter = current.position.offset(0.5, 0.5, 0.5)
      if (eyes.distanceTo(targetCenter) > 4.2) {
        try {
          await features.gotoWithTimeout(new goals.GoalNear(current.position.x, current.position.y, current.position.z, 2.5), 'approach dig block', 3500,
            runtimeState.mineBusy ? features.mineRouteOptions(connection) : undefined)
        } catch {}
        if (interrupted() || connection !== runtimeState.bot || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
        current = connection.blockAt(target.position)
        if (!current || current.type !== target.type) return false
      }

      // Clear blocker if line of sight is obstructed
      if (!connection.canSeeBlock(current)) {
        await clearBlockerFor(current, interrupted)
        if (interrupted() || connection !== runtimeState.bot || features.waterOwnsMovement() || runtimeState.emergencyRetreating) return false
        current = connection.blockAt(target.position)
        if (!current || current.type !== target.type) return false
      }

      // Re-equip best tool after clearing blockers (clearBlockerFor switches heldItem to blocker tool)
      await equipBestToolFor(current)
      if (current.harvestTools && !current.canHarvest(connection.heldItem?.type ?? null)) return false

      if (interrupted()) return false
      // Stop lingering movement and settle on ground to prevent in-air 5x dig slowdown
      features.stopPathfinder()
      connection.clearControlStates()
      if (!connection.entity.onGround) {
        const settleStart = Date.now()
        while (!interrupted() && !connection.entity.onGround && Date.now() - settleStart < 350) {
          await new Promise(resolve => setTimeout(resolve, 50))
        }
      }

      if (interrupted()) return false
      // Partial blocks can have air at the center of their block coordinates.
      eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      const samples = [[0.5, 0.5, 0.5]]
      if (current.shapes.some(shape => shape.some((value, index) => value !== Number(index >= 3)))) {
        for (const x of [0.12, 0.88]) for (const y of [0.12, 0.88]) {
          for (const z of [0.12, 0.88]) samples.push([x, y, z])
        }
      }
      const visibleShape = current.shapes.flatMap(([x1, y1, z1, x2, y2, z2]) => samples.map(([x, y, z]) =>
        current.position.offset(x1 + (x2 - x1) * x, y1 + (y2 - y1) * y, z1 + (z2 - z1) * z))).find(point => {
        const ray = point.minus(eyes)
        return connection.world.raycast(eyes, ray.normalize(), 4.5)?.position.equals(current.position)
      })
      targetCenter = visibleShape ?? current.position.offset(0.5, 0.5, 0.5)
      await connection.lookAt(targetCenter, true)
      if (interrupted()) return false
      const hit = connection.blockAtCursor(4.5)
      if (!hit || hit.type !== current.type || !hit.position.equals(current.position)) {
        features.log('dig cancelled; crosshair target changed', { target: current.position, hit: hit?.position ?? null })
        return false
      }

      const expectedTime = Math.max(250, Number(connection.digTime(current) || 1000))
      const timeoutMs = Math.max(10000, Math.ceil(expectedTime * 2) + 5000)

      features.log('digging selected block', { block: current.name, position: current.position, expectedMs: expectedTime, timeoutMs })
      await Promise.race([
        connection.dig(current, 'ignore'),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error('block dig timeout'))
            if (connection.targetDigBlock?.position.equals(current.position)) {
              try { connection.stopDigging() } catch {}
            }
          }, timeoutMs)
        }),
      ])

      // Verify block is broken: check current block state or poll briefly for server block update
      const checkStart = Date.now()
      while (!interrupted() && Date.now() - checkStart < 1200) {
        const checkBlock = connection.blockAt(current.position)
        if (!checkBlock || EMPTY_BLOCK.test(checkBlock.name) || checkBlock.type === 0 || checkBlock.type !== target.type) {
          features.log('dig confirmed broken', { block: current.name, position: current.position, ms: Date.now() - checkStart })
          return true
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }

      if (interrupted()) return false
      const finalCheck = connection.blockAt(current.position)
      if (!finalCheck || EMPTY_BLOCK.test(finalCheck.name) || finalCheck.type === 0 || finalCheck.type !== target.type) {
        return true
      }

      features.log('dig not confirmed by server', { block: current.name, position: current.position })
      return false
    } catch (error) {
      features.log('dig interrupted; replanning', { block: current?.name || target.name, position: target.position, message: error.message })
      return false
    } finally {
      clearTimeout(timer)
      runtimeState.isDiggingBlock = false
    }
  }

  // minecraft-data 26.1 tags ores with material "incorrect_for_<tier>_tool" instead
  // of "mineable/pickaxe", so prismarine-block finds no tool multiplier and
  // mineflayer waits the bare-hand time (4.55s for iron with a stone pickaxe)
  // before sending "finish digging". The server finishes the block in ~1.15s and
  // then sits waiting for that packet, which shows as a stall at full progress.
  // Recompute the delay for those blocks using the pickaxe multiplier table.
  function installDigTimeFix(connection) {
    const original = connection.digTime.bind(connection)
    features.log('dig timing fix installed')
    connection.digTime = block => {
      if (!block || !String(block.material || '').startsWith('incorrect_for_')) return original(block)
      return blockDigTimeWith(connection, block, connection.heldItem)
    }
  }

  return {
    toolDurability,
    equipBestToolFor,
    digWithExposure,
    installDigTimeFix,
  }
}

module.exports = createDigging
