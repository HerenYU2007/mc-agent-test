function createCombatInterruption(state, features) {
  const paused = new WeakMap()
  const observed = new WeakSet()

  function pauseCombatTask(connection) {
    if (!connection?.entity || connection !== state.bot || paused.has(connection) ||
        state.fleeingActive || state.meleeConnection === connection || state.impactGuards.has(connection)) return
    const digging = state.mineMode || state.mineBusy
    const navigation = state.navigationState
    const goal = connection.pathfinder?.goal
    if (!digging && !state.activeGoal && !goal) return
    const saved = {
      dimension: connection.game?.dimension, time: Date.now(), goal, navigation,
      movements: connection.pathfinder?.movements, active: state.activeGoal,
      mining: digging && Boolean(state.currentMineOrder),
      order: state.currentMineOrder, target: state.committedMineTarget, names: state.mineTargetNames,
    }
    paused.set(connection, saved)
    if (digging) features.interruptMiningForCombat(connection)
    if (!observed.has(connection)) {
      observed.add(connection)
      connection.on('death', () => paused.delete(connection))
      connection.once('end', () => paused.delete(connection))
    }
    features.log('combat task paused', { goal: navigation?.target ?? null, mine: saved.mining ? saved.order.target : null,
      task: saved.active?.type ?? navigation?.label })
  }

  async function resumeCombatTask() {
    const connection = state.bot
    const saved = paused.get(connection)
    if (!saved || state.fleeingActive || state.emergencyRetreating || Date.now() < state.retreatUntil || features.closeCombatPlan()) return false
    if (connection.game?.dimension !== saved.dimension || connection.health <= 0 || Date.now() - saved.time > 120000) {
      paused.delete(connection)
      return false
    }
    if (saved.active && saved.time - saved.active.startedAt <= (saved.active.timeoutMs || 90000)) {
      state.activeGoal = { ...saved.active, startedAt: saved.active.startedAt + Date.now() - saved.time }
    }
    if (saved.mining && connection.inventory.items().some(item => item.name.endsWith('_pickaxe'))) {
      state.currentMineOrder = saved.order
      state.mineTargetNames = saved.names
      state.committedMineTarget = saved.target
      state.mineMode = true
      state.lastCombatDecision = null
      paused.delete(connection)
      features.log('combat task restored', { task: 'mine', target: saved.target?.position ?? saved.order.target })
      return true
    }
    if (!saved.goal || saved.goal.isEnd(connection.entity.position.floored())) {
      paused.delete(connection)
      if (state.activeGoal) features.log('combat task restored', { task: state.activeGoal.type })
      return false
    }
    state.busy = true
    state.lastDecision = 'combat-resume'
    state.lastCombatDecision = { action: 'combat-resume', reason: '当前威胁已解除，返回战斗前的原路点' }
    state.navigationState = { ...saved.navigation, waypoints: [] }
    const initialMovements = connection.pathfinder.movements
    try {
      if (saved.movements !== initialMovements && saved.movements) connection.pathfinder.setMovements(saved.movements)
      features.log('combat route restoring', { target: saved.navigation?.target })
      await features.gotoWithTimeout(saved.goal, saved.navigation?.label || 'combat resume waypoint', 18000)
      paused.delete(connection)
      state.lastCombatDecision = null
      features.log('combat task restored', { task: saved.active?.type ?? 'navigation', target: saved.navigation?.target })
    } catch (error) {
      const threatened = features.closeCombatPlan() || state.impactGuards.has(connection) || state.fleeingActive
      if (!threatened) paused.delete(connection)
      features.log('combat route resume interrupted', { message: error.message, retry: Boolean(threatened) })
    } finally {
      if (connection === state.bot && saved.movements !== initialMovements && initialMovements) {
        connection.pathfinder.setMovements(initialMovements)
      }
      state.busy = false
      if (state.urgentThreatQueued) {
        state.urgentThreatQueued = false
        setImmediate(() => void features.decideAndAct('urgent-combat-resume'))
      }
    }
    return true
  }

  return { pauseCombatTask, resumeCombatTask }
}

module.exports = createCombatInterruption
