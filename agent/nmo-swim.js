const AIR = new Set(['air', 'cave_air', 'void_air'])
const water = (b) => b.name === 'water'
const hazard = (b) => /lava|magma|campfire|bubble_column|cactus|powder_snow/.test(b.name)
const solid = (b) =>
  /^(?:stone|deepslate|grass_block|dirt|sand|gravel|clay|bedrock|sea_lantern|cobblestone|.*_planks)$/.test(
    b.name,
  )
async function swimToward(call, target, range, initial) {
  const block = (pos) => call('get_block', { pos })
  const end = target.map((v, i) => (i !== 1 && Number.isInteger(v) ? v + 0.5 : v))
  let s = initial,
    entered = s.in_water,
    stalled = 0
  const yaw = (dx, dz) => Math.atan2(-dx, -dz)
  const until = Date.now() + 20000
  let startDry = 0
  while (Date.now() < until && s.alive && s.ready && s.dimension === initial.dimension) {
    if (s.in_lava || s.on_fire || s.health < initial.health || s.nearest_hostile?.dist < 6) return false
    const [x, y, z] = s.pos,
      dx = end[0] - x,
      dz = end[2] - z,
      remaining = Math.hypot(dx, dz)
    if (!s.in_water && entered && s.on_ground) return true
    if (!s.in_water && !entered && ++startDry > 8) return false
    if (remaining < Math.max(0.2, range) && !s.in_water) return true
    if (remaining < 0.15 && !s.submerged) return false
    const ahead = (step, h) => [
      Math.floor(x + (dx / Math.max(0.1, remaining)) * step),
      Math.floor(y) + h,
      Math.floor(z + (dz / Math.max(0.1, remaining)) * step),
    ]
    const [feet, head, above, floor, further, under, below] = await Promise.all(
      [
        ahead(0.85, 0),
        ahead(0.85, 1),
        ahead(0.85, 2),
        ahead(0.85, -1),
        ahead(2, -1),
        ahead(2, 0),
        ahead(2, -2),
      ].map(block),
    )
    if ([feet, head, above, floor, further, under, below].some(hazard)) return false
    if (!s.in_water && !entered && ![feet, head, floor, further, under, below].some(water)) return false
    if (!AIR.has(head.name) && !water(head)) return false
    if (!AIR.has(feet.name) && !water(feet) && !(solid(feet) && AIR.has(above.name))) return false
    // A dry approach requires either water or a known support immediately under the next step.
    if (!s.in_water && !entered && !(water(feet) || water(floor) || solid(floor))) return false
    if (s.submerged && (s.oxygen ?? 20) < 12) {
      if (!(water(head) || AIR.has(head.name))) return false
      await call('control', { jump: true, ms: 220 })
    } else {
      await call('control', {
        forward: true,
        jump: s.in_water || entered,
        sprint: s.food > 6,
        yaw: yaw(dx, dz),
        ms: 270,
      })
    }
    const next = await call('status')
    if (Math.hypot(...s.pos.map((v, i) => v - next.pos[i])) < 0.08) stalled++
    else stalled = 0
    if (stalled >= 4) return false
    s = next
    entered ||= s.in_water
  }
  return false
}
module.exports = { swimToward }
