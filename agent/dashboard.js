const http = require('node:http')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { createStructureRoutes } = require('./structure-survey')
const {
  VERSION, DASHBOARD_PORT, DEEPSEEK_API_KEY, DEEPSEEK_MODEL, LOG_NAMES, IRON_INPUT_NAMES,
} = require('./config')

function createDashboard(runtimeState, features) {
  let dashboardStarted = false
  const structureRoute = createStructureRoutes()

  function startDashboard() {
    if (dashboardStarted) return
    dashboardStarted = true
    const page = readFileSync(join(__dirname, 'dashboard.html'))
    const server = http.createServer((req, res) => {
      if (structureRoute(req, res)) return
      if (req.url === '/control' && req.method === 'POST') {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => {
          try {
            const action = JSON.parse(body).action
            if (action === 'stop') {
              runtimeState.botEnabled = false
              features.stopModelCalls()
              const oldBot = runtimeState.bot
              runtimeState.bot = null
              try { oldBot?.pathfinder?.stop() } catch {}
              try { oldBot?.pvp?.stop() } catch {}
              try { oldBot?.clearControlStates() } catch {}
              try { oldBot?.end('dashboard stop') } catch {}
              features.log('bot disconnected from dashboard')
            } else if (action === 'start') {
              runtimeState.botEnabled = true
              if (!runtimeState.bot) features.createBotConnection()
              else void features.decideAndAct('dashboard-start')
              features.log('bot reconnect requested from dashboard')
            } else if (action === 'enable-model') {
              if (!DEEPSEEK_API_KEY) throw new Error('未配置 DeepSeek 密钥')
              runtimeState.modelEnabled = true
              features.log('DeepSeek enabled from dashboard')
            } else if (action === 'disable-model') {
              features.stopModelCalls()
              features.log('DeepSeek disabled from dashboard')
            } else throw new Error('未知控制命令')
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: true, botEnabled: runtimeState.botEnabled, modelEnabled: runtimeState.modelEnabled }))
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: error.message }))
          }
        })
        return
      }
      if (req.url === '/observer' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(features.observerState()))
        return
      }
      if (req.url === '/state') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify({
          ...runtimeState.latestState,
          position: runtimeState.bot?.entity?.position.floored() ?? null,
          health: runtimeState.bot?.health ?? null,
          food: runtimeState.bot?.food ?? null,
          foodRecovery: runtimeState.recoveringFood,
          resupply: runtimeState.supplyBase.resupplyStatus(),
          supplyStation: runtimeState.supplyStation.status(),
          ...(runtimeState.bot?.entity ? {
            coal: features.inventoryItemCount('coal'),
            charcoal: features.inventoryItemCount('charcoal'),
            rawIron: features.inventoryCount(IRON_INPUT_NAMES),
            iron: features.inventoryCount(IRON_INPUT_NAMES) + features.inventoryItemCount('iron_ingot'),
            torches: features.inventoryItemCount('torch'),
            logs: features.inventoryCount(LOG_NAMES),
            planks: features.plankCount(),
            freeSlots: features.freeBackpackSlots(runtimeState.bot.inventory),
            hasPickaxe: features.hasTool('pickaxe'),
            hasIronPickaxe: runtimeState.bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)),
            hasSword: features.hasTool('sword'),
            hasShield: runtimeState.bot.inventory.slots.some(item => item?.name === 'shield'),
            armorPieces: features.equippedArmorCount(),
          } : {}),
          inWater: features.isActuallyInWater(),
          version: runtimeState.bot?.version || VERSION,
          botConnected: Boolean(runtimeState.bot?.entity),
          botEnabled: runtimeState.botEnabled,
          supplyBase: runtimeState.supplyBase.status(),
          navigation: features.visibleNavigationState(),
          deathPoint: runtimeState.deathPoint && !runtimeState.deathPoint.done
            ? { x: runtimeState.deathPoint.x, y: runtimeState.deathPoint.y, z: runtimeState.deathPoint.z, attempts: runtimeState.deathPoint.attempts, ageSeconds: Math.round((Date.now() - runtimeState.deathPoint.diedAt) / 1000) }
            : null,
          mine: {
            active: runtimeState.mineMode, busy: runtimeState.mineBusy, targets: [...runtimeState.mineTargetNames], blacklist: runtimeState.mineBlacklist.size, lastSearchAt: runtimeState.lastMineSearchAt,
            target: runtimeState.currentMineTarget, committed: runtimeState.committedMineTarget?.position ?? null, order: runtimeState.currentMineOrder, lastAudit: runtimeState.lastMineAudit,
          },
          decision: runtimeState.lastDecision,
          model: runtimeState.modelEnabled ? DEEPSEEK_MODEL : 'script-only',
          modelEnabled: runtimeState.modelEnabled,
          modelConfigured: Boolean(DEEPSEEK_API_KEY),
          modelUsage: runtimeState.modelUsage,
          lastModelDecision: runtimeState.lastModelDecision,
          lastCombatDecision: runtimeState.lastCombatDecision,
          shieldRaised: Boolean(runtimeState.bot && runtimeState.raisedShields.has(runtimeState.bot)),
          lastExperience: runtimeState.lastExperience,
          modelCalls: runtimeState.modelCalls,
          events: runtimeState.eventLog,
        }))
        return
      }
      if (req.url !== '/' || req.method !== 'GET') {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(page)
    })
    server.listen(DASHBOARD_PORT, '127.0.0.1', () => features.log('dashboard started', { url: `http://127.0.0.1:${DASHBOARD_PORT}` }))
  }

  return {
    startDashboard,
  }
}

module.exports = createDashboard
