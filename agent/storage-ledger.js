const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')

const types = new Set(['chest', 'trapped_chest', 'barrel'])
const isStorageBlock = name => types.has(name)
const isPosition = pos => Array.isArray(pos) && pos.length === 3 && pos.every(Number.isSafeInteger)

function createStorageLedger(world, { directory = path.join(os.homedir(), '.mc-agent', 'storage'), log = console.warn } = {}) {
  const id = createHash('sha256').update(world).digest('hex').slice(0, 24)
  const file = path.join(directory, id + '.json')

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data.version !== 1 || data.world !== world || !Array.isArray(data.containers)) {
        throw Error('仓储记录格式或世界不匹配')
      }
      return data
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { version: 1, world, containers: [] }
    }
  }

  function record(dimension, pos, type, stacks) {
    if (!isPosition(pos) || !isStorageBlock(type) || !Array.isArray(stacks)) return
    const counts = new Map()
    for (const item of stacks) {
      if (item?.name && Number.isSafeInteger(item.count) && item.count > 0) {
        counts.set(item.name, (counts.get(item.name) || 0) + item.count)
      }
    }
    const key = pos.join(',')
    const entry = { dimension, pos: pos.slice(), type, items: Object.fromEntries(counts), checkedAt: new Date().toISOString() }
    const tmp = file + '.' + randomUUID() + '.tmp'
    try {
      const data = read()
      data.containers = data.containers.filter(box => box.dimension !== dimension || box.pos.join(',') !== key)
      data.containers.push(entry)
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch {}
      log('仓储记录写入失败：' + error.message)
    }
  }

  function find(dimension, item, origin, range) {
    try {
      return read().containers
        .filter(box => box.dimension === dimension && isPosition(box.pos) && Object.hasOwn(box.items, item) && box.items[item] > 0)
        .map(box => ({ ...box, distance: Math.hypot(...box.pos.map((v, i) => v - origin[i])) }))
        .filter(box => box.distance <= range)
        .sort((a, b) => a.distance - b.distance)
    } catch (error) {
      log('仓储记录读取失败：' + error.message)
      return []
    }
  }

  return { file, record, find }
}

function recordNmoStorage(ledger, dimension, action, body, receipt) {
  const pos = body?.target?.pos ?? body?.pos
  const window = action === 'window/view' ? receipt : action === 'window/act' ? receipt?.window : null
  if (window) ledger.record(dimension, pos, window.target, window.sections?.container)
}

module.exports = { createStorageLedger, recordNmoStorage, isStorageBlock }
