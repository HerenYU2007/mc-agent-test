const assert = require('node:assert/strict')
const { once } = require('node:events')
const http = require('node:http')
const test = require('node:test')
const { findNearestVillages, handleVillageLookup } = require('../agent/village-locator')

const seed = '-7046029254386353131'
const expected = [[12272, 1168], [13744, 1712], [13200, 592], [13936, 1168], [13072, 384]]

test('matches the five villages verified in default Java 1.21.11', () => {
  const result = findNearestVillages(seed, 12884, 1510)
  assert.equal(result.version, '1.21.11')
  assert.equal(result.radius, 12288)
  assert.deepEqual(result.villages.map(({ x, z }) => [x, z]), expected)
  assert(result.villages.every((village, i) => i === 0 || village.distance >= result.villages[i - 1].distance))
})

test('keeps the full signed 64-bit seed and enforces coordinate limits', () => {
  for (const value of ['-9223372036854775808', '9223372036854775807', '0']) {
    const { villages } = findNearestVillages(value, -29999984, 29999984)
    assert(villages.every(({ x, z }) => Math.abs(x) <= 29999984 && Math.abs(z) <= 29999984))
  }
  for (const value of ['-9223372036854775809', '9223372036854775808', '1e3', 123]) {
    assert.throws(() => findNearestVillages(value, 0, 0), TypeError)
  }
  assert.throws(() => findNearestVillages(seed, 0.25, 0), TypeError)
  assert.throws(() => findNearestVillages(seed, 0, -29999985), TypeError)
})

test('lookup HTTP handler accepts JSON, rejects bad or oversized bodies and disables caching', async t => {
  const server = http.createServer(handleVillageLookup).listen(0, '127.0.0.1')
  t.after(() => new Promise(resolve => server.close(resolve)))
  await once(server, 'listening')
  const url = 'http://127.0.0.1:' + server.address().port + '/villages'
  const post = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
  const good = await post(JSON.stringify({ seed, baseX: 12884, baseZ: 1510 }))
  assert.equal(good.status, 200)
  assert.equal(good.headers.get('cache-control'), 'no-store')
  assert.deepEqual((await good.json()).villages.map(({ x, z }) => [x, z]), expected)
  for (const [body, status] of [['{', 400], ['null', 400], [' '.repeat(1025), 413]]) {
    const response = await post(body)
    assert.equal(response.status, status)
    assert.equal(typeof (await response.json()).error, 'string')
  }
})
