const test=require('node:test')
const assert=require('node:assert/strict')
const {escapeWall}=require('../agent/nmo-wall-escape')

test('窒息掉血时沿核实的走廊退出，普通怪物伤害仍交给战斗逻辑',async()=>{
  const status={ready:true,alive:true,dimension:'overworld',pos:[.5,48,.7],health:16}
  let source='arrow'
  const commands=[]
  const call=async (name,body)=>{
    commands.push([name,body])
    if(name==='events')return {last_seq:5,events:[{type:'hurt',source,t:Date.now()}]}
    assert.equal(name,'control')
    assert.ok(body.forward)
    assert.deepEqual(body.stop_on,['death'])
    return {pos:[1.1,48,.55]}
  }
  const block=async ([x,y,z])=>({name:x===1&&z===0&&y>=48?'air':'stone'})
  const step=()=>escapeWall(call,block,status,b=>b.name==='stone',b=>b.name==='air')
  assert.equal(await step(),false)
  status.health--
  assert.equal(await step(),false)
  status.health--
  source='in_wall'
  assert.equal(await step(),true)
  assert.deepEqual(commands.map(([name])=>name),['events','events','control'])
})

test('没有可站立出口时只尝试移开头部阻挡',async()=>{
  const status={ready:true,alive:true,dimension:'overworld',pos:[.5,20,.5],health:10}
  const actions=[]
  const call=async (action,args)=>{
    if(action==='events')return {last_seq:10,events:[{type:'hurt',source:'minecraft:in_wall',t:Date.now()}]}
    actions.push([action,args])
    return {}
  }
  const block=async ()=>({name:'gravel',diggable:true})
  const step=()=>escapeWall(call,block,status,()=>false,()=>false)
  assert.equal(await step(),false)
  status.health--
  assert.equal(await step(),true)
  assert.deepEqual(actions,[['dig',{pos:[0,21,0],collect:false,timeout:1800,stop_on:['death']}]])
})
