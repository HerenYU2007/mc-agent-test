const assert = require('node:assert/strict')
const { execFile, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { setTimeout: pause } = require('node:timers/promises')

const tempRoot = fs.realpathSync.native(os.tmpdir())
const prefix = 'codex-file-lock-test-'
const fixture = fs.mkdtempSync(path.join(tempRoot, prefix))
const globalConfig = path.join(fixture, 'gitconfig')
fs.writeFileSync(globalConfig, '')
const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_COUNT: '0', GIT_TERMINAL_PROMPT: '0' }
const remote = path.join(fixture, 'remote.git')
const ref = 'refs/heads/codex-file-locks'
const shared = 'agent/Shared 共享 文件.js'
const side = 'agent/new.js'

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 15000 }).trim()
}

function lock(cwd, action, ...files) {
  const args = ['scripts/file-lock.js', action, '--local-test', '--', ...files]
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { cwd, env, encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') return reject(error)
      resolve({ cwd, ok: !error, message: stdout + stderr })
    })
  })
}

function expect(result, ok, message) {
  assert.equal(result.ok, ok, result.message)
  assert.match(result.message, message)
}

async function pushThroughSync(cwd) {
  const target = git(cwd, 'rev-parse', 'HEAD')
  if (process.platform !== 'win32') {
    git(cwd, 'push', 'origin', 'collab')
    return
  }
  const options = { cwd, env, encoding: 'utf8', timeout: 30000, windowsHide: true }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', './auto-sync.ps1']
  const worker = new Promise(resolve => {
    execFile('powershell.exe', [...args, '-AllowLocalRemote', '-IntervalSeconds', '1', '-StableSeconds', '1'], options, resolve)
  })
  try {
    const deadline = Date.now() + 22000
    while (git(remote, 'rev-parse', 'collab') !== target && Date.now() < deadline) await pause(200)
    assert.equal(git(remote, 'rev-parse', 'collab'), target, '自动同步未发布持锁方提交')
  } finally {
    try {
      execFileSync('powershell.exe', [...args, '-Action', 'Stop'], options)
    } finally {
      assert.ifError(await worker)
      const gitDir = git(cwd, 'rev-parse', '--absolute-git-dir')
      assert.match(fs.readFileSync(path.join(gitDir, 'codex-auto-sync', 'sync.log'), 'utf8'), /已推送 collab/)
    }
  }
}

async function test() {
  fs.mkdirSync(remote)
  git(remote, 'init', '--bare', '--initial-branch=collab')
  const a = path.join(fixture, 'PC A')
  const clone = path.join(fixture, 'PC B')
  const b = path.join(fixture, 'Codex linked worktree')
  fs.mkdirSync(a)
  git(a, 'init', '--initial-branch=collab')
  git(a, 'config', 'user.name', 'Test A')
  git(a, 'config', 'user.email', 'a@example.test')
  git(a, 'remote', 'add', 'origin', remote)
  fs.mkdirSync(path.join(a, 'scripts'))
  fs.mkdirSync(path.join(a, 'agent'))
  fs.copyFileSync(path.join(__dirname, 'file-lock.js'), path.join(a, 'scripts', 'file-lock.js'))
  for (const file of ['auto-sync.ps1', '.gitignore']) fs.copyFileSync(path.join(__dirname, '..', file), path.join(a, file))
  fs.writeFileSync(path.join(a, shared), 'initial\n')
  git(a, 'add', '.')
  git(a, 'commit', '-m', 'Temporary fixture')
  expect(await lock(a, 'acquire', shared), false, /collab 尚未建立/)
  git(a, 'push', 'origin', 'collab')
  git(fixture, 'clone', '--branch', 'collab', remote, clone)
  git(clone, 'config', 'user.name', 'Test B')
  git(clone, 'config', 'user.email', 'b@example.test')
  git(clone, 'switch', '-c', 'test-spare')
  git(clone, 'worktree', 'add', b, 'collab')
  expect(await lock(clone, 'acquire', shared), false, /需要|检出了 collab/)
  expect(await lock(a, 'acquire', '.env'), false, /被 Git 忽略/)

  const initial = git(remote, 'rev-parse', 'collab')
  const alias = process.platform === 'win32' ? shared.toLowerCase() : shared
  const results = await Promise.all([
    lock(a, 'acquire', shared),
    lock(b, 'acquire', alias.replace('/', '\\'))
  ])
  assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results))
  const winner = results.find(result => result.ok).cwd
  const loser = results.find(result => !result.ok).cwd
  expect(results.find(result => !result.ok), false, /另一工作树锁定/)
  assert.equal(git(remote, 'rev-list', '--count', ref), '1')
  assert.equal(git(remote, 'ls-tree', '-r', ref), '')
  assert.equal(git(remote, 'rev-parse', 'collab'), initial)
  expect(await lock(loser, 'acquire', side, shared), false, /另一工作树锁定/)
  expect(await lock(loser, 'status', side), true, /空闲/)
  expect(await lock(loser, 'release', shared), false, /无法解锁他人/)
  expect(await lock(winner, 'acquire', shared), true, /可以编辑/)
  console.log('通过：两台电脑同时抢锁只有一个赢家，批量申请无部分占用，linked worktree 正常。')

  fs.writeFileSync(path.join(winner, shared), 'winner edit\n')
  expect(await lock(winner, 'release', shared), false, /未提交/)
  git(winner, 'add', '--', shared)
  expect(await lock(winner, 'release', shared), false, /未提交/)
  git(winner, 'commit', '-m', 'Stable edit')
  expect(await lock(winner, 'release', shared), false, /尚未包含当前本地提交/)
  await pushThroughSync(winner)
  expect(await lock(winner, 'release', shared), true, /已解锁/)
  expect(await lock(loser, 'acquire', shared), false, /等待自动同步/)
  git(loser, 'pull', '--ff-only', 'origin', 'collab')
  expect(await lock(loser, 'acquire', shared, side), true, /可以编辑/)
  expect(await lock(loser, 'status', side), true, /当前工作树持有/)
  expect(await lock(winner, 'status', shared), true, /其他工作树持有/)
  expect(await lock(loser, 'release', shared, side), true, /已解锁/)
  assert.equal(git(remote, 'rev-list', '--count', ref), '4')
  assert.equal(JSON.parse(git(remote, 'show', '-s', '--format=%B', ref)).locks.length, 0)
  console.log('通过：有未提交或未推送修改时拒绝解锁，推送成功后解锁，另一方先同步再接手。')
}

test().catch(error => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  const resolved = fs.realpathSync.native(fixture)
  if (resolved === fixture && path.dirname(resolved) === tempRoot && path.basename(resolved).startsWith(prefix)) {
    fs.rmSync(resolved, { recursive: true, force: true })
  }
})
