const { once } = require('node:events')
const { setTimeout: wait } = require('node:timers/promises')
const { Vec3 } = require('vec3')
const { readLitematic } = require('../litematic')
const { runCreativeBuild } = require('../agent/creative-build')

const AUTH = 'offline'
const USAGE = '用法：npm run build:creative -- [--replace-existing] <蓝图.litematic> <原点X> <原点Y> <原点Z>，或 npm run build:creative -- --inspect <蓝图.litematic>'

async function main(args) {
  if (args[0] === '--help') { console.log(USAGE); return }
  const replaceExisting = args[0] === '--replace-existing'
  if (replaceExisting) args = args.slice(1)
  const inspect = args[0] === '--inspect'
  if ((inspect && replaceExisting) || args.length !== (inspect ? 2 : 4)) throw new Error(USAGE)
  const filename = inspect ? args[1] : args[0]
  const blueprint = readLitematic(filename)
  const { cells, ...metadata } = blueprint
  console.log(JSON.stringify({ ...metadata, blocks: cells.length }))
  if (inspect) return

  const coordinates = args.slice(1).map(value => /^-?\d+$/.test(value) ? Number(value) : NaN)
  if (coordinates.some((value, axis) => !Number.isSafeInteger(value) ||
      value + blueprint.minimum[axis] < (axis === 1 ? -64 : -29999984) ||
      value + blueprint.maximum[axis] > (axis === 1 ? 319 : 29999984))) throw new Error('施工范围超出 Java 版主世界坐标')
  const origin = new Vec3(...coordinates)
  const port = Number(process.env.MC_PORT || 25567)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MC_PORT 必须是 1–65535 的端口')
  const name = process.env.MC_USERNAME || 'NMO-Builder'
  if (!/^[\w-]{1,16}$/.test(name)) throw new Error('MC_USERNAME 必须是有效的 Minecraft 玩家名')
  const bot = require('mineflayer').createBot({
    host: process.env.MC_HOST || '127.0.0.1', port, username: name, version: process.env.MC_VERSION || '26.1', auth: AUTH,
  })
  const controller = new AbortController()
  const { signal } = controller
  let ended = false
  const stop = () => controller.abort(new Error('已请求停止施工'))
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  bot.on('error', error => controller.abort(error))
  bot.once('kicked', reason => controller.abort(new Error(`测试服断开 Bot ${String(reason)}`)))
  bot.once('end', () => { ended = true; controller.abort(new Error('Bot 已断开服务器')) })

  try {
    await once(bot, 'spawn', { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
    if (bot.game.dimension !== 'overworld') throw new Error('请在主世界施工')
    if (bot.game.gameMode !== 'creative') console.log(`等待管理员设置创造模式 /gamemode creative ${name}`)
    for (let attempt = 0; bot.game.gameMode !== 'creative' && attempt < 40; attempt++) await wait(500, undefined, { signal })
    console.log(`施工 Bot ${name}，原点 ${origin}`)
    const result = await runCreativeBuild(bot, blueprint, origin, {
      replaceExisting, signal,
      onProgress: progress => console.log('BUILD_PROGRESS', JSON.stringify(progress)),
    })
    const { unresolved, ...summary } = result
    console.log('BUILD_FINISHED', JSON.stringify(summary))
    for (const cell of unresolved.slice(0, 20)) console.log('BUILD_UNRESOLVED', JSON.stringify(cell))
    if (unresolved.length) process.exitCode = 2
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    if (!ended) bot.quit()
  }
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.cause?.message || error.message)
  process.exitCode = 1
})
