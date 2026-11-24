const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { Vec3 } = require('vec3')
const { tiles, rawLight, darkSurface, observeLight, rememberTorch } = require('../agent/home-light')
const { blockForTool, observeToolTags } = require('../agent/mining-speed')
const { createHomeRoute, readyFood, STOCK, category } = require('../agent/home-route')
const { createVillageExpedition } = require('../agent/expedition')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const home = new Vec3(-16, 0, 0)
const floor = { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) }
const air = { name: 'air', type: 0, shapes: [], getProperties: () => ({}) }
function fixture() {
  const chunk = {
    minY: 0,
    sections: [{ solidBlockCount: 256 }],
    getBlockStateId: (p) => Number(p.y === 0),
    getBlock: () => floor,
  }
  const blocks = new Map()
  const bot = Object.assign(new EventEmitter(), {
    _client: new EventEmitter(),
    world: { getColumnAt: () => chunk },
    registry: { blocks: [{ filterLight: 0 }] },
    blockAt: (p) => blocks.get(p.toString()) || (p.y === 0 ? floor : air),
  })
  observeLight(bot)
  const packet = (light) => ({
    x: -1,
    z: 0,
    skyLightMask: [[0, 2]],
    emptySkyLightMask: [],
    blockLightMask: [[0, 2]],
    emptyBlockLightMask: [],
    skyLight: [Buffer.alloc(2048, 255)],
    blockLight: [light],
  })
  return { bot, blocks, chunk, packet }
}
test('64 格圆内每个地表列恰好覆盖一次，含四个边界', () => {
  const cols = tiles(home).flat()
  assert.equal(cols.length, 12853)
  assert.equal(new Set(cols.map(String)).size, cols.length)
  for (const p of [home.offset(64, 0, 0), home.offset(-64, 0, 0), home.offset(0, 0, 64), home.offset(0, 0, -64)])
    assert.ok(cols.some((v) => v.equals(p)))
})
test('脚部光照半字节、负坐标、白天暗格、半砖、水、头顶遮挡和卸载', () => {
  const { bot, blocks, chunk, packet } = fixture()
  const point = home.offset(0, 1, 0),
    next = point.offset(1, 0, 0)
  const bytes = Buffer.alloc(2048)
  bytes[128] = 0xb0
  assert.equal(rawLight({ block: [, bytes] }, 'block', next, 0), 11)
  bot._client.emit('map_chunk', packet(bytes))
  assert.deepEqual(darkSurface(bot, [home, home.offset(1, 0, 0)]), [point])
  blocks.set(point.toString(), { ...air, name: 'water' })
  assert.deepEqual(darkSurface(bot, [home]), [])
  blocks.clear()
  blocks.set(point.offset(0, 1, 0).toString(), floor)
  assert.deepEqual(darkSurface(bot, [home]), [])
  blocks.clear()
  chunk.getBlock = () => ({ ...floor, shapes: [[0, 0, 0, 1, 0.5, 1]] })
  assert.deepEqual(darkSurface(bot, [home]), [])
  bot._client.emit('unload_chunk', { chunkX: -1, chunkZ: 0 })
  assert.equal(darkSurface(bot, [home]), null)
})
test('新插火把可通过空气照亮平地，完整石墙会截断证明，移除的火把不算', () => {
  const { bot, blocks, packet } = fixture()
  bot._client.emit('map_chunk', packet(Buffer.alloc(2048)))
  const p = home.offset(0, 1, 0),
    source = p.offset(3, 0, 0)
  blocks.set(source.toString(), { ...air, name: 'torch' })
  rememberTorch(bot, source)
  assert.deepEqual(darkSurface(bot, [home]), [])
  blocks.set(p.offset(1, 0, 0).toString(), floor)
  assert.deepEqual(darkSurface(bot, [home]), [p])
  blocks.clear()
  assert.deepEqual(darkSurface(bot, [home]), [p])
})
test('1.21.11 钻石镐开采黑曜石沿用原版 188 tick，保留环境惩罚和原方块数据', () => {
  const d = require('minecraft-data')('1.21.11')
  const original = require('prismarine-block')('1.21.11').fromStateId(d.blocksByName.obsidian.defaultState, 0)
  const pick = d.itemsByName.diamond_pickaxe.id
  const corrected = blockForTool({ registry: d }, original, { name: 'diamond_pickaxe', type: pick })
  assert.equal(corrected.digTime(pick, false, false, false), 9400)
  assert.ok(corrected.digTime(pick, false, true, false) > 9400)
  assert.equal(original.material, d.blocksByName.obsidian.material)
})
test('收到服务器工具标签后按标签给候选工具计时，标签重载会替换旧数据', () => {
  const d = require('minecraft-data')('1.21.11'),
    bot = { registry: d, _client: new EventEmitter() }
  observeToolTags(bot)
  const block = require('prismarine-block')('1.21.11').fromStateId(d.blocksByName.oak_log.defaultState, 0)
  const tool = { name: 'diamond_axe', type: d.itemsByName.diamond_axe.id }
  const reload = (entries) =>
    bot._client.emit('tags', {
      tags: [{ tagType: 'minecraft:block', tags: [{ tagName: 'minecraft:mineable/axe', entries }] }],
    })
  reload([])
  assert.equal(blockForTool(bot, block, tool).material, 'default')
  reload([block.type])
  assert.equal(blockForTool(bot, block, tool).material, 'mineable/axe')
})
test('优先把十钻带回家，储粮按可食用饥饿值核算', async () => {
  const inventory = [
    { name: 'diamond', count: 9 },
    { name: 'beef', count: 40 },
    { name: 'bread', count: 7 },
  ]
  const bot = {
    entity: { position: home },
    inventory: { items: () => inventory },
    registry: { foodsByName: { bread: { foodPoints: 5 } } },
    food: 20,
  }
  const actions = []
  const route = createHomeRoute({
    safe: () => true,
    show: () => {},
    log: () => {},
    withdrawDepot: async () => {},
    collect: async (b, k) => actions.push(k),
  })
  const s = { stage: 1 }
  await route.run(bot, home, s, () => {})
  assert.equal(s.stage, 1)
  assert.deepEqual(actions, ['diamond'])
  inventory[0].count++
  await route.run(bot, home, s, () => {})
  assert.equal(s.stage, 2)
  assert.equal(readyFood(bot), 35)
  inventory[2].count++
  assert.equal(readyFood(bot), STOCK)
  assert.deepEqual(['diamond', 'cobblestone', 'bone', 'diamond_sword', 'bread'].map(category), [0, 1, 2, -1, -1])
})
test('旧的找村庄存档改为返家，在基地不会再次出发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-route-test-'))
  const file = path.join(dir, 'trip.json')
  try {
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        world: 'local',
        phase: 'searching',
        base: [-16, 0, 0],
        room: [-16, 0, 0],
        spawn: [-15, 0, 1],
        route: [[-16, 0, 0]],
      }),
    )
    const trip = createVillageExpedition({
      statePath: file,
      world: 'local',
      homeOnly: true,
      foodReserve: () => 8,
      safe: () => true,
      log: () => {},
    })
    const bot = { game: { dimension: 'overworld' }, entity: { position: home } }
    await trip.continueTrip(bot, home)
    assert.equal(trip.status().reason, 'home-route')
    assert.equal(await trip.prepare(bot, home, {}), 'home-ready')
    assert.equal(trip.active(bot, home), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
