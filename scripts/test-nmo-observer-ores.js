const test = require('node:test')
const assert = require('node:assert/strict')
const { createOreFeed } = require('../agent/nmo-observer-ores')
const { startNmoObserver } = require('../agent/nmo-observer')

const bot = { ready:true, alive:true, username:'Miner', server:'demo', dimension:'overworld', pos:[0.5,64,0.5] }
const ore = { name:'deepslate_diamond_ore', pos:[3,64,0] }
const needed = [ore.name]
const frame = status => ({connected:true, position:{x:status.pos[0],y:status.pos[1],z:status.pos[2]}})
function report(session, request, time, status = bot) {
  return { session, requestId:request.id, username:status.username, dimension:status.dimension, seenBot:status.pos,
    sampledAt:time, batch:0, batches:1, ores:[ore,ore] }
}

test('Bot 请求绑定会话、角色、维度和所在区块，只接收周围九个区块的矿点', () => {
  let now = 1000
  let status = bot
  const feed = createOreFeed(bot,()=>frame(status),()=>now)
  assert.equal(feed.activeRequest(),null)
  assert.equal(feed.receive({}),409)
  feed.candidates(bot,['oak_log'])
  assert.equal(feed.activeRequest(),null)
  feed.candidates(bot,needed)
  const request = feed.activeRequest()
  assert.equal(request.chunkX,0)
  assert.equal(request.chunkZ,0)
  assert(request.names.includes('lapis_ore'))
  assert(!request.names.includes('ancient_debris'))
  assert.equal(feed.pending(),true)

  const body = report(feed.session,request,now)
  for (const change of [{session:'old'},{requestId:'old'},{username:'Other'},
    {dimension:'the_nether'},{seenBot:[16,64,0]}]) {
    assert.equal(feed.receive({...body,...change}),409)
  }
  for (const pos of [[-17,64,0],[32,64,0],[0,64,32],[1.5,64,1]]) {
    assert.equal(feed.receive({...body,ores:[{...ore,pos}]}),400)
  }
  const boundary = {...ore,pos:[-16,-64,31]}
  assert.equal(feed.receive({...body,ores:[ore,boundary]}),200)
  assert.equal(feed.pending(),false)
  assert.equal(feed.candidates(bot,needed).length,2)
  assert.deepEqual(feed.candidates({...bot,server:'other'},needed),[])

  status = {...bot,pos:[16.5,64,0.5]}
  assert.equal(feed.candidates(status,needed).length,1)
  assert.equal(feed.activeRequest().chunkX,1)
  assert.equal(feed.receive(body),409)
  now += 45001
  assert.equal(feed.activeRequest(),null)
  feed.candidates(status,needed)
  assert.equal(feed.activeRequest().chunkX,1)
})

test('分批登记全部坐标，矿点去重并在确认采空后移除', () => {
  let now = 1000
  const feed = createOreFeed(bot,()=>frame(bot),()=>now)
  feed.candidates(bot,needed)
  const body = report(feed.session,feed.activeRequest(),now)
  const all = Array.from({length:150},(_,i)=>({...ore,pos:[i%31-15,50+(i/31|0),0]}))
  assert.equal(feed.receive({...body,batches:2,ores:all.slice(0,128)}),200)
  assert.equal(feed.candidates(bot,needed).length,128)
  assert.equal(feed.receive({...body,batches:2,ores:all.slice(0,128)}),200)
  feed.forget(bot,all[0].pos,ore.name)
  assert.equal(feed.receive({...body,batch:1,batches:2,ores:[all[0],...all.slice(128)]}),200)
  assert.equal(feed.candidates(bot,needed).length,149)
  assert.equal(feed.activeRequest(),null)
  now += 30001
  assert.equal(feed.candidates(bot,needed).length,149)
  const newer = report(feed.session,feed.activeRequest(),now)
  assert.equal(feed.receive({...newer,ores:[ore]}),200)
  assert.deepEqual(feed.candidates(bot,needed).map(candidate=>candidate.pos),[ore.pos])
})

test('下界扫描只请求对应维度的矿物', () => {
  const status = {...bot, dimension:'the_nether', pos:[-0.5,64,-16.1]}
  const feed = createOreFeed(status,()=>frame(status))
  feed.candidates(status,needed)
  assert.equal(feed.activeRequest(),null)
  feed.candidates(status,['ancient_debris'])
  const request = feed.activeRequest()
  assert.deepEqual([request.chunkX,request.chunkZ],[-1,-2])
  assert.deepEqual(request.names,['nether_gold_ore','nether_quartz_ore','ancient_debris'])
})

test('HTTP 上报只登记候选，网页来源不能提交', async () => {
  const actions = []
  const observer = await startNmoObserver({call:async name=>{
    actions.push(name)
    return name==='status'?bot:{items:[]}
  }},bot,{port:0,log:()=>{}})
  try {
    assert.equal((await (await fetch(observer.endpoint)).json()).oreSurvey,null)
    observer.oreCandidates(bot,needed)
    const {surveySession,oreSurvey} = await (await fetch(observer.endpoint)).json()
    const body = report(surveySession,oreSurvey,Date.now())
    const send = headers => fetch(observer.endpoint+'/ores',{method:'POST',
      headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)})
    assert.equal((await send({origin:'http://example.org'})).status,415)
    assert.equal((await send()).status,200)
    assert.equal(observer.oreCandidates(bot,needed).length,1)
    observer.forgetOre(bot,ore.pos,ore.name)
    assert.deepEqual(observer.oreCandidates(bot,needed),[])
    assert(actions.every(name=>['inventory','status'].includes(name)))
  } finally {
    await observer.close()
  }
})
