const { setTimeout: sleep } = require('node:timers/promises')
const { createStructureStore } = require('./structure-survey')
const { AIR, FOOD, add, dist, recoverable } = require('./nmo-actions')
const { brewAtBase } = require('./nmo-brew')
const { ruinedPortalStep } = require('./nmo-ruined-portal')
const { lightBase, crossHutDoor } = require('./nmo-base-lighting')
const { climbBackForSupplies } = require('./nmo-base')
const { clearSight } = require('./nmo-defense')

const sides = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const armor = /^diamond_|^netherite_/
const dry = /^(?:obsidian|dirt|grass_block|dirt_path|stone|cobblestone|cobbled_deepslate|deepslate|andesite|diorite|granite|calcite|tuff|sandstone|netherrack|blackstone|basalt|nether_brick.*|soul_soil)$/
const portalFrame = [[0,-1,0],[1,-1,0],[-1,0,0],[2,0,0],[-1,1,0],[2,1,0],
  [-1,2,0],[2,2,0],[0,3,0],[1,3,0]]
const scaffold = [[-1,-1,0],[2,-1,0],[-1,3,0]]
const portalParts = [
  ...scaffold.slice(0,2).map(offset => ({offset,support:true})),
  ...portalFrame.slice(0,-2).map(offset => ({offset})),
  {offset:scaffold[2],support:true},
  ...portalFrame.slice(-2).map(offset => ({offset})),
]
const solidSupports = ['cobblestone','cobbled_deepslate','dirt']
const plants = /^(?:short_grass|tall_grass|fern|large_fern|dandelion|poppy|cornflower|oxeye_daisy|snow)$/
const nextCall = new WeakMap()
const attempted = new WeakMap()
const lavaSearches = new WeakMap()
const TRIAL_ADVANCEMENT = 'adventure/minecraft_trials_edition'
const trialFloor = /^(?:(?:polished_|chiseled_)?tuff(?:_bricks)?|(?:(?:waxed|exposed|weathered|oxidized)_)*copper_grate)$/

async function safeStand(a, p) {
  const [floor, feet, head] = await Promise.all([a.block(add(p,[0,-1,0])),a.block(p),a.block(add(p,[0,1,0]))])
  return dry.test(floor.name) && AIR.has(feet.name) && AIR.has(head.name)
}
async function collect(a, names, radius = 48, pick = null) {
  const target = (await a.find(names, radius, 16)).find(point => (a.status.nearest_hostile?.dist ?? Infinity) >= 8 && point.dist <= radius)
  if (!target) return a.explore()
  if (pick) await a.equip(pick)
  return a.call('dig', {pos:target.pos,collect:true,stop_on:['hurt','death']})
}
async function craft(a, item, count = 1) {
  if (await a.station('crafting_table')) await a.craft(item, count)
}
async function prepareNetherBoots(a,m,save,log) {
  if (a.inventory.armor?.feet?.name==='golden_boots') {
    if (!m.nether.goldBootsForNether) {
      m.nether.goldBootsForNether=true
      save()
      log('出发前已核实穿上金靴')
    }
    return null
  }
  if (a.count('golden_boots') || await a.takeStored?.('golden_boots',1)) {
    await a.equip('golden_boots','feet')
    await a.refresh()
    if (a.inventory.armor?.feet?.name==='golden_boots') {
      m.nether.goldBootsForNether=true
      save()
      log('出发前已核实穿上金靴')
    }
    return '穿上并核实下界用金靴'
  }
  if (a.count('gold_ingot')<4) await a.takeStored?.('gold_ingot',4)
  const missing=4-a.count('gold_ingot')
  if (missing<=0) {
    await craft(a,'golden_boots')
    return '制作下界用金靴'
  }
  const fromNuggets=Math.min(missing,Math.floor(a.count('gold_nugget')/9))
  if (fromNuggets) {
    await craft(a,'gold_ingot',fromNuggets)
    return '把已有金粒合成金锭'
  }
  if (a.count('raw_gold')<missing) await a.takeStored?.('raw_gold',missing)
  if (a.count('raw_gold')<missing) {
    await a.gather('gold',{recoverDrops:true})
    return '为下界金靴采集金矿'
  }
  if (a.here()[1]<m.anchor[1]-3) {
    await climbBackForSupplies(a,m,save,log)
    return '带粗金沿矿道返回地面'
  }
  const coal=a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : null
  const planks=a.inventory.items.filter(item=>item.name.endsWith('_planks'))
    .sort((x,y)=>y.count-x.count)
  const woodNeeded=Math.ceil(missing*2/3)
  if (!coal && planks.reduce((total,item)=>total+item.count,0)<woodNeeded) {
    if (!await a.takeStored?.('coal',1) && !await a.gather('coal',{nearby:true})) {
      const ceiling=await Promise.all([2,3,4,5].map(y=>a.block(add(a.here(),[0,y,0]))))
      if (ceiling.some(block=>dry.test(block.name))) {
        await climbBackForSupplies(a,m,save,log)
        return '沿矿道继续上地面取燃料'
      }
      await a.ensurePlanks(woodNeeded)
    }
    return '为整批粗金备足燃料'
  }
  const units=coal ? missing : Math.min(missing,Math.floor(planks[0].count*1.5))
  await a.smelt('raw_gold',coal || planks[0].name,units)
  return '熔炼制作金靴所需的金锭'
}

async function fillBucket(a, log) {
  const origin = a.here()
  for (const { pos } of await a.find(['water'],48,12)) {
    const source = await a.block(pos)
    if (source.name !== 'water' || Number(source.properties?.level) !== 0) continue
    const aim = add(pos, [0.5,0.85,0.5])
    const stands = [origin, ...sides.flatMap(side =>
      [1,0,2].map(y => add(add(pos,side), [0,y,0])))]
    for (const stand of stands) {
      try {
        if (!await safeStand(a,stand)) continue
        const plannedEye = add(stand,[0.5,1.62,0.5])
        if (dist(plannedEye,aim)>4.5 || !await clearSight(a.call,plannedEye,aim)) continue
        if (dist(a.here(),stand)>0.5) {
          await a.move(stand,0)
          await a.refresh()
        }
        const eye = add(a.status.pos,[0,1.62,0])
        if (dist(eye,aim)>4.5 || !await clearSight(a.call,eye,aim)) continue
        await a.call('interact',{item:'bucket',pos})
        await a.refresh()
        if (a.count('water_bucket')) {
          log('从无遮挡的岸边取水，已核验背包中的水桶 '+pos.join(','))
          return
        }
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
    }
  }
  return a.explore()
}
async function convertObsidian(a, m, save, log) {
  if (m.nether.waterPlaced) {
    const job = m.nether.waterPlaced
    const p = job.pos || job
    if (job.lava && (await a.block(job.lava)).name==='lava' && Date.now() - job.started < 4500) return
    if ((await a.block(p)).name === 'water') await a.call('interact',{item:'bucket',pos:p})
    await a.refresh()
    if (!a.count('water_bucket') && (await a.block(p)).name === 'water') return
    if (job.lava && (await a.block(job.lava)).name==='lava') {
      const tried = m.nether.waterTried ??= {}
      tried[job.lava.join(',') + '/' + p.join(',')] = Date.now() + 30000
      for (const [key,expiry] of Object.entries(tried)) if (expiry < Date.now()) delete tried[key]
    }
    delete m.nether.waterPlaced
    save()
    return
  }
  const natural = await a.find(['obsidian'],64,16)
  for (const point of natural) {
    const neighbors = await Promise.all([...sides,[0,1,0],[0,-1,0]].map(d => a.block(add(point.pos,d))))
    if (neighbors.some(b => /^lava$|fire|magma/.test(b.name))) continue
    for (const side of sides) {
      const stand = add(point.pos,side)
      if (!await safeStand(a,stand)) continue
      try {
        await a.move(stand,0)
        await a.equip(a.tool('pickaxe'))
        const before = a.count('obsidian')
        const result = await a.call('dig',{pos:point.pos,collect:true,timeout:20000,stop_on:['hurt','death']})
        await a.refresh()
        if (a.count('obsidian') === before && !result.interrupted_by)
          await a.recoverValuableDrops({target:point.pos,names:['obsidian']})
        return
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
    }
  }
  if (!a.count('water_bucket')) {
    if (!a.count('bucket')) {
      const ironNeeded = 3 - a.count('iron_ingot')
      let rawIron = a.count('raw_iron')
      if (ironNeeded > rawIron && m.furnaceLoaded && m.furnace && dist(a.here(), m.furnace) <= 4 &&
          (await a.block(m.furnace)).name === 'furnace') {
        const { sections } = await a.call('window/view', { target: { pos: m.furnace } })
        rawIron += sections.input.filter(item => item.name === 'raw_iron').reduce((n, item) => n + item.count, 0)
        rawIron += sections.output.filter(item => item.name === 'iron_ingot').reduce((n, item) => n + item.count, 0)
      }
      if (ironNeeded > rawIron) return a.gather('iron')
      if (a.here()[1] < m.anchor[1] - 3) return climbBackForSupplies(a, m, save, log)
      if (ironNeeded > 0) {
        const coal = a.count('coal') ? 'coal' : a.count('charcoal') ? 'charcoal' : null
        if (coal) return a.smelt('raw_iron', coal, ironNeeded)
        if (!await a.ensurePlanks(1)) return
        const plank = a.inventory.items.find(item => item.name.endsWith('_planks'))
        if (plank) return a.smelt('raw_iron', plank.name, ironNeeded)
        return
      }
      return craft(a,'bucket')
    }
    return fillBucket(a, log)
  }
  const search = lavaSearches.get(m) ?? { failed: new Map(), searches: 0 }
  lavaSearches.set(m, search)
  const now = Date.now()
  for (const [key, until] of search.failed) if (until <= now) search.failed.delete(key)
  let tries = 0
  for (const lava of await a.find(['lava'],128,36,{ properties: { level: 0 } })) {
    if (Number((await a.block(lava.pos)).properties?.level)!==0) continue
    for (const direction of sides) {
      const support=add(lava.pos,direction), water=add(support,[0,1,0]), stand=add(water,direction)
      if (m.nether.waterTried?.[lava.pos.join(',') + '/' + water.join(',')] > Date.now()) continue
      const key = stand.join(',')
      if (search.failed.has(key) || !dry.test((await a.block(support)).name) ||
          !AIR.has((await a.block(water)).name) || !await safeStand(a,stand)) continue
      if (++tries > 3) return
      try {
        await a.move(stand,0)
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
        search.failed.set(key, Date.now() + 90000)
        continue
      }
      const result = await a.call('interact',{item:'water_bucket',pos:water})
      if ((await a.block(water)).name==='water') {
        search.searches = 0
        m.nether.waterPlaced={pos:water,lava:lava.pos,started:Date.now()}; save(); return
      }
      await a.refresh()
      if (!a.count('water_bucket')) {
        if (Array.isArray(result.target) && (await a.block(result.target)).name === 'water') {
          search.searches = 0
          m.nether.waterPlaced={pos:result.target,lava:lava.pos,started:Date.now()}; save(); return
        }
        throw Error('放水后未确认水源格，暂停黑曜石处理')
      }
      search.failed.set(key, Date.now() + 90000)
    }
  }
  search.searches++
  if (search.searches === 12) log('地表未找到可安全接近的岩浆口，分层探矿复查')
  if (search.searches >= 12 && a.here()[1] > 32) return a.stair(32)
  return a.explore()
}
async function portalSite(a, anchor) {
  for(const [x,z] of [[8,0],[0,8],[-8,0],[0,-8],[10,5],[-10,-5],[-10,5],[10,-5],[12,0],[-12,0]]) {
    for (const y of [1,0,-1,2,3,-2]) {
      const p=add(anchor,[x,y,z])
      const floors=await Promise.all([-1,0,1,2].map(x=>a.block(add(p,[x,-2,0]))))
      if (!floors.every(b=>dry.test(b.name))) continue
      const blocks=await Promise.all([...portalFrame,...scaffold,[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,2,0],[1,2,0]]
        .map(d=>a.block(add(p,d))))
      if (blocks.every(b=>AIR.has(b.name)||plants.test(b.name))) return p
    }
  }
  return null
}

async function siteForTable(a, anchor) {
  for (const [x,z] of [[3,-2],[3,2],[-3,-2],[-3,2],[0,4],[0,-4],[5,0],[-5,0]]) {
    for (const y of [0,1,-1,2,-2]) {
      const p=add(anchor,[x,y,z])
      const [floor,feet,head]=await Promise.all([a.block(add(p,[0,-1,0])),a.block(p),a.block(add(p,[0,1,0]))])
      if (dry.test(floor.name) && (AIR.has(feet.name)||plants.test(feet.name)) && AIR.has(head.name))
        return {p,clear:plants.test(feet.name)}
    }
  }
  return null
}
async function setHutSpawn(a, m, save, log) {
  const n = m.nether
  if (a.status.is_sleeping) return '在小屋床上等天亮'
  const center = m.hut.center
  const foot = add(center, [-1, 0, 0])
  const head = add(foot, [0, 0, -1])
  const entry = add(center, [0, 0, 2])
  const outside = add(center, [0, 0, 3])
  const interior = add(center, [0, 0, 1])
  const [bed, other] = await Promise.all([a.block(foot), a.block(head)])
  if (!bed.name.endsWith('_bed') || bed.name !== other.name || bed.properties?.part !== 'foot' ||
      other.properties?.part !== 'head') return '等待小屋床位校验'
  if (!n.bedVerified) {
    const door = await a.block(entry)
    if (door.name.endsWith('_door') && door.properties?.open === false) {
      if (dist(a.here(), outside) > 1 && dist(a.here(), interior) > 1) await a.move(outside, 0)
      await a.call('interact', { pos: entry })
    }
    if (!await crossHutDoor(a,entry,interior)) return '重新核对小屋门口站位'
    const before = await a.call('events', { since: 0, limit: 500 })
    const receipt = await a.call('interact', { pos: head })
    const { events } = await a.call('events', { since: before.last_seq, limit: 30 })
    const spawnEvent = events.some(e => e.type === 'chat' &&
      /respawn point set|spawn point set|重生点已设置|已设置重生点|重生点已设定/i.test(e.text))
    if (!spawnEvent && !receipt.slept) return '等待服务器确认床的重生点'
    n.bed = head
    n.bedVerified = true
    save()
    log('已由床交互确认重生点 ' + head.join(','))
    if (receipt.slept) return '小屋重生点已设置，睡到天亮'
  }
  const door = await a.block(entry)
  if (door.name.endsWith('_door') && door.properties?.open) {
    if (!await crossHutDoor(a,entry,outside)) return '从小屋门口离开'
    await a.call('interact', { pos: entry })
    if ((await a.block(entry)).properties?.open) return '重试关好小屋门'
  }
  n.bedDoorClosed = door.name.endsWith('_door')
  save()
  return '小屋重生点已设置'
}

async function overworld(a,m,save,context) {
  const n=m.nether
  if ((!n.bedVerified || !n.bedDoorClosed) && m.hut?.center) return setHutSpawn(a,m,save,context.log)
  if (n.completed) return await trialChamberStep(a,m,save,context) || '全程验收完成'
  if (n.entry && n.returning) {
    if (dist(a.here(),m.anchor)>8) { await a.move(m.anchor,3); return '回到补给站' }
    if (a.count('ancient_debris') && !n.storedDebris) {
      const chests=await a.find(['barrel','chest'],12,12)
      const box=chests.find(b=>dist(b.pos,m.anchor)<8)
      if (box) {
        await a.call('window/act',{target:{pos:box.pos},ops:[{op:'put',to:'container',item:'ancient_debris',count:1}]})
        n.storedDebris=true; save()
        return '存放远古残骸'
      }
    }
    if ((a.count('blaze_rod') || a.count('blaze_powder')) && a.count('nether_wart')) {
      const result=await brewAtBase(a,{base:m.anchor,brewingStand:n.brewingStand ?? add(m.anchor,[3,0,2])},()=>{})
      if(result.ok) {n.completed=true;save();return '基地酿造和返程已确认'}
      return '检查酿造材料'
    }
    if (a.sum(name=>FOOD.test(name))<8) { await a.food(); return '返程后补给食物' }
    if (a.status.health<17 || (a.status.nearest_hostile?.dist ?? Infinity)<8) return '在基地休整'
    if(n.restUntil && Date.now()<n.restUntil) return '在基地复盘并等待下一次出发'
    n.returning=false; save()
  }
  if (m.hut?.complete && !n.entry) {
    const light = await lightBase(a,m,save,context.log)
    if (light) return light
  }
  if (!n.table) {
    if (!a.count('enchanting_table')) {
      if (a.count('obsidian')<4) { await convertObsidian(a,m,save,context.log);return '采集附魔台黑曜石' }
      if (a.count('diamond')<2 && !await a.takeStored('diamond',2)) { await a.gather('diamond');return '补充附魔台钻石' }
      if (!a.count('book')) {
        if(!a.count('leather')) {await a.food({leather:true});return '为书本获取皮革'}
        if(a.count('paper')<3) {
          if(a.count('sugar_cane')<3) {await collect(a,['sugar_cane']);return '收集甘蔗制纸'}
          await craft(a,'paper',3);return '制作纸张'
        }
        await craft(a,'book');return '制作书本'
      }
      await craft(a,'enchanting_table')
      return '制作附魔台'
    }
    if (dist(a.here(),m.anchor)>12) {await a.move(m.anchor,3);return '携带附魔台回基地'}
    const site = await siteForTable(a,m.anchor)
    if(!site) return '检查基地附近附魔台站位'
    if (site.clear) await a.call('dig',{pos:site.p,collect:false,stop_on:['hurt','death']})
    await a.placeAt('enchanting_table',site.p)
    if((await a.block(site.p)).name==='enchanting_table') {
      n.table=site.p;save();context.log('已核验基地附魔台 '+site.p.join(','))
    }
    return '摆放并核验附魔台'
  }
  if (!n.portal) {
    if(a.count('obsidian')<10) {await convertObsidian(a,m,save,context.log);return '为下界门采集黑曜石'}
    const site=await portalSite(a,m.anchor)
    if(!site) {await a.explore();return '寻找下界门的干燥站位'}
    n.portal=site;save()
  }
  for(const part of portalParts) {
    const p=add(n.portal,part.offset), block=await a.block(p)
    if (part.support ? solidSupports.includes(block.name) || block.name==='obsidian' : block.name==='obsidian') continue
    if (plants.test(block.name)) {
      await a.call('dig',{pos:p,collect:false,stop_on:['hurt','death']})
      return '清理下界门施工格'
    }
    if (!AIR.has(block.name)) throw Object.assign(Error('门框位置受阻 '+p),{code:'place_failed'})
    const item=part.support?solidSupports.find(name=>a.count(name)):'obsidian'
    if (!item) {await a.gather('cobble');return '补足下界门角部支撑'}
    if (!a.count(item)) {await convertObsidian(a,m,save,context.log);return '补足下界门框'}
    await a.placeAt(item,p);return '逐块搭建下界门'
  }
  if ((await a.block(n.portal)).name!=='nether_portal') {
    if (!a.count('flint_and_steel')) {
      if (!a.count('flint')) {await collect(a,['gravel'],40,a.tool('shovel'));return '从砂砾获取燧石'}
      if (!a.count('iron_ingot') && !await a.takeStored('iron_ingot',1)) {await a.gather('iron');return '补充打火石所需铁锭'}
      await craft(a,'flint_and_steel');return '制作打火石'
    }
    await a.call('interact',{item:'flint_and_steel',pos:add(n.portal,[0,-1,0])})
    return '点亮下界门'
  }
  if (!n.portalVerified) {
    n.portalVerified = true
    save()
    context.log('已核验点亮的下界门 ' + n.portal.join(','))
  }
  if (!n.enchanted && a.status.xp_level>0 && a.count('diamond_sword') && a.count('lapis_lazuli')) {
    const target={pos:n.table}
    const sword=a.inventory.items.find(i=>i.name==='diamond_sword' && i.enchantments?.length)
    if(!sword) await a.call('window/act',{target,ops:[
      {op:'put',item:'diamond_sword',to:'item'},{op:'put',item:'lapis_lazuli',count:1,to:'lapis'},
      {op:'select',option:0},{op:'take',from:'item'}]})
    await a.refresh()
    if(a.inventory.items.some(i=>i.name==='diamond_sword' && i.enchantments?.length)) {n.enchanted=true;save()}
    return '普通附魔并核验钻石剑'
  }
  if (!/^(diamond|netherite)_pickaxe$/.test(a.tool('pickaxe')||'')) {
    if(a.count('diamond')<3 && !await a.takeStored('diamond',3)){await a.gather('diamond');return '备齐下界用钻镐'}
    if(await a.ensureSticks(2))await craft(a,'diamond_pickaxe')
    return '制作下界探矿用钻镐'
  }
  if (a.sum(name=>FOOD.test(name))<8) {await a.food({stock:8});return '进下界前补充食物'}
  if(a.status.health<16) {
    if(a.status.food<19) await a.food()
    return '基地恢复生命后进入下界'
  }
  const portalWork = await ruinedPortalStep(a,n,save,context,plan)
  if (portalWork) return portalWork
  const goldBoots=await prepareNetherBoots(a,m,save,context.log)
  if (goldBoots) return goldBoots
  await a.move(n.portal,0)
  await sleep(4200)
  return '通过下界门'
}

async function trialChamberStep(a,m,save,context) {
  const n = m.nether
  if (n.trialReturning) {
    if (dist(a.here(),m.anchor) > 5) {
      await a.move(m.anchor,4)
      return '试炼密室侦察后返回基地'
    }
    delete n.trialReturning
    save()
    return '试炼密室侦察已返回基地'
  }
  if (n.trialAchievement || !context.env.LLM_API_KEY || !m.anchor) return null
  const safe = a.status.health >= 17 && a.status.food >= 16 &&
    (a.status.nearest_hostile?.dist ?? Infinity) > 10 && a.sum(name => FOOD.test(name)) >= 8 &&
    a.inventory.offhand?.name === 'shield' &&
    Object.values(a.inventory.armor || {}).filter(item => armor.test(item?.name || '')).length >= 3
  if (!safe && !n.trialChamber) return null
  if (!safe) {
    n.trialReturning = true
    delete n.trialChamber
    save()
    return '试炼密室途中补给不足，返回基地'
  }
  let target = n.trialChamber
  if (!target) {
    if (Date.now() < (n.trialRetryAt || 0)) return null
    const world = context.env.MC_NMO_STRUCTURE_WORLD || context.env.MC_NMO_WORLD
    const sites = createStructureStore().list().filter(site => site.world === world &&
      site.type === 'trial_chambers' && dist(site.pos,m.anchor) <= 320 &&
      (n.trialSitesUnavailable?.[site.pos.join(',')] || 0) <= Date.now())
      .sort((x,y) => dist(x.pos,m.anchor) - dist(y.pos,m.anchor)).slice(0,3)
    if (!sites.length) return null
    const options = sites.map(site => ({kind:'visit',label:'探访试炼密室解锁成就',pos:site.pos,
      evidence:site.evidence,distance:Math.round(dist(site.pos,a.here()))}))
    options.push({kind:'wait',label:'暂缓探访，留在基地'})
    const selected = await plan(a,n,context,options,'主世界后期成就')
    if (!selected || selected.kind === 'wait') {
      n.trialRetryAt = Date.now() + 60000
      save()
      return null
    }
    target = n.trialChamber = selected
    save()
  }
  const completed = await a.call('advancements', {status:'completed',include_recipes:false,ids:['minecraft:'+TRIAL_ADVANCEMENT]})
  if (completed.advancements.some(item => item.id.replace(/^minecraft:/,'') === TRIAL_ADVANCEMENT)) {
    n.trialAchievement = true
    n.trialReturning = true
    delete n.trialChamber
    save()
    context.log('赛事接口已核验试炼密室成就')
    return '已获得试炼密室成就，返回基地'
  }
  try {
    if (dist(a.here(),target.pos) > 9) {
      await a.move(target.pos,8)
      return '沿安全进路接近试炼密室'
    }
    const markers = (await a.find(['trial_spawner','tuff_bricks','chiseled_tuff_bricks'],12,12))
      .filter(block => dist(block.pos,target.pos) < 20)
    const visited = target.visited ??= []
    for (const marker of markers) for (const offset of [[0,1,0], ...sides]) {
      const stand = add(marker.pos,offset)
      if (dist(a.here(),stand) < 2 || visited.includes(stand.join(','))) continue
      const [floor, feet, head] = await Promise.all([a.block(add(stand,[0,-1,0])),a.block(stand),a.block(add(stand,[0,1,0]))])
      if (!(dry.test(floor.name) || trialFloor.test(floor.name)) || !AIR.has(feet.name) || !AIR.has(head.name)) continue
      await a.move(stand,1)
      visited.push(stand.join(','))
      save()
      return '进入已核实的试炼密室站位'
    }
  } catch (error) {
    if (!recoverable.has(error.code)) throw error
    if (error.code === 'movement_interrupted') return '试炼密室进路中断，检查周围危险'
  }
  n.trialRetryAt = Date.now() + 180000
  const unavailable = n.trialSitesUnavailable ??= {}
  unavailable[target.pos.join(',')] = Date.now() + 15 * 60000
  n.trialReturning = true
  delete n.trialChamber
  save()
  return '试炼密室未找到可达站位，返回基地'
}

async function plan(a,n,context,options,objective='下界探索') {
  const {env,signal,observeModel,log}=context
  const next=nextCall.get(n)||0
  if(Date.now()<next || !options.length) return null
  nextCall.set(n,Date.now()+30000)
  if(!env.LLM_API_KEY) throw Error('动态规划缺少 AIA 配置')
  try {
    const observation={objective,position:a.status.pos,health:a.status.health,food:a.status.food,inventory:a.inventory.items.map(i=>[i.name,i.count]),
      equipped:a.inventory.armor,nearestHostile:a.status.nearest_hostile,portal:n.entry,confirmedAchievements:n.achievements,
      previous:n.lastDecision,options}
    const time=AbortSignal.timeout(15000)
    const response=await fetch('https://api.nju-aia.com/v1/chat/completions',{
      method:'POST',redirect:'error',signal:signal?AbortSignal.any([signal,time]):time,
      headers:{Authorization:'Bearer '+env.LLM_API_KEY,'Content-Type':'application/json'},
      body:JSON.stringify({model:env.LLM_MODEL,temperature:.1,max_tokens:280,stream:false,chat_template_kwargs:{enable_thinking:false},
        messages:[{role:'system',content:'你负责 Minecraft 生存任务规划。只从实测候选 options 选一个。根据生命、装备、补给、结构距离和退路选低风险的有效进度。输出 JSON {"choice":从0开始的索引,"steps":["短中文步骤","..."]}，最多三步，不自造坐标。'},
          {role:'user',content:JSON.stringify(observation)}]})})
    if(!response.ok) throw Error('HTTP '+response.status)
    const result=await response.json()
    observeModel({usage:result.usage})
    const text=result.choices?.[0]?.message?.content
    const picked=JSON.parse(String(text||'').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi,''))
    if(!Number.isInteger(picked.choice)||!options[picked.choice]||!Array.isArray(picked.steps))return null
    const choice=options[picked.choice], steps=picked.steps.filter(s=>typeof s==='string'&&s.trim()).slice(0,3).map(s=>s.slice(0,45))
    if(!steps.length)return null
    const resultPlan={...choice,steps}
    observeModel({objective:choice.label,option:choice,plan:steps.join(' → ')})
    log('AIA '+objective+'规划 '+JSON.stringify(resultPlan))
    return resultPlan
  }catch(error){
    signal?.throwIfAborted()
    log('AIA '+objective+'规划失败 '+(/^HTTP \d{3}$/.test(error.message)?error.message:error.name))
    return null
  }
}

async function nether(a,m,save,context) {
  const n=m.nether
  if(!n.entry) {n.entry=a.here();n.breadcrumbs=[n.entry];save(); context.log('实际进入下界 '+n.entry.join(','))}
  const p=a.here()
  if(!n.returning && dist(p,n.breadcrumbs.at(-1))>=5){n.breadcrumbs.push(p);save()}
  if(a.status.in_lava || a.status.on_fire || a.status.health<10) {n.returning=true;save()}
  if(n.returning) {
    if(dist(p,n.entry)>3) {
      if(n.breadcrumbs.length>1 && dist(p,n.breadcrumbs.at(-1))<4){n.breadcrumbs.pop();save()}
      await a.move(n.breadcrumbs.at(-1)||n.entry,2)
      return '沿安全返程点撤离下界'
    }
    const portal=(await a.find(['nether_portal'],16,8))[0]
    if(!portal)return '寻找已记录的返程门'
    await a.move(portal.pos,0);await sleep(4200);n.restUntil=Date.now()+30000;save()
    return '穿过下界门回基地'
  }
  if(!n.debris) {
    if(a.count('ancient_debris')>0) {
      n.debris=true;save();context.log('第一块远古残骸已入包')
    } else {
      if(a.hasReportedDebris?.()) await a.gather('debris')
      else if(p[1]>16) await a.stair(16)
      else if(!await a.gather('debris')) await a.explore()
      return '先采一块远古残骸'
    }
  }
  const gain=a.count('blaze_rod'), wart=a.count('nether_wart')
  const options=[{kind:'scout',label:'等待旁观者继续侦察'}]
  const structureWorld=context.env.MC_NMO_STRUCTURE_WORLD || context.env.MC_NMO_WORLD
  const structures=createStructureStore().list().filter(site=>site.world===structureWorld &&
    site.dimension==='the_nether' && ['fortress','bastion'].includes(site.type))
  const skip=attempted.get(n)||new Map()
  attempted.set(n,skip)
  const comfortable=a.status.health>=15 && a.status.food>=14 && a.sum(s=>FOOD.test(s))>=5 &&
    Object.values(a.inventory.armor||{}).filter(i=>armor.test(i?.name||'')).length>=3
  if(comfortable) for(const site of structures.sort((x,y)=>dist(x.pos,p)-dist(y.pos,p)).slice(0,5)){
    const key=site.type+':'+site.pos.join(',')
    if((skip.get(key)||0)>Date.now() || dist(site.pos,p)>380)continue
    options.push({kind:'visit',key,label:site.label,pos:site.pos,evidence:site.evidence,distance:Math.round(dist(site.pos,p))})
  }
  options.push({kind:'return',label:gain&&wart?'带材料回基地酿药':'返回基地补给'})
  const availableLoot = gain + ':' + wart
  if (n.loot !== availableLoot) {
    n.loot = availableLoot
    delete n.objective
    save()
  }
  let target=n.objective
  if(!target || target.kind==='scout') {
    const input=await plan(a,n,context,options)
    if(input){target=input;n.objective=input;n.lastDecision=input;save()}
  }
  if(!comfortable && target?.kind!=='scout'){n.returning=true;save();return '低补给，返程整备'}
  if(!target || target.kind==='scout')return '等待旁观者结构上报与模型规划'
  if(target.kind==='return'){n.returning=true;delete n.objective;save();return target.label}
  try {
    if(dist(p,target.pos)>12) {await a.move(target.pos,7);return '按模型计划接近'+target.label}
    const structures=target.key.startsWith('fortress:')?['nether_bricks','nether_brick_stairs']:['polished_blackstone_bricks','gilded_blackstone']
    const candidates=(await a.find(structures,16,12)).filter(b=>dist(b.pos,target.pos)<18)
    for(const block of candidates) {
      const stand=add(block.pos,[0,1,0])
      if(dist(stand,p)<2.5 || !await safeStand(a,stand))continue
      await a.move(stand,1)
      return '经实测站位进入'+target.label
    }
    if(target.key.startsWith('fortress:')){
      const crops=await a.find(['nether_wart'],28,12)
      if(!wart && crops.length && (a.status.nearest_hostile?.dist??Infinity)>8) {
        await a.call('dig',{pos:crops[0].pos,collect:true,stop_on:['hurt','death']})
        return '沿实际站位采集地狱疣'
      }
      const blaze=(await a.call('get_entities',{types:['blaze'],radius:20})).entities.find(e=>e.dist<12)
      if(blaze && gain<2 && comfortable) {
        const sword=a.tool('sword')
        if(sword)await a.equip(sword)
        await a.call('attack',{entity_id:blaze.id,weapon:sword,max_hits:2,timeout:4000,stop_on:['hurt','death']})
        return '分段迎击烈焰人'
      }
    }
    const obtained=await a.call('advancements',{status:'completed',include_recipes:false,ids:['nether/find_fortress','nether/find_bastion']})
    n.achievements=obtained.advancements.map(item=>item.id)
    await a.explore()
    skip.set(target.key,Date.now()+60000)
    delete n.objective;save()
    return '核验结构进度后重新规划'
  }catch(error){
    if(!recoverable.has(error.code))throw error
    skip.set(target.key,Date.now()+120000);delete n.objective;save()
    context.log('结构目标暂不可达，重新规划 '+target.label+' '+error.code)
    return '当前结构进路受阻，评估退路'
  }
}

async function step(a,m,save,context) {
  if(!m.nether){m.nether={};save()}
  return a.status.dimension==='the_nether'?nether(a,m,save,context):overworld(a,m,save,context)
}

module.exports={step,plan};
