const {setTimeout:sleep}=require('node:timers/promises')

const recipes=[
  {input:'water',ingredient:'nether_wart',output:'awkward'},
  {input:'awkward',ingredient:'magma_cream',output:'fire_resistance'},
  {input:'fire_resistance',ingredient:'redstone',output:'long_fire_resistance'}
]
const mark='minecraft:nether/brew_potion'
const sum=(items,name)=>items.filter(item=>item.name===name).reduce((n,item)=>n+item.count,0)
const potionCount=(items,potion)=>items.filter(item=>item.name==='potion'&&item.potion===potion).reduce((n,item)=>n+item.count,0)
const offset=(base,dx,dy,dz)=>[base[0]+dx,base[1]+dy,base[2]+dz]

async function brewAtBase(api,checkpoint,record,{target='awkward',stageOnly=false}={}){
  const goal=recipes.findIndex(recipe=>recipe.output===target)
  if(goal<0)throw Error('Unsupported brewing target '+target)
  const inventory=async()=>(await api.call('inventory')).items
  const block=pos=>api.call('get_block',{pos})
  const [x,y,z]=checkpoint.base
  const station=checkpoint.brewingStand??offset(checkpoint.base,0,0,1)
  const status=await api.call('status')
  if(!status.alive||status.dimension!=='overworld'||status.on_fire||status.nearest_hostile?.dist<5||
      Math.hypot(status.pos[0]-x,status.pos[1]-y,status.pos[2]-z)>14){
    return {ok:false,reason:'unsafe_or_away_from_base'}
  }
  const targetWindow={target:{pos:station}}
  const view=()=>api.call('window/view',targetWindow)
  const act=ops=>api.call('window/act',{...targetWindow,ops})
  async function travelTo(point){
    try{await api.call('move_to',{pos:point,range:0,timeout:5500})}
    catch{
      for(let attempt=0;attempt<2;attempt++){
        const current=await api.call('status')
        const dx=point[0]+.5-current.pos[0],dz=point[2]+.5-current.pos[2]
        const distance=Math.hypot(dx,dz)
        if(distance<.6)break
        await api.call('control',{yaw:Math.atan2(-dx,-dz),pitch:0,forward:true,
          ms:Math.min(1200,Math.max(100,Math.round(distance*255)))})
      }
    }
    const actual=(await api.call('status')).pos
    return Math.hypot(point[0]+.5-actual[0],point[2]+.5-actual[2])<1.25
  }
  const report=async()=>{
    const items=await inventory()
    const seen=await api.call('advancements',{status:'completed',include_recipes:false,ids:[mark]})
    return {ok:potionCount(items,target)>0&&seen.advancements.some(a=>a.id===mark),
      target,potions:potionCount(items,target),advancement:seen.advancements.some(a=>a.id===mark),station}
  }
  let items=await inventory()
  if(potionCount(items,target)){
    const existing=await report()
    if(existing.ok)return existing
  }
  const currentBlock=(await block(station)).name
  if(!['air','cave_air','brewing_stand'].includes(currentBlock))return {ok:false,reason:'station_space_occupied',station}
  let window=currentBlock==='brewing_stand'?await view():null
  const bottles=()=>window?.sections.bottles??[]
  if(bottles().some(b=>b.name!=='potion'||b.potion!==bottles()[0].potion)){
    return {ok:false,reason:'mixed_bottles',station}
  }
  const currentPotion=bottles()[0]?.potion
  if(currentPotion&&!recipes.some(r=>r.input===currentPotion||r.output===currentPotion)){
    return {ok:false,reason:'unrecognized_potion_in_station',station}
  }
  const startIndex=currentPotion?recipes.findIndex(r=>r.output===currentPotion)+1:0
  const needStand=!window&&sum(items,'brewing_stand')===0
  const needFuel=startIndex<=goal&&!window?.info?.fuel_left&&!(window?.info?.brew_time_left>0)&&!window?.sections.fuel?.length
  const rods=Number(needStand)+Number(needFuel&&!sum(items,'blaze_powder'))
  const missing=[]
  if(sum(items,'blaze_rod')<rods)missing.push('blaze_rod')
  if(needStand&&sum(items,'cobblestone')<3)missing.push('cobblestone')
  for(const {ingredient} of recipes.slice(startIndex,goal+1)){
    if(!sum(items,ingredient)&&!window?.sections.ingredient?.some(i=>i.name===ingredient))missing.push(ingredient)
  }
  if(!bottles().length&&!potionCount(items,'water')&&!sum(items,'glass_bottle')&&sum(items,'glass')<3)missing.push('glass_bottle')
  if(missing.length)return {ok:false,reason:'missing_materials',missing,rodsRequired:rods}
  if(startIndex>goal+1)return {ok:false,reason:'station_contains_later_potion',station}
  if(!window){
    if(needStand)await api.call('craft',{item:'brewing_stand',count:1})
    await api.call('place',{item:'brewing_stand',pos:station})
    if((await block(station)).name!=='brewing_stand')throw Error('Brewing stand placement was not confirmed')
    window=await view()
    record('brew_station_ready',{station,crafted:needStand})
  }
  if(!bottles().length){
    if(!potionCount(items,'water')&&!sum(items,'glass_bottle'))await api.call('craft',{item:'glass_bottle',count:3})
    items=await inventory()
    if(potionCount(items,'water')<3&&sum(items,'glass_bottle')){
      const water=checkpoint.waterSource??(await api.call('find_blocks',{types:['water'],radius:15,limit:3})).blocks[0]?.pos
      if(!water&&!potionCount(items,'water'))return {ok:false,reason:'water_source_not_found',station}
      const outside=water&&Math.hypot(water[0]-x,water[2]-z)>2.5
      const door=outside&&checkpoint.door?await block(checkpoint.door):null
      const open=door?.name.endsWith('_door')&&door.properties?.open!==true&&door.properties?.open!=='true'
      if(open)await api.call('interact',{pos:checkpoint.door})
      try{
        if(outside&&door){
          const exit=[checkpoint.door[0]+Math.sign(checkpoint.door[0]-x),checkpoint.door[1],
            checkpoint.door[2]+Math.sign(checkpoint.door[2]-z)]
          if(!await travelTo(exit))return {ok:false,reason:'water_exit_unreachable',station}
        }
        for(let i=0;water&&i<3&&potionCount(items,'water')<3&&sum(items,'glass_bottle');i++){
          const before=potionCount(items,'water')
          const surface=[water[0],water[1]+1,water[2]]
          const aim=/^(air|cave_air)$/.test((await block(surface)).name)?surface:water
          await api.call('interact',{pos:aim,item:'glass_bottle'})
          items=await inventory()
          if(potionCount(items,'water')<=before)throw Error('Water bottle fill was not confirmed')
          record('brew_bottle_filled',{water,bottles:potionCount(items,'water')})
        }
      }finally{
        if(outside){
          const back=await travelTo(checkpoint.base).catch(()=>false)
          if(back&&open)await api.call('interact',{pos:checkpoint.door})
        }
      }
    }
    await act([{op:'put',to:'bottles',item:'potion',potion:'water',count:potionCount(items,'water')}])
    window=await view()
  }
  if(needFuel){
    items=await inventory()
    if(!sum(items,'blaze_powder'))await api.call('craft',{item:'blaze_powder',count:2})
    await act([{op:'put',to:'fuel',item:'blaze_powder',count:1}])
    window=await view()
  }
  for(const recipe of recipes.slice(startIndex,goal+1)){
    if(bottles().every(b=>b.potion===recipe.output))continue
    if(!bottles().length||!bottles().every(b=>b.potion===recipe.input)){
      return {ok:false,reason:'unexpected_bottle_stage',recipe,bottles:bottles(),station}
    }
    const loaded=window.sections.ingredient?.[0]
    if(loaded&&loaded.name!==recipe.ingredient)return {ok:false,reason:'other_ingredient_in_station',station}
    if(!loaded){
      await act([{op:'put',to:'ingredient',item:recipe.ingredient,count:1}])
      record('brew_stage_started',{station,...recipe})
    }else record('brew_stage_resumed',{station,...recipe})
    if(stageOnly)return {ok:false,reason:'staged_for_resume',stage:recipe.output,station}
    const deadline=Date.now()+34000
    do{
      await sleep(1200)
      window=await view()
      if(bottles().length&&bottles().every(b=>b.potion===recipe.output))break
    }while(Date.now()<deadline)
    if(!bottles().length||!bottles().every(b=>b.potion===recipe.output)){
      return {ok:false,reason:'brew_timeout',stage:recipe.output,window,station}
    }
    record('brew_stage_ready',{station,stage:recipe.output,bottles:bottles().length})
  }
  const count=potionCount(bottles(),target)
  if(!count)return {ok:false,reason:'target_not_ready',target,station}
  await act([{op:'take',from:'bottles',item:'potion',count}])
  for(let i=0;i<4;i++){
    const result=await report()
    if(result.ok||i===3){record('brew_result',result);return result}
    await sleep(220)
  }
}

module.exports={brewAtBase}
