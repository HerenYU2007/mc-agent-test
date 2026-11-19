const { Vec3 } = require('vec3')
const { setTimeout: wait } = require('node:timers/promises')
const minecraftData = require('minecraft-data')
const ItemFactory = require('prismarine-item')

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1),
  new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
const FACE_PRIORITY = [1, 5, 3, 4, 2, 0]
const FACING = { north: 2, south: 3, west: 4, east: 5 }
const AIR = new Set(['air', 'cave_air', 'void_air'])
const INTERACTIVE = /(?:chest|barrel|furnace|hopper|beacon|anvil|crafting_table|trapped_chest|shulker_box)$/
const DETAIL = /(?:snow|torch|lantern|grass|water|coral|scaffolding)$/
const REACH = 4.65

function matches(actual, cell) {
  return actual?.name === cell.block && Object.entries(cell.properties).every(([key, value]) =>
    String(actual.getProperties()[key]) === value)
}

function orderCells(blueprint, origin) {
  const cells = blueprint.cells.map(cell => {
    const position = origin.offset(...cell.pos)
    const row = Math.floor((cell.pos[2] - blueprint.minimum[2]) / 7)
    const column = Math.floor((cell.pos[0] - blueprint.minimum[0]) / 7) * (row % 2 ? -1 : 1)
    return { ...cell, position, row, column, detail: Number(DETAIL.test(cell.block)) }
  })
  return cells.sort((a, b) => a.position.y - b.position.y || a.detail - b.detail || a.row - b.row ||
    a.column - b.column || a.position.z - b.position.z || a.position.x - b.position.x)
}

function placementFaces(cell) {
  if (cell.block === 'wall_torch') return [FACING[cell.properties.facing]].filter(face => face != null)
  return FACE_PRIORITY.filter(face => !cell.properties.axis || FACES[face][cell.properties.axis])
}

function clickPoint(bot, cell) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
  for (const faceId of placementFaces(cell)) {
    const face = FACES[faceId]
    const support = bot.blockAt(cell.position.minus(face))
    if (!support?.shapes?.length) continue
    for (const shape of support.shapes) {
      const delta = new Vec3(...['x', 'y', 'z'].map((axis, index) => {
        if (face[axis]) return shape[index + (face[axis] > 0 ? 3 : 0)]
        const fraction = axis === 'y' && cell.properties.half === 'top' ? 0.75 :
          axis === 'y' && cell.properties.half === 'bottom' ? 0.25 : 0.5
        return shape[index] + fraction * (shape[index + 3] - shape[index])
      }))
      const direction = support.position.plus(delta).minus(eye)
      const length = direction.norm()
      if (length < 0.01 || length > REACH || direction.dot(face) >= 0) continue
      const hit = bot.world.raycast(eye, direction.scaled(1 / length), length + 0.08)
      if (hit?.position.equals(support.position) && hit.face === faceId) return { support, face, delta }
    }
  }
  return null
}

function emptyBody(bot, position) {
  const low = position.offset(-0.29, 0.02, -0.29).floored()
  const high = position.offset(0.29, 1.79, 0.29).floored()
  for (let x = low.x; x <= high.x; x++) {
    for (let y = low.y; y <= high.y; y++) {
      for (let z = low.z; z <= high.z; z++) {
        const block = bot.blockAt(new Vec3(x, y, z))
        if (!block || block.shapes?.length) return false
      }
    }
  }
  return true
}

function clearSegment(bot, from, to) {
  const delta = to.minus(from)
  const steps = Math.max(1, Math.ceil(delta.norm() / 0.5))
  for (let step = 1; step <= steps; step++) {
    if (!emptyBody(bot, from.plus(delta.scaled(step / steps)))) return false
  }
  return true
}

async function flySegment(bot, goal, signal) {
  const steps = Math.ceil(bot.entity.position.distanceTo(goal) / 0.5) + 2
  for (let step = 0; step < steps; step++) {
    signal?.throwIfAborted()
    const delta = goal.minus(bot.entity.position)
    const distance = delta.norm()
    if (distance < 0.06) return true
    const next = bot.entity.position.plus(delta.scaled(Math.min(1, 0.5 / distance)))
    if (!emptyBody(bot, next)) return false
    bot.entity.velocity.set(0, 0, 0)
    bot.entity.position.add(next.minus(bot.entity.position))
    await wait(50, undefined, { signal })
  }
  return false
}

async function moveForInteraction(bot, cell, signal, retry, reach) {
  const center = cell.position.offset(0.5, 1.55, 0.5)
  const alternatives = retry ? [center, ...FACE_PRIORITY.filter(face => !FACES[face].y)
    .map(face => center.plus(FACES[face].scaled(2.5)).offset(0, -0.85, 0))] : [center]
  for (const goal of alternatives) {
    const start = bot.entity.position.clone()
    const y = Math.max(start.y, center.y, goal.y)
    const lift = new Vec3(start.x, y, start.z)
    const crossing = new Vec3(goal.x, y, goal.z)
    const route = [lift, crossing, goal]
    if (route.some((to, index) => !clearSegment(bot, index ? route[index - 1] : start, to))) continue
    let completed = true
    for (const point of route) {
      if (!await flySegment(bot, point, signal)) { completed = false; break }
    }
    if (!completed) continue
    const candidate = reach()
    if (candidate) return candidate
  }
  return null
}

function varint(number) {
  const bytes = []
  while (number >= 128) { bytes.push((number & 127) | 128); number >>>= 7 }
  bytes.push(number)
  return Buffer.from(bytes)
}

function encodeBlockState(properties) {
  return Buffer.concat([varint(properties.length), ...properties.flatMap(({ name, value }) =>
    [name, value].flatMap(text => {
      const bytes = Buffer.from(text)
      return [varint(bytes.length), bytes]
    }))])
}

function selectCreativeItem(bot, signal) {
  const Item = ItemFactory(bot.registry)
  const field = minecraftData(bot.version).protocol.play.toServer.types.packet_set_creative_slot?.[1]
    .find(field => field.name === 'item')?.type
  let lastKey
  return async cell => {
    const name = cell.block === 'wall_torch' ? 'torch' : cell.block === 'water' ? 'water_bucket' : cell.block
    const definition = bot.registry.itemsByName[name]
    const block = bot.registry.blocksByName[cell.block]
    if (!definition || !block || Object.entries(cell.properties).some(([key, value]) => {
      const state = block.states.find(state => state.name === key)
      return !state || (state.values && !state.values.map(String).includes(value))
    }) || (cell.block === 'water' && cell.properties.level !== '0')) return false
    const key = cell.block + JSON.stringify(cell.properties)
    if (lastKey === key && bot.heldItem?.name === name) return true
    const item = new Item(definition.id, Math.min(definition.stackSize || 1, 64))
    if (!item.components || !['Slot', 'UntrustedSlot'].includes(field)) throw new Error(`暂不支持 ${bot.version} 的创造物品协议`)
    const properties = name === 'water_bucket' ? [] : Object.entries(cell.properties).map(([name, value]) => ({ name, value }))
    if (properties.length) item.components.push({ type: 'block_state', data: { properties } })
    const payload = Item.toNotch(item)
    // Modern creative inventory packets frame each untrusted component separately.
    if (field === 'UntrustedSlot' && properties.length) payload.components = [{ type: 'block_state', data: encodeBlockState(properties) }]
    bot._client.write('set_creative_slot', { slot: 36, item: payload })
    bot._setSlot(36, item)
    bot.setQuickBarSlot(0)
    lastKey = key
    await wait(50, undefined, { signal })
    return bot.heldItem?.name === name
  }
}

async function runCreativeBuild(bot, blueprint, origin, { replaceExisting = false, signal, onProgress = () => {} } = {}) {
  if (bot.game.gameMode !== 'creative') throw new Error('施工需要创造模式，请在测试服设置 Bot 的游戏模式')
  const cells = orderCells(blueprint, origin)
  const selectItem = selectCreativeItem(bot, signal)
  const observed = new Map()
  const summary = { total: cells.length, placed: 0, existing: 0, cleared: 0, pending: cells.length, attempts: 0 }
  const keyFor = cell => cell.position.toString()
  let lastReport = 0

  function report(pending, cell, force = false) {
    if (!force && Date.now() - lastReport < 2000) return
    lastReport = Date.now()
    onProgress({ ...summary, pending, target: cell?.position.toArray() })
  }

  async function place(cell, retry) {
    signal?.throwIfAborted()
    let current = bot.blockAt(cell.position)
    if (matches(current, cell)) return 'existing'
    if (current && !AIR.has(current.name)) {
      if (!replaceExisting && (!retry || current.stateId !== observed.get(keyFor(cell)))) return 'existing-block'
      if (!current.diggable) return 'obstruction-not-breakable'
      // Do not clear a cell before we know its intended material can be selected.
      if (!await selectItem(cell)) return 'unsupported-item-or-state'
      const originalState = current.stateId
      const reachableBlock = () => {
        const block = bot.blockAt(cell.position)
        return block?.stateId === originalState && bot.canDigBlock(block) && bot.canSeeBlock(block) ? block : null
      }
      const obstruction = reachableBlock() ?? await moveForInteraction(bot, cell, signal, retry, reachableBlock)
      current = bot.blockAt(cell.position)
      if (matches(current, cell)) return 'existing'
      if (current && !AIR.has(current.name)) {
        if (!obstruction || !reachableBlock()) return 'obstruction-out-of-reach'
        signal?.throwIfAborted()
        try {
          await bot.dig(current, true)
        } catch (error) {
          signal?.throwIfAborted()
          if (bot.game.gameMode !== 'creative') throw error
          return 'clearance-rejected'
        }
        // Mineflayer can predict the removal locally before receiving a correction.
        await wait(100, undefined, { signal })
        current = bot.blockAt(cell.position)
        if (matches(current, cell)) return 'existing'
        if (!current || !AIR.has(current.name)) return 'clearance-rejected'
        summary.cleared++
      }
    }
    const reach = () => clickPoint(bot, cell)
    const click = reach() ?? await moveForInteraction(bot, cell, signal, retry, reach)
    if (!click) return 'support-or-reach'
    if (!await selectItem(cell)) return 'unsupported-item-or-state'
    signal?.throwIfAborted()
    current = bot.blockAt(cell.position)
    if (matches(current, cell)) return 'existing'
    if (current && !AIR.has(current.name)) return 'existing-block'
    const sneak = INTERACTIVE.test(click.support.name)
    if (sneak) bot.setControlState('sneak', true)
    try {
      if (sneak) await wait(50, undefined, { signal })
      await bot._genericPlace(click.support, click.face, { delta: click.delta, swingArm: 'right', forceLook: true })
      summary.attempts++
      for (let tick = 0; tick < 6; tick++) {
        const actual = bot.blockAt(cell.position)
        if (matches(actual, cell)) return 'placed'
        await wait(50, undefined, { signal })
      }
      const actual = bot.blockAt(cell.position)
      if (actual?.name === cell.block) observed.set(keyFor(cell), actual.stateId)
      return actual && !AIR.has(actual.name) ? 'placement-state-mismatch' : 'placement-rejected'
    } finally {
      if (sneak) bot.setControlState('sneak', false)
    }
  }

  async function pass(entries, retry) {
    const remaining = []
    for (const cell of entries) {
      const result = await place(cell, retry)
      if (result === 'placed' || result === 'existing') {
        summary[result]++
        summary.pending--
      } else remaining.push({ cell, reason: result })
      report(summary.pending, cell)
    }
    return remaining
  }

  bot.creative.startFlying()
  bot._client.write('abilities', { flags: 2 })
  try {
    const deferred = await pass(cells, false)
    const remaining = await pass(deferred.map(({ cell }) => cell), true)
    report(remaining.length, null, true)
    return { ...summary, unresolved: remaining.map(({ cell, reason }) => ({ position: cell.position.toArray(), block: cell.block, reason })) }
  } finally {
    bot.creative.stopFlying()
    if (!bot._client.ended) bot._client.write('abilities', { flags: 0 })
  }
}

module.exports = { runCreativeBuild, orderCells, matches, clickPoint, encodeBlockState }
