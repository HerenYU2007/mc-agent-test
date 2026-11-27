const { AIR, add, dist, recoverable } = require('./nmo-actions')
const { LOG_NAMES } = require('./config')
const { clearSight } = require('./nmo-defense')
const MIN_SMELTING_FUEL = 4

const safeGround = /^(?:grass_block|dirt|dirt_path|coarse_dirt|podzol|stone|cobblestone|cobbled_deepslate|deepslate|andesite|diorite|granite|calcite|tuff|sandstone|obsidian|moss_block|snow_block|terracotta)$/
const replaceable = /^(?:short_grass|tall_grass|fern|large_fern|dandelion|poppy|cornflower|oxeye_daisy|snow)$/
const isTorch = name => name === 'torch' || name === 'wall_torch'
const directions = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]]
const siteDeltas = [[0, 0, 0], ...[1, 2, 3].flatMap(r => directions.map(d => d.map(v => v * r)))]

async function crossHutDoor(a, entry, target) {
  if (dist(a.here(),target) <= 0.5) return true
  try {
    await a.move(target,0)
    return true
  } catch (error) {
    if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
  }
  const door = await a.block(entry)
  if (!door.name.endsWith('_door') || !door.properties?.open) return false
  const start = a.status.pos
  if (Math.abs(start[0]-(target[0]+0.5))>0.48 || Math.abs(start[1]-target[1])>0.5 ||
      Math.abs(start[2]-(target[2]+0.5))>3.2) return false
  for (let attempt=0;attempt<5;attempt++) {
    const {pos,health}=a.status
    await a.call('look',{pos:[target[0]+0.5,target[1]+1.62,target[2]+0.5]})
    await a.call('control',{forward:true,ms:175,stop_on:['hurt','death']})
    await a.refresh()
    if (a.status.health<health || !a.status.on_ground) return false
    if (dist(a.here(),target)===0) return true
    if (dist(pos,a.status.pos)<0.05 && attempt>=2) return false
  }
  return false
}

async function torchSupply(a) {
  if (a.count('torch')) return true
  if (await a.takeStored?.('torch', 1)) return true
  if (a.count('coal') || a.count('charcoal')) {
    if (await a.ensureSticks(1)) await a.craft('torch', 4)
    return a.count('torch') > 0
  }
  const planks = a.inventory.items.find(stack => stack.name.endsWith('_planks'))
  const log = a.inventory.items.find(stack => LOG_NAMES.has(stack.name))
  if (log && planks) await a.smelt(log.name, planks.name, 1)
  else if (log?.count >= 2) await a.ensurePlanks(2)
  else await a.gather('wood')
  return false
}

async function lightTravel(a, m) {
  if (!a.status.on_ground || a.status.in_water || a.status.dimension !== 'overworld' || !a.tool('pickaxe')) return
  const p = a.here()
  if (m.anchor && dist(p,m.anchor)<70) return
  if (m.surface && p[1] >= m.surface[1]-5) return
  const feet = await a.block(p)
  if (feet.block_light >= 3 || feet.sky_light >= 7) return
  for (const torch of await a.find(['torch','wall_torch'],8,4)) {
    if (await clearSight(a.call,add(p,[0.5,0.5,0.5]),add(torch.pos,[0.5,0.5,0.5]))) return
  }
  if (!a.count('torch')) {
    if (a.count('coal') + a.count('charcoal') > MIN_SMELTING_FUEL &&
        await a.ensureSticks(1)) {
      await a.craft('torch')
      return '为矿道制作火把'
    }
    return
  }
  for (const direction of directions.slice(0,4)) {
    const target = add(p,direction)
    const [body, floor] = await Promise.all([a.block(target),a.block(add(target,[0,-1,0]))])
    if (!AIR.has(body.name) || !safeGround.test(floor.name)) continue
    try {
      await a.placeAt('torch',target)
      if (isTorch((await a.block(target)).name)) return '在昏暗矿道插火把'
    } catch (error) {
      if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
    }
  }
}

async function buildLight(a, zone, placed) {
  for (const delta of siteDeltas) {
    for (const y of [0, -1, 1, -2, 2, -3, 3]) {
      const p = add(add(zone, delta), [0, y, 0])
      try {
        const lower = await a.block(add(p, [0, -1, 0]))
        if (!safeGround.test(lower.name)) continue
        const existing = await a.block(p)
        if (isTorch(existing.name)) return { pos:p, torch:true }
        if ((!AIR.has(existing.name) && !replaceable.test(existing.name)) ||
            !AIR.has((await a.block(add(p, [0, 1, 0]))).name)) continue
        if (existing.block_light > 0) return { pos:p, torch:false }
        const nearby = placed.filter(torch => p.reduce((distance,coordinate,i) => distance + Math.abs(coordinate-torch[i]),0)<=6)
        for (const torch of nearby) {
          if (isTorch((await a.block(torch)).name) &&
              await clearSight(a.call,add(p,[0.5,0.5,0.5]),add(torch,[0.5,0.5,0.5]))) return { pos:p, torch:false }
        }
        if (!a.count('torch')) return { needsTorch:true }
        if (dist(a.here(), p) > 4) await a.move(p, 2)
        if (replaceable.test(existing.name)) await a.call('dig', { pos: p, collect: false, stop_on: ['hurt', 'death'] })
        await a.placeAt('torch', p)
        if (isTorch((await a.block(p)).name)) return { pos:p, torch:true }
      } catch (error) {
        if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
      }
    }
  }
  return null
}

function lightingZones(m) {
  const around = []
  for (let x=-64;x<=64;x+=8) for (let z=-64;z<=64;z+=8) {
    if (Math.hypot(x,z)<=64) around.push([x,0,z])
  }
  around.sort((a,b)=>Math.hypot(a[0],a[2])-Math.hypot(b[0],b[2]))
  return [
    ...directions.map(d => add(m.hut.center, d.map(v => v * 5))),
    ...directions.slice(0,4).map(d => add(m.anchor, d.map(v => v * 4))),
    ...around.map(offset=>add(m.anchor,offset)),
  ]
}

async function lightBase(a, m, save, log) {
  const n = m.nether
  const lighting = n.lighting ??= { placed: [], blocked: [], index: 0 }
  if (lighting.done) return
  lighting.wallIndex ??= 0
  const fixtures = [[0,1,-1],[-1,1,1],[-1,1,3],[1,1,3]]
  if (lighting.wallIndex < fixtures.length) {
    const p=add(m.hut.center,fixtures[lighting.wallIndex])
    const door=add(m.hut.center,[0,0,2])
    const outside=add(m.hut.center,[0,0,3])
    const inside=add(m.hut.center,[0,0,1])
    const relative=a.here().map((part,i)=>part-m.hut.center[i])
    const indoors=Math.abs(relative[0])<=1 && Math.abs(relative[2])<=1 && relative[1]===0
    if (!isTorch((await a.block(p)).name)) {
      if (!await torchSupply(a)) return '补充小屋火把材料'
      if (lighting.wallIndex<2 && !indoors) {
        if (dist(a.here(),outside)>0.5) await a.move(outside,0)
        if (!(await a.block(door)).properties?.open) await a.call('interact',{pos:door})
        if (!await crossHutDoor(a,door,inside)) return '从门口进入小屋布置照明'
      }
      await a.placeAt('torch',p)
      if (!isTorch((await a.block(p)).name)) return '核查小屋墙上火把'
    }
    if (lighting.wallIndex===1 && (await a.block(door)).properties?.open) {
      if (!await crossHutDoor(a,door,outside)) return '离开小屋关门'
      await a.call('interact',{pos:door})
      if ((await a.block(door)).properties?.open) return '核对小屋关门'
    }
    lighting.wallIndex++
    save()
    return '安装小屋墙上火把'
  }
  const zones = lightingZones(m)
  const pending = lighting.index >= zones.length
  const index = pending ? lighting.blocked[0] : lighting.index
  if (index === undefined) {
    lighting.done = true
    n.torchesPlaced = !lighting.unresolved?.length
    save()
    log('基地 64 格照明巡检结束，地面火把 '+lighting.placed.length+
      '，未核验区域 '+(lighting.unresolved?.length ?? 0))
    return '基地第一轮照明巡检完成'
  }
  const result = await buildLight(a, zones[index], lighting.placed)
  if (result?.needsTorch) {
    await torchSupply(a)
    return '补充基地照明材料'
  }
  if (result?.torch && !lighting.placed.some(p=>dist(p,result.pos)===0)) {
    lighting.placed.push(result.pos)
    log('服务器已确认火把 ' + result.pos.join(','))
  } else if (!result) {
    if (pending) (lighting.unresolved ??= []).push(zones[index])
    else lighting.blocked.push(index)
  }
  if (pending) lighting.blocked.shift()
  else lighting.index++
  save()
  return '沿工坊和小屋四周布置火把'
}

module.exports = { torchSupply, lightBase, lightTravel, crossHutDoor, MIN_SMELTING_FUEL }
