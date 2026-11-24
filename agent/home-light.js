const { Vec3 } = require('vec3')

// MiniHUD 1.21.11 OverlayRendererLightLevel checks support, two cells of
// clearance and the BLOCK light layer at the entity's feet. Mineflayer has
// collision shapes, but not the server's per-entity isValidSpawn predicate.
// Protocol light arrays contain two nibbles per byte, in increasing X order.
// Reading them through the installed chunk library's long-array reader swaps
// byte positions within each group of sixteen X coordinates.
const lightMaps = new WeakMap()
function observeLight(bot) {
  if (lightMaps.has(bot)) return
  const columns = new Map()
  lightMaps.set(bot, columns)
  function apply(x, z, p, initial) {
    const key = x + ',' + z
    if (!p.blockLightMask || !p.skyLightMask) return
    const column = (!initial && columns.get(key)) || { block: [], sky: [] }
    for (const layer of ['sky', 'block']) {
      const mask = p[layer + 'LightMask'],
        empty = p[layer === 'sky' ? 'emptySkyLightMask' : 'emptyBlockLightMask']
      const flag = (words, i) => {
        const word = words?.[i >> 6]
        if (word == null) return false
        if (typeof word === 'bigint') return Boolean((word >> BigInt(i & 63)) & 1n)
        return Boolean((word[(i & 63) < 32 ? 1 : 0] >>> (i & 31)) & 1)
      }
      let next = 0
      for (let i = 0; i < Math.max(mask.length, empty?.length || 0) * 64; i++) {
        if (flag(mask, i)) column[layer][i] = Buffer.from(p[layer + 'Light'][next++])
        else if (flag(empty, i)) column[layer][i] = null
      }
    }
    columns.set(key, column)
  }
  bot._client.on('map_chunk', (p) => apply(p.x, p.z, p, true))
  bot._client.on('update_light', (p) => apply(p.chunkX, p.chunkZ, p, false))
  bot._client.on('unload_chunk', (p) => columns.delete(p.chunkX + ',' + p.chunkZ))
  bot._client.on('login', () => columns.clear())
  bot.once('end', () => columns.clear())
}
const recentSources = new WeakMap()
function rememberTorch(bot, p) {
  if (!recentSources.has(bot)) recentSources.set(bot, new Map())
  recentSources.get(bot).set(p.toString(), p.clone())
}
// Vanilla clients propagate local block changes between chunk-light packets.
// A confirmed torch and a clear path of at most 13 steps prove positive
// block light. An opaque or unknown cell invalidates that path.
function reachedByTorch(bot, p) {
  for (const [key, src] of recentSources.get(bot) || []) {
    if (src.manhattanDistanceTo(p) > 13) continue
    if (bot.blockAt(src, false)?.name !== 'torch') {
      recentSources.get(bot).delete(key)
      continue
    }
    for (const order of ['xyz', 'zyx', 'yxz', 'zxy', 'xzy', 'yzx']) {
      const q = src.clone()
      let open = true
      for (const axis of order) {
        while (q[axis] !== p[axis]) {
          q[axis] += Math.sign(p[axis] - q[axis])
          const block = bot.blockAt(q, false)
          if (
            !block ||
            bot.registry.blocks[block.type]?.filterLight !== 0 ||
            block.shapes.length ||
            LIQUID_OR_HAZARD.test(block.name)
          ) {
            open = false
            break
          }
        }
        if (!open) break
      }
      if (open) return true
    }
  }
  return false
}
function rawLight(column, layer, p, minY) {
  const bytes = column[layer][((p.y - minY) >> 4) + 1]
  if (!bytes) return 0
  const index = ((p.y & 15) << 8) | ((p.z & 15) << 4) | (p.x & 15)
  return (bytes[index >> 1] >> ((index & 1) * 4)) & 15
}
const RADIUS = 64
const NO_FLOOR = /glass|leaves|scaffolding|barrier|magma_block|bedrock|^ice$/
const LIQUID_OR_HAZARD = /^(water|lava|bubble_column|powder_snow|fire|soul_fire|sweet_berry_bush|wither_rose)$/
function fullTop(block) {
  return block?.shapes?.some(([x, , z, X, Y, Z]) => x === 0 && z === 0 && X === 1 && Z === 1 && Y === 1)
}
function spawnFloor(block) {
  return fullTop(block) && !NO_FLOOR.test(block.name)
}
function clear(block) {
  return (
    block &&
    !LIQUID_OR_HAZARD.test(block.name) &&
    !block.getProperties?.().waterlogged &&
    !block.shapes.some(([x, y, z, X, Y, Z]) => x === 0 && y === 0 && z === 0 && X === 1 && Y === 1 && Z === 1) &&
    !/rail|button|pressure_plate|redstone_wire|tripwire|carpet/.test(block.name)
  )
}

function tiles(home) {
  const groups = new Map()
  for (let dx = -RADIUS; dx <= RADIUS; dx++)
    for (let dz = -RADIUS; dz <= RADIUS; dz++) {
      if (dx * dx + dz * dz > RADIUS * RADIUS) continue
      const x = home.x + dx,
        z = home.z + dz
      const key = [x >> 3, z >> 3].join(',')
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(new Vec3(x, home.y, z))
    }
  return [...groups.values()].sort((a, b) => a[0].distanceTo(home) - b[0].distanceTo(home))
}

function darkSurface(bot, columns) {
  const chunk = bot.world.getColumnAt(columns[0])
  const sample = columns[0]
  const packet = lightMaps.get(bot)?.get((sample.x >> 4) + ',' + (sample.z >> 4))
  if (!chunk || !packet) return null
  const risks = []
  const cache = new Map()
  const loc = new Vec3(0, 0, 0)
  for (const column of columns) {
    loc.x = column.x & 15
    loc.z = column.z & 15
    let openAbove = true
    for (let section = chunk.sections.length - 1; section >= 0; section--) {
      if (!chunk.sections[section]?.solidBlockCount) continue
      const bottom = chunk.minY + section * 16
      for (loc.y = bottom + 15; loc.y >= bottom; loc.y--) {
        const id = chunk.getBlockStateId(loc)
        if (id === 0) continue
        let shape = cache.get(id)
        if (!shape) {
          const block = chunk.getBlock(loc)
          shape = { floor: spawnFloor(block), roof: fullTop(block) && !/leaves|glass/.test(block.name) }
          cache.set(id, shape)
        }
        if (shape.floor) {
          const p = new Vec3(column.x, loc.y + 1, column.z)
          const feet = bot.blockAt(p, false)
          if (!feet) return null
          if (
            rawLight(packet, 'block', p, chunk.minY) === 0 &&
            (openAbove || rawLight(packet, 'sky', p, chunk.minY) > 0) &&
            clear(feet) &&
            clear(bot.blockAt(p.offset(0, 1, 0), false)) &&
            !reachedByTorch(bot, p)
          )
            risks.push(p)
        }
        if (shape.roof) openAbove = false
      }
    }
  }
  return risks
}

function createLightSurvey() {
  let groups,
    center,
    owner,
    cursor = 0
  const checked = new Set()
  const blockedUntil = new Map()
  const retries = new Map()
  return function inspect(bot, home) {
    if (owner !== bot || !center?.equals(home)) {
      owner = bot
      center = home
      groups = tiles(home)
      cursor = 0
      checked.clear()
      retries.clear()
      blockedUntil.clear()
    }
    // Rotate past inaccessible tiles, but never count them as verified.
    for (let n = 0; n < groups.length; n++) {
      const i = cursor++ % groups.length
      if (checked.has(i) || (blockedUntil.get(i) || 0) > Date.now()) continue
      const cells = darkSurface(bot, groups[i])
      if (!cells) return { load: groups[i][0] }
      if (!cells.length) {
        checked.add(i)
        continue
      }
      cells.sort(
        (a, b) =>
          (retries.get(a.toString()) || 0) - (retries.get(b.toString()) || 0) ||
          a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position),
      )
      const target = cells[0]
      retries.set(target.toString(), (retries.get(target.toString()) || 0) + 1)
      cursor = i
      return {
        target,
        retryLater: () => {
          blockedUntil.set(i, Date.now() + 30000)
          cursor = i + 1
        },
      }
    }
    return { complete: checked.size === groups.length }
  }
}
module.exports = { createLightSurvey, darkSurface, tiles, observeLight, rawLight, rememberTorch }
