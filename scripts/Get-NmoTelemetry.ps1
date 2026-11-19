[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 3001,
    [ValidateRange(0, 5)]
    [int]$Events = 0,
    [switch]$Usage
)

$ErrorActionPreference = 'Stop'
$state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/state" -TimeoutSec 4
$result = [ordered]@{
    bot = if ($state.botConnected) { 'online' } elseif ($state.botEnabled) { 'reconnecting' } else { 'offline' }
    deepSeek = if ($state.modelEnabled) { 'on' } else { 'off' }
}
if ($state.botConnected) {
    $result.position = @($state.position.x, $state.position.y, $state.position.z)
    $result.hp = [Math]::Round($state.health, 1)
    $result.food = $state.food
    $result.foodRecovery = $state.foodRecovery
    if ($state.resupply.active -or $state.resupply.diamonds -gt 0) { $result.resupply = $state.resupply }
    $result.action = $state.decision
    $result.stage = $state.stage
    $result.inventory = [ordered]@{
        iron = [int]$state.iron - [int]$state.rawIron
        rawIron = $state.rawIron
        coal = $state.coal
        torch = $state.torches
        freeSlots = $state.freeSlots
    }
    $result.gear = [ordered]@{ ironPick = $state.hasIronPickaxe; shield = $state.hasShield; armor = $state.armorPieces }
    if ($state.mine.order) {
        $result.mine = [ordered]@{
            active = $state.mine.active
            requested = $state.mine.order.requested
            target = $state.mine.order.target
            planned = if ($state.mine.target) { $state.mine.target.name } else { $null }
            committed = $state.mine.committed
            result = $state.mine.lastAudit.result
            actual = $state.mine.lastAudit.actual
        }
    }
}
if ($Usage) { $result.tokens = $state.modelUsage }
if ($Events -gt 0) {
    $result.events = @($state.events |
        Where-Object { $_.message -in @('inventory cleared', 'inventory full; protected items kept', 'mine command audit', 'mining paused for food', 'food surface route started', 'food surface reached', 'food recovery complete', 'mine commitment resumed', 'dark area torch placed', 'gear upgrade crafted', 'iron workshop started', 'iron workshop recovered', 'combat policy decision', 'agent died; waiting for respawn', 'canopy descent reached ground', 'retreat food stop', 'surface resupply required after diamonds', 'surface resupply complete', 'swim bank lowered for exit', 'swim reached dry ground') } |
        Select-Object -Last $Events |
        ForEach-Object {
            $detail = $_.data
            if ($_.message -eq 'mine command audit') {
                $detail = [ordered]@{ target = $_.data.target; result = $_.data.result; actual = $_.data.actual.name }
            }
            [ordered]@{ time = $_.time; event = $_.message; detail = $detail }
        })
}
$result | ConvertTo-Json -Depth 7 -Compress
