function nmo_telemetry:refresh
tellraw @s [{"text":"[NMO] ","color":"aqua"},{"type":"nbt","nbt":"snapshot","storage":"nmo_telemetry:state"}]
