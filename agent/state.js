const { SupplyStation } = require('../supply-station')
const { DEEPSEEK_API_KEY, DEFAULT_MINE_TARGET_NAMES } = require('./config')

function createState() {
  return {
    // 连接与任务调度
    bot: null,
    mcData: undefined,
    movements: undefined,
    botEnabled: process.env.MC_BOT_AUTOSTART !== '0',
    busy: false,
    cycle: 0,
    lastDecision: 'boot',
    activeGoal: null,
    urgentThreatQueued: false,

    // 模型、日志和面板
    modelEnabled: Boolean(DEEPSEEK_API_KEY) && process.env.DEEPSEEK_AUTO_START === '1',
    latestState: null,
    eventLog: [],
    modelUsage: { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    lastModelDecision: null,
    lastExperience: '',
    modelCalls: [],

    // 背包、装备和工作台
    discardedEntities: new WeakSet(),
    discardPiles: new WeakMap(),
    repickedDiscards: new WeakMap(),
    nextGearCraftRetryAt: 0,

    // 导航与水域
    navigationState: { target: null, waypoints: [], label: '' },
    swimmingMode: false,
    swimShore: null,
    swimProgress: null,
    swimFailedShore: null,
    landedAt: 0,

    // 采矿与挖掘
    mineNeedsNewGround: false,
    currentMineTarget: null,
    mineMode: false,
    mineBusy: false,
    isDiggingBlock: false,
    mineTargetNames: new Set(DEFAULT_MINE_TARGET_NAMES),
    currentMineOrder: null,
    baseProspecting: false,
    lastMineAudit: null,
    committedMineTarget: null,
    mineBlacklist: new Map(),
    lastMineSearchAt: 0,

    // 战斗与撤离
    emergencyRetreating: false,
    fleeingActive: false,
    retreatUntil: 0,
    lastCombatDecision: null,
    meleeConnection: null,
    raisedShields: new WeakMap(),
    impactGuards: new WeakSet(),

    // 食物与熔炼
    recoveringFood: false,
    nextFoodSearchAt: 0,
    miningPausedForFood: false,
    surfaceRouteActive: false,
    lastDrySurface: null,
    isEating: false,
    isSmelting: false,
    temporaryFurnace: null,
    pendingFurnaceBatch: null,
    pendingIronWorkshop: null,

    // 避难与掉落
    deathPoint: null,
    shelterBusy: false,
    shelteredUntilDawn: false,
    emergencyShelteredUntil: 0,
    shelterInfo: null,
    nightsSheltered: 0,
    shelterAttemptedTonight: false,

    // 建筑与基地
    supplyStation: new SupplyStation(process.env.MC_SUPPLY_STATION_STATE,
      process.env.MC_BUILD_SUPPLY_STATION === '1', process.env.MC_BUILD_NBT, process.env.MC_BUILD_STARTER_HUT === '1'),
    supplyBase: undefined,
  }
}

module.exports = createState
