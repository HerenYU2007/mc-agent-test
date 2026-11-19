const assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: wait } = require('node:timers/promises')

const temp = fs.realpathSync.native(os.tmpdir())
const prefix = 'mac-auto-sync-test-'
const fixture = fs.mkdtempSync(path.join(temp, prefix))
const source = path.join(__dirname, '..')
const remote = path.join(fixture, 'origin.git')
const win = path.join(fixture, 'PC Windows')
const mac = path.join(fixture, 'Mac worktree')
const clone = path.join(fixture, 'Mac repository')
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
  GIT_CONFIG_GLOBAL: path.join(fixture, 'gitconfig'), GIT_TERMINAL_PROMPT: '0' }
const node = process.execPath
const sync = 'scripts/auto-sync-macos.js'
const locks = 'scripts/file-lock.js'
const ps = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './auto-sync.ps1']
const workers = new Set()
fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')

function run(cwd, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 25000 })
  assert.ifError(result.error)
  assert.equal(result.status, expected, result.stdout + result.stderr)
  return result.stdout.trim()
}

const git = (cwd, ...args) => run(cwd, 'git', args)
const lock = (cwd, action, ...names) => run(cwd, node, [locks, action, '--local-test', '--', ...names])
const tip = () => git(remote, 'rev-parse', 'refs/heads/collab')
const head = cwd => git(cwd, 'rev-parse', 'HEAD')
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)
const stateDir = cwd => path.join(git(cwd, 'rev-parse', '--absolute-git-dir'), 'codex-auto-sync-macos')
const macLog = cwd => fs.readFileSync(path.join(stateDir(cwd), 'sync.log'), 'utf8')

async function until(condition, label, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await wait(180)
  }
  throw new Error(`等待超时 ${label}`)
}

function worker(cwd, action = 'start') {
  const windows = cwd === win
  const args = windows ? [...ps, '-AllowLocalRemote', '-IntervalSeconds', '1', '-StableSeconds', '2'] :
    [sync, action, '--local-test', '1', '2']
  const child = spawn(windows ? 'powershell.exe' : node, args, { cwd, env, windowsHide: true, stdio: 'pipe' })
  child.stdout.resume()
  child.stderr.resume()
  const entry = { cwd, child, done: new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => resolve(code))
  }) }
  workers.add(entry)
  return entry
}

async function stop(entry) {
  if (entry.cwd === win) run(win, 'powershell.exe', [...ps, '-Action', 'Stop'])
  else run(entry.cwd, node, [sync, 'stop', '--local-test'])
  assert.equal(await entry.done, 0)
  workers.delete(entry)
}

function commit(cwd, file, value) {
  write(cwd, file, value)
  git(cwd, 'add', '--', file)
  git(cwd, 'commit', '-m', `Fixture update ${file}`)
  return head(cwd)
}

async function test() {
  fs.mkdirSync(remote)
  fs.mkdirSync(win)
  git(remote, 'init', '--bare', '--initial-branch=collab')
  git(win, 'init', '--initial-branch=collab')
  git(win, 'config', 'user.name', 'Windows fixture')
  git(win, 'config', 'user.email', 'win@example.test')
  git(win, 'remote', 'add', 'origin', remote)
  fs.mkdirSync(path.join(win, 'scripts'))
  for (const file of [sync, locks, '.gitignore', 'auto-sync.ps1']) fs.copyFileSync(path.join(source, file), path.join(win, file))
  write(win, 'conflict.txt', 'base\n')
  git(win, 'add', '.')
  git(win, 'commit', '-m', 'Fixture only')
  git(win, 'push', 'origin', 'collab')
  git(fixture, 'clone', '--branch', 'collab', remote, clone)
  git(clone, 'config', 'user.name', 'Mac fixture')
  git(clone, 'config', 'user.email', 'mac@example.test')
  git(clone, 'switch', '-c', 'fixture-spare')
  git(clone, 'worktree', 'add', mac, 'collab')
  assert.match(run(clone, node, [sync, 'check', '--local-test'], 1), /^$/)
  assert.match(run(mac, node, [sync, 'check', '--local-test']), /分支 collab/)
  let macWorker = worker(mac)
  await until(() => fs.existsSync(path.join(stateDir(mac), 'run.json')), 'Mac 同步器启动')
  run(mac, node, [sync, 'start', '--local-test', '1', '2'], 1)
  const initial = tip()
  write(mac, 'no-lock.txt', 'Unowned local edit\n')
  await until(() => macLog(mac).includes('取得文件锁：no-lock.txt'), '无锁保护')
  assert.equal(tip(), initial)
  assert.equal(head(mac), initial)
  assert.equal(git(mac, 'diff', '--cached', '--name-only'), '')
  fs.unlinkSync(path.join(mac, 'no-lock.txt'))
  const macFile = 'Mac 共享.txt'
  lock(mac, 'acquire', macFile)
  for (let i = 0; i < 16; i++) {
    write(mac, macFile, `ongoing ${i}\n`)
    await wait(160)
    assert.equal(head(mac), initial, '正在写入的文件过早提交')
  }
  write(mac, '.DS_Store', 'synthetic Finder file')
  write(mac, '._Mac.txt', 'synthetic AppleDouble file')
  write(mac, '.env', 'fixture only')
  await until(() => tip() !== initial && head(mac) === tip(), '稳定文件自动提交与推送')
  assert.equal(git(remote, 'show', `collab:${macFile}`), 'ongoing 15')
  assert.equal(git(remote, 'ls-tree', '--name-only', 'collab', '--', '.env', '.DS_Store', '._Mac.txt'), '')
  lock(mac, 'release', macFile)
  console.log('通过：拒绝无锁改动、等待写入稳定、忽略敏感文件和 macOS 产物。')

  if (process.platform === 'win32') {
    const winWorker = worker(win)
    await until(() => head(win) === tip(), 'Windows 收到 Mac 提交')
    lock(win, 'acquire', 'win.txt')
    write(win, 'win.txt', 'Windows edit\n')
    await until(() => fs.existsSync(path.join(mac, 'win.txt')), 'Mac 收到 Windows 自动同步提交')
    assert.equal(fs.readFileSync(path.join(mac, 'win.txt'), 'utf8').trim(), 'Windows edit')
    lock(win, 'release', 'win.txt')
    await stop(winWorker)
    console.log('通过：Node.js 同步器和原有 Windows PowerShell 同步器双向收发与解锁。')
  } else {
    git(win, 'pull', '--ff-only', 'origin', 'collab')
  }
  await stop(macWorker)

  lock(mac, 'acquire', 'mac-local.txt')
  lock(win, 'acquire', 'win-remote.txt')
  commit(mac, 'mac-local.txt', 'left\n')
  commit(win, 'win-remote.txt', 'right\n')
  git(win, 'push', 'origin', 'collab')
  lock(win, 'release', 'win-remote.txt')
  macWorker = worker(mac)
  await until(() => tip() === head(mac) && macLog(mac).includes('已安全合并双方提交'), '分叉自动合并并推送')
  assert.equal(git(remote, 'show', 'collab:mac-local.txt'), 'left')
  assert.equal(git(remote, 'show', 'collab:win-remote.txt'), 'right')
  lock(mac, 'release', 'mac-local.txt')
  await stop(macWorker)
  git(win, 'pull', '--ff-only', 'origin', 'collab')

  lock(mac, 'acquire', 'conflict.txt')
  commit(mac, 'conflict.txt', 'Mac side\n')
  // Simulate a non-cooperating writer to exercise the conflict preservation path.
  const conflict = commit(win, 'conflict.txt', 'Windows side\n')
  git(win, 'push', 'origin', 'collab')
  macWorker = worker(mac)
  await until(() => git(mac, 'ls-files', '--unmerged').length > 0, '冲突保护')
  assert.equal(tip(), conflict)
  assert.equal(git(mac, 'show', ':2:conflict.txt'), 'Mac side')
  assert.equal(git(mac, 'show', ':3:conflict.txt'), 'Windows side')
  write(mac, 'conflict.txt', 'Mac side\nWindows side\n')
  git(mac, 'add', '--', 'conflict.txt')
  git(mac, 'commit', '--no-edit')
  await until(() => tip() === head(mac), '解决冲突后恢复')
  lock(mac, 'release', 'conflict.txt')
  const previousId = JSON.parse(fs.readFileSync(path.join(stateDir(mac), 'run.json'), 'utf8')).id
  const restarted = worker(mac, 'restart')
  await until(() => fs.existsSync(path.join(stateDir(mac), 'run.json')) &&
    JSON.parse(fs.readFileSync(path.join(stateDir(mac), 'run.json'), 'utf8')).id !== previousId, '重启更换进程')
  assert.equal(await macWorker.done, 0)
  workers.delete(macWorker)
  restarted.child.kill('SIGKILL')
  await restarted.done
  workers.delete(restarted)
  const closedId = JSON.parse(fs.readFileSync(path.join(stateDir(mac), 'run.json'), 'utf8')).id
  macWorker = worker(mac)
  await until(() => JSON.parse(fs.readFileSync(path.join(stateDir(mac), 'run.json'), 'utf8')).id !== closedId,
    '退出异常后重新启动')
  await stop(macWorker)
  console.log('通过：分叉自动合并、冲突保留双方内容、恢复、停止、重启与异常退出后启动。')

  lock(mac, 'acquire', 'secret-fixture.txt')
  const published = tip()
  commit(mac, 'secret-fixture.txt', 'sk-' + 'a'.repeat(32) + '\n')
  git(mac, 'rm', '--', 'secret-fixture.txt')
  git(mac, 'commit', '-m', 'Remove synthetic test data')
  macWorker = worker(mac)
  await until(() => macLog(mac).includes('发现疑似凭据，已阻止同步 secret-fixture.txt'), '待推历史密钥检查')
  assert.equal(tip(), published)
  await stop(macWorker)
  console.log('通过：早期提交已删除的模拟密钥也会阻止推送。')
}

console.log('隔离测试目录 ' + fixture)
test().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(async () => {
  for (const entry of workers) {
    entry.child.kill()
    await entry.done.catch(() => {})
  }
  const resolved = fs.realpathSync.native(fixture)
  if (resolved === fixture && path.dirname(resolved) === temp && path.basename(resolved).startsWith(prefix)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
