const http = require('node:http')
const fs = require('node:fs')
const { homedir } = require('node:os')
const { dirname, join } = require('node:path')

const STRUCTURES = {
  village: { label: '村庄', dimension: 'overworld', mergeDistance: 52 },
  desert_pyramid: { label: '沙漠神殿', dimension: 'overworld', mergeDistance: 32 },
  jungle_temple: { label: '丛林神庙', dimension: 'overworld', mergeDistance: 24 },
  monument: { label: '海底神殿', dimension: 'overworld', mergeDistance: 64 },
  fortress: { label: '下界要塞', dimension: 'the_nether', mergeDistance: 96 },
  bastion: { label: '堡垒遗迹', dimension: 'the_nether', mergeDistance: 64 },
  end_city: { label: '末地城', dimension: 'the_end', mergeDistance: 64 },
}
const MAX_BATCH = 24
const MAX_BODY = 8192
const MAX_COORDINATE = 29999999
const FILE = join(homedir(), '.nmo-agent', 'observed-structures.jsonl')

function validRecord(entry) {
  return entry && Object.hasOwn(STRUCTURES, entry.type) && STRUCTURES[entry.type].dimension === entry.dimension &&
    Array.isArray(entry.pos) && entry.pos.length === 3 && entry.pos.every(Number.isSafeInteger) &&
    Math.abs(entry.pos[0]) <= MAX_COORDINATE && Math.abs(entry.pos[2]) <= MAX_COORDINATE &&
    entry.pos[1] >= -64 && entry.pos[1] <= 319 &&
    typeof entry.world === 'string' && entry.world.length <= 160 && entry.world.trim().length > 0 &&
    !/[\x00-\x1f\x7f]/.test(entry.world) &&
    Array.isArray(entry.evidence) && entry.evidence.length >= 2 && entry.evidence.length <= 8 &&
    new Set(entry.evidence).size === entry.evidence.length &&
    entry.evidence.every(clue => typeof clue === 'string' && /^[a-z_]{2,40}$/.test(clue))
}

function matchingSite(a, b) {
  return a.world === b.world && a.dimension === b.dimension && a.type === b.type &&
    Math.abs(a.pos[1] - b.pos[1]) <= 48 &&
    Math.hypot(a.pos[0] - b.pos[0], a.pos[2] - b.pos[2]) <= STRUCTURES[a.type].mergeDistance
}

function createStructureStore({ file = process.env.MC_STRUCTURE_FILE || FILE, now = Date.now } = {}) {
  let records = [], loadedSize = -1

  function refresh() {
    const size = fs.statSync(file, { throwIfNoEntry: false })?.size || 0
    if (size === loadedSize) return
    const next = []
    if (size) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const record = JSON.parse(line)
          if (validRecord(record) && Number.isFinite(record.seenAt)) next.push(record)
        } catch {
          // An interrupted last write does not erase earlier observations.
        }
      }
    }
    records = next
    loadedSize = size
  }

  function report(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > MAX_BATCH || !entries.every(validRecord)) {
      throw new TypeError('结构上报格式无效')
    }
    refresh()
    const inserted = []
    for (const entry of entries) {
      const { type, dimension, world, pos, evidence } = entry
      const candidate = { type, dimension, world: world.trim(), pos, evidence: [...new Set(evidence)], seenAt: now() }
      if (records.some(other => matchingSite(other, candidate)) || inserted.some(other => matchingSite(other, candidate))) continue
      inserted.push(candidate)
    }
    if (inserted.length) {
      fs.mkdirSync(dirname(file), { recursive: true })
      const content = inserted.map(entry => JSON.stringify(entry)).join('\n') + '\n'
      fs.appendFileSync(file, content, 'utf8')
      records.push(...inserted)
      loadedSize += Buffer.byteLength(content)
    }
    return { added: inserted.length, duplicates: entries.length - inserted.length }
  }

  function list() {
    refresh()
    return records.map(record => ({ ...record, label: STRUCTURES[record.type].label }))
      .sort((a, b) => b.seenAt - a.seenAt)
  }
  return { report, list }
}

function json(response, code, data) {
  response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(data))
}

function createStructureRoutes(store = createStructureStore()) {
  async function post(request, response) {
    if (request.headers.origin || request.headers['content-type']?.split(';')[0] !== 'application/json') {
      json(response, 415, { error: '仅接收旁观者 Mod 上报' })
      return
    }
    try {
      const chunks = []
      let size = 0
      for await (const part of request) {
        size += part.length
        if (size > MAX_BODY) {
          json(response, 413, { error: '上报批次过大' })
          return
        }
        chunks.push(part)
      }
      json(response, 200, store.report(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
    } catch (error) {
      if (!response.headersSent) {
        const invalid = error instanceof TypeError || error instanceof SyntaxError
        json(response, invalid ? 400 : 500, { error: invalid ? '结构上报格式无效' : '本地结构表写入失败' })
      }
    }
  }

  return function route(request, response) {
    if (request.method === 'POST' && request.url === '/observer/structures') {
      void post(request, response)
      return true
    }
    if (request.method === 'GET' && request.url === '/api/structures') {
      try { json(response, 200, { entries: store.list() }) }
      catch { json(response, 500, { error: '本地结构表读取失败' }) }
      return true
    }
    if (request.method === 'GET' && request.url === '/structures') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(fs.readFileSync(join(__dirname, 'structure-table.html')))
      return true
    }
    return false
  }
}

if (require.main === module) {
  const port = Number(process.env.MC_STRUCTURE_PORT || 3001)
  const route = createStructureRoutes()
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('MC_STRUCTURE_PORT 无效')
  http.createServer((request, response) => {
    if (route(request, response)) return
    if (request.method === 'GET' && request.url === '/') response.writeHead(302, { location: '/structures' }).end()
    else response.writeHead(404).end()
  }).listen(port, '127.0.0.1', () => console.log('结构发现表 http://127.0.0.1:' + port + '/structures'))
}

module.exports = { createStructureStore, createStructureRoutes }
