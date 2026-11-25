const { randomUUID } = require('node:crypto')

const ORE_KINDS = {
  coal: ['coal_ore', 'deepslate_coal_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  quartz: ['nether_quartz_ore'],
  debris: ['ancient_debris'],
}
const nether = new Set(['nether_gold_ore', 'nether_quartz_ore', 'ancient_debris'])
const overworld = Object.values(ORE_KINDS).flat().filter(name => !nether.has(name))
const CHUNK_SIZE = 16
const MAX_BATCH = 128
const REQUEST_LIFETIME = 45000
const RESCAN_INTERVAL = 30000
const INITIAL_WAIT = 3000
const MIN_Y = -64
const MAX_Y = 319

const position = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))
const chunk = value => Math.floor(value / CHUNK_SIZE)
const inArea = ([x, , z], { chunkX, chunkZ }) =>
  Math.abs(chunk(x) - chunkX) <= 1 && Math.abs(chunk(z) - chunkZ) <= 1

function createOreFeed(initial, frame, now = Date.now) {
  const session = randomUUID()
  const names = initial.dimension === 'the_nether' ? [...nether] : initial.dimension === 'overworld' ? overworld : []
  const allowed = new Set(names)
  const ores = new Map()
  let scan
  const sameBot = status => status.username === initial.username && status.server === initial.server &&
    status.dimension === initial.dimension && position(status.pos)

  function request(status, types) {
    if (!sameBot(status) || !frame().connected || !types.some(name => allowed.has(name))) return
    const chunkX = chunk(status.pos[0])
    const chunkZ = chunk(status.pos[2])
    const time = now()
    if (scan && scan.chunkX === chunkX && scan.chunkZ === chunkZ &&
        time - (scan.completedAt ?? scan.startedAt) < (scan.completedAt == null ? REQUEST_LIFETIME : RESCAN_INTERVAL)) {
      return
    }
    scan = { id: randomUUID(), chunkX, chunkZ, startedAt: time, received: new Set(), reported: new Set() }
    for (const [key, ore] of ores) if (!inArea(ore.pos, scan)) ores.delete(key)
  }

  function activeRequest() {
    if (!scan || scan.completedAt != null || now() - scan.startedAt >= REQUEST_LIFETIME) return null
    const bot = frame()
    if (!bot.connected || chunk(bot.position.x) !== scan.chunkX || chunk(bot.position.z) !== scan.chunkZ) return null
    return { id: scan.id, dimension: initial.dimension, chunkX: scan.chunkX, chunkZ: scan.chunkZ, names }
  }

  function pending() {
    return activeRequest() !== null && now() - scan.startedAt < INITIAL_WAIT
  }

  function receive(body) {
    const bot = frame()
    const active = activeRequest()
    if (!body || !active || body.session !== session || body.requestId !== active.id ||
        body.dimension !== active.dimension || body.username !== initial.username || !position(body.seenBot) ||
        distance(body.seenBot, [bot.position.x, bot.position.y, bot.position.z]) > 8 ||
        chunk(body.seenBot[0]) !== active.chunkX || chunk(body.seenBot[2]) !== active.chunkZ) return 409
    if (!Array.isArray(body.ores) || body.ores.length > MAX_BATCH || !Number.isSafeInteger(body.sampledAt) ||
        body.sampledAt < scan.startedAt || Math.abs(now() - body.sampledAt) > REQUEST_LIFETIME ||
        !Number.isSafeInteger(body.batch) || !Number.isSafeInteger(body.batches) ||
        body.batches < 1 || body.batches > Math.ceil(9 * CHUNK_SIZE ** 2 * (MAX_Y - MIN_Y + 1) / MAX_BATCH) ||
        body.batch < 0 || body.batch >= body.batches ||
        (scan.batches != null && scan.batches !== body.batches) ||
        (scan.sampledAt != null && scan.sampledAt !== body.sampledAt)) return 400
    for (const ore of body.ores) {
      if (!allowed.has(ore?.name) || !position(ore.pos) || !ore.pos.every(Number.isSafeInteger) ||
          ore.pos[1] < MIN_Y || ore.pos[1] > MAX_Y || ore.pos.some(n => Math.abs(n) > 30000000) ||
          !inArea(ore.pos, active)) return 400
    }
    if (scan.received.has(body.batch)) return 200
    scan.batches = body.batches
    scan.sampledAt = body.sampledAt
    for (const ore of body.ores) {
      const key = ore.pos.join(',')
      scan.reported.add(key)
      if (!scan.invalidated?.has(key)) ores.set(key, { name: ore.name, pos: ore.pos })
    }
    scan.received.add(body.batch)
    if (scan.received.size === scan.batches) {
      scan.completedAt = now()
      for (const key of ores.keys()) if (!scan.reported.has(key)) ores.delete(key)
    }
    return 200
  }

  function candidates(status, types) {
    request(status, types)
    if (!scan || !sameBot(status) || !frame().connected) return []
    const set = new Set(types)
    return [...ores.values()].filter(ore => set.has(ore.name) && inArea(ore.pos, scan)).map(ore => ({
      ...ore, dist: distance(ore.pos, status.pos), source: 'observer',
    })).sort((a, b) => a.dist - b.dist)
  }

  function forget(status, pos, name) {
    if (!scan || !sameBot(status) || !position(pos)) return
    const key = pos.join(',')
    if (ores.get(key)?.name !== name) return
    ores.delete(key)
    if (!scan.invalidated) scan.invalidated = new Set()
    scan.invalidated.add(key)
  }

  async function handle(request, response) {
    if (request.headers.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') {
      response.writeHead(415).end()
      return
    }
    try {
      const chunks = []
      let size = 0
      for await (const piece of request) {
        size += piece.length
        if (size > 16384) { response.writeHead(413).end(); return }
        chunks.push(piece)
      }
      response.writeHead(receive(JSON.parse(Buffer.concat(chunks).toString('utf8')))).end()
    } catch {
      if (!response.headersSent) response.writeHead(400).end()
    }
  }
  return { session, activeRequest, pending, candidates, forget, handle, receive }
}

module.exports = { ORE_KINDS, createOreFeed }
