const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { THREAT_RADIUS, EMPTY_BLOCK, RANGED_HOSTILES } = require('./config')

const SHIELD_READY_MS = 350
const HOSTILE_NAMES = new Set([
  'blaze', 'cave_spider', 'drowned', 'enderman', 'ender_mite', 'evoker',
  'husk', 'magma_cube', 'pillager', 'piglin', 'piglin_brute', 'ravager',
  'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray',
  'vex', 'vindicator', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
  'zombie_villager', 'zombified_piglin', 'creeper',
])
const VERY_DANGEROUS_HOSTILES = new Set(['warden', 'ravager', 'wither', 'ender_dragon'])

function createCombat(runtimeState, features) {
  let lastThreatSignature = ''

  let lastThreatDispatchAt = 0

  let lastCloseThreatSignature = ''

  let lastManualAttackAt = 0

  const lastRangedGuard = new WeakMap()

  const retreatPursuits = new WeakMap()

  let lastUnreachedHostile = null

  function isHostileEntity(entity) {
    if (!entity || entity === runtimeState.bot?.entity) return false
    const name = features.entityNameOf(entity)
    if (!HOSTILE_NAMES.has(name)) return false

    // Passive unless provoked
    if (name === 'zombified_piglin' || name === 'enderman') return false

    // Spiders and cave spiders are neutral in daylight / light level >= 9
    if (name === 'spider' || name === 'cave_spider') {
      const tod = Number(runtimeState.bot?.time?.timeOfDay ?? 0)
      const isDay = (tod < 12000 || tod > 23500) && !runtimeState.bot?.isRaining
      if (isDay && runtimeState.bot?.world) {
        const pos = entity.position ? entity.position.floored() : null
        if (pos) {
          const block = runtimeState.bot.blockAt(pos) || runtimeState.bot.blockAt(pos.offset(0, 1, 0))
          const sky = block ? (block.skyLight ?? 15) : 15
          const light = block ? (block.light ?? 0) : 0
          if (Math.max(sky, light) >= 9) return false
        }
      }
    }

    return true
  }

  function findNearestHostile(maxDistance = 16, targetName = '') {
    const wanted = String(targetName || '').toLowerCase()
    return Object.values(runtimeState.bot.entities || {})
      .filter(entity => entity !== runtimeState.bot.entity && entity.position)
      .filter(entity => isHostileEntity(entity))
      .filter(entity => !wanted || features.entityNameOf(entity) === wanted)
      .filter(entity => entity.position.distanceTo(runtimeState.bot.entity.position) <= maxDistance)
      .sort((a, b) => {
        const distanceDelta = a.position.distanceTo(runtimeState.bot.entity.position) - b.position.distanceTo(runtimeState.bot.entity.position)
        if (Math.abs(distanceDelta) > 0.35) return distanceDelta
        return (Number(a.health ?? 999) - Number(b.health ?? 999))
      })[0]
  }

  async function equipCombatItem() {
    const tiers = { wooden: 0, golden: 0, stone: 1, copper: 1, iron: 2, diamond: 3, netherite: 4 }
    const gradeWeapon = item => {
      const [material, type] = item.name.split('_')
      const base = type === 'sword' ? 4 + tiers[material] :
        ({ wooden: 7, golden: 7, stone: 9, copper: 8, iron: 9, diamond: 9, netherite: 10 })[material]
      const sharpness = item.enchants?.find(enchant => /(^|:)sharpness$/.test(enchant.name || ''))?.lvl ?? 0
      return ((base ?? 1) + (sharpness > 0 ? 0.5 * (sharpness + 1) : 0)) / meleeCooldown(item)
    }
    const weapon = runtimeState.bot.inventory.items()
      .filter(item => /_(sword|axe)$/.test(item.name))
      .sort((a, b) => gradeWeapon(b) - gradeWeapon(a) || features.toolDurability(b) - features.toolDurability(a))[0]
    if (weapon && runtimeState.bot.heldItem?.slot !== weapon.slot) await runtimeState.bot.equip(weapon, 'hand')
    await features.equipCombatShield(runtimeState.bot)
  }

  function meleeCooldown(item) {
    if (!item?.name.endsWith('_axe')) return 650
    if (/^(golden|diamond|netherite)_/.test(item.name)) return 1050
    return item.name.startsWith('iron_') ? 1150 : 1250
  }

  async function executeAttack(threat, modelDecision = null) {
    const connection = runtimeState.bot
    if (!threat || !connection?.entity || features.waterOwnsMovement() || runtimeState.isEating || runtimeState.meleeConnection) return false
    let name = hostileName(threat)
    if (mustAvoidMelee(threat)) {
      return threat.position.distanceTo(runtimeState.bot.entity.position) <= 8 ? executeFlee(threat) : false
    }
    runtimeState.mineMode = false
    runtimeState.meleeConnection = connection
    runtimeState.lastDecision = 'hunt-hostile'
    features.log('combat pursuit started', { target: name, id: threat.id, reason: modelDecision?.reason || 'visible hostile' })
    const defensive = modelDecision?.defensive === true
    const deadline = Date.now() + (defensive ? 6500 : 18000)
    let killed = false
    const onDeath = entity => { if (entity.id === threat.id) killed = true }
    connection.on('entityDead', onDeath)
    let attempts = 0
    try {
      await equipCombatItem()
      while (connection === runtimeState.bot && Date.now() < deadline && runtimeState.bot.health > 0 && !features.waterOwnsMovement() && !runtimeState.emergencyRetreating && !killed) {
        if (runtimeState.impactGuards.has(connection)) {
          await new Promise(resolve => setTimeout(resolve, 60))
          continue
        }
        let live = runtimeState.bot.entities[threat.id]
        const danger = closeCombatPlan(live)
        if (danger?.action === 'attack' && danger.target.id !== live?.id) {
          const previous = live?.id ?? threat.id
          threat = live = danger.target
          name = hostileName(live)
          attempts = 0
          features.log('combat target switched', { previous, target: name, id: live.id })
        }
        if (!live || live.isValid === false) break
        if (mustAvoidMelee(live) || danger?.action === 'flee') {
          features.lowerCombatShield(connection)
          runtimeState.lastCombatDecision = { action: 'flee', reason: danger?.reason || '交战中状态下降，立即撤退' }
          await executeFlee(danger?.target || live, runtimeState.lastCombatDecision)
          break
        }
        const sight = hostileSight(live)
        if (sight.visible && sight.distance <= 3.8) {
          await runtimeState.bot.lookAt(sight.center, true)
          if (runtimeState.impactGuards.has(connection)) continue
          const guarding = features.raiseCombatShield(connection, live)
          if (guarding && !defensive && sight.distance > 2.7) features.stepWhileShielding(connection, sight.center, live.position)
          else features.stopShieldSteps(connection)
          const cooldown = meleeCooldown(runtimeState.bot.heldItem)
          const shieldReady = !guarding || Date.now() - runtimeState.raisedShields.get(connection) >= SHIELD_READY_MS
          if (sight.distance <= 3 && shieldReady && Date.now() - lastManualAttackAt >= cooldown &&
              runtimeState.bot.entityAtCursor(3)?.id === threat.id) {
            features.lowerCombatShield(connection)
            runtimeState.bot.attack(live, true)
            lastManualAttackAt = Date.now()
            attempts = 0
            features.log('combat swing', { target: name, id: live.id })
          }
          if (sight.distance <= 3 || (guarding && Date.now() - runtimeState.raisedShields.get(connection) < SHIELD_READY_MS + 250)) {
            await new Promise(resolve => setTimeout(resolve, 110))
            continue
          }
        }
        features.lowerCombatShield(connection)
        if (defensive) {
          await new Promise(resolve => setTimeout(resolve, 100))
          continue
        }
        if (++attempts > 6) break
        const { x, y, z } = live.position.floored()
        runtimeState.navigationState = { target: { x, y, z, name }, waypoints: [], label: 'hunt-hostile' }
        try {
          await features.gotoWithTimeout(new goals.GoalNear(x, y, z, sight.visible ? 2 : 1), 'combat approach', 1250)
        } catch {
          if (features.waterOwnsMovement() || runtimeState.emergencyRetreating) break
        }
        await new Promise(resolve => setTimeout(resolve, 120))
      }
    } finally {
      if (!runtimeState.fleeingActive && !runtimeState.impactGuards.has(connection)) features.lowerCombatShield(connection)
      runtimeState.meleeConnection = null
      connection.removeListener('entityDead', onDeath)
      features.clearNavigation('combat-ended')
      features.log('combat ended', { target: name, id: threat.id, killed })
      if (killed && closeCombatPlan()) runtimeState.urgentThreatQueued = true
      if (!killed) lastUnreachedHostile = { id: threat.id, until: Date.now() + 6000 }
      features.persistExperience({ cycle: runtimeState.cycle, action: 'attack', experience: killed ? `击杀 ${name}` : `追击 ${name} 结束，未确认击杀` })
    }
    return true
  }

  async function executeFlee(threat, modelDecision = null) {
    const connection = runtimeState.bot
    if (!connection?.entity || connection.health <= 0 || features.waterOwnsMovement() ||
        runtimeState.fleeingActive || runtimeState.impactGuards.has(connection)) return false
    runtimeState.fleeingActive = true
    runtimeState.retreatUntil = Date.now() + 10000
    runtimeState.activeGoal = null
    runtimeState.mineMode = false
    runtimeState.lastDecision = 'flee'
    const recoveringFromLowHealth = connection.health <= 8
    try {
      features.lowerCombatShield(connection)
      features.stopPathfinder()
      connection.pvp.stop()
      const ranged = threat && /^(skeleton|stray|bogged|pillager)$/.test(hostileName(threat))
      const distance = threat?.position.distanceTo(connection.entity.position)
      if (ranged && distance >= 4 && distance <= 12 && hostileSight(threat).visible &&
          Date.now() - (lastRangedGuard.get(connection) ?? 0) >= 3000 && !runtimeState.isEating) {
        try {
          connection.clearControlStates()
          if (await features.equipCombatShield(connection)) {
            await connection.lookAt(hostileSight(threat).center, true)
            if (connection === runtimeState.bot && features.raiseCombatShield(connection, threat)) {
              lastRangedGuard.set(connection, Date.now())
              const here = connection.entity.position
              const away = here.minus(threat.position)
              features.stepWhileShielding(connection, threat.position, here.offset(away.x, 0, away.z))
              await new Promise(resolve => setTimeout(resolve, 450))
            }
          }
        } finally {
          if (!runtimeState.impactGuards.has(connection)) features.lowerCombatShield(connection)
        }
      }
      if (connection !== runtimeState.bot || connection.health <= 0 || features.waterOwnsMovement()) return false
      let advanced = false
      for (let leg = 0; leg < 5 && connection === runtimeState.bot && connection.health > 0 && !features.waterOwnsMovement(); leg += 1) {
        if (recoveringFromLowHealth && features.safeToEatOnRetreat(connection)) await features.restAfterRetreat(connection)
        if (connection !== runtimeState.bot || connection.health <= 0 || features.waterOwnsMovement()) return false
        if (await features.tryEmergencyPit(connection)) return true
        const plan = closeCombatPlan()
        if (leg > 0 && plan?.action === 'attack' && (!recoveringFromLowHealth || connection.health >= 20)) {
          runtimeState.urgentThreatQueued = true
          return true
        }
        if (leg > 0 && !findNearestHostile(14)) return true
        if (plan?.action === 'flee') threat = plan.target
        advanced = await executeRetreatLeg(connection, threat, leg === 0 ? modelDecision : null)
        if (!advanced) break
      }
      if (advanced) await features.tryEmergencyPit(connection)
      return true
    } finally {
      if (!runtimeState.impactGuards.has(connection)) features.lowerCombatShield(connection)
      runtimeState.retreatUntil = Date.now() + 6000
      runtimeState.fleeingActive = false
    }
  }

  async function executeRetreatLeg(connection, threat, modelDecision) {
      const origin = connection.entity.position.floored()
      const pursuers = nearbyThreatSignature().threats.filter(entry => entry.distance <= 14)
      const ids = new Set(pursuers.map(entry => entry.id))
      if (threat?.id != null) ids.add(threat.id)
      let pursuit = retreatPursuits.get(connection)
      if (!pursuit || Date.now() - pursuit.updated > 16000 || ![...ids].some(id => pursuit.ids.has(id))) {
        pursuit = { started: Date.now(), updated: Date.now(), goals: 0, ids }
        retreatPursuits.set(connection, pursuit)
      } else {
        pursuit.updated = Date.now()
        pursuit.ids = ids
      }
      const threats = pursuers.map(entry => entry.position)
      if (!threats.length && threat?.position) threats.push(threat.position)
      const closestDistance = point => Math.min(...threats.map(p => Math.hypot(point.x - p.x, point.z - p.z)))
      const delta = threats.reduce((sum, p) => {
        const dx = origin.x - p.x
        const dz = origin.z - p.z
        const distance = Math.hypot(dx, dz) || 1
        return { x: sum.x + dx / distance, z: sum.z + dz / distance }
      }, { x: 0, z: 0 })
      const angle = delta.x || delta.z ? Math.atan2(delta.z, delta.x) : 0
      const modelTarget = features.clampModelTarget(modelDecision?.target, origin, 14)
      const candidates = modelTarget ? [modelTarget] : []
      for (const distance of [12, 8, 5]) {
        for (const turn of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
          candidates.push({
            x: origin.x + Math.round(Math.cos(angle + turn) * distance),
            z: origin.z + Math.round(Math.sin(angle + turn) * distance),
          })
        }
      }

      const safe = candidates.filter(target => {
        if (Math.hypot(target.x - origin.x, target.z - origin.z) < 5) return false
        if (threats.length && closestDistance(target) < closestDistance(origin) + 1) return false
        return [-2, -1, 0, 1, 2].some(dy => {
          const feet = new Vec3(target.x, origin.y + dy, target.z)
          const floor = connection.blockAt(feet.offset(0, -1, 0))
          return floor?.boundingBox === 'block' && !/cactus|magma|campfire/.test(floor.name) &&
            EMPTY_BLOCK.test(connection.blockAt(feet)?.name) &&
            EMPTY_BLOCK.test(connection.blockAt(feet.offset(0, 1, 0))?.name)
        })
      }).sort((a, b) => threats.length ? closestDistance(b) - closestDistance(a) : 0)

      for (const target of safe.slice(0, 4)) {
        while (connection === runtimeState.bot && runtimeState.impactGuards.has(connection)) {
          await new Promise(resolve => setTimeout(resolve, 60))
        }
        if (runtimeState.bot !== connection || connection.health <= 0 || features.waterOwnsMovement()) break
        runtimeState.navigationState = { target, waypoints: [], label: 'flee' }
        features.log('fleeing', { target, threat: features.entityNameOf(threat) || null, reason: modelDecision?.reason || '' })
        try {
          await gotoRetreatWaypoint(connection, target)
          pursuit.goals += 1
          pursuit.updated = Date.now()
          features.log('retreat waypoint reached', { target, position: connection.entity.position.floored() })
          return true
        } catch (error) {
          features.log('retreat route interrupted', { target, message: error.message })
        }
      }
      return false
  }

  async function gotoRetreatWaypoint(connection, target) {
    const goal = new goals.GoalNearXZ(target.x, target.z, 1)
    let lastPosition = connection.entity.position.clone()
    let lastProgress = Date.now()
    const watch = setInterval(() => {
      if (connection !== runtimeState.bot || connection.pathfinder.goal !== goal || !connection.entity) return
      if (connection.entity.position.distanceTo(lastPosition) >= 0.35) {
        lastPosition = connection.entity.position.clone()
        lastProgress = Date.now()
      } else if (Date.now() - lastProgress >= 950) {
        features.log('retreat route stalled; changing direction', { target })
        connection.pathfinder.setGoal(null)
      }
    }, 125)
    try {
      await features.gotoWithTimeout(goal, 'flee', 4200)
    } finally {
      clearInterval(watch)
    }
  }

  async function backstepFromThreat(threat, durationMs = 1800) {
    if (!threat || !runtimeState.bot.entity || runtimeState.bot.health <= 0 || features.waterOwnsMovement()) return false
    try {
      await runtimeState.bot.lookAt(threat.position.offset(0, 1, 0), true)
      runtimeState.bot.pvp.stop()
      runtimeState.bot.setControlState('sprint', true)
      runtimeState.bot.setControlState('back', true)
      runtimeState.bot.setControlState('jump', true)
      await new Promise(resolve => setTimeout(resolve, durationMs))
      if (features.waterOwnsMovement()) return false
      runtimeState.bot.setControlState('back', false)
      runtimeState.bot.setControlState('sprint', false)
      runtimeState.bot.setControlState('jump', false)
      features.log('local backstep completed', { threat: features.entityNameOf(threat), distance: Number(threat.position.distanceTo(runtimeState.bot.entity.position).toFixed(1)) })
      return true
    } catch (error) {
      runtimeState.bot.setControlState('back', false)
      runtimeState.bot.setControlState('sprint', false)
      runtimeState.bot.setControlState('jump', false)
      features.log('local backstep failed', { message: error.message })
      return false
    }
  }

  async function handleScriptFallbackThreat() {
    const candidates = nearbyThreatSignature().threats
      .map(({ id }) => runtimeState.bot.entities[id])
      .filter(entity => entity && hostileSight(entity).visible)
    const danger = candidates.find(entity => mustAvoidMelee(entity) && entity.position.distanceTo(runtimeState.bot.entity.position) < 8)
    if (danger) return executeFlee(danger)
    const target = candidates.find(entity => !mustAvoidMelee(entity) &&
      (lastUnreachedHostile?.id !== entity.id || Date.now() > lastUnreachedHostile.until))
    return target ? executeAttack(target) : false
  }

  function threatRange(name) {
    return RANGED_HOSTILES.has(name) ? 14 : 8
  }

  function closeCombatPlan(currentTarget = null) {
    if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0) return null
    const threats = nearbyThreatSignature().threats
      .filter(({ distance, name }) => distance <= threatRange(name))
      .map(({ id }) => runtimeState.bot.entities[id]).filter(entity => entity && hostileSight(entity).visible)
    if (!threats.length) return null
    const origin = runtimeState.bot.entity.position
    const distance = entity => entity.position.distanceTo(origin)
    const dangerous = threats.find(entity => VERY_DANGEROUS_HOSTILES.has(hostileName(entity)) ||
      (hostileName(entity) === 'creeper' && distance(entity) <= 6.5))
    if (dangerous) return { action: 'flee', target: dangerous, reason: '爆炸威胁过近或遇到高危大型怪' }
    const options = threats.filter(entity => hostileName(entity) !== 'creeper')
    if (!options.length) return null
    const score = entity => distance(entity) - (entity.id === currentTarget?.id ? 1.15 : 0) -
      (RANGED_HOSTILES.has(hostileName(entity)) ? 0.9 : 0) -
      (Number.isFinite(entity.health) && entity.health <= 5 ? 0.75 : 0)
    const target = [...options].sort((a, b) => score(a) - score(b))[0]
    const hasShield = runtimeState.bot.inventory.slots.some(item => item?.name === 'shield')
    const armor = features.equippedArmorCount()
    const ranged = options.some(entity => RANGED_HOSTILES.has(hostileName(entity)))
    const direction = target.position.minus(origin)
    const flanked = threats.some(entity => {
      const other = entity.position.minus(origin)
      return direction.x * other.x + direction.z * other.z < -1 && distance(entity) < 6
    })
    const minHealth = Math.max(6, 6 + (options.length - 1) * 3 + (ranged ? (hasShield ? 1 : 4) : 0) +
      (flanked ? 2 : 0) - (armor >= 3 ? 2 : 0) - (hasShield && !flanked ? 1 : 0))
    if (mustAvoidMelee(target) || runtimeState.bot.health <= minHealth) {
      const pursuit = retreatPursuits.get(runtimeState.bot)
      if (pursuit && Date.now() - pursuit.started >= 12000 && Date.now() - pursuit.updated <= 16000 &&
          pursuit.goals >= 2 && hasShield && !ranged && !flanked && runtimeState.bot.health >= 7 && !mustAvoidMelee(target)) {
        const lead = options.filter(entity => pursuit.ids.has(entity.id))
          .sort((a, b) => distance(a) - distance(b))[0]
        if (lead && distance(lead) <= 5 && options.every(entity => entity.id === lead.id || distance(entity) > 3.5)) {
          return { action: 'attack', target: lead, defensive: true,
            reason: '持续被追，举盾原地反打领头怪' }
        }
      }
      return { action: 'flee', target, reason: `状态不足以处理 ${options.length} 只近敌（安全血量需高于 ${minHealth}）` }
    }
    return { action: 'attack', target, reason: ranged && hasShield ? '状态足够，持盾接近并接战' :
      options.length > 1 ? '状态足够，优先处理眼前目标再换怪' : '状态足够，接战附近敌人' }
  }

  function hostileName(entity) {
    return String(entity.name || entity.displayName || '').toLowerCase().replaceAll(' ', '_')
  }

  function mustAvoidMelee(entity) {
    const name = hostileName(entity)
    return name === 'creeper' || VERY_DANGEROUS_HOSTILES.has(name) || runtimeState.bot.health <= 5 ||
      runtimeState.bot.food < 4 || (!features.hasTool('sword') && !features.hasTool('axe'))
  }

  function hostileSight(entity) {
    const eyes = runtimeState.bot.entity.position.offset(0, runtimeState.bot.entity.eyeHeight, 0)
    const center = entity.position.offset(0, (entity.height || 1.8) * 0.55, 0)
    const ray = center.minus(eyes)
    const distance = ray.norm()
    const hit = distance > 0 && runtimeState.bot.world.raycast(eyes, ray.unit(), distance)
    return { center, distance, visible: !hit || eyes.distanceTo(hit.intersect) >= distance }
  }

  function nearbyThreatSignature() {
    const threats = Object.values(runtimeState.bot.entities || {})
      .filter(entity => entity !== runtimeState.bot.entity && entity.position)
      .map(entity => {
        const name = features.entityNameOf(entity)
        return { entity, name, distance: entity.position.distanceTo(runtimeState.bot.entity.position) }
      })
      .filter(item => isHostileEntity(item.entity) && item.distance <= THREAT_RADIUS)
      .sort((a, b) => a.distance - b.distance)
    if (threats.length === 0) return { signature: '', threats: [] }
    // A moving mob should not trigger a new model call every 500 ms. The
    // signature changes only when a hostile entity enters/leaves the radius or
    // a different hostile entity appears.
    const signature = threats.slice(0, 6).map(item => `${item.entity.id}:${item.name}`).join('|')
    return {
      signature,
      threats: threats.slice(0, 6).map(item => ({
        id: item.entity.id,
        name: item.name,
        distance: Number(item.distance.toFixed(1)),
        position: item.entity.position.floored(),
      })),
    }
  }

  function monitorThreats() {
    if (!runtimeState.botEnabled || !runtimeState.bot || !runtimeState.bot.entity || runtimeState.impactGuards.has(runtimeState.bot) ||
        runtimeState.emergencyShelteredUntil || runtimeState.shelteredUntilDawn || runtimeState.shelterBusy) return
    const current = nearbyThreatSignature()
    if (!current.signature) {
      lastThreatSignature = ''
      lastCloseThreatSignature = ''
      return
    }
    const closest = current.threats[0]
    if (closest && (closest.distance <= 4 || (runtimeState.lastDecision === 'flee' && closest.distance <= 14)) &&
        !runtimeState.emergencyRetreating && !runtimeState.fleeingActive && !features.waterOwnsMovement()) {
      const entity = runtimeState.bot.entities[closest.id]
      const plan = closeCombatPlan()
      if (entity && (plan?.action === 'flee' ||
          (!plan && runtimeState.lastDecision === 'flee' && retreatPursuits.get(runtimeState.bot)?.ids.has(entity.id)))) {
        const target = plan?.target ?? entity
        runtimeState.emergencyRetreating = true
        runtimeState.lastCombatDecision = { action: 'flee', reason: plan?.reason ?? '追兵仍在附近，继续脱离', target: hostileName(target) }
        features.log('emergency spacing guard', { target: closest.name, distance: closest.distance })
        void executeFlee(target, runtimeState.lastCombatDecision)
          .catch(error => features.log('emergency retreat interrupted', { message: error.message }))
          .finally(() => {
            runtimeState.emergencyRetreating = false
            void features.decideAndAct('urgent-post-emergency')
          })
      }
    }
    const now = Date.now()
    const closeSignature = current.threats.filter(({id, distance, name}) =>
      distance <= threatRange(name) &&
        runtimeState.bot.entities[id] && hostileSight(runtimeState.bot.entities[id]).visible).map(({id}) => id).join('|')
    if ((current.signature !== lastThreatSignature || closeSignature !== lastCloseThreatSignature) &&
        now - lastThreatDispatchAt >= 1000) {
      lastThreatSignature = current.signature
      lastCloseThreatSignature = closeSignature
      lastThreatDispatchAt = now
      features.log('urgent threat detected', { radius: THREAT_RADIUS, threats: current.threats })
      const response = closeSignature && closeCombatPlan()
      if (response && !features.waterOwnsMovement() && !runtimeState.emergencyRetreating && !runtimeState.fleeingActive && runtimeState.lastDecision !== 'hunt-hostile') {
        if (runtimeState.bot.pathfinder.goal) features.stopPathfinder()
        if (runtimeState.bot.targetDigBlock) runtimeState.bot.stopDigging()
        void features.decideAndAct('urgent-threat')
      }
    }
  }

  return {
    isHostileEntity,
    findNearestHostile,
    equipCombatItem,
    executeAttack,
    executeFlee,
    handleScriptFallbackThreat,
    threatRange,
    closeCombatPlan,
    hostileName,
    mustAvoidMelee,
    hostileSight,
    nearbyThreatSignature,
    monitorThreats,
  }
}

module.exports = createCombat
