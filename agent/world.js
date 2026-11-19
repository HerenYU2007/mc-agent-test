const { Vec3 } = require('vec3')
const { LOG_NAMES, WATER_BLOCK_NAMES } = require('./config')

function createWorld(runtimeState) {
  // True when the position, the block under it, or any of its four horizontal
  // neighbours (at that level or one lower) is water.
  function isWaterAdjacent(position) {
    if (!position || !runtimeState.bot?.world) return false
    const offsets = [[0, 0, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]
    for (const [dx, dy, dz] of offsets) {
      const neighbour = runtimeState.bot.blockAt(position.offset(dx, dy, dz))
      if (neighbour && WATER_BLOCK_NAMES.has(neighbour.name)) return true
    }
    return false
  }

  function entityNameOf(entity) {
    if (!entity) return ''
    return String(entity.name || entity.displayName || entity.type || '').toLowerCase().replace(/ /g, '_')
  }

  // 8-10 cobblestone for stone pickaxe, sword and axe

  // Underground = several solid, non-foliage blocks overhead. Leaves and logs are
  // ignored so standing under a tree does not count. Sampled straight up from the
  // head, which is enough to tell a cave or mine from open ground.
  function isUndergroundNow() {
    if (!runtimeState.bot?.entity) return false
    const head = runtimeState.bot.entity.position.floored().offset(0, 2, 0)
    let solid = 0
    for (let dy = 0; dy < 24; dy += 1) {
      const block = runtimeState.bot.blockAt(head.offset(0, dy, 0))
      if (!block) break
      if (block.boundingBox === 'block' && !/(leaves|_log|_wood)$/.test(block.name)) solid += 1
      if (solid >= 3) return true
    }
    return false
  }

  function nightShelterTerrain(connection = runtimeState.bot, feet = connection?.entity?.position.floored()) {
    if (!feet || connection.game?.dimension !== 'overworld') return 'unknown'
    const top = connection.game.minY + connection.game.height
    if (!Number.isInteger(top)) return 'unknown'
    const head = feet.offset(0, 1, 0)
    for (let y = head.y; y < top; y += 1) {
      const block = connection.blockAt(head.offset(0, y - head.y, 0), false)
      if (!block) return 'unknown'
      if (block.boundingBox === 'block' && !/(leaves|_log|_wood)$/.test(block.name)) return 'covered'
    }
    return 'open'
  }

  function isNightShelterTime(timeOfDay) {
    return timeOfDay >= 12000 && timeOfDay <= 23500
  }

  function surveyNearbyBlocks(radius = 6) {
    if (!runtimeState.bot.entity) return { counts: {}, interesting: [] }
    const center = runtimeState.bot.entity.position.floored()
    const counts = {}
    const interesting = []
    const interestingNames = new Set([
      ...LOG_NAMES,
      'stone', 'deepslate', 'coal_ore', 'deepslate_coal_ore',
      'iron_ore', 'deepslate_iron_ore',
      'crafting_table', 'furnace', 'water', 'lava',
    ])
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dy = -3; dy <= 3; dy += 1) {
        for (let dz = -radius; dz <= radius; dz += 1) {
          const position = center.offset(dx, dy, dz)
          const block = runtimeState.bot.blockAt(position)
          if (!block) continue
          counts[block.name] = (counts[block.name] || 0) + 1
          if (interestingNames.has(block.name) && interesting.length < 40) {
            interesting.push({ name: block.name, position: { x: position.x, y: position.y, z: position.z }, distance: Number(runtimeState.bot.entity.position.distanceTo(position).toFixed(1)) })
          }
        }
      }
    }
    return { counts, interesting }
  }

  function isWaterBlock(block) {
    return /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(block?.name) ||
      block?.getProperties?.().waterlogged === true
  }

  function walkableAt(x, y, z) {
    const feet = runtimeState.bot.blockAt(new Vec3(x, y, z))
    const head = runtimeState.bot.blockAt(new Vec3(x, y + 1, z))
    const below = runtimeState.bot.blockAt(new Vec3(x, y - 1, z))
    return Boolean(feet && head && below && below.boundingBox === 'block' &&
      feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
      !WATER_BLOCK_NAMES.has(feet.name))
  }

  function findNearestBlock(names, maxDistance = 32) {
    const allowed = names instanceof Set ? names : new Set(names)
    return runtimeState.bot.findBlock({
      maxDistance,
      count: 1,
      matching: block => Boolean(block && allowed.has(block.name)),
    })
  }

  function openSurfaceAt(connection, feet) {
    const at = connection.blockAt(feet.offset(0, 1, 0))
    return Number(at?.skyLight) >= 13 && walkableAt(feet.x, feet.y, feet.z) &&
      nightShelterTerrain(connection, feet) === 'open'
  }

  return {
    isWaterAdjacent,
    entityNameOf,
    isUndergroundNow,
    nightShelterTerrain,
    isNightShelterTime,
    surveyNearbyBlocks,
    isWaterBlock,
    walkableAt,
    findNearestBlock,
    openSurfaceAt,
  }
}

module.exports = createWorld
