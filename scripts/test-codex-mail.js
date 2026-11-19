const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createGitHubClient, createMailbox, formatMessage, parseMessage, INTERVAL } = require('./codex-mail')

const config = { repo: 'mail-fixture/project', issue: 17, accounts: ['windows-user', 'mac-user'] }
const root = fs.realpathSync.native(os.tmpdir())
const prefix = 'nmo-codex-mail-test-'
const directory = fs.mkdtempSync(path.join(root, prefix))
const endpoint = `/repos/${config.repo}/issues/${config.issue}/comments`
const timestamp = '2026-11-19T05:00:00Z'

async function test() {
  const comments = []
  const reads = []
  let nextId = 100
  let brokenPage
  const insert = (author, body) => {
    const data = { id: nextId++, user: { login: author }, body, updated_at: timestamp }
    comments.push(data)
    return data
  }

  function connection(identity) {
    return createGitHubClient({ repo: config.repo, getCredential: () => 'fixture-credential', async fetcher(url, options) {
      assert.equal(url.origin, 'https://api.github.com')
      assert.equal(url.pathname, endpoint)
      assert.equal(options.headers.Authorization, 'Bearer fixture-credential')
      assert.equal(options.redirect, 'error')
      if (options.method === 'POST') return Response.json(insert(identity, JSON.parse(options.body).body), { status: 201 })
      const page = Number(url.searchParams.get('page'))
      const since = url.searchParams.get('since')
      reads.push({ page, since, identity })
      if (page === brokenPage) return Response.json({ error: 'temporary fixture failure' }, { status: 503 })
      const matching = comments.filter(comment => !since || Date.parse(comment.updated_at) > Date.parse(since))
      const result = matching.slice((page - 1) * 2, page * 2)
      const headers = matching.length > page * 2 ? { link: '<https://api.github.com/fixture>; rel="next"' } : {}
      return Response.json(result, { headers })
    } })
  }

  const windows = createMailbox({ config, me: 'windows-user', directory: path.join(directory, 'win'), request: connection('windows-user') })
  const mac = createMailbox({ config, me: 'mac-user', directory: path.join(directory, 'mac'), request: connection('mac-user') })
  assert.equal(INTERVAL, 30000)
  assert.throws(() => createMailbox({ config, me: 'stranger', directory, request: connection('stranger') }), /不属于/)
  const a = await windows.send('建造接口', '请确认 `target` 字段。\n复核提交 4465008。')
  assert.equal(a.to, 'mac-user')
  insert('stranger', formatMessage('mac-user', '伪造', '不应收录。', null))
  insert('windows-user', '普通 Issue 评论')
  insert('windows-user', formatMessage('windows-user', '非本机收件人', '不应收录。', null))
  assert.equal(parseMessage(null, config, 'mac-user'), null)

  brokenPage = 2
  await assert.rejects(mac.poll(), /503/)
  assert.equal(mac.status().checkedAt, undefined)
  assert.equal(mac.unread().length, 1, '第一页已写入且未漏掉')
  brokenPage = undefined
  assert.equal((await mac.poll()).added, 0)
  assert.ok(reads.some(read => read.page === 2))
  assert.deepEqual(mac.unread().map(message => [message.id, message.sender, message.topic]), [[a.id, 'windows-user', '建造接口']])
  assert.equal(mac.unread()[0].body, '请确认 `target` 字段。\n复核提交 4465008。')

  // Another valid comment arrives with the same GitHub timestamp.
  const b = await windows.send('待测', '请运行样图测试。')
  assert.equal((await mac.poll()).added, 1)
  assert.ok(reads.some(read => read.since === '2026-11-19T04:59:58.000Z'))
  assert.deepEqual(mac.unread().map(message => message.id), [a.id, b.id])
  await assert.rejects(mac.send('', '找不到的消息', 999), /找不到原消息/)
  const reply = await mac.send('', '收到，开始测试。', a.id)
  mac.ack([b.id])
  assert.deepEqual(mac.unread(), [])
  await Promise.all([mac.poll(), mac.poll()])
  assert.deepEqual(mac.unread(), [])
  const reopened = createMailbox({ config, me: 'mac-user', directory: path.join(directory, 'mac'), request: connection('mac-user') })
  assert.deepEqual(reopened.unread(), [], '重启后保留已读记录')

  assert.equal((await windows.poll()).added, 1)
  assert.deepEqual(windows.unread().map(message => [message.id, message.sender, message.replyTo, message.topic]),
    [[reply.id, 'mac-user', a.id, '建造接口']])
  assert.throws(() => windows.ack([999]), /找不到消息/)
  windows.ack([reply.id])
  await windows.poll()
  assert.deepEqual(windows.unread(), [])
  await assert.rejects(connection('windows-user')('https://example.com/'), /只连接 GitHub API/)
  console.log('通过：双向收发、未读确认、回复关联、分页、断线重试、同秒去重和账号过滤。')
}

test().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
  const exact = fs.realpathSync.native(directory)
  if (exact === directory && path.dirname(exact) === root && path.basename(exact).startsWith(prefix)) fs.rmSync(exact, { recursive: true, force: true })
})
