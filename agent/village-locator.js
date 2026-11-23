const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const VERSION = '1.21.11'
const SEARCH_RADIUS = 12288
const WORLD_LIMIT = 29999984
const MIN_SEED = -(1n << 63n)
const MAX_SEED = (1n << 63n) - 1n
let villageEngine

function loadEngine() {
  if (villageEngine) return villageEngine
  const { WASI } = require('node:wasi')
  const wasi = new WASI({ version: 'preview1' })
  const binary = readFileSync(join(__dirname, 'village-locator.wasm'))
  const instance = new WebAssembly.Instance(new WebAssembly.Module(binary), wasi.getImportObject())
  wasi.initialize(instance)
  villageEngine = instance.exports
  return villageEngine
}

function findNearestVillages(seed, baseX, baseZ) {
  const value = typeof seed === 'string' ? seed.trim() : ''
  if (!/^[+-]?\d{1,19}$/.test(value)) throw new TypeError('请输入 Java 版的数字种子')
  const worldSeed = BigInt(value)
  if (worldSeed < MIN_SEED || worldSeed > MAX_SEED) throw new TypeError('种子超出有符号 64 位整数范围')
  if (![baseX, baseZ].every(value => Number.isInteger(value) && Math.abs(value) <= WORLD_LIMIT)) {
    throw new TypeError('基地 X、Z 必须为世界边界内的整数')
  }

  const engine = loadEngine()
  const count = engine.find_villages(worldSeed, baseX, baseZ, SEARCH_RADIUS)
  const points = new Int32Array(engine.memory.buffer, engine.village_coordinates(), 2 * count)
  const villages = Array.from({ length: count }, (_, i) => {
    const x = points[2 * i]
    const z = points[2 * i + 1]
    return { x, z, distance: Math.round(Math.hypot(x - baseX, z - baseZ)) }
  })
  return { version: VERSION, radius: SEARCH_RADIUS, base: { x: baseX, z: baseZ }, villages }
}

async function handleVillageLookup(req, res) {
  const reply = (status, result) => {
    if (res.destroyed) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(result))
  }
  let input
  try {
    let body = ''
    for await (const part of req.iterator({ destroyOnReturn: false })) {
      body += part
      if (body.length > 1024) return reply(413, { error: '查询数据过长' })
    }
    input = JSON.parse(body)
  } catch {
    return reply(400, { error: '无效的种子查询' })
  }
  try {
    if (!input || typeof input !== 'object') throw new TypeError('无效的种子查询')
    reply(200, findNearestVillages(input.seed, input.baseX, input.baseZ))
  } catch (error) {
    reply(error instanceof TypeError ? 400 : 500,
      { error: error instanceof TypeError ? error.message : '本地村庄生成器暂不可用' })
  }
}

module.exports = { findNearestVillages, handleVillageLookup }
