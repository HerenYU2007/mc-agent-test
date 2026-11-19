const mineflayer = require('mineflayer')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const minecraftData = require('minecraft-data')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const collectBlock = require('mineflayer-collectblock').plugin
const toolPlugin = require('mineflayer-tool').plugin
const pvp = require('mineflayer-pvp').plugin
const mineflayerViewer = require('prismarine-viewer').mineflayer
const { Vec3 } = require('vec3')
const { SupplyStation } = require('./supply-station')
const { createSupplyBase } = require('./supply-base')

const VERSION = process.env.MC_VERSION || '26.3'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25565)
const USERNAME = process.env.MC_USERNAME || 'NMO-TestAgent'
const VIEWER_PORT = Number(process.env.MC_VIEWER_PORT || 3000)
const DASHBOARD_PORT = Number(process.env.MC_DASHBOARD_PORT || 3001)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions'
let modelEnabled = Boolean(DEEPSEEK_API_KEY) && process.env.DEEPSEEK_AUTO_START === '1'
const pendingModelCalls = new Set()
const EXPERIENCE_LOG_PATH = process.env.EXPERIENCE_LOG_PATH || path.join(__dirname, 'experience.jsonl')
const RUNTIME_LOG_PATH = process.env.RUNTIME_LOG_PATH || path.join(__dirname, 'runtime-events.jsonl')
const NORMAL_DECISION_INTERVAL_MS = 10000
const THREAT_RADIUS = 24
const STONE_DROPS = new Set(['cobblestone', 'cobbled_deepslate'])
const STONE_TARGETS = new Set(['stone', 'deepslate'])
const COAL_TARGETS = new Set(['coal_ore', 'deepslate_coal_ore'])
const COAL_DROPS = new Set(['coal'])
const RUBBLE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite',
  'granite', 'tuff', 'gravel', 'netherrack', 'smooth_basalt', 'calcite', 'blackstone', 'cobbled_blackstone'])
const SOIL = new Set(['dirt', 'coarse_dirt', 'rooted_dirt', 'sand', 'red_sand'])
const DEBRIS = new Set(['leaf_litter', 'short_grass', 'dead_bush'])
const INVENTORY_RESERVES = [[RUBBLE, 64], [SOIL, 32]]
const TOOL_TIER = { wooden: 0, golden: 0, stone: 1, copper: 2, iron: 3, diamond: 4, netherite: 5 }
const ARMOR_SLOTS = [['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]
const ARMOR_DEFENSE = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], copper: [2, 4, 3, 1],
  iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], turtle: [2, 0, 0, 0],
}
const discardedEntities = new WeakSet()
const discardPiles = new WeakMap()
const repickedDiscards = new WeakMap()
let inventoryFullNoticeAt = 0
let mineNeedsNewGround = false

let bot = null
let dashboardStarted = false

process.on('unhandledRejection', error => {
  const message = error?.message || String(error)
  if (message.includes('GoalChanged') || message.includes('goal was changed')) {
    console.error(`[agent ${new Date().toISOString()}] recovered path interruption: ${message}`)
    try { stopPathfinder() } catch {}
    return
  }
  console.error(`[agent ${new Date().toISOString()}] unhandled async error: ${message}`)
})

let mcData
let movements
let busy = false
let nextGearCraftRetryAt = 0
const FOOD_RECOVERY_START = 10
const FOOD_RECOVERY_END = 14
let recoveringFood = false
let nextFoodSearchAt = 0
let miningPausedForFood = false
const supplyStation = new SupplyStation(process.env.MC_SUPPLY_STATION_STATE,
  process.env.MC_BUILD_SUPPLY_STATION === '1', process.env.MC_BUILD_NBT)
const stationBlockedSteps = new Map()
let lastDecision = 'boot'
let cycle = 0
let latestState = null
const eventLog = []
let modelUsage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 }
let lastModelDecision = null
let lastExperience = ''
const modelCalls = []
let urgentThreatQueued = false
let lastThreatSignature = ''
let lastThreatDispatchAt = 0
let emergencyRetreating = false
let fleeingActive = false
let retreatUntil = 0
let lastCombatDecision = null
let lastCloseThreatSignature = ''
let botEnabled = process.env.MC_BOT_AUTOSTART !== '0'
let loopsStarted = false
let lastManualAttackAt = 0
let meleeConnection = null
const raisedShields = new WeakMap()
const impactGuards = new WeakSet()
const shieldSteps = new WeakSet()
const lastRangedGuard = new WeakMap()
const retreatPursuits = new WeakMap()
const SHIELD_READY_MS = 350
let lastUnreachedHostile = null
let swimmingMode = false
let swimShore = null
let swimDrySince = 0
let swimProgress = null
let swimFailedShore = null
let swimBankDig = null
let nextSwimBankDigAt = 0
let nextCanopyAttemptAt = 0
let surfaceRouteActive = false
let lastDrySurface = null
const POST_ARMOR_DIAMONDS = 10
const SURFACE_FOOD_TARGET = 8
const supplyBase = createSupplyBase({
  statePath: process.env.MC_BASE_STATE_PATH || path.join(__dirname, 'supply-base-state.json'),
  world: JSON.stringify([HOST, PORT, USERNAME]),
  diamondTarget: POST_ARMOR_DIAMONDS,
  log,
  durability: toolDurability,
  safe: connection => canWorkHere(connection) && !fleeingActive &&
    !damageInterruptActive(connection) && !closeCombatPlan(),
  openSurface: openSurfaceAt,
  goto: gotoWithTimeout,
  woodSupply: () => plankCount() + inventoryCount(LOG_NAMES) * 4,
  planks: makePlanksFor,
  craft: craftNamed,
  foodReserve,
  eat: eatFoodIfNeeded,
  forage: () => huntNearbyAnimalsOrForage({ stockUp: true }),
  cookFood: cookRawMeatInFurnace,
  wood: collectWoodWithPlan,
  surface: approachFoodSurface,
  explore: exploreOneStep,
  smeltIron: () => processFurnaceBatch(new Set(['raw_iron']), 'base materials smelted', 95000,
    item => IRON_FUEL_NAMES.has(item.name)),
  starterGear: prepareStarterGear,
  mine: async objective => {
    if (mineNeedsNewGround) {
      mineNeedsNewGround = false
      const y = Math.floor(bot.entity.position.y)
      const floor = objective.kind === 'redstone' ? 8 : objective.kind === 'iron' ? 28 : null
      const riseToStone = objective.kind === 'stone' && objective.names[0] === 'cobblestone' &&
        objective.names.length === 1 && y < 8
      if (riseToStone || (floor !== null && y > floor + 2)) {
        const targetY = riseToStone ? Math.min(8, y + 8) : Math.max(floor, y - 8)
        if (await prospectMiningLevel(targetY)) return
      }
      if (!canWorkHere(bot) || closeCombatPlan()) return
      await exploreOneStep()
      return
    }
    await mineForGear(null, objective.kind, null, { objective })
  },
})
// When set, the swim controller heads for this far shore instead of the
// nearest ledge (used to leave a platform the bot built in the sea).
let swimOverride = null
let swimOverrideUntil = 0
let lastStrandCheckAt = 0
// Where the bot last died, so it can walk back and pick up its dropped items.
// {x,y,z,dimension,diedAt,attempts,done,carriedBefore}
let deathPoint = null
let recoveringDeathDrops = false
const DEATH_DROP_LIFETIME_MS = 5 * 60 * 1000
let shelterBusy = false
let shelteredUntilDawn = false
let emergencyShelteredUntil = 0
let nextEmergencyShelterAt = 0
let shelterInfo = null      // {kind:'pit'|'walls', seal?:Vec3}
let nightsSheltered = 0
let shelterAttemptedTonight = false
let landedAt = 0
let lastSwimLogAt = 0
let navigationState = { target: null, waypoints: [], label: '' }
let lastParticleAt = 0
// The block the mine planner is about to dig (or is digging): {x,y,z,name,label}.
let currentMineTarget = null
// Local MineProcess state.  DeepSeek chooses the high-level action; this
// loop performs the fast Baritone-style search/replan work every second.
let mineMode = false
let mineBusy = false
let isSmelting = false
let isDiggingBlock = false
let isEating = false
let activeGoal = null

const HARMFUL_FOODS = new Set(['pufferfish', 'spider_eye', 'poisonous_potato', 'chorus_fruit', 'suspicious_stew'])
const PASSIVE_FOOD_ANIMALS = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit'])
const RAW_MEAT_NAMES = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'potato'])
const DEFAULT_MINE_TARGET_NAMES = new Set([
  'stone', 'deepslate',
  'coal_ore', 'deepslate_coal_ore',
  'iron_ore', 'deepslate_iron_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'emerald_ore', 'deepslate_emerald_ore',
])
let mineTargetNames = new Set(DEFAULT_MINE_TARGET_NAMES)
let currentMineOrder = null
let baseProspecting = false
let lastMineAudit = null
let committedMineTarget = null
const mineBlacklist = new Map()
let lastMineSearchAt = 0
let nextMineSearchAt = 0
let temporaryCraftingTable = null

function stopPathfinder() {
  if (!bot?.pathfinder) return
  try {
    // setGoal(null) clears the current path immediately. Calling
    // pathfinder.stop() leaves its stop flag armed until the next physics
    // tick, which can make the following goto reject instantly.
    bot.pathfinder.setGoal(null)
  } catch {
    try { bot.pathfinder.stop() } catch {}
  }
}

try {
  const lines = fs.readFileSync(EXPERIENCE_LOG_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean)
  const previous = lines.length ? JSON.parse(lines[lines.length - 1]) : null
  if (previous?.experience) lastExperience = String(previous.experience)
} catch {
  // The experience file is optional on a first run.
}

function persistExperience(entry) {
  if (!entry?.experience) return
  lastExperience = String(entry.experience).slice(0, 500)
  try {
    fs.appendFileSync(EXPERIENCE_LOG_PATH, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8')
  } catch (error) {
    log('experience persistence failed', { message: error.message })
  }
}

const LOG_NAMES = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'pale_oak_log',
])

const HOSTILE_NAMES = new Set([
  'blaze', 'cave_spider', 'drowned', 'enderman', 'ender_mite', 'evoker',
  'husk', 'magma_cube', 'pillager', 'piglin', 'piglin_brute', 'ravager',
  'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray',
  'vex', 'vindicator', 'witch', 'wither_skeleton', 'zoglin', 'zombie',
  'zombie_villager', 'zombified_piglin', 'creeper',
])

const WATER_BLOCK_NAMES = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])

// True when the position, the block under it, or any of its four horizontal
// neighbours (at that level or one lower) is water.
function isWaterAdjacent(position) {
  if (!position || !bot?.world) return false
  const offsets = [[0, 0, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]
  for (const [dx, dy, dz] of offsets) {
    const neighbour = bot.blockAt(position.offset(dx, dy, dz))
    if (neighbour && WATER_BLOCK_NAMES.has(neighbour.name)) return true
  }
  return false
}

function entityNameOf(entity) {
  if (!entity) return ''
  return String(entity.name || entity.displayName || entity.type || '').toLowerCase().replace(/ /g, '_')
}

function isHostileEntity(entity) {
  if (!entity || entity === bot?.entity) return false
  const name = entityNameOf(entity)
  if (!HOSTILE_NAMES.has(name)) return false

  // Passive unless provoked
  if (name === 'zombified_piglin' || name === 'enderman') return false

  // Spiders and cave spiders are neutral in daylight / light level >= 9
  if (name === 'spider' || name === 'cave_spider') {
    const tod = Number(bot?.time?.timeOfDay ?? 0)
    const isDay = (tod < 12000 || tod > 23500) && !bot?.isRaining
    if (isDay && bot?.world) {
      const pos = entity.position ? entity.position.floored() : null
      if (pos) {
        const block = bot.blockAt(pos) || bot.blockAt(pos.offset(0, 1, 0))
        const sky = block ? (block.skyLight ?? 15) : 15
        const light = block ? (block.light ?? 0) : 0
        if (Math.max(sky, light) >= 9) return false
      }
    }
  }

  return true
}

function log(message, data = undefined) {
  const suffix = data === undefined ? '' : ` ${JSON.stringify(data)}`
  const event = { time: new Date().toISOString(), message, data: data ?? null }
  console.log(`[agent ${event.time}] ${message}${suffix}`)
  eventLog.push(event)
  if (eventLog.length > 80) eventLog.shift()
  try {
    fs.appendFileSync(RUNTIME_LOG_PATH, `${JSON.stringify(event)}\n`, 'utf8')
  } catch (error) {
    console.error(`[agent ${event.time}] runtime log persistence failed: ${error.message}`)
  }
}

function startDashboard() {
  if (dashboardStarted) return
  dashboardStarted = true
  const page = `<!doctype html><meta charset="utf-8"><title>NMO Agent 实时监控</title>
  <style>body{margin:0;background:#101820;color:#e8f1f2;font:14px system-ui}main{max-width:1180px;margin:20px auto;padding:0 16px}h1{font-size:22px}.sub{color:#9fc3cc}.section{margin-top:16px}.panel{background:#192a34;border:1px solid #2e4a58;border-radius:10px;padding:14px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{background:#192a34;border:1px solid #2e4a58;border-radius:10px;padding:12px}.value{font-size:20px;font-weight:700;margin-top:6px;word-break:break-word}canvas{width:100%;height:300px;background:#16313c;border-radius:10px;margin-top:12px;image-rendering:pixelated}pre{white-space:pre-wrap;background:#0c1318;padding:12px;border-radius:10px;max-height:260px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:7px;border-bottom:1px solid #2e4a58;text-align:left;vertical-align:top}th{color:#9fc3cc}td.reason{max-width:420px;white-space:pre-wrap}.pill{display:inline-block;padding:2px 7px;border-radius:9px;background:#315765}.ok{color:#7ee787}.bad{color:#ff8a8a}@media(max-width:800px){.grid{grid-template-columns:repeat(2,1fr)}table{font-size:12px}}</style>
  <main><h1>NMO Agent 实时监控</h1><div class="sub">DeepSeek 实时决策、寻路与战斗监控</div><div class="section panel"><button id="startBtn">启动 Bot</button> <button id="stopBtn">暂停 Bot</button> <span id="botStatus" class="pill">状态读取中…</span></div><div id="grid" class="grid section"></div><canvas id="map" width="900" height="300"></canvas>
  <div class="section panel"><button id="modelBtn" disabled>读取 DeepSeek 状态…</button> <span id="modelStatus" class="pill" role="status"></span><h3>最近一次模型决策</h3><pre id="decision">连接中…</pre><h3>采矿指令与实际操作</h3><pre id="mineAudit">等待采矿指令…</pre><h3>最近经验总结</h3><pre id="experience">连接中…</pre></div>
  <div class="section panel"><h3>模型调用与 Token 用量</h3><div id="usage"></div><table><thead><tr><th>时间</th><th>触发</th><th>状态</th><th>动作</th><th>目标</th><th>原因 / 经验</th><th>输入</th><th>输出</th><th>总计</th><th>延迟</th></tr></thead><tbody id="modelCalls"></tbody></table></div>
  <div class="section panel"><h3>最近事件</h3><pre id="events">连接中…</pre></div></main>
  <script>
  const grid=document.querySelector('#grid'), events=document.querySelector('#events'), decision=document.querySelector('#decision'), experience=document.querySelector('#experience'), usage=document.querySelector('#usage'), modelCalls=document.querySelector('#modelCalls'), canvas=document.querySelector('#map'), ctx=canvas.getContext('2d'), botStatus=document.querySelector('#botStatus');
  const mineAudit=document.querySelector('#mineAudit');
  const modelButton=document.querySelector('#modelBtn'), modelStatus=document.querySelector('#modelStatus');
  function drawModelStatus(state){
    modelButton.disabled=!state.modelConfigured;
    modelButton.textContent=state.modelEnabled?'关闭 DeepSeek':'开启 DeepSeek';
    modelStatus.textContent=!state.modelConfigured?'未配置密钥':state.modelEnabled?'模型已开启':'模型已关闭';
    modelButton.onclick=()=>control(state.modelEnabled?'disable-model':'enable-model');
  }
  function drawMineAudit(mine){
    if(!mine?.order){mineAudit.textContent='等待采矿指令…';return;}
    const result={'command':'已下达','target-mined':'已挖到目标','path-clearance':'清除挡路方块','unexpected-ore':'已阻止非目标矿物','no-reachable-target':'暂无可达目标','target-changed':'计划坐标的方块已变化','invalid-target':'无效目标'}[mine.lastAudit?.result]||'—';
    const planned=mine.target?.name||mine.lastAudit?.planned?.name||'—';
    const actual=mine.lastAudit?.actual;
    const block=actual?actual.name+' ('+[actual.position.x,actual.position.y,actual.position.z].join(', ')+')':'—';
    mineAudit.textContent=['模型指令 '+(mine.order.requested||'—'),'执行目标 '+mine.order.target,'计划方块 '+planned,'最近操作 '+result+' '+block].join('\\n');
  }
  function fmt(v){return v==null?'—':typeof v==='number'?Math.round(v*10)/10:v}
  function draw(s){ctx.clearRect(0,0,900,300);ctx.fillStyle='#16313c';ctx.fillRect(0,0,900,300); if(!s||!s.position)return; const x=450+(s.position.x%80)*5, z=150+(s.position.z%36)*5; ctx.strokeStyle='#315765'; for(let i=0;i<18;i++){ctx.beginPath();ctx.moveTo(i*50,0);ctx.lineTo(i*50,300);ctx.stroke()} for(let i=0;i<7;i++){ctx.beginPath();ctx.moveTo(0,i*50);ctx.lineTo(900,i*50);ctx.stroke()} const pts=(s.navigation&&s.navigation.waypoints)||[];if(pts.length){ctx.strokeStyle='#ff4040';ctx.lineWidth=3;ctx.beginPath();pts.forEach((p,i)=>{const px=450+(p.x%80)*5,pz=150+(p.z%36)*5;i?ctx.lineTo(px,pz):ctx.moveTo(px,pz)});ctx.stroke();ctx.fillStyle='#ff4040';pts.forEach(p=>{ctx.beginPath();ctx.arc(450+(p.x%80)*5,150+(p.z%36)*5,4,0,Math.PI*2);ctx.fill()});ctx.lineWidth=1;} ctx.fillStyle='#ffd166';ctx.beginPath();ctx.arc(x,z,9,0,Math.PI*2);ctx.fill();ctx.fillStyle='#e8f1f2';ctx.fillText('Agent',x+12,z+4);}
  function targetText(t){return t&&typeof t==='object'?JSON.stringify(t):fmt(t)}
  async function control(action){await fetch('/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});await tick();}
  document.querySelector('#startBtn').onclick=()=>control('start');document.querySelector('#stopBtn').onclick=()=>control('stop');
  async function tick(){const r=await fetch('/state');const s=await r.json();const u=s.modelUsage||{};const cards=[['版本',s.version],['周期',s.cycle],['生命',s.health],['饥饿',s.food],['木材',s.logs],['背包空位',s.freeSlots],['夜间',s.night?'是':'否'],['镐 / 剑 / 盾',[(s.hasPickaxe?'✓':'—'),(s.hasSword?'✓':'—'),(s.hasShield?'✓':'—')].join(' / ')],['坐标',s.position?JSON.stringify(s.position):'—'],['路径目标',s.navigation&&s.navigation.target?JSON.stringify(s.navigation.target):'—'],['当前决策',s.decision],['模型',s.model||'script-only']];grid.innerHTML=cards.map(([k,v])=>'<div class="card">'+k+'<div class="value">'+fmt(v)+'</div></div>').join('');botStatus.textContent=s.botEnabled?(s.botConnected?'Bot 运行中':'Bot 重连中'):'Bot 已断开';botStatus.className=s.botEnabled?'pill ok':'pill bad';draw(s);drawMineAudit(s.mine);drawModelStatus(s);decision.textContent=JSON.stringify(s.lastModelDecision||{action:s.decision},null,2);experience.textContent=s.lastExperience||'暂无经验总结';usage.innerHTML='<span class="pill">请求 '+fmt(u.requests)+'</span> <span class="pill">输入 '+fmt(u.promptTokens)+'</span> <span class="pill">输出 '+fmt(u.completionTokens)+'</span> <span class="pill">累计 '+fmt(u.totalTokens)+'</span>';modelCalls.innerHTML=(s.modelCalls||[]).slice().reverse().map(c=>'<tr><td>'+fmt(c.time)+'</td><td>'+fmt(c.trigger)+'</td><td class="'+(c.status==='ok'?'ok':'bad')+'">'+fmt(c.status)+'</td><td>'+fmt(c.action)+'</td><td>'+targetText(c.target)+'</td><td class="reason">'+fmt(c.reason)+'<br><span class="sub">经验：'+fmt(c.experience)+'</span></td><td>'+fmt(c.promptTokens)+'</td><td>'+fmt(c.completionTokens)+'</td><td>'+fmt(c.totalTokens)+'</td><td>'+fmt(c.latencyMs)+' ms</td></tr>').join('');events.textContent=(s.events||[]).slice().reverse().map(e=>e.time+'  '+e.message+(e.data?' '+JSON.stringify(e.data):'')).join('\\n');}
  tick();setInterval(tick,1000);
  </script>`
  const server = http.createServer((req, res) => {
    if (req.url === '/control' && req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const action = JSON.parse(body).action
          if (action === 'stop') {
            botEnabled = false
            stopModelCalls()
            const oldBot = bot
            bot = null
            try { oldBot?.pathfinder?.stop() } catch {}
            try { oldBot?.pvp?.stop() } catch {}
            try { oldBot?.clearControlStates() } catch {}
            try { oldBot?.end('dashboard stop') } catch {}
            log('bot disconnected from dashboard')
          } else if (action === 'start') {
            botEnabled = true
            if (!bot) createBotConnection()
            else void decideAndAct('dashboard-start')
            log('bot reconnect requested from dashboard')
          } else if (action === 'enable-model') {
            if (!DEEPSEEK_API_KEY) throw new Error('未配置 DeepSeek 密钥')
            modelEnabled = true
            log('DeepSeek enabled from dashboard')
          } else if (action === 'disable-model') {
            stopModelCalls()
            log('DeepSeek disabled from dashboard')
          } else throw new Error('未知控制命令')
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, botEnabled, modelEnabled }))
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: error.message }))
        }
      })
      return
    }
    if (req.url === '/observer' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(observerState()))
      return
    }
    if (req.url === '/state') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify({
        ...latestState,
        position: bot?.entity?.position.floored() ?? null,
        health: bot?.health ?? null,
        food: bot?.food ?? null,
        foodRecovery: recoveringFood,
        resupply: supplyBase.resupplyStatus(),
        supplyStation: supplyStation.status(),
        ...(bot?.entity ? {
          coal: inventoryItemCount('coal'),
          charcoal: inventoryItemCount('charcoal'),
          rawIron: inventoryCount(IRON_INPUT_NAMES),
          iron: inventoryCount(IRON_INPUT_NAMES) + inventoryItemCount('iron_ingot'),
          torches: inventoryItemCount('torch'),
          logs: inventoryCount(LOG_NAMES),
          planks: plankCount(),
          freeSlots: freeBackpackSlots(bot.inventory),
          hasPickaxe: hasTool('pickaxe'),
          hasIronPickaxe: bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)),
          hasSword: hasTool('sword'),
          hasShield: bot.inventory.slots.some(item => item?.name === 'shield'),
          armorPieces: equippedArmorCount(),
        } : {}),
        inWater: isActuallyInWater(),
        version: bot?.version || VERSION,
        botConnected: Boolean(bot?.entity),
        botEnabled,
        supplyBase: supplyBase.status(),
        navigation: visibleNavigationState(),
        deathPoint: deathPoint && !deathPoint.done
          ? { x: deathPoint.x, y: deathPoint.y, z: deathPoint.z, attempts: deathPoint.attempts, ageSeconds: Math.round((Date.now() - deathPoint.diedAt) / 1000) }
          : null,
        mine: {
          active: mineMode, busy: mineBusy, targets: [...mineTargetNames], blacklist: mineBlacklist.size, lastSearchAt: lastMineSearchAt,
          target: currentMineTarget, committed: committedMineTarget?.position ?? null, order: currentMineOrder, lastAudit: lastMineAudit,
        },
        decision: lastDecision,
        model: modelEnabled ? DEEPSEEK_MODEL : 'script-only',
        modelEnabled,
        modelConfigured: Boolean(DEEPSEEK_API_KEY),
        modelUsage,
        lastModelDecision,
        lastCombatDecision,
        shieldRaised: Boolean(bot && raisedShields.has(bot)),
        lastExperience,
        modelCalls,
        events: eventLog,
      }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
  })
  server.listen(DASHBOARD_PORT, '127.0.0.1', () => log('dashboard started', { url: `http://127.0.0.1:${DASHBOARD_PORT}` }))
}

function observerItem(item) {
  if (!item?.name || item.count <= 0) return null
  return { id: item.name.includes(':') ? item.name : `minecraft:${item.name}`,
    count: item.count, damage: item.durabilityUsed ?? 0, enchanted: Boolean(item.enchants?.length) }
}

function observerState() {
  const connection = bot
  const status = { username: USERNAME, connected: Boolean(connection?.entity), modelEnabled }
  if (!status.connected) return status
  const inventory = connection.inventory
  const getEquipment = destination => observerItem(inventory.slots[connection.getEquipmentDestSlot(destination)])
  const lastCall = modelCalls.findLast(call => call.status === 'ok')
  const audit = lastMineAudit?.cycle === currentMineOrder?.cycle && lastMineAudit?.target === currentMineOrder?.target
    ? lastMineAudit : null
  return { ...status, position: connection.entity.position.floored(), health: connection.health, food: connection.food,
    freeSlots: freeBackpackSlots(inventory), foodRecovery: recoveringFood, action: lastDecision,
    shieldRaised: raisedShields.has(connection), navigation: visibleNavigationState(), mineTarget: currentMineTarget,
    mineOrder: mineMode ? currentMineOrder?.target : null, committedMineTarget: committedMineTarget?.position,
    actual: audit?.actual, mineResult: audit?.result, combatReason: lastCombatDecision?.reason,
    modelAction: lastModelDecision?.action, modelReason: lastModelDecision?.reason,
    tokens: { total: modelUsage.totalTokens, input: lastCall?.promptTokens, output: lastCall?.completionTokens },
    resupply: supplyBase.resupplyStatus(),
    inventory: {
      backpack: inventory.slots.slice(inventory.inventoryStart, inventory.hotbarStart).map(observerItem),
      hotbar: inventory.slots.slice(inventory.hotbarStart, inventory.inventoryEnd).map(observerItem),
      selected: connection.quickBarSlot,
      armor: ['head', 'torso', 'legs', 'feet'].map(getEquipment),
      offhand: getEquipment('off-hand'),
    },
  }
}

function visibleNavigationState() {
  const points = Array.isArray(navigationState.waypoints) ? navigationState.waypoints : []
  if (!bot?.entity) return navigationState
  if (waterOwnsMovement()) return { target: swimShore, waypoints: [], label: 'swimming' }
  const digging = bot.targetDigBlock
  if (digging) {
    const { x, y, z } = digging.position
    return { target: { x, y, z, name: digging.name }, waypoints: [], label: 'digging' }
  }
  if (bot.pathfinder && !bot.pathfinder.isMoving() && !mineBusy && !swimmingMode) {
    return { target: null, waypoints: [], label: '' }
  }
  if (points.length < 2) return navigationState
  const position = bot.entity.position
  let nearestIndex = 0
  let nearestDistance = Infinity
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]
    const dx = Number(point.x) - position.x
    const dz = Number(point.z) - position.z
    const distance = Math.hypot(dx, dz)
    if (distance < nearestDistance) {
      nearestDistance = distance
      nearestIndex = index
    }
  }
  // Keep one node before the closest point so the line joins the bot while
  // removing all nodes that are already behind it.
  const keepFrom = nearestDistance <= 2.25 ? nearestIndex : Math.max(0, nearestIndex - 1)
  if (keepFrom <= 0) return navigationState
  return { ...navigationState, waypoints: points.slice(keepFrom) }
}

function clearNavigation(label = '') {
  navigationState = { target: null, waypoints: [], label }
}

function inventoryCount(names) {
  const allowed = names instanceof Set ? names : new Set(names)
  return bot.inventory.items()
    .filter(item => allowed.has(item.name))
    .reduce((sum, item) => sum + item.count, 0)
}

function snapshot() {
  const entities = Object.values(bot.entities || {})
    .filter(entity => entity !== bot.entity && entity.position)
    .map(entity => {
      const name = entityNameOf(entity)
      return {
        id: entity.id,
        name,
        hostile: isHostileEntity(entity),
        position: entity.position.floored(),
        distance: Number(entity.position.distanceTo(bot.entity.position).toFixed(1)),
      }
    })
    .filter(entity => entity.distance <= THREAT_RADIUS)
    .sort((a, b) => a.distance - b.distance)

  const blockSurvey = surveyNearbyBlocks(6)
  return {
    cycle,
    position: bot.entity.position.floored(),
    health: bot.health,
    food: bot.food,
    oxygen: bot.oxygenLevel,
    inWater: Boolean(bot.entity.isInWater),
    night: bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500,
    timeOfDay: bot.time.timeOfDay,
    logs: inventoryCount(LOG_NAMES),
    planks: inventoryCount(new Set(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks'])),
    sticks: inventoryCount(new Set(['stick'])),
    hasTable: inventoryCount(new Set(['crafting_table'])) > 0 || Boolean(findNearestBlock(new Set(['crafting_table']), 12)),
    hasPickaxe: bot.inventory.items().some(item => item.name.endsWith('_pickaxe')),
    hasAxe: bot.inventory.items().some(item => item.name.endsWith('_axe')),
    hasSword: bot.inventory.items().some(item => item.name.endsWith('_sword')),
    hasShield: inventoryCount(new Set(['shield'])) > 0 || bot.inventory.slots.some(item => item?.name === 'shield'),
    armorPieces: equippedArmorCount(),
    iron: inventoryItemCount('iron_ingot') + inventoryCount(IRON_INPUT_NAMES),
    rawIron: inventoryCount(IRON_INPUT_NAMES),
    torches: inventoryCount(new Set(['torch'])),
    underground: isUndergroundNow(),
    mining_underground: miningUnderground(),
    nightShelterTerrain: nightShelterTerrain(),
    cobblestone: inventoryCount(STONE_DROPS),
    coal: inventoryItemCount('coal'),
    charcoal: inventoryItemCount('charcoal'),
    hasBed: bot.inventory.items().some(item => item.name.endsWith('_bed')),
    hasIronPickaxe: bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)),
    nearbyBlocks: blockSurvey,
    nearbyEntities: entities.slice(0, 8),
  }
}

// Early-game route (see early-game-flow.md): the script decides the stage from
// the inventory and the clock; the model may only pick actions the stage allows.
const WOOD_TARGET = 12   // hand-chop 10-15 logs before crafting anything
const STONE_TARGET = 10  // 8-10 cobblestone for stone pickaxe, sword and axe

// Underground = several solid, non-foliage blocks overhead. Leaves and logs are
// ignored so standing under a tree does not count. Sampled straight up from the
// head, which is enough to tell a cave or mine from open ground.
function isUndergroundNow() {
  if (!bot?.entity) return false
  const head = bot.entity.position.floored().offset(0, 2, 0)
  let solid = 0
  for (let dy = 0; dy < 24; dy += 1) {
    const block = bot.blockAt(head.offset(0, dy, 0))
    if (!block) break
    if (block.boundingBox === 'block' && !/(leaves|_log|_wood)$/.test(block.name)) solid += 1
    if (solid >= 3) return true
  }
  return false
}

// This flag describes an active mining task, not whether night shelter is safe.
function miningUnderground() {
  return isUndergroundNow() && (mineMode || mineBusy || lastDecision === 'mine' ||
    lastDecision === 'gather-stone-for-tools' || lastDecision === 'gather-coal-for-torches') &&
    bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
}

function nightShelterTerrain(connection = bot, feet = connection?.entity?.position.floored()) {
  if (!feet || connection.game?.dimension !== 'overworld') return 'unknown'
  const top = connection.game.minY + connection.game.height
  if (!Number.isInteger(top)) return 'unknown'
  const head = feet.offset(0, 1, 0)
  for (let y = head.y; y < top; y += 1) {
    const block = connection.blockAt(head.offset(0, y - head.y, 0), false)
    if (!block) return 'unknown'
    if (block.boundingBox === 'block' && !/(leaves|_log|_wood)$/.test(block.name)) return 'covered'
  }
  return 'open'
}

function isNightShelterTime(timeOfDay) {
  return timeOfDay >= 12000 && timeOfDay <= 23500
}

function needsCoalForIron(state) {
  if (state.rawIron > 0) return state.coal + state.charcoal === 0
  return !state.hasIronPickaxe && state.iron === 0 && state.coal < 4 && state.charcoal === 0
}

function getEdibleFoods() {
  if (!bot?.inventory) return []
  return bot.inventory.items().filter(item => {
    if (!item || item.count <= 0) return false
    if (HARMFUL_FOODS.has(item.name)) return false
    if (item.name === 'rotten_flesh' && bot.food > 4) return false
    return Boolean(mcData?.foodsByName?.[item.name])
  })
}

function foodRecoveryNeeded(connection = bot) {
  if (connection !== bot || !Number.isFinite(connection?.food)) return false
  if (connection.food <= FOOD_RECOVERY_START) recoveringFood = true
  if (connection.food >= FOOD_RECOVERY_END) recoveringFood = false
  return recoveringFood
}

function monitorFood(connection = bot) {
  if (!botEnabled || !connection?.entity || connection.health <= 0 || !movements ||
      !foodRecoveryNeeded(connection) || waterOwnsMovement() || emergencyRetreating || fleeingActive ||
      isEating || isSmelting || shelterBusy || emergencyShelteredUntil || shelteredUntilDawn ||
      damageInterruptActive(connection)) return
  if (mineBusy && !miningPausedForFood) {
    miningPausedForFood = true
    log('mining paused for food', { food: connection.food, target: currentMineTarget })
    stopPathfinder()
    if (connection.targetDigBlock) connection.stopDigging()
  }
  if (!busy && !mineBusy && Date.now() >= nextFoodSearchAt) void decideAndAct('food-urgent')
}

function damageInterruptActive(connection) {
  return impactGuards.has(connection) || meleeConnection === connection
}

async function recoverFoodSupply() {
  const connection = bot
  lastDecision = 'hunt-food'
  log('food recovery priority', { food: connection.food, target: committedMineTarget?.position ?? null })
  if (!foodReserve() && await supplyBase.recoverFood(connection) && !foodRecoveryNeeded(connection)) {
    log('food recovery complete', { food: connection.food, source: 'supply-base' })
    return
  }
  if (!await huntNearbyAnimalsOrForage() && foodRecoveryNeeded(connection) &&
      canWorkHere(connection) && !closeCombatPlan()) {
    if (nightShelterTerrain() === 'covered') {
      await approachFoodSurface(connection)
    } else {
      await exploreOneStep()
    }
  }
  if (canWorkHere(connection) && !foodRecoveryNeeded(connection)) {
    log('food recovery complete', { food: connection.food, target: committedMineTarget?.position ?? null })
  }
}

function computeStage(s) {
  if (supplyBase.active(bot)) {
    return { name: 'supply_base', hint: '建立并维护补给基地和红石工坊', allowed: null }
  }
  if (isNightShelterTime(s.timeOfDay) && s.nightShelterTerrain === 'open' &&
      (nightsSheltered < 1 || !s.hasSword)) {
    return { name: 'first_night', hint: '天黑了：做床睡觉，没有床就挖三格深的坑并封住头顶，等天亮', allowed: null }
  }
  const currentFood = Number(s.food ?? 20)
  if (currentFood <= FOOD_RECOVERY_START || recoveringFood) {
    const hasFood = getEdibleFoods().length > 0
    if (hasFood) {
      return { name: 'eat_food', hint: `饥饿值偏低 (${currentFood}/20)，食用背包食物恢复状态`, allowed: new Set(['gear_up', 'explore']), action: 'gear_up' }
    }
    return { name: 'hunt_food', hint: `饥饿值危险 (${currentFood}/20) 且背包无食物，寻找牛/羊/猪/鸡狩猎获取肉食`, allowed: new Set(['hunt_food', 'explore', 'attack']), action: 'hunt_food' }
  }
  const isUnderground = Boolean(s.mining_underground || s.underground || (s.position && s.position.y < 55))
  if (!s.hasPickaxe) {
    const hasAnyWood = (s.sticks >= 2 || s.planks >= 1 || s.logs >= 1)
    const canMakeStonePick = Number(s.cobblestone || 0) >= 3 && hasAnyWood
    if (canMakeStonePick) {
      return { name: 'get_stone', hint: '补做石镐并升级装备', allowed: new Set(isUnderground ? ['gear_up', 'mine'] : ['gear_up', 'mine', 'explore']), action: 'gear_up', targetName: 'stone' }
    }
    const hasRawOrIngot = Number(s.iron || 0) > 0
    if (hasRawOrIngot && hasAnyWood) {
      return { name: 'find_iron', hint: '熔炼铁矿制作铁镐', allowed: new Set(['gear_up']), action: 'gear_up', targetName: 'iron' }
    }
    const totalWood = s.logs + Math.floor(s.planks / 4)
    if (totalWood < WOOD_TARGET) {
      return { name: 'gather_wood', hint: `缺乏木材制作工具，收集原木 (目标 ${WOOD_TARGET})`, allowed: new Set(isUnderground ? ['collect_wood', 'gear_up'] : ['collect_wood', 'explore']), action: 'collect_wood' }
    }
    return { name: 'wood_tools', hint: '原木转木板，4 木板做工作台，木镐必须先做，再做木剑和木斧', allowed: new Set(['gear_up', 'collect_wood', 'explore']), action: 'gear_up' }
  }
  const stoneTools = ['pickaxe', 'sword', 'axe'].every(kind => hasStoneGradeTool(kind))
  if (!stoneTools) {
    const hasEnoughCobble = Number(s.cobblestone || 0) >= STONE_TARGET
    return {
      name: 'get_stone',
      hint: hasEnoughCobble
        ? '已挖够圆石，合成石镐、石剑、石斧（若缺木棍先砍树）'
        : `用木镐挖 ${STONE_TARGET} 块圆石，再合成石镐、石剑、石斧`,
      allowed: new Set(isUnderground ? ['mine', 'gear_up'] : ['mine', 'gear_up', 'collect_wood', 'explore']),
      action: hasEnoughCobble ? 'gear_up' : 'mine',
      targetName: 'stone'
    }
  }
  if (needsCoalForIron(s) || (s.coal === 0 && s.torches < 8 && !s.rawIron && s.hasIronPickaxe)) {
    return { name: 'find_coal', hint: '先找煤矿，留煤炭供熔炉使用；火把数量不能替代燃料', allowed: new Set(isUnderground ? ['mine'] : ['mine', 'explore']), action: 'mine', targetName: 'coal' }
  }
  const upgrade = nextIronUpgrade()
  if (upgrade) {
    const ingots = inventoryItemCount('iron_ingot')
    const ready = ingots >= upgrade.cost || (s.coal + s.charcoal > 0 && s.rawIron + ingots >= upgrade.cost)
    return {
      name: 'find_iron',
      hint: ready ? `铁已够做${upgrade.label}，先制作再继续下矿` :
        `先补铁到 ${upgrade.cost} 个，下一件装备是${upgrade.label}`,
      allowed: new Set(ready ? ['gear_up'] : isUnderground ? ['mine', 'gear_up'] : ['mine', 'explore', 'gear_up', 'collect_wood']),
      action: ready ? 'gear_up' : 'mine',
      targetName: 'iron'
    }
  }
  return { name: 'find_diamond', hint: '用铁镐往深层走，阶梯式一格一格往下挖，钻石必须铁镐或更好', allowed: null }
}

function surveyNearbyBlocks(radius = 6) {
  if (!bot.entity) return { counts: {}, interesting: [] }
  const center = bot.entity.position.floored()
  const counts = {}
  const interesting = []
  const interestingNames = new Set([
    ...LOG_NAMES,
    'stone', 'deepslate', 'coal_ore', 'deepslate_coal_ore',
    'iron_ore', 'deepslate_iron_ore',
    'crafting_table', 'furnace', 'water', 'lava',
  ])
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const position = center.offset(dx, dy, dz)
        const block = bot.blockAt(position)
        if (!block) continue
        counts[block.name] = (counts[block.name] || 0) + 1
        if (interestingNames.has(block.name) && interesting.length < 40) {
          interesting.push({ name: block.name, position: { x: position.x, y: position.y, z: position.z }, distance: Number(bot.entity.position.distanceTo(position).toFixed(1)) })
        }
      }
    }
  }
  return { counts, interesting }
}

function waterSurfaceY(connection, origin) {
  let surface = origin.y
  while (surface - origin.y < 48 && isWaterBlock(connection.blockAt(new Vec3(origin.x, surface + 1, origin.z)))) surface += 1
  return surface
}

function findNearestLandForSwimming(radius = 12) {
  if (!bot?.entity) return null
  const origin = bot.entity.position.floored()
  const surface = waterSurfaceY(bot, origin)
  let best = null
  let bestDistance = Infinity
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      for (const y of [surface + 1, surface, surface + 2]) {
        const position = new Vec3(origin.x + dx, y, origin.z + dz)
        if (swimFailedShore && position.distanceTo(swimFailedShore) < 2) continue
        const support = bot.blockAt(position.offset(0, -1, 0))
        if (support?.boundingBox !== 'block' || movements?.blocksToAvoid.has(support.type)) continue
        if (!EMPTY_BLOCK.test(bot.blockAt(position)?.name) ||
            !EMPTY_BLOCK.test(bot.blockAt(position.offset(0, 1, 0))?.name)) continue
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
          const water = new Vec3(position.x + x, Math.min(y - 1, surface), position.z + z)
          return isWaterBlock(bot.blockAt(water)) &&
            bot.blockAt(water.offset(0, 1, 0))?.boundingBox === 'empty' &&
            bot.blockAt(water.offset(0, 2, 0))?.boundingBox === 'empty'
        })
        if (!edge) continue
        const distance = bot.entity.position.distanceTo(position) + 2 * Math.abs(y - surface - 1)
        if (distance < bestDistance) {
          best = position
          bestDistance = distance
        }
      }
    }
  }
  return best
}

async function lowerSwimBank(connection, shore, lip) {
  try {
    if (!await equipBestToolFor(lip) || connection !== bot || !isActuallyInWater(connection)) return
    await connection.lookAt(lip.position.offset(0.5, 0.5, 0.5), true)
    if (!connection.blockAtCursor(4.5)?.position.equals(lip.position)) return
    const dig = connection.dig(lip, true)
    const deadline = Date.now() + Math.max(5500, connection.digTime(lip) * 2 + 1000)
    let finished = false
    void dig.then(() => { finished = true }, () => { finished = true })
    while (!finished && connection === bot && connection.health > 0 &&
           Number(connection.oxygenLevel ?? 20) > 6 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!finished && connection.targetDigBlock?.position.equals(lip.position)) connection.stopDigging()
    if (connection === bot && finished && connection.blockAt(lip.position)?.type !== lip.type) {
      swimShore = shore.offset(0, -1, 0)
      if (swimOverride?.equals(shore)) swimOverride = swimShore
      swimProgress = { distance: Infinity, at: Date.now() }
      log('swim bank lowered for exit', { block: lip.name, position: lip.position, exit: swimShore })
    }
  } catch (error) {
    log('swim bank clearance interrupted', { message: error.message })
  } finally {
    if (swimBankDig?.connection === connection) swimBankDig = null
  }
}

function isWaterBlock(block) {
  return /^(water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(block?.name) ||
    block?.getProperties?.().waterlogged === true
}

function isActuallyInWater(connection = bot) {
  return Boolean(connection?.entity && (connection.entity.isInWater ||
    isWaterBlock(connection.blockAt(connection.entity.position.floored()))))
}

function waterOwnsMovement() {
  return swimmingMode || isActuallyInWater()
}

const PLACED_SUPPORT = /(cobblestone|_planks|_slab|_stairs|crafting_table|furnace|scaffolding)$/

function walkableAt(x, y, z) {
  const feet = bot.blockAt(new Vec3(x, y, z))
  const head = bot.blockAt(new Vec3(x, y + 1, z))
  const below = bot.blockAt(new Vec3(x, y - 1, z))
  return Boolean(feet && head && below && below.boundingBox === 'block' &&
    feet.boundingBox === 'empty' && head.boundingBox === 'empty' &&
    !WATER_BLOCK_NAMES.has(feet.name))
}

function isCanopyBlock(block) {
  return LOG_NAMES.has(block?.name) || /_leaves$/.test(block?.name ?? '')
}

function canopyColumn(connection, feet) {
  let platformY = feet.y
  const steps = []
  for (let depth = 1; depth <= 24; depth += 1) {
    const block = connection.blockAt(feet.offset(0, -depth, 0))
    if (!block || isWaterBlock(block) || /lava|magma|cactus|campfire|powder_snow/.test(block.name)) return null
    if (block.boundingBox !== 'block') continue
    if (platformY - block.position.y - 1 > 3) return null
    if (!isCanopyBlock(block)) {
      const landing = block.position.offset(0, 1, 0)
      return steps.length && feet.y - landing.y >= 4 ? { feet, steps, landing } : null
    }
    steps.push(block.position)
    platformY = block.position.y + 1
  }
  return null
}

async function leaveSpawnCanopy() {
  const connection = bot
  if (!canWorkHere(connection) || closeCombatPlan() || Date.now() < nextCanopyAttemptAt) return false
  const feet = connection.entity.position.floored()
  if (!connection.entity.onGround && connection.entity.position.y - feet.y > 0.15) return false
  if (!isCanopyBlock(connection.blockAt(feet.offset(0, -1, 0)))) return false
  nextCanopyAttemptAt = Date.now() + 2500
  let plan = canopyColumn(connection, feet)
  if (!plan) {
    const options = []
    for (let dx = -3; dx <= 3; dx += 1) {
      for (let dz = -3; dz <= 3; dz += 1) {
        for (const dy of [0, -1, -2]) {
          const point = feet.offset(dx, dy, dz)
          if (!walkableAt(point.x, point.y, point.z) || !isCanopyBlock(connection.blockAt(point.offset(0, -1, 0)))) continue
          const candidate = canopyColumn(connection, point)
          if (candidate) options.push(candidate)
        }
      }
    }
    for (const candidate of options.sort((a, b) => a.feet.distanceTo(feet) - b.feet.distanceTo(feet)).slice(0, 3)) {
      try {
        await gotoWithTimeout(new goals.GoalBlock(candidate.feet.x, candidate.feet.y, candidate.feet.z), 'canopy descent approach', 3000)
        plan = candidate
        break
      } catch (error) {
        log('canopy approach unavailable', { position: candidate.feet, message: error.message })
      }
    }
  }
  if (!plan || !canWorkHere(connection)) return false
  stopPathfinder()
  const center = plan.feet.offset(0.5, 0, 0.5)
  const offCenter = () => Math.hypot(connection.entity.position.x - center.x, connection.entity.position.z - center.z)
  if (offCenter() > 0.28) {
    await connection.lookAt(center.offset(0, connection.entity.eyeHeight, 0), true)
    connection.setControlState('sneak', true)
    connection.setControlState('forward', true)
    const deadline = Date.now() + 900
    try {
      while (canWorkHere(connection) && offCenter() > 0.2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30))
    } finally {
      connection.clearControlStates()
    }
  }
  if (!canWorkHere(connection) || offCenter() > 0.35) return false
  lastDecision = 'canopy-descent'
  log('canopy descent planned', { from: plan.feet, landing: plan.landing, steps: plan.steps.length })
  let progress = false
  for (const position of plan.steps) {
    if (!canWorkHere(connection) || closeCombatPlan() || offCenter() > 0.4) break
    const block = connection.blockAt(position)
    if (!isCanopyBlock(block) || position.y !== connection.entity.position.floored().y - 1 || !connection.canDigBlock(block)) break
    isDiggingBlock = true
    try {
      if (!await equipBestToolFor(block)) break
      await connection.dig(block, true)
      progress = true
      const landingDeadline = Date.now() + 1350
      while (canWorkHere(connection) && Date.now() < landingDeadline &&
          (!connection.entity.onGround || connection.entity.position.y >= position.y + 0.9)) {
        await new Promise(resolve => setTimeout(resolve, 60))
      }
    } catch (error) {
      log('canopy descent interrupted', { position, message: error.message })
      break
    } finally {
      isDiggingBlock = false
    }
  }
  if (canWorkHere(connection) && connection.entity.position.floored().equals(plan.landing)) {
    log('canopy descent reached ground', { position: plan.landing, health: connection.health })
  }
  return progress
}

// Flood fill over dry standable columns (steps of at most one block). Capped,
// so a real landmass stops the search quickly while a platform returns small.
function dryComponent(start, cap = 60) {
  const seen = new Map()
  const queue = [{ x: start.x, y: start.y, z: start.z }]
  seen.set(`${start.x},${start.z}`, start.y)
  while (queue.length > 0 && seen.size < cap) {
    const node = queue.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = node.x + dx
      const nz = node.z + dz
      const key = `${nx},${nz}`
      if (seen.has(key)) continue
      for (const dy of [0, 1, -1]) {
        if (walkableAt(nx, node.y + dy, nz)) {
          seen.set(key, node.y + dy)
          queue.push({ x: nx, y: node.y + dy, z: nz })
          break
        }
      }
    }
  }
  return seen
}

// Nearest natural, solid landmass outside `platform`. Sampled every 2 blocks to
// stay cheap; each candidate must be a real landmass (large dry component).
function findMainlandShore(platform, radius = 48) {
  const origin = bot.entity.position.floored()
  const candidates = []
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const x = origin.x + dx
      const z = origin.z + dz
      const distance = Math.hypot(dx, dz)
      if (distance < 4 || platform.has(`${x},${z}`)) continue
      for (let y = origin.y + 6; y >= origin.y - 8; y -= 1) {
        const support = bot.blockAt(new Vec3(x, y - 1, z))
        if (!support || support.boundingBox !== 'block') continue
        // First solid block from above is the surface of this column.
        if (PLACED_SUPPORT.test(support.name) || /(leaves|_log)$/.test(support.name) || !walkableAt(x, y, z)) break
        let solid = true
        for (let i = -1; i <= 1 && solid; i += 1) {
          for (let j = -1; j <= 1 && solid; j += 1) {
            if (bot.blockAt(new Vec3(x + i, y - 1, z + j))?.boundingBox !== 'block') solid = false
          }
        }
        if (solid) candidates.push({ x, y, z, distance })
        break
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  for (const candidate of candidates.slice(0, 12)) {
    if (dryComponent(candidate, 60).size >= 40) return candidate
  }
  return null
}

// Standing on a tiny patch (e.g. a platform built over the sea): swim to real land.
async function escapeIfStranded() {
  if (!bot?.entity || waterOwnsMovement() || swimOverride || emergencyRetreating) return false
  if (Date.now() - lastStrandCheckAt < 5000 || !bot.entity.onGround) return false
  lastStrandCheckAt = Date.now()
  const feet = bot.entity.position.floored()
  if (openSurfaceAt(bot, feet)) lastDrySurface = { feet, dimension: bot.game.dimension }
  // A forest floor under leaves also gives a tiny "dry component" because the
  // head-clearance test fails there. Only treat it as a stranded platform when
  // water actually surrounds the bot, which is the real sea-platform case.
  let waterAround = 0
  for (let dx = -3; dx <= 3; dx += 1) {
    for (let dz = -3; dz <= 3; dz += 1) {
      for (const dy of [-1, 0]) {
        const block = bot.blockAt(feet.offset(dx, dy, dz))
        if (block && WATER_BLOCK_NAMES.has(block.name)) waterAround += 1
      }
    }
  }
  if (waterAround < 12) return false
  const platform = dryComponent({ x: feet.x, y: feet.y, z: feet.z }, 60)
  if (platform.size >= 40) return false
  const shore = findMainlandShore(platform)
  if (!shore) {
    log('stranded on a small platform; no mainland within range', { platformSize: platform.size })
    return false
  }
  log('stranded on a small platform; swimming to mainland', { platformSize: platform.size, shore })
  persistExperience({ cycle, action: 'escape-platform', experience: '站在海中的小平台上，寻路不下水会原地踏步；改为游向真正的陆地' })
  swimOverride = new Vec3(shore.x, shore.y, shore.z)
  swimOverrideUntil = Date.now() + 90000
  mineMode = false
  stopPathfinder()
  clearNavigation('escape-platform')
  const deadline = Date.now() + 5000
  try {
    while (Date.now() < deadline && !isActuallyInWater() && bot.health > 0) {
      const dx = shore.x + 0.5 - bot.entity.position.x
      const dz = shore.z + 0.5 - bot.entity.position.z
      await bot.look(Math.atan2(-dx, -dz), 0, true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  } finally {
    if (!isActuallyInWater()) {
      swimOverride = null
      bot.clearControlStates()
    }
  }
  return true
}

function monitorSwimming() {
  if (!botEnabled || !bot?.entity || bot.health <= 0) return
  const now = Date.now()
  const inWater = isActuallyInWater()
  if (!inWater) {
    if (!swimmingMode) return
    // Jumping against the shore keeps onGround flickering. Count the bot as
    // standing when it is on the ground or a solid block is directly below,
    // so control is handed back instead of idling in swim-ashore.
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    const standing = bot.entity.onGround || below?.boundingBox === 'block'
    if (standing) swimDrySince ||= now
    else swimDrySince = 0
    if (swimDrySince) {
      bot.setControlState('forward', false)
      bot.setControlState('sprint', false)
    }
    if (swimDrySince && now - swimDrySince >= 550) {
      bot.clearControlStates()
      swimmingMode = false
      swimShore = swimProgress = swimFailedShore = null
      clearNavigation('landed')
      log('swim reached dry ground', { position: bot.entity.position })
      if (swimOverride) {
        // Only finish the override when this is the mainland, not the platform.
        const here = bot.entity.position.floored()
        const reached = Math.hypot(here.x - swimOverride.x, here.z - swimOverride.z) <= 4
        if (reached) swimOverride = null
      }
      landedAt = Date.now()
      setImmediate(() => void decideAndAct('landed'))
    } else {
      bot.setControlState('jump', false)
    }
    return
  }

  swimDrySince = 0
  if (!swimmingMode) {
    swimmingMode = true
    lastDecision = 'swim-ashore'
    bot.pvp.stop()
    stopPathfinder()
    bot.stopDigging()
    bot.clearControlStates()
    clearNavigation('swimming')
    log('entered water; fast swim controller enabled', { oxygen: bot.oxygenLevel })
  }

  const oxygen = Number(bot.oxygenLevel ?? 20)
  if (swimBankDig?.connection === bot) {
    bot.setControlState('jump', true)
    bot.setControlState('forward', false)
    if (oxygen <= 6 && bot.targetDigBlock?.position.equals(swimBankDig.position)) bot.stopDigging()
    return
  }
  const position = bot.entity.position
  const horizontalRemaining = swimShore ? Math.hypot(position.x - swimShore.x - 0.5, position.z - swimShore.z - 0.5) : Infinity
  if (swimShore && swimProgress && horizontalRemaining + 0.4 < swimProgress.distance) {
    swimProgress = { distance: horizontalRemaining, at: now }
  }
  if (swimShore && swimProgress && oxygen > 9 && now >= nextSwimBankDigAt &&
      now - swimProgress.at >= 1300 && horizontalRemaining < 3) {
    const feet = position.floored()
    const lip = bot.blockAt(swimShore.offset(0, -1, 0))
    const support = bot.blockAt(swimShore.offset(0, -2, 0))
    if (swimShore.y > waterSurfaceY(bot, feet) + 1 && lip && support?.boundingBox === 'block' &&
        !isWaterBlock(support) && TUNNEL_SAFE_BLOCKS.has(lip.name) && !isOreName(lip.name) && bot.canDigBlock(lip)) {
      swimBankDig = { connection: bot, position: lip.position }
      nextSwimBankDigAt = now + 4500
      bot.setControlState('jump', true)
      bot.setControlState('forward', false)
      void lowerSwimBank(bot, swimShore, lip)
      return
    }
  }
  if (swimShore && swimProgress && now - swimProgress.at > 3000 && oxygen > 6) {
    swimFailedShore = swimShore
    swimShore = null
    swimProgress = null
  }
  if (swimOverride && now > swimOverrideUntil) swimOverride = null
  if (swimOverride) {
    // Heading for the mainland: skip the progress-based shore swap so it does
    // not turn back to the platform it just left.
    if (!swimShore || swimShore.x !== swimOverride.x || swimShore.z !== swimOverride.z) {
      swimShore = swimOverride
      swimProgress = { distance: Infinity, at: now }
      log('swim shore selected', { position: swimShore, reason: 'mainland override' })
    }
    swimProgress = swimProgress && { ...swimProgress, at: now }
  } else if (!swimShore && (!swimProgress || now - swimProgress.at > 1500)) {
    swimShore = findNearestLandForSwimming(14)
    swimProgress = { distance: Infinity, at: now }
    if (swimShore) log('swim shore selected', { position: swimShore })
  }
  bot.setControlState('sprint', true)
  bot.setControlState('forward', oxygen > 6)
  bot.setControlState('jump', oxygen <= 6 || !swimShore ||
    position.y < swimShore.y - 1.4 || horizontalRemaining < 2.5)

  if (oxygen <= 6) {
    // Hold the head upward and keep jumping until the oxygen bar recovers.
    void bot.look(bot.entity.yaw, 1.1, true).catch(() => {})
    if (Date.now() - lastSwimLogAt > 2000) {
      lastSwimLogAt = Date.now()
      log('low oxygen; surfacing', { oxygen })
    }
  } else if (swimShore) {
    const dx = swimShore.x + 0.5 - position.x
    const dz = swimShore.z + 0.5 - position.z
    const pitch = position.y < swimShore.y - 1.2 ? 0.32 : 0
    void bot.look(Math.atan2(-dx, -dz), pitch, true).catch(() => {})
  }
}

function emitNavigationParticles() {
  // Server-side dust particles are opt-in; the observer mod draws the route client-side.
  if (process.env.MC_VISUALIZE_PATH !== '1' || !bot?.entity || !navigationState.waypoints?.length) return
  if (Date.now() - lastParticleAt < 900) return
  lastParticleAt = Date.now()
  const y = Math.floor(bot.entity.position.y) + 1
  const points = navigationState.waypoints.slice(0, 16)
  for (const point of points) {
    const command = `/particle minecraft:dust{color:[1.0,0.0,0.0],scale:0.7} ${point.x + 0.5} ${y} ${point.z + 0.5} 0.12 0.35 0.12 0 4 force`
    try { bot.chat(command) } catch {}
  }
  const target = navigationState.target
  if (target) {
    const marker = `/particle minecraft:dust{color:[1.0,0.0,0.0],scale:1.4} ${target.x + 0.5} ${y + 0.8} ${target.z + 0.5} 0.2 1.0 0.2 0 12 force`
    try { bot.chat(marker) } catch {}
  }
}

function stopModelCalls() {
  modelEnabled = false
  for (const controller of pendingModelCalls) controller.abort()
}

async function askDeepSeek(state, trigger = 'scheduled') {
  if (!modelEnabled || !botEnabled) return null
  const started = Date.now()
  const call = {
    time: new Date().toISOString(),
    cycle: state.cycle,
    trigger,
    status: 'pending',
    action: '—',
    target: null,
    reason: '',
    experience: '',
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    latencyMs: 0,
    state: {
      position: state.position,
      health: state.health,
      food: state.food,
      logs: state.logs,
      nearbyEntities: state.nearbyEntities,
    },
  }
  modelCalls.push(call)
  if (modelCalls.length > 60) modelCalls.shift()
  const payload = {
    model: DEEPSEEK_MODEL,
    messages: [
      {
        role: 'system',
        content: [
          '你是 Minecraft 生存 Agent 的高层决策器。',
          '根据当前状态选择一个动作，只返回 JSON：',
          '{"action":"attack|flee|collect_wood|gear_up|mine|build_camp|inspect_stone|explore","target_name":"目标实体名或方块名","target":{"x":整数,"z":整数},"reason":"简短原因","experience":"对本轮环境或行动的一句话经验总结"}。挖矿必须填写一种矿物，例如 diamond、iron、coal 或 stone，并与理由中所说的采矿目标一致。',
          '前期路线：开局先徒手砍 10-15 个原木；原木转木板，4 木板做工作台，木镐必须最先做，再做木剑和木斧；用木镐挖 8-10 块圆石，合成石镐、石剑、石斧；露天遇到第一夜时由脚本尝试做床或挖坑避难，矿洞内按当前任务行动；准备火把（煤炭加木棍）；煤炭够了后全力下矿/探洞找铁矿（绝对不要挖铜矿，不要选 copper），铁锭优先铁镐、铁剑、胸甲、头盔、盾牌；有铁镐后往深层阶梯式挖，找钻石。',
          '状态里的 stage 和 stageHint 是脚本判断的当前阶段，按 stageHint 选动作，不要跳过阶段。',
          '看到 nearbyEntities 中的 item 时优先靠近拾取；attack 只在 nearbyEntities 有敌对生物时使用；flee 表示跑路并远离威胁；生命低、饥饿低或苦力怕过近时优先 flee；explore 时给出下一目标 X/Z；不要输出游戏指令。',
          '近敌优先于砍树、挖矿和拾取。装备和生命够用时优先接战，包括有盾时接近射手。只有生命危急、缺武器、被围且状态不足，或苦力怕临近等明显打不过时才撤退。',
          '执行 collect_wood 时，材料足够就先合成木斧，再砍树。执行器会拆下并捡回自己放的临时工作台。',
        ].join(' '),
      },
      { role: 'user', content: JSON.stringify({ ...state, decisionTrigger: trigger, previousExperience: lastExperience }) },
    ],
    thinking: { type: 'disabled' },
    response_format: { type: 'json_object' },
    // The reply carries a Chinese reason and experience; 96 tokens cut the JSON
    // off mid-string ("Unterminated string"), which forced the script fallback.
    max_tokens: 320,
    stream: false,
  }

  const controller = new AbortController()
  pendingModelCalls.add(controller)
  try {
    const response = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${DEEPSEEK_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    controller.signal.throwIfAborted()
    const usage = body.usage || {}
    modelUsage.requests += 1
    modelUsage.promptTokens += Number(usage.prompt_tokens || 0)
    modelUsage.completionTokens += Number(usage.completion_tokens || 0)
    modelUsage.totalTokens += Number(usage.total_tokens || 0)
    const content = body.choices?.[0]?.message?.content
    const decision = typeof content === 'string' ? JSON.parse(content) : content
    const allowed = new Set(['attack', 'flee', 'collect_wood', 'gear_up', 'mine', 'build_camp', 'inspect_stone', 'explore'])
    if (!decision || !allowed.has(decision.action)) throw new Error('invalid model action')
    decision.reason = String(decision.reason || '').slice(0, 240)
    decision.experience = String(decision.experience || decision.reason || '').slice(0, 500)
    if (decision.target && Number.isFinite(Number(decision.target.x)) && Number.isFinite(Number(decision.target.z))) {
      decision.target = { x: Math.round(Number(decision.target.x)), z: Math.round(Number(decision.target.z)) }
    } else {
      decision.target = null
    }
    decision.target_name = String(decision.target_name || '').slice(0, 80)
    log('model decision', {
      model: body.model || DEEPSEEK_MODEL,
      action: decision.action,
      reason: String(decision.reason || '').slice(0, 160),
      target: decision.target,
      targetName: decision.target_name,
      experience: decision.experience,
      totalTokens: Number(usage.total_tokens || 0),
      latencyMs: Date.now() - started,
    })
    call.status = 'ok'
    call.action = decision.action
    call.target = decision.target_name
      ? { name: decision.target_name, ...(decision.target || {}) }
      : (decision.target || null)
    call.reason = decision.reason
    call.experience = decision.experience
    call.promptTokens = Number(usage.prompt_tokens || 0)
    call.completionTokens = Number(usage.completion_tokens || 0)
    call.totalTokens = Number(usage.total_tokens || 0)
    call.latencyMs = Date.now() - started
    lastModelDecision = { ...decision, model: body.model || DEEPSEEK_MODEL, trigger, cycle: state.cycle, time: call.time }
    persistExperience({ cycle: state.cycle, action: decision.action, reason: decision.reason, experience: decision.experience, target: decision.target || decision.target_name || null })
    return decision
  } catch (error) {
    call.latencyMs = Date.now() - started
    if (controller.signal.aborted) {
      call.status = 'cancelled'
      call.reason = 'DeepSeek 已关闭'
      return null
    }
    call.status = 'error'
    call.reason = error.message
    log('model call failed; using script fallback', { message: error.message, latencyMs: Date.now() - started })
    return null
  } finally {
    pendingModelCalls.delete(controller)
  }
}

function findNearestBlock(names, maxDistance = 32) {
  const allowed = names instanceof Set ? names : new Set(names)
  return bot.findBlock({
    maxDistance,
    count: 1,
    matching: block => Boolean(block && allowed.has(block.name)),
  })
}

function findNearestHostile(maxDistance = 16, targetName = '') {
  const wanted = String(targetName || '').toLowerCase()
  return Object.values(bot.entities || {})
    .filter(entity => entity !== bot.entity && entity.position)
    .filter(entity => isHostileEntity(entity))
    .filter(entity => !wanted || entityNameOf(entity) === wanted)
    .filter(entity => entity.position.distanceTo(bot.entity.position) <= maxDistance)
    .sort((a, b) => {
      const distanceDelta = a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position)
      if (Math.abs(distanceDelta) > 0.35) return distanceDelta
      return (Number(a.health ?? 999) - Number(b.health ?? 999))
    })[0]
}

function findNearbyDrops(maxDistance = 16) {
  return Object.values(bot.entities || {})
    .filter(entity => entity !== bot.entity && entity.position && !discardedEntities.has(entity))
    .filter(entity => ['item', 'item_stack'].includes(String(entity.name || entity.type || '').toLowerCase()))
    .map(entity => ({ entity, distance: entity.position.distanceTo(bot.entity.position) }))
    .filter(item => item.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
}

function clampModelTarget(target, origin, maxDistance = 64) {
  if (!target || !Number.isFinite(Number(target.x)) || !Number.isFinite(Number(target.z))) return null
  return {
    x: Math.round(Math.max(origin.x - maxDistance, Math.min(origin.x + maxDistance, Number(target.x)))),
    z: Math.round(Math.max(origin.z - maxDistance, Math.min(origin.z + maxDistance, Number(target.z)))),
  }
}

async function gotoDestination(target, label = 'path') {
  const { x, z } = target
  const distance = Math.hypot(x - bot.entity.position.x, z - bot.entity.position.z)
  navigationState = { target: { x, z }, waypoints: [], label }
  await gotoWithTimeout(new goals.GoalNearXZ(x, z, 2), label, Math.min(26000, 7500 + distance * 350))
}

async function gotoWithTimeout(goal, label, timeoutMs) {
  if (waterOwnsMovement()) throw new Error('movement paused until the bot reaches dry ground')
  const connection = bot
  let timer
  const movement = connection.pathfinder.goto(goal)
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timeout`))
      if (connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
    }, timeoutMs)
  })
  try {
    return await Promise.race([movement, timeout])
  } finally {
    clearTimeout(timer)
  }
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
  if (isEating || connection.inventory.slots[slot]?.name !== 'shield') return false
  if (raisedShields.has(connection) && connection.usingHeldItem) return true
  if (connection.usingHeldItem) return false
  connection.activateItem(true)
  raisedShields.set(connection, Date.now())
  log('shield raised', { target: entityNameOf(target) })
  return true
}

function lowerCombatShield(connection) {
  stopShieldSteps(connection)
  if (!raisedShields.delete(connection)) return
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
  connection.on('entityUpdate', entity => {
    if (entityNameOf(entity) !== 'creeper') return
    if (entity.metadata?.[swell] > 0 || entity.metadata?.[ignited] === true) litCreepers.add(entity)
    else litCreepers.delete(entity)
  })
  const isArrow = entity => ['arrow', 'spectral_arrow'].includes(entityNameOf(entity))
  connection.on('entitySpawn', entity => {
    if (isArrow(entity)) arrows.set(entity.id, {
      position: entity.position.clone(), velocity: entity.velocity?.clone(), updated: Date.now()
    })
  })
  // On 26.x the spawn packet already expresses velocity in blocks per tick.
  // Mineflayer's generic entity helper still divides those values by 8000.
  connection._client.on('spawn_entity', packet => {
    const sample = arrows.get(packet.entityId)
    const v = packet.velocity
    if (sample && /^26\./.test(connection.version) && v &&
        [v.x, v.y, v.z].every(Number.isFinite)) {
      sample.velocity = new Vec3(v.x, v.y, v.z)
    }
  })
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
    if (connection !== bot || connection.health <= 0 || (!arrows.size && !litCreepers.size) || isEating ||
        isSmelting || isDiggingBlock || connection.targetDigBlock || waterOwnsMovement() ||
        impactGuards.has(connection)) return
    const slot = connection.getEquipmentDestSlot('off-hand')
    if (connection.inventory.slots[slot]?.name !== 'shield') return
    const feet = connection.entity.position
    const creeper = [...litCreepers].find(entity => !considered.has(entity) &&
      entity.position.distanceTo(feet) < 6 && hostileSight(entity).visible)
    if (creeper) {
      considered.add(creeper)
      void guardAgainstCreeper(connection, creeper, litCreepers)
        .catch(error => log('creeper guard interrupted', { message: error.message }))
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
    void guardAgainstArrow(connection, incoming).catch(error => log('arrow guard interrupted', { message: error.message }))
  })
}

async function guardAgainstCreeper(connection, creeper, litCreepers) {
  impactGuards.add(connection)
  const onExplosion = () => log('creeper explosion observed while shielding', { entityId: creeper.id })
  connection._client.once('explosion', onExplosion)
  try {
    stopPathfinder()
    connection.clearControlStates()
    const start = connection.entity.position.clone()
    const away = start.minus(creeper.position)
    const retreat = start.offset(away.x * 2, 0, away.z * 2)
    const until = Date.now() + 1700
    await connection.lookAt(hostileSight(creeper).center, true)
    if (connection !== bot || connection.health <= 0 || !raiseCombatShield(connection, creeper)) return
    log('creeper fuse guard', { entityId: creeper.id })
    while (connection === bot && connection.health > 0 && !waterOwnsMovement() &&
        litCreepers.has(creeper) && Date.now() < until) {
      await connection.lookAt(hostileSight(creeper).center, true)
      stepWhileShielding(connection, creeper.position, retreat)
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    // Hold until the explosion and damage packets arrive after entity removal.
    await new Promise(resolve => setTimeout(resolve, 120))
  } finally {
    connection._client.removeListener('explosion', onExplosion)
    impactGuards.delete(connection)
    lowerCombatShield(connection)
  }
}

async function guardAgainstArrow(connection, { arrow, ticks, velocity }) {
  const start = connection.entity.position.clone()
  const route = visibleNavigationState().waypoints || []
  const waypoint = route.find(point => Math.hypot(point.x - start.x, point.z - start.z) >= 0.8)
  const pursuing = meleeConnection === connection
  const retreating = fleeingActive
  const target = waypoint || (pursuing ? closeCombatPlan()?.target?.position : null) ||
    (retreating ? start.offset(velocity.x * 5, 0, velocity.z * 5) : null)
  impactGuards.add(connection)
  try {
    stopPathfinder()
    connection.clearControlStates()
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const facing = eyes.offset(-velocity.x * 8, 0, -velocity.z * 8)
    await connection.lookAt(facing, true)
    if (connection !== bot || connection.health <= 0 || !raiseCombatShield(connection, arrow)) return
    log('incoming arrow guard', { entityId: arrow.id, estimatedImpactMs: Math.round(ticks * 50) })
    const until = Date.now() + Math.max(350, Math.round(ticks * 50) + 160)
    while (connection === bot && connection.health > 0 && !waterOwnsMovement() && Date.now() < until) {
      if (target && raisedShields.has(connection)) stepWhileShielding(connection, facing, target)
      await new Promise(resolve => setTimeout(resolve, 60))
    }
    const moved = connection.entity?.position.distanceTo(start) ?? 0
    if (moved >= 0.2) log('moved while blocking arrow', { distance: Number(moved.toFixed(2)), pursuing, retreating })
  } finally {
    impactGuards.delete(connection)
    lowerCombatShield(connection)
  }
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
  const weapon = bot.inventory.items()
    .filter(item => /_(sword|axe)$/.test(item.name))
    .sort((a, b) => gradeWeapon(b) - gradeWeapon(a) || toolDurability(b) - toolDurability(a))[0]
  if (weapon && bot.heldItem?.slot !== weapon.slot) await bot.equip(weapon, 'hand')
  await equipCombatShield(bot)
}

function meleeCooldown(item) {
  if (!item?.name.endsWith('_axe')) return 650
  if (/^(golden|diamond|netherite)_/.test(item.name)) return 1050
  return item.name.startsWith('iron_') ? 1150 : 1250
}

function inventoryItemCount(name) {
  return bot.inventory.items()
    .filter(item => item.name === name)
    .reduce((sum, item) => sum + item.count, 0)
}

function backpackSlots(window) {
  return window.slots.slice(window.inventoryStart, window.inventoryEnd)
}

function freeBackpackSlots(window) {
  return backpackSlots(window).filter(item => !item).length
}

function discardCandidates(connection, window, keep) {
  const items = backpackSlots(window).filter(Boolean)
  const toolStone = items.reduce((sum, item) => sum + (STONE_DROPS.has(item.name) ? item.count : 0), 0)
  const heldSlot = window.hotbarStart + connection.quickBarSlot
  const reserves = INVENTORY_RESERVES.map(([names, minimum]) => ({ names, minimum,
    count: items.reduce((total, item) => total + (names.has(item.name) ? item.count : 0), 0) }))
  const equipment = connection.inventory.slots.filter(Boolean)
  const reservingBaseGear = supplyBase.active(connection)
  const obsolete = item => {
    if (item.enchants?.length || (reservingBaseGear && supplyBase.keeps(item))) return false
    const [material, type] = item.name.split('_')
    const armorIndex = ARMOR_SLOTS.findIndex(([, kind]) => kind === type)
    if (armorIndex >= 0 && ARMOR_DEFENSE[material]) {
      const worn = connection.inventory.slots[connection.getEquipmentDestSlot(ARMOR_SLOTS[armorIndex][0])]
      return toolDurability(worn) > 16 && armorScore(worn, armorIndex) > armorScore(item, armorIndex)
    }
    const tier = TOOL_TIER[material]
    if (tier === undefined || !['pickaxe', 'axe', 'sword', 'shovel', 'hoe'].includes(type)) return false
    return equipment.some(other => other.name.endsWith(`_${type}`) &&
      TOOL_TIER[other.name.split('_')[0]] > tier && toolDurability(other) > 16)
  }
  return items.filter(item => !keep.has(item.name) && item.slot !== heldSlot)
    .flatMap(item => {
      if (DEBRIS.has(item.name)) return [{ item, priority: 0 }]
      if (obsolete(item)) return [{ item, priority: 1 }]
      const reserve = reserves.find(entry => entry.names.has(item.name))
      if (reserve && reserve.count - item.count >= reserve.minimum &&
          (!STONE_DROPS.has(item.name) || toolStone - item.count >= 32)) return [{ item, priority: 2 }]
      return []
    }).sort((a, b) => a.priority - b.priority || a.item.count - b.item.count)
}

function droppedStack(entity) {
  try { return entity.getDroppedItem() } catch { return null }
}

function aimAwayFromWork(connection) {
  const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
  const work = currentMineTarget || committedMineTarget?.position || navigationState.target
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => {
    const ray = new Vec3(x, 0, z)
    const hit = connection.world.raycast(eyes, ray, 3)
    const open = hit?.intersect?.distanceTo(eyes) ?? 3
    const away = work ? -Math.sign((work.x - eyes.x) * x + (work.z - eyes.z) * z) : 0
    return { ray, open, score: open + away * 0.35 }
  }).sort((a, b) => b.score - a.score)
  return directions[0].open >= 0.8 ? eyes.plus(directions[0].ray.scaled(2)) : null
}

function discardTileCost(connection, block) {
  const position = block?.position
  const pile = discardPiles.get(connection)
  if (!position || !pile?.size) return 0
  for (const item of pile) {
    if (item.position && Math.abs(item.position.y - position.y) < 1.4 &&
        Math.hypot(item.position.x - position.x - 0.5, item.position.z - position.z - 0.5) < 1.05) return 8
  }
  return 0
}

async function clearBackpack(connection, reason, { duringMining = false, window = connection.inventory, keep = new Set() } = {}) {
  const originalFree = freeBackpackSlots(window)
  const repicked = repickedDiscards.get(connection)
  if (originalFree >= 2 && !repicked?.size) return originalFree
  const ready = () => canWorkHere(connection, duringMining) && !isEating && !isDiggingBlock && !fleeingActive &&
    !damageInterruptActive(connection) && !closeCombatPlan() && !window.selectedItem &&
    (connection.currentWindow || connection.inventory) === window
  const discarded = []
  for (let attempt = 0; attempt < 3 && ready(); attempt += 1) {
    const candidates = discardCandidates(connection, window, keep)
    const entry = candidates.find(({ item }) => repicked?.has(item.name)) ||
      (originalFree < 2 && freeBackpackSlots(window) < 3 ? candidates[0] : null)
    if (!entry) break
    const { item } = entry
    const nearbyBefore = new Set(findNearbyDrops(4).map(({ entity }) => entity.id))
    try {
      if (!discarded.length) {
        const aim = aimAwayFromWork(connection)
        if (aim) await connection.lookAt(aim, true)
        if (!ready() || window.slots[item.slot] !== item) break
      }
      // Mode 4 with right mouse button discards one whole stack in a single click.
      await connection.clickWindow(item.slot, 1, 4)
      await new Promise(resolve => setTimeout(resolve, 150))
      if (connection !== bot || !connection.entity || (connection.currentWindow || connection.inventory) !== window || window.slots[item.slot]) break
      for (const { entity } of findNearbyDrops(4)) {
        if (!nearbyBefore.has(entity.id) && droppedStack(entity)?.type === item.type) {
          discardedEntities.add(entity)
          discardPiles.get(connection)?.add(entity)
        }
      }
      repicked?.delete(item.name)
      discarded.push({ item: item.name, count: item.count })
    } catch (error) {
      log('inventory cleanup interrupted', { reason, item: item.name, message: error.message })
      break
    }
  }
  const freeSlots = freeBackpackSlots(window)
  if (discarded.length) log('inventory cleared', { reason, discarded, freeBefore: originalFree, freeAfter: freeSlots })
  else if (freeSlots === 0 && ready() && Date.now() >= inventoryFullNoticeAt) {
    inventoryFullNoticeAt = Date.now() + 15000
    log('inventory full; protected items kept', { reason })
  }
  return freeSlots
}

async function craftNamed(name, table = null) {
  const connection = bot
  const item = mcData?.itemsByName?.[name]
  if (!item) return false
  const inventory = connection.inventory
  for (let attempt = 0; attempt < 3 && canWorkHere(connection); attempt += 1) {
    if (connection.currentWindow) connection.closeWindow(connection.currentWindow)
    await clearBackpack(connection, 'crafting')
    await connection._syncWindow?.(inventory)
    // Clear inputs left in the backpack crafting grid after a refused click.
    if (inventory.selectedItem) {
      const empty = inventory.firstEmptyInventorySlot()
      if (empty == null) return false
      await connection.clickWindow(empty, 0, 0)
    }
    for (let slot = 1; slot <= 4; slot += 1) {
      if (inventory.slots[slot]) await connection.clickWindow(slot, 0, 1)
    }
    const recipe = connection.recipesFor(item.id, null, 1, table)[0]
    if (!recipe || !canWorkHere(connection)) return false
    const before = inventoryItemCount(name)
    let error
    try {
      await connection.craft(recipe, 1, table)
    } catch (failure) {
      error = failure
    }
    await connection._syncWindow?.(inventory)
    if (connection !== bot) return false
    const gained = inventoryItemCount(name) - before
    if (gained >= recipe.result.count) {
      log('crafted', { item: name, count: gained })
      return true
    }
    log('craft result not confirmed', { item: name, gained, attempt: attempt + 1, message: error?.message })
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return false
}

const TABLE_NAME = 'crafting_table'
const TABLE_NAMES = new Set([TABLE_NAME])
const FURNACE_NAME = 'furnace'
const FURNACE_NAMES = new Set([FURNACE_NAME])
const TABLE_TOP = new Vec3(0, 1, 0)
const EMPTY_BLOCK = /^(air|cave_air|void_air)$/

function canWorkHere(connection, duringMining = false) {
  return connection === bot && botEnabled && connection?.entity && connection.health > 0 &&
    !emergencyRetreating && !waterOwnsMovement() && (!mineBusy || duringMining)
}

function plankCount() {
  return bot.inventory.items().reduce((sum, item) => sum + (item.name.endsWith('_planks') ? item.count : 0), 0)
}

async function makePlanksFor(required, exact = null) {
  while ((exact ? inventoryItemCount(exact) : plankCount()) < required) {
    const logItem = bot.inventory.items().find(item => LOG_NAMES.has(item.name) &&
      (!exact || item.name.replace(/_log$/, '_planks') === exact))
    if (!logItem || !await craftNamed(logItem.name.replace(/_log$/, '_planks'))) return false
  }
  return true
}

function isTableSite(connection, position) {
  const support = connection.blockAt(position.offset(0, -1, 0))
  const isSolidSupport = support?.shapes?.some(shape => shape[0] === 0 && shape[1] === 0 && shape[2] === 0 &&
    shape[3] === 1 && shape[4] === 1 && shape[5] === 1) || support?.boundingBox === 'block'
  return Boolean(isSolidSupport &&
    !movements.interactableBlocks.has(support.name) && !movements.blocksToAvoid.has(support.type) &&
    EMPTY_BLOCK.test(connection.blockAt(position)?.name))
}

let lastTorchAttemptAt = 0

async function maybePlaceTorch(duringMining = false) {
  const connection = bot
  if (!canWorkHere(connection, duringMining) || isSmelting || isEating || isDiggingBlock ||
      !connection.entity.onGround || furnaceThreat() || Date.now() - lastTorchAttemptAt < 1500) return false
  const torch = connection.inventory.items().find(item => item.name === 'torch')
  if (!torch) return false
  const feet = connection.entity.position.floored()
  const current = connection.blockAt(feet)
  if (!current || !Number.isFinite(current.light) || !Number.isFinite(current.skyLight)) return false
  const sky = Math.max(0, current.skyLight - (connection.time.isDay ? 0 : 11))
  const light = Math.max(current.light, sky)
  if (light >= 8) return false
  lastTorchAttemptAt = Date.now()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const position = feet.offset(dx, 0, dz)
    if (!isTableSite(connection, position)) continue
    const support = connection.blockAt(position.offset(0, -1, 0))
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const ray = position.offset(0.5, -0.02, 0.5).minus(eyes)
    if (!connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
    try {
      await connection.equip(torch, 'hand')
      if (!canWorkHere(connection, duringMining) || furnaceThreat()) return false
      await connection.placeBlock(support, TABLE_TOP)
      if (connection.blockAt(position)?.name !== 'torch') continue
      log('dark area torch placed', { position, light })
      return true
    } catch (error) {
      log('torch placement deferred', { position, message: error.message })
    }
  }
  return false
}

async function clearSpaceForCraftingTable(connection, base) {
  if (!connection?.entity || waterOwnsMovement() || emergencyRetreating) return false
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const candidates = []
  for (const [dx, dz] of directions) {
    const pos = base.offset(dx, 0, dz)
    const support = connection.blockAt(pos.offset(0, -1, 0))
    if (!support || (support.boundingBox !== 'block' && !support.shapes?.some(shape =>
      shape[0] === 0 && shape[1] === 0 && shape[2] === 0 && shape[3] === 1 && shape[4] === 1 && shape[5] === 1))) continue
    const block = connection.blockAt(pos)
    if (!block) continue
    if (EMPTY_BLOCK.test(block.name)) {
      const above = connection.blockAt(pos.offset(0, 1, 0))
      if (above && above.boundingBox === 'block' && TUNNEL_SAFE_BLOCKS.has(above.name) && connection.canDigBlock(above)) {
        candidates.push({ pos, toDig: [above], cost: 1 })
      }
      continue
    }
    if (TUNNEL_SAFE_BLOCKS.has(block.name) && connection.canDigBlock(block)) {
      const above = connection.blockAt(pos.offset(0, 1, 0))
      const toDig = [block]
      if (above && above.boundingBox === 'block' && TUNNEL_SAFE_BLOCKS.has(above.name) && connection.canDigBlock(above)) {
        toDig.push(above)
      }
      const isSoft = /^(dirt|grass_block|sand|gravel|podzol|coarse_dirt)$/.test(block.name)
      candidates.push({ pos, toDig, cost: isSoft ? 1 : 5 })
    }
  }
  candidates.sort((a, b) => a.cost - b.cost)
  for (const candidate of candidates) {
    try {
      for (const b of candidate.toDig) {
        if (!connection.canDigBlock(b)) continue
        await equipBestToolFor(b)
        log('digging clearance for crafting table', { block: b.name, position: b.position })
        await connection.dig(b, true)
      }
      return true
    } catch (error) {
      log('clearance dig failed', { position: candidate.pos, message: error.message })
    }
  }
  return false
}

async function ensureCraftingTable(allowRelocate = true) {
  const connection = bot
  if (!canWorkHere(connection)) return null
  const table = findNearestBlock(TABLE_NAMES, 4)
  if (table && table.position.offset(0.5, 0.5, 0.5).distanceTo(connection.entity.position.offset(0, 1.62, 0)) <= 4) {
    if (connection.canSeeBlock(table)) {
      const old = deferredCraftingTables.findIndex(entry => entry.dimension === connection.game.dimension &&
        entry.position.equals(table.position))
      if (!temporaryCraftingTable && old >= 0) temporaryCraftingTable = deferredCraftingTables.splice(old, 1)[0]
      return table
    }
  }
  if (temporaryCraftingTable) {
    deferredCraftingTables.push(temporaryCraftingTable)
    log('distant crafting table deferred', { position: temporaryCraftingTable.position })
    temporaryCraftingTable = null
  }
  if (inventoryItemCount(TABLE_NAME) === 0 && !await makePlanksFor(4)) return null
  if (inventoryItemCount(TABLE_NAME) === 0 && !await craftNamed(TABLE_NAME)) return null
  const held = bot.inventory.items().find(item => item.name === TABLE_NAME)
  if (!held) return null
  const base = connection.entity.position.floored()
  const spots = []
  for (const y of [0, -1, 1, -2, 2]) {
    for (let x = -3; x <= 3; x += 1) {
      for (let z = -3; z <= 3; z += 1) {
        if (x === 0 && z === 0) continue
        spots.push(base.offset(x, y, z))
      }
    }
  }
  spots.sort((a, b) => a.distanceTo(base) - b.distanceTo(base))
  for (const position of spots) {
    if (!canWorkHere(connection)) return null
    if (!isTableSite(connection, position)) continue
    const support = connection.blockAt(position.offset(0, -1, 0))
    const hit = position.offset(0.5, -0.02, 0.5)
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const ray = hit.minus(eyes)
    if (ray.norm() > 4 || !connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
    try {
      await connection.equip(held, 'hand')
      if (!canWorkHere(connection)) return null
      await connection.placeBlock(support, TABLE_TOP)
    } catch (error) {
      log('crafting table placement skipped', { position, message: error.message })
    }
    const placed = connection.blockAt(position)
    if (placed?.name === TABLE_NAME) {
      temporaryCraftingTable = { position, dimension: connection.game.dimension, broken: false }
      log('temporary crafting table placed', { position })
      return placed
    }
    if (!connection.inventory.items().some(item => item.name === TABLE_NAME)) return null
  }
  if (allowRelocate && canWorkHere(connection)) {
    const groundNames = new Set(['grass_block', 'dirt', 'coarse_dirt', 'stone', 'sand', 'podzol', 'moss_block'])
    const candidates = connection.findBlocks({
      maxDistance: 14,
      count: 16,
      matching: block => groundNames.has(block.name),
      useExtraInfo: block => isTableSite(connection, block.position.offset(0, 1, 0)) &&
        [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => isTableSite(connection, block.position.offset(x, 1, z))),
    })
    if (candidates.length) {
      const goal = new goals.GoalCompositeAny(candidates.map(({ x, y, z }) => new goals.GoalBlock(x, y + 1, z)))
      try {
        await gotoWithTimeout(goal, 'crafting table ground', 6000)
        return await ensureCraftingTable(false)
      } catch (error) {
        log('crafting table relocation failed', { message: error.message })
      }
    }
  }
  if (canWorkHere(connection)) {
    const cleared = await clearSpaceForCraftingTable(connection, base)
    if (cleared) {
      return await ensureCraftingTable(false)
    }
  }
  log('crafting table placement skipped', { message: 'no reachable clear space beside the bot' })
  return null
}

async function pickUpBlockDrop(names, position, countBefore, duringMining = false) {
  const connection = bot
  for (let attempt = 0; attempt < 2 && canWorkHere(connection, duringMining); attempt += 1) {
    // Drops usually fly into reach within ~150ms; the old fixed 400ms wait was
    // the visible "hitch" after every block. Poll briefly instead of sleeping.
    const waitUntil = Date.now() + (attempt === 0 ? 200 : 400)
    while (Date.now() < waitUntil && inventoryCount(names) <= countBefore) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    if (!canWorkHere(connection, duringMining)) return false
    if (inventoryCount(names) > countBefore) return true
    await clearBackpack(connection, 'block-drop', { duringMining, keep: names })
    const drop = findNearbyDrops(8).find(({ entity }) => {
      if (entity.position.distanceTo(position.offset(0.5, 0.5, 0.5)) > 4) return false
      try { return names.has(entity.getDroppedItem()?.name) } catch { return false }
    })?.entity
    if (drop) {
      const feet = drop.position.offset(0, 0.05, 0).floored()
      try {
        await gotoWithTimeout(new goals.GoalBlock(feet.x, feet.y, feet.z), 'drop pickup', 2500)
      } catch (error) {
        log('drop approach interrupted', { position: feet, message: error.message })
      }
    }
  }
  await new Promise(resolve => setTimeout(resolve, 250))
  return connection === bot && inventoryCount(names) > countBefore
}

async function reclaimTemporaryCraftingTable() {
  const pending = temporaryCraftingTable
  const connection = bot
  if (!pending || !canWorkHere(connection) || pending.dimension !== connection.game.dimension) return false
  const { position } = pending
  try {
    if (!pending.broken) {
      let table = connection.blockAt(position)
      if (!table) return false
      if (table.name !== TABLE_NAME) {
        temporaryCraftingTable = null
        return false
      }
      if (!connection.canDigBlock(table) || !connection.canSeeBlock(table)) {
        await gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world), 'crafting table reclaim path', 5000)
        table = connection.blockAt(position)
      }
      if (!canWorkHere(connection) || table?.name !== TABLE_NAME || !connection.canDigBlock(table) ||
          !connection.canSeeBlock(table)) return false
      await clearBackpack(connection, 'crafting-table-recovery')
      pending.countBefore = inventoryItemCount(TABLE_NAME)
      await equipBestToolFor(table)
      if (!canWorkHere(connection)) return false
      let timer
      try {
        const tableDigTime = Math.max(250, Number(connection.digTime(table) || 1000))
        const tableTimeout = Math.max(8000, Math.ceil(tableDigTime * 2) + 3000)
        await Promise.race([
          connection.dig(table, true),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('crafting table dig timeout'))
              if (connection.targetDigBlock?.position.equals(position)) connection.stopDigging()
            }, tableTimeout)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (connection.blockAt(position)?.name === TABLE_NAME) return false
      pending.broken = true
    }
    if (!await pickUpBlockDrop(TABLE_NAMES, position, pending.countBefore)) {
      log('crafting table pickup pending', { position })
      return false
    }
    temporaryCraftingTable = null
    log('temporary crafting table reclaimed', { position })
    persistExperience({ cycle, action: 'reclaim-table', experience: '工具合成完成后拆下临时工作台，已确认工作台进入背包' })
    return true
  } catch (error) {
    log('crafting table reclaim failed', { position, message: error.message })
    persistExperience({ cycle, action: 'reclaim-table', experience: `临时工作台回收失败：${error.message}` })
    return false
  }
}

const deferredCraftingTables = []
let temporaryFurnace = null
let pendingFurnaceBatch = null
let pendingIronWorkshop = null

async function ensureFurnace(stations = null) {
  const connection = bot
  if (!canWorkHere(connection)) return null
  if (!stations) {
    const existing = findNearestBlock(FURNACE_NAMES, 4)
    if (furnaceReachable(connection, existing) && !supplyBase.owns(connection, existing.position)) return existing
    if (temporaryFurnace) return null
  }
  // A furnace broken without a pickaxe will not drop as an item.
  if (!hasTool('pickaxe')) return null

  // Ensure we have a furnace in inventory:
  if (inventoryItemCount(FURNACE_NAME) === 0) {
    if (inventoryCount(STONE_DROPS) < 8) {
      log('cannot craft furnace; need 8 cobblestone', { cobblestone: inventoryCount(STONE_DROPS) })
      return null
    }
    const table = await ensureCraftingTable(!stations?.length)
    if (!table) return null
    const crafted = await craftNamed(FURNACE_NAME, table)
    if (!crafted && inventoryItemCount(FURNACE_NAME) === 0) return null
  }

  const held = bot.inventory.items().find(item => item.name === FURNACE_NAME)
  if (!held) return null

  const base = connection.entity.position.floored()
  const spots = []
  for (const y of [0, -1, 1, -2, 2]) {
    for (let x = -3; x <= 3; x += 1) {
      for (let z = -3; z <= 3; z += 1) {
        if (x === 0 && z === 0) continue
        spots.push(base.offset(x, y, z))
      }
    }
  }
  spots.sort((a, b) => a.distanceTo(base) - b.distanceTo(base))
  for (const position of spots) {
    if (!canWorkHere(connection)) return null
    if (!isTableSite(connection, position)) continue
    const support = connection.blockAt(position.offset(0, -1, 0))
    const hit = position.offset(0.5, -0.02, 0.5)
    const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    const ray = hit.minus(eyes)
    if (ray.norm() > 4 || !connection.world.raycast(eyes, ray.unit(), ray.norm())?.position.equals(support.position)) continue
    try {
      await connection.equip(held, 'hand')
      if (!canWorkHere(connection)) return null
      await connection.placeBlock(support, TABLE_TOP)
    } catch (error) {
      log('furnace placement skipped', { position, message: error.message })
    }
    const placed = connection.blockAt(position)
    if (placed?.name === FURNACE_NAME) {
      const fixture = { position, dimension: connection.game.dimension, broken: false }
      if (stations) stations.push(fixture)
      else temporaryFurnace = fixture
      log('temporary furnace placed', { position })
      return placed
    }
    if (!connection.inventory.items().some(item => item.name === FURNACE_NAME)) return null
  }
  log('furnace placement skipped: no clear spot found')
  return null
}

async function reclaimTemporaryFurnace(pending = temporaryFurnace) {
  if (!pending) return true
  const connection = bot
  if (pendingFurnaceBatch || !canWorkHere(connection) || connection.game.dimension !== pending.dimension) return false
  const position = new Vec3(pending.position.x, pending.position.y, pending.position.z)
  try {
    if (!pending.broken) {
      const furnace = connection.blockAt(position)
      if (!furnace) return false
      if (furnace.name !== FURNACE_NAME) {
        if (temporaryFurnace === pending) temporaryFurnace = null
        return true
      }
      pending.countBefore = inventoryItemCount(FURNACE_NAME)
      const pickaxe = connection.inventory.items().find(item => item.name.endsWith('_pickaxe'))
      if (!pickaxe) return false
      await clearBackpack(connection, 'furnace-recovery')
      const inventory = connection.inventory
      const room = inventory.slots.slice(inventory.inventoryStart, inventory.inventoryEnd)
        .some(item => !item || (item.name === FURNACE_NAME && item.count < item.stackSize))
      if (!room) {
        log('furnace reclaim deferred; inventory full', { position })
        return false
      }
      await connection.equip(pickaxe, 'hand')
      if (!canWorkHere(connection) || !connection.heldItem?.name.endsWith('_pickaxe')) return false
      let timer
      try {
        const digTime = Math.max(500, Number(connection.digTime(furnace) || 1500))
        const timeoutMs = Math.max(10000, Math.ceil(digTime * 2) + 4000)
        await Promise.race([
          connection.dig(furnace, true),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error('furnace dig timeout'))
              if (connection.targetDigBlock?.position.equals(position)) connection.stopDigging()
            }, timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      if (connection.blockAt(position)?.name === FURNACE_NAME) return false
      pending.broken = true
    }
    if (!await pickUpBlockDrop(FURNACE_NAMES, position, pending.countBefore)) {
      log('furnace pickup pending', { position })
      return false
    }
    if (temporaryFurnace === pending) temporaryFurnace = null
    log('temporary furnace reclaimed', { position })
    persistExperience({ cycle, action: 'reclaim-furnace', experience: '冶炼完成后使用镐子拆下并捡回熔炉' })
    return true
  } catch (error) {
    log('furnace reclaim failed', { position, message: error.message })
    return false
  }
}

function furnaceFuelSeconds(item) {
  if (!item) return 0
  if (item.name === 'coal' || item.name === 'charcoal') return 80
  if (item.name === 'stick') return 5
  if (/_(planks|log|wood)$/.test(item.name)) return 15
  return 0
}

function furnaceInventory(window) {
  return window.slots.slice(window.inventoryStart, window.inventoryEnd)
}

async function takeFurnaceSlot(connection, window, read, take, slot) {
  let item = window[read]()
  if (!item) return 0
  if (connection.currentWindow !== window) throw new Error('furnace window was closed')
  await clearBackpack(connection, 'furnace-contents', { window, keep: new Set([item.name]) })
  if (connection.currentWindow !== window) throw new Error('furnace window was closed')
  item = window[read]()
  if (!item) return 0
  const room = furnaceInventory(window).reduce((total, stack) => {
    if (!stack) return total + item.stackSize
    return total + (item.constructor.equal(item, stack, false, true) ? stack.stackSize - stack.count : 0)
  }, 0)
  if (room < item.count) throw new Error('inventory has no room for furnace ' + slot)
  await window[take]()
  const remaining = window[read]()
  if (remaining) throw new Error('furnace ' + slot + ' did not clear')
  return item.count
}

async function drainFurnace(connection, window) {
  const recovered = { input: 0, output: 0, fuel: 0 }
  // Take input first to stop the furnace making more output during cleanup.
  for (const [slot, read, take] of [
    ['input', 'inputItem', 'takeInput'],
    ['output', 'outputItem', 'takeOutput'],
    ['fuel', 'fuelItem', 'takeFuel'],
  ]) {
    try {
      recovered[slot] = await takeFurnaceSlot(connection, window, read, take, slot)
    } catch (error) {
      log('furnace slot recovery deferred', { slot, message: error.message })
    }
  }
  return recovered
}

function furnaceReachable(connection, block) {
  return block?.name === FURNACE_NAME &&
    block.position.offset(0.5, 0.5, 0.5).distanceTo(connection.entity.position.offset(0, 1.62, 0)) <= 4 &&
    connection.canSeeBlock(block)
}

function furnaceThreat() {
  const hostile = findNearestHostile(8)
  return hostile && hostileSight(hostile).visible
}

async function finishFurnaceWork(connection, openWindow = null, mayApproach = false) {
  const pending = pendingFurnaceBatch || temporaryFurnace
  if (!pending || !canWorkHere(connection) || connection.game.dimension !== pending.dimension || furnaceThreat()) return false
  const { position } = pending
  let window = openWindow
  try {
    let block = connection.blockAt(position)
    if (mayApproach && !furnaceReachable(connection, block) && !temporaryFurnace?.broken) {
      await gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world), 'furnace recovery path', 6000)
      block = connection.blockAt(position)
    }
    if (!canWorkHere(connection) || furnaceThreat()) return false
    if (pendingFurnaceBatch) {
      if (block && block.name !== FURNACE_NAME) {
        log('furnace batch block missing', { position })
        pendingFurnaceBatch = null
      } else {
        if (connection.currentWindow !== window) window = null
        if (!window) {
          if (!furnaceReachable(connection, block)) return false
          window = await connection.openFurnace(block)
        }
        const recovered = await drainFurnace(connection, window)
        pendingFurnaceBatch.collected += recovered.output
        log('furnace contents recovered', { position, ...recovered })
        if (window.inputItem() || window.outputItem() || window.fuelItem()) return false
        pendingFurnaceBatch = null
      }
    }
  } catch (error) {
    log('furnace cleanup deferred', { position, message: error.message })
    return false
  } finally {
    if (window && connection.currentWindow === window) window.close()
  }
  return reclaimTemporaryFurnace()
}

async function processFurnaceBatch(inputNames, outputEvent, timeLimit, acceptsFuel = () => true, maxInput = Infinity) {
  const connection = bot
  if (!canWorkHere(connection) || isSmelting || pendingFurnaceBatch || temporaryFurnace || pendingIronWorkshop) return false
  if (!connection.inventory.items().some(item => inputNames.has(item.name)) ||
      !connection.inventory.items().some(item => acceptsFuel(item) && furnaceFuelSeconds(item) > 0) || furnaceThreat()) return false

  isSmelting = true
  mineMode = false
  let window = null
  let batch = null
  try {
    const block = await ensureFurnace()
    if (!block || !canWorkHere(connection)) return false
    window = await connection.openFurnace(block)
    // Borrow an existing furnace only if the player has left it empty.
    if (window.inputItem() || window.outputItem() || window.fuelItem()) {
      log('furnace batch skipped; furnace slots are occupied', { position: block.position })
      return false
    }
    const raw = furnaceInventory(window).find(item => item && inputNames.has(item.name))
    if (!raw) return false
    batch = { position: block.position, dimension: connection.game.dimension, collected: 0 }
    pendingFurnaceBatch = batch
    const batchSize = Math.min(raw.count, maxInput)
    await window.putInput(raw.type, null, batchSize)
    log('furnace batch started', { item: raw.name, count: batchSize, position: block.position })
    const deadline = Date.now() + Math.min(timeLimit, batchSize * 11000 + 5000)
    while (Date.now() < deadline && canWorkHere(connection) && connection.currentWindow === window) {
      if (furnaceThreat()) {
        log('furnace batch interrupted by nearby threat')
        break
      }
      batch.collected += await takeFurnaceSlot(connection, window, 'outputItem', 'takeOutput', 'output')
      const input = window.inputItem()
      if (!input) break
      const burning = connection.blockAt(block.position)?.getProperties().lit ?? ((window.fuel ?? 0) > 0)
      if (!window.fuelItem() && !burning) {
        const fuel = furnaceInventory(window).filter(Boolean)
          .filter(item => acceptsFuel(item) && furnaceFuelSeconds(item) > 0)
          .sort((a, b) => furnaceFuelSeconds(b) - furnaceFuelSeconds(a) ||
            Number(b.name === 'coal') - Number(a.name === 'coal'))[0]
        if (!fuel) {
          log('furnace fuel exhausted; recovering unprocessed input', { remaining: input.count })
          break
        }
        const count = Math.min(fuel.count, Math.ceil(input.count * 10 / furnaceFuelSeconds(fuel)))
        await window.putFuel(fuel.type, null, count)
        log('replenished furnace fuel', { item: fuel.name, count, remaining: input.count })
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }
  } catch (error) {
    log('furnace batch interrupted', { message: error.message })
  } finally {
    try {
      await finishFurnaceWork(connection, window)
    } finally {
      if (window && connection.currentWindow === window) window.close()
      isSmelting = false
    }
  }
  if (!batch?.collected) return false
  log(outputEvent, { count: batch.collected })
  return true
}

const IRON_INPUT_NAMES = new Set(['raw_iron', 'iron_ore', 'deepslate_iron_ore'])
const IRON_FUEL_NAMES = new Set(['coal', 'charcoal'])

async function withIronFurnace(connection, station, visit) {
  const block = connection.blockAt(station.position)
  if (!canWorkHere(connection) || furnaceThreat() || !furnaceReachable(connection, block)) return false
  const window = await connection.openFurnace(block)
  try {
    return await visit(window)
  } finally {
    if (connection.currentWindow === window) window.close()
  }
}

async function recoverIronWorkshop(connection, mayApproach = false) {
  const workshop = pendingIronWorkshop
  if (!workshop || !canWorkHere(connection) || workshop.dimension !== connection.game.dimension || furnaceThreat()) return false
  for (const station of [...workshop.stations]) {
    if (!canWorkHere(connection) || furnaceThreat()) break
    try {
      let block = connection.blockAt(station.position)
      if (mayApproach && !station.broken && !furnaceReachable(connection, block)) {
        await gotoWithTimeout(new goals.GoalLookAtBlock(station.position, connection.world), 'iron workshop recovery path', 6000)
        block = connection.blockAt(station.position)
      }
      if (!canWorkHere(connection) || furnaceThreat()) break
      if (station.loaded && !station.broken && (!block || block.name === FURNACE_NAME)) {
        const cleared = await withIronFurnace(connection, station, async window => {
          const recovered = await drainFurnace(connection, window)
          workshop.collected += recovered.output
          log('furnace contents recovered', { position: station.position, ...recovered })
          return !window.inputItem() && !window.outputItem() && !window.fuelItem()
        })
        if (!cleared) continue
        station.loaded = false
      }
      if (await reclaimTemporaryFurnace(station)) workshop.stations.splice(workshop.stations.indexOf(station), 1)
    } catch (error) {
      log('iron workshop recovery deferred', { position: station.position, message: error.message })
    }
  }
  if (workshop.stations.length) return false
  pendingIronWorkshop = null
  log('iron workshop recovered', { collected: workshop.collected })
  return true
}

async function smeltRawIron() {
  const connection = bot
  if (!canWorkHere(connection) || isSmelting || pendingFurnaceBatch || temporaryFurnace || pendingIronWorkshop || furnaceThreat() || foodRecoveryNeeded()) return false
  const rawCount = inventoryCount(IRON_INPUT_NAMES)
  const fuelCount = inventoryCount(IRON_FUEL_NAMES)
  if (!rawCount || !fuelCount) return false
  const stations = []
  const workshop = { dimension: connection.game.dimension, stations, collected: 0 }
  pendingIronWorkshop = workshop
  isSmelting = true
  mineMode = false
  let crafted = false
  try {
    const count = Math.min(3, Math.ceil(rawCount / 8), fuelCount)
    while (stations.length < count && !furnaceThreat()) {
      if (!await ensureFurnace(stations)) break
    }
    let longestBatch = 0
    for (let i = 0; i < stations.length; i += 1) {
      const station = stations[i]
      await withIronFurnace(connection, station, async window => {
        if (window.inputItem() || window.outputItem() || window.fuelItem()) return
        const items = furnaceInventory(window).filter(Boolean)
        const raw = items.find(item => IRON_INPUT_NAMES.has(item.name))
        const coal = items.find(item => item.name === 'coal') || items.find(item => item.name === 'charcoal')
        if (!raw || !coal) return
        const totalRemaining = inventoryCount(IRON_INPUT_NAMES)
        const remainingStations = stations.length - i
        const portion = Math.min(raw.count, Math.ceil(totalRemaining / remainingStations), coal.count * 8,
          Math.max(1, inventoryCount(IRON_FUEL_NAMES) - remainingStations + 1) * 8)
        station.loaded = true
        await window.putFuel(coal.type, null, Math.ceil(portion / 8))
        await window.putInput(raw.type, null, portion)
        longestBatch = Math.max(longestBatch, portion)
        log('iron furnace started', { position: station.position, input: raw.name, count: portion, fuel: coal.name })
      })
    }
    log('iron workshop started', { furnaces: stations.filter(station => station.loaded).length, rawCount })
    const deadline = Date.now() + longestBatch * 11000 + 8000
    while (longestBatch && Date.now() < deadline && canWorkHere(connection) && !furnaceThreat() && !foodRecoveryNeeded()) {
      let running = false
      for (const station of stations.filter(entry => entry.loaded)) {
        const result = await withIronFurnace(connection, station, async window => {
          const collected = await takeFurnaceSlot(connection, window, 'outputItem', 'takeOutput', 'output')
          if (collected) {
            workshop.collected += collected
            log('iron furnace output collected', { position: station.position, count: collected })
          }
          return { running: Boolean(window.inputItem()) }
        })
        running ||= Boolean(result?.running)
      }
      if (!furnaceThreat()) crafted = (await craftAvailableGear(false)) || crafted
      if (!running) break
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
  } catch (error) {
    log('iron workshop interrupted', { message: error.message })
  } finally {
    try { await recoverIronWorkshop(connection) } finally { isSmelting = false }
  }
  if (workshop.collected) log('collected smelted iron ingots from furnace', { count: workshop.collected })
  return crafted || workshop.collected > 0
}

function armorScore(item, index) {
  const [material, kind] = item?.name.split('_') ?? []
  const defense = ARMOR_DEFENSE[material]?.[index]
  if (kind !== ARMOR_SLOTS[index][1] || !defense || toolDurability(item) <= 0) return -1
  const toughness = material === 'netherite' ? 3 : material === 'diamond' ? 2 : 0
  const protection = item.enchants?.find(enchant => /(^|:)protection$/.test(enchant.name ?? ''))?.lvl ?? 0
  return defense + toughness * 0.35 + protection * 0.6
}

async function autoEquipArmor(duringMining = false) {
  const connection = bot
  const safe = () => canWorkHere(connection, duringMining) && !connection.currentWindow &&
    !connection.inventory.selectedItem && !isEating && !isDiggingBlock && !fleeingActive && !closeCombatPlan()
  if (!safe()) return
  for (const [index, [destination, kind]] of ARMOR_SLOTS.entries()) {
    if (!safe()) return
    const slot = connection.getEquipmentDestSlot(destination)
    const current = connection.inventory.slots[slot]
    const best = connection.inventory.items().filter(item => item.name.endsWith(`_${kind}`) &&
      armorScore(item, index) >= 0 && toolDurability(item) > 2)
      .sort((a, b) => armorScore(b, index) - armorScore(a, index) || toolDurability(b) - toolDurability(a))[0]
    if (!best) continue
    if (armorScore(best, index) < armorScore(current, index) ||
        (armorScore(best, index) === armorScore(current, index) && toolDurability(best) <= toolDurability(current))) continue
    try {
      await connection.equip(best, destination)
      if (connection.inventory.slots[slot]?.name === best.name) log('auto equipped armor', { slot: destination, item: best.name })
    } catch (error) {
      log('armor swap deferred', { slot: destination, item: best.name, message: error.message })
    }
  }
}

function safeToEatOnRetreat(connection) {
  return connection === bot && connection?.entity && connection.health > 0 && !waterOwnsMovement() &&
    !nearbyThreatSignature().threats.some(({ id, distance, name }) => distance < 7 ||
      (distance < (RANGED_HOSTILES.has(name) ? 17 : 11) && connection.entities[id] && hostileSight(connection.entities[id]).visible))
}

async function eatFoodIfNeeded({ retreat = false } = {}) {
  const connection = bot
  if (!connection?.entity || isEating || isDiggingBlock || isSmelting ||
      (!retreat && (emergencyRetreating || fleeingActive)) || (retreat && !safeToEatOnRetreat(connection)) ||
      meleeConnection === connection || raisedShields.has(connection) || impactGuards.has(connection)) return false
  const currentFood = Number(connection.food ?? 20)
  const currentHealth = Number(connection.health ?? 20)
  if (currentFood >= 18 && currentHealth >= 20) return false

  const restorative = item => /^(enchanted_)?golden_apple$/.test(item.name)
  const foods = getEdibleFoods().filter(item => currentFood < 20 || (retreat && currentHealth < 20 && restorative(item)))
  if (foods.length === 0) return false

  foods.sort((a, b) => {
    const fa = mcData?.foodsByName?.[a.name] || {}
    const fb = mcData?.foodsByName?.[b.name] || {}
    const cookedA = a.name.startsWith('cooked_') ? 10 : 0
    const cookedB = b.name.startsWith('cooked_') ? 10 : 0
    if (retreat && currentHealth <= 8 && restorative(a) !== restorative(b)) return restorative(a) ? -1 : 1
    return (cookedB + (fb.foodPoints || 0)) - (cookedA + (fa.foodPoints || 0))
  })

  const food = foods[0]
  isEating = true
  let safetyWatch
  try {
    stopPathfinder()
    await connection.equip(food, 'hand')
    if (connection !== bot || (retreat && !safeToEatOnRetreat(connection))) return false
    log(retreat ? 'retreat food stop' : 'eating food', { item: food.name, currentFood, health: currentHealth })
    if (retreat) {
      const danger = new Promise((_, reject) => {
        safetyWatch = setInterval(() => {
          if (safeToEatOnRetreat(connection)) return
          if (connection === bot) connection.deactivateItem()
          reject(new Error('追兵靠近，停止进食'))
        }, 100)
      })
      await Promise.race([connection.consume(), danger])
    } else await connection.consume()
    log('food consumed successfully', { item: food.name, newFood: connection.food, newHealth: connection.health, retreat })
    return true
  } catch (error) {
    log('eating failed', { item: food.name, message: error.message })
    return false
  } finally {
    clearInterval(safetyWatch)
    isEating = false
  }
}

async function restAfterRetreat(connection) {
  if (connection.health >= 20 || !safeToEatOnRetreat(connection)) return
  lowerCombatShield(connection)
  const ate = await eatFoodIfNeeded({ retreat: true })
  if (ate || connection.food >= 18) {
    const deadline = Date.now() + 4500
    while (Date.now() < deadline && connection.health < 20 && safeToEatOnRetreat(connection)) {
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
}

async function cookRawMeatInFurnace() {
  return processFurnaceBatch(RAW_MEAT_NAMES, 'collected cooked food from furnace', 30000)
}

function findNearestPassiveAnimal(maxDistance = 36) {
  if (!bot?.entity) return null
  const origin = bot.entity.position
  let nearest = null
  let bestDist = maxDistance
  for (const entity of Object.values(bot.entities)) {
    if (!entity || !entity.position) continue
    const name = String(entity.name || entity.displayName || '').toLowerCase().replaceAll(' ', '_')
    if (!PASSIVE_FOOD_ANIMALS.has(name)) continue
    const dist = entity.position.distanceTo(origin)
    if (dist < bestDist) {
      bestDist = dist
      nearest = entity
    }
  }
  return nearest
}

const VILLAGE_FOOD_BLOCKS = new Set(['wheat', 'hay_block'])

async function forageVillageBread() {
  const connection = bot
  if (!canWorkHere(connection) || closeCombatPlan()) return false
  let progress = false
  if (inventoryItemCount('hay_block') > 0) progress = await craftNamed('wheat')
  if (inventoryItemCount('wheat') < 3) {
    const crops = connection.findBlocks({ maxDistance: 28, count: 16,
      matching: block => block.name === 'hay_block' || (block.name === 'wheat' && Number(block.getProperties().age) === 7) })
    for (const position of crops.slice(0, 4)) {
      if (!canWorkHere(connection) || closeCombatPlan() || inventoryItemCount('wheat') >= 3) break
      const crop = connection.blockAt(position)
      if (!crop || !VILLAGE_FOOD_BLOCKS.has(crop.name) ||
          (crop.name === 'wheat' && Number(crop.getProperties().age) !== 7)) continue
      try {
        if (!connection.canDigBlock(crop) || !connection.canSeeBlock(crop)) {
          await gotoWithTimeout(new goals.GoalLookAtBlock(position, connection.world, { reach: 4.2 }), 'village crop path', 5000)
        }
        const drops = new Set([crop.name])
        const before = inventoryCount(drops)
        if (!canWorkHere(connection) || closeCombatPlan() || !await digWithExposure(crop, VILLAGE_FOOD_BLOCKS)) continue
        progress = (await pickUpBlockDrop(drops, position, before)) || progress
        if (crop.name === 'hay_block' && inventoryItemCount('hay_block')) progress = (await craftNamed('wheat')) || progress
        log('village crop harvested', { item: crop.name, position })
      } catch (error) {
        log('village crop unreachable', { position, message: error.message })
      }
    }
  }
  if (inventoryItemCount('wheat') < 3 || !canWorkHere(connection) || closeCombatPlan()) return progress
  try {
    const table = await ensureCraftingTable()
    if (!table) return progress
    while (canWorkHere(connection) && !closeCombatPlan() && inventoryItemCount('wheat') >= 3 &&
           inventoryItemCount('bread') < SURFACE_FOOD_TARGET) {
      if (!await craftNamed('bread', table)) break
      progress = true
    }
  } finally {
    await reclaimTemporaryCraftingTable()
  }
  return progress
}

function openSurfaceAt(connection, feet) {
  const at = connection.blockAt(feet.offset(0, 1, 0))
  return Number(at?.skyLight) >= 13 && walkableAt(feet.x, feet.y, feet.z) &&
    nightShelterTerrain(connection, feet) === 'open'
}

function foodReserve() {
  return getEdibleFoods().reduce((count, item) => count + (item.name === 'rotten_flesh' ? 0 : item.count), 0)
}

async function approachFoodSurface(connection) {
  if (!canWorkHere(connection) || closeCombatPlan() || connection.game?.dimension !== 'overworld') return
  const feet = connection.entity.position.floored()
  if (openSurfaceAt(connection, feet)) return

  lastDecision = 'surface-resupply'
  const known = lastDrySurface?.dimension === connection.game.dimension && lastDrySurface.feet.distanceTo(feet) <= 82
    ? lastDrySurface.feet : null
  log('food surface route started', { from: feet, knownSurface: known })
  surfaceRouteActive = true
  try {
    if (known) {
      await gotoWithTimeout(new goals.GoalBlock(known.x, known.y, known.z), 'resupply known surface', 15000).catch(() => {})
    }
    for (const rise of [8, 4, 2]) {
      if (!canWorkHere(connection) || closeCombatPlan()) return
      const currentFeet = connection.entity.position.floored()
      if (openSurfaceAt(connection, currentFeet)) break
      const maxY = connection.game.minY + connection.game.height - 2
      const goalY = Math.min(currentFeet.y + rise, maxY)
      if (goalY <= currentFeet.y) break
      const reached = await gotoWithTimeout(new goals.GoalY(goalY), 'resupply climb towards open sky', 14000)
        .then(() => true, () => false)
      if (reached || !canWorkHere(connection) || connection.entity.position.floored().y > currentFeet.y) break
    }
    if (canWorkHere(connection) && openSurfaceAt(connection, connection.entity.position.floored())) {
      log('food surface reached', { position: connection.entity.position.floored() })
    }
  } finally {
    surfaceRouteActive = false
  }
}

async function surfaceResupply() {
  const connection = bot
  await eatFoodIfNeeded()
  if (!canWorkHere(connection) || closeCombatPlan()) return
  const feet = connection.entity.position.floored()
  if (!openSurfaceAt(connection, feet)) {
    await approachFoodSurface(connection)
    return
  }
  lastDecision = 'hunt-food'
  if (foodReserve() < SURFACE_FOOD_TARGET && !await huntNearbyAnimalsOrForage({ stockUp: true }) &&
      canWorkHere(connection) && !closeCombatPlan()) await exploreOneStep()
  const foodItems = foodReserve()
  if (canWorkHere(connection) && !closeCombatPlan() && foodItems >= SURFACE_FOOD_TARGET &&
      openSurfaceAt(connection, connection.entity.position.floored()) && supplyBase.completeResupply()) {
    const { diamonds } = supplyBase.qualification()
    log('surface resupply complete', { foodItems, diamonds })
    log('supply base unlocked after resupply', { foodItems, diamonds })
  }
}

async function huntNearbyAnimalsOrForage({ stockUp = false } = {}) {
  if (!bot?.entity || waterOwnsMovement() || emergencyRetreating) return false

  if (!stockUp && await eatFoodIfNeeded()) return true

  if (await forageVillageBread()) {
    await eatFoodIfNeeded()
    return true
  }

  const hasRaw = bot.inventory.items().some(item => RAW_MEAT_NAMES.has(item.name))
  if (hasRaw && !stockUp) {
    await cookRawMeatInFurnace()
    if (await eatFoodIfNeeded()) return true
  }

  const animal = findNearestPassiveAnimal(36)
  if (animal) {
    const animalName = String(animal.name || animal.displayName || 'animal').toLowerCase()
    log('hunting passive animal for food', { animal: animalName, position: animal.position, distance: Number(animal.position.distanceTo(bot.entity.position).toFixed(1)) })
    await equipCombatItem()

    const chaseDeadline = Date.now() + 15000
    while (Date.now() < chaseDeadline && bot.entities[animal.id] && canWorkHere(bot) && !emergencyRetreating) {
      const dist = animal.position.distanceTo(bot.entity.position)
      if (dist <= 3.2) {
        try {
          await bot.lookAt(animal.position.offset(0, (animal.height || 1) * 0.5, 0), true)
          bot.attack(animal)
        } catch {}
      } else {
        try {
          await gotoWithTimeout(new goals.GoalFollow(animal, 2.0), 'hunt chase', 2500)
        } catch {}
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    await collectNearbyDrops(16)

    const woolCount = bot.inventory.items().filter(i => i.name.endsWith('_wool')).reduce((sum, i) => sum + i.count, 0)
    if (woolCount >= 3 && inventoryItemCount('white_bed') === 0 && (plankCount() >= 3 || inventoryCount(LOG_NAMES) >= 1)) {
      if (plankCount() < 3) await makePlanksFor(3)
      const table = await ensureCraftingTable()
      if (table) {
        const bedItem = bot.inventory.items().find(i => i.name.endsWith('_wool'))
        const bedColor = bedItem?.name?.split('_')?.[0] || 'white'
        await craftNamed(`${bedColor}_bed`, table)
        await reclaimTemporaryCraftingTable()
      }
    }

    await eatFoodIfNeeded()
    return true
  }

  return false
}

async function ensureWoodAxe() {
  if (!canWorkHere(bot) || bot.inventory.items().some(item => item.name.endsWith('_axe'))) return false
  const tablePlanks = inventoryItemCount(TABLE_NAME) > 0 || findNearestBlock(TABLE_NAMES, 4) ? 0 : 4
  const stickPlanks = inventoryItemCount('stick') >= 2 ? 0 : 2
  const required = tablePlanks + stickPlanks + 3
  if (plankCount() + inventoryCount(LOG_NAMES) * 4 < required || !await makePlanksFor(required)) return false
  if (stickPlanks && !await craftNamed('stick')) return false
  const table = await ensureCraftingTable()
  const crafted = Boolean(table && canWorkHere(bot) && await craftNamed('wooden_axe', table))
  if (crafted) log('early wood axe ready', { axe: 'wooden_axe' })
  return crafted
}

function gearUpgrades(tier) {
  const names = new Set(bot.inventory.slots.filter(Boolean).map(item => item.name))
  const acceptedTiers = tier === 'iron' ? ['iron', 'diamond', 'netherite'] : ['diamond', 'netherite']
  const resource = tier === 'iron' ? 'iron_ingot' : 'diamond'
  const label = tier === 'iron' ? '铁' : '钻石'
  const plans = [
    { type: 'pickaxe', label: `${label}镐`, cost: 3, sticks: 2 },
    { type: 'sword', label: `${label}剑`, cost: 2, sticks: 1 },
    { type: 'chestplate', label: `${label}胸甲`, cost: 8 },
    { type: 'leggings', label: `${label}护腿`, cost: 7 },
    { type: 'helmet', label: `${label}头盔`, cost: 5 },
    { type: 'boots', label: `${label}靴子`, cost: 4 },
  ].filter(plan => !acceptedTiers.some(material => names.has(`${material}_${plan.type}`)))
    .map(plan => ({ ...plan, resource, item: `${tier}_${plan.type}` }))
  if (tier === 'iron' && !names.has('shield')) {
    plans.splice(plans[0]?.type === 'pickaxe' ? 1 : 0, 0,
      { item: 'shield', type: 'shield', label: '盾牌', resource, cost: 1, planks: 6 })
  }
  return plans
}

function nextIronUpgrade() {
  return gearUpgrades('iron')[0] ?? null
}

function readyGearUpgrades() {
  const diamond = gearUpgrades('diamond')
  const iron = gearUpgrades('iron')
  const diamondPick = diamond.find(plan => plan.type === 'pickaxe')
  const candidates = [diamondPick, ...iron.filter(plan => plan.type === 'pickaxe' || plan.type === 'shield'),
    ...(diamondPick ? [] : diamond), ...iron.filter(plan => plan.type !== 'pickaxe' && plan.type !== 'shield')]
    .filter(plan => plan && inventoryItemCount(plan.resource) >= plan.cost)
  if (!candidates.length) return []
  const tablePlanks = inventoryItemCount(TABLE_NAME) > 0 || findNearestBlock(TABLE_NAMES, 4) ? 0 : 4
  const wood = plankCount() + inventoryCount(LOG_NAMES) * 4
  const sticks = inventoryItemCount('stick')
  return candidates.filter(plan => wood >= tablePlanks + (plan.planks || 0) +
    (plan.sticks > sticks ? 2 : 0))
}

async function craftAvailableGear(allowRelocate = true) {
  let changed = false
  const failed = new Set()
  while (canWorkHere(bot) && !foodRecoveryNeeded() && !closeCombatPlan()) {
    const next = readyGearUpgrades().find(plan => !failed.has(plan.item))
    if (!next) break
    const table = await ensureCraftingTable(allowRelocate)
    if (!table || !canWorkHere(bot) || foodRecoveryNeeded()) break
    if (next.sticks && inventoryItemCount('stick') < next.sticks &&
        (!await makePlanksFor(2) || !await craftNamed('stick'))) {
      failed.add(next.item)
      continue
    }
    if ((next.planks && !await makePlanksFor(next.planks)) || !await craftNamed(next.item, table)) {
      failed.add(next.item)
      continue
    }
    changed = true
    log('gear upgrade crafted', { item: next.item, material: next.resource })
  }
  if (changed) {
    await autoEquipArmor()
    await equipCombatItem()
  }
  return changed
}

async function prepareStarterGear() {
  if (!canWorkHere(bot) || foodRecoveryNeeded()) return false
  let progress = false
  try {
    progress = await craftAvailableGear()
    if (foodRecoveryNeeded()) return progress
    const rawIronCount = inventoryItemCount('raw_iron') + inventoryItemCount('iron_ore') + inventoryItemCount('deepslate_iron_ore')
    const ironUpgrade = nextIronUpgrade()
    if (rawIronCount > 0 && (!ironUpgrade || rawIronCount + inventoryItemCount('iron_ingot') >= ironUpgrade.cost)) {
      const smelted = await smeltRawIron()
      progress = smelted || progress
      if (pendingIronWorkshop || pendingFurnaceBatch || temporaryFurnace) return progress
    }

    const toolPlans = [['pickaxe', 3, 2], ['sword', 2, 1], ['axe', 3, 2]]
    const canMakeTool = ([tool, heads]) => !hasTool(tool) ||
      (!hasStoneGradeTool(tool) && inventoryCount(STONE_DROPS) >= heads)
    const suppliesNeeded = toolPlans.some(canMakeTool)

    const fuelToReserve = !bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)) ||
      inventoryCount(IRON_INPUT_NAMES) > 0 ? 1 : 0
    if (inventoryItemCount('torch') < 8 && inventoryItemCount('coal') > fuelToReserve) {
      if (inventoryItemCount('stick') === 0 && await makePlanksFor(2)) await craftNamed('stick')
      progress = (await craftNamed('torch')) || progress
    }
    if (!suppliesNeeded) {
      await autoEquipArmor()
      await equipCombatItem()
      return progress
    }
    const hasTableReady = inventoryItemCount(TABLE_NAME) > 0 || Boolean(findNearestBlock(TABLE_NAMES, 4))
    if (!hasTableReady) {
      const minWoodForTool = inventoryCount(STONE_DROPS) >= 3 ? 0 : 3
      if (plankCount() + inventoryCount(LOG_NAMES) * 4 < 4 + minWoodForTool) {
        log('starter gear deferred: insufficient wood for table and tool', {
          planks: plankCount(),
          logs: inventoryCount(LOG_NAMES),
          required: 4 + minWoodForTool
        })
        return progress
      }
      if (!await makePlanksFor(4)) return progress
    }
    const table = await ensureCraftingTable()
    if (!table || !canWorkHere(bot)) return progress
    for (const [tool, heads, sticks] of toolPlans) {
      if (!canWorkHere(bot)) break
      if (!canMakeTool([tool, heads])) continue
      const useStone = inventoryCount(STONE_DROPS) >= heads
      const needsSticks = inventoryItemCount('stick') < sticks
      if (!await makePlanksFor((useStone ? 0 : heads) + (needsSticks ? 2 : 0))) continue
      if (needsSticks && !await craftNamed('stick')) continue
      if (!canWorkHere(bot)) break
      const crafted = await craftNamed(`${useStone ? 'stone' : 'wooden'}_${tool}`, table)
      progress = crafted || progress
    }

    await autoEquipArmor()
    await equipCombatItem()

    if (progress) log('starter gear prepared', {
      axe: bot.inventory.items().some(item => item.name.endsWith('_axe')),
      pickaxe: bot.inventory.items().some(item => item.name.endsWith('_pickaxe')),
      sword: bot.inventory.items().some(item => item.name.endsWith('_sword')),
      ironPickaxe: bot.inventory.items().some(item => item.name === 'iron_pickaxe'),
      shield: inventoryItemCount('shield') > 0,
      torches: inventoryItemCount('torch'),
    })
    return progress
  } finally {
    await reclaimTemporaryCraftingTable()
  }
}

function hasTool(kind) {
  return bot.inventory.items().some(item => item.name.endsWith(`_${kind}`))
}

function hasStoneGradeTool(kind) {
  return bot.inventory.items().some(item =>
    item.name.endsWith(`_${kind}`) && /^(stone|copper|iron|diamond|netherite)_/.test(item.name))
}

async function advanceSurvivalGear() {
  if (!canWorkHere(bot)) return false
  const stonesNeeded = ['pickaxe', 'sword', 'axe'].reduce((count, kind) =>
    count + (hasStoneGradeTool(kind) ? 0 : kind === 'sword' ? 2 : 3), 0)
  const needsTools = ['pickaxe', 'sword', 'axe'].some(kind => !hasTool(kind))
  const coal = inventoryItemCount('coal')
  const charcoal = inventoryItemCount('charcoal')
  const needsTorches = inventoryItemCount('torch') < 8
  const canUpgrade = stonesNeeded > 0 && inventoryCount(STONE_DROPS) >= stonesNeeded
  const rawIron = inventoryCount(IRON_INPUT_NAMES)
  const ironIngots = inventoryItemCount('iron_ingot')
  const needsCoal = needsCoalForIron({ rawIron, coal, charcoal, iron: rawIron + ironIngots,
    hasIronPickaxe: bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name)) })
  const nextIron = nextIronUpgrade()
  const canSmeltUpgrade = rawIron > 0 && coal + charcoal > 0 && (!nextIron || rawIron + ironIngots >= nextIron.cost)
  if (needsTools || canUpgrade || (needsTorches && coal > 0) || canSmeltUpgrade || readyGearUpgrades().length) {
    lastDecision = 'gear-up'
    log('survival objective', { action: 'craft', stonesNeeded, needsTools, needsTorches, canSmeltUpgrade })
    if (await prepareStarterGear() || pendingIronWorkshop || pendingFurnaceBatch || temporaryFurnace) return true
  }
  if (!hasTool('pickaxe')) return false
  const targets = stonesNeeded > 0 && inventoryCount(STONE_DROPS) < stonesNeeded
    ? STONE_TARGETS : needsCoal || (needsTorches && coal === 0) ? COAL_TARGETS : null
  if (!targets) return false
  if (mineNeedsNewGround) {
    mineNeedsNewGround = false
    return false
  }
  if (!findNearestBlock(targets, targets === COAL_TARGETS ? ORE_SCAN_RADIUS : BLOCK_MINE_RADIUS)) return false
  mineMode = true
  mineTargetNames = targets
  currentMineOrder = { cycle, requested: null, target: targets === STONE_TARGETS ? 'stone' : 'coal', source: 'survival' }
  lastDecision = targets === STONE_TARGETS ? 'gather-stone-for-tools' :
    needsCoal ? 'gather-coal-for-smelting' : 'gather-coal-for-torches'
  log('survival objective', { action: lastDecision, stonesNeeded, stone: inventoryCount(STONE_DROPS) })
  return true
}

function mineTargetSetFromName(targetName = '') {
  const normalized = String(targetName || '').trim().toLowerCase().replace(/^minecraft:/, '')
  if (!normalized) return new Set(DEFAULT_MINE_TARGET_NAMES)
  if (normalized === 'coal') return COAL_TARGETS
  if (normalized === 'stone') return STONE_TARGETS
  const aliases = {
    coal: ['coal_ore', 'deepslate_coal_ore'],
    iron: ['iron_ore', 'deepslate_iron_ore'],
    copper: ['copper_ore', 'deepslate_copper_ore'],
    gold: ['gold_ore', 'deepslate_gold_ore'],
    redstone: ['redstone_ore', 'deepslate_redstone_ore'],
    lapis: ['lapis_ore', 'deepslate_lapis_ore'],
    diamond: ['diamond_ore', 'deepslate_diamond_ore'],
    emerald: ['emerald_ore', 'deepslate_emerald_ore'],
  }
  const translated = { 煤: 'coal', 煤炭: 'coal', 煤矿: 'coal', 铁: 'iron', 铁矿: 'iron',
    钻石: 'diamond', 钻石矿: 'diamond', 青金石: 'lapis', 青金石矿: 'lapis', 石头: 'stone' }[normalized] || normalized
  if (translated === 'stone') return STONE_TARGETS
  return aliases[translated] ? new Set(aliases[translated]) :
    mcData?.blocksByName?.[translated] ? new Set([translated]) : new Set()
}

function minePositionKey(position) {
  return `${position.x},${position.y},${position.z}`
}

function pruneMineBlacklist(now = Date.now()) {
  for (const [key, expiresAt] of mineBlacklist) {
    if (expiresAt <= now) mineBlacklist.delete(key)
  }
}

function isTransparentForMine(block) {
  return !block || block.name === 'air' || block.boundingBox === 'empty' || block.name === 'water' || block.name === 'bubble_column'
}

function isPlausibleMineTarget(position, block) {
  if (!position || !block || block.name === 'air' || block.name === 'bedrock' || block.name === 'lava') return false
  if (block.name.includes('copper')) return false
  if (block.boundingBox !== 'block') return false
  const key = minePositionKey(position)
  if (mineBlacklist.has(key)) return false
  const origin = bot.entity.position
  if (Math.abs(position.y - origin.y) > (isOreName(block.name) ? 40 : 16)) return false

  // Match MineProcess.prune(): reject targets touching fluids and retain a
  // nearby transparent face so the final dig can be performed safely.
  const offsets = [
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ]
  for (const [dx, dy, dz] of offsets) {
    const neighbour = bot.blockAt(position.offset(dx, dy, dz))
    if (neighbour?.name === 'lava') return false
    // Do not select an underwater face as a normal mine target. The movement
    // controller deliberately takes over in water, so a mine plan there would
    // fight the surfacing logic and repeatedly cancel itself.
    if (neighbour?.name === 'water' || neighbour?.name === 'bubble_column') return false
  }
  // Baritone's normal MineProcess allows non-exposed targets; exposure is
  // only an optional legit-mine setting. Keep buried stone/ore candidates and
  // let the pathfinder/digWithExposure decide whether a safe approach exists.
  return true
}

function mineGoalForBlock(position) {
  return new goals.GoalCompositeAny([
    new goals.GoalLookAtBlock(position, bot.world, { reach: 4.5 }),
    new goals.GoalGetToBlock(position.x, position.y, position.z),
  ])
}

function scoreMinePath(candidate, result) {
  const pathLength = Array.isArray(result?.path) ? result.path.length : 9999
  const distance = bot.entity.position.distanceTo(candidate.position)
  const oreBonus = /_ore$/.test(candidate.block.name) ? -2 : 0
  const exposedBonus = candidate.exposedFaces > 1 ? -1 : 0
  return pathLength + distance * 0.4 + (result.status === 'success' ? 0 : 8) + oreBonus + exposedBonus
}

// Baritone-style ore scan: ores are searched over a wider radius than plain
// stone, remembered between ticks, and ranked ahead of stone.
const ORE_SCAN_RADIUS = 72
const BLOCK_MINE_RADIUS = 36
const WOOD_SCAN_RADIUS = 72
const ORE_CACHE_LIMIT = 128
const knownOres = new Map()
let lastOreScan = null

function scanBlockIds(names) {
  return [...names].map(name => mcData.blocksByName[name]?.id).filter(Number.isInteger)
}

function isOreName(name) {
  return /_ore$/.test(name) || name === 'ancient_debris'
}

function scanOres() {
  const wanted = new Set([...mineTargetNames].filter(isOreName))
  if (wanted.size === 0) return []
  const origin = bot.entity.position
  const signature = [...wanted].sort().join(',')
  if (lastOreScan?.connection !== bot || lastOreScan.dimension !== bot.game.dimension) knownOres.clear()
  if (!lastOreScan || lastOreScan.connection !== bot || lastOreScan.dimension !== bot.game.dimension ||
      lastOreScan.signature !== signature || Date.now() - lastOreScan.time > 2600 ||
      origin.distanceTo(lastOreScan.position) >= 6) {
    const ids = scanBlockIds(wanted)
    const found = ids.length ? bot.findBlocks({ maxDistance: ORE_SCAN_RADIUS, count: 96, matching: ids }) : []
    for (const position of found) knownOres.set(minePositionKey(position), position)
    lastOreScan = { connection: bot, dimension: bot.game.dimension, signature, time: Date.now(), position: origin.clone() }
  }
  // Forget cached positions that are mined out, or no longer an ore we want.
  for (const [key, position] of knownOres) {
    const block = bot.blockAt(position)
    if (origin.distanceTo(position) > ORE_SCAN_RADIUS || (block && !wanted.has(block.name))) knownOres.delete(key)
  }
  const ranked = [...knownOres.entries()].sort((a, b) => a[1].distanceTo(origin) - b[1].distanceTo(origin))
  for (const [key] of ranked.slice(ORE_CACHE_LIMIT)) knownOres.delete(key)
  return ranked.slice(0, ORE_CACHE_LIMIT).map(([, position]) => position)
}

function searchMineCandidates() {
  pruneMineBlacklist()
  const nonOreIds = scanBlockIds([...mineTargetNames].filter(name => !isOreName(name)))
  const stonePositions = nonOreIds.length ? bot.findBlocks({
    maxDistance: BLOCK_MINE_RADIUS,
    count: 64,
    matching: nonOreIds,
  }) : []
  const seen = new Set()
  const positions = []
  for (const position of [...scanOres(), ...stonePositions]) {
    const key = minePositionKey(position)
    if (seen.has(key)) continue
    seen.add(key)
    positions.push(position)
  }
  const candidates = []
  for (const position of positions) {
    const block = bot.blockAt(position)
    if (supplyStation.protects(bot, position) || !mineTargetNames.has(block?.name) || !isPlausibleMineTarget(position, block)) continue
    let exposedFaces = 0
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      if (isTransparentForMine(bot.blockAt(position.offset(dx, dy, dz)))) exposedFaces += 1
    }
    candidates.push({ position, block, exposedFaces })
  }
  return candidates
}

// True when any node of a planned path stands in, or directly above, water.
function pathTouchesWater(path) {
  for (const node of path) {
    const feet = bot.blockAt(new Vec3(Math.floor(node.x), Math.floor(node.y), Math.floor(node.z)))
    const below = bot.blockAt(new Vec3(Math.floor(node.x), Math.floor(node.y) - 1, Math.floor(node.z)))
    if ((feet && WATER_BLOCK_NAMES.has(feet.name)) || (below && WATER_BLOCK_NAMES.has(below.name))) return true
  }
  return false
}

function planMineTarget() {
  if (!bot?.entity || !movements) return null
  const scanned = searchMineCandidates()
  const candidates = scanned
    // Buried targets (no transparent face) can never pass canSeeBlock from the
    // surface, so rank exposed candidates first and only then fall back to distance.
    .sort((a, b) => (isOreName(a.block.name) ? 0 : 1) - (isOreName(b.block.name) ? 0 : 1) ||
      (a.exposedFaces > 0 ? 0 : 1) - (b.exposedFaces > 0 ? 0 : 1) ||
      a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
    // Baritone keeps a bounded known-location list; do the same so a local
    // search never monopolizes the Mineflayer event loop.
    .slice(0, 14)
  let best = null
  let noPath = 0
  let wetTargets = 0
  let evaluated = 0
  const statusCounts = {}
  const evaluationDeadline = performance.now() + 320
  for (const candidate of candidates) {
    // Stop once a reasonable target is in hand; keep going a little further so
    // the oreBonus in scoreMinePath can promote a slightly worse-looking ore
    // over a flat stone candidate.
    if ((best && evaluated >= 6) || (evaluated > 0 && performance.now() >= evaluationDeadline)) break
    evaluated += 1
    try {
      const result = bot.pathfinder.getPathTo(movements, mineGoalForBlock(candidate.position), 75)
      statusCounts[result?.status ?? 'none'] = (statusCounts[result?.status ?? 'none'] || 0) + 1
      const alreadyReachable = result?.status === 'success' && bot.canDigBlock(candidate.block) &&
        bot.canSeeBlock(candidate.block) && bot.entity.position.distanceTo(candidate.position) <= 5
      if (!result || !Array.isArray(result.path) || (!result.path.length && !alreadyReachable) || result.status === 'noPath') {
        mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 15000)
        noPath += 1
        continue
      }
      // A single getPathTo call gets only 40ms per tick, so medium-distance
      // targets usually come back as "partial". Accept partial paths — the dig
      // step will stop if the bot does not actually arrive — but still reject
      // paths that cross water, which was the real problem.
      if (pathTouchesWater(result.path) || isWaterAdjacent(candidate.position)) {
        mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 120000)
        wetTargets += 1
        continue
      }
      const score = scoreMinePath(candidate, result)
      if (!best || score < best.score) best = { ...candidate, result, score }
    } catch (error) {
      mineBlacklist.set(minePositionKey(candidate.position), Date.now() + 15000)
      log('mine candidate path search failed', { position: candidate.position, message: error.message })
    }
  }
  log('mine scan evaluated', { plausible: scanned.length, evaluated, noPath, wetTargets, statusCounts })
  return best
}

async function minePlannerTick(reason = 'tick') {
  if (!mineMode || mineBusy || busy || !botEnabled || !bot?.entity || !movements) return false
  if (emergencyRetreating || fleeingActive || waterOwnsMovement() || foodRecoveryNeeded() || bot.health <= 0) return false
  if (supplyBase.active(bot) && !['base', 'station'].includes(currentMineOrder?.source)) {
    finishMineObjective()
    void decideAndAct('mine-complete')
    return false
  }
  if (Date.now() < nextMineSearchAt) return false
  if (!['base', 'station'].includes(currentMineOrder?.source) &&
      Date.now() >= nextGearCraftRetryAt && readyGearUpgrades().length && !closeCombatPlan()) {
    void decideAndAct('gear-ready')
    return false
  }
  mineBusy = true
  miningPausedForFood = false
  lastMineSearchAt = Date.now()
  nextMineSearchAt = lastMineSearchAt + 750
  let objectiveReached = false
  try {
    await clearBackpack(bot, 'mining', { duringMining: true })
    if (!bot?.entity || !mineMode || foodRecoveryNeeded() || closeCombatPlan()) return false
    await autoEquipArmor(true)
    const hasPickaxe = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
    if (!hasPickaxe) {
      log('mine planner paused; pickaxe required')
      mineMode = false
      objectiveReached = true
      return false
    }
    log('mine planner search', { reason, targets: [...mineTargetNames].slice(0, 12) })
    const savedTarget = committedMineTarget && bot.blockAt(committedMineTarget.position)
    if (!savedTarget || savedTarget.type !== committedMineTarget.block.type || !mineTargetNames.has(savedTarget.name)) {
      if (committedMineTarget) log('mine commitment released', { reason: 'target-changed', position: committedMineTarget.position })
      committedMineTarget = null
    }
    const resumed = Boolean(committedMineTarget)
    const plan = committedMineTarget ?? planMineTarget()
    if (!plan) {
      mineNeedsNewGround = true
      mineMode = false
      navigationState = { target: null, waypoints: [], label: 'mine-search-empty' }
      nextMineSearchAt = Date.now() + 3000
      log('mine planner found no reachable target', { oreRadius: ORE_SCAN_RADIUS, blockRadius: BLOCK_MINE_RADIUS })
      recordMineAudit('no-reachable-target')
      persistExperience({ cycle, action: 'mine-search', experience: '扫描到的目标没有可行路径，已跳过并等待环境变化后重搜' })
      return false
    }

    committedMineTarget = plan
    lastDecision = 'mine'
    const target = plan.position
    currentMineTarget = { x: target.x, y: target.y, z: target.z, name: plan.block.name }
    navigationState = {
      target: { x: target.x, y: target.y, z: target.z, name: plan.block.name },
      waypoints: resumed ? [] : plan.result.path.map(point => ({ x: point.x, y: point.y, z: point.z })),
      label: 'baritone-mine',
    }
    log(resumed ? 'mine commitment resumed' : 'mine planner selected target', {
      block: plan.block.name,
      position: target,
      pathNodes: plan.result.path.length,
      pathStatus: plan.result.status,
      score: Number(plan.score.toFixed(2)),
    })

    const startPosition = bot.entity.position.clone()
    const distance = startPosition.distanceTo(target)
    const interrupted = () => !mineMode || miningPausedForFood || foodRecoveryNeeded() ||
      waterOwnsMovement() || emergencyRetreating || fleeingActive || damageInterruptActive(bot)
    try {
      await gotoWithTimeout(mineGoalForBlock(target), 'mine target path', Math.min(22000, 7000 + distance * 230))
    } catch (error) {
      if (interrupted()) return false
      if (/timeout/i.test(error.message) && startPosition.distanceTo(bot.entity.position) >= 3 && (plan.retries ?? 0) < 2) {
        plan.retries = (plan.retries ?? 0) + 1
        log('mine path still progressing; retrying same target', { position: target, retry: plan.retries })
        return false
      }
      committedMineTarget = null
      mineBlacklist.set(minePositionKey(target), Date.now() + 20000)
      log('mine target unreachable; blacklisted', { block: plan.block.name, position: target, message: error.message })
      persistExperience({ cycle, action: 'mine-replan', experience: `目标 ${plan.block.name} 不可达，已临时加入黑名单并改搜其他目标` })
      return false
    }

    if (interrupted()) return false
    const current = bot.blockAt(target)
    if (!current || current.type !== plan.block.type || !mineTargetNames.has(current.name)) {
      log('mine target changed before dig; rescanning', { position: target })
      committedMineTarget = null
      recordMineAudit('target-changed', current)
      return false
    }
    const drops = STONE_TARGETS.has(current.name) ? STONE_DROPS : COAL_TARGETS.has(current.name) ? COAL_DROPS :
      /^(deepslate_)?iron_ore$/.test(current.name) ? new Set(['raw_iron']) :
      /^(deepslate_)?copper_ore$/.test(current.name) ? new Set(['raw_copper']) :
      /^(deepslate_)?gold_ore$/.test(current.name) ? new Set(['raw_gold']) :
      /^(deepslate_)?diamond_ore$/.test(current.name) ? new Set(['diamond']) :
      /^(deepslate_)?redstone_ore$/.test(current.name) ? new Set(['redstone']) :
      /^(deepslate_)?lapis_ore$/.test(current.name) ? new Set(['lapis_lazuli']) :
      /^(deepslate_)?emerald_ore$/.test(current.name) ? new Set(['emerald']) : new Set([current.name])
    const before = inventoryCount(drops)
    const countedDiamond = drops.has('diamond') && needsPostArmorDiamonds(bot)
    await maybePlaceTorch(true)
    if (interrupted()) return false
    if (!await digWithExposure(current, mineTargetNames)) {
      if (interrupted()) return false
      committedMineTarget = null
      mineBlacklist.set(minePositionKey(target), Date.now() + 10000)
      log('mine dig failed; target blacklisted for replan', { block: current.name, position: target })
      persistExperience({ cycle, action: 'mine-replan', experience: `目标 ${current.name} 无法从当前站位挖到，重新搜索可达目标` })
      return false
    }
    committedMineTarget = null
    mineBlacklist.delete(minePositionKey(target))
    log('mine target mined', { block: current.name, position: target })
    const pickedUp = await pickUpBlockDrop(drops, target, before, true)
    log('mine pickup result', { block: current.name, pickedUp })
    if (countedDiamond && pickedUp && supplyBase.recordDiamonds(inventoryItemCount('diamond') - before)) {
      const { diamonds, target, needsResupply } = supplyBase.qualification()
      log('post-armor diamonds collected', { count: diamonds, target })
      if (needsResupply) {
        mineMode = false
        activeGoal = null
        log('surface resupply required after diamonds', { diamonds })
        objectiveReached = true
      }
    }
    if (!objectiveReached) objectiveReached = finishMineObjective()
    persistExperience({ cycle, action: 'mine', experience: `按实际寻路节点到达 ${current.name} 的可见面并完成挖掘` })
    return true
  } finally {
    mineBusy = false
    currentMineTarget = null
    if (miningPausedForFood) setImmediate(() => monitorFood())
    if (objectiveReached && !urgentThreatQueued) setImmediate(() => void decideAndAct('mine-complete'))
    if (urgentThreatQueued) {
      urgentThreatQueued = false
      setImmediate(() => void decideAndAct('urgent-queued'))
    }
  }
}

function finishMineObjective() {
  if (!mineMode || !bot?.entity || !mineTargetNames.size) return false
  if (supplyBase.active(bot) && currentMineOrder?.source !== 'station') {
    const objective = currentMineOrder?.objective
    if (objective && Date.now() < objective.until && foodReserve() >= 3 &&
        inventoryCount(new Set(objective.names)) < objective.target) return false
    mineMode = false
    committedMineTarget = null
    activeGoal = null
    return true
  }
  const targets = [...mineTargetNames]
  const coal = inventoryItemCount('coal')
  const fuel = coal + inventoryItemCount('charcoal')
  const raw = inventoryCount(IRON_INPUT_NAMES)
  const ingots = inventoryItemCount('iron_ingot')
  const ironPick = bot.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name))
  const stock = currentMineOrder?.stoneDrop ? inventoryItemCount(currentMineOrder.stoneDrop) : inventoryCount(STONE_DROPS)
  const stoneReady = targets.every(name => STONE_TARGETS.has(name)) && stock >= (currentMineOrder?.stoneLimit ?? STONE_TARGET)
  const coalReady = targets.every(name => COAL_TARGETS.has(name)) &&
    (coal >= 4 || (raw > 0 && fuel > 0) || (ironPick && inventoryItemCount('torch') < 8 && coal >= 1))
  const upgrade = nextIronUpgrade()
  const ironReady = targets.every(name => IRON_INPUT_NAMES.has(name)) && upgrade &&
    (ingots >= upgrade.cost || (fuel > 0 && raw + ingots >= upgrade.cost))
  const diamondPriority = currentMineOrder?.source !== 'station' && needsPostArmorDiamonds(bot) && hasDiamondMiningTool(bot) &&
    !targets.every(name => /^(deepslate_)?diamond_ore$/.test(name))
  if (!stoneReady && !coalReady && !ironReady && !diamondPriority) return false
  mineMode = false
  committedMineTarget = null
  mineNeedsNewGround = false
  if (activeGoal?.type === 'mine') activeGoal = null
  log('mine objective ready; advancing', {
    resource: diamondPriority ? 'post-armor diamonds' : stoneReady ? 'stone' : coalReady ? 'coal' : 'iron', coal, raw, ingots,
  })
  return true
}

function recordMineAudit(result, block = null) {
  if (!currentMineOrder) return
  lastMineAudit = { time: new Date().toISOString(), ...currentMineOrder, result,
    planned: currentMineTarget, actual: block ? { name: block.name, position: block.position } : null }
  log('mine command audit', lastMineAudit)
  persistExperience({ ...lastMineAudit, action: 'mine-audit', experience: {
    'command': `采矿目标 ${currentMineOrder.target}`,
    'target-mined': `已挖到目标方块 ${block?.name}`,
    'path-clearance': `清除挡路方块 ${block?.name}`,
    'unexpected-ore': `实际挖掘矿物 ${block?.name} 与指令不一致，暂停采矿并重新规划`,
    'no-reachable-target': `暂时没有可达的 ${currentMineOrder.target}，移动后重搜`,
    'target-changed': `计划坐标的方块已变化，取消挖掘并重搜`,
    'invalid-target': `无效的采矿目标 ${currentMineOrder.target}，等待新指令`,
  }[result] })
}

async function mineForGear(modelTarget = null, targetName = '', requested = null,
  { objective = null, stoneLimit = null, stoneDrop = null } = {}) {
  if (foodRecoveryNeeded()) return false
  if (!bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) {
    log('mining refused; no pickaxe equipped or available')
    persistExperience({ cycle, action: 'mine-blocked', experience: '没有镐，禁止进入挖矿执行器' })
    return false
  }
  const exactStone = stoneDrop ?? (objective?.kind === 'stone' && objective.names.length === 1 ? objective.names[0] : null)
  const targets = exactStone ? new Set([exactStone === 'cobbled_deepslate' ? 'deepslate' : 'stone']) : mineTargetSetFromName(targetName)
  if (committedMineTarget && !targets.has(committedMineTarget.block.name)) committedMineTarget = null
  mineTargetNames = targets
  currentMineOrder = { cycle, requested, target: targetName || 'general',
    source: objective ? 'base' : stoneLimit ? 'station' : requested ? 'model' : 'survival' }
  if (objective) currentMineOrder.objective = objective
  if (stoneLimit) currentMineOrder.stoneLimit = stoneLimit
  if (stoneDrop) currentMineOrder.stoneDrop = stoneDrop
  mineMode = mineTargetNames.size > 0
  recordMineAudit(mineMode ? 'command' : 'invalid-target')
  if (!mineMode) return false
  lastDecision = 'mine'
  log('mine mode enabled', { targetName, targets: [...mineTargetNames] })
  // The actual search and dig are performed by minePlannerTick.  It is
  // intentionally separate from the DeepSeek action so path replanning can
  // continue after a high-level decision has finished.
  return true
}

// Positions that already failed to path to or dig (unreachable canopy logs,
// server-rejected digs). Without this the same block is retried every cycle.
const collectBlacklist = new Map()

function pruneCollectBlacklist(now = Date.now()) {
  for (const [key, expiresAt] of collectBlacklist) {
    if (expiresAt <= now) collectBlacklist.delete(key)
  }
}

async function collectTreeTrunks(stockTarget = WOOD_TARGET, woodNames = LOG_NAMES) {
  const connection = bot
  if (!canWorkHere(connection)) return false
  pruneCollectBlacklist()
  const pending = connection.findBlocks({
    maxDistance: 28, count: 64, matching: scanBlockIds(woodNames)
  }).filter(position => !collectBlacklist.has(minePositionKey(position)))
  let lastTrunk = null
  let collected = 0
  let failures = 0
  while (pending.length && collected < WOOD_TARGET && failures < 3 &&
      canWorkHere(connection) && !closeCombatPlan() && inventoryCount(woodNames) < stockTarget) {
    const here = connection.entity.position
    const candidates = pending.flatMap(position => {
      const block = connection.blockAt(position, false)
      if (!block || !woodNames.has(block.name)) return []
      const ready = connection.canDigBlock(block) && connection.canSeeBlock(block)
      const sameTrunk = lastTrunk && position.x === lastTrunk.x && position.z === lastTrunk.z
      return [{ block, ready, score: here.distanceTo(position) +
        Math.max(0, position.y - here.y) * 2 - (sameTrunk ? 3 : 0) }]
    })
    candidates.sort((a, b) => Number(b.ready) - Number(a.ready) || a.score - b.score)
    const selected = candidates[0]
    if (!selected) break
    const position = selected.block.position
    pending.splice(pending.findIndex(point => point.equals(position)), 1)
    try {
      if (!selected.ready) {
        if (collected && here.distanceTo(position) > 7) break
        const goal = new goals.GoalLookAtBlock(position, connection.world, { reach: 4.2 })
        await gotoWithTimeout(goal, 'wood trunk path', collected ? 1600 : 3000)
      }
      if (!canWorkHere(connection) || closeCombatPlan()) break
      const block = connection.blockAt(position)
      if (!block || block.type !== selected.block.type || !woodNames.has(block.name)) continue
      if (!await digWithExposure(block, woodNames)) throw new Error('could not dig chosen trunk')
      collected += 1
      failures = 0
      lastTrunk = position
    } catch (error) {
      if (connection !== bot || !canWorkHere(connection) || closeCombatPlan()) break
      failures += 1
      stopPathfinder()
      collectBlacklist.set(minePositionKey(position), Date.now() + 45000)
      log('wood trunk skipped', { position, message: error.message })
    }
  }
  if (!canWorkHere(connection) || closeCombatPlan()) return collected > 0
  const before = inventoryCount(LOG_NAMES)
  await collectFallenWood(connection)
  if (!canWorkHere(connection)) return collected > 0
  if (collected || inventoryCount(LOG_NAMES) > before) {
    log('wood batch completed', { broken: collected, logs: inventoryCount(LOG_NAMES) })
    await prepareAxeForWoodCollection()
    return true
  }
  return false
}

async function collectFallenWood(connection) {
  await clearBackpack(connection, 'wood-pickup')
  const drops = findNearbyDrops(8).filter(({ entity }) => {
    try { return LOG_NAMES.has(entity.getDroppedItem()?.name) } catch { return false }
  }).slice(0, 4)
  for (const { entity } of drops) {
    if (!canWorkHere(connection) || closeCombatPlan() || inventoryCount(LOG_NAMES) >= WOOD_TARGET) return
    if (!connection.entities[entity.id]) continue
    const point = entity.position.floored()
    // A dropped log can still be falling through the air. Approach a standing
    // position below it rather than waiting for a path to the moving entity.
    let feet = point
    for (let i = 0; i < 4; i += 1) {
      const below = connection.blockAt(feet.offset(0, -1, 0), false)
      if (below?.boundingBox === 'block') break
      feet = feet.offset(0, -1, 0)
    }
    try {
      await gotoWithTimeout(new goals.GoalNear(feet.x, feet.y, feet.z, 0.8), 'wood drop pickup', 1200)
    } catch {
      if (!canWorkHere(connection)) return
    }
  }
}

function toolDurability(item) {
  const max = item?.maxDurability ?? mcData?.items[item?.type]?.maxDurability
  return max ? Math.max(0, max - (item.durabilityUsed ?? 0)) : Infinity
}

function blockDigTimeWith(connection, block, item) {
  const helmet = connection.inventory.slots[connection.getEquipmentDestSlot('head')]
  const corrected = String(block.material || '').startsWith('incorrect_for_') &&
    connection.registry.materials['mineable/pickaxe']
  // Do not mutate the cached world block when fixing the 26.1 ore material.
  const probe = corrected ? Object.create(block, { material: { value: 'mineable/pickaxe' } }) : block
  return probe.digTime(item?.type ?? null, connection.game.gameMode === 'creative',
    ['water', 'flowing_water'].includes(connection._getBlockAtEyeLevel?.()?.name),
    !connection.entity.onGround, [...(item?.enchants || []), ...(helmet?.enchants || [])], connection.entity.effects)
}

async function equipBestToolFor(block) {
  const connection = bot
  if (!block || !connection?.entity) return false
  const held = connection.heldItem
  const items = connection.inventory.items()
  const isTool = item => /_(pickaxe|axe|shovel|hoe|sword)$|^(shears|trident)$/.test(item?.name || '')
  const usable = items.filter(isTool)
  if (!isTool(held)) usable.push(held ?? null)
  else usable.push(items.find(item => !Number.isFinite(toolDurability(item))) ?? null)
  const ranked = usable.filter(item => block.canHarvest(item?.type ?? null)).map(item => ({
    item, duration: blockDigTimeWith(connection, block, item), remaining: toolDurability(item)
  })).filter(choice => Number.isFinite(choice.duration))
  ranked.sort((a, b) => Number(a.remaining <= 2) - Number(b.remaining <= 2) ||
    a.duration - b.duration ||
    Number(a.item !== held) - Number(b.item !== held) ||
    (a.remaining < b.remaining ? 1 : a.remaining > b.remaining ? -1 : 0))
  const best = ranked[0]
  if (!best) {
    log('no suitable harvesting tool', { block: block.name })
    return false
  }
  try {
    if (best.item && held?.slot !== best.item.slot) await connection.equip(best.item, 'hand')
    if (!best.item && held) await connection.unequip('hand')
    const tool = connection.heldItem?.name ?? 'hand'
    log('tool equipped', { block: block.name, tool, estimatedMs: best.duration })
    return Boolean(block.canHarvest(connection.heldItem?.type ?? null))
  } catch (error) {
    log('tool equip failed', { block: block.name, message: error.message })
    return false
  }
}

const TUNNEL_SAFE_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'cobblestone', 'andesite', 'diorite',
  'granite', 'deepslate', 'tuff', 'sandstone', 'netherrack', 'moss_block', 'rooted_dirt',
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore',
  'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'oak_log', 'birch_log', 'spruce_log'
])

// Dig the first solid block between the bot's eyes and `target`. Gravel/sand
// (falling blocks), fluids and anything not on the safe list are never touched.
async function clearBlockerFor(target) {
  const connection = bot
  if (!connection?.entity || waterOwnsMovement() || emergencyRetreating) return false
  const eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
  const aim = target.position.offset(0.5, 0.5, 0.5)
  const ray = aim.minus(eyes)
  const range = ray.norm()
  if (range > 5) return false
  const hit = connection.world.raycast(eyes, ray.unit(), range)
  const blocker = hit ? connection.blockAt(hit.position ?? hit) : null
  if (!blocker || blocker.position.equals(target.position)) return false
  if (supplyBase.owns(connection, blocker.position)) return false
  if (mineBusy && isOreName(blocker.name)) return false
  if (!TUNNEL_SAFE_BLOCKS.has(blocker.name) || !connection.canDigBlock(blocker)) return false
  // Never dig out the block under the bot's feet.
  const feet = connection.entity.position.floored()
  if (blocker.position.x === feet.x && blocker.position.z === feet.z && blocker.position.y < feet.y) return false
  try {
    if (!await equipBestToolFor(blocker)) return false
    log('clearing blocker for target', { blocker: blocker.name, blockerPosition: blocker.position, target: target.name })
    await connection.dig(blocker, true)
    return true
  } catch (error) {
    log('blocker dig failed', { blocker: blocker.name, message: error.message })
    return false
  }
}

async function digWithExposure(target, allowedNames = null) {
  const connection = bot
  if (!target || !connection?.entity || waterOwnsMovement() || emergencyRetreating) return false
  let current = connection.blockAt(target.position)
  if (!current || current.type !== target.type || (allowedNames && !allowedNames.has(current.name)) ||
      !connection.canDigBlock(current)) return false

  isDiggingBlock = true
  let timer
  try {
    await equipBestToolFor(current)
    if (connection !== bot || waterOwnsMovement() || emergencyRetreating) return false
    current = connection.blockAt(target.position)
    if (!current || current.type !== target.type) return false

    if (current.harvestTools && !current.canHarvest(connection.heldItem?.type ?? null)) return false

    // Approach block if too far (> 4.2 blocks)
    let eyes = connection.entity.position.offset(0, connection.entity.eyeHeight, 0)
    let targetCenter = current.position.offset(0.5, 0.5, 0.5)
    if (eyes.distanceTo(targetCenter) > 4.2) {
      try {
        await gotoWithTimeout(new goals.GoalNear(current.position.x, current.position.y, current.position.z, 2.5), 'approach dig block', 3500)
      } catch {}
      if (connection !== bot || waterOwnsMovement() || emergencyRetreating) return false
      current = connection.blockAt(target.position)
      if (!current || current.type !== target.type) return false
    }

    // Clear blocker if line of sight is obstructed
    if (!connection.canSeeBlock(current)) {
      await clearBlockerFor(current)
      if (connection !== bot || waterOwnsMovement() || emergencyRetreating) return false
      current = connection.blockAt(target.position)
      if (!current || current.type !== target.type) return false
    }

    // Re-equip best tool after clearing blockers (clearBlockerFor switches heldItem to blocker tool)
    await equipBestToolFor(current)
    if (current.harvestTools && !current.canHarvest(connection.heldItem?.type ?? null)) return false

    // Stop lingering movement and settle on ground to prevent in-air 5x dig slowdown
    stopPathfinder()
    connection.clearControlStates()
    if (!connection.entity.onGround) {
      const settleStart = Date.now()
      while (!connection.entity.onGround && Date.now() - settleStart < 350) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }

    // Aim towards the block center before starting dig
    targetCenter = current.position.offset(0.5, 0.5, 0.5)
    await connection.lookAt(targetCenter, true)
    const hit = connection.blockAtCursor(4.5)
    if (!hit || hit.type !== current.type || !hit.position.equals(current.position)) {
      log('dig cancelled; crosshair target changed', { target: current.position, hit: hit?.position ?? null })
      return false
    }

    const expectedTime = Math.max(250, Number(connection.digTime(current) || 1000))
    const timeoutMs = Math.max(10000, Math.ceil(expectedTime * 2) + 5000)

    log('digging selected block', { block: current.name, position: current.position, expectedMs: expectedTime, timeoutMs })
    await Promise.race([
      connection.dig(current, true),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('block dig timeout'))
          if (connection.targetDigBlock?.position.equals(current.position)) {
            try { connection.stopDigging() } catch {}
          }
        }, timeoutMs)
      }),
    ])

    // Verify block is broken: check current block state or poll briefly for server block update
    const checkStart = Date.now()
    while (Date.now() - checkStart < 1200) {
      const checkBlock = connection.blockAt(current.position)
      if (!checkBlock || EMPTY_BLOCK.test(checkBlock.name) || checkBlock.type === 0 || checkBlock.type !== target.type) {
        log('dig confirmed broken', { block: current.name, position: current.position, ms: Date.now() - checkStart })
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const finalCheck = connection.blockAt(current.position)
    if (!finalCheck || EMPTY_BLOCK.test(finalCheck.name) || finalCheck.type === 0 || finalCheck.type !== target.type) {
      return true
    }

    log('dig not confirmed by server', { block: current.name, position: current.position })
    return false
  } catch (error) {
    log('dig interrupted; replanning', { block: current?.name || target.name, position: target.position, message: error.message })
    return false
  } finally {
    clearTimeout(timer)
    isDiggingBlock = false
  }
}

async function moveToModelTarget(target, label = 'model target') {
  const origin = bot.entity.position.floored()
  const safeTarget = clampModelTarget(target, origin, 64)
  if (!safeTarget) return false
  try {
    await gotoDestination(safeTarget, label)
    return true
  } catch (error) {
    stopPathfinder()
    log('target path failed; using local fallback', { label, target: safeTarget, message: error.message })
    persistExperience({ cycle, action: 'path-replan', experience: `${label} 未到达，改为当前位置附近重新规划：${error.message}` })
    return false
  }
}

async function prepareAxeForWoodCollection() {
  // The route is: hand-chop logs first, then table, pickaxe, sword, axe. Crafting
  // an axe mid-chop spent the logs and put the axe ahead of the pickaxe.
  if (!bot.inventory.items().some(item => item.name.endsWith('_pickaxe')) && inventoryCount(LOG_NAMES) < WOOD_TARGET) return false
  try {
    return await ensureWoodAxe()
  } finally {
    await reclaimTemporaryCraftingTable()
  }
}

const woodSearchVisits = []

async function collectWoodWithPlan(target = null, stockTarget = WOOD_TARGET, woodNames = LOG_NAMES) {
  if (!canWorkHere(bot)) return false
  if (await leaveSpawnCanopy()) return true
  await prepareAxeForWoodCollection()
  if (await collectTreeTrunks(stockTarget, woodNames)) return true
  if (!canWorkHere(bot) || closeCombatPlan()) return false

  const origin = bot.entity.position.floored()
  pruneCollectBlacklist()
  const trunks = bot.findBlocks({
    maxDistance: WOOD_SCAN_RADIUS, count: 96,
    matching: scanBlockIds(woodNames)
  }).filter(position => !collectBlacklist.has(minePositionKey(position)))
  const score = position => Math.hypot(position.x - origin.x, position.z - origin.z) +
    Math.max(0, position.y - origin.y) * 2.5
  trunks.sort((a, b) => score(a) - score(b))
  const tree = trunks.find(position => Math.hypot(position.x - origin.x, position.z - origin.z) >= 5)
  if (tree) {
    const wood = bot.blockAt(tree)
    log('wood source found', { block: wood?.name, position: tree, candidates: trunks.length })
    if (await moveToModelTarget(tree, 'scout to tree')) {
      if (canWorkHere(bot) && await collectTreeTrunks(stockTarget, woodNames)) return true
    }
    if (!canWorkHere(bot) || closeCombatPlan()) return false
    collectBlacklist.set(minePositionKey(tree), Date.now() + 30000)
  }

  const here = bot.entity.position.floored()
  woodSearchVisits.push(here)
  if (woodSearchVisits.length > 16) woodSearchVisits.shift()
  const options = Array.from({ length: 5 }, () => pickDryExploreTarget(here, 20, 15)).filter(Boolean)
  const modelTarget = clampModelTarget(target, here, 42)
  if (modelTarget && Math.hypot(modelTarget.x - here.x, modelTarget.z - here.z) >= 12) options.push(modelTarget)
  const novelty = candidate => Math.min(...woodSearchVisits.map(point =>
    Math.hypot(candidate.x - point.x, candidate.z - point.z)))
  options.sort((a, b) => novelty(b) - novelty(a))
  log('wood search moving to new ground', { from: here, target: options[0] ?? null, scanRadius: WOOD_SCAN_RADIUS })
  await exploreOneStep(options[0] ?? null)
  return canWorkHere(bot) && !closeCombatPlan() && await collectTreeTrunks(stockTarget, woodNames)
}

async function collectNearbyDrops(maxDistance = 16, maxCount = 6) {
  if (emergencyRetreating || !bot.entity || bot.health <= 0) return 0
  const connection = bot
  await clearBackpack(connection, 'nearby-drops')
  if (connection !== bot || !connection.entity) return 0
  const capped = INVENTORY_RESERVES.filter(([names, minimum]) => inventoryCount(names) >= minimum)
  const drops = findNearbyDrops(maxDistance).filter(({ entity }) => {
    const name = droppedStack(entity)?.name
    return !DEBRIS.has(name) && !capped.some(([names]) => names.has(name))
  }).slice(0, maxCount)
  if (drops.length === 0) return 0
  let collected = 0
  for (const drop of drops) {
    if (!bot.entities[drop.entity.id]) continue
    try {
      await gotoWithTimeout(new goals.GoalNearXZ(drop.entity.position.x, drop.entity.position.z, 1.5), 'drop path', 4500)
      await new Promise(resolve => setTimeout(resolve, 450))
      if (!bot.entities[drop.entity.id]) collected += 1
    } catch (error) {
      stopPathfinder()
      log('drop pickup skipped', { id: drop.entity.id, message: error.message })
    }
  }
  if (collected > 0) log('drops collected', { collected })
  return collected
}

const DEATH_RECOVERY_ATTEMPTS = 2
const DEATH_RECOVERY_COOLDOWN_MS = 25000
const VALUABLE_DEATH_GEAR = /^(iron|diamond|netherite)_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/
const VALUABLE_DEATH_ITEMS = new Set([
  'diamond', 'netherite_scrap', 'netherite_ingot', 'ancient_debris', 'elytra',
  'totem_of_undying', 'enchanted_golden_apple',
])

function carriedStackCounts(connection, valuableOnly = false) {
  const inventory = connection.inventory
  const items = [...inventory.items()]
  for (const slot of ['head', 'torso', 'legs', 'feet', 'off-hand']) {
    const item = inventory.slots[connection.getEquipmentDestSlot(slot)]
    if (item && !items.includes(item)) items.push(item)
  }
  const counts = new Map()
  const wanted = new Set()
  for (const item of items) {
    counts.set(item.name, (counts.get(item.name) ?? 0) + item.count)
    if (VALUABLE_DEATH_GEAR.test(item.name) || VALUABLE_DEATH_ITEMS.has(item.name) || item.enchants?.length) {
      wanted.add(item.name)
    }
  }
  if (!valuableOnly) return counts
  for (const [name, minimum] of [['raw_iron', 4], ['iron_ingot', 4], ['emerald', 4]]) {
    if ((counts.get(name) ?? 0) >= minimum) wanted.add(name)
  }
  return new Map([...wanted].map(name => [name, counts.get(name)]))
}

function deathRecoveryDue(connection = bot) {
  return deathPoint && !deathPoint.done && Date.now() >= deathPoint.nextAttemptAt &&
    connection?.entity && connection.health >= 16 && connection.food >= 14
}

function finishDeathRecovery(point, reason, details = {}) {
  point.done = true
  log('death recovery finished', { reason, attempts: point.attempts, ...details })
}

function deferDeathRecovery(point, reason, target = null) {
  if (point.attempts >= DEATH_RECOVERY_ATTEMPTS) {
    finishDeathRecovery(point, reason)
    return
  }
  point.nextAttemptAt = Date.now() + DEATH_RECOVERY_COOLDOWN_MS
  log('death recovery deferred', { reason, target, attempts: point.attempts })
}

function deathRecoveryThreat(connection, site) {
  const origin = connection.entity.position
  return Object.values(connection.entities).find(entity => {
    if (!entity.position || !isHostileEntity(entity)) return false
    const name = hostileName(entity)
    const reach = RANGED_HOSTILES.has(name) ? 16 : name === 'creeper' ? 11 : 8
    return entity.position.distanceTo(origin) <= reach || entity.position.distanceTo(site) <= reach
  })
}

async function recoverDeathDrops() {
  const point = deathPoint
  const connection = bot
  if (!point || point.done || recoveringDeathDrops || !canWorkHere(connection)) return false
  if (point.dimension !== (connection.game?.dimension ?? 'overworld')) {
    finishDeathRecovery(point, 'another-dimension')
    return false
  }
  const expiresAt = point.diedAt + DEATH_DROP_LIFETIME_MS - 15000
  if (Date.now() >= expiresAt) {
    finishDeathRecovery(point, 'expired')
    return false
  }
  if (!deathRecoveryDue(connection)) return false

  const goalPoint = new Vec3(point.x, point.y, point.z)
  const before = carriedStackCounts(connection)
  const missing = new Set([...point.loot].filter(([name, count]) => (before.get(name) ?? 0) < count).map(([name]) => name))
  if (!missing.size) {
    finishDeathRecovery(point, 'gear-already-carried')
    return false
  }
  const siteUnsafe = () => {
    const site = connection.blockAt(goalPoint)
    return goalPoint.y < connection.game.minY || (site && (isWaterBlock(site) || /lava|fire/.test(site.name)))
  }
  if (siteUnsafe()) {
    finishDeathRecovery(point, 'unsafe-terrain')
    return false
  }
  const firstThreat = deathRecoveryThreat(connection, goalPoint)
  if (firstThreat) {
    deferDeathRecovery(point, 'hostile-nearby', hostileName(firstThreat))
    return false
  }

  const startingHealth = connection.health
  const interruption = () => {
    if (point.done || bot !== connection || !botEnabled || !connection.entity || connection.health <= 0 ||
        Date.now() >= expiresAt) return { reason: 'interrupted' }
    if (connection.health < startingHealth) return { reason: 'damage', urgent: true }
    if (siteUnsafe()) return { reason: 'unsafe-terrain' }
    if (connection.food < 14 || waterOwnsMovement() || emergencyRetreating || fleeingActive) return { reason: 'survival-priority' }
    const threat = deathRecoveryThreat(connection, goalPoint)
    if (threat) return { reason: 'hostile-nearby', target: hostileName(threat),
      urgent: threat.position.distanceTo(connection.entity.position) <= THREAT_RADIUS }
    return null
  }

  let stopped = null
  const walk = async (goal, label, timeout) => {
    const watch = setInterval(() => {
      stopped ??= interruption()
      if (stopped && bot === connection && connection.pathfinder.goal === goal) connection.pathfinder.setGoal(null)
    }, 100)
    try {
      await gotoWithTimeout(goal, label, timeout)
    } catch (error) {
      if (!stopped) log('death recovery path interrupted', { message: error.message })
    } finally {
      clearInterval(watch)
    }
    stopped ??= interruption()
    return !stopped
  }

  const nearbyDeathDrops = () => findNearbyDrops(10).filter(({ entity }) =>
    entity.position.distanceTo(goalPoint) <= 8 && missing.has(droppedStack(entity)?.name))
  const stillNearby = () => connection.entity.position.distanceTo(goalPoint) <= 4
  const travel = connection.entity.position.distanceTo(goalPoint)
  recoveringDeathDrops = true
  mineMode = false
  point.attempts += 1
  lastDecision = 'death-recovery'
  navigationState = { target: { x: point.x, y: point.y, z: point.z, name: 'death-point' }, waypoints: [], label: 'death-recovery' }
  log('recovering death drops', { point: goalPoint, attempt: point.attempts, wanted: [...missing] })
  try {
    if (!stillNearby()) await walk(new goals.GoalNear(point.x, point.y, point.z, 3), 'death recovery path', Math.min(16000, 5000 + travel * 400))
    if (!stopped && stillNearby()) {
      const tried = new Set()
      for (let i = 0; i < 4 && !interruption(); i += 1) {
        const target = nearbyDeathDrops().find(({ entity }) => !tried.has(entity.id))?.entity
        if (!target) break
        tried.add(target.id)
        const feet = target.position.floored()
        if (!await walk(new goals.GoalBlock(feet.x, feet.y, feet.z), 'valuable death drop pickup', 3500)) break
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
    stopped ??= interruption()
    if (stopped) {
      if (!point.done) {
        if (stopped.reason === 'unsafe-terrain') finishDeathRecovery(point, stopped.reason)
        else deferDeathRecovery(point, stopped.reason, stopped.target)
      }
      if (stopped.urgent) urgentThreatQueued = true
      return true
    }
    const after = carriedStackCounts(connection)
    const gained = [...missing].reduce((sum, name) => sum + Math.max(0, (after.get(name) ?? 0) - (before.get(name) ?? 0)), 0)
    const reached = stillNearby()
    const dropsLeft = reached ? nearbyDeathDrops().length : null
    log('death recovery result', { gained, dropsLeft, reached, attempt: point.attempts })
    if (gained && dropsLeft === 0) {
      finishDeathRecovery(point, 'valuable-loot-recovered', { gained })
      persistExperience({ cycle, action: 'death-recovery', experience: `回收 ${gained} 个值得取回的掉落物` })
    } else {
      deferDeathRecovery(point, reached ? 'valuable-loot-unconfirmed' : 'unreachable')
    }
    return true
  } finally {
    if (bot === connection && navigationState.label === 'death-recovery') clearNavigation('death-recovery-done')
    recoveringDeathDrops = false
  }
}

async function gatherStationStone(count, ready, exact = null) {
  if (!hasTool('pickaxe')) {
    if (plankCount() + inventoryCount(LOG_NAMES) * 4 < 9) await collectWoodWithPlan(null, Math.ceil((9 - plankCount()) / 4))
    if (ready()) await prepareStarterGear()
  } else if (mineNeedsNewGround) {
    mineNeedsNewGround = false
    await exploreOneStep()
  } else if (ready()) {
    await mineForGear(null, 'stone', null, { stoneLimit: count, stoneDrop: exact })
  }
}

async function supplyStationMaterials(connection, materials, ready) {
  for (const [block, count] of Object.entries(materials)) {
    if (['planks', 'chest', 'furnace', 'torch'].includes(block) || inventoryItemCount(block) >= count) continue
    const logName = block.replace(/_planks$/, '_log')
    if (block.endsWith('_planks') && LOG_NAMES.has(logName)) {
      const logCount = Math.ceil((count - inventoryItemCount(block)) / 4)
      if (inventoryItemCount(logName) < logCount) {
        await collectWoodWithPlan(null, logCount, new Set([logName]))
        return false
      }
      if (!await makePlanksFor(count, block) || !ready()) return false
    } else if (STONE_DROPS.has(block)) {
      await gatherStationStone(count, ready, block)
      return false
    } else {
      log('structure material unavailable', { block, missing: count - inventoryItemCount(block) })
      return false
    }
  }
  const chestNeeded = materials.chest && !inventoryItemCount('chest')
  const furnaceNeeded = materials.furnace && !inventoryItemCount('furnace')
  const torchNeeded = materials.torch && !inventoryItemCount('torch')
  if (furnaceNeeded && inventoryCount(STONE_DROPS) < 8) {
    await gatherStationStone(8, ready)
    return false
  }

  const planks = (materials.planks ?? 0) + (chestNeeded ? 8 : 0) +
    (chestNeeded || furnaceNeeded ? 4 : 0) + (torchNeeded ? 3 : 0)
  if (plankCount() + inventoryCount(LOG_NAMES) * 4 < planks) {
    await collectWoodWithPlan(null, Math.ceil((planks - plankCount()) / 4))
    return false
  }
  if (!await makePlanksFor(planks) || !ready()) return false

  if (chestNeeded || furnaceNeeded) {
    try {
      const table = await ensureCraftingTable()
      if (!table || !ready()) return false
      if (chestNeeded && !await craftNamed('chest', table)) return false
      if (furnaceNeeded && (!ready() || !await craftNamed('furnace', table))) return false
    } finally {
      await reclaimTemporaryCraftingTable()
    }
  }
  if (torchNeeded && ready()) {
    if (!inventoryCount(IRON_FUEL_NAMES)) {
      if (!inventoryCount(LOG_NAMES)) {
        await collectWoodWithPlan(null, 1)
        return false
      }
      await processFurnaceBatch(LOG_NAMES, 'supply station charcoal ready', 16000,
        item => item.name.endsWith('_planks'), 1)
    }
    if (!ready()) return false
    if (!inventoryItemCount('stick') && !await craftNamed('stick')) return false
    if (!await craftNamed('torch')) return false
  }
  return connection === bot && ready() && Object.entries(materials).every(([block, count]) =>
    (block === 'planks' ? plankCount() : inventoryItemCount(block)) >= count)
}

async function buildSupplyStation() {
  const connection = bot
  const ready = () => canWorkHere(connection) && !foodRecoveryNeeded(connection) &&
    !closeCombatPlan() && !damageInterruptActive(connection) && Date.now() >= retreatUntil
  if (!ready()) return
  lastDecision = supplyStation.schematic ? 'build-structure' : 'build-camp'
  const constructionMovement = new Movements(connection)
  constructionMovement.canDig = false
  constructionMovement.scafoldingBlocks = []
  constructionMovement.allow1by1towers = false
  constructionMovement.allowParkour = false
  constructionMovement.maxDropDown = 2
  const now = Date.now()
  for (const [key, until] of stationBlockedSteps) {
    if (until <= now) stationBlockedSteps.delete(key)
  }
  constructionMovement.exclusionAreasStep.push(block => {
    if (!block?.position) return 0
    const key = `${block.position.x},${block.position.z}`
    return isWaterBlock(block) || stationBlockedSteps.has(key) ? 100 : 0
  })
  const walk = async (goal, timeout) => {
    if (!ready()) return false
    connection.pathfinder.setMovements(constructionMovement)
    let lastPosition = connection.entity.position.clone()
    let lastProgress = Date.now()
    const watch = setInterval(() => {
      if (connection.pathfinder.goal !== goal) return
      if (!ready()) {
        connection.pathfinder.setGoal(null)
        return
      }
      const current = connection.entity.position
      if (lastPosition.distanceTo(current) >= 0.4) {
        lastPosition = current.clone()
        lastProgress = Date.now()
        return
      }
      if (Date.now() - lastProgress < 2700) return
      const feet = current.floored()
      const next = visibleNavigationState().waypoints.map(point => new Vec3(point.x, point.y, point.z).floored())
        .find(point => point.distanceTo(feet) <= 2 && (point.x !== feet.x || point.z !== feet.z))
      if (!next) return
      stationBlockedSteps.set(`${next.x},${next.z}`, Date.now() + 30000)
      log('supply station route replanned', { from: feet, blockedStep: next })
      connection.pathfinder.setGoal(null)
    }, 100)
    try {
      await gotoWithTimeout(goal, 'supply station movement', timeout)
      return ready()
    } catch {
      return false
    } finally {
      clearInterval(watch)
      if (connection === bot) connection.pathfinder.setMovements(movements)
    }
  }
  let disconnected
  const connectionEnded = new Promise(resolve => { disconnected = resolve })
  connection.once('end', disconnected)
  try {
    await Promise.race([connectionEnded, supplyStation.step(connection, { ready, walk, log, explore: exploreOneStep,
      materials: materials => supplyStationMaterials(connection, materials, ready), dig: digWithExposure })])
  } catch (error) {
    log('supply station step interrupted', { ...supplyStation.status(), message: error.message })
  } finally {
    connection.removeListener('end', disconnected)
    if (!ready() && !mineMode) supplyStation.interrupt(log, 'survival priority')
  }
}

// Pick an explore direction that leads away from nearby water: sample a ring of
// candidates and keep the first whose target column and route midpoint are dry.
function pickDryExploreTarget(origin, minDistance = 12, maxExtra = 18) {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const angle = Math.random() * Math.PI * 2
    const distance = minDistance + Math.floor(Math.random() * maxExtra)
    const x = origin.x + Math.round(Math.cos(angle) * distance)
    const z = origin.z + Math.round(Math.sin(angle) * distance)
    const mx = origin.x + Math.round(Math.cos(angle) * distance / 2)
    const mz = origin.z + Math.round(Math.sin(angle) * distance / 2)
    const column = position => {
      for (let dy = 4; dy >= -6; dy -= 1) {
        const block = bot.blockAt(new Vec3(position.x, origin.y + dy, position.z))
        if (block && block.boundingBox === 'block') return block
      }
      return null
    }
    const end = column({ x, z })
    const mid = column({ x: mx, z: mz })
    if (!end || !mid || WATER_BLOCK_NAMES.has(end.name) || WATER_BLOCK_NAMES.has(mid.name)) continue
    const top = bot.blockAt(end.position.offset(0, 1, 0))
    if (top && WATER_BLOCK_NAMES.has(top.name)) continue
    return { x, z }
  }
  return null
}

async function exploreOneStep(modelTarget = null) {
  const origin = bot.entity.position.floored()
  const angle = Math.random() * Math.PI * 2
  const distance = 12 + Math.floor(Math.random() * 18)
  let randomTarget = origin.offset(Math.round(Math.cos(angle) * distance), 0, Math.round(Math.sin(angle) * distance))
  const dryTarget = pickDryExploreTarget(origin)
  if (dryTarget) randomTarget = new Vec3(dryTarget.x, origin.y, dryTarget.z)
  // For a short time after leaving water ignore a model target that is wet or
  // beside water, so the bot does not walk straight back in.
  if (modelTarget && Date.now() - landedAt < 8000) {
    const probe = bot.blockAt(new Vec3(Number(modelTarget.x), origin.y - 1, Number(modelTarget.z)))
    if (!probe || WATER_BLOCK_NAMES.has(probe.name) || isWaterAdjacent(probe.position)) {
      log('explore target near water right after landing; ignored', { modelTarget })
      modelTarget = null
    }
  }
  let target = clampModelTarget(modelTarget, origin, 64)
  // A model target on top of the bot makes explore a no-op, which is how the
  // bot ended up idling in place. Require real travel, else pick a random one.
  if (target && Math.hypot(target.x - origin.x, target.z - origin.z) < 8) {
    log('explore target too close; using random target', { rejected: target })
    target = null
  }
  if (!target) target = { x: randomTarget.x, z: randomTarget.z }
  log('exploring', { from: origin, target })
  try {
    // Let the pathfinder choose the reachable surface height. Requiring the
    // random target to have the bot's exact Y coordinate made exploration
    // fail immediately on hills, trees, and uneven terrain.
    await gotoDestination(target, 'explore')
  } catch (firstError) {
    stopPathfinder()
    const fallback = origin.offset(Math.round(Math.cos(angle) * 8), 0, Math.round(Math.sin(angle) * 8))
    log('path replan', { reason: firstError.message, fallback: { x: fallback.x, z: fallback.z } })
    persistExperience({ cycle, action: 'path-replan', experience: `目标寻路失败，改用近距离目标：${firstError.message}` })
    await gotoDestination({ x: fallback.x, z: fallback.z }, 'explore fallback')
  }
  await maybePlaceTorch()
}

async function executeAttack(threat, modelDecision = null) {
  const connection = bot
  if (!threat || !connection?.entity || waterOwnsMovement() || isEating || meleeConnection) return false
  let name = hostileName(threat)
  if (mustAvoidMelee(threat)) {
    return threat.position.distanceTo(bot.entity.position) <= 8 ? executeFlee(threat) : false
  }
  mineMode = false
  meleeConnection = connection
  lastDecision = 'hunt-hostile'
  log('combat pursuit started', { target: name, id: threat.id, reason: modelDecision?.reason || 'visible hostile' })
  const defensive = modelDecision?.defensive === true
  const deadline = Date.now() + (defensive ? 6500 : 18000)
  let killed = false
  const onDeath = entity => { if (entity.id === threat.id) killed = true }
  connection.on('entityDead', onDeath)
  let attempts = 0
  try {
    await equipCombatItem()
    while (connection === bot && Date.now() < deadline && bot.health > 0 && !waterOwnsMovement() && !emergencyRetreating && !killed) {
      if (impactGuards.has(connection)) {
        await new Promise(resolve => setTimeout(resolve, 60))
        continue
      }
      let live = bot.entities[threat.id]
      const danger = closeCombatPlan(live)
      if (danger?.action === 'attack' && danger.target.id !== live?.id) {
        const previous = live?.id ?? threat.id
        threat = live = danger.target
        name = hostileName(live)
        attempts = 0
        log('combat target switched', { previous, target: name, id: live.id })
      }
      if (!live || live.isValid === false) break
      if (mustAvoidMelee(live) || danger?.action === 'flee') {
        lowerCombatShield(connection)
        lastCombatDecision = { action: 'flee', reason: danger?.reason || '交战中状态下降，立即撤退' }
        await executeFlee(danger?.target || live, lastCombatDecision)
        break
      }
      const sight = hostileSight(live)
      if (sight.visible && sight.distance <= 3.8) {
        await bot.lookAt(sight.center, true)
        if (impactGuards.has(connection)) continue
        const guarding = raiseCombatShield(connection, live)
        if (guarding && !defensive && sight.distance > 2.7) stepWhileShielding(connection, sight.center, live.position)
        else stopShieldSteps(connection)
        const cooldown = meleeCooldown(bot.heldItem)
        const shieldReady = !guarding || Date.now() - raisedShields.get(connection) >= SHIELD_READY_MS
        if (sight.distance <= 3 && shieldReady && Date.now() - lastManualAttackAt >= cooldown &&
            bot.entityAtCursor(3)?.id === threat.id) {
          lowerCombatShield(connection)
          bot.attack(live, true)
          lastManualAttackAt = Date.now()
          attempts = 0
          log('combat swing', { target: name, id: live.id })
        }
        if (sight.distance <= 3 || (guarding && Date.now() - raisedShields.get(connection) < SHIELD_READY_MS + 250)) {
          await new Promise(resolve => setTimeout(resolve, 110))
          continue
        }
      }
      lowerCombatShield(connection)
      if (defensive) {
        await new Promise(resolve => setTimeout(resolve, 100))
        continue
      }
      if (++attempts > 6) break
      const { x, y, z } = live.position.floored()
      navigationState = { target: { x, y, z, name }, waypoints: [], label: 'hunt-hostile' }
      try {
        await gotoWithTimeout(new goals.GoalNear(x, y, z, sight.visible ? 2 : 1), 'combat approach', 1250)
      } catch {
        if (waterOwnsMovement() || emergencyRetreating) break
      }
      await new Promise(resolve => setTimeout(resolve, 120))
    }
  } finally {
    if (!fleeingActive && !impactGuards.has(connection)) lowerCombatShield(connection)
    meleeConnection = null
    connection.removeListener('entityDead', onDeath)
    clearNavigation('combat-ended')
    log('combat ended', { target: name, id: threat.id, killed })
    if (killed && closeCombatPlan()) urgentThreatQueued = true
    if (!killed) lastUnreachedHostile = { id: threat.id, until: Date.now() + 6000 }
    persistExperience({ cycle, action: 'attack', experience: killed ? `击杀 ${name}` : `追击 ${name} 结束，未确认击杀` })
  }
  return true
}

async function executeFlee(threat, modelDecision = null) {
  const connection = bot
  if (!connection?.entity || connection.health <= 0 || waterOwnsMovement() ||
      fleeingActive || impactGuards.has(connection)) return false
  fleeingActive = true
  retreatUntil = Date.now() + 10000
  activeGoal = null
  mineMode = false
  lastDecision = 'flee'
  const recoveringFromLowHealth = connection.health <= 8
  try {
    lowerCombatShield(connection)
    stopPathfinder()
    connection.pvp.stop()
    const ranged = threat && /^(skeleton|stray|bogged|pillager)$/.test(hostileName(threat))
    const distance = threat?.position.distanceTo(connection.entity.position)
    if (ranged && distance >= 4 && distance <= 12 && hostileSight(threat).visible &&
        Date.now() - (lastRangedGuard.get(connection) ?? 0) >= 3000 && !isEating) {
      try {
        connection.clearControlStates()
        if (await equipCombatShield(connection)) {
          await connection.lookAt(hostileSight(threat).center, true)
          if (connection === bot && raiseCombatShield(connection, threat)) {
            lastRangedGuard.set(connection, Date.now())
            const here = connection.entity.position
            const away = here.minus(threat.position)
            stepWhileShielding(connection, threat.position, here.offset(away.x, 0, away.z))
            await new Promise(resolve => setTimeout(resolve, 450))
          }
        }
      } finally {
        if (!impactGuards.has(connection)) lowerCombatShield(connection)
      }
    }
    if (connection !== bot || connection.health <= 0 || waterOwnsMovement()) return false
    let advanced = false
    for (let leg = 0; leg < 5 && connection === bot && connection.health > 0 && !waterOwnsMovement(); leg += 1) {
      if (recoveringFromLowHealth && safeToEatOnRetreat(connection)) await restAfterRetreat(connection)
      if (connection !== bot || connection.health <= 0 || waterOwnsMovement()) return false
      if (await tryEmergencyPit(connection)) return true
      const plan = closeCombatPlan()
      if (leg > 0 && plan?.action === 'attack' && (!recoveringFromLowHealth || connection.health >= 20)) {
        urgentThreatQueued = true
        return true
      }
      if (leg > 0 && !findNearestHostile(14)) return true
      if (plan?.action === 'flee') threat = plan.target
      advanced = await executeRetreatLeg(connection, threat, leg === 0 ? modelDecision : null)
      if (!advanced) break
    }
    if (advanced) await tryEmergencyPit(connection)
    return true
  } finally {
    if (!impactGuards.has(connection)) lowerCombatShield(connection)
    retreatUntil = Date.now() + 6000
    fleeingActive = false
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
    const modelTarget = clampModelTarget(modelDecision?.target, origin, 14)
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
      while (connection === bot && impactGuards.has(connection)) {
        await new Promise(resolve => setTimeout(resolve, 60))
      }
      if (bot !== connection || connection.health <= 0 || waterOwnsMovement()) break
      navigationState = { target, waypoints: [], label: 'flee' }
      log('fleeing', { target, threat: entityNameOf(threat) || null, reason: modelDecision?.reason || '' })
      try {
        await gotoRetreatWaypoint(connection, target)
        pursuit.goals += 1
        pursuit.updated = Date.now()
        log('retreat waypoint reached', { target, position: connection.entity.position.floored() })
        return true
      } catch (error) {
        log('retreat route interrupted', { target, message: error.message })
      }
    }
    return false
}

async function gotoRetreatWaypoint(connection, target) {
  const goal = new goals.GoalNearXZ(target.x, target.z, 1)
  let lastPosition = connection.entity.position.clone()
  let lastProgress = Date.now()
  const watch = setInterval(() => {
    if (connection !== bot || connection.pathfinder.goal !== goal || !connection.entity) return
    if (connection.entity.position.distanceTo(lastPosition) >= 0.35) {
      lastPosition = connection.entity.position.clone()
      lastProgress = Date.now()
    } else if (Date.now() - lastProgress >= 950) {
      log('retreat route stalled; changing direction', { target })
      connection.pathfinder.setGoal(null)
    }
  }, 125)
  try {
    await gotoWithTimeout(goal, 'flee', 4200)
  } finally {
    clearInterval(watch)
  }
}

const WOOL_NAMES = /_wool$/

// Try to make and use a bed: 3 wool + 3 planks. Sheep drop 1 wool; shearing is
// not available this early, so the bot must kill three sheep (or pick up wool).
async function tryBed() {
  if (bot.inventory.items().some(item => item.name.endsWith('_bed'))) return true
  const wool = () => bot.inventory.items().filter(item => WOOL_NAMES.test(item.name))
    .reduce((sum, item) => sum + item.count, 0)
  // Hunt sheep that are close enough to reach before dark.
  for (let attempt = 0; attempt < 6 && wool() < 3 && canWorkHere(bot); attempt += 1) {
    const sheep = Object.values(bot.entities).find(entity =>
      entityNameOf(entity) === 'sheep' && entity.position.distanceTo(bot.entity.position) < 30)
    if (!sheep) break
    try {
      await equipCombatItem()
      await gotoWithTimeout(new goals.GoalNear(sheep.position.x, sheep.position.y, sheep.position.z, 2), 'sheep approach', 6000)
      for (let swing = 0; swing < 8 && bot.entities[sheep.id]; swing += 1) {
        await bot.lookAt(sheep.position.offset(0, 0.8, 0), true)
        bot.attack(sheep, true)
        await new Promise(resolve => setTimeout(resolve, 450))
      }
      await collectNearbyDrops(8)
    } catch (error) {
      stopPathfinder()
      log('sheep hunt interrupted', { message: error.message })
    }
  }
  if (wool() < 3) return false
  const woolItem = bot.inventory.items().find(item => WOOL_NAMES.test(item.name))
  const colour = woolItem.name.replace(/_wool$/, '')
  if (!await makePlanksFor(3)) return false
  const table = await ensureCraftingTable()
  const crafted = Boolean(table && await craftNamed(`${colour}_bed`, table))
  await reclaimTemporaryCraftingTable()
  return crafted
}

// Place the bed on a flat spot and sleep. Returns true once the bot slept or
// set its spawn; false means the caller should fall back to the pit.
async function placeAndSleep() {
  const bed = bot.inventory.items().find(item => item.name.endsWith('_bed'))
  if (!bed) return false
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const ground = bot.blockAt(base.offset(dx, -1, dz))
    const above = bot.blockAt(base.offset(dx, 0, dz))
    const farGround = bot.blockAt(base.offset(dx * 2, -1, dz * 2))
    const farAbove = bot.blockAt(base.offset(dx * 2, 0, dz * 2))
    if (ground?.boundingBox !== 'block' || farGround?.boundingBox !== 'block') continue
    if (!EMPTY_BLOCK.test(above?.name) || !EMPTY_BLOCK.test(farAbove?.name)) continue
    try {
      await bot.equip(bed, 'hand')
      await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true)
      await bot.placeBlock(ground, new Vec3(0, 1, 0))
      const placed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 4 })
      if (!placed) continue
      await bot.sleep(placed)
      log('sleeping in bed', { position: placed.position })
      return true
    } catch (error) {
      log('bed use failed', { message: error.message })
      // "not night" or "monsters nearby" still sets the respawn point on use.
      const placed = bot.findBlock({ matching: block => block.name.endsWith('_bed'), maxDistance: 4 })
      if (placed && /night|monsters|sleep/i.test(error.message)) return false
    }
  }
  return false
}

// "Dig three, fill one": a 1x1 pit three blocks deep, then seal the top.
const EMERGENCY_PIT_SOIL = new Set(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol'])

function pitFiller(connection) {
  return connection.inventory.items().find(item =>
    SHELTER_FILL.has(item.name) && item.name !== 'sand' && item.name !== 'gravel')
}

async function tryEmergencyPit(connection) {
  if (connection !== bot || connection.health <= 0 || connection.health > 8 ||
      !connection.entity?.onGround || shelterBusy || Date.now() < nextEmergencyShelterAt ||
      impactGuards.has(connection) || waterOwnsMovement() || findNearestHostile(14) ||
      nightShelterTerrain() !== 'open') return false
  const feet = connection.entity.position.floored()
  if (![1, 2, 3].every(depth => EMERGENCY_PIT_SOIL.has(connection.blockAt(feet.offset(0, -depth, 0))?.name))) return false
  const bottom = connection.blockAt(feet.offset(0, -4, 0))
  if (bottom?.boundingBox !== 'block' || WATER_BLOCK_NAMES.has(bottom.name) || bottom.name === 'lava') return false
  if (![[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) =>
    connection.blockAt(feet.offset(x, -1, z))?.boundingBox === 'block')) return false
  nextEmergencyShelterAt = Date.now() + 18000
  shelterBusy = true
  lastDecision = 'emergency-shelter'
  log('emergency pit started', { health: connection.health, position: feet })
  try {
    if (!await digPitShelter(true) || connection !== bot || connection.health <= 0) return false
    emergencyShelteredUntil = Date.now() + 12000
    lastCombatDecision = { action: 'flee', reason: '已拉开距离，挖坑封顶避险' }
    log('emergency pit sealed', { holdMs: 12000, health: connection.health })
    return true
  } catch (error) {
    log('emergency pit interrupted', { message: error.message })
    return false
  } finally {
    shelterBusy = false
  }
}

async function digPitShelter(emergency = false) {
  const connection = bot
  if (nightShelterTerrain() !== 'open' || (!emergency && !isNightShelterTime(bot.time.timeOfDay))) return false
  let start = bot.entity.position.floored()
  const spot = bot.blockAt(start.offset(0, -1, 0))
  if (!spot || spot.boundingBox !== 'block' || WATER_BLOCK_NAMES.has(spot.name)) return false
  let initialFiller = pitFiller(bot)
  if (!emergency && !initialFiller) {
    const soft = findNearestBlock(new Set(['dirt', 'grass_block', 'sand']), 3)
    if (soft && canWorkHere(bot) && bot.canDigBlock(soft)) {
      try {
        await bot.dig(soft, true)
        await pickUpBlockDrop(new Set(['dirt', 'sand']), soft.position, 0)
        if (connection !== bot) return false
        initialFiller = pitFiller(bot)
      } catch {}
    }
  }
  if (!emergency && !initialFiller) {
    log('pit shelter skipped; no filler block to seal pit')
    return false
  }
  if (connection !== bot || connection.health <= 0) return false
  start = bot.entity.position.floored()
  mineMode = false
  stopPathfinder()
  bot.clearControlStates()
  const firstBlock = connection.blockAt(start.offset(0, -1, 0))
  if (firstBlock) await equipBestToolFor(firstBlock)
  for (let depth = 1; depth <= 3; depth += 1) {
    if (connection !== bot || connection.health <= 0 || waterOwnsMovement()) return false
    const below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0))
    if (!below || below.boundingBox !== 'block') break
    // Never dig down into liquid or a cave void: check two blocks down first.
    const under = bot.blockAt(below.position.offset(0, -1, 0))
    if (!under || WATER_BLOCK_NAMES.has(under.name) || under.name === 'lava' || under.boundingBox !== 'block') break
    try {
      await bot.dig(below, true)
      await new Promise(resolve => setTimeout(resolve, 350))
    } catch (error) {
      log('pit dig failed', { depth, message: error.message })
      break
    }
  }
  const floorY = Math.floor(bot.entity.position.y)
  if (start.y - floorY < 2) return false
  if (emergency && !pitFiller(connection)) await new Promise(resolve => setTimeout(resolve, 200))
  if (connection !== bot || connection.health <= 0) return false
  const filler = pitFiller(bot)
  if (!filler) return false
  // Seal the hole above. The bot's head is at floorY + 1; the cell to close is
  // floorY + 2 in the same column. A block is placed ON a face of a reference
  // block, so use the pit wall one level up (floorY + 2) beside that cell and
  // click its face that looks into the column, i.e. the direction (-dx, 0, -dz).
  const column = { x: start.x, z: start.z }
  const sealCell = bot.blockAt(new Vec3(column.x, floorY + 2, column.z))
  if (!sealCell || !EMPTY_BLOCK.test(sealCell.name)) return false
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const wall = bot.blockAt(new Vec3(column.x + dx, floorY + 2, column.z + dz))
    if (!wall || wall.boundingBox !== 'block') continue
    try {
      await bot.equip(filler, 'hand')
      await bot.look(Math.atan2(dx, dz) + Math.PI, -0.9, true) // look up-and-across toward the cell
      await bot.placeBlock(wall, new Vec3(-dx, 0, -dz))
      if (!EMPTY_BLOCK.test(bot.blockAt(sealCell.position)?.name)) {
        shelterInfo = { kind: 'pit', seal: sealCell.position }
        log('pit sealed', { depth: start.y - floorY, at: { x: column.x, y: floorY, z: column.z } })
        return true
      }
    } catch (error) {
      log('pit seal skipped', { wall: wall.position, message: error.message })
    }
  }
  return false
}

// Night 1 route from the guide: sheep -> bed; no sheep -> pit; last resort walls.
async function firstNightShelter() {
  if (shelterBusy || nightShelterTerrain() !== 'open' || !isNightShelterTime(bot.time.timeOfDay)) return false
  shelterBusy = true
  try {
    mineMode = false
    stopPathfinder()
    if (await tryBed() && await placeAndSleep()) {
      shelterInfo = { kind: 'bed' }
      nightsSheltered += 1
      persistExperience({ cycle, action: 'night-shelter', experience: '用羊毛和木板做床并睡觉，跳过夜晚' })
      return true
    }
    // Looking for sheep or a place to craft can lead under a roof.
    if (nightShelterTerrain() !== 'open' || !isNightShelterTime(bot.time.timeOfDay)) return false
    if (await digPitShelter()) {
      nightsSheltered += 1
      persistExperience({ cycle, action: 'night-shelter', experience: '没有床，挖三格深的坑并封住头顶等天亮' })
      return true
    }
    // The pit could not be sealed. Do not dig another one (that is how it
    // ended up 27 blocks underground): count this night as handled, surface,
    // and carry on with the normal threat handling.
    nightsSheltered += 1
    shelterAttemptedTonight = true
    log('first-night shelter failed; continuing without it')
    persistExperience({ cycle, action: 'night-shelter', experience: '坑没封上，本夜不再重复挖坑，改用常规避敌' })
    return false
  } finally {
    shelterBusy = false
  }
}

// Open one side of the shelter at dawn so the pathfinder can leave.
async function breakShelter() {
  const info = shelterInfo
  shelterInfo = null
  if (info?.kind === 'bed') return true
  if (info?.kind === 'pit') {
    // Dig the seal, then climb out by stacking: dig the wall into a staircase.
    const seal = bot.blockAt(info.seal)
    try {
      if (seal && seal.boundingBox === 'block') { await equipBestToolFor(seal); await bot.dig(seal, true) }
      for (let step = 0; step < 4; step += 1) {
        const here = bot.entity.position.floored()
        const above = bot.blockAt(here.offset(0, 2, 0))
        if (above && above.boundingBox === 'block') await bot.dig(above, true)
        const placeable = bot.inventory.items().find(item => SHELTER_FILL.has(item.name))
        const floor = bot.blockAt(here.offset(0, -1, 0))
        if (!placeable || !floor) break
        bot.setControlState('jump', true)
        await new Promise(resolve => setTimeout(resolve, 280))
        await bot.equip(placeable, 'hand')
        try { await bot.placeBlock(floor, new Vec3(0, 1, 0)) } catch {}
        bot.setControlState('jump', false)
        if (bot.entity.position.y >= info.seal.y) break
      }
      log('pit shelter opened at dawn')
      return true
    } catch (error) {
      bot.setControlState('jump', false)
      log('pit open failed', { message: error.message })
      return false
    }
  }
  const base = bot.entity.position.floored()
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const wall = bot.blockAt(base.offset(dx, 0, dz))
    if (wall && wall.boundingBox === 'block' && bot.canDigBlock(wall)) {
      try {
        await equipBestToolFor(wall)
        await bot.dig(wall, true)
        log('shelter opened at dawn', { position: wall.position })
        return true
      } catch (error) {
        log('shelter open failed', { message: error.message })
      }
    }
  }
  return false
}

const SHELTER_FILL = new Set(['dirt', 'cobblestone', 'stone', 'deepslate', 'sand', 'gravel', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks'])

// Night and no sword/axe: sealing yourself in is safer than running. Dig one
// block into the hillside facing solid ground (or stand in the open and wall
// the four sides and the top), then wait until morning.
async function nightShelter() {
  if (!bot?.entity || bot.health <= 0 || waterOwnsMovement() || shelterBusy) return false
  const countFill = () => bot.inventory.items()
    .filter(item => SHELTER_FILL.has(item.name)).reduce((sum, item) => sum + item.count, 0)
  shelterBusy = true
  try {
    // After a respawn the inventory is empty: punch a few dirt/sand blocks
    // within reach first (hand digging is fine for these).
    for (let attempt = 0; attempt < 10 && countFill() < 8; attempt += 1) {
      const soil = bot.findBlock({
        maxDistance: 4,
        matching: block => ['dirt', 'grass_block', 'sand', 'coarse_dirt'].includes(block.name) &&
          block.position.y >= Math.floor(bot.entity.position.y) - 1,
      })
      if (!soil || !bot.canDigBlock(soil)) break
      try {
        await bot.dig(soil, true)
        await new Promise(resolve => setTimeout(resolve, 150))
      } catch { break }
    }
    if (countFill() < 6) {
      log('night shelter skipped; not enough fill blocks', { have: countFill() })
      return false
    }
    mineMode = false
    stopPathfinder()
    bot.pvp.stop()
    bot.clearControlStates()
    const base = bot.entity.position.floored()
    const ring = [[1, 0], [-1, 0], [0, 1], [0, -1]]
    const toSeal = []
    for (const [dx, dz] of ring) {
      for (const dy of [0, 1]) toSeal.push(base.offset(dx, dy, dz))
    }
    toSeal.push(base.offset(0, 2, 0))
    let placed = 0
    for (const position of toSeal) {
      const block = bot.blockAt(position)
      if (!block || block.boundingBox === 'block') continue
      if (WATER_BLOCK_NAMES.has(block.name) || block.name === 'lava') continue
      const item = bot.inventory.items().find(i => SHELTER_FILL.has(i.name))
      if (!item) break
      // Find any solid neighbour to place against.
      const neighbours = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]
      let reference = null
      let face = null
      for (const [nx, ny, nz] of neighbours) {
        const candidate = bot.blockAt(position.offset(nx, ny, nz))
        if (candidate && candidate.boundingBox === 'block' && !candidate.position.equals(base) &&
            !candidate.position.equals(base.offset(0, 1, 0))) {
          reference = candidate
          face = new Vec3(-nx, -ny, -nz)
          break
        }
      }
      if (!reference) continue
      try {
        await bot.equip(item, 'hand')
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true)
        await bot.placeBlock(reference, face)
        placed += 1
      } catch (error) {
        log('shelter placement skipped', { position, message: error.message })
      }
    }
    log('night shelter built', { placed, at: base })
    persistExperience({ cycle, action: 'night-shelter', experience: `夜间无武器，用 ${placed} 个方块把自己围起来等天亮，避免被苦力怕和僵尸围攻` })
    return placed >= 4
  } finally {
    shelterBusy = false
  }
}

async function backstepFromThreat(threat, durationMs = 1800) {
  if (!threat || !bot.entity || bot.health <= 0 || waterOwnsMovement()) return false
  try {
    await bot.lookAt(threat.position.offset(0, 1, 0), true)
    bot.pvp.stop()
    bot.setControlState('sprint', true)
    bot.setControlState('back', true)
    bot.setControlState('jump', true)
    await new Promise(resolve => setTimeout(resolve, durationMs))
    if (waterOwnsMovement()) return false
    bot.setControlState('back', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    log('local backstep completed', { threat: entityNameOf(threat), distance: Number(threat.position.distanceTo(bot.entity.position).toFixed(1)) })
    return true
  } catch (error) {
    bot.setControlState('back', false)
    bot.setControlState('sprint', false)
    bot.setControlState('jump', false)
    log('local backstep failed', { message: error.message })
    return false
  }
}

async function handleScriptFallbackThreat() {
  const candidates = nearbyThreatSignature().threats
    .map(({ id }) => bot.entities[id])
    .filter(entity => entity && hostileSight(entity).visible)
  const danger = candidates.find(entity => mustAvoidMelee(entity) && entity.position.distanceTo(bot.entity.position) < 8)
  if (danger) return executeFlee(danger)
  const target = candidates.find(entity => !mustAvoidMelee(entity) &&
    (lastUnreachedHostile?.id !== entity.id || Date.now() > lastUnreachedHostile.until))
  return target ? executeAttack(target) : false
}

const RANGED_HOSTILES = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch'])
const VERY_DANGEROUS_HOSTILES = new Set(['warden', 'ravager', 'wither', 'ender_dragon'])

function threatRange(name) {
  return RANGED_HOSTILES.has(name) ? 14 : 8
}

function closeCombatPlan(currentTarget = null) {
  if (!bot?.entity || bot.health <= 0) return null
  const threats = nearbyThreatSignature().threats
    .filter(({ distance, name }) => distance <= threatRange(name))
    .map(({ id }) => bot.entities[id]).filter(entity => entity && hostileSight(entity).visible)
  if (!threats.length) return null
  const origin = bot.entity.position
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
  const hasShield = bot.inventory.slots.some(item => item?.name === 'shield')
  const armor = equippedArmorCount()
  const ranged = options.some(entity => RANGED_HOSTILES.has(hostileName(entity)))
  const direction = target.position.minus(origin)
  const flanked = threats.some(entity => {
    const other = entity.position.minus(origin)
    return direction.x * other.x + direction.z * other.z < -1 && distance(entity) < 6
  })
  const minHealth = Math.max(6, 6 + (options.length - 1) * 3 + (ranged ? (hasShield ? 1 : 4) : 0) +
    (flanked ? 2 : 0) - (armor >= 3 ? 2 : 0) - (hasShield && !flanked ? 1 : 0))
  if (mustAvoidMelee(target) || bot.health <= minHealth) {
    const pursuit = retreatPursuits.get(bot)
    if (pursuit && Date.now() - pursuit.started >= 12000 && Date.now() - pursuit.updated <= 16000 &&
        pursuit.goals >= 2 && hasShield && !ranged && !flanked && bot.health >= 7 && !mustAvoidMelee(target)) {
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

function equippedArmorCount() {
  return bot.inventory.slots.slice(5, 9)
    .filter(item => /_(helmet|chestplate|leggings|boots)$/.test(item?.name || '')).length
}

function hasDiamondArmor(connection) {
  return ARMOR_SLOTS.every(([slot, type]) => {
    const name = connection.inventory.slots[connection.getEquipmentDestSlot(slot)]?.name ?? ''
    return name === `diamond_${type}` || name === `netherite_${type}`
  })
}

function needsPostArmorDiamonds(connection) {
  const milestone = supplyBase.qualification()
  return connection.game?.dimension === 'overworld' && !milestone.unlocked &&
    !milestone.needsResupply && hasDiamondArmor(connection)
}

function hasDiamondMiningTool(connection) {
  return connection.inventory.items().some(item => /^(iron|diamond|netherite)_pickaxe$/.test(item.name))
}

async function minePostArmorDiamonds() {
  if (mineNeedsNewGround) {
    mineNeedsNewGround = false
    const y = Math.floor(bot.entity.position.y)
    if (y > -48 && await prospectMiningLevel(Math.max(-48, y - 8))) return
    if (canWorkHere(bot) && !closeCombatPlan()) await exploreOneStep()
    return
  }
  await mineForGear(null, 'diamond')
}

async function prospectMiningLevel(y) {
  baseProspecting = true
  try {
    await gotoWithTimeout(new goals.GoalY(y), 'prospect towards mining level', 12000)
    return true
  } catch {
    return false
  } finally {
    baseProspecting = false
  }
}

function hostileName(entity) {
  return String(entity.name || entity.displayName || '').toLowerCase().replaceAll(' ', '_')
}

function mustAvoidMelee(entity) {
  const name = hostileName(entity)
  return name === 'creeper' || VERY_DANGEROUS_HOSTILES.has(name) || bot.health <= 5 ||
    bot.food < 4 || (!hasTool('sword') && !hasTool('axe'))
}

function hostileSight(entity) {
  const eyes = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
  const center = entity.position.offset(0, (entity.height || 1.8) * 0.55, 0)
  const ray = center.minus(eyes)
  const distance = ray.norm()
  const hit = distance > 0 && bot.world.raycast(eyes, ray.unit(), distance)
  return { center, distance, visible: !hit || eyes.distanceTo(hit.intersect) >= distance }
}

async function decideAndAct(trigger = 'scheduled') {
  if (!botEnabled || !bot?.entity || bot.health <= 0 || waterOwnsMovement()) return
  if (bot && impactGuards.has(bot)) return
  if (emergencyRetreating || fleeingActive) {
    if (trigger.startsWith('urgent')) urgentThreatQueued = true
    return
  }
  const immediate = !emergencyShelteredUntil && !shelteredUntilDawn ? closeCombatPlan() : null
  if (immediate) supplyStation.interrupt(log, 'combat')
  else if (foodRecoveryNeeded()) supplyStation.interrupt(log, 'food')
  if (immediate?.action === 'flee' && !busy && !mineBusy && !isEating && !isSmelting && !isDiggingBlock) {
    lastCombatDecision = { action: 'flee', reason: immediate.reason, target: hostileName(immediate.target) }
    await executeFlee(immediate.target, lastCombatDecision)
    return
  }
  if (immediate) {
    activeGoal = null
    mineMode = false
  } else if (!emergencyShelteredUntil && Date.now() < retreatUntil) {
    lastDecision = 'flee'
    if (!busy && !mineBusy && !isEating && bot.health < 12 && safeToEatOnRetreat(bot)) {
      busy = true
      try { await restAfterRetreat(bot) } finally { busy = false }
    }
    return
  }

  if (!immediate && bot.game?.dimension === 'overworld' && supplyBase.qualification().needsResupply &&
      !emergencyShelteredUntil && !shelteredUntilDawn &&
      !deathRecoveryDue()) {
    if (busy || mineBusy || isEating || isSmelting || isDiggingBlock || shelterBusy) return
    mineMode = false
    activeGoal = null
    busy = true
    try { await surfaceResupply() } catch (error) {
      log('surface resupply interrupted', { message: error.message })
    } finally { busy = false }
    return
  }

  if (!immediate && !emergencyShelteredUntil && !shelteredUntilDawn && foodRecoveryNeeded()) {
    if (busy || mineBusy || isEating || isSmelting || isDiggingBlock || shelterBusy || Date.now() < nextFoodSearchAt) return
    const connection = bot
    const resumeMining = mineMode
    busy = true
    try {
      await recoverFoodSupply()
    } catch (error) {
      log('food recovery route interrupted', { message: error.message })
    } finally {
      busy = false
      nextFoodSearchAt = Date.now() + 1800
      if (bot === connection && resumeMining && bot.health > 0 && !emergencyRetreating && !fleeingActive &&
          Date.now() >= retreatUntil && !closeCombatPlan()) mineMode = true
    }
    return
  }

  // Defer non-urgent decisions if actively breaking a block so digging is never cancelled
  if ((isDiggingBlock || bot.targetDigBlock) && !trigger.startsWith('urgent')) {
    log('decision deferred; bot is actively digging block', {
      block: bot.targetDigBlock?.name || currentMineTarget?.name,
      trigger,
    })
    return
  }

  // Defer non-urgent decisions if actively smelting in furnace
  if (isSmelting && !trigger.startsWith('urgent')) {
    log('decision deferred; bot is actively smelting in furnace', { trigger })
    return
  }

  // Defer non-urgent decisions if actively eating
  if (isEating && !trigger.startsWith('urgent')) {
    log('decision deferred; bot is actively eating food', { trigger })
    return
  }

  // Defer non-urgent decisions if in active mineMode with working tools
  if (mineMode && !busy && !mineBusy) finishMineObjective()
  if (!immediate && !supplyBase.active(bot) && !busy && !mineBusy && !isSmelting && !isEating && !isDiggingBlock &&
      !bot?.targetDigBlock && !deathRecoveryDue() && !shelteredUntilDawn && !emergencyShelteredUntil &&
      Date.now() >= nextGearCraftRetryAt && canWorkHere(bot)) {
    if (readyGearUpgrades().length) {
      busy = true
      const resumeMining = mineMode
      mineMode = false
      lastDecision = 'gear-up'
      try {
        if (await craftAvailableGear()) return
      } finally {
        if (resumeMining && bot?.health > 0 && !emergencyRetreating && !fleeingActive && Date.now() >= retreatUntil) mineMode = true
        nextGearCraftRetryAt = Date.now() + 5000
        try { await reclaimTemporaryCraftingTable() } finally { busy = false }
      }
    }
  }
  if (mineMode && !immediate) {
    const hasPickaxe = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
    if (hasPickaxe) {
      log('decision deferred; mineMode active and operating', { trigger })
      return
    }
  }
  if (!busy && !mineBusy && (supplyBase.active(bot) ||
      (needsPostArmorDiamonds(bot) && hasDiamondMiningTool(bot)))) activeGoal = null

  // TASK COMMITMENT PROTECTION:
  // If we have an active ongoing goal, do NOT let scheduled ticks re-query DeepSeek or thrash actions!
  if (activeGoal && (trigger === 'scheduled' || trigger === 'periodic') && !trigger.startsWith('urgent')) {
    const currentSnap = snapshot()
    const isCompleted = activeGoal.isComplete ? activeGoal.isComplete(currentSnap) : false
    const isExpired = Date.now() - activeGoal.startedAt > (activeGoal.timeoutMs || 90000)
    if (!isCompleted && !isExpired) {
      log('maintaining active task commitment; skipping re-decision', {
        goal: activeGoal.type,
        target: activeGoal.targetName,
        elapsedSeconds: Math.round((Date.now() - activeGoal.startedAt) / 1000),
      })
      if (activeGoal.type === 'mine') {
        if (mineNeedsNewGround && !busy) {
          busy = true
          try {
            mineNeedsNewGround = false
            await exploreOneStep()
          } catch (error) {
            log('mine scouting path interrupted', { message: error.message })
          } finally {
            busy = false
          }
        }
        mineMode = true
        return
      }
      if (activeGoal.type === 'collect_wood') {
        if (!busy) {
          busy = true
          try {
            await collectWoodWithPlan()
          } finally { busy = false }
        }
        return
      }
      if (activeGoal.type === 'hunt_food') {
        if (!busy) {
          busy = true
          try {
            await huntNearbyAnimalsOrForage()
          } finally { busy = false }
        }
        return
      }
      if (activeGoal.type === 'gear_up') {
        if (!busy) {
          busy = true
          try {
            await prepareStarterGear()
          } finally { busy = false }
        }
        return
      }
    } else if (isCompleted) {
      log('active task completed successfully', { goal: activeGoal.type })
      activeGoal = null
    } else {
      log('active task expired or stalled; clearing commitment', { goal: activeGoal.type })
      activeGoal = null
    }
  }

  if (busy || mineBusy || !bot || !bot.entity || !movements) {
    if ((busy || mineBusy) && trigger.startsWith('urgent')) urgentThreatQueued = true
    return
  }
  busy = true
  cycle += 1
  try {
    if (!immediate && !emergencyShelteredUntil && !shelteredUntilDawn && await leaveSpawnCanopy()) return
    await eatFoodIfNeeded()
    if (emergencyShelteredUntil) {
      if (Date.now() < emergencyShelteredUntil || findNearestHostile(9)) {
        lastDecision = 'emergency-shelter'
        return
      }
      emergencyShelteredUntil = 0
      await breakShelter()
      if (!bot?.entity || bot.health <= 0) return
    }
    let state = snapshot()
    latestState = state
    log('state', state)

    if (!immediate && deathPoint && !deathPoint.done && !shelteredUntilDawn) {
      if (await recoverDeathDrops()) return
      if (!bot?.entity || bot.health <= 0 || waterOwnsMovement()) return
    }

    const furnaceToRecover = pendingFurnaceBatch || temporaryFurnace
    if (!shelteredUntilDawn && pendingIronWorkshop?.dimension === bot.game.dimension && !furnaceThreat()) {
      lastDecision = 'furnace-recovery'
      isSmelting = true
      try { await recoverIronWorkshop(bot, true) } finally { isSmelting = false }
      if (!closeCombatPlan() && pendingIronWorkshop) return
    }
    if (!shelteredUntilDawn && furnaceToRecover?.dimension === bot.game.dimension && !furnaceThreat()) {
      lastDecision = 'furnace-recovery'
      isSmelting = true
      try {
        await finishFurnaceWork(bot, null, true)
      } finally {
        isSmelting = false
      }
      return
    }

    // First night, or unarmed at night: follow the route (bed, else a 3-deep pit)
    // and wait for daylight. Running about at night unarmed is how it kept dying.
    const duskNow = isNightShelterTime(state.timeOfDay)
    if (!duskNow) shelterAttemptedTonight = false
    const needsShelter = duskNow && !shelteredUntilDawn && !shelterAttemptedTonight &&
      state.nightShelterTerrain === 'open' && (nightsSheltered < 1 || !state.hasSword)
    if (needsShelter && !(state.hasSword && findNearestHostile(8))) {
      supplyStation.interrupt(log, 'night shelter')
      if (supplyStation.pending && supplyStation.protects(bot, bot.entity.position.floored().offset(0, -1, 0))) {
        const { entry } = supplyStation.site
        try {
          await gotoWithTimeout(new goals.GoalBlock(entry.x, entry.y, entry.z), 'leave construction for shelter', 6500)
        } catch {
          return
        }
        if (!bot?.entity || waterOwnsMovement() || closeCombatPlan()) return
      }
      shelterAttemptedTonight = true
      if (await firstNightShelter()) {
        shelteredUntilDawn = true
        lastDecision = 'night-shelter'
        return
      }
      if (!bot?.entity || bot.health <= 0 || waterOwnsMovement()) return
      state = snapshot()
    }
    if (shelteredUntilDawn) {
      if (isNightShelterTime(state.timeOfDay)) {
        lastDecision = 'night-shelter'
        log('sheltering until dawn', { timeOfDay: state.timeOfDay })
        return
      }
      shelteredUntilDawn = false
      await breakShelter()
      if (!bot?.entity || bot.health <= 0 || waterOwnsMovement()) return
      state = snapshot()
    }

    await clearBackpack(bot, 'routine')
    if (!bot?.entity || bot.health <= 0) return
    await autoEquipArmor()
    if (!immediate && !closeCombatPlan() && supplyStation.pending) {
      await buildSupplyStation()
      return
    }
    if (!immediate && !closeCombatPlan() && needsPostArmorDiamonds(bot) && hasDiamondMiningTool(bot)) {
      await minePostArmorDiamonds()
      return
    }
    const stage = computeStage(state)
    state.stage = stage.name
    state.stageHint = stage.hint
    if (stage.name === 'supply_base' && !closeCombatPlan() && canWorkHere(bot)) {
      lastDecision = 'supply-base'
      await supplyBase.run(bot)
      return
    }
    const upgrade = nextIronUpgrade()
    const ironReady = state.rawIron > 0 && state.coal + state.charcoal > 0 &&
      (!upgrade || state.rawIron + inventoryItemCount('iron_ingot') >= upgrade.cost)
    if (!closeCombatPlan() && (ironReady || (trigger === 'mine-complete' && stage.name === 'get_stone' && stage.action === 'gear_up'))) {
      lastDecision = 'gear-up'
      if (await prepareStarterGear()) return
    }
    await maybePlaceTorch()
    let modelDecision = await askDeepSeek({ ...state, previousExperience: lastExperience }, trigger)
    const requestedMineTarget = modelDecision?.action === 'mine' ? modelDecision.target_name || '(未填写)' : null
    if (!bot?.entity || waterOwnsMovement() || emergencyRetreating || fleeingActive ||
        impactGuards.has(bot) || bot.health <= 0) return
    const encounter = closeCombatPlan()
    if (encounter) {
      activeGoal = null
      mineMode = false
      const { action, target, reason, defensive } = encounter
      lastCombatDecision = { action, reason, defensive: Boolean(defensive), target: hostileName(target), modelAction: modelDecision?.action ?? null }
      log('combat policy decision', lastCombatDecision)
      if (action === 'attack') await executeAttack(target, lastCombatDecision)
      else await executeFlee(target, { ...modelDecision, reason })
      return
    }
    if (Date.now() < retreatUntil) return
    if (!shelteredUntilDawn && foodRecoveryNeeded()) return
    lastCombatDecision = null
    // Keep the model on the route: threats are handled before this point, so
    // here it may only pick actions the stage allows, otherwise the script's
    // own action for the stage is used.
    if (modelDecision && stage.allowed && stage.action && !stage.allowed.has(modelDecision.action) &&
        !['attack', 'flee'].includes(modelDecision.action)) {
      log('stage override', { stage: stage.name, modelAction: modelDecision.action, forced: stage.action })
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
    latestState = { ...state, modelDecision }

    if (modelDecision) {
      const requestedAction = modelDecision.action
      const nearestThreat = findNearestHostile(THREAT_RADIUS)
      const selectedThreat = findNearestHostile(THREAT_RADIUS, modelDecision.target_name) || nearestThreat
      const threatDistance = nearestThreat ? nearestThreat.position.distanceTo(bot.entity.position) : Infinity
      const threatName = entityNameOf(nearestThreat)
      const forcedFlee = nearestThreat && ((threatName === 'creeper' && threatDistance < 6) || bot.health < 5 || bot.food < 4)

      if (forcedFlee && requestedAction !== 'flee') {
        mineMode = false
        log('safety override', { modelAction: requestedAction, forcedAction: 'flee', threat: threatName, distance: Number(threatDistance.toFixed(1)) })
        await executeFlee(nearestThreat, modelDecision)
        return
      }

      if (requestedAction !== 'mine') mineMode = false

      if (state.night && !state.hasPickaxe && !nearestThreat && requestedAction === 'explore') {
        log('night gear override', { modelAction: requestedAction, forcedAction: 'gear_up' })
        await prepareStarterGear()
        if (!state.hasPickaxe) await mineForGear(modelDecision.target, modelDecision.target_name)
        return
      }

      if (requestedAction === 'attack') {
        const selectedDistance = selectedThreat ? selectedThreat.position.distanceTo(bot.entity.position) : Infinity
        if (selectedThreat && state.night && selectedDistance > 8) {
          // Do not chase distant mobs at night; keep building gear and fight only what closes in.
          log('night attack override; not chasing distant hostile', { threat: entityNameOf(selectedThreat), distance: Number(selectedDistance.toFixed(1)) })
          persistExperience({ cycle, action: 'attack-skip', experience: '夜间不追击8格外的敌对生物，继续补装备，等它靠近再近战' })
          if (!state.hasPickaxe) { await prepareStarterGear(); if (state.logs < WOOD_TARGET) await collectWoodWithPlan(modelDecision.target) }
          else await mineForGear(modelDecision.target, modelDecision.target_name)
          return
        }
        if (selectedThreat) {
          await executeAttack(selectedThreat, modelDecision)
          return
        }
        log('model requested attack but no live target was available')
      } else if (requestedAction === 'flee') {
        if (nearestThreat && threatDistance <= threatRange(threatName) && mustAvoidMelee(nearestThreat) &&
            hostileSight(nearestThreat).visible) {
          activeGoal = null
          await executeFlee(nearestThreat, modelDecision)
          return
        }
        log('model retreat skipped; no immediate danger')
      } else if (requestedAction === 'hunt_food') {
        lastDecision = 'hunt-food'
        log('decision', { action: lastDecision, reason: modelDecision.reason })
        activeGoal = {
          type: 'hunt_food',
          startedAt: Date.now(),
          isComplete: (s) => (s.food || 0) >= 18 || getEdibleFoods().length >= 4,
          timeoutMs: 60000,
        }
        await huntNearbyAnimalsOrForage()
        return
      } else if (requestedAction === 'collect_wood') {
        const isUnderground = state.underground || state.mining_underground || (bot.entity.position.y < 55)
        if (isUnderground) {
          const hasAnyPick = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
          const canCraftPick = (inventoryCount(STONE_DROPS) >= 3 || inventoryItemCount('iron_ingot') >= 3) &&
            (inventoryItemCount('stick') >= 2 || plankCount() >= 1 || inventoryCount(LOG_NAMES) >= 1)
          if (hasAnyPick || canCraftPick) {
            await prepareStarterGear()
            if (bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))) {
              await mineForGear(null, 'iron')
              return
            }
          }
          log('no pickaxe and no wood underground; navigating to surface for trees', { y: Math.round(bot.entity.position.y) })
          await gotoWithTimeout(new goals.GoalY(68), 'surface for wood', 15000).catch(() => {})
          return
        }
        if (state.logs >= WOOD_TARGET) {
          log('wood reserve reached; redirecting to gear or exploration', { logs: state.logs })
          await collectNearbyDrops(16)
          await prepareStarterGear()
          if (state.night && !state.hasPickaxe) await mineForGear()
          else await exploreOneStep(modelDecision.target)
          return
        }
        activeGoal = {
          type: 'collect_wood',
          startedAt: Date.now(),
          isComplete: (s) => (s.logs + Math.floor(s.planks / 4)) >= WOOD_TARGET,
          timeoutMs: 90000,
        }
        lastDecision = 'collect-wood'
        log('decision', { action: lastDecision, reason: modelDecision.reason })
        await collectWoodWithPlan(modelDecision.target)
        return
      } else if (requestedAction === 'gear_up') {
        lastDecision = 'gear-up'
        log('decision', { action: lastDecision, reason: modelDecision.reason })
        activeGoal = {
          type: 'gear_up',
          startedAt: Date.now(),
          isComplete: (s) => s.hasPickaxe && s.hasSword,
          timeoutMs: 60000,
        }
        await collectNearbyDrops(12)
        const prepared = await prepareStarterGear()
        const hasAnyPickaxe = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
        if (!prepared && hasAnyPickaxe) await mineForGear(modelDecision.target, modelDecision.target_name)
        return
      } else if (requestedAction === 'mine') {
        const hasPickaxe = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
        if (!hasPickaxe) {
          mineMode = false
          lastDecision = 'gear-up'
          log('mine blocked; pickaxe required', { modelReason: modelDecision.reason })
          const prepared = await prepareStarterGear()
          const afterPrepare = bot.inventory.items().some(item => item.name.endsWith('_pickaxe'))
          if (!afterPrepare) {
            persistExperience({ cycle, action: 'gear-up', experience: '模型要求挖矿但没有镐，先阻止挖矿并继续完成工具制作' })
            if (state.logs < WOOD_TARGET) await collectWoodWithPlan(modelDecision.target)
          }
          return
        }
        activeGoal = { type: 'mine', targetName: modelDecision.target_name, startedAt: Date.now(), timeoutMs: 120000 }
        lastDecision = 'mine'
        log('decision', { action: lastDecision, reason: modelDecision.reason })
        await collectNearbyDrops(12)
        if (stage.name !== 'find_coal') await prepareStarterGear()
        if (!pendingIronWorkshop && !pendingFurnaceBatch && !temporaryFurnace) {
          await mineForGear(modelDecision.target, modelDecision.target_name, requestedMineTarget)
          if (!mineMode) activeGoal = null
        }
        return
      } else if (requestedAction === 'build_camp') {
        lastDecision = 'build-camp'
        log('decision', { action: lastDecision, reason: modelDecision.reason })
        supplyStation.requested = true
        await buildSupplyStation()
        return
      } else if (requestedAction === 'inspect_stone') {
        const stone = findNearestBlock(new Set(['stone', 'deepslate']), 24)
        if (!stone) {
          log('model requested stone inspection but no stone was visible')
          await exploreOneStep(modelDecision.target)
          return
        }
        const goal = new goals.GoalNear(stone.position.x, stone.position.y, stone.position.z, 3)
        if (goal.isEnd(bot.entity.position.floored())) {
          lastDecision = 'explore'
          log('stone already within inspection range; exploring', { position: stone.position })
          await exploreOneStep()
          return
        }
        lastDecision = 'inspect-stone'
        log('decision', { action: lastDecision, block: stone.name, reason: modelDecision.reason })
        await gotoWithTimeout(goal, 'stone target', 7000)
        return
      } else if (requestedAction === 'explore') {
        if (stage.name === 'gather_wood') {
          lastDecision = 'collect-wood'
          await collectWoodWithPlan(modelDecision.target)
          return
        }
        if (!nearestThreat && await advanceSurvivalGear()) return
        lastDecision = 'explore'
        log('decision', { action: lastDecision, target: modelDecision.target, reason: modelDecision.reason })
        await exploreOneStep(modelDecision.target)
        return
      }
    }

    // Deterministic fallback is used only when the model is unavailable or
    // returns an unusable action.
    if (await handleScriptFallbackThreat()) return
    mineMode = false
    if ((state.logs >= 3 || state.planks >= 5 || state.hasPickaxe) && await advanceSurvivalGear()) return
    if (state.logs < WOOD_TARGET && !(state.hasPickaxe && state.hasSword)) {
      lastDecision = 'collect-wood'
      log('decision', { action: lastDecision, fallback: true })
      await collectWoodWithPlan()
      return
    }
    lastDecision = 'explore'
    log('decision', { action: lastDecision, fallback: true })
    await exploreOneStep()
  } catch (error) {
    log('action failed', { decision: lastDecision, message: error.message })
    persistExperience({ cycle, action: lastDecision, experience: `本轮行动失败：${error.message}` })
    stopPathfinder()
  } finally {
    busy = false
    if (urgentThreatQueued) {
      urgentThreatQueued = false
      setImmediate(() => void decideAndAct('urgent-queued'))
    }
  }
}

function nearbyThreatSignature() {
  const threats = Object.values(bot.entities || {})
    .filter(entity => entity !== bot.entity && entity.position)
    .map(entity => {
      const name = entityNameOf(entity)
      return { entity, name, distance: entity.position.distanceTo(bot.entity.position) }
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
  if (!botEnabled || !bot || !bot.entity || impactGuards.has(bot) ||
      emergencyShelteredUntil || shelteredUntilDawn || shelterBusy) return
  const current = nearbyThreatSignature()
  if (!current.signature) {
    lastThreatSignature = ''
    lastCloseThreatSignature = ''
    return
  }
  const closest = current.threats[0]
  if (closest && (closest.distance <= 4 || (lastDecision === 'flee' && closest.distance <= 14)) &&
      !emergencyRetreating && !fleeingActive && !waterOwnsMovement()) {
    const entity = bot.entities[closest.id]
    const plan = closeCombatPlan()
    if (entity && (plan?.action === 'flee' ||
        (!plan && lastDecision === 'flee' && retreatPursuits.get(bot)?.ids.has(entity.id)))) {
      const target = plan?.target ?? entity
      emergencyRetreating = true
      lastCombatDecision = { action: 'flee', reason: plan?.reason ?? '追兵仍在附近，继续脱离', target: hostileName(target) }
      log('emergency spacing guard', { target: closest.name, distance: closest.distance })
      void executeFlee(target, lastCombatDecision)
        .catch(error => log('emergency retreat interrupted', { message: error.message }))
        .finally(() => {
          emergencyRetreating = false
          void decideAndAct('urgent-post-emergency')
        })
    }
  }
  const now = Date.now()
  const closeSignature = current.threats.filter(({id, distance, name}) =>
    distance <= threatRange(name) &&
      bot.entities[id] && hostileSight(bot.entities[id]).visible).map(({id}) => id).join('|')
  if ((current.signature !== lastThreatSignature || closeSignature !== lastCloseThreatSignature) &&
      now - lastThreatDispatchAt >= 1000) {
    lastThreatSignature = current.signature
    lastCloseThreatSignature = closeSignature
    lastThreatDispatchAt = now
    log('urgent threat detected', { radius: THREAT_RADIUS, threats: current.threats })
    const response = closeSignature && closeCombatPlan()
    if (response && !waterOwnsMovement() && !emergencyRetreating && !fleeingActive && lastDecision !== 'hunt-hostile') {
      if (bot.pathfinder.goal) stopPathfinder()
      if (bot.targetDigBlock) bot.stopDigging()
      void decideAndAct('urgent-threat')
    }
  }
}

// minecraft-data 26.1 tags ores with material "incorrect_for_<tier>_tool" instead
// of "mineable/pickaxe", so prismarine-block finds no tool multiplier and
// mineflayer waits the bare-hand time (4.55s for iron with a stone pickaxe)
// before sending "finish digging". The server finishes the block in ~1.15s and
// then sits waiting for that packet, which shows as a stall at full progress.
// Recompute the delay for those blocks using the pickaxe multiplier table.
function installDigTimeFix(connection) {
  const original = connection.digTime.bind(connection)
  log('dig timing fix installed')
  connection.digTime = block => {
    if (!block || !String(block.material || '').startsWith('incorrect_for_')) return original(block)
    return blockDigTimeWith(connection, block, connection.heldItem)
  }
}

function createBotConnection() {
  if (bot) return bot
  const connection = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION })
  bot = connection
  const pile = new Set()
  const repicked = new Set()
  discardPiles.set(connection, pile)
  repickedDiscards.set(connection, repicked)
  connection.on('entityGone', entity => pile.delete(entity))
  connection.on('playerCollect', (collector, entity) => {
    if (collector?.id !== connection.entity?.id || !discardedEntities.has(entity)) return
    const item = droppedStack(entity)
    if (item) repicked.add(item.name)
  })
  connection.loadPlugin(pathfinder)
  connection.loadPlugin(collectBlock)
  connection.loadPlugin(toolPlugin)
  connection.loadPlugin(pvp)

  connection.once('spawn', () => {
    if (bot !== connection) return
    trackCombatImpacts(connection)
    // digTime is defined by mineflayer's digging plugin, so it only exists here.
    if (typeof connection.digTime === 'function') installDigTimeFix(connection)
    else log('digTime not available; dig timing fix not installed')
    const dig = connection.dig.bind(connection)
    connection.dig = async (block, ...args) => {
      const watchingMine = connection === bot && mineBusy && currentMineTarget && block
      if (!watchingMine) return dig(block, ...args)
      const targetHit = block.name === currentMineTarget.name && block.position.equals(currentMineTarget)
      if (!targetHit && isOreName(block.name)) {
        recordMineAudit('unexpected-ore', block)
        throw new Error('Mining order excludes ' + block.name)
      }
      await dig(block, ...args)
      if (connection.blockAt(block.position)?.type !== block.type) {
        recordMineAudit(targetHit ? 'target-mined' : 'path-clearance', block)
      }
    }
    mcData = minecraftData(connection.version)
    movements = new Movements(connection, mcData)
    movements.canDig = true
    movements.exclusionAreasBreak.push(block =>
      supplyStation.protects(connection, block?.position) || !(mineBusy || surfaceRouteActive || baseProspecting) ? 100 : 0)
    movements.allow1by1towers = true
    movements.allowParkour = true
    movements.placeCost = 2.5
    // liquidCost of 40 was not enough to deter the pathfinder from entering
    // water. 500 effectively forbids a water step unless there is no dry path.
    movements.liquidCost = 500
    // Never bridge over open water: placing on the surface made the bot build
    // onto the sea, fall in, get pulled ashore by the swim controller, repeat.
    movements.exclusionAreasPlace.push(block => (isWaterAdjacent(block?.position) ? 500 : 0))
    // Walking INTO a water block also costs a lot; the shore-walking swim step
    // itself was free before.
    movements.exclusionAreasStep.push(block => (block && WATER_BLOCK_NAMES.has(block.name) ? 500 : 0))
    movements.exclusionAreasStep.push(block => discardTileCost(connection, block))
    movements.blocksCantBreak.add(mcData.blocksByName[TABLE_NAME].id)
    movements.exclusionAreasBreak.push(block => supplyBase.owns(connection, block?.position) ? Infinity : 0)
    for (const block of mcData.blocksArray) {
      if (LOG_NAMES.has(block.name) || isOreName(block.name)) movements.blocksCantBreak.add(block.id)
    }
    // Let the pathfinder choose safe solid inventory blocks when a route
    // needs a one-block tower or a bridge. Falling sand/gravel and fluids are
    // intentionally excluded.
    movements.scafoldingBlocks = [
      'dirt', 'cobblestone', 'stone', 'deepslate',
      'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
      'acacia_planks', 'dark_oak_planks', 'mangrove_planks',
      'cherry_planks', 'pale_oak_planks',
    ].map(name => mcData.itemsByName[name]?.id).filter(Number.isInteger)
    connection.pathfinder.setMovements(movements)
    if (process.env.MC_VIEWER !== '0') {
      mineflayerViewer(connection, { port: VIEWER_PORT, firstPerson: false })
      log('viewer started', { url: `http://127.0.0.1:${VIEWER_PORT}` })
    }
    startDashboard()
    log('spawned', { version: connection.version, position: connection.entity.position })
    void decideAndAct('spawn')
    if (!loopsStarted) {
      loopsStarted = true
      setInterval(() => void decideAndAct('scheduled'), NORMAL_DECISION_INTERVAL_MS)
      setInterval(() => {
        if (supplyStation.pending && !busy && !mineMode && !mineBusy && !waterOwnsMovement() &&
            !shelteredUntilDawn && !emergencyShelteredUntil && !isEating && !isSmelting && !isDiggingBlock &&
            !foodRecoveryNeeded()) void decideAndAct('station')
      }, 1600)
      // MineProcess-style local replanning. This is deliberately independent
      // from the slower DeepSeek loop and only searches when the previous
      // plan is idle, invalid, or has just finished mining.
      setInterval(() => void minePlannerTick('periodic'), 750)
      setInterval(monitorThreats, 500)
      setInterval(() => monitorFood(), 500)
      setInterval(() => void monitorSwimming(), 250)
      setInterval(() => void escapeIfStranded().catch(error => log('stranded escape failed', { message: error.message })), 2000)
      setInterval(emitNavigationParticles, 500)
    }
  })

  // Inventory-clear packets can arrive just before the death health update.
  let recentRecoveryLoot = null
  let nextLootSampleAt = 0
  connection.on('physicsTick', () => {
    const now = Date.now()
    if (connection.health <= 0 || now < nextLootSampleAt) return
    nextLootSampleAt = now + 100
    const loot = carriedStackCounts(connection, true)
    if (loot.size) recentRecoveryLoot = { loot, at: now }
  })
  connection.on('health', () => {
    if (connection.health < 8) log('health critical', { health: connection.health, food: connection.food })
    monitorFood(connection)
  })

  connection.on('death', () => {
    emergencyShelteredUntil = 0
    shelteredUntilDawn = false
    shelterInfo = null
    activeGoal = null
    mineMode = false
    committedMineTarget = null
    recoveringFood = false
    miningPausedForFood = false
    swimmingMode = false
    swimShore = swimProgress = swimFailedShore = null
    supplyStation.interrupt(log, 'death')
    const where = connection.entity?.position.floored()
    const loot = carriedStackCounts(connection, true)
    if (recentRecoveryLoot && Date.now() - recentRecoveryLoot.at < 1000) {
      for (const [name, count] of recentRecoveryLoot.loot) loot.set(name, Math.max(count, loot.get(name) ?? 0))
    }
    recentRecoveryLoot = null
    if (deathPoint && !deathPoint.done) {
      if (recoveringDeathDrops || (where && deathPoint.dimension === connection.game?.dimension &&
          where.distanceTo(new Vec3(deathPoint.x, deathPoint.y, deathPoint.z)) <= 12)) {
        finishDeathRecovery(deathPoint, 'died-during-recovery')
      } else {
        deferDeathRecovery(deathPoint, 'died-before-recovery')
      }
    } else if (where) {
      if (loot.size) {
        deathPoint = {
          x: where.x, y: where.y, z: where.z, loot,
          dimension: connection.game?.dimension ?? 'overworld',
          diedAt: Date.now(), attempts: 0, done: false, nextAttemptAt: Date.now() + 1800,
        }
        log('death point recorded', { position: where, dimension: deathPoint.dimension, loot: [...loot] })
      } else {
        log('death recovery skipped', { reason: 'low-value-loot', position: where })
      }
    }
    log('agent died; waiting for respawn')
    connection.pvp.stop()
    setTimeout(() => {
      if (!botEnabled || bot !== connection) return
      try {
        connection.respawn()
        log('respawn requested')
      } catch (error) {
        log('respawn failed', { message: error.message })
      }
    }, 1200)
  })

  connection.on('startedAttacking', () => log('started attacking', { target: entityNameOf(connection.pvp.target) }))
  connection.on('attackedTarget', () => log('attack landed', { target: entityNameOf(connection.pvp.target) }))
  connection.on('stoppedAttacking', () => log('stopped attacking'))
  connection.on('goal_reached', () => clearNavigation('goal-reached'))
  connection.on('path_stop', () => clearNavigation('path-stopped'))
  connection.on('path_update', result => {
    if (!result?.path || result.path.length === 0) {
      if (result?.status === 'success' || result?.status === 'noPath') clearNavigation(`path-${result.status}`)
      return
    }
    const toPlace = result.path.flatMap(point => Array.isArray(point.toPlace) ? point.toPlace : [])
    navigationState = {
      ...navigationState,
      waypoints: result.path.map(point => ({ x: point.x, y: point.y, z: point.z })),
    }
    if (toPlace.length > 0) {
      const scaffoldCount = inventoryCount(new Set(['dirt', 'cobblestone', 'stone', 'sand', 'gravel']))
      log('path plan requires scaffolding', { placements: toPlace.length, scaffoldBlocksAvailable: scaffoldCount, positions: toPlace.slice(0, 6) })
      persistExperience({ cycle, action: 'path-scaffold', experience: `寻路发现 ${toPlace.length} 个高度差，使用库存方块自动垫路；库存不足时放弃该分支` })
    }
    log('real path updated', { nodes: result.path.length, cost: result.cost ?? null, placements: toPlace.length })
  })
  connection.on('kicked', reason => log('kicked', { reason }))
  connection.on('error', error => log('connection error', { message: error.message }))
  connection.on('end', reason => {
    supplyStation.interrupt(log, 'disconnect')
    log('connection ended', { reason })
    if (bot === connection) {
      swimmingMode = false
      swimShore = swimProgress = swimFailedShore = null
      bot = null
    }
  })
  return connection
}

startDashboard()
if (botEnabled) createBotConnection()

