const { Vec3 } = require('vec3')
const { setTimeout: wait } = require('node:timers/promises')
const { WATER_BLOCK_NAMES } = require('./config')

const NEIGHBOURS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
const HAZARD = /^(lava|flowing_lava|fire|soul_fire|cactus|magma_block|campfire|soul_campfire|powder_snow)$/
const feetOf = point => new Vec3(Math.floor(point.x), Math.floor(point.y + 0.01), Math.floor(point.z))
const correctedEdges = new WeakMap()
const guardedMovements = new WeakSet()

function isFluid(block) {
  return Boolean(block && (WATER_BLOCK_NAMES.has(block.name) ||
    /^(flowing_water|lava|flowing_lava)$/.test(block.name) || block.getProperties?.()?.waterlogged === true))
}

function fluidBeside(connection, point) {
  return isFluid(connection.blockAt(point)) || NEIGHBOURS.some(([x, y, z]) =>
    isFluid(connection.blockAt(point.offset(x, y, z))))
}

function dryFooting(connection, point) {
  return [-1, 0, 1].every(dy => {
    const block = connection.blockAt(point.offset(0, dy, 0))
    return block && !isFluid(block) && !HAZARD.test(block.name)
  })
}

function avoidWetSteps(movements, connection, active = () => true) {
  movements.exclusionAreasStep.push(block => active() && block?.position && (isFluid(block) ||
    isFluid(connection.blockAt(block.position.offset(0, -1, 0)))) ? 100 : 0)
}

function avoidWetCorners(movements, connection) {
  const diagonal = movements.getMoveDiagonal
  movements.getMoveDiagonal = function (node, direction, neighbors) {
    const start = feetOf(node)
    if (!dryFooting(connection, start.offset(direction.x, 0, 0)) ||
        !dryFooting(connection, start.offset(0, 0, direction.z))) return
    return diagonal.call(this, node, direction, neighbors)
  }
}

function nearbyHostiles(connection, isHostile) {
  return Object.values(connection.entities ?? {}).filter(entity => entity.position && entity.isValid !== false && isHostile(entity))
}

function threatNear(point, threats, radius) {
  return threats.some(entity => entity.position.distanceTo(point) <= radius)
}

function pathHazard(connection, path, { start = connection.entity.position, threats = [] } = {}) {
  let last = feetOf(start)
  for (const node of path) {
    const next = feetOf(node)
    if (last.y - next.y > 3) return '落差超过三格'
    const dx = next.x - last.x
    const dz = next.z - last.z
    const samples = Math.max(1, Math.abs(dx), Math.abs(dz))
    for (let i = 1; i <= samples; i++) {
      const cell = feetOf(last.offset(dx * i / samples, (next.y - last.y) * i / samples, dz * i / samples))
      if (!dryFooting(connection, cell)) return '流体、危险方块或未加载地形'
      if (threatNear(cell, threats, 6)) return '路线太靠近怪物'
    }
    if (dx && dz && Math.abs(dx) === 1 && Math.abs(dz) === 1 &&
        (!dryFooting(connection, last.offset(dx, 0, 0)) || !dryFooting(connection, last.offset(0, 0, dz)))) {
      return '斜向移动贴近危险方块'
    }
    if (node.toBreak?.some(block => fluidBeside(connection, feetOf(block)))) return '破坏方块会接触流体'
    if (node.toPlace?.some(block => fluidBeside(connection, feetOf(block)))) return '需要在流体旁垫方块'
    last = next
  }
  return null
}

function safeStepUp(connection, destination) {
  const current = feetOf(connection.entity.position)
  const target = feetOf(destination)
  if (target.y - current.y !== 1 || Math.abs(target.x - current.x) + Math.abs(target.z - current.z) !== 1) return false
  const clear = point => {
    const block = connection.blockAt(point)
    return block?.boundingBox === 'empty' && !isFluid(block) && !HAZARD.test(block.name)
  }
  return dryFooting(connection, target) &&
    connection.blockAt(target.offset(0, -1, 0))?.boundingBox === 'block' &&
    clear(current.offset(0, 2, 0)) && clear(target) && clear(target.offset(0, 1, 0))
}

function blockedDryRise(connection, from, to) {
  if (to.y - from.y !== 1 || !dryFooting(connection, from) || !dryFooting(connection, to)) return false
  const blocked = point => connection.blockAt(point)?.boundingBox !== 'empty'
  if (blocked(from.offset(0, 2, 0))) return true
  const dx = to.x - from.x
  const dz = to.z - from.z
  return Boolean(dx && dz && (blocked(from.offset(dx, 2, 0)) || blocked(from.offset(0, 2, dz))))
}

const edgeKey = (from, to) => `${from}>${to}`
const passiveStep = step => !step.toBreak?.length && !step.toPlace?.length

function guardDrySteps(connection, movements) {
  if (!movements?.getNeighbors || guardedMovements.has(movements)) return
  guardedMovements.add(movements)
  const nextSteps = movements.getNeighbors
  movements.getNeighbors = function (node) {
    const from = feetOf(node)
    const recent = correctedEdges.get(connection)
    return nextSteps.call(this, node).filter(step => {
      if (!passiveStep(step)) return true
      const to = feetOf(step)
      return !(recent?.get(edgeKey(from, to)) > Date.now()) && !blockedDryRise(connection, from, to)
    })
  }
}

class CorrectedWalkError extends Error {
  constructor(from, to) {
    super('同一路步反复被服务器纠正')
    this.from = from
    this.to = to
  }
}

async function centerOnDryFooting(connection, canMove) {
  const origin = feetOf(connection.entity.position)
  const center = origin.offset(0.5, 0, 0.5)
  const linedUp = () => Math.hypot(connection.entity.position.x - center.x,
    connection.entity.position.z - center.z) <= 0.1
  const canCenter = () => canMove() && connection.entity.onGround && !connection.entity.isInWater &&
    feetOf(connection.entity.position).equals(origin) && dryFooting(connection, origin)
  if (!canCenter() || linedUp()) return false
  const airborne = connection.entity.position.offset(0, connection.entity.eyeHeight ?? 1.62, 0)
  await connection.lookAt(new Vec3(center.x, airborne.y, center.z), true)
  if (!canCenter()) return false
  const deadline = Date.now() + 650
  const wasSneaking = connection.getControlState('sneak')
  connection.setControlState('sneak', true)
  connection.setControlState('forward', true)
  try {
    while (Date.now() < deadline && canCenter() && !linedUp()) await wait(35)
    return canCenter() && linedUp()
  } finally {
    connection.setControlState('forward', false)
    connection.setControlState('sneak', wasSneaking)
  }
}

async function retryCenteredRise(connection, { from, to }, canMove) {
  if (!safeStepUp(connection, to) || !await centerOnDryFooting(connection, canMove)) return false
  correctedEdges.get(connection)?.delete(edgeKey(from, to))
  return true
}

async function watchPath(connection, goal, execute, { validate, canJump = () => true, log = () => {} } = {}) {
  let path = []
  let problem = null
  let correction = null
  let lastEdge = ''
  let lastCorrection = 0
  let correctionCount = 0
  let lastPosition = connection.entity.position.clone()
  let lastProgress = Date.now()
  const attemptedJumps = new Set()
  const ownsGoal = () => connection.pathfinder.goal === goal && connection.entity
  const checkPath = (points, options) => {
    if (!validate || problem) return
    problem = validate(points, options)
    if (problem) setImmediate(() => {
      if (ownsGoal()) connection.pathfinder.setGoal(null)
    })
  }
  const onPath = result => {
    if (!ownsGoal()) return
    path = result.path ?? []
    checkPath(path)
  }
  const reset = () => { path = [] }
  const onCorrection = () => {
    if (!ownsGoal() || !canJump() || problem || correction || !path.length) return
    const from = feetOf(connection.entity.position)
    const step = path.find(node => !feetOf(node).equals(from))
    if (!step || !passiveStep(step)) return
    const to = feetOf(step)
    if (Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), Math.abs(to.z - from.z)) > 1 ||
        !dryFooting(connection, from) || !dryFooting(connection, to)) return
    const key = edgeKey(from, to)
    const now = Date.now()
    correctionCount = lastEdge === key && now - lastCorrection < 1500 ? correctionCount + 1 : 1
    lastEdge = key
    lastCorrection = now
    if (correctionCount < 3) return
    const recent = correctedEdges.get(connection) ?? new Map()
    for (const [edge, expires] of recent) if (expires <= now) recent.delete(edge)
    recent.set(key, now + 15000)
    correctedEdges.set(connection, recent)
    correction = new CorrectedWalkError(from, to)
    log('navigation corrected edge; replanning', { from, to, corrections: correctionCount })
    connection.pathfinder.setGoal(null)
  }
  const tick = () => {
    if (!ownsGoal() || !path.length || problem) return
    const { position, onGround, isInWater } = connection.entity
    const first = path.findIndex(node => feetOf(node).equals(feetOf(position)))
    const pending = first < 0 ? path : path.slice(first + 1)
    if (position.distanceTo(lastPosition) > 0.18) {
      lastPosition = position.clone()
      lastProgress = Date.now()
    }
    const next = pending[0]
    if (!next || !onGround || isInWater || !canJump() || Date.now() - lastProgress < 400 ||
        next.toBreak?.length || next.toPlace?.length || connection.targetDigBlock ||
        connection.getControlState('jump') || !safeStepUp(connection, next)) return
    const key = feetOf(next).toString()
    if (attemptedJumps.has(key)) return
    attemptedJumps.add(key)
    const dx = Math.floor(next.x) + 0.5 - position.x
    const dz = Math.floor(next.z) + 0.5 - position.z
    void connection.look(Math.atan2(-dx, -dz), 0, true).catch(() => {})
    connection.setControlState('sprint', false)
    connection.setControlState('forward', true)
    connection.setControlState('jump', true)
    log('navigation step-up recovery jump', { from: feetOf(position), step: feetOf(next) })
  }
  // Map a position back to the local route before periodically validating it.
  // Pathfinder emits the original node list and consumes prefixes internally.
  const recheck = validate && setInterval(() => {
    if (!ownsGoal() || !path.length || problem) return
    const position = connection.entity.position
    let index = -1
    let distance = Infinity
    for (let i = 0; i < path.length; i++) {
      const candidate = feetOf(path[i]).offset(0.5, 0, 0.5).distanceTo(position)
      if (candidate < distance) { index = i; distance = candidate }
    }
    const from = index >= 0 && distance < 1 && feetOf(path[index]).equals(feetOf(position)) ? index + 1 :
      index >= 0 && distance < 1.6 ? index : 0
    checkPath(path.slice(from, from + 3), { start: position })
  }, 180)
  connection.on('path_update', onPath)
  connection.on('path_reset', reset)
  connection.on('forcedMove', onCorrection)
  connection.on('physicsTick', tick)
  try {
    const result = await execute()
    if (correction) throw correction
    return result
  } catch (error) {
    if (problem) throw new Error(problem, { cause: error })
    if (correction) throw correction
    throw error
  } finally {
    if (recheck) clearInterval(recheck)
    connection.off('path_update', onPath)
    connection.off('path_reset', reset)
    connection.off('forcedMove', onCorrection)
    connection.off('physicsTick', tick)
  }
}

module.exports = { avoidWetCorners, avoidWetSteps, blockedDryRise, centerOnDryFooting, CorrectedWalkError,
  dryFooting, fluidBeside, guardDrySteps, isFluid, nearbyHostiles, pathHazard, retryCenteredRise,
  safeStepUp, threatNear, watchPath }
