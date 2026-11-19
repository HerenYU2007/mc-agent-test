const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { gzipSync } = require('node:zlib')
const { Vec3 } = require('vec3')
const nbt = require('prismarine-nbt')
const { readLitematic } = require('../litematic')
const { matches, orderCells, clickPoint, encodeBlockState } = require('../agent/creative-build')

const states = [
  ['air'], ['polished_diorite'], ['spruce_log', { axis: 'y' }],
  ['smooth_quartz_stairs', { facing: 'east', half: 'top', shape: 'straight', waterlogged: 'false' }],
  ['red_wool'], ['glass'],
]

function fixture() {
  const [width, height, depth] = [5, 3, 5]
  const cells = [[0, 0, 0, 1], [1, 0, 0, 1], [2, 0, 0, 1], [3, 0, 0, 4],
    [1, 0, 4, 1], [1, 1, 0, 2], [2, 1, 0, 3], [3, 1, 0, 5], [3, 2, 0, 4]]
  const bits = 3
  const words = Array.from({ length: Math.ceil(width * height * depth * bits / 64) }, () => 0n)
  for (const [x, y, z, state] of cells) {
    const bit = ((y * depth + z) * width + x) * bits
    const index = Math.floor(bit / 64)
    const shift = bit % 64
    words[index] |= BigInt.asUintN(64, BigInt(state) << BigInt(shift))
    if (shift + bits > 64) words[index + 1] |= BigInt(state) >> BigInt(64 - shift)
  }
  const longs = words.map(word => [Number(BigInt.asIntN(32, word >> 32n)), Number(BigInt.asIntN(32, word))])
  const vector = ([x, y, z]) => nbt.comp({ x: nbt.int(x), y: nbt.int(y), z: nbt.int(z) })
  const palette = states.map(([name, properties]) => ({ Name: nbt.string(`minecraft:${name}`), ...(properties && {
    Properties: nbt.comp(Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, nbt.string(value)]))),
  }) }))
  return gzipSync(nbt.writeUncompressed({ type: 'compound', name: '', value: {
    Version: nbt.int(6), MinecraftDataVersion: nbt.int(4786), Regions: nbt.comp({ fixture: nbt.comp({
      Position: vector([4, 0, 0]), Size: vector([-5, 3, 5]), BlockStatePalette: nbt.list(nbt.comp(palette)),
      BlockStates: nbt.longArray(longs), Entities: nbt.list(nbt.comp([{ id: nbt.string('minecraft:rabbit') }])),
    }) }),
  } }))
}

if (process.argv[2] === '--fixture' && process.argv[3]) {
  fs.writeFileSync(process.argv[3], fixture(), { flag: 'wx' })
  console.log(process.argv[3])
} else {
  const target = path.join(os.tmpdir(), `nmo-creative-fixture-${process.pid}.litematic`)
  fs.writeFileSync(target, fixture(), { flag: 'wx' })
  try {
    const plan = readLitematic(target)
    assert.deepEqual(plan.minimum, [0, 0, 0])
    assert.deepEqual(plan.maximum, [4, 2, 4])
    assert.equal(plan.cells.length, 9)
    assert.equal(plan.skippedEntities, 1)
    const stair = plan.cells.find(cell => cell.block.endsWith('stairs'))
    assert.deepEqual(stair.pos, [2, 1, 0])
    assert.equal(stair.properties.half, 'top')
    assert.equal(plan.cells.find(cell => cell.pos.join(',') === '1,0,4').block, 'polished_diorite')
    assert.equal(matches({ name: stair.block, getProperties: () => ({ ...stair.properties }) }, stair), true)
    assert.equal(matches({ name: stair.block, getProperties: () => ({ ...stair.properties, half: 'bottom' }) }, stair), false)
    const origin = new Vec3(100, 20, 100)
    const sorted = orderCells(plan, origin)
    assert.deepEqual(sorted[0].position.toArray(), [100, 20, 100])
    assert.deepEqual(sorted.at(-1).position.toArray(), [103, 22, 100])
    const support = { position: new Vec3(100, 19, 100), shapes: [[0, 0, 0, 1, 1, 1]] }
    const bot = {
      entity: { position: new Vec3(100.5, 21.5, 100.5) },
      blockAt: position => position.equals(support.position) ? support : null,
      world: { raycast: () => ({ position: support.position, face: 1 }) },
    }
    assert.deepEqual(clickPoint(bot, sorted[0]).delta.toArray(), [0.5, 1, 0.5])
    bot.world.raycast = () => ({ position: support.position, face: 2 })
    assert.equal(clickPoint(bot, sorted[0]), null)
    assert.deepEqual(encodeBlockState([{ name: 'axis', value: 'y' }]), Buffer.from([1, 4, 97, 120, 105, 115, 1, 121]))
    console.log('通过：Litematic v6、有符号尺寸、跨长整数字位、方块状态、层序和支撑面校验。')
  } finally {
    fs.unlinkSync(target)
  }
}
