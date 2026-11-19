const path = require('node:path')
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { SupplyStation } = require('../supply-station')
const { hutBlueprint, hutEntrance } = require('../starter-hut')

const BLUEPRINT = path.join(__dirname, '..', 'blueprints', 'starter-hut-5x5.litematic')
const DOOR = /^(?!iron_)[a-z_]+_door$/
const vector = ({ x, y, z }) => new Vec3(x, y, z)
const coordinates = position => position.toArray()

function shelterGeometry(site) {
  const { center, front, entry } = site
  const cells = hutBlueprint(site)
  const bed = cells.find(cell => cell.block === 'bed')
  return {
    cells, door: center.plus(front.scaled(2)), outside: entry, inside: center.plus(front),
    foot: bed.position, head: bed.pair,
  }
}

// Existing expedition saves used the northwest corner of the old 4×4 room.
function legacyGeometry(origin) {
  return {
    door: origin.offset(2, 0, 3), outside: origin.offset(2, 0, 4),
    inside: origin.offset(2, 0, 2),
  }
}

function savedSite(state) {
  const site = state.hut?.site
  return site && { ...site, center: vector(site.center), front: vector(site.front), entry: vector(site.entry) }
}

function legacyOwns(room, position) {
  if (!room) return false
  const { x, y, z } = position.minus(new Vec3(...room))
  const footprint = x >= 0 && x < 4 && z >= 0 && z < 4
  return (footprint && (y === 2 || (y >= 0 && y < 2 && (x === 0 || x === 3 || z === 0 || z === 3)))) ||
    (y === 0 && [[-1, 1], [4, 1], [1, -1], [1, 4], [2, 1], [1, 2], [1, 1]].some(([dx, dz]) => x === dx && z === dz))
}

function createExpeditionShelter(api, persist) {
  let construction = null
  let owner = null

  function layoutFor(state) {
    const site = savedSite(state)
    if (!site) return state.room && legacyGeometry(new Vec3(...state.room))
    return {
      door: site.center.plus(site.front.scaled(2)), outside: site.entry,
      inside: site.center.plus(site.front),
    }
  }

  function within(connection, state) {
    if (!state.room) return false
    const origin = new Vec3(...state.room)
    const { x, y, z } = connection.entity.position.floored().minus(origin)
    if (state.hut) return y === 0 && Math.abs(x) <= 1 && Math.abs(z) <= 1
    return y === 0 && x >= 1 && x <= 2 && z >= 1 && z <= 2
  }

  async function move(connection, position, label) {
    if (connection.entity.position.floored().equals(position)) return api.safe(connection)
    await api.travel(connection, new goals.GoalBlock(position.x, position.y, position.z), label, 7500).catch(() => {})
    return api.safe(connection) && connection.entity.position.floored().equals(position)
  }

  async function door(connection, layout, open) {
    const block = connection.blockAt(layout.door)
    if (!DOOR.test(block?.name) || !api.safe(connection) || connection.entity.position.distanceTo(layout.door) > 4) return false
    if (block.getProperties().open !== open) {
      await connection.activateBlock(block)
      await connection.waitForTicks(3)
    }
    return connection.blockAt(layout.door)?.getProperties().open === open
  }

  async function throughDoor(connection, layout, target) {
    if (connection.blockAt(layout.door)?.getProperties().open !== true ||
        [target, target.offset(0, 1, 0)].some(position => {
          const block = connection.blockAt(position)
          return !block || block.shapes?.length
        })) return false
    const eye = connection.entity.eyeHeight ?? 1.62
    await connection.lookAt(target.offset(0.5, eye, 0.5), true)
    connection.setControlState('forward', true)
    try {
      for (let tick = 0; tick < 30 && api.safe(connection); tick++) {
        if (connection.entity.position.floored().equals(target)) return true
        await connection.waitForTicks(1)
      }
      return false
    } finally { connection.setControlState('forward', false) }
  }

  async function enter(connection, state) {
    const layout = layoutFor(state)
    if (!layout) return false
    if (!within(connection, state)) {
      if (!await move(connection, layout.outside, 'temporary shelter doorway') || !await door(connection, layout, true) ||
          !await throughDoor(connection, layout, layout.inside)) return false
    }
    return door(connection, layout, false)
  }

  async function leave(connection, state) {
    if (!within(connection, state)) return true
    const layout = layoutFor(state)
    return await move(connection, layout.inside, 'align with shelter doorway') && await door(connection, layout, true) &&
      await throughDoor(connection, layout, layout.outside) && await door(connection, layout, false)
  }

  function prepareConstruction(state) {
    if (owner === state && construction) return construction
    const station = new SupplyStation(null, true, null, true, BLUEPRINT, {
      progress: state.hut,
      saveProgress: progress => {
        state.hut = progress
        state.room = coordinates(progress.site.center)
        if (progress.spawnSet) state.spawn = coordinates(shelterGeometry(progress.site).head)
        persist()
      },
    })
    owner = state
    construction = station
    return station
  }

  async function prepare(connection, state, base, services) {
    if (!state.hut && state.room) {
      if (state.spawn) return 'ready'
      state.legacyRoom = state.room
      state.room = null
      persist()
    }
    const station = prepareConstruction(state)
    if (station.completed) return 'ready'
    await api.buildShelter(station, {
      siteOrigin: base,
      allowSite: site => {
        const { center, entry } = site
        if (entry.y !== center.y) return false
        for (let x = -2; x <= 2; x++) {
          for (let z = -2; z <= 2; z++) {
            for (let y = -1; y <= 3; y++) {
              if (services.occupied(center.offset(x, y, z))) return false
            }
          }
        }
        return [...hutEntrance(site), ...hutBlueprint(site).filter(cell => cell.phase === '照明').map(cell => cell.position)]
          .every(position => !services.occupied(position))
      },
    })
    return station.completed ? 'ready' : station.site ? 'shelter-building' : 'shelter-no-site'
  }

  function owns(state, position) {
    if (!position) return false
    const site = savedSite(state)
    if (!site) return legacyOwns(state.room ?? state.legacyRoom, position)
    if (legacyOwns(state.legacyRoom, position)) return true
    const { x, y, z } = position.minus(site.center)
    if (Math.abs(x) <= 2 && Math.abs(z) <= 2 && y >= -1 && y <= 3) return true
    return [...hutEntrance(site), ...hutBlueprint(site).filter(cell => cell.phase === '照明').map(cell => cell.position)]
      .some(target => target.equals(position))
  }

  return { prepare, leave, enter, within, owns, status: state => state.hut || owner === state ? prepareConstruction(state).status() : null }
}

module.exports = { createExpeditionShelter, shelterGeometry }
