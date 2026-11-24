const { randomUUID } = require('node:crypto')

const minerals = new Set(['coal_ore','deepslate_coal_ore','iron_ore','deepslate_iron_ore',
  'redstone_ore','deepslate_redstone_ore','diamond_ore','deepslate_diamond_ore','ancient_debris'])
const position = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)
const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]))

function createOreFeed(initial, frame, now = Date.now) {
  const session = randomUUID()
  let snapshot
  function receive(body) {
    const bot = frame()
    if (!body || body.session !== session || !bot.connected || body.dimension !== initial.dimension ||
        body.username !== initial.username || !position(body.seenBot) ||
        distance(body.seenBot, [bot.position.x,bot.position.y,bot.position.z]) > 8) return 409
    if (!Array.isArray(body.ores) || body.ores.length > 128 || !Number.isSafeInteger(body.sampledAt) ||
        Math.abs(now() - body.sampledAt) > 45000 || (snapshot && body.sampledAt < snapshot.at)) return 400
    const seen = new Set()
    const ores = []
    for (const ore of body.ores) {
      if (!minerals.has(ore?.name) || !position(ore.pos) || !ore.pos.every(Number.isSafeInteger) ||
          ore.pos[1] < -64 || ore.pos[1] > 319 || ore.pos.some(n => Math.abs(n) > 30000000)) return 400
      if ((ore.name === 'ancient_debris') !== (initial.dimension === 'the_nether')) return 400
      const key = ore.pos.join(',')
      if (seen.has(key)) continue
      seen.add(key)
      ores.push({name:ore.name, pos:ore.pos})
    }
    snapshot = { at:body.sampledAt, ores }
    return 200
  }
  function candidates(status, types) {
    if (!snapshot || now() - snapshot.at > 45000 || !frame().connected ||
        status.server !== initial.server || status.dimension !== initial.dimension ||
        status.username !== initial.username || !position(status.pos)) return []
    return snapshot.ores.filter(o => types.includes(o.name)).map(o => ({
      ...o, dist:distance(o.pos,status.pos), source:'observer'
    })).filter(o => o.dist <= 192).sort((a,b) => a.dist-b.dist)
  }
  async function handle(request,response) {
    if (request.headers.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') {
      response.writeHead(415).end(); return
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
    } catch { if (!response.headersSent) response.writeHead(400).end() }
  }
  return { session, candidates, handle, receive }
}
module.exports = { createOreFeed }
