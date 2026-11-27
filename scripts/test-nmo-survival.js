const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { strategy, runStep, checkpoint } = require('../agent/nmo-survival')
const { actions } = require('../agent/nmo-actions')
const { step: expeditionStep } = require('../agent/nmo-full-route')
const { fits, baseStep } = require('../agent/nmo-base')
const { DEPOT, WORKSHOP } = require('../supply-base')

function scenario(names, overrides = {}) {
  const operations = []
  const items = Object.entries(names).map(([name, count], i) => ({ slot: 36 + i, name, count }))
  const inventory = { items, armor: {}, offhand: null }
  const a = {
    inventory,
    status: { food: 20, health: 20, time_of_day: 4000, pos: [0, 64, 0] },
    here: () => [0, 64, 0],
    count: (n) => names[n] || 0,
    sum: (fn) => items.reduce((v, i) => v + (fn(i.name) ? i.count : 0), 0),
    tool: (k) => ['netherite','diamond','iron','copper','stone','golden','wooden']
      .map(tier => tier + '_' + k).find(name => names[name]),
    refresh: async () => {},
    safety: async () => false,
    food: async () => false,
    gather: async (k) => operations.push(['gather', k]),
    ensureSticks: async () => true,
    ensurePlanks: async () => true,
    station: async (n) => {
      operations.push(['station', n])
      return [1, 64, 0]
    },
    craft: async (n) => {
      operations.push(['craft', n])
      names[n] = (names[n] || 0) + 1
    },
    reclaim: async (n) => operations.push(['reclaim', n]),
    smelt: async (...args) => operations.push(['smelt', ...args]),
    ...overrides,
  }
  const m = { diamonds: 0, surface: [0, 64, 0] }
  return {
    a,
    m,
    operations,
    next: () =>
      runStep(
        a,
        m,
        () => {},
        strategy(a, m),
        () => {},
      ),
  }
}
test('空背包到木镐和石镐沿用同一个阶段判断', async () => {
  const empty = scenario({})
  assert.equal(await empty.next(), 'gather_wood')
  assert.deepEqual(empty.operations, [['gather', 'wood']])
  const wood = scenario({ oak_log: 12, wooden_axe: 1 })
  assert.equal(await wood.next(), 'wood_tools')
  assert.ok(wood.operations.some((op) => op[1] === 'wooden_pickaxe'))
  const bench = scenario({ crafting_table: 1, spruce_planks: 3, stick: 2, wooden_axe: 1 })
  assert.equal(await bench.next(), 'wood_tools')
  assert.ok(bench.operations.some(op => op[0] === 'craft' && op[1] === 'wooden_pickaxe'))
  const stone = scenario({ wooden_pickaxe: 1, cobblestone: 3 })
  await stone.next()
  assert.ok(stone.operations.some((op) => op[1] === 'stone_pickaxe'))
})
test('补煤、熔铁、装备和钻石后资格来自实际背包', async () => {
  const tools = { stone_pickaxe: 1, stone_axe: 1, stone_sword: 1, stick: 6, oak_planks: 10 }
  const coal = scenario({ ...tools, raw_iron: 3 })
  await coal.next()
  assert.deepEqual(coal.operations, [['gather', 'coal']])
  const iron = scenario({ ...tools, coal: 3, raw_iron: 3 })
  await iron.next()
  assert.deepEqual(iron.operations, [['smelt', 'raw_iron', 'coal']])
  const pick = scenario({ ...tools, iron_ingot: 3, coal: 4 })
  await pick.next()
  assert.ok(pick.operations.some((op) => op[1] === 'iron_pickaxe'))
  const diamond = scenario({ ...tools, iron_pickaxe: 1, iron_sword: 1, bucket: 1, coal: 4, torch: 12 })
  for (const [k, type] of Object.entries({
    head: 'helmet',
    chest: 'chestplate',
    legs: 'leggings',
    feet: 'boots',
  }))
    diamond.a.inventory.armor[k] = { name: 'diamond_' + type }
  diamond.a.inventory.offhand = { name: 'shield' }
  const count = diamond.a.count
  let diamonds = 0
  diamond.a.count = (n) => (n === 'diamond' ? diamonds : count(n))
  diamond.a.gather = async (k) => {
    assert.equal(k, 'diamond')
    diamonds++
  }
  diamond.m.diamonds = 9
  await diamond.next()
  assert.equal(diamond.m.diamonds, 10)
  assert.equal(strategy(diamond.a, diamond.m).stage().name, 'supply_base')
  diamond.a.count = (n) => n === 'lapis_lazuli' ? 9 : n === 'diamond' ? diamonds : count(n)
  diamond.a.gather = async (k) => diamond.operations.push(['gather', k])
  assert.equal(await diamond.next(), '回基地前采集青金石 9/10')
  assert.deepEqual(diamond.operations, [['gather', 'lapis']])
})

test('后期试炼密室以服务器实际成就为准，随后从已记录站位返回基地', async () => {
  const armor = Object.fromEntries(['helmet','chestplate','leggings','boots'].map(part => [part,{name:'diamond_' + part}]))
  const operations = []
  const a = {
    status: { dimension:'overworld', health:20, food:20 }, inventory: { armor, offhand:{name:'shield'} },
    here: () => [20,-18,16], sum: () => 10,
    call: async (action, input) => {
      operations.push([action,input.ids])
      return { advancements:[{id:'minecraft:adventure/minecraft_trials_edition'}] }
    },
    move: async (pos, range) => operations.push(['move',pos,range]),
  }
  const m = { anchor:[0,64,0], nether:{completed:true,trialChamber:{pos:[22,-19,16]}} }
  const context = { env:{LLM_API_KEY:'test'}, log() {} }
  assert.equal(await expeditionStep(a,m,() => {},context), '已获得试炼密室成就，返回基地')
  assert.equal(m.nether.trialAchievement, true)
  assert.equal(m.nether.trialChamber, undefined)
  assert.equal(await expeditionStep(a,m,() => {},context), '试炼密室侦察后返回基地')
  assert.deepEqual(operations, [['advancements',['adventure/minecraft_trials_edition']],['move',[0,64,0],4]])
})

test('工坊合成前背包已满时回储物桶存一组石料', async () => {
  const storage = DEPOT.find(piece => piece.id === 'storage').offset
  const calls = []
  const m = {anchor:[0,0,0], unlocked:true, needed:'hopper'}
  const a = {
    inventory:{empty_slots:0}, count:name => name === 'cobblestone' ? 236 : 0,
    here:() => [20,0,20], block:async () => ({name:'barrel'}),
    move:async (...args) => calls.push(args),
    call:async (...args) => calls.push(args), refresh:async () => {},
  }
  assert.equal(await baseStep(a,m,() => {},() => {}), '先回储物桶腾出合成空间')
  a.here = () => storage
  assert.equal(await baseStep(a,m,() => {},() => {}), '存放富余石料，继续施工')
  assert.deepEqual(calls, [[storage,2], ['window/act',{target:{pos:storage},ops:[{
    op:'put',to:'container',item:'cobblestone',count:64,
  }]}]])
  assert.equal(m.needed,'hopper')
})

test('去远处找铁前，先采可直接挖的铁；附近无铁时就地补煤', async () => {
  const inventory = {stone_pickaxe:1, stone_axe:1, stone_sword:1, coal:5, torch:8, raw_iron:1}
  for (const nearby of ['iron','coal']) {
    const f = scenario(inventory)
    f.a.refresh = async () => {}
    f.a.gatherNearby = async kind => {
      f.operations.push(['nearby',kind])
      return kind === nearby
    }
    await f.next()
    assert.deepEqual(f.operations, nearby === 'iron' ? [['nearby','iron']] : [['nearby','iron'],['nearby','coal']])
  }
})

test('新档开局煤储备补到 32，达标后消耗燃料不会重新卡在开局阶段', async () => {
  const tools = {stone_pickaxe:1,stone_axe:1,stone_sword:1,torch:12}
  const low = scenario({...tools,coal:31})
  assert.equal(await low.next(), 'find_coal')
  assert.deepEqual(low.operations, [['gather','coal']])
  const stocked = scenario({...tools,coal:31,charcoal:1})
  assert.equal(await stocked.next(), 'find_iron')
  assert.equal(stocked.m.openingCoalStocked, true)
  const later = scenario({...tools,coal:6})
  later.m.openingCoalStocked = true
  assert.equal(await later.next(), 'find_iron')
})

test('做完木镐后先用木斧备齐 12 根原木再进矿', async () => {
  const base = {wooden_pickaxe:1,wooden_axe:1,cobblestone:3}
  const status = {dimension:'overworld',food:20,health:20,time_of_day:4000,pos:[0,64,0]}
  const low = scenario({...base,oak_log:11},{status})
  assert.equal(await low.next(), '进矿前采集备用原木')
  assert.deepEqual(low.operations, [['gather','wood']])
  const stocked = scenario({...base,oak_log:12},{status})
  assert.equal(await stocked.next(), 'get_stone')
  assert.equal(stocked.m.openingWoodStocked, true)
  assert.ok(stocked.operations.some(op => op[0] === 'craft' && op[1] === 'stone_pickaxe'))
})

test('铁锭已够但缺木棍时，从矿层返程补木', async () => {
  const f = scenario({stone_pickaxe:1,stone_axe:1,stone_sword:1,iron_ingot:3,coal:1,stick:1,oak_planks:1}, {
    here: () => [0,56,0],
  })
  f.a.stair = async height => f.operations.push(['stair',height])
  assert.equal(await f.next(), '沿原矿道返回补充工具用木材')
  assert.deepEqual(f.operations, [['stair',64]])
})

test('熔炉正在烧炼时就近采铁，出锭后先取货', async () => {
  const f = scenario({iron_pickaxe:1,stone_axe:1,stone_sword:1,coal:28,raw_iron:2,torch:8})
  f.m.furnace = [1,64,0]
  f.a.block = async () => ({name:'furnace'})
  let output = []
  f.a.call = async method => {
    assert.equal(method,'window/view')
    return {info:{burning:true},sections:{input:[{name:'raw_iron'}],fuel:[],output}}
  }
  f.a.gatherNearby = async (kind,options) => f.operations.push(['nearby',kind,options.within])
  assert.equal(await f.next(),'熔炼期间采集炉边粗铁')
  assert.deepEqual(f.operations,[['nearby','iron',{center:f.m.furnace,radius:2.5}]])
  output = [{name:'iron_ingot'}]
  assert.equal(await f.next(),'熔炼、取货和回收临时熔炉')
  assert.deepEqual(f.operations.at(-1),['smelt',null,'coal'])
})

test('身边没有工作台时，先为铁镐补足新工作台的木板', async () => {
  const f = scenario({stone_pickaxe:1,stone_axe:1,stone_sword:1,iron_ingot:3,coal:1,stick:5,oak_planks:3})
  f.m.crafting_table = [12,56,0]
  f.a.ensurePlanks = async amount => f.operations.push(['planks',amount])
  assert.equal(await f.next(), 'find_iron')
  assert.deepEqual(f.operations, [['planks',4]])
})

test('熔炉内仍有成品时不拆，取货后验证清空和拾取', async () => {
  const inventory = { items: [{ name: 'iron_pickaxe', count: 1 }], armor: {} }
  const pos = [2, 64, 0],
    memory = { furnace: pos },
    ops = []
  let pending = true,
    block = 'furnace'
  const api = {
    async call(name, body) {
      ops.push(name)
      if (name === 'status') return { pos: [0, 64, 0] }
      if (name === 'inventory') return inventory
      if (name === 'get_block') return { name: block }
      if (name === 'window/view')
        return {
          sections: { fuel: [], input: [], output: pending ? [{ name: 'iron_ingot', count: 1 }] : [] },
          info: {},
        }
      if (name === 'window/act') {
        assert.equal(body.ops[0].from, 'output')
        inventory.items.push({ name: 'iron_ingot', count: 1 })
        pending = false
        return {}
      }
      if (name === 'equip') return {}
      if (name === 'dig') {
        block = 'air'
        inventory.items.push({ name: 'furnace', count: 1 })
        return {}
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    memory,
    () => {},
    () => {},
  )
  await a.refresh()
  assert.equal(await a.reclaim('furnace'), false)
  assert.equal(ops.includes('dig'), false)
  await a.smelt(null, null)
  await a.smelt(null, null)
  assert.equal(memory.furnace, undefined)
  assert.equal(a.count('furnace'), 1)
  assert.equal(a.count('iron_ingot'), 1)
})
test('工坊必须验证漏斗朝向和红石壁灯', () => {
  const feed = WORKSHOP.find((p) => p.id === 'fuel-feed'),
    indicator = WORKSHOP.find((p) => p.id === 'indicator')
  assert.equal(fits(feed, { name: 'hopper', properties: { facing: 'down' } }), false)
  assert.equal(fits(feed, { name: 'hopper', properties: { facing: 'west' } }), true)
  assert.equal(fits(indicator, { name: 'redstone_wall_torch', properties: { facing: 'south' } }), true)
})
test('重启保留进度且禁止误用其他存档', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmo-state-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const env = { MC_NMO_STATE_PATH: path.join(dir, 'state.json') },
    api = { base: 'http://localhost:1234/api/v1' },
    s = { username: 'A', dimension: 'overworld' }
  const prior = checkpoint(env, api, s)
  prior.memory.diamonds = 8
  prior.save()
  assert.equal(checkpoint(env, api, s).memory.diamonds, 8)
  assert.throws(() => checkpoint(env, api, { ...s, username: 'B' }), /存档归属/)
})

test('角色占用施工格时，先通过 HTTP 走到安全的相邻格再重试', async () => {
  let pos = [0, 64, 0],
    attempts = 0
  const api = {
    async call(name, body) {
      if (name === 'status') return { pos, ready:true, alive:true, health:20, dimension:'overworld', on_ground:true }
      if (name === 'inventory') return { items: [] }
      if (name === 'get_block') return { name: body.pos[1] < 64 ? 'stone' : 'air' }
      if (name === 'move_to') {
        pos = body.pos.map((v,i)=>i!==1 && Number.isInteger(v)?v+0.5:v)
        return { pos }
      }
      if (name === 'place') {
        if (!attempts++) throw Object.assign(Error('self'), { code: 'blocked_by_self' })
        assert.notDeepEqual(pos, body.pos)
        return { placed: body.item, pos: body.pos }
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    {},
    () => {},
    () => {},
  )
  await a.refresh()
  assert.equal((await a.placeAt('hopper', [0, 64, 0])).placed, 'hopper')
  assert.equal(attempts, 2)
})

test('狭窄矿道里就近开一格放熔炉，避开含水侧壁', async () => {
  const wet = [1, 64, 0]
  const dry = [0, 64, 1]
  const cells = new Map([['0,64,0', 'air'], ['0,65,0', 'air'], ['2,64,0', 'water']])
  const work = []
  const api = {
    async call(name, body) {
      if (name === 'status') return { ready:true, alive:true, health:20, pos:[0.5,64,0.5], dimension:'overworld', on_ground:true }
      if (name === 'inventory') return { items:[{name:'furnace',count:1},{name:'stone_pickaxe',count:1}] }
      if (name === 'get_entities') return { entities: [] }
      if (name === 'get_block') return { name:cells.get(body.pos.join(',')) || 'stone', diggable:true, pos:body.pos }
      if (name === 'equip') return {}
      if (name === 'dig') {
        work.push(body.pos)
        cells.set(body.pos.join(','), 'air')
        return { dug:'stone' }
      }
      if (name === 'place') {
        assert.equal(cells.get(body.pos.join(',')), 'air')
        assert.deepEqual(body.pos, dry)
        return { placed:body.item, pos:body.pos }
      }
      assert.fail(name)
    },
  }
  const memory = { surface:[0,86,0] }
  const a = actions(api, memory, () => {}, () => {})
  await a.refresh()
  assert.deepEqual(await a.station('furnace'), dry)
  assert.deepEqual(memory.furnace, dry)
  assert.deepEqual(work, [dry])
  assert.equal(cells.has(wet.join(',')), false)
})

test('背包已有工作台时就地放置，跳过远处的旧工作台', async () => {
  const local = [1,64,0]
  const memory = {crafting_table:[12,56,0]}
  const api = {
    async call(name, body) {
      if (name === 'status') return {pos:[0.5,64,0.5]}
      if (name === 'inventory') return {items:[{name:'crafting_table',count:1}]}
      if (name === 'place') return {placed:body.item,pos:local}
      assert.fail(name)
    },
  }
  const a = actions(api,memory,() => {},() => {})
  await a.refresh()
  assert.deepEqual(await a.station('crafting_table'),local)
  assert.deepEqual(memory.crafting_table,local)
})

test('工作台自动选址碰到火把后选择空格放置', async () => {
  const torch = [1,64,0]
  const empty = [0,64,1]
  const api = {
    async call(name, body) {
      if (name === 'status') return {pos:[0.5,64,0.5]}
      if (name === 'inventory') return {items:[{name:'crafting_table',count:1}]}
      if (name === 'get_block') {
        const name = body.pos.join(',') === torch.join(',') ? 'torch' : body.pos[1] < 64 ? 'stone' : 'air'
        return {name}
      }
      if (name === 'place') {
        if (!body.pos) throw Object.assign(Error('torch occupies auto-place cell'),{code:'place_failed'})
        assert.deepEqual(body.pos,empty)
        return {placed:body.item,pos:body.pos}
      }
      assert.fail(name)
    },
  }
  const a = actions(api,{},() => {},() => {})
  await a.refresh()
  assert.deepEqual(await a.station('crafting_table'),empty)
})

test('矿道内优先从可回收的同层空位选择工作台落点', async () => {
  const ground = [2,64,0]
  const ledge = [0,65,1]
  const open = [ground,addHead(ground),ledge,addHead(ledge)].map(pos => pos.join(','))
  function addHead(pos) {return [pos[0],pos[1]+1,pos[2]]}
  const api = {
    async call(name,body) {
      if (name === 'status') return {pos:[0.5,64,0.5]}
      if (name === 'inventory') return {items:[{name:'crafting_table',count:1}]}
      if (name === 'get_block') return {name:open.includes(body.pos.join(',')) ? 'air' : 'stone'}
      if (name === 'place') {
        assert.deepEqual(body.pos,ground)
        return {placed:body.item,pos:body.pos}
      }
      assert.fail(name)
    },
  }
  const a = actions(api,{surface:[0,71,0]},() => {},() => {})
  await a.refresh()
  assert.deepEqual(await a.station('crafting_table'),ground)
})

test('起步采石时会把深洞候选排除在 AIA 和挖掘动作之外', async () => {
  const near = [[1, 64, 0], [0, 64, 1]]
  const deep = [0, 44, 2]
  const digs = []
  let collected = 0
  const state = {
    pos:[0.5,64,0.5], health:20, food:20, ready:true, alive:true,
    dimension:'overworld', gamemode:'survival', held:{name:'wooden_pickaxe'},
  }
  const candidates = [deep, ...near].map(pos => ({name:'stone', pos}))
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return {items:[{name:'wooden_pickaxe',count:1},{name:'cobblestone',count:collected}]}
      if (name === 'find_blocks') {
        assert.equal(body.radius, 12)
        return {blocks:candidates}
      }
      if (name === 'get_block') return {name:near.some(pos => pos.join(',') === body.pos.join(',')) ? 'stone' : 'air'}
      if (name === 'get_entities') return {entities:[]}
      if (name === 'dig') {
        digs.push(body.pos)
        collected++
        return {gained:{cobblestone:1}}
      }
      assert.fail(name)
    },
  }
  const a = actions(api, {}, () => {}, () => {}, async ({options}) => {
    assert.deepEqual(options.map(option => option.pos), near)
    return 1
  })
  await a.refresh()
  assert.equal(await a.gather('stone'), true)
  assert.deepEqual(digs, [near[1]])
})

test('采铁先处理近处安全矿点，旁观上报的远点排在后面', async () => {
  const wet = [1,64,0]
  const dry = [0,64,2]
  const remote = [9,64,0]
  const blocks = new Map([[wet.join(','),'iron_ore'],[dry.join(','),'iron_ore'],['2,64,0','water']])
  const state = {
    pos:[0.5,64,0.5], health:20, food:20, ready:true, alive:true,
    dimension:'overworld', gamemode:'survival', held:{name:'stone_pickaxe'},
  }
  const digs = []
  let rawIron = 0
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return {items:[
        {name:'stone_pickaxe',count:1},{name:'raw_iron',count:rawIron},
      ]}
      if (name === 'find_blocks') return {blocks:[{name:'iron_ore',pos:wet}]}
      if (name === 'get_block') return {name:blocks.get(body.pos.join(',')) || 'air',harvest_tool_ok:true}
      if (name === 'get_entities') return {entities:[]}
      if (name === 'dig') {
        digs.push(body.pos)
        rawIron++
        return {gained:{raw_iron:1}}
      }
      assert.fail(name)
    },
  }
  const a = actions(api, {}, () => {}, () => {}, () => assert.fail('近矿无需比较远点'), {
    observerOres: () => [remote,dry].map(pos => ({name:'iron_ore',pos,source:'observer'})),
  })
  await a.refresh()
  assert.equal(await a.gatherNearby('iron'), true)
  assert.deepEqual(digs, [dry])
})

test('主任务就近挖铁后会补捡安全位置上的粗铁', async () => {
  const ore = [1,64,0]
  const item = {id:7,name:'item',item:'raw_ironx1',pos:[1.5,64,0.5]}
  const state = {
    pos:[0.5,64,0.5],health:20,food:20,ready:true,alive:true,dimension:'overworld',
    gamemode:'survival',held:{name:'stone_pickaxe'},
  }
  let dug = false
  let collected = false
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return {items:[
        {name:'stone_pickaxe',count:1}, {name:'raw_iron',count:Number(collected)},
      ]}
      if (name === 'find_blocks') return {blocks:[{name:'iron_ore',pos:ore}]}
      if (name === 'get_block') {
        const oreHere = !dug && ore.join(',') === body.pos.join(',')
        return {name:oreHere ? 'iron_ore' : body.pos[1]<64 ? 'stone' : 'air', harvest_tool_ok:true}
      }
      if (name === 'get_entities') return {entities:body.types.includes('item') && dug && !collected ? [item] : []}
      if (name === 'dig') {
        dug = true
        return {gained:{}}
      }
      if (name === 'move_to') {
        assert.equal(body.entity_id,item.id)
        collected = true
        state.pos = item.pos
        return {pos:state.pos}
      }
      assert.fail(name)
    },
  }
  const a = actions(api,{},() => {},() => {})
  await a.refresh()
  assert.equal(await a.gatherNearby('iron',{recoverDrops:true}),true)
  assert.equal(a.count('raw_iron'),1)
})

test('已返程到基地时兼容旧足迹，仍可去旁边清理旧工具并返回', async () => {
  const items = [
    {name:'wooden_pickaxe',count:1},
    {name:'stone_pickaxe',count:1},
    {name:'wooden_sword',count:1,custom_name:'纪念品'},
    {name:'stone_sword',count:1},
  ]
  const state = {
    pos:[0.5,64,0.5], health:20, ready:true, alive:true, on_ground:true, dimension:'overworld',
    held:{name:'stone_pickaxe'},
  }
  const calls = []
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return {items,empty_slots:36-items.length}
      if (name === 'get_block') return {name:body.pos[1] < 64 ? 'stone' : 'air'}
      calls.push([name,body])
      if (name === 'look') return {}
      if (name === 'drop') {
        assert.equal(body.item, 'wooden_pickaxe')
        items.splice(0,1)
        return {}
      }
      if (name === 'move_to') {
        state.pos = [body.pos[0]+0.5,body.pos[1],body.pos[2]+0.5]
        return {pos:state.pos}
      }
      assert.fail(name)
    },
  }
  const a = actions(api, {unlocked:true,returnTrail:{points:[[0,60,0]],cursor:1}}, () => {}, () => {})
  await a.refresh()
  assert.equal(await a.clearBackpack(), true)
  assert.deepEqual(calls.map(call => call[0]), ['move_to','look','drop','move_to'])
  assert.deepEqual(calls[0][1].pos, [4,64,0])
  assert.equal(calls[1][1].pos[0], 6.5)
  assert.deepEqual(state.pos, [0.5,64,0.5])
  assert.equal(a.count('wooden_sword'), 1)
})

test('撤退会在跨出初始警戒距离后继续，脱战确认前不恢复挖矿', async t => {
  let time = 10000
  t.mock.method(Date, 'now', () => time)
  const state = {
    ready:true, alive:true, on_ground:true, dimension:'overworld', gamemode:'survival',
    pos:[0.5,64,0.5], health:18, food:18, nearest_hostile:{id:5,name:'creeper',dist:3},
  }
  let foes = [{id:5,name:'creeper',dist:3,pos:[0.5,64,3.5]}]
  const movement = []
  const api = {
    async call(name, body) {
      if (name === 'status') return {...state}
      if (name === 'inventory') return {items:[]}
      if (name === 'get_entities') return {entities:foes}
      if (name === 'get_block') return {name:body.pos[1] < 64 ? 'stone' : 'air'}
      if (name === 'control') {
        assert.equal(body.sprint,true)
        movement.push(['sprint',body.ms])
        state.pos = [0.5,64,-3.5]
        return {pos:state.pos}
      }
      if (name === 'move_to') {
        movement.push(['move',body.pos])
        state.pos = [body.pos[0]+0.5,body.pos[1],body.pos[2]+0.5]
        return {pos:state.pos}
      }
      assert.fail(name)
    },
  }
  const a = actions(api, {}, () => {}, () => {})
  await a.refresh()
  assert.equal(await a.safety(), true)
  assert.equal(a.retreating, true)
  assert.ok(movement[0][1]>550)
  foes = [{id:5,name:'creeper',dist:13,pos:[0.5,64,9.5]}]
  state.nearest_hostile = {id:5,name:'creeper',dist:13}
  await a.refresh()
  assert.equal(await a.safety(), true)
  assert.equal(movement[1][0], 'move')
  assert.ok(movement[1][1][2] <= -12, '退离最初警戒半径后仍需继续拉开一整段距离')
  foes = []
  delete state.nearest_hostile
  await a.refresh()
  assert.equal(await a.safety(), true)
  time += 2400
  assert.equal(await a.safety(), true)
  time += 200
  assert.equal(await a.safety(), false)
  assert.equal(a.retreating, false)
})

test('从已有工作台续跑时，新入口只通过 HTTP 完成木镐并拾回工作台', async (t) => {
  const { runSurvival } = require('../agent/nmo-survival')
  const http = require('node:http')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nmo-http-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const stop = new AbortController(),
    trace = []
  const bag = new Map([
    ['oak_log', 12],
    ['crafting_table', 1],
    ['wooden_axe', 1],
  ])
  const delta = (name, n) => bag.set(name, (bag.get(name) || 0) + n)
  let table = false
  const server = http.createServer(async (req, res) => {
    const path = req.url.replace('/api/v1/', ''),
      chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}
    trace.push(path)
    let result
    assert.equal(req.headers.authorization, 'Bearer local-test-token')
    if (path === 'status')
      result = {
        ready: true,
        alive: true,
        username: 'Sim',
        dimension: 'overworld',
        gamemode: 'survival',
        pos: [0, 64, 0],
        food: 20,
        health: 20,
        time_of_day: 3000,
      }
    else if (path === 'inventory')
      result = {
        items: [...bag]
          .filter(([, count]) => count > 0)
          .map(([name, count], slot) => ({ name, count, slot: 36 + slot })),
        armor: {},
      }
    else if (path === 'craft') {
      if (body.item === 'oak_planks') {
        delta('oak_log', -1)
        delta('oak_planks', 4)
      } else if (body.item === 'stick') {
        delta('oak_planks', -2)
        delta('stick', 4)
      } else if (body.item === 'wooden_pickaxe') {
        assert.ok(table)
        delta('oak_planks', -3)
        delta('stick', -2)
        delta(body.item, 1)
      } else if (body.item === 'wooden_sword') {
        assert.ok(table)
        delta('oak_planks', -2)
        delta('stick', -1)
        delta(body.item, 1)
      } else assert.fail(body.item)
      result = {}
    } else if (path === 'place') {
      table = true
      delta('crafting_table', -1)
      result = { placed: 'crafting_table', pos: [2, 64, 0] }
    } else if (path === 'get_block') result = { name: table ? 'crafting_table' : 'air', pos: body.pos }
    else if (path === 'dig') {
      assert.ok(table)
      table = false
      delta('crafting_table', 1)
      stop.abort()
      result = {}
    } else assert.fail(path)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  await runSurvival(
    {
      MC_AGENT_API_URL: 'http://127.0.0.1:' + server.address().port + '/api/v1',
      MC_AGENT_TOKEN: 'local-test-token',
      MC_NMO_STATE_PATH: path.join(dir, 'state.json'),
    },
    { signal: stop.signal, log: () => {}, sleep: async () => {} },
  )
  assert.equal(bag.get('wooden_pickaxe'), 1)
  assert.equal(bag.get('crafting_table'), 1)
  assert.ok(trace.includes('craft'))
  assert.ok(!trace.includes('auth/logout'))
})

test('AIA 选择会改变实际 NMO 挖掘目标，单次预算不会产生第二次推理', async () => {
  const { createNmoPlanner } = require('../agent/nmo-planner')
  const state = { ready: true, gamemode: 'survival', health: 20, food: 20, pos: [0, 68, 0] }
  const blocks = [
    [2, 68, 0],
    [3, 68, 0],
    [4, 68, 0],
  ].map((pos) => ({ name: 'oak_log', pos }))
  const digs = [],
    notes = []
  let requests = 0,
    elapsed = 0
  const choose = createNmoPlanner(
    { LLM_API_KEY: 'mock-credential', LLM_MODEL: 'mock-model', LLM_MAX_CALLS: '1' },
    {
      now: () => elapsed,
      log: (line) => notes.push(line),
      request: async (url, opts) => {
        requests++
        assert.equal(url, 'https://api.nju-aia.com/v1/chat/completions')
        assert.equal(opts.redirect, 'error')
        assert.equal(opts.headers.Authorization, 'Bearer mock-credential')
        const observation = JSON.parse(JSON.parse(opts.body).messages[1].content)
        assert.equal(observation.objective, 'wood')
        assert.deepEqual(observation.options[1].pos, blocks[1].pos)
        return Response.json({
          choices: [{ message: { content: '{"choice":1}' } }],
          usage: { total_tokens: 47 },
        })
      },
    },
  )
  const api = {
    async call(name, body) {
      if (name === 'status') return state
      if (name === 'inventory') return { items: [{name:'oak_log',count:digs.length}], armor: {} }
      if (name === 'find_blocks') return { blocks }
      if (name === 'get_block') return { name: 'oak_log' }
      if (name === 'dig') {
        digs.push(body.pos)
        return { gained: { oak_log: 1 } }
      }
      assert.fail(name)
    },
  }
  const a = actions(
    api,
    {},
    () => {},
    (line) => notes.push(line),
    choose,
  )
  await a.refresh()
  await a.gather('wood')
  elapsed += 60000
  await a.gather('wood')
  assert.deepEqual(digs, [blocks[1].pos, blocks[0].pos])
  assert.equal(requests, 1)
  assert.ok(notes.some((line) => line.includes('47')))
  assert.ok(notes.every((line) => !line.includes('mock-credential')))
})

test('采附近原木时用短程拾取，并以背包实际增加为准', async () => {
  const logPos = [1,64,0]
  const start = {pos:[0.5,64,0.5],health:20,food:20,ready:true,alive:true,dimension:'overworld'}
  const dropped = {id:19,item:'spruce_logx1',pos:[1.5,64,0.5]}
  let dug = false
  let logs = 0
  const calls = []
  const api = {
    async call(name,body) {
      if (name === 'status') return start
      if (name === 'inventory') return {items:[{name:'spruce_log',count:logs}]}
      if (name === 'find_blocks') return {blocks:[{name:'spruce_log',pos:logPos}]}
      if (name === 'get_block') return {
        name:!dug && body.pos.join(',') === logPos.join(',') ? 'spruce_log' : body.pos[1]<64 ? 'stone' : 'air',
      }
      if (name === 'get_entities') return {entities:body.types.includes('item') && dug && logs===0 ? [dropped] : []}
      calls.push([name,body])
      if (name === 'dig') {
        dug = true
        return {gained:{}}
      }
      if (name === 'move_to') {
        logs++
        start.pos = dropped.pos
        return {pos:start.pos}
      }
      assert.fail(name)
    }
  }
  const a = actions(api,{},() => {},() => {})
  await a.refresh()
  assert.equal(await a.gather('wood'),true)
  assert.equal(calls[0][1].collect,false)
  assert.equal(calls[1][1].entity_id,dropped.id)
  assert.equal(calls[1][1].timeout,1500)
  assert.equal(a.count('spruce_log'),1)
})

test('AIA 拒绝越界选择，HTTP 鉴权失败时不把响应正文写入日志', async () => {
  const { createNmoPlanner } = require('../agent/nmo-planner')
  const obs = { options: [{}, {}] },
    model = { LLM_API_KEY: 'mock-credential', LLM_MODEL: 'mock-model' }
  assert.equal(createNmoPlanner({}), null)
  assert.throws(() => createNmoPlanner({ ...model, LLM_BASE_URL: 'https://invalid.example/v1' }), /官方/)
  for (const reply of [
    Response.json({ choices: [{ message: { content: '{"choice":99}' } }] }),
    new Response('private-provider-details', { status: 403 }),
  ]) {
    const lines = []
    const choose = createNmoPlanner(model, { log: (s) => lines.push(s), request: async () => reply })
    assert.equal(await choose(obs), null)
    assert.ok(lines[0].includes('继续本地流程'))
    assert.ok(!lines[0].includes('private-provider-details'))
  }
})

test('体积扫描在小预算下完整续扫，发现六面封闭的矿物', async()=>{
  const {createOreSurvey}=require('../agent/nmo-ore-survey')
  const seen=new Set(), located=[]
  const scan=createOreSurvey([2,14.8,-3],['diamond_ore'],{radius:2,minY:13,maxY:15})
  const expected=[3,14,-3]
  let complete=false
  while(!complete) {
    const result=await scan(async pos=>{
      const key=pos.join(',')
      assert(!seen.has(key))
      seen.add(key)
      return {name:key===expected.join(',')?'diamond_ore':'stone',pos}
    },{budget:4})
    assert(result.reads<=4)
    complete=result.done
    located.push(...result.found)
  }
  assert.deepEqual(located,[{name:'diamond_ore',pos:expected}])
  const count=[-2,-1,0,1,2].flatMap(x=>[-1,0,1].flatMap(y=>[-2,-1,0,1,2].filter(z=>x*x+y*y+z*z<=4))).length
  assert.equal(seen.size,count)
})
test('赛事移动回执与服务器实际坐标不符时不宣告到达',async()=>{
  const {createMovement}=require('../agent/nmo-movement')
  const move=createMovement(async(name)=>{
    if(name==='status')return {pos:[0.5,64,0.5],ready:true,alive:true,health:20,dimension:'overworld',on_ground:false}
    if(name==='move_to')return {pos:[8.5,64,.5]}
    assert.fail(name)
  })
  await assert.rejects(move([8,64,0],0),{code:'path_not_found'})
})

test('先用已有粗金做金靴，核实已穿着后才走进下界门', async () => {
  const portal=[0,64,0], stock={raw_gold:4}, operations=[]
  const m={anchor:portal,nether:{portal,entry:[8,58,15],table:[5,64,0],enchanted:true,
    bedVerified:true,bedDoorClosed:true,ruinedPortal:{obtained:true}}}
  const a={
    status:{dimension:'overworld',health:20}, here:()=>portal,
    inventory:{armor:{feet:{name:'diamond_boots'}},items:[{name:'birch_planks',count:1}]},
    count:name=>stock[name] || 0, tool:()=> 'diamond_pickaxe', sum:()=>8, has:()=>true,
    block:async pos=>({name:pos.join(',')===portal.join(',')?'nether_portal':'obsidian'}),
    takeStored:async()=>false,
    gather:async (kind,options)=>{
      assert.equal(kind,'coal')
      assert.deepEqual(options,{nearby:true})
      operations.push(['gather',kind])
      stock.coal=1
      return true
    },
    smelt:async (...args)=>{operations.push(args);stock.gold_ingot=4},
    station:async()=>true,
    craft:async item=>{operations.push(item);stock[item]=1},
    equip:async (item,slot)=>{operations.push([item,slot]);a.inventory.armor[slot]={name:item}},
    refresh:async()=>{},
    move:async pos=>{assert.deepEqual(pos,portal);throw Error('已尝试走进门')},
  }
  const step=()=>expeditionStep(a,m,()=>{},{env:{},log(){}})
  assert.equal(await step(),'为整批粗金备足燃料')
  assert.equal(await step(),'熔炼制作金靴所需的金锭')
  assert.equal(await step(),'制作下界用金靴')
  assert.equal(await step(),'穿上并核实下界用金靴')
  assert.equal(m.nether.goldBootsForNether,true)
  await assert.rejects(step,/已尝试走进门/)
  assert.deepEqual(operations,[['gather','coal'],['raw_gold','coal',4],'golden_boots',['golden_boots','feet']])
})
