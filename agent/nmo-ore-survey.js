const { setTimeout: delay } = require('node:timers/promises')

function* surveyCells(origin, radius, minY, maxY) {
  for (let shell = 0; shell <= radius; shell++) {
    for (let y = -shell; y <= shell; y++) {
      if (origin[1] + y < minY || origin[1] + y > maxY) continue
      for (let z = -shell; z <= shell; z++) {
        const edge = Math.abs(y) === shell || Math.abs(z) === shell
        const stride = edge ? 1 : Math.max(1, 2 * shell)
        for (let x = -shell; x <= shell; x += stride) {
          if (x * x + y * y + z * z <= radius * radius) yield [origin[0] + x, origin[1] + y, origin[2] + z]
        }
      }
    }
  }
}

function createOreSurvey(origin, types, { radius = 6, minY = -64, maxY = 319, concurrency = 3 } = {}) {
  if (
    !Array.isArray(origin) ||
    origin.length !== 3 ||
    !origin.every(Number.isFinite) ||
    !Number.isInteger(radius) ||
    radius < 0 ||
    radius > 128 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 8 ||
    !Number.isInteger(minY) ||
    !Number.isInteger(maxY) ||
    minY > maxY
  )
    throw RangeError('无效的矿物扫描区域')
  const cells = surveyCells(origin.map(Math.floor), radius, minY, maxY)
  const wanted = new Set(types)
  const retry = []
  let exhausted = false
  return async function scan(read, { budget = 24, signal, shouldYield } = {}) {
    if (!Number.isSafeInteger(budget) || budget < 1) throw RangeError('无效的扫描预算')
    const found = []
    let reads = 0,
      unloaded = 0
    while (reads < budget && !signal?.aborted) {
      if (shouldYield && (await shouldYield())) break
      const batch = []
      while (batch.length < Math.min(concurrency, budget - reads)) {
        const cell = retry.length ? { value: retry.pop() } : cells.next()
        if (cell.done) {
          exhausted = true
          break
        }
        batch.push(cell.value)
      }
      if (!batch.length) break
      const replies = await Promise.allSettled(batch.map(read))
      let error
      for (const [i, reply] of replies.entries()) {
        if (reply.status === 'fulfilled') {
          if (wanted.has(reply.value.name)) found.push({ name: reply.value.name, pos: batch[i] })
        } else if (reply.reason?.code === 'not_loaded') {
          unloaded++
        } else {
          retry.push(batch[i])
          error ||= reply.reason
        }
      }
      reads += batch.length
      if (error) throw error
      if (!exhausted && reads < budget) await delay(10, undefined, { signal })
    }
    return { found, reads, unloaded, done: exhausted && !retry.length }
  }
}
module.exports = { createOreSurvey }
