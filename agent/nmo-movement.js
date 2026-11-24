const { swimToward } = require('./nmo-swim')
const AIR = new Set(['air', 'cave_air', 'void_air'])
const FLOOR =
  /^(?:stone|deepslate|cobblestone|cobbled_deepslate|dirt|grass_block|andesite|diorite|granite|tuff|netherrack|bedrock|.*_planks)$/
const MATERIAL = ['dirt', 'cobblestone', 'cobbled_deepslate']
const directions = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const recoverable = new Set(['timeout', 'path_timeout', 'path_not_found', 'stalled', 'move_unconfirmed'])
const fault = (code) => Object.assign(new Error(code), { code })
const offset = ([x, y, z], [dx, dz], dy = 0, steps = 1) => [x + dx * steps, y + dy, z + dz * steps]
const center = (n) => (Number.isInteger(n) ? n + 0.5 : n)

function arrived([x, y, z], [tx, ty, tz], range) {
  const horizontal = Math.hypot(x - center(tx), z - center(tz))
  if (range >= 1) return Math.hypot(horizontal, y - ty) <= range + 0.1
  return (
    Math.floor(x) === Math.floor(tx) &&
    Math.floor(z) === Math.floor(tz) &&
    Math.abs(y - ty) <= 0.6 &&
    horizontal <= Math.max(range, 0.15) + 0.08
  )
}

function createMovement(call) {
  return async function move(target, range = 2) {
    const initial = await call('status')
    async function state() {
      const s = await call('status')
      if (!s.ready || s.alive === false || s.dimension !== initial.dimension || s.health < initial.health)
        throw fault('movement_interrupted')
      return s
    }
    async function walk(pos, radius, timeout) {
      const receipt = await call('move_to', { pos, range: radius, timeout })
      if (receipt.dimension_changed) return receipt
      if (receipt.interrupted_by) throw fault('movement_interrupted')
      const fresh = await state()
      if (!arrived(fresh.pos, pos, radius)) throw fault('move_unconfirmed')
      return { ...receipt, pos: fresh.pos }
    }
    try {
      return await walk(target, range, 9000)
    } catch (error) {
      if (!recoverable.has(error.code)) throw error
    }
    const start = await state()
    if (
      start.ready &&
      !start.in_lava &&
      !start.on_fire &&
      !start.in_vehicle &&
      (start.in_water || start.on_ground) &&
      (await swimToward(call, target, range, start))
    ) {
      return walk(target, range, 4500)
    }
    if (!start.on_ground || start.in_water || start.nearest_hostile?.dist <= 8) throw fault('path_not_found')
    const origin = start.pos.map(Math.floor)
    const read = async (pos) => (await call('get_block', { pos })).name
    const column = async (p, heights) => Promise.all(heights.map((h) => read([p[0], p[1] + h, p[2]])))
    const ordered = [...directions].sort((a, b) => {
      const remaining = (dir) => Math.hypot(target[0] - origin[0] - dir[0], target[2] - origin[2] - dir[1])
      return remaining(a) - remaining(b)
    })
    let count = 0
    for (const dir of ordered) {
      const near = offset(origin, dir)
      const [floor, feet, head, above] = await column(near, [-1, 0, 1, 2])
      if (!FLOOR.test(floor) || ![feet, head, above].every((n) => AIR.has(n))) continue
      try {
        await walk(near, 0, 2200)
        return await walk(target, range, 3500)
      } catch (error) {
        if (!recoverable.has(error.code)) throw error
      }
      if (++count >= 2) break
    }
    if (target[1] < origin[1] + 2) throw fault('path_not_found')
    // Only build inside a small enclosed depression with solid two-high sides on all four axes.
    const rims = []
    for (const dir of ordered) {
      let rim = 0
      for (let step = 1; step <= 3; step++) {
        const [feet, head] = await column(offset(origin, dir, 0, step), [0, 1])
        if (FLOOR.test(feet) && FLOOR.test(head)) {
          rim = step
          break
        }
        if (!AIR.has(feet) || !AIR.has(head)) break
      }
      if (!rim) throw fault('path_not_found')
      if (rim === 2) rims.push(dir)
    }
    const inventory = await call('inventory')
    const item = MATERIAL.find((name) => inventory.items.some((i) => i.name === name && i.count > 0))
    if (!item) throw fault('path_not_found')
    for (const dir of rims) {
      const step = offset(origin, dir)
      const rim = offset(origin, dir, 2, 2)
      const [floor, feet, head, above, overhead] = await column(step, [-1, 0, 1, 2, 3])
      const landing = await column(rim, [-1, 0, 1])
      if (
        !FLOOR.test(floor) ||
        ![feet, head, above, overhead].every((n) => AIR.has(n)) ||
        !FLOOR.test(landing[0]) ||
        !landing.slice(1).every((n) => AIR.has(n))
      )
        continue
      await walk(origin, 0, 2200)
      const fresh = await state()
      if (fresh.nearest_hostile?.dist <= 8 || !fresh.on_ground || fresh.in_water)
        throw fault('movement_interrupted')
      await call('place', { item, pos: step })
      if ((await read(step)) !== item) throw fault('place_failed')
      await walk(offset(step, [0, 0], 1), 0, 3000)
      await walk(rim, 0, 3000)
      return walk(target, range, 5000)
    }
    throw fault('path_not_found')
  }
}

module.exports = { createMovement }
