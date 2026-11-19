const fs = require('node:fs')
const { once } = require('node:events')
const { Vec3 } = require('vec3')
const { goals } = require('mineflayer-pathfinder')

const AIR = /^(air|cave_air|void_air)$/
const STONE = ['cobblestone', 'cobbled_deepslate']
const FUEL = ['coal', 'charcoal']
const IRON = ['raw_iron', 'iron_ingot']
const FOOD = /^(bread|baked_potato|cooked_.+|apple|carrot|beetroot|melon_slice|sweet_berries|pumpkin_pie|golden_carrot|golden_apple|enchanted_golden_apple)$/
const WOOD_SLAB = /(?:oak|spruce|birch|jungle|acacia|mangrove|cherry|bamboo|crimson|warped)_slab$/
const COOKED = {
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton',
  chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod',
  salmon: 'cooked_salmon', potato: 'baked_potato',
}
const SPARES = [
  { name: 'iron_pickaxe', kind: /^(iron|diamond|netherite)_pickaxe$/, iron: 3 },
  { name: 'iron_sword', kind: /^(iron|diamond|netherite)_sword$/, iron: 2 },
  { name: 'shield', kind: /^shield$/, iron: 1, planks: 6, sticks: 0 },
]
const FOOD_TARGET = 8
const TORCH_TARGET = 16
const DURABILITY_TARGET = 24

function part(id, names, offset, support = [0, -1, 0], properties = {}) {
  return { id, names: [].concat(names), offset, support: new Vec3(...support), properties }
}

// The stairs give the Bot a view of the top faces on the intake stack.
const DEPOT = [
  part('table', 'crafting_table', [-2, 0, -1]),
  part('storage', 'barrel', [-2, 0, 1]),
]
const WORKSHOP = [
  part('output', 'barrel', [0, 0, 0]),
  part('drain', 'hopper', [0, 1, 0], undefined, { facing: 'down' }),
  part('furnace', 'furnace', [0, 2, 0]),
  part('step-1', STONE, [-1, 0, -2]),
  part('step-2-base', STONE, [-1, 0, -1]),
  part('step-2', STONE, [-1, 1, -1]),
  part('step-3-base', STONE, [-1, 0, 0]),
  part('step-3-middle', STONE, [-1, 1, 0]),
  part('step-3', STONE, [-1, 2, 0]),
  part('intake', 'hopper', [0, 3, 0], undefined, { facing: 'down' }),
  part('input', 'barrel', [0, 4, 0]),
  part('fuel-feed', 'hopper', [1, 2, 0], [-1, 0, 0], { facing: 'west' }),
  part('fuel', 'barrel', [1, 3, 0]),
  part('switch-base', STONE, [2, 0, 0]),
  part('switch-middle', STONE, [2, 1, 0]),
  part('switch-support', STONE, [2, 2, 0]),
  part('switch', 'lever', [3, 2, 0], [-1, 0, 0], { face: 'wall', facing: 'east' }),
  part('indicator', 'redstone_torch', [2, 2, 1], [0, 0, -1], { facing: 'south' }),
]
const PARTS = [...DEPOT, ...WORKSHOP]
const BY_ID = new Map(PARTS.map(piece => [piece.id, piece]))
const SITE_OFFSETS = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [4, 4], [-4, 4], [4, -4], [-4, -4],
  [7, 0], [-7, 0], [0, 7], [0, -7], [7, 7], [-7, 7], [7, -7], [-7, -7]]

function createSupplyBase(api) {
  let anchor = null
  let unlocked = false
  let trip = null
  let visitAfter = 0
  let emergencyAfter = 0
  let status = { phase: 'awaiting-armor', workshop: 'unbuilt', storedFood: null }
  const setPhase = (phase, extra = {}) => { status = { ...status, phase, ...extra } }

  try {
    const saved = JSON.parse(fs.readFileSync(api.statePath, 'utf8'))
    if (saved.version === 1 && saved.world === api.world) {
      if (saved.position === null) unlocked = true
      if (Array.isArray(saved.position) && saved.position.length === 3 && saved.position.every(Number.isSafeInteger)) {
        anchor = new Vec3(...saved.position)
        unlocked = true
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') api.log('base state could not be read', { message: error.message })
  }

  function saveProgress(position) {
    const pending = api.statePath + '.tmp'
    fs.writeFileSync(pending, JSON.stringify({
      version: 1, world: api.world, position: position && [position.x, position.y, position.z],
    }))
    fs.renameSync(pending, api.statePath)
    unlocked = true
    anchor = position
  }

  const items = connection => connection.inventory.items()
  const count = (list, names) => list.reduce((sum, item) => sum + (names.includes(item.name) ? item.count : 0), 0)
  const food = list => list.reduce((sum, item) => sum + (FOOD.test(item.name) ? item.count : 0), 0)
  const healthy = (list, kind) => list.some(item => kind.test(item.name) && api.durability(item) > DURABILITY_TARGET)
  const inOverworld = connection => connection?.game?.dimension === 'overworld'
  const piecePos = piece => anchor.offset(...piece.offset)
  const blockFor = (connection, id) => connection.blockAt(piecePos(BY_ID.get(id)))

  function matches(piece, block) {
    const name = piece.id === 'indicator' ? 'redstone_wall_torch' : null
    return (name ? block?.name === name : piece.names.includes(block?.name)) &&
      Object.entries(piece.properties).every(([key, value]) => block.getProperties()[key] === value)
  }

  function findSite(connection) {
    const feet = connection.entity.position.floored()
    for (const [dx, dz] of SITE_OFFSETS) {
      for (const dy of [0, 1, -1, 2, -2]) {
        const site = feet.offset(dx, dy, dz)
        if (!api.openSurface(connection, site.offset(0, 0, 2))) continue
        const hasFloor = (x, z) => {
          const floor = connection.blockAt(site.offset(x, -1, z))
          return floor?.boundingBox === 'block' && !/leaves|_log|_wood|ice|magma|cactus|campfire/.test(floor.name)
        }
        if (PARTS.every(piece => {
          const [x, y, z] = piece.offset
          return AIR.test(connection.blockAt(site.offset(x, y, z))?.name) && (y !== 0 || hasFloor(x, z))
        }) && [-2, -1, 0, 1, 2, 3].every(x => hasFloor(x, 2) && api.openSurface(connection, site.offset(x, 0, 2)))) {
          return site
        }
      }
    }
    return null
  }

  async function returnToBase(connection) {
    const entry = anchor.offset(0, 0, 2)
    const atEntrance = () => {
      const feet = connection.entity.position.floored()
      return feet.distanceTo(entry) <= 5 && feet.y >= entry.y - 1 && feet.y <= entry.y + 3
    }
    if (atEntrance()) return true
    setPhase('returning')
    const goal = new goals.GoalBlock(entry.x, entry.y, entry.z)
    await api.goto(goal, 'supply base', 18000).catch(() => {})
    return api.safe(connection) && atEntrance()
  }

  async function approach(connection, position) {
    const goal = new goals.GoalLookAtBlock(position, connection.world)
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight ?? 1.62, 0)
    const direction = position.offset(0.5, 0.5, 0.5).minus(eyes)
    if (direction.norm() <= 4.25 && connection.world.raycast(eyes, direction.normalize(), 4.5)?.position.equals(position)) return true
    await api.goto(goal, 'base workstation', 6500).catch(() => {})
    return api.safe(connection) && goal.isEnd(connection.entity.position.floored())
  }

  async function place(connection, piece) {
    const position = piecePos(piece)
    const goal = new goals.GoalPlaceBlock(position, connection.world, { faces: [piece.support], range: 4.4 })
    const click = () => goal.getFaceAndRef(connection.entity.position.offset(0, connection.entity.eyeHeight ?? 1.62, 0))
    if (!click() || goal.isStandingIn(connection.entity.position.floored())) {
      await api.goto(goal, 'base placement', 8000).catch(() => {})
    }
    const face = click()
    if (!api.safe(connection) || !face || goal.isStandingIn(connection.entity.position.floored()) ||
        !AIR.test(connection.blockAt(position)?.name)) return false
    const material = items(connection).find(item => piece.names.includes(item.name))
    const reference = connection.blockAt(face.ref)
    if (!material || !reference) return false
    await connection.equip(material, 'hand')
    if (!api.safe(connection)) return false
    connection.setControlState('sneak', true)
    try {
      await connection.waitForTicks(1)
      if (!api.safe(connection) || !AIR.test(connection.blockAt(position)?.name)) return false
      await connection._placeBlockWithOptions(reference, face.face.scaled(-1), {
        delta: face.to.minus(face.ref), swingArm: 'right',
      })
    } finally {
      connection.setControlState('sneak', false)
    }
    const placed = matches(piece, connection.blockAt(position))
    api.log(placed ? 'base part placed' : 'base placement mismatch', { part: piece.id, position })
    return placed
  }

  async function useBarrel(connection, id, action) {
    const position = piecePos(BY_ID.get(id))
    if (!api.safe(connection) || blockFor(connection, id)?.name !== 'barrel' ||
        !await approach(connection, position) || !api.safe(connection)) return
    const block = connection.blockAt(position)
    if (block?.name !== 'barrel' || connection.currentWindow) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4500)
    let window
    try {
      const [[opened]] = await Promise.all([
        once(connection, 'windowOpen', { signal: controller.signal }),
        connection.activateBlock(block),
      ])
      window = opened
      if (api.safe(connection) && window === connection.currentWindow && window.inventoryStart === 27) await action(window)
    } finally {
      clearTimeout(timer)
      controller.abort()
      if (window && window === connection.currentWindow) connection.closeWindow(window)
    }
  }

  async function transfer(connection, window, item, quantity, deposit) {
    if (quantity <= 0 || !api.safe(connection) || window !== connection.currentWindow) return 0
    const { inventoryStart, inventoryEnd } = window
    const [sourceStart, sourceEnd, destStart, destEnd] = deposit
      ? [inventoryStart, inventoryEnd, 0, inventoryStart]
      : [0, inventoryStart, inventoryStart, inventoryEnd]
    const slot = window.slots.indexOf(item, sourceStart)
    if (slot < sourceStart || slot >= sourceEnd) return 0
    const destination = window.slots.slice(destStart, destEnd)
    // Use an empty slot when uncertain about component or enchantment compatibility.
    if (!destination.includes(null)) return 0
    const amount = Math.min(quantity, item.count)
    const playerCount = () => count(window.slots.slice(inventoryStart, inventoryEnd).filter(Boolean), [item.name])
    const before = playerCount()
    await connection.transfer({ window, itemType: item.type, metadata: item.metadata, nbt: item.nbt,
      count: amount, sourceStart: slot, sourceEnd: slot + 1, destStart, destEnd })
    return Math.max(0, Math.min(amount, (playerCount() - before) * (deposit ? -1 : 1)))
  }

  async function serviceStorage(connection, spares = false, emergency = false) {
    await useBarrel(connection, 'storage', async window => {
      const pack = () => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
      const stored = () => window.containerItems()
      for (const item of stored().filter(item => FOOD.test(item.name))) {
        await transfer(connection, window, item, FOOD_TARGET - food(pack()), false)
      }
      if (!emergency) {
        for (const item of stored().filter(item => item.name === 'torch')) {
          await transfer(connection, window, item, TORCH_TARGET - count(pack(), ['torch']), false)
        }
        for (const item of pack()) {
          if (['diamond', 'emerald', 'lapis_lazuli', 'gold_ingot'].includes(item.name)) {
            await transfer(connection, window, item, item.count, true)
          } else if (FOOD.test(item.name) && !item.name.includes('golden_')) {
            await transfer(connection, window, item, Math.min(food(pack()) - FOOD_TARGET, 16 - food(stored())), true)
          } else if (item.name === 'torch') {
            await transfer(connection, window, item,
              Math.min(count(pack(), ['torch']) - TORCH_TARGET, 32 - count(stored(), ['torch'])), true)
          }
        }
      }
      for (const spare of SPARES) {
        const offhand = connection.inventory.slots[connection.getEquipmentDestSlot('off-hand')]
        const worn = !healthy(pack(), spare.kind) && !(offhand && healthy([offhand], spare.kind))
        const backup = stored().find(item => item.name === spare.name && api.durability(item) > DURABILITY_TARGET)
        if (worn && backup) {
          const amount = await transfer(connection, window, backup, 1, false)
          if (amount) api.log('base spare withdrawn', { item: spare.name })
        } else if (spares && !backup) {
          const copy = pack().find(item => item.name === spare.name && api.durability(item) > DURABILITY_TARGET)
          const remaining = [...pack().filter(item => item !== copy), offhand].filter(Boolean)
          if (copy && healthy(remaining, spare.kind)) {
            const amount = await transfer(connection, window, copy, 1, true)
            if (amount) api.log('base spare stored', { item: spare.name })
          }
        }
      }
      status.storedFood = food(stored())
      status.missingSpare = SPARES.find(spare => !stored().some(item => item.name === spare.name &&
        api.durability(item) > DURABILITY_TARGET))?.name ?? null
    })
  }

  async function collect(connection, kind, names = [], target = 0) {
    setPhase('gathering', { resource: kind })
    if (kind === 'wood' || kind === 'food') {
      if (!api.openSurface(connection, connection.entity.position.floored())) return api.surface(connection)
      if (kind === 'wood') return api.wood()
      if (status.workshop === 'building' && items(connection).some(item => Object.hasOwn(COOKED, item.name)) &&
          count(items(connection), FUEL) > 0 && await api.cookFood()) return
      if (!await api.forage()) await api.explore()
      return
    }
    if (trip?.kind !== kind) trip = { kind, names, target, until: Date.now() + 120000 }
    await api.mine(trip)
  }

  async function make(connection, name, table) {
    if (!api.safe(connection) || (table && !await approach(connection, table.position))) return false
    return api.safe(connection) && await api.craft(name, table)
  }

  async function needIron(connection, amount) {
    const inventory = items(connection)
    if (count(inventory, IRON) < amount) return collect(connection, 'iron', IRON, amount)
    if (!count(inventory, FUEL)) return collect(connection, 'coal', FUEL, 3)
    setPhase('smelting')
    await api.smeltIron()
  }

  async function craftSpare(connection, spare, table) {
    const inventory = items(connection)
    const wood = (spare.planks ?? 0) + (count(inventory, ['stick']) < (spare.sticks ?? 2) ? 2 : 0)
    if (count(inventory, ['iron_ingot']) < spare.iron || api.woodSupply() < wood ||
        !await api.planks(wood)) return false
    if (count(items(connection), ['stick']) < (spare.sticks ?? 2) && !await make(connection, 'stick', null)) return false
    return make(connection, spare.name, table)
  }

  async function build(connection, piece, table) {
    const name = piece.names[0]
    const inventory = items(connection)
    if (piece.names.some(id => count(inventory, [id]))) return place(connection, piece)
    const cobble = count(inventory, STONE)
    const ingots = count(inventory, ['iron_ingot'])
    const wood = api.woodSupply()
    const planksNeeded = { barrel: 9, hopper: 8, crafting_table: 4, lever: 2, redstone_torch: 2 }[name] ?? 0
    if (planksNeeded && wood < planksNeeded) return collect(connection, 'wood')
    if (name === 'lever' && !count(inventory, ['cobblestone'])) {
      return collect(connection, 'stone', ['cobblestone'], 1)
    }
    if (name === 'furnace' && !STONE.some(material => count(inventory, [material]) >= 8)) {
      const preferred = count(inventory, ['cobbled_deepslate']) > count(inventory, ['cobblestone'])
        ? 'cobbled_deepslate' : 'cobblestone'
      return collect(connection, 'stone', [preferred], 8)
    }
    if (!cobble && STONE.includes(name)) {
      return collect(connection, 'stone', STONE, 12)
    }
    if (name === 'hopper' && ingots < 5) return needIron(connection, 15 - WORKSHOP
      .filter(part => part.names.includes('hopper') && matches(part, connection.blockAt(piecePos(part)))).length * 5)
    if (name === 'redstone_torch' && !count(inventory, ['redstone'])) {
      const pick = SPARES[0]
      if (!inventory.some(item => pick.kind.test(item.name) && api.durability(item) > 2)) {
        if (ingots < pick.iron) return needIron(connection, pick.iron)
        if (count(inventory, ['stick']) < 2 && wood < 2) return collect(connection, 'wood')
        return craftSpare(connection, pick, table)
      }
      return collect(connection, 'redstone', ['redstone'], 4)
    }
    if (planksNeeded && !await api.planks(planksNeeded)) return false
    if (name === 'barrel' && !items(connection).some(item => WOOD_SLAB.test(item.name) && item.count >= 2)) {
      const boards = items(connection).find(item => item.name.endsWith('_planks') && item.count >= 3)
      if (!boards) return collect(connection, 'wood')
      if (!await make(connection, boards.name.replace('_planks', '_slab'), table)) return false
    }
    if (name === 'hopper' && !count(inventory, ['chest']) && !await make(connection, 'chest', table)) return false
    if ((name === 'lever' || name === 'redstone_torch') && !count(inventory, ['stick']) &&
        !await make(connection, 'stick', null)) return false
    return await make(connection, name, name === 'crafting_table' || name === 'redstone_torch' || name === 'lever' ? null : table)
  }

  async function serviceFurnace(connection) {
    const outputNames = ['iron_ingot', ...Object.values(COOKED)]
    // Each hopper moves one item per transfer, independently of the Bot.
    await useBarrel(connection, 'output', async window => {
      for (const item of window.containerItems().filter(item => outputNames.includes(item.name))) {
        const amount = await transfer(connection, window, item, item.count, false)
        if (amount) api.log('base furnace output collected', { item: item.name, count: amount })
      }
    })
    const enabled = blockFor(connection, 'fuel-feed')?.getProperties().enabled === true
    const lit = blockFor(connection, 'indicator')?.getProperties().lit === true
    status.workshop = enabled && lit ? 'ready' : enabled ? 'signal-mismatch' : 'fuel-locked'
    if (!enabled) return { queued: false, burning: false }
    const playerItems = window => window.slots.slice(window.inventoryStart, window.inventoryEnd).filter(Boolean)
    if (count(items(connection), FUEL) > 0) {
      await useBarrel(connection, 'fuel', async window => {
        for (const item of playerItems(window).filter(item => FUEL.includes(item.name))) {
          await transfer(connection, window, item, 4 - count(window.containerItems(), FUEL), true)
        }
      })
    }
    let queued = false
    await useBarrel(connection, 'input', async window => {
      const staged = window.containerItems().reduce((sum, item) => sum + item.count, 0)
      queued = staged > 0
      if (staged >= 16) return
      const inventory = playerItems(window)
      const raw = inventory.find(item => Object.hasOwn(COOKED, item.name)) ||
        inventory.find(item => item.name === 'raw_iron')
      if (!raw) return
      const amount = await transfer(connection, window, raw, 16 - staged, true)
      if (amount) {
        queued = true
        api.log('base furnace intake queued', { item: raw.name, count: amount })
      }
    })
    return { queued, burning: blockFor(connection, 'furnace')?.getProperties().lit === true }
  }

  async function run(connection) {
    if (trip) {
      const { kind, names, target, until } = trip
      if (Date.now() < until && count(items(connection), names) < target &&
          api.foodReserve() >= 3 && items(connection).some(item => /_pickaxe$/.test(item.name))) {
        return collect(connection, kind, names, target)
      }
      trip = null
    }
    if (!anchor) {
      setPhase('selecting-site')
      if (!unlocked) saveProgress(null)
      if (!api.openSurface(connection, connection.entity.position.floored())) return api.surface(connection)
      const site = findSite(connection)
      if (!site) return api.explore()
      saveProgress(site)
      api.log('supply base site selected', { position: site })
    }

    if (Date.now() < visitAfter && connection.entity.position.distanceTo(anchor) < 40) {
      setPhase('expedition')
      if (api.foodReserve() < FOOD_TARGET) return collect(connection, 'food')
      return api.explore()
    }
    if (!await returnToBase(connection)) {
      if (api.safe(connection) && !api.openSurface(connection, connection.entity.position.floored())) {
        await api.surface(connection)
      }
      return
    }

    const missing = parts => parts.find(piece => !matches(piece, connection.blockAt(piecePos(piece))))
    const depotPart = missing(DEPOT)
    const workshopPart = missing(WORKSHOP)
    status.workshop = workshopPart ? 'building' : status.workshop
    const table = blockFor(connection, 'table')
    const pending = depotPart || workshopPart
    if (pending && !AIR.test(connection.blockAt(piecePos(pending))?.name)) {
      setPhase('obstructed', { part: pending.id, resource: null })
      visitAfter = Date.now() + 15000
      return
    }
    if (depotPart) {
      setPhase('building-base', { part: depotPart.id, resource: null })
      return build(connection, depotPart, table)
    }
    setPhase('restocking', { part: null, resource: null })
    await serviceStorage(connection, true)
    if (!api.safe(connection)) return
    if (connection.food < 18) await api.eat()
    if (!api.safe(connection)) return
    if (!items(connection).some(item => /_pickaxe$/.test(item.name))) {
      if (api.woodSupply() < 8) return collect(connection, 'wood')
      return api.starterGear()
    }

    const inventory = items(connection)
    const fuel = count(inventory, FUEL)
    if (count(inventory, ['torch']) < TORCH_TARGET && fuel) {
      if (!count(inventory, ['stick']) && await api.planks(2)) await make(connection, 'stick', null)
      if (count(items(connection), ['stick']) && await make(connection, 'torch', null)) return
    }

    if (workshopPart) {
      setPhase('building-redstone', { part: workshopPart.id, resource: null })
      if (api.foodReserve() < 3 && !inventory.some(item => Object.hasOwn(COOKED, item.name))) return collect(connection, 'food')
      return build(connection, workshopPart, table)
    }

    const furnace = await serviceFurnace(connection)
    if (!api.safe(connection)) return
    const ingots = count(items(connection), ['iron_ingot'])
    if (count(items(connection), ['torch']) < TORCH_TARGET && !fuel) return collect(connection, 'coal', FUEL, 5)
    const missingSpare = SPARES.find(spare => spare.name === status.missingSpare)
    if (missingSpare && await craftSpare(connection, missingSpare, table)) return
    if (missingSpare && !healthy(items(connection), missingSpare.kind) && !fuel && !ingots) {
      return collect(connection, 'coal', FUEL, 5)
    }
    if (missingSpare && ingots >= missingSpare.iron) return collect(connection, 'wood')
    if (furnace.queued && !furnace.burning && !fuel) return collect(connection, 'coal', FUEL, 5)
    if (api.foodReserve() < FOOD_TARGET ||
        (status.storedFood < FOOD_TARGET && food(items(connection)) >= FOOD_TARGET)) {
      visitAfter = Date.now() + 25000
      if (api.foodReserve() < FOOD_TARGET) return collect(connection, 'food')
      return api.forage()
    }
    visitAfter = Date.now() + 60000
    setPhase('departing', { resource: null })
    api.log('base resupply complete', { position: anchor, food: api.foodReserve(), torches: count(items(connection), ['torch']),
      workshop: status.workshop, missingSpare: status.missingSpare })
    if (missingSpare && ingots < missingSpare.iron && !count(items(connection), ['raw_iron']) &&
        !furnace.queued && !furnace.burning && status.workshop === 'ready') {
      visitAfter = 0
      return collect(connection, 'iron', IRON, 8)
    }
    await api.explore()
  }

  async function recoverFood(connection) {
    if (!anchor || !inOverworld(connection) || status.storedFood === 0 || Date.now() < emergencyAfter ||
        connection.entity.position.distanceTo(anchor) > 30) return false
    emergencyAfter = Date.now() + 20000
    if (!await returnToBase(connection)) return false
    await serviceStorage(connection, false, true)
    if (!api.safe(connection) || !api.foodReserve()) return false
    await api.eat()
    return true
  }

  return {
    active: connection => inOverworld(connection) && (unlocked || api.hasArmor(connection)),
    run,
    recoverFood,
    owns: (connection, position) => Boolean(anchor && inOverworld(connection) && position &&
      PARTS.some(piece => position.equals(piecePos(piece)))),
    keeps: item => SPARES.some(spare => spare.name === item.name) && api.durability(item) > DURABILITY_TARGET,
    status: () => ({ ...status, position: anchor }),
  }
}

module.exports = { createSupplyBase }
