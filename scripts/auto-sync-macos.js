const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { setTimeout: wait } = require('node:timers/promises')
const { git, verifyTarget, remoteTip, isAncestor, assertHeldPaths } = require('./file-lock.js')

const root = fs.realpathSync.native(path.join(__dirname, '..'))
const ref = 'refs/heads/collab'
const records = text => text.split('\0').filter(Boolean)
const clean = args => git(args).text.trim()
const head = () => clean(['rev-parse', 'HEAD'])
const operationMarkers = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START', 'index.lock']
const ignoredSamples = ['.env', 'config/.env.local', 'secrets.json', 'keys/id_ed25519', 'certs/private.pem', 'node_modules/module/index.js', '.cache/info', 'observer-mod/build/example.jar', 'dist/bundle.js', '.DS_Store', 'agent/._combat.js']
const credential = /(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{24,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[a-z0-9]{16}|-----BEGIN (?:[a-z0-9 ]+ )?PRIVATE KEY-----|https?:\/\/[^/\s:@]+:[^/\s@]+@)/i

function checkIgnoreRules() {
  for (const name of ignoredSamples) {
    if (git(['check-ignore', '--no-index', '-q', '--', name], { allowed: [0, 1] }).code !== 0) {
      throw new Error(`.gitignore 需要覆盖 ${name}。`)
    }
  }
}

function blockedPath(name) {
  if (/(?:^|\/)(?:node_modules|\.cache|\.gradle|\.pytest_cache|\.mypy_cache|__pycache__|build|dist|out|logs)(?:\/|$)/i.test(name)) return true
  const leaf = path.posix.basename(name)
  if (leaf.toLowerCase() === '.env.example') return false
  return /^(?:\.env(?:$|\.)|\.ds_store$|\._|id_(?:rsa|ed25519|ecdsa|dsa)(?:$|\.)|(?:credentials|secrets)\.json$)/i.test(leaf) ||
    /\.(?:pem|key|ppk|pfx|p12|token|log|jsonl|jar|class|zip|pyc)$/i.test(leaf)
}

function fingerprint(file) {
  const absolute = path.resolve(root, file)
  if (!absolute.startsWith(root + path.sep)) throw new Error('Git 路径超出工作树。')
  const item = fs.lstatSync(absolute, { throwIfNoEntry: false })
  if (!item) return null
  if (!item.isFile() || !fs.realpathSync.native(absolute).startsWith(root + path.sep)) {
    throw new Error(`暂缓自动提交非普通文件 ${file}。`)
  }
  const handle = fs.openSync(absolute, 'r')
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(65536)
  const readStat = () => {
    const { dev, ino, size, mtimeNs, ctimeNs } = fs.fstatSync(handle, { bigint: true })
    return [dev, ino, size, mtimeNs, ctimeNs].join('/')
  }
  try {
    const before = readStat()
    let count
    while ((count = fs.readSync(handle, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
    if (before !== readStat()) throw new Error(`文件仍在写入，稍后重试 ${file}。`)
    return [before, hash.digest('hex')]
  } finally {
    fs.closeSync(handle)
  }
}

function snapshot() {
  const status = git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--ignore-submodules=none']).text
  const files = [...new Set(records(status).map(record => record.slice(3)))].sort()
  const work = JSON.stringify(files.map(file => [file, fingerprint(file)]))
  const index = git(['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-renames', 'HEAD', '--']).text
  return { status, files, work, index, head: head() }
}

function equalSnapshot(a, b) {
  return b && a.head === b.head && a.status === b.status && a.work === b.work && a.index === b.index
}

function changed(from, to) {
  return records(git(['diff', '--name-only', '--no-renames', '-z', from, to, '--']).text)
}

function createAudit() {
  const blobs = new Set()
  function assertTree(revisions) {
    const tree = revisions.at(-1)
    const names = records(git(['diff-tree', '--no-commit-id', '--no-renames', '-r', '-z', '--name-only',
      '--diff-filter=ACMRT', ...revisions, '--']).text)
    for (const name of names) {
      if (blockedPath(name)) throw new Error(`敏感文件或生成产物阻止同步 ${name}。`)
      const match = git(['ls-tree', '-z', tree, '--', name]).text.match(/^\d+ blob ([a-f0-9]+)\t/)
      if (!match) throw new Error(`无法核实普通 Git 文件 ${name}。`)
      const blob = match[1]
      if (blobs.has(blob)) continue
      if (credential.test(git(['cat-file', 'blob', blob]).text)) throw new Error(`发现疑似凭据，已阻止同步 ${name}。`)
      if (blobs.size >= 4096) blobs.clear()
      blobs.add(blob)
    }
  }
  function history(tip, other) {
    const revisions = clean(['rev-list', '--reverse', tip, '--not', other])
    for (const commit of revisions ? revisions.split(/\r?\n/) : []) {
      if (credential.test(git(['show', '-s', '--format=%B', commit]).text)) throw new Error('待同步的提交消息含疑似凭据。')
      const parents = clean(['rev-list', '-n', '1', '--parents', commit]).split(' ').slice(1)
      for (const parent of parents.length ? parents : ['--root']) assertTree([parent, commit])
    }
  }
  return { assertTree, history }
}

function mutexPort(gitDir) {
  return 20000 + createHash('sha256').update(gitDir).digest().readUInt16BE(0) % 28000
}

function startMutex(gitDir, id) {
  const port = mutexPort(gitDir)
  const server = net.createServer(socket => {
    socket.on('error', () => socket.destroy())
    socket.end(id)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.removeListener('error', reject)
      resolve(server)
    })
  })
}

async function assertWorkerRunning(gitDir, stateDir) {
  const runtime = path.join(stateDir, 'run.json')
  if (!fs.existsSync(runtime)) throw new Error('此工作树未启动同步。请先运行 node scripts/auto-sync-macos.js start。')
  const { id } = JSON.parse(fs.readFileSync(runtime, 'utf8'))
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无法确认同步进程标识。')
  const stopFile = path.join(stateDir, id + '.stop')
  if (fs.existsSync(stopFile)) throw new Error('同步进程正在停止。请等停止后重新启动。')
  const running = await new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: mutexPort(gitDir) })
    let reply = ''
    socket.setEncoding('utf8')
    socket.setTimeout(3000, () => socket.destroy())
    socket.on('data', chunk => {
      reply += chunk
      if (reply.length > id.length) socket.destroy()
    })
    socket.once('end', () => resolve(reply === id))
    socket.once('error', () => resolve(false))
    socket.once('close', () => resolve(false))
  })
  if (!running || fs.existsSync(stopFile)) {
    throw new Error('无法验证此工作树的同步进程。若刚更新同步脚本，请运行 restart；否则检查日志后重试。')
  }
}

function gitOperation(gitDir) {
  return operationMarkers.find(name => fs.existsSync(path.join(gitDir, name))) ||
    (git(['ls-files', '--unmerged', '-z']).text.length ? '未解决的冲突' : '')
}

function stopRequest(stateDir) {
  const current = path.join(stateDir, 'run.json')
  if (!fs.existsSync(current)) return false
  const { id } = JSON.parse(fs.readFileSync(current, 'utf8'))
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('无法确认同步进程标识。')
  fs.writeFileSync(path.join(stateDir, id + '.stop'), '')
  return true
}

function createSync(gitDir, allowLocal, stable, stopped, log) {
  const origin = clean(['remote', 'get-url', 'origin'])
  const audit = createAudit()
  const operation = () => gitOperation(gitDir)
  let previous
  let ownedStage

  function assertTarget() {
    const actual = fs.realpathSync.native(verifyTarget(allowLocal))
    if (actual !== gitDir || clean(['remote', 'get-url', 'origin']) !== origin) {
      throw new Error('工作树或远程地址已变化，已暂停同步。')
    }
  }

  function commitStable(current) {
    if (!equalSnapshot(current, previous)) {
      previous = { ...current, since: performance.now() }
      log('发现本地修改，等待文件内容和暂存状态稳定。')
      return null
    }
    if (performance.now() - previous.since < stable) return null
    checkIgnoreRules()
    assertHeldPaths(current.files, gitDir)
    assertTarget()
    if (stopped() || operation() || !equalSnapshot(current, snapshot())) {
      previous = null
      return null
    }

    let expectedIndex = current.index
    if (!current.index || (ownedStage?.head === current.head && ownedStage.index === current.index)) {
      git(['add', '-A', '--', ...current.files])
      expectedIndex = git(['diff', '--cached', '--raw', '--no-abbrev', '-z', '--no-renames', 'HEAD', '--']).text
      ownedStage = { head: current.head, index: expectedIndex }
    } else {
      ownedStage = null
    }
    const staged = snapshot()
    if (!staged.index || staged.head !== current.head || staged.work !== current.work ||
        staged.index !== expectedIndex) {
      previous = null
      log('暂存期间检测到变化，保留现场并重新等待稳定。')
      return null
    }
    const tree = clean(['write-tree'])
    audit.assertTree([current.head, tree])
    assertHeldPaths(changed(current.head, tree), gitDir)
    assertTarget()
    if (stopped() || operation() || !equalSnapshot(staged, snapshot())) {
      previous = null
      return null
    }
    git(['commit', '-m', `同步协作修改 ${new Date().toISOString()}`])
    previous = null
    ownedStage = null
    log('已提交稳定的本地修改。')
    return snapshot()
  }

  return function round() {
    assertTarget()
    const pending = operation()
    if (pending) {
      log(`等待完成现有 Git 操作 ${pending}。`)
      return
    }
    const tip = remoteTip(ref)
    if (!tip) throw new Error('远程 collab 尚未建立。')
    if (stopped()) return
    let current = snapshot()
    if (current.status) {
      current = commitStable(current)
      if (!current || current.status) return
    }
    previous = null
    if (stopped() || operation() || tip === current.head) return

    if (!isAncestor(tip, current.head)) {
      audit.history(tip, current.head)
      assertTarget()
      if (stopped() || operation() || !equalSnapshot(current, snapshot())) return
      const options = ['--no-autostash', '--no-overwrite-ignore']
      if (isAncestor(current.head, tip)) {
        git(['merge', '--ff-only', ...options, tip])
        log('已快进到远程 collab。')
        return
      }
      const merge = git(['merge', '--no-ff', '--no-commit', ...options, tip], { allowed: [0, 1, 128] })
      if (merge.code !== 0) {
        log('合并暂停。Git 已保留双方提交，请查看 git status。')
        return
      }
      const mergeHead = path.join(gitDir, 'MERGE_HEAD')
      const tree = clean(['write-tree'])
      audit.assertTree([current.head, tree])
      assertTarget()
      const unstaged = git(['diff', '--quiet', '--'], { allowed: [0, 1] }).code !== 0
      const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).text.length !== 0
      if (!fs.existsSync(mergeHead) || fs.readFileSync(mergeHead, 'utf8').trim() !== tip ||
          head() !== current.head || unstaged || untracked || clean(['write-tree']) !== tree) {
        log('合并期间工作树发生变化，保留 Git 合并现场。')
        return
      }
      git(['commit', '--no-edit'])
      log('已安全合并双方提交。')
      current = snapshot()
    }

    if (current.status || operation() || stopped()) return
    audit.history(current.head, tip)
    assertHeldPaths(changed(tip, current.head), gitDir)
    assertTarget()
    if (stopped() || operation() || !equalSnapshot(current, snapshot())) return
    const push = git(['-c', 'remote.origin.mirror=false', 'push', '--porcelain', '--no-force',
      '--no-follow-tags', '--recurse-submodules=no', 'origin', `${current.head}:${ref}`], { allowed: [0, 1, 128], network: true })
    log(push.code === 0 ? `已推送 collab ${current.head.slice(0, 8)}。` : '推送未完成，保留本地提交并在下轮重试。')
  }
}

function parseArgs() {
  const [action = 'start', ...args] = process.argv.slice(2)
  const allowLocal = args[0] === '--local-test'
  if (allowLocal) args.shift()
  const interval = args.length ? Number(args[0]) : 30
  const stable = args.length > 1 ? Number(args[1]) : 30
  if (!['check', 'status', 'start', 'stop', 'restart'].includes(action) || args.length > 2 || (!allowLocal && args.length) ||
      ![interval, stable].every(seconds => Number.isInteger(seconds) && seconds > 0 && seconds <= 3600)) {
    throw new Error('用法：node scripts/auto-sync-macos.js <check|status|start|stop|restart>')
  }
  return { action, allowLocal, interval: interval * 1000, stable: stable * 1000 }
}

async function main() {
  const { action, allowLocal, interval, stable } = parseArgs()
  const gitDir = fs.realpathSync.native(verifyTarget(allowLocal))
  const stateDir = path.join(gitDir, 'codex-auto-sync-macos')
  const logfile = path.join(stateDir, 'sync.log')
  if (action === 'stop') {
    console.log(stopRequest(stateDir) ? '已请求停止同步。' : '没有可停止的同步进程。')
    return
  }
  checkIgnoreRules()
  git(['var', 'GIT_AUTHOR_IDENT'])
  if (action === 'check') {
    console.log(`工作树 ${root}\n分支 collab，远程配置和忽略规则通过。\n日志 ${logfile}`)
    return
  }
  if (action === 'status') {
    const operation = gitOperation(gitDir)
    if (operation) throw new Error(`现有 Git 操作阻塞同步 ${operation}，请处理后重查。`)
    await assertWorkerRunning(gitDir, stateDir)
    git(['ls-remote', '--exit-code', '--refs', 'origin', ref], { network: true })
    await assertWorkerRunning(gitDir, stateDir)
    console.log(`同步运行正常，远程 collab 可达。工作树 ${root}`)
    return
  }

  let server
  const id = randomUUID()
  const deadline = Date.now() + 120000
  const restarting = action === 'restart' && stopRequest(stateDir)
  while (!server) {
    try {
      server = await startMutex(gitDir, id)
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      if (!restarting || Date.now() >= deadline) {
        throw new Error('此工作树已在同步，或用于防重复启动的本机回环端口已占用。')
      }
      await wait(300)
    }
  }

  const runtime = path.join(stateDir, 'run.json')
  const signalFile = path.join(stateDir, id + '.stop')
  let interrupted = false
  const onSignal = () => { interrupted = true }
  const stopped = () => interrupted || fs.existsSync(signalFile)
  function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`
    console.log(line)
    if ((fs.statSync(logfile, { throwIfNoEntry: false })?.size || 0) >= 2 * 1024 * 1024) {
      const rotated = path.join(stateDir, 'sync.previous.log')
      if (fs.existsSync(rotated)) fs.unlinkSync(rotated)
      fs.renameSync(logfile, rotated)
    }
    fs.appendFileSync(logfile, line + '\n')
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    const unpublished = path.join(stateDir, id + '.json')
    fs.writeFileSync(unpublished, JSON.stringify({ id }))
    fs.renameSync(unpublished, runtime)
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    const round = createSync(gitDir, allowLocal, stable, stopped, log)
    log(`启动 collab 同步，每 ${interval / 1000} 秒检查，稳定等待至少 ${stable / 1000} 秒。`)
    while (!stopped()) {
      const next = performance.now() + interval
      try {
        round()
      } catch (error) {
        log(error.message)
      }
      await wait(0)
      while (!stopped() && performance.now() < next) await wait(Math.min(300, next - performance.now()))
    }
    log('同步进程已安全停止。')
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    try {
      for (const file of [runtime, signalFile]) {
        if (fs.existsSync(file)) fs.unlinkSync(file)
      }
    } finally {
      server.close()
    }
  }
}

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
