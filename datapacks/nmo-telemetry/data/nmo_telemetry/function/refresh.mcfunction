data modify storage nmo_telemetry:state snapshot set value {bot:"NMO-TestAgent",online:0b}
execute as @a[name=NMO-TestAgent,limit=1] at @s run function nmo_telemetry:sample
