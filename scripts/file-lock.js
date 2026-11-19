const { spawnSync } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const root = fs.realpathSync.native(path.join(__dirname, '..'))
const lockRef = 'refs/heads/codex-file-locks'
const collabRef = 'refs/heads/collab'
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const ownerId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_OPTIONAL_LOCKS: '0' }

function git(args, { allowed = [0], input, network = false, env = gitEnv } = {}) {
  const flags = args[0] === 'check-ignore' ? [] : ['--literal-pathspecs']
  const result = spawnSync('git', ['--no-replace-objects', ...flags, ...args], {
    cwd: root, env, input, encoding: 'utf8', windowsHide: true,
    maxBuffer: 8 * 1024 * 1024, timeout: network ? 45000 : 15000
  })
  if (result.error || !allowed.includes(result.status)) {
    // The underlying error can contain an authenticated remote URL.
    throw new Error(`Git ${args[0]} 失败（${result.error?.code || result.status}）。请检查 Git、网络和本机凭据。`)
  }
  return { code: result.status, text: result.stdout }
}

function verifyTarget(allowLocalRemote) {
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) {
    if (process.env[name]) throw new Error(`请在未设置 ${name} 的终端运行。`)
  }
  const top = fs.realpathSync.native(git(['rev-parse', '--show-toplevel']).text.trim())
  if (top !== root || git(['symbolic-ref', '--quiet', 'HEAD'], { allowed: [0, 1] }).text.trim() !== collabRef) {
    throw new Error('请使用当前项目检出了 collab 的工作树。')
  }
  const fetchUrl = git(['remote', 'get-url', '--all', 'origin']).text.trim()
  const pushUrl = git(['remote', 'get-url', '--push', '--all', 'origin']).text.trim()
  const github = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[\w.-]+\/[\w.-]+$/i
  const local = allowLocalRemote && path.isAbsolute(fetchUrl) && !fetchUrl.startsWith('\\\\') && fs.statSync(fetchUrl, { throwIfNoEntry: false })?.isDirectory()
  if (fetchUrl !== pushUrl || !(allowLocalRemote ? local : github.test(fetchUrl))) {
    throw new Error('origin 必须是单一且推拉一致的 GitHub 地址。测试模式只接受本地目录作为远程。')
  }
  return git(['rev-parse', '--absolute-git-dir']).text.trim()
}

function getOwner(gitDir) {
  const file = path.join(gitDir, 'codex-file-lock-owner')
  if (!fs.existsSync(file)) {
    const id = randomUUID()
    const temp = `${file}.${id}`
    fs.writeFileSync(temp, `${id}\n`, { flag: 'wx' })
    try {
      // Publish a complete identifier atomically, including during concurrent first use.
      fs.linkSync(temp, file)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    } finally {
      fs.unlinkSync(temp)
    }
  }
  const owner = fs.readFileSync(file, 'utf8').trim()
  if (!ownerId.test(owner)) throw new Error('本地工作树的文件锁身份损坏，请保留现场。')
  return owner
}

function normalizeFile(value) {
  const file = value.replaceAll('\\', '/').replace(/^\.\//, '')
  const parts = file.split('/')
  for (const part of parts) {
    if (!part || /[\x00-\x1f\x7f<>:"|?*]|[. ]$/.test(part) || /^\.git$/i.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) {
      throw new Error(`需要可移植的仓库相对文件路径：${value}`)
    }
  }
  return { file, key: file.normalize('NFC').toLowerCase() }
}

function canonicalWorktreeFile(file) {
  const parts = file.split('/')
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = fs.lstatSync(current, { throwIfNoEntry: false })
    if (!info) return path.relative(root, path.join(current, ...parts.slice(index + 1))).split(path.sep).join('/')
    if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new Error(`请指定普通文件或待新建的文件：${file}`)
    }
    current = fs.realpathSync.native(current)
  }
  return path.relative(root, current).split(path.sep).join('/')
}

function remoteTip(ref) {
  const result = git(['ls-remote', '--exit-code', '--refs', 'origin', ref], { allowed: [0, 2], network: true })
  if (result.code === 2) return null
  const [oid, name] = result.text.trim().split('\t')
  if (name !== ref || !objectId.test(oid)) throw new Error(`无法确认远程引用 ${ref}。`)
  const object = `${oid}^{commit}`
  if (git(['cat-file', '-e', object], { allowed: [0, 1, 128] }).code !== 0) {
    git(['fetch', '--no-write-fetch-head', '--refmap=', '--no-tags', '--no-recurse-submodules', 'origin', ref], { network: true })
    if (git(['cat-file', '-e', object], { allowed: [0, 1, 128] }).code !== 0) {
      throw new Error('远程在读取时更新，请重新运行。')
    }
  }
  return oid
}

function collabTip() {
  const remote = remoteTip(collabRef)
  if (!remote) throw new Error('远程 collab 尚未建立，请先发布协作分支。')
  return remote
}

function readLocks() {
  const tip = remoteTip(lockRef)
  if (!tip) return { tip, locks: new Map() }
  const state = JSON.parse(git(['show', '-s', '--format=%B', tip]).text)
  if (state.version !== 1 || !Array.isArray(state.locks)) throw new Error('远程文件锁记录格式无效。')
  const locks = new Map()
  for (const entry of state.locks) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.owner !== 'string' || !ownerId.test(entry.owner) ||
        typeof entry.id !== 'string' || !ownerId.test(entry.id)) {
      throw new Error('远程文件锁记录格式无效。')
    }
    const { key } = normalizeFile(entry.file)
    if (locks.has(key)) throw new Error('远程文件锁包含重复路径。')
    locks.set(key, { file: entry.file, owner: entry.owner, id: entry.id })
  }
  return { tip, locks }
}

function advanceLocks(tip, locks) {
  const tree = git(['mktree'], { input: '' }).text.trim()
  const parent = tip ? ['-p', tip] : []
  const message = JSON.stringify({ version: 1, locks: Array.from(locks.values()) })
  const metadataEnv = { ...gitEnv, GIT_AUTHOR_NAME: 'Codex file locks', GIT_COMMITTER_NAME: 'Codex file locks',
    GIT_AUTHOR_EMAIL: 'codex-file-locks@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'codex-file-locks@users.noreply.github.com' }
  const commit = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, ...parent, '-F', '-'], { input: message, env: metadataEnv }).text.trim()
  const push = git(['-c', 'remote.origin.mirror=false', 'push', '--porcelain', '--no-force', '--no-follow-tags',
    '--recurse-submodules=no', 'origin', `${commit}:${lockRef}`], { allowed: [0, 1, 128], network: true })
  if (push.code === 0) return true
  if (remoteTip(lockRef) !== tip) return false
  throw new Error('远程文件锁更新失败，请检查网络、凭据或该分支的写权限。')
}

function assertClean(files) {
  for (const file of files) canonicalWorktreeFile(file)
  const entries = git(['ls-files', '-v', '-z', '--', ...files]).text.split('\0')
  if (entries.some(entry => /^[Sa-z] /.test(entry))) {
    throw new Error('目标文件的 Git 索引标记隐藏了本地改动，请先检查索引状态。')
  }
  if (git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', ...files]).text.length) {
    throw new Error('目标文件有未提交、未跟踪或已忽略的本地修改，请保留现场。')
  }
}

function assertTrackable(files) {
  for (const file of files) {
    if (git(['check-ignore', '--no-index', '-q', '--', file], { allowed: [0, 1] }).code === 0) {
      throw new Error(`路径被 Git 忽略，无法用于协作：${file}`)
    }
  }
}

function assertSameFiles(local, remote, files) {
  if (git(['diff', '--quiet', '--no-ext-diff', local, remote, '--', ...files], { allowed: [0, 1] }).code !== 0) {
    throw new Error('目标文件的本地提交与远程 collab 不一致。请先同步。')
  }
}

function isAncestor(first, second) {
  return git(['merge-base', '--is-ancestor', first, second], { allowed: [0, 1] }).code === 0
}

function acquire(paths, owner) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const { tip, locks } = readLocks()
    const busy = paths.find(({ key }) => locks.has(key) && locks.get(key).owner !== owner)
    if (busy) throw new Error(`文件已被另一工作树锁定：${busy.file}`)
    const missing = paths.filter(({ key }) => !locks.has(key))
    const local = git(['rev-parse', 'HEAD']).text.trim()
    const remote = collabTip()
    if (!isAncestor(remote, local)) throw new Error('本地尚未包含最新的远程 collab，等待自动同步后重试。')
    if (missing.length) {
      const files = missing.map(({ file }) => file)
      assertTrackable(files)
      assertClean(files)
      assertSameFiles(local, remote, files)
      for (const { file, key } of missing) locks.set(key, { file, owner, id: randomUUID() })
      if (!advanceLocks(tip, locks)) continue
    }
    // Another owner may have published work before we won the lock. Read again now.
    if (!isAncestor(collabTip(), git(['rev-parse', 'HEAD']).text.trim())) {
      throw new Error('已持锁，但远程 collab 在抢锁时更新。等工作树同步后重新执行 acquire，再开始编辑。')
    }
    for (const { file } of paths) console.log(`已持锁，可以编辑 ${file}`)
    return
  }
  throw new Error('锁记录正在频繁更新，请重试。')
}

function release(paths, owner) {
  let originalLocks
  for (let attempt = 0; attempt < 5; attempt++) {
    const { tip, locks } = readLocks()
    const held = paths.filter(({ key }) => locks.has(key))
    const busy = held.find(({ key }) => locks.get(key).owner !== owner)
    if (busy) throw new Error(`当前工作树无法解锁他人的文件：${busy.file}`)
    if (!originalLocks) originalLocks = new Map(held.map(({ key }) => [key, locks.get(key).id]))
    if (held.some(({ key }) => originalLocks.get(key) !== locks.get(key).id)) {
      throw new Error('文件锁已重新申请，请核对当前工作树的操作。')
    }
    if (!held.length) {
      console.log('这些文件当前均未被锁定。')
      return
    }
    const files = held.map(({ key }) => locks.get(key).file)
    const local = git(['rev-parse', 'HEAD']).text.trim()
    const remote = collabTip()
    if (!isAncestor(local, remote)) throw new Error('GitHub collab 尚未包含当前本地提交。锁仍保留，推送成功后再试。')
    assertSameFiles(local, remote, files)
    assertClean(files)
    if (git(['rev-parse', 'HEAD']).text.trim() !== local) throw new Error('本地提交已更新，请重新确认推送。')
    for (const { key } of held) locks.delete(key)
    if (!advanceLocks(tip, locks)) continue
    for (const file of files) console.log(`已确认远程 collab，已解锁 ${file}`)
    return
  }
  throw new Error('锁记录正在频繁更新，请重试。')
}

function main() {
  const [action, ...args] = process.argv.slice(2)
  const allowLocal = args[0] === '--local-test'
  if (allowLocal) args.shift()
  if (args[0] === '--') args.shift()
  if (!['acquire', 'release', 'status'].includes(action) || (action !== 'status' && !args.length)) {
    throw new Error('用法：node scripts/file-lock.js <acquire|release|status> -- <仓库相对文件路径...>')
  }
  const gitDir = verifyTarget(allowLocal)
  if (action !== 'status' && ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer'].some(name => fs.existsSync(path.join(gitDir, name)))) {
    throw new Error('工作树存在进行中的 Git 操作。完成后再申请或释放文件锁。')
  }
  const owner = getOwner(gitDir)
  const files = args.map(file => normalizeFile(file).file)
  const targets = action === 'acquire' ? files.map(canonicalWorktreeFile) : files
  const paths = Array.from(new Map(targets.map(normalizeFile).map(entry => [entry.key, entry])).values())
  if (action === 'acquire') return acquire(paths, owner)
  if (action === 'release') return release(paths, owner)
  const { locks } = readLocks()
  for (const { key, file } of paths.length ? paths : Array.from(locks.values(), ({ file }) => normalizeFile(file))) {
    const state = locks.get(key)
    console.log(`${file}  ${!state ? '空闲' : state.owner === owner ? '当前工作树持有' : '其他工作树持有'}`)
  }
  if (!paths.length && !locks.size) console.log('当前没有文件锁。')
}

try {
  main()
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
