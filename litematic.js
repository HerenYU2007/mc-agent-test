const fs = require('node:fs')
const path = require('node:path')
const { gunzipSync } = require('node:zlib')
const nbt = require('prismarine-nbt')

const FILE_LIMIT = 64 * 1024 * 1024
const VOLUME_LIMIT = 16 * 1024 * 1024
const AXES = ['x', 'y', 'z']
const AIR = new Set(['air', 'cave_air', 'void_air', 'structure_void'])

function vector(tag, label) {
  const coordinates = AXES.map(axis => tag?.[axis])
  if (!coordinates.every(Number.isSafeInteger)) throw new Error(`蓝图的 ${label} 坐标无效`)
  return coordinates
}

function readLitematic(filename) {
  if (fs.statSync(filename).size > FILE_LIMIT) throw new Error('Litematic 文件超过 64 MiB')
  const input = fs.readFileSync(filename)
  const bytes = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input, { maxOutputLength: FILE_LIMIT }) : input
  const schematic = nbt.simplify(nbt.parseUncompressed(bytes, 'big'))
  const regions = Object.entries(schematic.Regions || {})
  if (schematic.Version !== 6 || !regions.length) throw new Error('需要包含施工区域的 Litematic v6 蓝图')
  const minimum = [Infinity, Infinity, Infinity]
  const maximum = [-Infinity, -Infinity, -Infinity]
  const cells = new Map()
  let volume = 0
  let skippedEntities = 0
  let skippedBlockEntityData = 0
  for (const [label, region] of regions) {
    const position = vector(region.Position, `${label} 位置`)
    const signedSize = vector(region.Size, `${label} 尺寸`)
    const size = signedSize.map(Math.abs)
    const [width, height, depth] = size
    const regionVolume = width * height * depth
    volume += regionVolume
    if (size.some(value => value === 0) || !Number.isSafeInteger(volume) || volume > VOLUME_LIMIT) {
      throw new Error(`蓝图尺寸无效或体积过大 ${label}`)
    }
    // Litematica coordinates are relative to the selection origin. The array starts at each region's minimum corner.
    const corner = position.map((value, axis) => value + Math.min(signedSize[axis] + 1, 0))
    for (let axis = 0; axis < 3; axis++) {
      minimum[axis] = Math.min(minimum[axis], corner[axis])
      maximum[axis] = Math.max(maximum[axis], corner[axis] + size[axis] - 1)
    }
    if (!Array.isArray(region.BlockStatePalette) || !region.BlockStatePalette.length) throw new Error(`缺少蓝图材料 ${label}`)
    const palette = region.BlockStatePalette.map(({ Name, Properties = {} }) => {
      if (typeof Name !== 'string' || !/^minecraft:[a-z0-9_]+$/.test(Name) ||
          !Properties || typeof Properties !== 'object' || Array.isArray(Properties) ||
          Object.entries(Properties).some(([key, value]) => !/^[a-z0-9_]+$/.test(key) || typeof value !== 'string' || !/^[a-z0-9_-]+$/.test(value))) {
        throw new Error(`蓝图包含不支持的方块状态 ${label}`)
      }
      const block = Name.slice('minecraft:'.length)
      return { block, properties: Object.fromEntries(Object.entries(Properties).sort(([a], [b]) => a.localeCompare(b))) }
    })
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)))
    const wordsNeeded = Math.ceil(regionVolume * bits / 64)
    if (!Array.isArray(region.BlockStates) || region.BlockStates.length !== wordsNeeded ||
        region.BlockStates.some(word => !Array.isArray(word) || word.length !== 2 || !word.every(Number.isInteger))) {
      throw new Error(`蓝图方块数据长度不符 ${label}`)
    }
    const words = region.BlockStates.map(([high, low]) => (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0))
    const mask = (1n << BigInt(bits)) - 1n
    for (let index = 0; index < regionVolume; index++) {
      const bit = index * bits
      const word = Math.floor(bit / 64)
      const shift = bit % 64
      let value = words[word] >> BigInt(shift)
      if (shift + bits > 64) value |= words[word + 1] << BigInt(64 - shift)
      const state = palette[Number(value & mask)]
      if (!state) throw new Error(`蓝图材料索引超界 ${label}`)
      if (AIR.has(state.block)) continue
      const pos = [index % width, Math.floor(index / (width * depth)), Math.floor(index / width) % depth]
        .map((coord, axis) => coord + corner[axis])
      const key = pos.join(',')
      const previous = cells.get(key)
      if (previous && (previous.block !== state.block || JSON.stringify(previous.properties) !== JSON.stringify(state.properties))) {
        throw new Error(`蓝图区域在 ${key} 有不同的重叠方块`)
      }
      if (!previous) cells.set(key, { pos, ...state })
    }
    skippedEntities += region.Entities?.length || 0
    skippedBlockEntityData += region.TileEntities?.length || 0
  }
  if (!cells.size) throw new Error('蓝图里没有需放置的方块')
  return {
    name: path.basename(filename), format: schematic.Version, dataVersion: schematic.MinecraftDataVersion,
    minimum, maximum, cells: [...cells.values()], skippedEntities, skippedBlockEntityData,
  }
}

module.exports = { readLitematic }
