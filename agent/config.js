const path = require('node:path')
const { Vec3 } = require('vec3')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const VERSION = process.env.MC_VERSION || '26.3'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 25565)
const USERNAME = process.env.MC_USERNAME || 'NMO-TestAgent'
const VIEWER_PORT = Number(process.env.MC_VIEWER_PORT || 3000)
const DASHBOARD_PORT = Number(process.env.MC_DASHBOARD_PORT || 3001)
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || ''
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-flash'
const DEEPSEEK_URL = process.env.DEEPSEEK_URL || 'https://api.deepseek.com/chat/completions'
const EXPERIENCE_LOG_PATH = process.env.EXPERIENCE_LOG_PATH || path.join(PROJECT_ROOT, 'experience.jsonl')
const RUNTIME_LOG_PATH = process.env.RUNTIME_LOG_PATH || path.join(PROJECT_ROOT, 'runtime-events.jsonl')
const THREAT_RADIUS = 24
const STONE_DROPS = new Set(['cobblestone', 'cobbled_deepslate'])
const STONE_TARGETS = new Set(['stone', 'deepslate'])
const COAL_TARGETS = new Set(['coal_ore', 'deepslate_coal_ore'])
const RUBBLE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'andesite', 'diorite',
  'granite', 'tuff', 'gravel', 'netherrack', 'smooth_basalt', 'calcite', 'blackstone', 'cobbled_blackstone'])
const SOIL = new Set(['dirt', 'coarse_dirt', 'rooted_dirt', 'sand', 'red_sand'])
const ARMOR_SLOTS = [['head', 'helmet'], ['torso', 'chestplate'], ['legs', 'leggings'], ['feet', 'boots']]
const ARMOR_DEFENSE = {
  leather: [1, 3, 2, 1], golden: [2, 5, 3, 1], chainmail: [2, 5, 4, 1], copper: [2, 4, 3, 1],
  iron: [2, 6, 5, 2], diamond: [3, 8, 6, 3], netherite: [3, 8, 6, 3], turtle: [2, 0, 0, 0],
}
const FOOD_RECOVERY_START = 10
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
const LOG_NAMES = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log',
  'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'pale_oak_log',
])
const WATER_BLOCK_NAMES = new Set(['water', 'bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'])
// Early-game route (see early-game-flow.md): the script decides the stage from
// the inventory and the clock; the model may only pick actions the stage allows.
const WOOD_TARGET = 12
// hand-chop 10-15 logs before crafting anything
const STONE_TARGET = 10
const TABLE_NAME = 'crafting_table'
const TABLE_NAMES = new Set([TABLE_NAME])
const FURNACE_NAME = 'furnace'
const TABLE_TOP = new Vec3(0, 1, 0)
const EMPTY_BLOCK = /^(air|cave_air|void_air)$/
const IRON_INPUT_NAMES = new Set(['raw_iron', 'iron_ore', 'deepslate_iron_ore'])
const IRON_FUEL_NAMES = new Set(['coal', 'charcoal'])
// Baritone-style ore scan: ores are searched over a wider radius than plain
// stone, remembered between ticks, and ranked ahead of stone.
const ORE_SCAN_RADIUS = 72
const BLOCK_MINE_RADIUS = 36
const TUNNEL_SAFE_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'coarse_dirt', 'podzol', 'cobblestone', 'andesite', 'diorite',
  'granite', 'deepslate', 'tuff', 'sandstone', 'netherrack', 'moss_block', 'rooted_dirt',
  'coal_ore', 'deepslate_coal_ore', 'iron_ore', 'deepslate_iron_ore', 'copper_ore', 'deepslate_copper_ore',
  'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'oak_log', 'birch_log', 'spruce_log'
])
const RANGED_HOSTILES = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch'])

module.exports = {
  PROJECT_ROOT,
  VERSION,
  HOST,
  PORT,
  USERNAME,
  VIEWER_PORT,
  DASHBOARD_PORT,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  DEEPSEEK_URL,
  EXPERIENCE_LOG_PATH,
  RUNTIME_LOG_PATH,
  THREAT_RADIUS,
  STONE_DROPS,
  STONE_TARGETS,
  COAL_TARGETS,
  RUBBLE,
  SOIL,
  ARMOR_SLOTS,
  ARMOR_DEFENSE,
  FOOD_RECOVERY_START,
  DEFAULT_MINE_TARGET_NAMES,
  LOG_NAMES,
  WATER_BLOCK_NAMES,
  WOOD_TARGET,
  STONE_TARGET,
  TABLE_NAME,
  TABLE_NAMES,
  FURNACE_NAME,
  TABLE_TOP,
  EMPTY_BLOCK,
  IRON_INPUT_NAMES,
  IRON_FUEL_NAMES,
  ORE_SCAN_RADIUS,
  BLOCK_MINE_RADIUS,
  TUNNEL_SAFE_BLOCKS,
  RANGED_HOSTILES,
}
