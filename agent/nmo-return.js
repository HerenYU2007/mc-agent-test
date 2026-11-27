const fs = require('node:fs')
const { AIR, recoverable, add, dist } = require('./nmo-actions')

const directions = [[1,0,0],[-1,0,0],[0,0,1],[0,0,-1]]
const danger = /water|lava|magma|fire|cactus|powder_snow|gravel|sand$/

async function buildReturnStep(a, origin) {
  const building = ['cobblestone','cobbled_deepslate','dirt'].find(name=>a.count(name))
  if (!building) return false
  const underfoot = await a.block(add(origin,[0,-1,0]))
  if (AIR.has(underfoot.name) || danger.test(underfoot.name)) return false
  for (const dir of directions) {
    const step = add(origin,dir)
    const base = add(step,[0,-1,0])
    const [floor,feet,head,lower,...neighbors] = await Promise.all([
      a.block(step),a.block(add(step,[0,1,0])),a.block(add(step,[0,2,0])),a.block(base),
      ...directions.map(offset=>a.block(add(step,offset))),
    ])
    if (!AIR.has(floor.name) || !AIR.has(feet.name) || !AIR.has(head.name) ||
        [lower,...neighbors].some(block=>danger.test(block.name))) continue
    try {
      if (AIR.has(lower.name)) await a.placeAt(building,base)
      await a.placeAt(building,step)
      await a.move(add(step,[0,1,0]),0)
      await a.refresh()
      if (a.here()[1]>origin[1]) return true
    } catch(error) {
      if (!recoverable.has(error.code) || error.code === 'movement_interrupted') throw error
    }
  }
  return false
}

function readTrail(file) {
  const points=[]
  let dimension='overworld'
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue
    let entry
    try { entry=JSON.parse(line) } catch { continue }
    if (entry.kind==='status' || entry.kind==='damage') dimension=entry.dimension ?? dimension
    if (dimension!=='overworld') continue
    const pos=entry.kind==='status'||entry.kind==='damage'?entry.pos:
      entry.kind==='action'&&entry.endpoint==='move_to'?entry.result?.pos:null
    if (!Array.isArray(pos) || pos.length!==3 || !pos.every(Number.isFinite)) continue
    const cell=pos.map(Math.floor)
    if (points.length && dist(cell,points.at(-1))===0) continue
    points.push(cell)
  }
  return points
}

async function followRecordedExit(a,m,surface,save,log,file,completion='已带备用钻石回到可营建的地表') {
  if (!m.returnTrail) {
    const points=readTrail(file)
    let at=points.length-2
    while (at>0 && dist(points[at],a.here())>8) at--
    if(points.length<2)return a.stair(surface[1])
    m.returnTrail={points,cursor:at+1}
    save()
  }
  const route=m.returnTrail
  const origin=a.here()
  route.blocked ??= {}
  if (origin[1]>=surface[1]-3 && a.status.on_ground && !a.status.in_water) {
    const ground=(await a.block(add(origin,[0,-1,0]))).name
    const surfaceBlock=/^(grass_block|dirt|sand|red_sand|stone|gravel|podzol|mycelium|snow_block|terracotta)$/
    if (surfaceBlock.test(ground)) {
      const sky=await Promise.all(Array.from({length:32},(_,i)=>a.block(add(origin,[0,i+1,0]))))
      if (sky.every(block=>AIR.has(block.name))) {
        m.surface=origin
        m.reachedBuildSurface=true
        delete m.returnTrail
        save()
        log(completion+' '+origin.join(','))
        return true
      }
    }
  }
  const chronological = Array.from({length: Math.min(22,route.cursor)},(_,i)=>Math.max(0,route.cursor-22)+i)
  const upward = route.points.map((point,index)=>({point,index,distance:dist(point,origin)}))
    .filter(({point,distance})=>point[1]>origin[1] && point[1]<origin[1]+7 && distance<=9)
    .sort((x,y)=>y.point[1]-x.point[1]||x.distance-y.distance)
  const options = [...new Map([...upward.map(item=>item.index),...chronological].map(index=>
    [route.points[index].join(','),index])).values()].slice(0,28)
  for(const index of options) {
    const point=route.points[index]
    if ((route.blocked[index] || 0) > Date.now()) continue
    const distance=dist(point,origin)
    if((distance<1.5 && point[1]<=origin[1]) || distance>11 || Math.abs(point[1]-origin[1])>6) continue
    const [floor,feet,head]=await Promise.all([a.block(add(point,[0,-1,0])),a.block(point),a.block(add(point,[0,1,0]))])
    if(AIR.has(floor.name)||/water|lava|magma|powder_snow|fire|cactus/.test(floor.name)||
      !AIR.has(feet.name)||!AIR.has(head.name))continue
    try {
      await a.move(point,1)
      await a.refresh()
      if(dist(a.here(),origin)<1)continue
      route.cursor=Math.min(route.cursor,index)
      log('沿已走矿道返程 '+a.here().join(',')+'，剩余记录点 '+index)
      save()
      return true
    } catch(error) {
      if(!recoverable.has(error.code))throw error
      route.blocked[index]=Date.now()+30000
    }
  }
  // When the next historical footprint was damaged, use the existing guarded stair fallback.
  if(await buildReturnStep(a,origin) || await a.stair(surface[1])) {
    await a.refresh()
    const nearest=route.points.findLastIndex((p,index)=>index<route.cursor && dist(p,a.here())<=3)
    if(nearest>=0)route.cursor=nearest+1
    save()
    return true
  }
  return false
}
module.exports={readTrail,followRecordedExit}
