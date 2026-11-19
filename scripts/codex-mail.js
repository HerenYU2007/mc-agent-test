const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { createHash, randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const { git, verifyTarget } = require('./file-lock.js')

const API = 'https://api.github.com'
const INTERVAL = 30000
const MARKER = 'nmo-codex-mail:v1'
const ROOT = fs.realpathSync.native(path.join(__dirname, '..'))
const USERNAME = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i
const REPOSITORY = /^[a-z\d-]+\/[a-z\d_.-]+$/i
const validId = value => Number.isSafeInteger(value) && value > 0
const normalized = name => name.toLowerCase()

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx' })
    fs.renameSync(temp, file)
  } finally {
    try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function credential(repo) {
  const options = { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 12000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } }
  const result = spawnSync('git', ['credential', 'fill'], { ...options,
    input: `protocol=https\nhost=github.com\npath=${repo}.git\n\n` })
  if (result.status === 0) {
    const line = (result.stdout || '').split(/\r?\n/).find(line => line.startsWith('password='))
    if (line?.length > 9) return line.slice(9)
  }
  const gh = spawnSync('gh', ['auth', 'token', '--hostname', 'github.com'], options)
  if (gh.status === 0 && gh.stdout.trim()) return gh.stdout.trim()
  throw new Error('找不到 GitHub 凭据。请用 Git Credential Manager 登录，或完成 gh auth login 与 gh auth setup-git。')
}

function createGitHubClient({ repo, getCredential = credential, fetcher = fetch }) {
  if (!REPOSITORY.test(repo)) throw new Error('协作邮箱的 GitHub 仓库无效。')
  let token
  return async function request(route, { method = 'GET', body } = {}) {
    const url = new URL(route, API)
    if (url.origin !== API) throw new Error('协作邮箱只连接 GitHub API。')
    token ||= getCredential(repo)
    let response
    try {
      response = await fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: {
          Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json', 'User-Agent': 'NMO Codex Mail', 'X-GitHub-Api-Version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      throw new Error('连接 GitHub API 失败或超时。')
    }
    if (!response.ok) {
      if (response.status === 401) token = undefined
      throw new Error(`GitHub API 返回 ${response.status}。`)
    }
    return { data: await response.json(), next: /rel="next"/.test(response.headers.get('link') || '') }
  }
}

function validateConfig(config) {
  if (!config || !REPOSITORY.test(config.repo) || !validId(config.issue) ||
      !Array.isArray(config.accounts) || config.accounts.length !== 2 ||
      !config.accounts.every(name => typeof name === 'string' && USERNAME.test(name)) ||
      normalized(config.accounts[0]) === normalized(config.accounts[1])) throw new Error('协作邮箱配置无效。')
  return config
}

function formatMessage(to, topic, body, replyTo) {
  topic = topic.trim()
  body = body.trim()
  if (!topic || topic.length > 100 || /[\r\n\x00-\x1f]/.test(topic) || !body || body.length > 8000) {
    throw new Error('请提供 1–100 字的单行主题和 1–8000 字的消息。')
  }
  const metadata = Buffer.from(JSON.stringify({ to, topic, replyTo })).toString('base64url')
  const heading = topic.replace(/[\\*_[\]<>]/g, '\\$&')
  return `<!-- ${MARKER} ${metadata} -->\n**给 ${to} · ${heading}**${replyTo ? `（回复 #${replyTo}）` : ''}\n\n${body}`
}

function parseMessage(comment, config, me) {
  if (!comment || typeof comment !== 'object') return null
  const sender = comment.user?.login
  if (!validId(comment.id) || typeof sender !== 'string' || !config.accounts.some(name => normalized(name) === normalized(sender)) ||
      normalized(sender) === normalized(me) || typeof comment.body !== 'string' || comment.body.length > 10000) return null
  const match = comment.body.match(/^<!-- nmo-codex-mail:v1 ([a-z\d_-]+) -->\r?\n[^\r\n]*\r?\n\r?\n([\s\S]+)$/i)
  if (!match) return null
  let meta
  try { meta = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')) } catch { return null }
  if (!meta || typeof meta.to !== 'string' || normalized(meta.to) !== normalized(me) || typeof meta.topic !== 'string' ||
      !meta.topic.trim() || meta.topic.length > 100 || /[\x00-\x1f]/.test(meta.topic) ||
      (meta.replyTo !== null && !validId(meta.replyTo)) || !match[2].trim() || match[2].length > 8000) return null
  return { id: comment.id, sender, topic: meta.topic, body: match[2].trim(), replyTo: meta.replyTo,
    url: `https://github.com/${config.repo}/issues/${config.issue}#issuecomment-${comment.id}` }
}

function createMailbox({ config, me, directory, request }) {
  validateConfig(config)
  if (typeof me !== 'string' || !config.accounts.some(name => normalized(name) === normalized(me))) {
    throw new Error('当前登录的 GitHub 账号不属于这组协作者。')
  }
  const peer = config.accounts.find(name => normalized(name) !== normalized(me))
  const inboxDir = path.join(directory, 'inbox')
  const readDir = path.join(directory, 'read')
  const cursorFile = path.join(directory, 'poll.json')
  const base = `/repos/${config.repo}/issues/${config.issue}/comments`
  const itemFile = id => path.join(inboxDir, `${id}.json`)
  const receiptFile = id => path.join(readDir, `${id}.json`)

  async function poll() {
    const previous = readJson(cursorFile, {})
    const since = Number.isFinite(previous.cursor) ? new Date(previous.cursor - 2000).toISOString() : null
    let cursor = previous.cursor
    let added = 0
    let next = true
    for (let page = 1; next; page++) {
      const params = new URLSearchParams({ per_page: '100', page: String(page) })
      if (since) params.set('since', since)
      const result = await request(`${base}?${params}`)
      if (!Array.isArray(result.data)) throw new Error('GitHub 返回了无效的评论列表。')
      for (const comment of result.data) {
        const timestamp = Date.parse(comment?.updated_at)
        if (Number.isFinite(timestamp)) cursor = Math.max(cursor ?? timestamp, timestamp)
        const message = parseMessage(comment, config, me)
        if (!message || fs.existsSync(itemFile(message.id))) continue
        writeJson(itemFile(message.id), message)
        added++
      }
      next = result.next
    }
    const latest = readJson(cursorFile, {})
    if (Number.isFinite(latest.cursor)) cursor = Math.max(cursor ?? latest.cursor, latest.cursor)
    const state = { checkedAt: new Date().toISOString(), cursor }
    writeJson(cursorFile, state)
    return { ...state, added }
  }

  function unread() {
    if (!fs.existsSync(inboxDir)) return []
    return fs.readdirSync(inboxDir).filter(name => /^\d+\.json$/.test(name)).map(name => Number.parseInt(name, 10))
      .filter(id => validId(id) && !fs.existsSync(receiptFile(id))).sort((a, b) => a - b)
      .map(id => readJson(itemFile(id), null)).filter(Boolean)
  }

  function ack(ids) {
    for (const id of ids) {
      if (!validId(id) || !fs.existsSync(itemFile(id))) throw new Error(`收件箱中找不到消息 ${id}。`)
    }
    for (const id of ids) writeJson(receiptFile(id), { readAt: new Date().toISOString() })
  }

  async function send(topic, body, replyTo = null) {
    if (replyTo !== null) {
      if (!validId(replyTo)) throw new Error('回复需要原消息 ID。')
      const original = readJson(itemFile(replyTo), null)
      if (!original) throw new Error('收件箱中找不到原消息，请先运行 inbox。')
      topic = original.topic
    }
    const message = formatMessage(peer, topic, body, replyTo)
    const { data } = await request(base, { method: 'POST', body: { body: message } })
    if (!validId(data?.id)) throw new Error('GitHub 未确认消息 ID，请先检查 Issue 再重试。')
    const sent = { id: data.id, to: peer, url: `https://github.com/${config.repo}/issues/${config.issue}#issuecomment-${data.id}` }
    if (replyTo !== null) {
      try { ack([replyTo]) } catch { sent.readReceiptPending = replyTo }
    }
    return sent
  }

  return { poll, unread, ack, send, status: () => readJson(cursorFile, {}) }
}

function bindWatcher(directory) {
  const port = 12000 + createHash('sha256').update(directory).digest().readUInt16BE(0) % 8000
  const server = net.createServer(socket => socket.destroy())
  return new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error('此工作树已有收件器或本机回环端口已占用。') : error))
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server))
  })
}

async function watch(mailbox, directory, me) {
  const server = await bindWatcher(directory)
  const id = randomUUID()
  const worker = path.join(directory, 'watch.json')
  const stopFile = path.join(directory, `${id}.stop.json`)
  let stopped = false
  const stop = () => { stopped = true }
  const shouldStop = () => stopped || fs.existsSync(stopFile)
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    writeJson(worker, { id, pid: process.pid, account: me })
    console.log(`收件器已启动 ${me}，每 30 秒查询 GitHub。`)
    let first = true
    while (!shouldStop()) {
      const next = performance.now() + INTERVAL
      try {
        const result = await mailbox.poll()
        if (first || result.added) console.log(`${result.checkedAt} 收件成功，新增 ${result.added} 条。`)
        first = false
      } catch (error) {
        console.error(`${new Date().toISOString()} 收件失败 ${error.message}`)
      }
      while (!shouldStop() && performance.now() < next) await delay(Math.min(500, next - performance.now()))
    }
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
    try {
      for (const file of [worker, stopFile]) {
        try { fs.unlinkSync(file) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
    } finally { server.close() }
  }
}

async function main(argv) {
  const [command = 'help', ...args] = argv
  const usage = '用法：node scripts/codex-mail.js <watch|stop|inbox|send "主题" "消息"|reply ID "消息"|read ID...|status>'
  if (command === 'help' || command === '--help') { console.log(usage); return }
  if (!['watch', 'stop', 'inbox', 'send', 'reply', 'read', 'status'].includes(command)) throw new Error(usage)
  if (['watch', 'stop', 'inbox', 'status'].includes(command) && args.length ||
      ['send', 'reply'].includes(command) && args.length !== 2 || command === 'read' && !args.length) throw new Error(usage)
  const config = validateConfig(require('./codex-mail-config.json'))
  const gitDir = fs.realpathSync.native(verifyTarget(false))
  const remote = git(['remote', 'get-url', 'origin']).text.trim().replace(/\.git$/i, '').split(/github\.com[/:]/i).at(-1)
  if (normalized(remote) !== normalized(config.repo)) throw new Error('当前 origin 与协作邮箱的仓库不一致。')
  const directory = path.join(gitDir, 'codex-mail', String(config.issue))
  if (command === 'stop') {
    const run = readJson(path.join(directory, 'watch.json'), null)
    if (run && /^[a-f0-9-]{36}$/.test(run.id)) {
      writeJson(path.join(directory, `${run.id}.stop.json`), {})
      console.log('已请求停止收件器。')
    } else console.log('没有可停止的收件器。')
    return
  }
  const request = createGitHubClient({ repo: config.repo })
  const { data } = await request('/user')
  const me = data?.login
  if (typeof me !== 'string' || !config.accounts.some(name => normalized(name) === normalized(me))) throw new Error('请登录协作账号。')
  const mailbox = createMailbox({ config, me, directory: path.join(directory, normalized(me)), request })
  if (command === 'watch') return watch(mailbox, directory, me)
  if (command === 'status') {
    const worker = readJson(path.join(directory, 'watch.json'), null)
    console.log(JSON.stringify({ account: me, issue: config.issue, watcherPid: worker?.pid ?? null,
      checkedAt: mailbox.status().checkedAt ?? null, unread: mailbox.unread().length }, null, 2))
  } else if (command === 'inbox') {
    await mailbox.poll()
    const unread = mailbox.unread()
    if (!unread.length) console.log('没有未读消息。')
    else {
      console.log(`未读 ${unread.length} 条，显示前 ${Math.min(20, unread.length)} 条。`)
      for (const message of unread.slice(0, 20)) console.log(JSON.stringify(message))
    }
  } else if (command === 'read') {
    mailbox.ack(args.map(Number))
    console.log('已标记为已读。')
  } else {
    const message = command === 'send' ? await mailbox.send(args[0], args[1]) : await mailbox.send('', args[1], Number(args[0]))
    console.log(JSON.stringify(message))
  }
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message)
  process.exitCode = 1
})

module.exports = { createGitHubClient, createMailbox, formatMessage, parseMessage, INTERVAL }
