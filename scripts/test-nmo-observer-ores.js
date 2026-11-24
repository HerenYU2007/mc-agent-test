const test = require('node:test')
const assert = require('node:assert/strict')
const { createOreFeed } = require('../agent/nmo-observer-ores')
const { startNmoObserver } = require('../agent/nmo-observer')

const bot = { ready:true, alive:true, username:'Miner', server:'demo', dimension:'overworld', pos:[0.5,64,0.5] }
const ore = { name:'deepslate_diamond_ore', pos:[3,64,0] }
function report(session,time) {
  return { session, username:bot.username, dimension:bot.dimension, seenBot:bot.pos, sampledAt:time, ores:[ore,ore] }
}
test('旁观者候选绑定角色、会话、维度及可见 Bot 坐标，过期、跨服和错误数据失效', () => {
  let now=1000
  const feed=createOreFeed(bot,()=>({connected:true,position:{x:0.5,y:64,z:0.5}}),()=>now)
  const body=report(feed.session,now)
  for (const change of [{session:'old'},{username:'Other'},{dimension:'the_nether'},{seenBot:[16,64,0]}])
    assert.equal(feed.receive({...body,...change}),409)
  assert.equal(feed.receive({...body,ores:[{...ore,pos:[1.5,64,1]}]}),400)
  assert.equal(feed.receive(body),200)
  assert.equal(feed.candidates(bot,[ore.name]).length,1)
  assert.deepEqual(feed.candidates({...bot,server:'other'},[ore.name]),[])
  now+=45001
  assert.deepEqual(feed.candidates(bot,[ore.name]),[])
})
test('上传只登记候选，重复上报可覆盖采空的点，网页来源不能提交', async () => {
  const actions=[]
  const o=await startNmoObserver({ call:async n=>{actions.push(n);return n==='status'?bot:{items:[]}} },bot,{port:0,log:()=>{}})
  try {
    const {surveySession}=await (await fetch(o.endpoint)).json()
    const body=report(surveySession,Date.now())
    const send=(data,headers={})=>fetch(o.endpoint+'/ores',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(data)})
    assert.equal((await send(body,{origin:'http://example.org'})).status,415)
    assert.equal((await send(body)).status,200)
    assert.equal(o.oreCandidates(bot,[ore.name]).length,1)
    assert.equal((await send({...body,ores:[]})).status,200)
    assert.deepEqual(o.oreCandidates(bot,[ore.name]),[])
    assert(actions.every(n=>['inventory','status'].includes(n)))
  } finally {await o.close()}
})
