const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')

const AIR = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|snow)$/
const WOOD = /_planks$/
const DOOR = /^(?!iron_)[a-z_]+_door$/
const BED = /_bed$/
const STONE = ['cobblestone', 'cobbled_deepslate']
const DOWN = new Vec3(0, -1, 0)
const FACES = [DOWN, new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const SITES = [[-2, 4], [-6, -2], [-2, -6], [4, -2], [-6, 4], [4, 4], [4, -6], [-6, -6], [-2, 6], [6, -2], [-8, -2], [-2, -8]]
const PERIMETER = []
const INTERIOR = []
for (let x = 0; x < 4; x++) {
  for (let z = 0; z < 4; z++) (x === 0 || z === 0 || x === 3 || z === 3 ? PERIMETER : INTERIOR).push([x, z])
}
const LIGHTS = [[-1, 1], [4, 1], [1, -1], [1, 4], [2, 1]]
const DOOR_XZ = [2, 3]
const isShell = block => STONE.includes(block?.name) || WOOD.test(block?.name)
const serialize = position => [position.x, position.y, position.z]

function shelterGeometry(origin) {
  const walls = [0, 1].flatMap(y => PERIMETER.filter(([x, z]) => x !== DOOR_XZ[0] || z !== DOOR_XZ[1])
    .map(([x, z]) => origin.offset(x, y, z)))
  const roof = [...PERIMETER, ...INTERIOR].map(([x, z]) => origin.offset(x, 2, z))
  return { shell: [...walls, ...roof], lights: LIGHTS.map(([x, z]) => origin.offset(x, 0, z)),
    door: origin.offset(2, 0, 3), outside: origin.offset(2, 0, 4), inside: origin.offset(2, 0, 2),
    foot: origin.offset(1, 0, 2), head: origin.offset(1, 0, 1) }
}

function createExpeditionShelter(api, persist) {
  const ground = block => block?.boundingBox === 'block' && !/leaves|_log|_wood|ice|magma|cactus|campfire|sand|gravel/.test(block.name)
  const empty = block => Boolean(block && AIR.test(block.name))
  const bare = block => /^(air|cave_air|void_air)$/.test(block?.name)
  const blockAt = (connection, position) => connection.blockAt(position)
  let retryBedAfter = 0

  function findSite(connection, base) {
    for (const [x, z] of SITES) {
      for (const dy of [0, 1, -1, 2, -2]) {
        const origin = base.offset(x, dy, z)
        const layout = shelterGeometry(origin)
        const feet = [...PERIMETER, ...INTERIOR].map(([x, z]) => origin.offset(x, 0, z))
        if ([...feet, ...layout.lights, layout.outside].every(position => ground(blockAt(connection, position.offset(0, -1, 0)))) &&
            [...feet, ...feet.map(position => position.offset(0, 1, 0)), ...layout.shell, ...layout.lights, layout.outside]
              .every(position => empty(blockAt(connection, position)))) return origin
      }
    }
    return null
  }

  async function move(connection, position, label) {
    if (connection.entity.position.floored().equals(position)) return api.safe(connection)
    await api.travel(connection, new goals.GoalBlock(position.x, position.y, position.z), label, 7500).catch(() => {})
    return api.safe(connection) && connection.entity.position.floored().equals(position)
  }

  async function clearPlants(connection, target) {
    let plant = blockAt(connection, target)
    if (bare(plant)) return true
    if (!empty(plant) || !api.safe(connection)) return false
    if (!connection.canDigBlock(plant) || !connection.canSeeBlock(plant)) {
      await api.travel(connection, new goals.GoalLookAtBlock(target, connection.world, { reach: 4.2 }), 'clear shelter vegetation', 5000).catch(() => {})
      plant = blockAt(connection, target)
    }
    if (bare(plant)) return true
    if (!empty(plant) || !api.safe(connection) || !connection.canDigBlock(plant)) return false
    await connection.dig(plant, true).catch(() => {})
    return bare(blockAt(connection, target))
  }

  async function place(connection, target, item, faces, north = false) {
    if (!item || !api.safe(connection) || !await clearPlants(connection, target)) return false
    const goal = new goals.GoalPlaceBlock(target, connection.world, { faces, range: 4.3 })
    const click = () => goal.getFaceAndRef(connection.entity.position.offset(0, connection.entity.eyeHeight ?? 1.62, 0))
    const feet = connection.entity.position.floored()
    if (!click() || goal.isStandingIn(feet)) {
      const canPlace = goal.isEnd.bind(goal)
      goal.isEnd = node => !feet.equals(node) && canPlace(node)
      await api.travel(connection, goal, 'expedition shelter placement', 7000).catch(() => {})
    }
    const action = click()
    if (!action || goal.isStandingIn(connection.entity.position.floored()) || !api.safe(connection)) return false
    const reference = blockAt(connection, action.ref)
    if (!reference) return false
    await connection.equip(item, 'hand')
    if (!api.safe(connection) || !bare(blockAt(connection, target))) return false
    if (north) await connection.lookAt(connection.entity.position.offset(0, 0, -4), true)
    await connection._placeBlockWithOptions(reference, action.face.scaled(-1), {
      delta: action.to.minus(action.ref), swingArm: 'right', ...(north ? { forceLook: 'ignore' } : {}),
    }).catch(error => api.log('expedition shelter placement interrupted', { target, message: error.message }))
    return blockAt(connection, target)?.name === item.name
  }

  const within = (connection, origin) => {
    const feet = connection.entity.position.floored().minus(origin)
    return feet.x >= 1 && feet.x <= 2 && feet.z >= 1 && feet.z <= 2 && feet.y === 0
  }

  async function door(connection, layout, open) {
    const block = blockAt(connection, layout.door)
    if (!DOOR.test(block?.name) || !api.safe(connection) || connection.entity.position.distanceTo(layout.door) > 4) return false
    if (block.getProperties().open !== open) {
      await connection.activateBlock(block)
      await connection.waitForTicks(3)
    }
    return blockAt(connection, layout.door)?.getProperties().open === open
  }

  async function throughDoor(connection, layout, target) {
    if (blockAt(connection, layout.door)?.getProperties().open !== true ||
        [target, target.offset(0, 1, 0)].some(position => {
          const block = blockAt(connection, position)
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

  async function enter(connection, origin) {
    const layout = shelterGeometry(origin)
    if (!within(connection, origin)) {
      if (!await move(connection, layout.outside, 'temporary shelter doorway') || !await door(connection, layout, true) ||
          !await throughDoor(connection, layout, layout.inside)) return false
    }
    return door(connection, layout, false)
  }

  async function leave(connection, origin) {
    if (!within(connection, origin)) return true
    const layout = shelterGeometry(origin)
    return await move(connection, layout.inside, 'align with shelter doorway') && await door(connection, layout, true) &&
      await throughDoor(connection, layout, layout.outside) &&
      await door(connection, layout, false)
  }

  async function setSpawn(connection, position) {
    if (Date.now() < retryBedAfter) return false
    retryBedAfter = Date.now() + 4500
    const bed = blockAt(connection, position)
    if (!BED.test(bed?.name)) return false
    let confirmed = false
    const message = packet => {
      if (JSON.stringify(packet?.json ?? packet).includes('block.minecraft.set_spawn') || /respawn point set|已设置重生点/i.test(packet?.toString() ?? '')) confirmed = true
    }
    connection.on('message', message)
    try {
      // Clicking also sets the personal spawn in daylight. Wait for server feedback.
      await connection.activateBlock(bed)
      for (let beat = 0; beat < 16 && !confirmed && !connection.isSleeping && api.safe(connection); beat++) await connection.waitForTicks(1)
      if (!confirmed && !connection.isSleeping) return false
      api.log('expedition respawn confirmed', { position })
      return true
    } finally { connection.removeListener('message', message) }
  }

  async function prepare(connection, state, base, services) {
    const inventory = () => connection.inventory.items()
    if (!state.room) {
      const origin = findSite(connection, base)
      if (!origin) return 'shelter-no-site'
      state.room = serialize(origin)
      persist()
      api.log('expedition shelter site selected', { position: origin })
    }
    const origin = new Vec3(...state.room)
    const layout = shelterGeometry(origin)
    let count = 0
    for (const position of layout.shell) {
      if (isShell(blockAt(connection, position))) continue
      const material = inventory().find(item => STONE.includes(item.name) || WOOD.test(item.name))
      if (!material) {
        if (await api.planks(8)) return 'shelter-building'
        await services.collect('stone', STONE, 16)
        return 'shelter-materials'
      }
      if (await place(connection, position, material, FACES)) count++
      if (count >= 8 || !api.safe(connection)) return 'shelter-building'
    }
    const obstruction = layout.shell.find(position => !isShell(blockAt(connection, position)))
    if (obstruction) {
      api.log('expedition shelter part deferred', { position: obstruction, block: blockAt(connection, obstruction)?.name })
      return count ? 'shelter-building' : 'shelter-obstructed'
    }
    const lower = blockAt(connection, layout.door)
    if (!DOOR.test(lower?.name) || !DOOR.test(blockAt(connection, layout.door.offset(0, 1, 0))?.name)) {
      if (!empty(lower) || !empty(blockAt(connection, layout.door.offset(0, 1, 0)))) return 'shelter-door-obstructed'
      const item = inventory().find(item => DOOR.test(item.name))
      if (!item) {
        if (await api.planks(6)) {
          const boards = inventory().find(item => WOOD.test(item.name) && item.count >= 6)
          if (boards) await services.make(boards.name.replace('_planks', '_door'))
        } else await services.collect('wood')
        return 'shelter-door'
      }
      await place(connection, layout.door, item, [DOWN])
      return 'shelter-door'
    }
    for (const position of layout.lights) {
      if (blockAt(connection, position)?.name === 'torch') continue
      const light = inventory().find(item => item.name === 'torch')
      if (!light) return 'shelter-needs-torches'
      if (position.equals(layout.lights.at(-1)) && !await enter(connection, origin)) return 'shelter-doorway'
      if (!await place(connection, position, light, [DOWN])) return 'shelter-torch-blocked'
    }
    if (!BED.test(blockAt(connection, layout.foot)?.name) || !BED.test(blockAt(connection, layout.head)?.name)) {
      const bed = inventory().find(item => BED.test(item.name))
      if (!bed) {
        await leave(connection, origin)
        await api.acquireBed()
        return 'shelter-acquiring-bed'
      }
      if (!empty(blockAt(connection, layout.foot)) || !empty(blockAt(connection, layout.head))) return 'shelter-bed-obstructed'
      if (!await enter(connection, origin)) return 'shelter-doorway'
      if (!await clearPlants(connection, layout.head)) return 'shelter-bed-obstructed'
      await place(connection, layout.foot, bed, [DOWN], true)
      return 'shelter-bed'
    }
    if (!state.spawn) {
      if (!await enter(connection, origin) || !await setSpawn(connection, layout.foot)) return 'shelter-setting-spawn'
      state.spawn = serialize(layout.head)
      persist()
    }
    return 'ready'
  }

  return { prepare, leave, enter, within }
}

module.exports = { createExpeditionShelter, shelterGeometry }
