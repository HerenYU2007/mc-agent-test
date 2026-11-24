const { Vec3 } = require('vec3')
const { EMPTY_BLOCK } = require('./config')

function createCombatDefence(runtimeState, features) {
  const shieldSteps = new WeakSet()
  const shieldBlocks = new WeakMap()
  const hostileSwings = new WeakMap()
  const swimArrowGuards = new WeakSet()
  const enoughAir = connection => Number(connection.oxygenLevel ?? 20) > 6

  function damageInterruptActive(connection) {
    return runtimeState.impactGuards.has(connection) || runtimeState.meleeConnection === connection
  }

  async function equipCombatShield(connection) {
    const slot = connection.getEquipmentDestSlot('off-hand')
    if (connection.inventory.slots[slot]?.name === 'shield') return true
    const shield = connection.inventory.items().find(item => item.name === 'shield')
    if (!shield) return false
    await connection.equip(shield, 'off-hand')
    return connection.inventory.slots[slot]?.name === 'shield'
  }

  function raiseCombatShield(connection, target) {
    const slot = connection.getEquipmentDestSlot('off-hand')
    if (runtimeState.isEating || connection.inventory.slots[slot]?.name !== 'shield') return false
    if (runtimeState.raisedShields.has(connection) && connection.usingHeldItem) return true
    if (connection.usingHeldItem) return false
    connection.activateItem(true)
    runtimeState.raisedShields.set(connection, Date.now())
    features.log('shield raised', { target: features.entityNameOf(target) })
    return true
  }

  function lowerCombatShield(connection) {
    stopShieldSteps(connection)
    if (!runtimeState.raisedShields.delete(connection)) return
    if (connection.usingHeldItem) connection.deactivateItem()
  }

  function stopShieldSteps(connection) {
    if (!shieldSteps.delete(connection)) return
    for (const key of ['forward', 'back', 'left', 'right']) connection.setControlState(key, false)
  }

  function stepWhileShielding(connection, facing, destination) {
    const position = connection.entity.position
    const dx = destination.x - position.x
    const dz = destination.z - position.z
    const travel = Math.hypot(dx, dz)
    const look = facing.minus(position)
    const facingLength = Math.hypot(look.x, look.z)
    if (travel < 0.55 || facingLength < 0.1) {
      stopShieldSteps(connection)
      return
    }
    const forward = (dx * look.x + dz * look.z) / (travel * facingLength)
    const right = (-dx * look.z + dz * look.x) / (travel * facingLength)
    const next = position.offset(0.75 * dx / travel, 0, 0.75 * dz / travel).floored()
    const floor = connection.blockAt(next.offset(0, -1, 0), false)
    if (floor?.boundingBox !== 'block' || /cactus|magma|campfire/.test(floor.name) ||
        !EMPTY_BLOCK.test(connection.blockAt(next, false)?.name) ||
        !EMPTY_BLOCK.test(connection.blockAt(next.offset(0, 1, 0), false)?.name)) {
      stopShieldSteps(connection)
      return
    }
    shieldSteps.add(connection)
    connection.setControlState('sprint', false)
    connection.setControlState('forward', forward > 0.38)
    connection.setControlState('back', forward < -0.38)
    connection.setControlState('left', right < -0.38)
    connection.setControlState('right', right > 0.38)
  }

  function trackCombatImpacts(connection) {
    const arrows = new Map()
    const considered = new WeakSet()
    const litCreepers = new Set()
    const creeperKeys = connection.registry.entitiesByName.creeper?.metadataKeys || []
    const swell = creeperKeys.indexOf('swell_dir')
    const ignited = creeperKeys.indexOf('is_ignited')
    const confirmShieldBlock = signal => {
      if (connection !== runtimeState.bot || !runtimeState.raisedShields.has(connection)) return
      const at = Date.now()
      if (at - (shieldBlocks.get(connection) ?? 0) < 100) return
      shieldBlocks.set(connection, at)
      features.log('shield impact confirmed', { at, signal, swimming: swimArrowGuards.has(connection) })
    }
    connection._client.on('entity_status', packet => {
      if (packet.entityId === connection.entity?.id && packet.entityStatus === 29) confirmShieldBlock('entity-status')
    })
    connection.inventory.on(`updateSlot:${connection.getEquipmentDestSlot('off-hand')}`, (oldItem, item) => {
      if (oldItem?.name === 'shield' && item?.name === 'shield' && item.durabilityUsed > oldItem.durabilityUsed) {
        confirmShieldBlock('shield-durability')
      }
    })
    connection.on('soundEffectHeard', (sound, position) => {
      if (!/^(minecraft:)?item[._]shield[._]block$/.test(sound) || !connection.entity?.position) return
      const ownDistance = connection.entity.position.distanceTo(position)
      if (ownDistance <= 0.5 && !Object.values(connection.entities).some(entity =>
        entity !== connection.entity && entity.type === 'player' && entity.position?.distanceTo(position) <= ownDistance)) {
        confirmShieldBlock('shield-sound')
      }
    })
    connection.on('entitySwingArm', entity => {
      if (features.isHostileEntity(entity)) hostileSwings.set(entity, Date.now())
    })
    connection.on('entityUpdate', entity => {
      if (features.entityNameOf(entity) !== 'creeper') return
      if (entity.metadata?.[swell] > 0 || entity.metadata?.[ignited] === true) litCreepers.add(entity)
      else litCreepers.delete(entity)
    })
    const isArrow = entity => ['arrow', 'spectral_arrow'].includes(features.entityNameOf(entity))
    connection.on('entitySpawn', entity => {
      if (isArrow(entity)) arrows.set(entity.id, {
        position: entity.position.clone(), velocity: entity.velocity?.clone(), updated: Date.now()
      })
    })
    // The compact vector is already decoded in blocks per tick. Mineflayer's
    // generic entity helper still divides these packets by 8000.
    const updateCompactVelocity = packet => {
      const sample = arrows.get(packet.entityId)
      const v = packet.velocity
      if (sample && (connection.supportFeature('entityVelocityIsLpVec3') || /^26\./.test(connection.version)) && v &&
          [v.x, v.y, v.z].every(Number.isFinite)) {
        sample.velocity = new Vec3(v.x, v.y, v.z)
        sample.updated = Date.now()
      }
    }
    connection._client.on('spawn_entity', updateCompactVelocity)
    connection._client.on('entity_velocity', updateCompactVelocity)
    connection.on('entityMoved', entity => {
      const sample = arrows.get(entity.id)
      if (!sample) return
      const delta = entity.position.minus(sample.position)
      if (delta.norm() < 0.005) return
      const now = Date.now()
      sample.velocity = delta.scaled(50 / Math.max(50, now - sample.updated))
      sample.position = entity.position.clone()
      sample.updated = now
    })
    connection.on('entityGone', entity => {
      arrows.delete(entity.id)
      litCreepers.delete(entity)
    })
    connection.on('physicsTick', () => {
      if (connection !== runtimeState.bot || connection.health <= 0 || (!arrows.size && !litCreepers.size) || runtimeState.isEating ||
          runtimeState.isSmelting || runtimeState.isDiggingBlock || connection.targetDigBlock ||
          runtimeState.impactGuards.has(connection)) return
      const swimming = features.waterOwnsMovement()
      if (swimming && (!arrows.size || !features.isActuallyInWater(connection) || !enoughAir(connection) ||
          features.isWaterClutchActive(connection))) return
      const slot = connection.getEquipmentDestSlot('off-hand')
      if (connection.inventory.slots[slot]?.name !== 'shield') return
      const feet = connection.entity.position
      const creeper = !swimming && [...litCreepers].find(entity => !considered.has(entity) &&
        entity.position.distanceTo(feet) < 6 && features.hostileSight(entity).visible)
      if (creeper) {
        considered.add(creeper)
        void guardAgainstCreeper(connection, creeper, litCreepers)
          .catch(error => features.log('creeper guard interrupted', { message: error.message }))
        return
      }
      const now = Date.now()
      let incoming = null
      for (const [id, sample] of arrows) {
        const arrow = connection.entities[id]
        const v = sample.velocity
        if (!arrow || considered.has(arrow) || !v || now - sample.updated > 200) continue
        const speedSq = v.x * v.x + v.z * v.z
        if (speedSq < 0.035) continue
        const dx = feet.x - sample.position.x
        const dz = feet.z - sample.position.z
        const ticks = (dx * v.x + dz * v.z) / speedSq
        if (ticks <= 0 || ticks > 18 || (incoming && incoming.ticks <= ticks)) continue
        if (Math.hypot(dx - v.x * ticks, dz - v.z * ticks) > 0.85) continue
        const impactY = sample.position.y + v.y * ticks - 0.025 * ticks * ticks
        if (impactY < feet.y - 0.2 || impactY > feet.y + 2.3) continue
        const ray = feet.offset(0, 0.9, 0).minus(sample.position)
        if (ray.norm() > 0 && connection.world.raycast(sample.position, ray.unit(), ray.norm())) continue
        incoming = { arrow, ticks, velocity: v }
      }
      if (!incoming) return
      considered.add(incoming.arrow)
      void guardAgainstArrow(connection, incoming, swimming).catch(error => features.log('arrow guard interrupted', { message: error.message }))
    })
  }

  async function guardAgainstCreeper(connection, creeper, litCreepers) {
    features.pauseCombatTask(connection)
    runtimeState.impactGuards.add(connection)
    const onExplosion = () => features.log('creeper explosion observed while shielding', { entityId: creeper.id })
    connection._client.once('explosion', onExplosion)
    try {
      features.cancelCombatBow(connection, '苦力怕即将爆炸，切换格挡')
      features.stopPathfinder()
      connection.clearControlStates()
      const start = connection.entity.position.clone()
      const away = start.minus(creeper.position)
      const retreat = start.offset(away.x * 2, 0, away.z * 2)
      const until = Date.now() + 1700
      await connection.lookAt(features.hostileSight(creeper).center, true)
      if (connection !== runtimeState.bot || connection.health <= 0 || !raiseCombatShield(connection, creeper)) return
      features.log('creeper fuse guard', { entityId: creeper.id })
      while (connection === runtimeState.bot && connection.health > 0 && !features.waterOwnsMovement() &&
          litCreepers.has(creeper) && Date.now() < until) {
        await connection.lookAt(features.hostileSight(creeper).center, true)
        stepWhileShielding(connection, creeper.position, retreat)
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      // Hold until the explosion and damage packets arrive after entity removal.
      await new Promise(resolve => setTimeout(resolve, 120))
    } finally {
      connection._client.removeListener('explosion', onExplosion)
      runtimeState.impactGuards.delete(connection)
      lowerCombatShield(connection)
    }
  }

  async function guardAgainstArrow(connection, { arrow, ticks, velocity }, swimming) {
    const start = connection.entity.position.clone()
    const route = swimming ? [] : features.visibleNavigationState().waypoints || []
    const waypoint = route.find(point => Math.hypot(point.x - start.x, point.z - start.z) >= 0.8)
    const pursuing = runtimeState.meleeConnection === connection
    const retreating = runtimeState.fleeingActive
    const target = !swimming && (waypoint || (pursuing ? features.closeCombatPlan()?.target?.position : null) ||
      (retreating ? start.offset(velocity.x * 5, 0, velocity.z * 5) : null))
    if (swimming) swimArrowGuards.add(connection)
    else features.pauseCombatTask(connection)
    runtimeState.impactGuards.add(connection)
    try {
      features.cancelCombatBow(connection, '检测到来箭，切换格挡')
      if (swimming) {
        for (const key of ['sprint', 'forward', 'back', 'left', 'right']) connection.setControlState(key, false)
        connection.setControlState('jump', true)
      } else {
        features.stopPathfinder()
        connection.clearControlStates()
      }
      const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
      const facing = eyes.offset(-velocity.x * 8, 0, -velocity.z * 8)
      await connection.lookAt(facing, true)
      if (connection !== runtimeState.bot || connection.health <= 0 || !raiseCombatShield(connection, arrow)) return
      features.log('incoming arrow guard', { entityId: arrow.id, estimatedImpactMs: Math.round(ticks * 50), swimming })
      const until = Date.now() + Math.max(350, Math.round(ticks * 50) + 160)
      while (connection === runtimeState.bot && connection.health > 0 && Date.now() < until &&
          (swimming ? enoughAir(connection) : !features.waterOwnsMovement())) {
        if (target && runtimeState.raisedShields.has(connection)) stepWhileShielding(connection, facing, target)
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      const moved = connection.entity?.position.distanceTo(start) ?? 0
      if (moved >= 0.2) features.log('moved while blocking arrow', { distance: Number(moved.toFixed(2)), pursuing, retreating })
    } finally {
      swimArrowGuards.delete(connection)
      runtimeState.impactGuards.delete(connection)
      lowerCombatShield(connection)
      if (swimming && connection === runtimeState.bot) features.monitorSwimming()
    }
  }

  return {
    damageInterruptActive,
    equipCombatShield,
    raiseCombatShield,
    lowerCombatShield,
    stopShieldSteps,
    stepWhileShielding,
    trackCombatImpacts,
    isSwimmingArrowGuardActive: connection => swimArrowGuards.has(connection),
    latestShieldBlock: connection => shieldBlocks.get(connection) ?? 0,
    latestHostileSwing: entity => hostileSwings.get(entity) ?? 0,
  }
}

module.exports = createCombatDefence
