const { goals } = require('mineflayer-pathfinder')
const { THREAT_RADIUS, STONE_DROPS, LOG_NAMES, WOOD_TARGET } = require('./config')

function createScheduler(runtimeState, features) {
  async function actOnEncounter(encounter, model = null) {
    const { action, target, reason, defensive } = encounter
    features.pauseCombatTask(runtimeState.bot)
    runtimeState.activeGoal = null
    runtimeState.mineMode = false
    runtimeState.lastCombatDecision = { action, reason, defensive: Boolean(defensive),
      target: features.hostileName(target), modelAction: model?.action ?? null }
    features.log('combat policy decision', runtimeState.lastCombatDecision)
    if (action === 'attack') await features.executeAttack(target, runtimeState.lastCombatDecision)
    else await features.executeFlee(target, { ...model, reason })
  }

  async function decideAndAct(trigger = 'scheduled') {
    if (!runtimeState.botEnabled || !runtimeState.bot?.entity || runtimeState.bot.health <= 0 ||
        features.waterOwnsMovement() || features.isWaterClutchActive()) return
    if (runtimeState.bot && runtimeState.impactGuards.has(runtimeState.bot)) return
    if (runtimeState.emergencyRetreating || runtimeState.fleeingActive) {
      if (trigger.startsWith('urgent')) runtimeState.urgentThreatQueued = true
      return
    }
    const immediate = !runtimeState.emergencyShelteredUntil && !runtimeState.shelteredUntilDawn ? features.closeCombatPlan() : null
    if (immediate) {
      features.pauseCombatTask(runtimeState.bot)
      runtimeState.supplyStation.interrupt(features.log, 'combat')
    }
    else if (features.foodRecoveryNeeded()) runtimeState.supplyStation.interrupt(features.log, 'food')
    if (immediate?.action === 'flee' && !runtimeState.busy && !runtimeState.mineBusy && !runtimeState.isEating && !runtimeState.isSmelting && !runtimeState.isDiggingBlock) {
      await actOnEncounter(immediate)
      return
    }
    if (immediate) {
      runtimeState.activeGoal = null
      runtimeState.mineMode = false
    } else if (!runtimeState.emergencyShelteredUntil && Date.now() < runtimeState.retreatUntil) {
      runtimeState.lastDecision = 'flee'
      if (!runtimeState.busy && !runtimeState.mineBusy && !runtimeState.isEating && runtimeState.bot.health < 12 && features.safeToEatOnRetreat(runtimeState.bot)) {
        runtimeState.busy = true
        try { await features.restAfterRetreat(runtimeState.bot) } finally { runtimeState.busy = false }
      }
      return
    }

    if (!immediate && runtimeState.bot.game?.dimension === 'overworld' && runtimeState.supplyBase.qualification().needsResupply &&
        !runtimeState.emergencyShelteredUntil && !runtimeState.shelteredUntilDawn &&
        !features.deathRecoveryDue()) {
      if (runtimeState.busy || runtimeState.mineBusy || runtimeState.isEating || runtimeState.isSmelting || runtimeState.isDiggingBlock || runtimeState.shelterBusy) return
      runtimeState.mineMode = false
      runtimeState.activeGoal = null
      runtimeState.busy = true
      try { await features.surfaceResupply() } catch (error) {
        features.log('surface resupply interrupted', { message: error.message })
      } finally { runtimeState.busy = false }
      return
    }

    if (!immediate && !runtimeState.emergencyShelteredUntil && !runtimeState.shelteredUntilDawn &&
        !runtimeState.supplyBase.expeditionActive(runtimeState.bot) && features.foodRecoveryNeeded()) {
      if (runtimeState.busy || runtimeState.mineBusy || runtimeState.isEating || runtimeState.isSmelting || runtimeState.isDiggingBlock || runtimeState.shelterBusy || Date.now() < runtimeState.nextFoodSearchAt) return
      const connection = runtimeState.bot
      const resumeMining = runtimeState.mineMode
      runtimeState.busy = true
      try {
        await features.recoverFoodSupply()
      } catch (error) {
        features.log('food recovery route interrupted', { message: error.message })
      } finally {
        runtimeState.busy = false
        runtimeState.nextFoodSearchAt = Date.now() + 1800
        if (runtimeState.bot === connection && resumeMining && runtimeState.bot.health > 0 && !runtimeState.emergencyRetreating && !runtimeState.fleeingActive &&
            Date.now() >= runtimeState.retreatUntil && !features.closeCombatPlan()) runtimeState.mineMode = true
      }
      return
    }

    // Defer non-urgent decisions if actively breaking a block so digging is never cancelled
    if ((runtimeState.isDiggingBlock || runtimeState.bot.targetDigBlock) && !trigger.startsWith('urgent')) {
      features.log('decision deferred; bot is actively digging block', {
        block: runtimeState.bot.targetDigBlock?.name || runtimeState.currentMineTarget?.name,
        trigger,
      })
      return
    }

    // Defer non-urgent decisions if actively smelting in furnace
    if (runtimeState.isSmelting && !trigger.startsWith('urgent')) {
      features.log('decision deferred; bot is actively smelting in furnace', { trigger })
      return
    }

    // Defer non-urgent decisions if actively eating
    if (runtimeState.isEating && !trigger.startsWith('urgent')) {
      features.log('decision deferred; bot is actively eating food', { trigger })
      return
    }
    if (!immediate && !runtimeState.busy && !runtimeState.mineBusy && !runtimeState.isEating && !runtimeState.isSmelting &&
        !runtimeState.isDiggingBlock && !runtimeState.emergencyShelteredUntil && !runtimeState.shelteredUntilDawn &&
        !features.deathRecoveryDue() && await features.resumeCombatTask()) return

    // Defer non-urgent decisions if in active mineMode with working tools
    if (runtimeState.mineMode && !runtimeState.busy && !runtimeState.mineBusy) features.finishMineObjective()
    if (!immediate && !runtimeState.supplyBase.active(runtimeState.bot) && !runtimeState.busy && !runtimeState.mineBusy && !runtimeState.isSmelting && !runtimeState.isEating && !runtimeState.isDiggingBlock &&
        !runtimeState.bot?.targetDigBlock && !features.deathRecoveryDue() && !runtimeState.shelteredUntilDawn && !runtimeState.emergencyShelteredUntil &&
        Date.now() >= runtimeState.nextGearCraftRetryAt && features.canWorkHere(runtimeState.bot)) {
      if (features.readyGearUpgrades().length) {
        runtimeState.busy = true
        const resumeMining = runtimeState.mineMode
        runtimeState.mineMode = false
        runtimeState.lastDecision = 'gear-up'
        try {
          if (await features.craftAvailableGear()) return
        } finally {
          if (resumeMining && runtimeState.bot?.health > 0 && !runtimeState.emergencyRetreating && !runtimeState.fleeingActive && Date.now() >= runtimeState.retreatUntil) runtimeState.mineMode = true
          runtimeState.nextGearCraftRetryAt = Date.now() + 5000
          try { await features.reclaimTemporaryCraftingTable() } finally { runtimeState.busy = false }
        }
      }
    }
    if (runtimeState.mineMode && !immediate) {
      const hasPickaxe = runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
      if (hasPickaxe) {
        features.log('decision deferred; mineMode active and operating', { trigger })
        return
      }
    }
    if (!runtimeState.busy && !runtimeState.mineBusy && (runtimeState.supplyBase.active(runtimeState.bot) ||
        (features.needsPostArmorDiamonds(runtimeState.bot) && features.hasDiamondMiningTool(runtimeState.bot)))) runtimeState.activeGoal = null

    // TASK COMMITMENT PROTECTION:
    // If we have an active ongoing goal, do NOT let scheduled ticks re-query DeepSeek or thrash actions!
    if (runtimeState.activeGoal && (trigger === 'scheduled' || trigger === 'periodic') && !trigger.startsWith('urgent')) {
      const currentSnap = features.snapshot()
      const isCompleted = runtimeState.activeGoal.isComplete ? runtimeState.activeGoal.isComplete(currentSnap) : false
      const isExpired = Date.now() - runtimeState.activeGoal.startedAt > (runtimeState.activeGoal.timeoutMs || 90000)
      if (!isCompleted && !isExpired) {
        features.log('maintaining active task commitment; skipping re-decision', {
          goal: runtimeState.activeGoal.type,
          target: runtimeState.activeGoal.targetName,
          elapsedSeconds: Math.round((Date.now() - runtimeState.activeGoal.startedAt) / 1000),
        })
        if (runtimeState.activeGoal.type === 'mine') {
          if (runtimeState.mineNeedsNewGround && !runtimeState.busy) {
            runtimeState.busy = true
            try {
              runtimeState.mineNeedsNewGround = false
              await features.exploreOneStep()
            } catch (error) {
              features.log('mine scouting path interrupted', { message: error.message })
            } finally {
              runtimeState.busy = false
            }
          }
          runtimeState.mineMode = true
          return
        }
        if (runtimeState.activeGoal.type === 'collect_wood') {
          if (!runtimeState.busy) {
            runtimeState.busy = true
            try {
              await features.collectWoodWithPlan()
            } finally { runtimeState.busy = false }
          }
          return
        }
        if (runtimeState.activeGoal.type === 'hunt_food') {
          if (!runtimeState.busy) {
            runtimeState.busy = true
            try {
              await features.huntNearbyAnimalsOrForage()
            } finally { runtimeState.busy = false }
          }
          return
        }
        if (runtimeState.activeGoal.type === 'gear_up') {
          if (!runtimeState.busy) {
            runtimeState.busy = true
            try {
              await features.prepareStarterGear()
            } finally { runtimeState.busy = false }
          }
          return
        }
      } else if (isCompleted) {
        features.log('active task completed successfully', { goal: runtimeState.activeGoal.type })
        runtimeState.activeGoal = null
      } else {
        features.log('active task expired or stalled; clearing commitment', { goal: runtimeState.activeGoal.type })
        runtimeState.activeGoal = null
      }
    }

    if (runtimeState.busy || runtimeState.mineBusy || !runtimeState.bot || !runtimeState.bot.entity || !runtimeState.movements) {
      if ((runtimeState.busy || runtimeState.mineBusy) && trigger.startsWith('urgent')) runtimeState.urgentThreatQueued = true
      return
    }
    runtimeState.busy = true
    runtimeState.cycle += 1
    try {
      if (immediate) {
        await actOnEncounter(immediate)
        return
      }
      if (!immediate && !runtimeState.emergencyShelteredUntil && !runtimeState.shelteredUntilDawn && await features.leaveSpawnCanopy()) return
      await features.eatFoodIfNeeded()
      if (runtimeState.emergencyShelteredUntil) {
        if (Date.now() < runtimeState.emergencyShelteredUntil || features.findNearestHostile(9)) {
          runtimeState.lastDecision = 'emergency-shelter'
          return
        }
        runtimeState.emergencyShelteredUntil = 0
        await features.breakShelter()
        if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0) return
      }
      let state = features.snapshot()
      runtimeState.latestState = state
      features.log('state', state)

      if (!immediate && runtimeState.deathPoint && !runtimeState.deathPoint.done && !runtimeState.shelteredUntilDawn) {
        if (await features.recoverDeathDrops()) return
        if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0 || features.waterOwnsMovement()) return
      }

      const furnaceToRecover = runtimeState.pendingFurnaceBatch || runtimeState.temporaryFurnace
      if (!runtimeState.shelteredUntilDawn && runtimeState.pendingIronWorkshop?.dimension === runtimeState.bot.game.dimension && !features.furnaceThreat()) {
        runtimeState.lastDecision = 'furnace-recovery'
        runtimeState.isSmelting = true
        try { await features.recoverIronWorkshop(runtimeState.bot, true) } finally { runtimeState.isSmelting = false }
        if (!features.closeCombatPlan() && runtimeState.pendingIronWorkshop) return
      }
      if (!runtimeState.shelteredUntilDawn && furnaceToRecover?.dimension === runtimeState.bot.game.dimension && !features.furnaceThreat()) {
        runtimeState.lastDecision = 'furnace-recovery'
        runtimeState.isSmelting = true
        try {
          await features.finishFurnaceWork(runtimeState.bot, null, true)
        } finally {
          runtimeState.isSmelting = false
        }
        return
      }

      // First night, or unarmed at night: follow the route (bed, else a 3-deep pit)
      // and wait for daylight. Running about at night unarmed is how it kept dying.
      const duskNow = features.isNightShelterTime(state.timeOfDay)
      if (!duskNow) runtimeState.shelterAttemptedTonight = false
      const needsShelter = duskNow && !runtimeState.supplyBase.active(runtimeState.bot) &&
        !runtimeState.shelteredUntilDawn && !runtimeState.shelterAttemptedTonight &&
        state.nightShelterTerrain === 'open' && (runtimeState.nightsSheltered < 1 || !state.hasSword)
      if (needsShelter && !(state.hasSword && features.findNearestHostile(8))) {
        runtimeState.supplyStation.interrupt(features.log, 'night shelter')
        if (runtimeState.supplyStation.pending && runtimeState.supplyStation.protects(runtimeState.bot, runtimeState.bot.entity.position.floored().offset(0, -1, 0))) {
          const { entry } = runtimeState.supplyStation.site
          try {
            await features.gotoWithTimeout(new goals.GoalBlock(entry.x, entry.y, entry.z), 'leave construction for shelter', 6500)
          } catch {
            return
          }
          if (!runtimeState.bot?.entity || features.waterOwnsMovement() || features.closeCombatPlan()) return
        }
        runtimeState.shelterAttemptedTonight = true
        if (await features.firstNightShelter()) {
          runtimeState.shelteredUntilDawn = true
          runtimeState.lastDecision = 'night-shelter'
          return
        }
        if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0 || features.waterOwnsMovement()) return
        state = features.snapshot()
      }
      if (runtimeState.shelteredUntilDawn) {
        if (features.isNightShelterTime(state.timeOfDay)) {
          runtimeState.lastDecision = 'night-shelter'
          features.log('sheltering until dawn', { timeOfDay: state.timeOfDay })
          return
        }
        runtimeState.shelteredUntilDawn = false
        await features.breakShelter()
        if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0 || features.waterOwnsMovement()) return
        state = features.snapshot()
      }

      await features.clearBackpack(runtimeState.bot, 'routine')
      if (!runtimeState.bot?.entity || runtimeState.bot.health <= 0) return
      await features.autoEquipArmor()
      if (!immediate && await features.tryFillTravelBucket(runtimeState.bot)) return
      if (!immediate && !features.closeCombatPlan() && runtimeState.supplyStation.pending) {
        await features.buildSupplyStation()
        return
      }
      if (!immediate && !features.closeCombatPlan() && features.needsPostArmorDiamonds(runtimeState.bot) && features.hasDiamondMiningTool(runtimeState.bot)) {
        await features.minePostArmorDiamonds()
        return
      }
      const stage = features.computeStage(state)
      state.stage = stage.name
      state.stageHint = stage.hint
      if (stage.name === 'supply_base' && !features.closeCombatPlan() && features.canWorkHere(runtimeState.bot)) {
        runtimeState.lastDecision = 'supply-base'
        await runtimeState.supplyBase.run(runtimeState.bot)
        const expedition = runtimeState.supplyBase.status().expedition
        if (expedition?.phase === 'visiting') runtimeState.lastDecision = expedition.villageAction || 'observe_village'
        else if (expedition?.phase === 'searching' || expedition?.phase === 'returning') runtimeState.lastDecision = `expedition-${expedition.phase}`
        return
      }
      const upgrade = features.nextIronUpgrade()
      const ironReady = state.rawIron > 0 && state.coal + state.charcoal > 0 &&
        (!upgrade || state.rawIron + features.inventoryItemCount('iron_ingot') >= upgrade.cost)
      if (!features.closeCombatPlan() && (ironReady || (trigger === 'mine-complete' && stage.name === 'get_stone' && stage.action === 'gear_up'))) {
        runtimeState.lastDecision = 'gear-up'
        if (await features.prepareStarterGear()) return
      }
      await features.maybePlaceTorch()
      let modelDecision = await features.askDeepSeek({ ...state, previousExperience: runtimeState.lastExperience }, trigger)
      const requestedMineTarget = modelDecision?.action === 'mine' ? modelDecision.target_name || '(未填写)' : null
      if (!runtimeState.bot?.entity || features.waterOwnsMovement() || runtimeState.emergencyRetreating || runtimeState.fleeingActive ||
          runtimeState.impactGuards.has(runtimeState.bot) || runtimeState.bot.health <= 0) return
      const encounter = features.closeCombatPlan()
      if (encounter) {
        await actOnEncounter(encounter, modelDecision)
        return
      }
      if (Date.now() < runtimeState.retreatUntil) return
      if (!runtimeState.shelteredUntilDawn && features.foodRecoveryNeeded()) return
      runtimeState.lastCombatDecision = null
      // Keep the model on the route: threats are handled before this point, so
      // here it may only pick actions the stage allows, otherwise the script's
      // own action for the stage is used.
      if (modelDecision && stage.allowed && stage.action && !stage.allowed.has(modelDecision.action) &&
          !['attack', 'flee'].includes(modelDecision.action)) {
        features.log('stage override', { stage: stage.name, modelAction: modelDecision.action, forced: stage.action })
        modelDecision = { ...modelDecision, action: stage.action, target_name: stage.targetName || modelDecision.target_name }
      } else if (modelDecision && stage.name === 'get_stone' && modelDecision.action === 'mine' && !modelDecision.target_name) {
        modelDecision = { ...modelDecision, target_name: 'stone' }
      } else if (modelDecision && stage.name === 'find_coal' && modelDecision.action === 'mine' && !modelDecision.target_name) {
        modelDecision = { ...modelDecision, target_name: 'coal' }
      } else if (modelDecision && stage.name === 'find_iron' && modelDecision.action === 'mine') {
        if (!modelDecision.target_name || modelDecision.target_name.includes('copper')) {
          modelDecision = { ...modelDecision, target_name: 'iron' }
        }
      }
      if (modelDecision?.action === 'mine' && modelDecision.target_name?.includes('copper')) {
        modelDecision = { ...modelDecision, target_name: 'iron' }
      }
      if (modelDecision?.action === 'mine' && !modelDecision.target_name) {
        modelDecision = { ...modelDecision, target_name: stage.targetName || (state.hasIronPickaxe ? 'diamond' : 'iron') }
      }
      runtimeState.latestState = { ...state, modelDecision }

      if (modelDecision) {
        const requestedAction = modelDecision.action
        const nearestThreat = features.findNearestHostile(THREAT_RADIUS)
        const selectedThreat = features.findNearestHostile(THREAT_RADIUS, modelDecision.target_name) || nearestThreat
        const threatDistance = nearestThreat ? nearestThreat.position.distanceTo(runtimeState.bot.entity.position) : Infinity
        const threatName = features.entityNameOf(nearestThreat)
        const forcedFlee = nearestThreat && ((threatName === 'creeper' && threatDistance < 6) || runtimeState.bot.health < 5 || runtimeState.bot.food < 4)

        if (forcedFlee && requestedAction !== 'flee') {
          runtimeState.mineMode = false
          features.log('safety override', { modelAction: requestedAction, forcedAction: 'flee', threat: threatName, distance: Number(threatDistance.toFixed(1)) })
          await features.executeFlee(nearestThreat, modelDecision)
          return
        }

        if (requestedAction !== 'mine') runtimeState.mineMode = false

        if (state.night && !state.hasPickaxe && !nearestThreat && requestedAction === 'explore') {
          features.log('night gear override', { modelAction: requestedAction, forcedAction: 'gear_up' })
          await features.prepareStarterGear()
          if (!state.hasPickaxe) await features.mineForGear(modelDecision.target, modelDecision.target_name)
          return
        }

        if (requestedAction === 'attack') {
          const selectedDistance = selectedThreat ? selectedThreat.position.distanceTo(runtimeState.bot.entity.position) : Infinity
          const rangedOnly = state.night && selectedDistance > 8
          if (selectedThreat && rangedOnly && !features.canUseCombatBow(runtimeState.bot, selectedThreat)) {
            // Do not chase distant mobs at night; keep building gear and fight only what closes in.
            features.log('night attack override; not chasing distant hostile', { threat: features.entityNameOf(selectedThreat), distance: Number(selectedDistance.toFixed(1)) })
            features.persistExperience({ cycle: runtimeState.cycle, action: 'attack-skip', experience: '夜间不追击8格外的敌对生物，继续补装备，等它靠近再近战' })
            if (!state.hasPickaxe) { await features.prepareStarterGear(); if (state.logs < WOOD_TARGET) await features.collectWoodWithPlan(modelDecision.target) }
            else await features.mineForGear(modelDecision.target, modelDecision.target_name)
            return
          }
          if (selectedThreat) {
            await features.executeAttack(selectedThreat, { ...modelDecision, rangedOnly })
            return
          }
          features.log('model requested attack but no live target was available')
        } else if (requestedAction === 'flee') {
          if (nearestThreat && threatDistance <= features.threatRange(threatName) && features.mustAvoidMelee(nearestThreat) &&
              features.hostileSight(nearestThreat).visible) {
            await features.executeFlee(nearestThreat, modelDecision)
            return
          }
          features.log('model retreat skipped; no immediate danger')
        } else if (requestedAction === 'hunt_food') {
          runtimeState.lastDecision = 'hunt-food'
          features.log('decision', { action: runtimeState.lastDecision, reason: modelDecision.reason })
          runtimeState.activeGoal = {
            type: 'hunt_food',
            startedAt: Date.now(),
            isComplete: (s) => (s.food || 0) >= 18 || features.getEdibleFoods().length >= 4,
            timeoutMs: 60000,
          }
          await features.huntNearbyAnimalsOrForage()
          return
        } else if (requestedAction === 'collect_wood') {
          const isUnderground = state.underground || state.mining_underground || (runtimeState.bot.entity.position.y < 55)
          if (isUnderground) {
            const hasAnyPick = runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
            const canCraftPick = (features.inventoryCount(STONE_DROPS) >= 3 || features.inventoryItemCount('iron_ingot') >= 3) &&
              (features.inventoryItemCount('stick') >= 2 || features.plankCount() >= 1 || features.inventoryCount(LOG_NAMES) >= 1)
            if (hasAnyPick || canCraftPick) {
              await features.prepareStarterGear()
              if (runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) {
                await features.mineForGear(null, 'iron')
                return
              }
            }
            features.log('no pickaxe and no wood underground; navigating to surface for trees', { y: Math.round(runtimeState.bot.entity.position.y) })
            await features.gotoWithTimeout(new goals.GoalY(68), 'surface for wood', 15000).catch(() => {})
            return
          }
          if (state.logs >= WOOD_TARGET) {
            features.log('wood reserve reached; redirecting to gear or exploration', { logs: state.logs })
            await features.collectNearbyDrops(16)
            await features.prepareStarterGear()
            if (state.night && !state.hasPickaxe) await features.mineForGear()
            else await features.exploreOneStep(modelDecision.target)
            return
          }
          runtimeState.activeGoal = {
            type: 'collect_wood',
            startedAt: Date.now(),
            isComplete: (s) => (s.logs + Math.floor(s.planks / 4)) >= WOOD_TARGET,
            timeoutMs: 90000,
          }
          runtimeState.lastDecision = 'collect-wood'
          features.log('decision', { action: runtimeState.lastDecision, reason: modelDecision.reason })
          await features.collectWoodWithPlan(modelDecision.target)
          return
        } else if (requestedAction === 'gear_up') {
          runtimeState.lastDecision = 'gear-up'
          features.log('decision', { action: runtimeState.lastDecision, reason: modelDecision.reason })
          runtimeState.activeGoal = {
            type: 'gear_up',
            startedAt: Date.now(),
            isComplete: (s) => s.hasPickaxe && s.hasSword,
            timeoutMs: 60000,
          }
          await features.collectNearbyDrops(12)
          const prepared = await features.prepareStarterGear()
          const hasAnyPickaxe = runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
          if (!prepared && hasAnyPickaxe) await features.mineForGear(modelDecision.target, modelDecision.target_name)
          return
        } else if (requestedAction === 'mine') {
          const hasPickaxe = runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
          if (!hasPickaxe) {
            runtimeState.mineMode = false
            runtimeState.lastDecision = 'gear-up'
            features.log('mine blocked; pickaxe required', { modelReason: modelDecision.reason })
            const prepared = await features.prepareStarterGear()
            const afterPrepare = runtimeState.bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
            if (!afterPrepare) {
              features.persistExperience({ cycle: runtimeState.cycle, action: 'gear-up', experience: '模型要求挖矿但没有镐，先阻止挖矿并继续完成工具制作' })
              if (state.logs < WOOD_TARGET) await features.collectWoodWithPlan(modelDecision.target)
            }
            return
          }
          runtimeState.activeGoal = { type: 'mine', targetName: modelDecision.target_name, startedAt: Date.now(), timeoutMs: 120000 }
          runtimeState.lastDecision = 'mine'
          features.log('decision', { action: runtimeState.lastDecision, reason: modelDecision.reason })
          await features.collectNearbyDrops(12)
          if (stage.name !== 'find_coal') await features.prepareStarterGear()
          if (!runtimeState.pendingIronWorkshop && !runtimeState.pendingFurnaceBatch && !runtimeState.temporaryFurnace) {
            await features.mineForGear(modelDecision.target, modelDecision.target_name, requestedMineTarget)
            if (!runtimeState.mineMode) runtimeState.activeGoal = null
          }
          return
        } else if (requestedAction === 'build_camp') {
          runtimeState.lastDecision = 'build-camp'
          features.log('decision', { action: runtimeState.lastDecision, reason: modelDecision.reason })
          runtimeState.supplyStation.requested = true
          await features.buildSupplyStation()
          return
        } else if (requestedAction === 'inspect_stone') {
          const stone = features.findNearestBlock(new Set(['stone', 'deepslate']), 24)
          if (!stone) {
            features.log('model requested stone inspection but no stone was visible')
            await features.exploreOneStep(modelDecision.target)
            return
          }
          const goal = new goals.GoalNear(stone.position.x, stone.position.y, stone.position.z, 3)
          if (goal.isEnd(runtimeState.bot.entity.position.floored())) {
            runtimeState.lastDecision = 'explore'
            features.log('stone already within inspection range; exploring', { position: stone.position })
            await features.exploreOneStep()
            return
          }
          runtimeState.lastDecision = 'inspect-stone'
          features.log('decision', { action: runtimeState.lastDecision, block: stone.name, reason: modelDecision.reason })
          await features.gotoWithTimeout(goal, 'stone target', 7000)
          return
        } else if (requestedAction === 'explore') {
          if (stage.name === 'gather_wood') {
            runtimeState.lastDecision = 'collect-wood'
            await features.collectWoodWithPlan(modelDecision.target)
            return
          }
          if (!nearestThreat && await features.advanceSurvivalGear()) return
          runtimeState.lastDecision = 'explore'
          features.log('decision', { action: runtimeState.lastDecision, target: modelDecision.target, reason: modelDecision.reason })
          await features.exploreOneStep(modelDecision.target)
          return
        }
      }

      // Deterministic fallback is used only when the model is unavailable or
      // returns an unusable action.
      if (await features.handleScriptFallbackThreat()) return
      runtimeState.mineMode = false
      if ((state.logs >= 3 || state.planks >= 5 || state.hasPickaxe) && await features.advanceSurvivalGear()) return
      if (state.logs < WOOD_TARGET && !(state.hasPickaxe && state.hasSword)) {
        runtimeState.lastDecision = 'collect-wood'
        features.log('decision', { action: runtimeState.lastDecision, fallback: true })
        await features.collectWoodWithPlan()
        return
      }
      runtimeState.lastDecision = 'explore'
      features.log('decision', { action: runtimeState.lastDecision, fallback: true })
      await features.exploreOneStep()
    } catch (error) {
      features.log('action failed', { decision: runtimeState.lastDecision, message: error.message })
      features.persistExperience({ cycle: runtimeState.cycle, action: runtimeState.lastDecision, experience: `本轮行动失败：${error.message}` })
      features.stopPathfinder()
    } finally {
      runtimeState.busy = false
      if (runtimeState.urgentThreatQueued) {
        runtimeState.urgentThreatQueued = false
        setImmediate(() => void decideAndAct('urgent-queued'))
      }
    }
  }

  return {
    decideAndAct,
  }
}

module.exports = createScheduler
