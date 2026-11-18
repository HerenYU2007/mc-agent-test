data modify storage nmo_telemetry:state snapshot.online set value 1b
data modify storage nmo_telemetry:state snapshot.dimension set from entity @s Dimension
execute store result storage nmo_telemetry:state snapshot.x int 1 run data get entity @s Pos[0] 1
execute store result storage nmo_telemetry:state snapshot.y int 1 run data get entity @s Pos[1] 1
execute store result storage nmo_telemetry:state snapshot.z int 1 run data get entity @s Pos[2] 1
execute store result storage nmo_telemetry:state snapshot.hp double 0.1 run data get entity @s Health 10
data modify storage nmo_telemetry:state snapshot.food set from entity @s foodLevel
data modify storage nmo_telemetry:state snapshot.held set from entity @s SelectedItem.id
execute store result storage nmo_telemetry:state snapshot.gameTime int 1 run time query gametime
data modify storage nmo_telemetry:state snapshot.inventory set value {iron:0,rawIron:0,coal:0,torch:0,diamond:0}
execute store result storage nmo_telemetry:state snapshot.inventory.iron int 1 run clear @s minecraft:iron_ingot 0
execute store result storage nmo_telemetry:state snapshot.inventory.rawIron int 1 run clear @s minecraft:raw_iron 0
execute store result storage nmo_telemetry:state snapshot.inventory.coal int 1 run clear @s minecraft:coal 0
execute store result storage nmo_telemetry:state snapshot.inventory.torch int 1 run clear @s minecraft:torch 0
execute store result storage nmo_telemetry:state snapshot.inventory.diamond int 1 run clear @s minecraft:diamond 0
data modify storage nmo_telemetry:state snapshot.mined set value {}
execute store result storage nmo_telemetry:state snapshot.mined.diamondOre int 1 run scoreboard players get @s nmo_diamond
execute store result storage nmo_telemetry:state snapshot.mined.deepslateDiamondOre int 1 run scoreboard players get @s nmo_diamond_ds
execute store result storage nmo_telemetry:state snapshot.mined.coalOre int 1 run scoreboard players get @s nmo_coal
execute store result storage nmo_telemetry:state snapshot.mined.deepslateCoalOre int 1 run scoreboard players get @s nmo_coal_ds
execute store result storage nmo_telemetry:state snapshot.mined.lapisOre int 1 run scoreboard players get @s nmo_lapis
execute store result storage nmo_telemetry:state snapshot.mined.deepslateLapisOre int 1 run scoreboard players get @s nmo_lapis_ds
execute store result storage nmo_telemetry:state snapshot.mined.ironOre int 1 run scoreboard players get @s nmo_iron
execute store result storage nmo_telemetry:state snapshot.mined.deepslateIronOre int 1 run scoreboard players get @s nmo_iron_ds
