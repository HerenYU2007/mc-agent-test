const attempts = new WeakMap()
const sides = [[1,0],[-1,0],[0,1],[0,-1]]
const obstruction = /^(?:stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff|netherrack|dirt|gravel|sand|red_sand)$/
const retryable = new Set(['busy','interrupted','movement_interrupted','not_loaded','out_of_reach',
  'not_ready','path_not_found','timeout','nothing_to_dig','undiggable'])

async function escapeWall(call,block,status,isFloor,isSpace) {
  const previous=attempts.get(call)
  const now=Date.now()
  const state={health:status.health,dimension:status.dimension,death:status.last_death?.t,
    until:previous?.until ?? 0,seq:previous?.seq ?? 0}
  attempts.set(call,state)
  if (!status.ready || !status.alive || status.in_lava || status.in_water ||
      !previous || previous.dimension!==state.dimension || previous.death!==state.death) {
    state.until=0
    return false
  }
  if (status.health<previous.health) {
    const {events,last_seq}=await call('events',{since:state.seq,limit:500})
    state.seq=last_seq
    if (events.some(event=>event.type==='hurt' && event.source?.replace(/^minecraft:/,'')==='in_wall' &&
        Math.abs(now-event.t)<2000)) state.until=now+1600
  }
  if (now>=state.until) return false

  const origin=status.pos.map(Math.floor)
  const nearby=await Promise.all(sides.map(async ([dx,dz])=>{
    const [x,y,z]=[origin[0]+dx,origin[1],origin[2]+dz]
    try {
      const [floor,feet,head]=await Promise.all([[x,y-1,z],[x,y,z],[x,y+1,z]].map(block))
      return isFloor(floor) && isSpace(feet) && isSpace(head) ? [x+.5,z+.5] : null
    } catch(error) {if(error.code!=='not_loaded')throw error;return null}
  }))
  for (const [x,z] of nearby.filter(Boolean)) {
    const yaw=Math.atan2(status.pos[0]-x,status.pos[2]-z)
    try {
      const moved=await call('control',{forward:true,yaw,pitch:0,ms:285,stop_on:['death']})
      if (moved.pos && Math.hypot(moved.pos[0]-status.pos[0],moved.pos[2]-status.pos[2])>.32) {
        state.until=0
        return true
      }
    } catch(error) {if(!retryable.has(error.code))throw error}
  }
  const head=[origin[0],origin[1]+1,origin[2]]
  try {
    const wall=await block(head)
    if (wall.diggable && obstruction.test(wall.name))
      await call('dig',{pos:head,collect:false,timeout:1800,stop_on:['death']})
  } catch(error) {if(!retryable.has(error.code))throw error}
  return true
}

module.exports={escapeWall}
