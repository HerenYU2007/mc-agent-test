const { Vec3 } = require('vec3')

const MIN_BOW_RANGE = 7
const MAX_BOW_RANGE = 23
const FULL_DRAW_TICKS = 22
const BOW_SPEED = 3
const ARROW_DRAG = 0.99
const ARROW_GRAVITY = 0.05
const ARROW_NAMES = new Set(['arrow', 'spectral_arrow', 'tipped_arrow'])
const STILL = new Vec3(0, 0, 0)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function bowAim(origin, target, motion = STILL) {
  const displacement = target.minus(origin)
  function requiredVelocity(ticks) {
    const travel = (1 - ARROW_DRAG ** ticks) / (1 - ARROW_DRAG)
    const lift = ARROW_GRAVITY * (ticks - travel) / (1 - ARROW_DRAG)
    return displacement.plus(motion.scaled(ticks)).offset(0, lift, 0).scaled(1 / travel)
  }
  let high = 1
  while (high < 14 && requiredVelocity(high).norm() > BOW_SPEED) high++
  if (requiredVelocity(high).norm() > BOW_SPEED) return null
  let low = Math.max(0.25, high - 1)
  for (let iteration = 0; iteration < 12; iteration++) {
    const mid = (low + high) / 2
    if (requiredVelocity(mid).norm() > BOW_SPEED) low = mid
    else high = mid
  }
  return { ticks: high, velocity: requiredVelocity(high).unit().scaled(BOW_SPEED) }
}

function clearArrowPath(world, origin, shot) {
  let start = origin
  let velocity = shot.velocity
  for (let tick = 0; tick < shot.ticks; tick++) {
    const length = velocity.norm() * Math.min(1, shot.ticks - tick)
    if (world.raycast(start, velocity.unit(), length)) return false
    start = start.plus(velocity)
    velocity = velocity.scaled(ARROW_DRAG).offset(0, -ARROW_GRAVITY, 0)
  }
  return true
}

function createCombatBow(state, features) {
  const draws = new WeakMap()
  const heldBow = connection => connection.heldItem?.name === 'bow'
  const bow = connection => connection.inventory.items()
    .filter(item => item.name === 'bow' && features.toolDurability(item) > 0)
    .sort((a, b) => features.toolDurability(b) - features.toolDurability(a))[0]
  const hasAmmo = connection => connection.inventory.items().some(item => ARROW_NAMES.has(item.name)) ||
    ARROW_NAMES.has(connection.inventory.slots[connection.getEquipmentDestSlot('off-hand')]?.name)

  function canUseCombatBow(connection, target) {
    if (!connection?.entity || !target?.position || target.isValid === false || connection !== state.bot || !state.botEnabled ||
        connection.health < 8 || connection.food < 6 || state.isEating || state.emergencyRetreating || state.fleeingActive ||
        state.impactGuards.has(connection) || !connection.entity.onGround || connection.entity.isInWater ||
        connection.entity.isInLava || !hasAmmo(connection) || !bow(connection)) return false
    const distance = connection.entity.position.distanceTo(target.position)
    return distance >= MIN_BOW_RANGE && distance <= MAX_BOW_RANGE && features.hostileSight(target).visible &&
      !features.findNearestHostile(MIN_BOW_RANGE - 0.5)
  }

  function cancelCombatBow(connection, reason) {
    if (!draws.has(connection)) return false
    draws.delete(connection)
    if (connection === state.bot && connection.entity && heldBow(connection)) {
      const selected = connection.quickBarSlot
      const start = connection.QUICK_BAR_START
      const slots = Array.from({ length: 9 }, (_, index) => index).filter(index => index !== selected)
      const safeSlot = slots.find(index => /_(axe|sword)$/.test(connection.inventory.slots[start + index]?.name)) ??
        slots.find(index => connection.inventory.slots[start + index]?.name !== 'bow') ?? slots[0]
      // Selecting a different slot stops use on the server. Releasing use would fire the arrow.
      connection.setQuickBarSlot(safeSlot)
      connection.usingHeldItem = false
    }
    features.log('bow draw cancelled', { reason })
    return true
  }

  async function shootCombatBow(connection, target) {
    if (draws.has(connection) || !canUseCombatBow(connection, target)) return false
    const arrowOrigin = () => connection.entity.position.offset(0, connection.entity.eyeHeight - 0.1, 0)
    const targetCenter = () => target.position.offset(0, (target.height || 1.8) * 0.65, 0)
    const getShot = (origin, movement) => bowAim(origin, targetCenter(), movement)
    const firstOrigin = arrowOrigin()
    const firstShot = getShot(firstOrigin, STILL)
    if (!firstShot || !clearArrowPath(connection.world, firstOrigin, firstShot)) return false
    const health = connection.health
    const safe = () => connection.health >= health && canUseCombatBow(connection, target)
    try {
      features.lowerCombatShield(connection)
      features.stopPathfinder()
      connection.clearControlStates()
      await features.equipCombatShield(connection)
      if (!safe()) return false
      await connection.equip(bow(connection), 'hand')
      if (!heldBow(connection) || !safe()) return false

      draws.set(connection, target.id)
      await connection.lookAt(firstOrigin.plus(firstShot.velocity), true)
      if (!safe() || !draws.has(connection)) return false
      connection.activateItem()
      state.lastDecision = 'draw-bow'
      state.lastCombatDecision = { action: 'draw-bow', target: features.hostileName(target), reason: '拉弓并预判远处目标走位' }
      features.log('bow draw started', { target: features.hostileName(target), id: target.id })
      let sample = target.position.clone()
      let movement = STILL
      for (let tick = 1; tick <= FULL_DRAW_TICKS; tick++) {
        await wait(50)
        if (!draws.has(connection) || !heldBow(connection) || !safe()) return false
        if (tick % 4 !== 0) continue
        const change = target.position.minus(sample).scaled(0.25)
        const speed = Math.hypot(change.x, change.z)
        movement = speed <= 0.35 ? new Vec3(change.x, Math.max(-0.12, Math.min(0.12, change.y)), change.z) : STILL
        sample = target.position.clone()
        const origin = arrowOrigin()
        const shot = getShot(origin, movement)
        if (shot) await connection.lookAt(origin.plus(shot.velocity), true)
      }
      const origin = arrowOrigin()
      const shot = getShot(origin, movement)
      if (!shot || !clearArrowPath(connection.world, origin, shot)) return false
      await connection.lookAt(origin.plus(shot.velocity), true)
      if (!safe() || !draws.has(connection) || !heldBow(connection)) return false
      draws.delete(connection)
      connection.deactivateItem()
      state.lastDecision = 'shoot-bow'
      state.lastCombatDecision = { action: 'shoot-bow', target: features.hostileName(target), reason: '弓已拉满，沿已检查的弹道放箭' }
      features.log('bow shot released', { target: features.hostileName(target), id: target.id,
        flightTicks: Number(shot.ticks.toFixed(1)), distance: Number(origin.distanceTo(target.position).toFixed(1)),
        horizontalLead: Number((Math.hypot(movement.x, movement.z) * shot.ticks).toFixed(2)) })
      return true
    } finally {
      cancelCombatBow(connection, '目标、走位或危险状态变化')
    }
  }

  return { canUseCombatBow, shootCombatBow, cancelCombatBow }
}

module.exports = createCombatBow
module.exports.bowAim = bowAim
module.exports.clearArrowPath = clearArrowPath
