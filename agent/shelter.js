const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { WATER_BLOCK_NAMES, EMPTY_BLOCK } = require('./config')

const WOOL_NAMES = /_wool$/
// "Dig three, fill one": a 1x1 pit three blocks deep, then seal the top.
const EMERGENCY_PIT_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol'])
const SHELTER_FILL = new Set(['dirt', 'cobblestone', 'stone', 'deepslate', 'sand', 'gravel', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'])

function createShelter(runtimeState, features) {
  let nextEmergencyShelterAt = 0

  // Try to make and use a bed: 3 wool + 3 planks. Sheep drop 1 wool; shearing is
  // not available this early, so the bot must kill three sheep (or pick up wool).
  async function tryBed() {
    if (runtimeState.bot.inventory.items().some(item => item.name.endsWith('_bed'))) return true
    const wool = () => runtimeState.bot.inventory.items().filter(item => WOOL_NAMES.test(item.name))
      .reduce((sum, item) => sum + item.count, 0)
    // Hunt sheep that are close enough to reach before dark.
    for (let attempt = 0; attempt < 6 && wool() < 3 && features.canWorkHere(runtimeState.bot); attempt += 1) {
      const sheep = Object.values(runtimeState.bot.entities).find(entity =>
        features.entityNameOf(entity) === 'sheep' && entity.position.distanceTo(runtimeState.bot.entity.position) < 30)
      if (!sheep) break
      try {
        await features.equipCombatItem()
        await features.gotoWithTimeout(new goals.GoalNear(sheep.position.x, sheep.position.y, sheep.position.z, 2), 'sheep approach', 6000)
        for (let swing = 0; swing < 8 && runtimeState.bot.entities[sheep.id]; swing += 1) {
          await runtimeState.bot.lookAt(sheep.position.offset(0, 0.8, 0), true)
          runtimeState.bot.attack(sheep, true)
          await new Promise(resolve => setTimeout(resolve, 450))
        }
        await features.collectNearbyDrops(8)
      } catch (error) {
        features.stopPathfinder()
        features.log('sheep hunt interrupted', { message: error.message })
      }
    }
    if (wool() < 3) return false
    const woolItem = runtimeState.bot.inventory.items().find(item => WOOL_NAMES.test(item.name))
    const colour = woolItem.name.replace(/_wool$/, '')
    if (!await features.makePlanksFor(3)) return false
    const table = await features.ensureCraftingTable()
    const crafted = Boolean(table && await features.craftNamed(`${colour}_bed`, table))
    await features.reclaimTemporaryCraftingTable()
    return crafted
  }

  // Place the bed on a flat spot and sleep. Returns true once the bot slept or
  // set its spawn; false means the caller should fall back to the pit.
  async function placeAndSleep() {
    const bed = runtimeState.bot.inventory.items().find(item => item.name.endsWith('_bed'))
    if (!bed) return false
    const base = runtimeState.bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ground = runtimeState.bot.blockAt(base.offset(dx, -1, dz))
      const above = runtimeState.bot.blockAt(base.offset(dx, 0, dz))
      const farGround = runtimeState.bot.blockAt(base.offset(dx * 2, -1, dz * 2))
      const farAbove = runtimeState.bot.blockAt(base.offset(dx * 2, 0, dz * 2))
      if (ground?.boundingBox !== 'block' || farGround?.boundingBox !== 'block') continue
      if (!EMPTY_BLOCK.test(above?.name) || !EMPTY_BLOCK.test(farAbove?.name)) continue
      try {
        await runtimeState.bot.equip(bed, 'hand')
        await runtimeState.bot.lookAt(ground.position.offset(0.5, 1, 0.5), true)
        await runtimeState.bot.placeBlock(ground, new Vec3(0, 1, 0))
        const placed = runtimeState.bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 4 })
        if (!placed) continue
        await runtimeState.bot.sleep(placed)
        features.log('sleeping in bed', { position: placed.position })
        return true
      } catch (error) {
        features.log('bed use failed', { message: error.message })
        // "not night" or "monsters nearby" still sets the respawn point on use.
        const placed = runtimeState.bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 4 })
        if (placed && /night|monsters|sleep/i.test(error.message)) return false
      }
    }
    return false
  }

  function pitFiller(connection) {
    return connection.inventory.items().find(item =>
      SHELTER_FILL.has(item.name) && item.name !== 'sand' && item.name !== 'gravel')
  }

  async function tryEmergencyPit(connection) {
    if (connection !== runtimeState.bot || connection.health <= 0 || connection.health > 8 ||
        !connection.entity?.onGround || runtimeState.shelterBusy || Date.now() < nextEmergencyShelterAt ||
        runtimeState.impactGuards.has(connection) || features.waterOwnsMovement() || features.findNearestHostile(14) ||
        features.nightShelterTerrain() !== 'open') return false
    const feet = connection.entity.position.floored()
    if (![1, 2, 3].every(depth => EMERGENCY_PIT_SOIL.has(connection.blockAt(feet.offset(0, -depth, 0))?.name))) return false
    const bottom = connection.blockAt(feet.offset(0, -4, 0))
    if (bottom?.boundingBox !== 'block' || WATER_BLOCK_NAMES.has(bottom.name) || bottom.name === 'lava') return false
    if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) =>
      connection.blockAt(feet.offset(x, -1, z))?.boundingBox === 'block')) return false
    nextEmergencyShelterAt = Date.now() + 18000
    runtimeState.shelterBusy = true
    runtimeState.lastDecision = 'emergency-shelter'
    features.log('emergency pit started', { health: connection.health, position: feet })
    try {
      if (!await digPitShelter(true) || connection !== runtimeState.bot || connection.health <= 0) return false
      runtimeState.emergencyShelteredUntil = Date.now() + 12000
      runtimeState.lastCombatDecision = { action: 'flee', reason: '已拉开距离，挖坑封顶避险' }
      features.log('emergency pit sealed', { holdMs: 12000, health: connection.health })
      return true
    } catch (error) {
      features.log('emergency pit interrupted', { message: error.message })
      return false
    } finally {
      runtimeState.shelterBusy = false
    }
  }

  async function digPitShelter(emergency = false) {
    const connection = runtimeState.bot
    if (features.nightShelterTerrain() !== 'open' || (!emergency && !features.isNightShelterTime(runtimeState.bot.time.timeOfDay))) return false
    let start = runtimeState.bot.entity.position.floored()
    const spot = runtimeState.bot.blockAt(start.offset(0, -1, 0))
    if (!spot || spot.boundingBox !== 'block' || WATER_BLOCK_NAMES.has(spot.name)) return false
    let initialFiller = pitFiller(runtimeState.bot)
    if (!emergency && !initialFiller) {
      const soft = features.findNearestBlock(new Set(['dirt', 'grass_block', 'sand']), 3)
      if (soft && features.canWorkHere(runtimeState.bot) && runtimeState.bot.canDigBlock(soft)) {
        try {
          await runtimeState.bot.dig(soft, true)
          await features.pickUpBlockDrop(new Set(['dirt', 'sand']), soft.position, 0)
          if (connection !== runtimeState.bot) return false
          initialFiller = pitFiller(runtimeState.bot)
        } catch {}
      }
    }
    if (!emergency && !initialFiller) {
      features.log('pit shelter skipped; no filler block to seal pit')
      return false
    }
    if (connection !== runtimeState.bot || connection.health <= 0) return false
    start = runtimeState.bot.entity.position.floored()
    runtimeState.mineMode = false
    features.stopPathfinder()
    runtimeState.bot.clearControlStates()
    const firstBlock = connection.blockAt(start.offset(0, -1, 0))
    if (firstBlock) await features.equipBestToolFor(firstBlock)
    for (let depth = 1; depth <= 3; depth += 1) {
      if (connection !== runtimeState.bot || connection.health <= 0 || features.waterOwnsMovement()) return false
      const below = runtimeState.bot.blockAt(runtimeState.bot.entity.position.floored().offset(0, -1, 0))
      if (!below || below.boundingBox !== 'block') break
      // Never dig down into liquid or a cave void: check two blocks down first.
      const under = runtimeState.bot.blockAt(below.position.offset(0, -1, 0))
      if (!under || WATER_BLOCK_NAMES.has(under.name) || under.name === 'lava' || under.boundingBox !== 'block') break
      try {
        await runtimeState.bot.dig(below, true)
        await new Promise(resolve => setTimeout(resolve, 350))
      } catch (error) {
        features.log('pit dig failed', { depth, message: error.message })
        break
      }
    }
    const floorY = Math.floor(runtimeState.bot.entity.position.y)
    if (start.y - floorY < 2) return false
    if (emergency && !pitFiller(connection)) await new Promise(resolve => setTimeout(resolve, 200))
    if (connection !== runtimeState.bot || connection.health <= 0) return false
    const filler = pitFiller(runtimeState.bot)
    if (!filler) return false
    // Seal the hole above. The bot's head is at floorY + 1; the cell to close is
    // floorY + 2 in the same column. A block is placed ON a face of a reference
    // block, so use the pit wall one level up (floorY + 2) beside that cell and
    // click its face that looks into the column, i.e. the direction (-dx, 0, -dz).
    const column = { x: start.x, z: start.z }
    const sealCell = runtimeState.bot.blockAt(new Vec3(column.x, floorY + 2, column.z))
    if (!sealCell || !EMPTY_BLOCK.test(sealCell.name)) return false
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wall = runtimeState.bot.blockAt(new Vec3(column.x + dx, floorY + 2, column.z + dz))
      if (!wall || wall.boundingBox !== 'block') continue
      try {
        await runtimeState.bot.equip(filler, 'hand')
        await runtimeState.bot.look(Math.atan2(dx, dz) + Math.PI, -0.9, true) // look up-and-across toward the cell
        await runtimeState.bot.placeBlock(wall, new Vec3(-dx, 0, -dz))
        if (!EMPTY_BLOCK.test(runtimeState.bot.blockAt(sealCell.position)?.name)) {
          runtimeState.shelterInfo = { kind: 'pit', seal: sealCell.position }
          features.log('pit sealed', { depth: start.y - floorY, at: { x: column.x, y: floorY, z: column.z } })
          return true
        }
      } catch (error) {
        features.log('pit seal skipped', { wall: wall.position, message: error.message })
      }
    }
    return false
  }

  // Night 1 route from the guide: sheep -> bed; no sheep -> pit; last resort walls.
  async function firstNightShelter() {
    if (runtimeState.shelterBusy || features.nightShelterTerrain() !== 'open' || !features.isNightShelterTime(runtimeState.bot.time.timeOfDay)) return false
    runtimeState.shelterBusy = true
    try {
      runtimeState.mineMode = false
      features.stopPathfinder()
      if (await tryBed() && await placeAndSleep()) {
        runtimeState.shelterInfo = { kind: 'bed' }
        runtimeState.nightsSheltered += 1
        features.persistExperience({ cycle: runtimeState.cycle, action: 'night-shelter', experience: '用羊毛和木板做床并睡觉，跳过夜晚' })
        return true
      }
      // Looking for sheep or a place to craft can lead under a roof.
      if (features.nightShelterTerrain() !== 'open' || !features.isNightShelterTime(runtimeState.bot.time.timeOfDay)) return false
      if (await digPitShelter()) {
        runtimeState.nightsSheltered += 1
        features.persistExperience({ cycle: runtimeState.cycle, action: 'night-shelter', experience: '没有床，挖三格深的坑并封住头顶等天亮' })
        return true
      }
      // The pit could not be sealed. Do not dig another one (that is how it
      // ended up 27 blocks underground): count this night as handled, surface,
      // and carry on with the normal threat handling.
      runtimeState.nightsSheltered += 1
      runtimeState.shelterAttemptedTonight = true
      features.log('first-night shelter failed; continuing without it')
      features.persistExperience({ cycle: runtimeState.cycle, action: 'night-shelter', experience: '坑没封上，本夜不再重复挖坑，改用常规避敌' })
      return false
    } finally {
      runtimeState.shelterBusy = false
    }
  }

  // Open one side of the shelter at dawn so the pathfinder can leave.
  async function breakShelter() {
    const info = runtimeState.shelterInfo
    runtimeState.shelterInfo = null
    if (info?.kind === 'bed') return true
    if (info?.kind === 'pit') {
      // Dig the seal, then climb out by stacking: dig the wall into a staircase.
      const seal = runtimeState.bot.blockAt(info.seal)
      try {
        if (seal && seal.boundingBox === 'block') { await features.equipBestToolFor(seal); await runtimeState.bot.dig(seal, true) }
        for (let step = 0; step < 4; step += 1) {
          const here = runtimeState.bot.entity.position.floored()
          const above = runtimeState.bot.blockAt(here.offset(0, 2, 0))
          if (above && above.boundingBox === 'block') await runtimeState.bot.dig(above, true)
          const placeable = runtimeState.bot.inventory.items().find(item => SHELTER_FILL.has(item.name))
          const floor = runtimeState.bot.blockAt(here.offset(0, -1, 0))
          if (!placeable || !floor) break
          runtimeState.bot.setControlState('jump', true)
          await new Promise(resolve => setTimeout(resolve, 280))
          await runtimeState.bot.equip(placeable, 'hand')
          try { await runtimeState.bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch {}
          runtimeState.bot.setControlState('jump', false)
          if (runtimeState.bot.entity.position.y >= info.seal.y) break
        }
        features.log('pit shelter opened at dawn')
        return true
      } catch (error) {
        runtimeState.bot.setControlState('jump', false)
        features.log('pit open failed', { message: error.message })
        return false
      }
    }
    const base = runtimeState.bot.entity.position.floored()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const wall = runtimeState.bot.blockAt(base.offset(dx, 0, dz))
      if (wall && wall.boundingBox === 'block' && runtimeState.bot.canDigBlock(wall)) {
        try {
          await features.equipBestToolFor(wall)
          await runtimeState.bot.dig(wall, true)
          features.log('shelter opened at dawn', { position: wall.position })
          return true
        } catch (error) {
          features.log('shelter open failed', { message: error.message })
        }
      }
    }
    return false
  }

  // Night and no sword/axe: sealing yourself in is safer than running. Dig one
  // block into the hillside facing solid ground (or stand in the open and wall
  // the four sides and the top), then wait until morning.
  async function nightShelter() {
    if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0 || features.waterOwnsMovement() || runtimeState.shelterBusy) return false
    const countFill = () => runtimeState.bot.inventory.items()
      .filter(item => SHELTER_FILL.has(item.name)).reduce((sum, item) => sum + item.count, 0)
    runtimeState.shelterBusy = true
    try {
      // After a respawn the inventory is empty: punch a few dirt/sand blocks
      // within reach first (hand digging is fine for these).
      for (let attempt = 0; attempt < 10 && countFill() < 8; attempt += 1) {
        const soil = runtimeState.bot.findBlock({
          maxDistance: 4,
          matching: block => ['dirt', 'grass_block', 'sand', 'coarse_dirt'].includes(block.name) &&
            block.position.y >= Math.floor(runtimeState.bot.entity.position.y) - 1,
        })
        if (!soil || !runtimeState.bot.canDigBlock(soil)) break
        try {
          await runtimeState.bot.dig(soil, true)
          await new Promise(resolve => setTimeout(resolve, 150))
        } catch { break }
      }
      if (countFill() < 6) {
        features.log('night shelter skipped; not enough fill blocks', { have: countFill() })
        return false
      }
      runtimeState.mineMode = false
      features.stopPathfinder()
      runtimeState.bot.pvp.stop()
      runtimeState.bot.clearControlStates()
      const base = runtimeState.bot.entity.position.floored()
      const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      const toSeal = []
      for (const [dx, dz] of ring) {
        for (const dy of [0, 1]) toSeal.push(base.offset(dx, dy, dz))
      }
      toSeal.push(base.offset(0, 2, 0))
      let placed = 0
      for (const position of toSeal) {
        const block = runtimeState.bot.blockAt(position)
        if (!block || block.boundingBox === 'block') continue
        if (WATER_BLOCK_NAMES.has(block.name) || block.name === 'lava') continue
        const item = runtimeState.bot.inventory.items().find(i => SHELTER_FILL.has(i.name))
        if (!item) break
        // Find any solid neighbour to place against.
        const neighbours = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
        let reference = null
        let face = null
        for (const [nx, ny, nz] of neighbours) {
          const candidate = runtimeState.bot.blockAt(position.offset(nx, ny, nz))
          if (candidate && candidate.boundingBox === 'block' && !candidate.position.equals(base) &&
              !candidate.position.equals(base.offset(0, 1, 0))) {
            reference = candidate
            face = new Vec3(-nx, -ny, -nz)
            break
          }
        }
        if (!reference) continue
        try {
          await runtimeState.bot.equip(item, 'hand')
          await runtimeState.bot.lookAt(position.offset(0.5, 0.5, 0.5), true)
          await runtimeState.bot.placeBlock(reference, face)
          placed += 1
        } catch (error) {
          features.log('shelter placement skipped', { position, message: error.message })
        }
      }
      features.log('night shelter built', { placed, at: base })
      features.persistExperience({ cycle: runtimeState.cycle, action: 'night-shelter', experience: `夜间无武器，用 ${placed} 个方块把自己围起来等天亮，避免被苦力怕和僵尸围攻` })
      return placed >= 4
    } finally {
      runtimeState.shelterBusy = false
    }
  }

  return {
    tryEmergencyPit,
    firstNightShelter,
    breakShelter,
  }
}

module.exports = createShelter
