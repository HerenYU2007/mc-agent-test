const { Vec3 } = require('vec3')

const MIN_BOW_RANGE = 7
const MAX_BOW_RANGE = 23
const RETREAT_OPEN_RANGE = 13
const RETREAT_CLOSE_RANGE = 10
const RETREAT_MAX_RANGE = 19
const FULL_DRAW_TICKS = 22
const SETTLE_TICKS = 4
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

function retreatMotion(origin, samples) {
  const latest = samples.at(-1)
  const recent = samples.findLast(sample => latest.at - sample.at >= 90)
  const previous = recent && samples.findLast(sample => recent.at - sample.at >= 90)
  if (!previous) return { velocity: STILL, reversing: false }
  const toward = latest.position.minus(origin)
  const distance = Math.hypot(toward.x, toward.z)
  if (distance === 0) return { velocity: STILL, reversing: false }
  const radial = new Vec3(toward.x / distance, 0, toward.z / distance)
  const side = new Vec3(-radial.z, 0, radial.x)
  const current = latest.position.minus(recent.position).scaled(50 / (latest.at - recent.at))
  const prior = recent.position.minus(previous.position).scaled(50 / (recent.at - previous.at))
  const limit = (value, maximum) => Math.max(-maximum, Math.min(maximum, value))
  const across = current.dot(side)
  const previouslyAcross = prior.dot(side)
  const reversing = Math.abs(across) >= 0.05 && Math.abs(previouslyAcross) >= 0.05 && across * previouslyAcross < 0
  const sideways = reversing ? across : across * 0.8 + previouslyAcross * 0.2
  const along = 0.65 * current.dot(radial) + 0.35 * prior.dot(radial)
  const velocity = radial.scaled(limit(along, 0.36)).plus(side.scaled(limit(sideways, 0.34)))
    .offset(0, limit(current.y, 0.12), 0)
  return { velocity, reversing, lateralSpeed: sideways }
}

function createCombatBow(state, features) {
  const draws = new WeakMap()
  const heldBow = connection => connection.heldItem?.name === 'bow'
  const bow = connection => connection.inventory.items()
    .filter(item => item.name === 'bow' && features.toolDurability(item) > 0)
    .sort((a, b) => features.toolDurability(b) - features.toolDurability(a))[0]
  const hasAmmo = connection => connection.inventory.items().some(item => ARROW_NAMES.has(item.name)) ||
    ARROW_NAMES.has(connection.inventory.slots[connection.getEquipmentDestSlot('off-hand')]?.name)

  function canUseCombatBow(connection, target, retreat = false, drawing = false) {
    if (!connection?.entity || !target?.position || target.isValid === false || connection !== state.bot || !state.botEnabled ||
        connection.health < (retreat ? 7 : 8) || connection.food < (retreat ? 17 : 6) ||
        state.isEating || state.emergencyRetreating || state.fleeingActive !== retreat ||
        state.impactGuards.has(connection) || !connection.entity.onGround || connection.entity.isInWater ||
        connection.entity.isInLava || !hasAmmo(connection) || !bow(connection)) return false
    const distance = connection.entity.position.distanceTo(target.position)
    const minimum = retreat ? (drawing ? RETREAT_CLOSE_RANGE : RETREAT_OPEN_RANGE) : MIN_BOW_RANGE
    return distance >= minimum && distance <= (retreat ? RETREAT_MAX_RANGE : MAX_BOW_RANGE) &&
      features.hostileSight(target).visible && !features.findNearestHostile(retreat ? RETREAT_CLOSE_RANGE - 0.5 : MIN_BOW_RANGE - 0.5)
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

  async function shootCombatBow(connection, target, retreat = false) {
    if (draws.has(connection) || !canUseCombatBow(connection, target, retreat)) return false
    const arrowOrigin = () => connection.entity.position.offset(0, connection.entity.eyeHeight - 0.1, 0)
    const targetCenter = () => target.position.offset(0, (target.height || 1.8) * 0.65, 0)
    const getShot = (origin, movement, nextTick = 0) => bowAim(origin, targetCenter().plus(movement.scaled(nextTick)), movement)
    // lookAt measures from the eye, while the arrow spawns below it.
    const aim = (origin, shot) => connection.lookAt(origin.offset(0, 0.1, 0).plus(shot.velocity), true)
    const firstOrigin = arrowOrigin()
    const firstShot = getShot(firstOrigin, STILL)
    if (!firstShot || !clearArrowPath(connection.world, firstOrigin, firstShot)) return false
    const health = connection.health
    const safe = () => connection.health >= health && canUseCombatBow(connection, target, retreat, true)
    let cancelReason = '目标、走位或危险状态变化'
    try {
      features.lowerCombatShield(connection)
      features.stopPathfinder()
      connection.clearControlStates()
      await features.equipCombatShield(connection)
      if (!safe()) return false
      await connection.equip(bow(connection), 'hand')
      if (!heldBow(connection) || !safe()) return false

      draws.set(connection, target.id)
      await aim(firstOrigin, firstShot)
      if (!safe() || !draws.has(connection)) return false
      connection.activateItem()
      state.lastDecision = 'draw-bow'
      state.lastCombatDecision = { action: 'draw-bow', target: features.hostileName(target),
        reason: retreat ? '已与追兵拉开距离，站稳预判侧移' : '拉弓并预判远处目标走位' }
      features.log('bow draw started', { target: features.hostileName(target), id: target.id, retreat })
      let sample = target.position.clone()
      let movement = STILL
      let motion
      const trail = [{ at: Date.now(), position: sample }]
      for (let tick = 1; tick <= FULL_DRAW_TICKS + (retreat ? SETTLE_TICKS : 0); tick++) {
        await wait(50)
        if (!draws.has(connection) || !heldBow(connection) || !safe()) return false
        if (retreat) {
          const origin = arrowOrigin()
          trail.push({ at: Date.now(), position: target.position.clone() })
          if (trail.length > 12) trail.shift()
          if (tick < FULL_DRAW_TICKS) continue
          const estimate = retreatMotion(origin, trail)
          if (estimate.reversing) {
            cancelReason = '追兵正在反向侧移，继续撤离'
            continue
          }
          if (Math.hypot(connection.entity.velocity.x, connection.entity.velocity.z) > 0.06) {
            cancelReason = '射击位置不稳，继续撤离'
            continue
          }
          motion = estimate
          movement = estimate.velocity
          break
        }
        if (tick % 4 !== 0) continue
        const change = target.position.minus(sample).scaled(0.25)
        const speed = Math.hypot(change.x, change.z)
        movement = speed <= 0.35 ? new Vec3(change.x, Math.max(-0.12, Math.min(0.12, change.y)), change.z) : STILL
        sample = target.position.clone()
        const origin = arrowOrigin()
        const shot = getShot(origin, movement)
        if (shot) await aim(origin, shot)
      }
      if (retreat && !motion) return false
      const origin = arrowOrigin()
      const shot = getShot(origin, movement, 1)
      if (!shot || !clearArrowPath(connection.world, origin, shot)) return false
      await aim(origin, shot)
      // Mineflayer sends the new look before processing the release only on its next movement tick.
      const rotated = await Promise.race([
        connection.waitForTicks(1).then(() => true, () => false),
        wait(120).then(() => false),
      ])
      if (!rotated || !safe() || !draws.has(connection) || !heldBow(connection)) return false
      draws.delete(connection)
      connection.deactivateItem()
      state.lastDecision = 'shoot-bow'
      state.lastCombatDecision = { action: 'shoot-bow', target: features.hostileName(target),
        reason: retreat ? '回射后继续撤离' : '弓已拉满，沿已检查的弹道放箭' }
      features.log('bow shot released', { target: features.hostileName(target), id: target.id, retreat,
        flightTicks: Number(shot.ticks.toFixed(1)), distance: Number(origin.distanceTo(target.position).toFixed(1)),
        horizontalLead: Number((Math.hypot(movement.x, movement.z) * shot.ticks).toFixed(2)),
        aimVelocity: shot.velocity.toArray(),
        ...(retreat ? { lateralLead: Number(((motion.lateralSpeed ?? 0) * shot.ticks).toFixed(2)) } : {}) })
      return true
    } finally {
      cancelCombatBow(connection, cancelReason)
    }
  }

  return { canUseCombatBow, shootCombatBow, cancelCombatBow }
}

module.exports = createCombatBow
module.exports.bowAim = bowAim
module.exports.clearArrowPath = clearArrowPath
module.exports.retreatMotion = retreatMotion
