const { Vec3 } = require('vec3')

const HUT_ID = 'starter-hut-5x5-v1'
const HUT_SIZE = [5, 4, 5]
const WOOD = /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|bamboo|crimson|warped)_/
const MATERIAL = { planks: 'planks', slab: 'wooden_slab', door: 'wooden_door', bed: 'bed', light: 'wall_torch' }
const roofRings = [2, 1, 0]

function hutBlueprint(site) {
  const { center, front, supports } = site
  const right = new Vec3(front.z, 0, -front.x)
  const point = (x, y, z) => center.plus(right.scaled(x)).plus(front.scaled(z)).offset(0, y, 0)
  const cells = supports.map(({ x, z }) => ({
    phase: '地基', block: 'cobblestone', position: center.offset(x, -1, z), baseOnly: true,
  }))
  const add = (phase, block, x, y, z, extra) => cells.push({ phase, block, position: point(x, y, z), ...extra })
  // Put the two-part bed and the fixtures in place while the interior is still open.
  add('室内', MATERIAL.bed, -1, 0, 0, { baseOnly: true, look: front.scaled(-1), pair: point(-1, 0, -1) })
  add('室内', 'chest', 1, 0, -1, { baseOnly: true })
  add('室内', 'furnace', 1, 0, 0, { baseOnly: true })
  add('室内', 'crafting_table', 1, 0, 1, { baseOnly: true })
  for (let y = 0; y < 3; y++) {
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== 2 || (x === 0 && z === 2 && y < 2)) continue
        if (y === 1 && Math.abs(x) === 2 && z === 0) continue
        add(`墙体第 ${y + 1} 层`, y ? MATERIAL.planks : 'cobblestone', x, y, z, { baseOnly: !(y === 2 && x === 0 && z === 2) })
      }
    }
    // Set the windows while their sills are exposed. They support the upper wall.
    if (y === 1) {
      for (const x of [-2, 2]) add('玻璃窗', 'glass', x, y, 0, { baseOnly: true })
    }
  }
  for (const ring of roofRings) {
    for (let x = -ring; x <= ring; x++) {
      for (let z = -ring; z <= ring; z++) {
        if (Math.max(Math.abs(x), Math.abs(z)) === ring) {
          add(ring ? '屋顶' : '屋顶中格', MATERIAL.slab, x, 3, z, { half: 'bottom' })
        }
      }
    }
  }
  // Interior lights hang on the rear wall and entrance wall.
  add('照明', MATERIAL.light, 0, 1, -1, { faces: [front.scaled(-1)] })
  add('照明', MATERIAL.light, -1, 1, 1, { faces: [front] })
  for (const x of [-1, 1]) add('照明', MATERIAL.light, x, 1, 3, { faces: [front.scaled(-1)] })
  add('门', MATERIAL.door, 0, 0, 2, { baseOnly: true, look: front.scaled(-1), pair: point(0, 1, 2) })
  return cells
}

function hutItem(name, material) {
  if (!name) return false
  if (material === MATERIAL.slab) return WOOD.test(name) && name.endsWith('_slab') && !name.includes('_mosaic_')
  if (material === MATERIAL.door) return WOOD.test(name) && name.endsWith('_door') && !name.endsWith('_trapdoor')
  if (material === MATERIAL.bed) return name.endsWith('_bed')
  if (material === MATERIAL.light) return name === 'torch'
  return material === MATERIAL.planks ? name.endsWith('_planks') : name === material
}

function hutBlockMatches(bot, cell) {
  const actual = bot.blockAt(cell.position)
  if (cell.block === MATERIAL.light) return actual?.name === 'wall_torch'
  if (!hutItem(actual?.name, cell.block)) return false
  if (cell.block === MATERIAL.slab) return actual.getProperties().type === 'bottom'
  if (!cell.pair) return true
  const paired = bot.blockAt(cell.pair)
  if (paired?.name !== actual.name) return false
  const properties = actual.getProperties()
  const other = paired.getProperties()
  return cell.block === MATERIAL.bed
    ? properties.part === 'foot' && other.part === 'head'
    : properties.half === 'lower' && other.half === 'upper'
}

module.exports = { HUT_ID, HUT_SIZE, hutBlueprint, hutItem, hutBlockMatches }
