const { goals, Movements } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const { avoidWetCorners, avoidWetSteps, dryFooting, pathHazard } = require('./movement-safety')
const { THREAT_RADIUS, EMPTY_BLOCK, RANGED_HOSTILES } = require('./config')

const COUNTER_WINDOW_MS = 600
const JUMP_WINDOW_MS = 570
const HOSTILE_NAMES = new Set([
  'blaze', 'cave_spider', 'drowned', 'enderman', 'ender_mite', 'evoker',
  'husk', 'magma_cube', 'pillager', 'piglin', 'piglin_brute', 'ravager',
  'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray',
  'vex', 'vindicator', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
  'zombie_villager', 'zombified_piglin', 'creeper',
])
const VERY_DANGEROUS_HOSTILES = new Set(['warden', 'ravager', 'wither', 'ender_dragon'])

function meleeExchange({ shield, inReach, ready, guarding, recentBlock, incoming, recover, defensive, firstStrike }) {
  if (inReach && ready && (!shield || recentBlock || (!incoming && guarding >= (firstStrike ? 600 : 340)))) return 'strike'
  if (shield && (incoming || defensive || !inReach || !recover || guarding > 0)) return 'guard'
  return 'wait'
}

function jumpAttackStep({ safe, elapsed, onGround, rose, descending, ready, inReach }) {
  if (!safe) return 'cancel'
  if (descending && ready && inReach) return 'strike'
  if (elapsed >= JUMP_WINDOW_MS || (onGround && rose)) return ready && inReach ? 'fallback' : 'cancel'
  return 'wait'
}

function opponentMissedSwing({ swingAge, hurtAfterSwing, guardReady }) {
  return guardReady && !hurtAfterSwing && swingAge >= 75 && swingAge <= 185
}

function hasRaisedShield(flags, equipment) {
  return Number.isInteger(flags) && (flags & 1) !== 0 && equipment?.[(flags & 2) !== 0 ? 1 : 0]?.name === 'shield'
}

function createCombat(runtimeState, features) {
  const duelOpponent = process.env.MC_DUEL_OPPONENT || ''
  const jumpAttacksEnabled = process.env.MC_JUMP_ATTACKS !== '0'
  const defeated = new WeakSet()
  let lastThreatSignature = ''

  let lastThreatDispatchAt = 0

  let lastCloseThreatSignature = ''

  let lastManualAttackAt = 0

  const lastRangedGuard = new WeakMap()

  const retreatPursuits = new WeakMap()

  let lastUnreachedHostile = null

  function isHostileEntity(entity) {
    if (!entity || entity === runtimeState.bot?.entity || defeated.has(entity)) return false
    if (entity.type === 'player') return Boolean(duelOpponent && entity.username === duelOpponent)
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

  function canStartJumpAttack(connection) {
    const entity = connection.entity
    if (!entity.onGround || entity.isInWater || entity.isInLava || entity.elytraFlying || connection.health < 10 ||
        !/_(sword|axe)$/.test(connection.heldItem?.name)) return false
    const feet = entity.position.floored()
    const floor = connection.blockAt(feet.offset(0, -1, 0))
    if (floor?.boundingBox !== 'block' || /ice|slime|honey|magma|cactus|campfire/.test(floor.name)) return false
    return [0, 1, 2, 3].every(height => {
      const block = connection.blockAt(feet.offset(0, height, 0))
      return block?.boundingBox === 'empty' && !/water|lava|ladder|vine|scaffolding|powder_snow|web/.test(block.name)
    })
  }

  async function executeAttack(threat, modelDecision = null) {
    const connection = runtimeState.bot
    if (!threat || !connection?.entity || features.waterOwnsMovement() || runtimeState.isEating || runtimeState.meleeConnection) return false
    let name = hostileName(threat)
    const defensive = modelDecision?.defensive === true
    if (mustAvoidMelee(threat) && (defensive || !features.canUseCombatBow(connection, threat))) {
      return threat.position.distanceTo(runtimeState.bot.entity.position) <= 8 ? executeFlee(threat) : false
    }
    features.pauseCombatTask(connection)
    runtimeState.mineMode = false
    runtimeState.meleeConnection = connection
    runtimeState.lastDecision = 'hunt-hostile'
    features.log('combat pursuit started', { target: name, id: threat.id, reason: modelDecision?.reason || 'visible hostile' })
    const deadline = Date.now() + (defensive ? 6500 : 18000)
    let killed = false
    const onDeath = entity => {
      defeated.add(entity)
      if (entity.id === threat.id) killed = true
    }
    connection.on('entityDead', onDeath)
    let lastHurtAt = 0
    const onHurt = entity => { if (entity?.id === connection.entity?.id) lastHurtAt = Date.now() }
    connection.on('entityHurt', onHurt)
    let attempts = 0
    let lastCounterBlock = 0
    let guardSince = Date.now()
    let jump = null
    let nextJumpAt = 0
    let axePlan = null
    let weaponReadyAt = 0
    let nextShieldBreakAt = 0
    let restoreWeapon = false
    let needsMeleeWeapon = false
    let bowRetryAt = 0
    const activeHandIndex = connection.registry.entitiesByName.player?.metadataKeys?.indexOf('living_entity_flags')
    const clearJump = () => {
      if (!jump) return
      connection.setControlState('jump', false)
      jump = null
    }
    try {
      await equipCombatItem()
      while (connection === runtimeState.bot && Date.now() < deadline && runtimeState.bot.health > 0 && !features.waterOwnsMovement() && !runtimeState.emergencyRetreating && !runtimeState.fleeingActive && !killed) {
        if (runtimeState.impactGuards.has(connection)) {
          clearJump()
          await new Promise(resolve => setTimeout(resolve, 60))
          continue
        }
        let live = runtimeState.bot.entities[threat.id]
        const danger = closeCombatPlan(live)
        if (danger?.action === 'attack' && danger.target.id !== live?.id) {
          clearJump()
          const previous = live?.id ?? threat.id
          threat = live = danger.target
          name = hostileName(live)
          attempts = 0
          guardSince = Date.now()
          features.log('combat target switched', { previous, target: name, id: live.id })
        }
        if (!live || live.isValid === false) break
        if (!defensive && danger?.action !== 'flee' && Date.now() >= bowRetryAt && features.canUseCombatBow(connection, live)) {
          clearJump()
          axePlan = null
          restoreWeapon = false
          needsMeleeWeapon = true
          const shot = await features.shootCombatBow(connection, live)
          if (shot) {
            await new Promise(resolve => setTimeout(resolve, 180))
            continue
          }
          bowRetryAt = Date.now() + 900
          if (connection !== runtimeState.bot || connection.health <= 0 || runtimeState.impactGuards.has(connection)) continue
        }
        if (modelDecision?.rangedOnly && danger?.action !== 'flee' && connection.entity.position.distanceTo(live.position) > 8) break
        if (mustAvoidMelee(live) || danger?.action === 'flee') {
          clearJump()
          features.lowerCombatShield(connection)
          runtimeState.lastCombatDecision = { action: 'flee', reason: danger?.reason || '交战中状态下降，立即撤退' }
          await executeFlee(danger?.target || live, runtimeState.lastCombatDecision)
          break
        }
        if (needsMeleeWeapon) {
          const previous = connection.heldItem?.type
          await equipCombatItem()
          if (connection.heldItem?.type !== previous) weaponReadyAt = Date.now() + meleeCooldown(connection.heldItem)
          needsMeleeWeapon = false
          runtimeState.lastDecision = 'hunt-hostile'
          if (runtimeState.impactGuards.has(connection)) continue
        }
        const sight = hostileSight(live)
        if (sight.visible && sight.distance <= 3.8) {
          await runtimeState.bot.lookAt(sight.center, true)
          if (runtimeState.impactGuards.has(connection)) { clearJump(); continue }
          const now = Date.now()
          const blockAt = features.latestShieldBlock(connection)
          const recentBlock = blockAt >= guardSince && blockAt > lastCounterBlock && now - blockAt <= COUNTER_WINDOW_MS
          const raisedAt = runtimeState.raisedShields.get(connection)
          const shield = connection.inventory.slots[connection.getEquipmentDestSlot('off-hand')]?.name === 'shield'
          const inReach = sight.distance <= 3 && connection.entityAtCursor(3)?.id === live.id
          const enemySwingAt = features.latestHostileSwing(live)
          const enemySwingAge = now - enemySwingAt
          const incoming = enemySwingAge <= 450
          const ready = now >= weaponReadyAt && now - lastManualAttackAt >= meleeCooldown(connection.heldItem)
          const action = meleeExchange({ shield, inReach, ready,
            guarding: raisedAt ? now - raisedAt : 0, recentBlock, incoming,
            recover: now - lastManualAttackAt <= 245, defensive, firstStrike: lastManualAttackAt < guardSince })
          let swing = action === 'strike' ? (recentBlock ? 'counter' : 'normal') : null
          const entity = connection.entity
          const targetShieldRaised = live.type === 'player' && hasRaisedShield(live.metadata?.[activeHandIndex], live.equipment)
          if (axePlan && (axePlan.id !== live.id || !targetShieldRaised || now > axePlan.until)) {
            axePlan = null
            restoreWeapon = true
          }
          if (restoreWeapon && !recentBlock && !jump) {
            const previous = connection.heldItem?.type
            await equipCombatItem()
            if (connection.heldItem?.type !== previous) weaponReadyAt = Date.now() + meleeCooldown(connection.heldItem)
            restoreWeapon = false
            await new Promise(resolve => setTimeout(resolve, 45))
            continue
          }
          if (axePlan && swing !== 'counter') {
            swing = ready && inReach ? 'axe' : null
          } else if (!axePlan && swing === 'normal' && targetShieldRaised && !defensive && now >= nextShieldBreakAt) {
            const axe = connection.inventory.items().filter(item => /_axe$/.test(item.name) && features.toolDurability(item) > 0)
              .sort((a, b) => meleeCooldown(a) - meleeCooldown(b) || features.toolDurability(b) - features.toolDurability(a))[0]
            if (axe) {
              clearJump()
              if (connection.heldItem?.slot !== axe.slot) {
                await connection.equip(axe, 'hand')
                weaponReadyAt = Date.now() + meleeCooldown(connection.heldItem)
              }
              if (connection.heldItem?.name.endsWith('_axe')) {
                axePlan = { id: live.id, until: Math.max(weaponReadyAt, now) + 900 }
                nextShieldBreakAt = now + 2100
                features.log('combat shield breaker readying', { target: name, weapon: connection.heldItem.name })
                continue
              }
            }
          }
          if (jump && targetShieldRaised) clearJump()
          if (jump && swing !== 'counter') {
            const elapsed = now - jump.at
            const y = entity.position.y
            jump.peakY = Math.max(jump.peakY, y)
            if (!entity.onGround || elapsed >= 110) connection.setControlState('jump', false)
            const step = jumpAttackStep({
              safe: enemySwingAt <= jump.at && lastHurtAt <= jump.at &&
                !entity.isInWater && !entity.isInLava && connection.health >= jump.health,
              elapsed, onGround: entity.onGround, rose: jump.peakY > jump.originY + 0.15,
              descending: !entity.onGround && entity.velocity.y < -0.06 && jump.peakY - y >= 0.09 && y >= jump.originY + 0.2,
              ready, inReach,
            })
            if (step === 'wait') {
              await new Promise(resolve => setTimeout(resolve, 45))
              continue
            }
            if (step === 'strike') swing = 'jump'
            if (step === 'fallback') swing = 'normal'
            if (step === 'cancel') features.log('combat jump cancelled', { target: name, elapsed })
            clearJump()
          }
          const jumpOpening = live.type === 'player'
            ? ready && inReach && !recentBlock && opponentMissedSwing({
              swingAge: enemySwingAge, hurtAfterSwing: lastHurtAt >= enemySwingAt,
              guardReady: !shield || Boolean(raisedAt && now - raisedAt >= 340),
            })
            : swing === 'normal' && !incoming
          if (!axePlan && !targetShieldRaised && jumpOpening && jumpAttacksEnabled && !defensive && now >= nextJumpAt &&
              sight.distance <= 2.75 && canStartJumpAttack(connection)) {
            features.lowerCombatShield(connection)
            features.stopPathfinder()
            connection.setControlState('sprint', false)
            jump = { at: now, originY: entity.position.y, peakY: entity.position.y, health: connection.health }
            nextJumpAt = now + 950
            connection.setControlState('jump', true)
            features.log('combat jump started', { target: name, id: live.id })
            await new Promise(resolve => setTimeout(resolve, 45))
            continue
          }
          if (swing) {
            clearJump()
            features.lowerCombatShield(connection)
            connection.attack(live, true)
            lastManualAttackAt = now
            if (swing === 'counter') {
              lastCounterBlock = blockAt
              runtimeState.lastCombatDecision = { action: 'attack', target: name, defensive, reason: '盾牌已挡下攻击，武器冷却结束后反击' }
              features.log('combat shield counter', { target: name, id: live.id, delayMs: now - blockAt })
            } else if (swing === 'axe') {
              axePlan = null
              restoreWeapon = true
              nextShieldBreakAt = now + 5000
              runtimeState.lastCombatDecision = { action: 'attack', target: name, defensive, reason: '对手正在举盾，用斧头打盾' }
              features.log('combat axe shield swing', { target: name, id: live.id, weapon: connection.heldItem.name })
            } else if (swing === 'jump') {
              runtimeState.lastCombatDecision = { action: 'attack', target: name, defensive, reason: '实际起跳并在下落时攻击' }
              features.log('combat jump swing', { target: name, id: live.id, velocityY: entity.velocity.y })
            }
            attempts = 0
            features.log('combat swing', { target: name, id: live.id })
          } else if (action === 'guard') {
            const guarding = features.raiseCombatShield(connection, live)
            if (guarding && !defensive && !inReach) features.stepWhileShielding(connection, sight.center, live.position)
            else features.stopShieldSteps(connection)
          }
          if (inReach || swing || (action === 'guard' && (defensive || incoming || !raisedAt || now - raisedAt < 800))) {
            await new Promise(resolve => setTimeout(resolve, 55))
            continue
          }
        }
        if (runtimeState.emergencyRetreating || runtimeState.fleeingActive) break
        clearJump()
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
      if (!runtimeState.fleeingActive && !runtimeState.impactGuards.has(connection)) {
        clearJump()
        features.cancelCombatBow(connection, '本次战斗结束')
        features.lowerCombatShield(connection)
      }
      runtimeState.meleeConnection = null
      connection.removeListener('entityDead', onDeath)
      connection.removeListener('entityHurt', onHurt)
      if (!runtimeState.fleeingActive && !runtimeState.emergencyRetreating) features.clearNavigation('combat-ended')
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
    features.cancelCombatBow(connection, '进入撤离')
    features.pauseCombatTask(connection)
    runtimeState.fleeingActive = true
    runtimeState.retreatUntil = Date.now() + 10000
    runtimeState.activeGoal = null
    runtimeState.mineMode = false
    runtimeState.lastDecision = 'flee'
    const recoveringFromLowHealth = connection.health <= 10
    let meal = null
    let nextMealAt = 0
    const eatOnTheMove = () => {
      if ((!recoveringFromLowHealth && connection.health > 10) || meal || Date.now() < nextMealAt ||
          !features.safeToEatOnRetreat(connection)) return
      if (!features.getEdibleFoods().some(item => connection.food < 20 || /^(enchanted_)?golden_apple$/.test(item.name))) return
      nextMealAt = Date.now() + 2600
      features.lowerCombatShield(connection)
      meal = features.eatFoodIfNeeded({ retreat: true, moving: true })
        .then(ate => !ate && guardInterruptedMeal(connection))
        .finally(() => { meal = null })
    }
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
      let retreatShotTried = false
      const retreatOrigin = connection.entity.position.clone()
      const canShootOnRetreat = () => !retreatShotTried && !meal &&
        connection.entity.position.distanceTo(retreatOrigin) >= 3 &&
        features.canUseCombatBow(connection, threat, true)
      for (let leg = 0; leg < 5 && connection === runtimeState.bot && connection.health > 0 && !features.waterOwnsMovement(); leg += 1) {
        if (connection !== runtimeState.bot || connection.health <= 0 || features.waterOwnsMovement()) return false
        if (!meal && await features.tryEmergencyPit(connection)) return true
        const plan = closeCombatPlan()
        if (leg > 0 && plan?.action === 'attack' && (!recoveringFromLowHealth || connection.health >= 20)) {
          runtimeState.urgentThreatQueued = true
          return true
        }
        if (leg > 0 && !findNearestHostile(retreatShotTried ? 19 : 14)) break
        if (plan?.action === 'flee') threat = plan.target
        advanced = await executeRetreatLeg(connection, threat, leg === 0 ? modelDecision : null, () => {
          eatOnTheMove()
          return canShootOnRetreat()
        })
        if (!advanced) break
        eatOnTheMove()
        if (canShootOnRetreat()) {
          retreatShotTried = true
          await features.shootCombatBow(connection, threat, true)
          if (connection === runtimeState.bot && runtimeState.fleeingActive) runtimeState.lastDecision = 'flee'
        }
      }
      if (meal) await meal
      if (recoveringFromLowHealth && features.safeToEatOnRetreat(connection)) await features.restAfterRetreat(connection)
      if (advanced) await features.tryEmergencyPit(connection)
      return true
    } finally {
      if (meal) await meal
      if (!runtimeState.impactGuards.has(connection)) features.lowerCombatShield(connection)
      runtimeState.retreatUntil = Date.now() + 6000
      runtimeState.fleeingActive = false
    }
  }

  async function guardInterruptedMeal(connection) {
    if (connection !== runtimeState.bot || !runtimeState.fleeingActive || connection.health <= 0 ||
        runtimeState.impactGuards.has(connection) || features.safeToEatOnRetreat(connection)) return
    const threat = findNearestHostile(7)
    if (!threat || !hostileSight(threat).visible) return
    runtimeState.impactGuards.add(connection)
    try {
      features.stopPathfinder()
      if (!await features.equipCombatShield(connection)) return
      if (connection !== runtimeState.bot || connection.health <= 0) return
      const lookingAt = hostileSight(threat).center
      await connection.lookAt(lookingAt, true)
      if (!features.raiseCombatShield(connection, threat)) return
      features.log('retreat shield restored after interrupted meal', { target: hostileName(threat) })
      const origin = connection.entity.position
      const away = origin.minus(threat.position)
      features.stepWhileShielding(connection, lookingAt, origin.offset(away.x, 0, away.z))
      await new Promise(resolve => setTimeout(resolve, 450))
    } catch (error) {
      features.log('retreat shield recovery interrupted', { message: error.message })
    } finally {
      runtimeState.impactGuards.delete(connection)
      features.lowerCombatShield(connection)
    }
  }

  async function executeRetreatLeg(connection, threat, modelDecision, onAdvance) {
      const origin = connection.entity.position.floored()
      const pursuers = nearbyThreatSignature().threats.filter(entry => entry.distance <= 14)
      const ids = new Set(pursuers.map(entry => entry.id))
      if (threat?.id != null) ids.add(threat.id)
      let pursuit = retreatPursuits.get(connection)
      if (!pursuit || Date.now() - pursuit.updated > 16000 || ![...ids].some(id => pursuit.ids.has(id))) {
        pursuit = { started: Date.now(), updated: Date.now(), goals: 0, ids, failed: new Map() }
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
      for (const distance of [12, 8, 5, 3]) {
        for (const turn of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]) {
          candidates.push({
            x: origin.x + Math.round(Math.cos(angle + turn) * distance),
            z: origin.z + Math.round(Math.sin(angle + turn) * distance),
          })
        }
      }

      const safe = []
      const seen = new Set()
      for (const target of candidates) {
        if (Math.hypot(target.x - origin.x, target.z - origin.z) < 3 ||
            (threats.length && closestDistance(target) < closestDistance(origin) + 1)) continue
        for (const dy of [0, 1, -1, 2, -2]) {
          const feet = new Vec3(target.x, origin.y + dy, target.z)
          if (seen.has(feet.toString()) || !dryFooting(connection, feet) ||
              connection.blockAt(feet.offset(0, -1, 0))?.boundingBox !== 'block' ||
              !EMPTY_BLOCK.test(connection.blockAt(feet)?.name) ||
              !EMPTY_BLOCK.test(connection.blockAt(feet.offset(0, 1, 0))?.name)) continue
          seen.add(feet.toString())
          safe.push(feet)
          break
        }
      }
      safe.sort((a, b) => Math.abs(a.distanceTo(origin) - 6) - Math.abs(b.distanceTo(origin) - 6) ||
        closestDistance(b) - closestDistance(a))

      const walking = new Movements(connection, runtimeState.mcData)
      walking.canDig = false
      walking.allow1by1towers = false
      walking.allowParkour = false
      walking.scafoldingBlocks = []
      walking.maxDropDown = 3
      walking.infiniteLiquidDropdownDistance = false
      avoidWetCorners(walking, connection)
      avoidWetSteps(walking, connection)
      let deadline = performance.now() + 230
      for (const target of safe.slice(0, 14)) {
        if (performance.now() >= deadline) break
        if (runtimeState.bot !== connection || connection.health <= 0 || features.waterOwnsMovement()) break
        if ((pursuit.failed.get(target.toString()) || 0) > Date.now()) continue
        const goal = new goals.GoalBlock(target.x, target.y, target.z)
        const search = connection.pathfinder.getPathFromTo(walking, connection.entity.position, goal, {
          timeout: 30, tickTimeout: 18, searchRadius: 18, optimizePath: false,
        })
        let preview
        try {
          preview = search.next().value?.result
        } finally {
          search.return()
        }
        if (preview?.status !== 'success' || !preview.path.length || pathHazard(connection, preview.path)) continue
        if (runtimeState.impactGuards.has(connection)) break
        const previous = connection.pathfinder.movements
        connection.pathfinder.setMovements(walking)
        runtimeState.navigationState = { target, waypoints: preview.path, label: 'flee' }
        features.log('fleeing', { target, threat: features.entityNameOf(threat) || null, reason: modelDecision?.reason || '' })
        try {
          if (await gotoRetreatWaypoint(connection, goal, target, onAdvance)) return true
          pursuit.goals += 1
          pursuit.updated = Date.now()
          features.log('retreat waypoint reached', { target, position: connection.entity.position.floored() })
          return true
        } catch (error) {
          features.log('retreat route interrupted', { target, message: error.message })
          pursuit.failed.set(target.toString(), Date.now() + 10000)
          if (connection.entity?.position.distanceTo(origin.offset(0.5, 0, 0.5)) > 1.5) return true
          deadline = performance.now() + 130
        } finally {
          if (connection.pathfinder.movements === walking) connection.pathfinder.setMovements(previous)
        }
      }
      return false
  }

  async function gotoRetreatWaypoint(connection, goal, target, onAdvance) {
    let lastPosition = connection.entity.position.clone()
    let lastProgress = Date.now()
    let pausedForShot = false
    const watch = setInterval(() => {
      if (connection !== runtimeState.bot || connection.pathfinder.goal !== goal || !connection.entity) return
      if (connection.entity.position.distanceTo(lastPosition) >= 0.35) {
        lastPosition = connection.entity.position.clone()
        lastProgress = Date.now()
        if (onAdvance?.()) {
          pausedForShot = true
          connection.pathfinder.setGoal(null)
        }
      } else if (Date.now() - lastProgress >= 950) {
        features.log('retreat route stalled; changing direction', { target })
        connection.pathfinder.setGoal(null)
      }
    }, 125)
    try {
      await features.gotoWithTimeout(goal, 'flee', 4200, {
        allowClutch: false,
        validateRoute: (path, options) => pathHazard(connection, path, options),
      })
    } catch (error) {
      if (!pausedForShot) throw error
    } finally {
      clearInterval(watch)
    }
    return pausedForShot
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
    const connection = runtimeState.bot
    const candidates = nearbyThreatSignature().threats
      .map(({ id }) => connection.entities[id])
      .filter(entity => entity && hostileSight(entity).visible)
    const danger = candidates.find(entity => mustAvoidMelee(entity) && entity.position.distanceTo(connection.entity.position) < 8 &&
      !features.canUseCombatBow(connection, entity))
    if (danger) return executeFlee(danger)
    const target = candidates.find(entity => (!mustAvoidMelee(entity) || features.canUseCombatBow(connection, entity)) &&
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
    if ((mustAvoidMelee(target) && !features.canUseCombatBow(runtimeState.bot, target)) || runtimeState.bot.health <= minHealth) {
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
    return String(entity.username || entity.name || entity.displayName || '').toLowerCase().replaceAll(' ', '_')
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
      if (response && !features.waterOwnsMovement() && !runtimeState.emergencyRetreating && !runtimeState.fleeingActive && !runtimeState.meleeConnection) {
        features.pauseCombatTask(runtimeState.bot)
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
module.exports.meleeExchange = meleeExchange
module.exports.jumpAttackStep = jumpAttackStep
module.exports.opponentMissedSwing = opponentMissedSwing
module.exports.hasRaisedShield = hasRaisedShield
