const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { gunzipSync } = require('node:zlib')
const nbt = require('prismarine-nbt')

const SKIPPED_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'structure_void'])

function readStructureNbt(filename) {
  const limit = 8 * 1024 * 1024
  if (fs.statSync(filename).size > limit) throw new Error('结构蓝图文件过大')
  const data = fs.readFileSync(filename)
  const bytes = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, { maxOutputLength: limit }) : data
  const { size, palette, palettes, blocks, entities } = nbt.simplify(nbt.parseUncompressed(bytes, 'big'))
  const materials = palette ?? palettes?.[0]
  if (!Array.isArray(size) || size.length !== 3 ||
      !size.every((n, i) => Number.isInteger(n) && n > 0 && n <= [11, 4, 11][i]) ||
      !Array.isArray(materials) || !Array.isArray(blocks)) {
    throw new Error('需要原版 Java 结构方块导出的 .nbt，首版支持 11×4×11 以内')
  }
  if (entities?.length) throw new Error('此蓝图包含实体，生存施工暂不复制实体')
  const seen = new Set()
  const cells = []
  for (const { pos, state, nbt: blockEntity } of blocks) {
    if (!Array.isArray(pos) || pos.length !== 3 ||
        !pos.every((n, i) => Number.isInteger(n) && n >= 0 && n < size[i]) ||
        !Number.isInteger(state) || state < 0 || state >= materials.length) {
      throw new Error('结构蓝图包含越界坐标或无效材料索引')
    }
    const { Name, Properties } = materials[state]
    if (typeof Name !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(Name)) {
      throw new Error(`暂不支持此蓝图方块 ${Name}`)
    }
    const block = Name.slice('minecraft:'.length)
    if (SKIPPED_BLOCKS.has(block)) continue
    if (blockEntity || (Properties && Object.keys(Properties).length)) {
      throw new Error(`暂不支持复制方块属性或方块实体数据 ${Name}`)
    }
    const key = pos.join(',')
    if (seen.has(key)) throw new Error(`结构蓝图重复坐标 ${key}`)
    seen.add(key)
    cells.push({ block, pos })
  }
  if (!cells.length) throw new Error('蓝图里没有需放置的方块')
  return { size, cells, name: path.basename(filename), id: createHash('sha256').update(bytes).digest('hex') }
}

module.exports = { readStructureNbt }
