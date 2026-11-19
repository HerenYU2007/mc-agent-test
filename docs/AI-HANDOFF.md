# Minecraft 生存 Agent 接手说明

项目在 Minecraft Java 26.1 原版服务器上运行独立 Bot。DeepSeek 提供可选的高层决策，采矿、合成、战斗、游泳和救急由本地逻辑执行。旁观 Mod 只在观察者客户端加载。

## 从哪里开始

| 需要处理的内容 | 入口 |
| --- | --- |
| 启动与配置 | [README](../README.md)、[环境变量模板](../.env.example)、[服务端配置模板](../server.properties.example) |
| Bot 启动、连接与功能装配 | [`agent.js`](../agent.js)、[`runtime.js`](../agent/runtime.js)、[`lifecycle.js`](../agent/lifecycle.js) |
| 任务优先级、装备阶段与钻石里程碑 | [`scheduler.js`](../agent/scheduler.js)、[`progression.js`](../agent/progression.js)、[`base-progression.js`](../agent/base-progression.js) |
| DeepSeek 决策与 Token、经验和日志 | [`model.js`](../agent/model.js)、[`logging.js`](../agent/logging.js) |
| 地形判断、寻路、水中移动和树冠脱困 | [`world.js`](../agent/world.js)、[`navigation.js`](../agent/navigation.js)、[`swimming.js`](../agent/swimming.js)、[`canopy.js`](../agent/canopy.js) |
| 采矿目标、挖掘动作与采木 | [`mining.js`](../agent/mining.js)、[`digging.js`](../agent/digging.js)、[`wood.js`](../agent/wood.js) |
| 背包、工具和护甲、合成与熔炼 | [`inventory.js`](../agent/inventory.js)、[`equipment.js`](../agent/equipment.js)、[`crafting.js`](../agent/crafting.js)、[`smelting.js`](../agent/smelting.js) |
| 战斗、撤退、盾牌与来箭格挡 | [`combat.js`](../agent/combat.js)、[`combat-defence.js`](../agent/combat-defence.js) |
| 战斗前任务保存与脱战恢复 | [`combat-interruption.js`](../agent/combat-interruption.js) |
| 食物、夜间避难和死亡掉落 | [`food.js`](../agent/food.js)、[`shelter.js`](../agent/shelter.js)、[`death-recovery.js`](../agent/death-recovery.js) |
| 5×5 施工、NBT 导入、基地与红石工坊 | [`construction.js`](../agent/construction.js)、[`supply-station.js`](../supply-station.js)、[`structure-nbt.js`](../structure-nbt.js)、[`supply-base.js`](../supply-base.js) |
| 补给后整备、建临时基地、找村庄和返程 | [`expedition.js`](../agent/expedition.js)、[`expedition-shelter.js`](../agent/expedition-shelter.js) |
| 创造模式 `.litematic` 逐块施工 | [`creative-build.js`](../agent/creative-build.js)、[`litematic.js`](../litematic.js)、[`build-creative.js`](../scripts/build-creative.js)、[实测步骤](CREATIVE-BUILD.md) |
| 网页面板、HTTP 接口、观测数据 | [`dashboard.html`](../agent/dashboard.html)、[`dashboard.js`](../agent/dashboard.js)、[`telemetry.js`](../agent/telemetry.js) |
| 原生 HUD、线路、目标和背包 | [`ObserverHud.java`](../observer-mod/src/main/java/com/nmo/agentobserver/ObserverHud.java)、[`ObserverFrame.java`](../observer-mod/src/main/java/com/nmo/agentobserver/ObserverFrame.java)、[`AgentObserverClient.java`](../observer-mod/src/main/java/com/nmo/agentobserver/AgentObserverClient.java) |
| 精简运行快照 | [`Get-NmoTelemetry.ps1`](../scripts/Get-NmoTelemetry.ps1)、[原版遥测数据包](../datapacks/nmo-telemetry/README.md) |
| 已实现和实测范围 | [更新日志](../CHANGELOG.md)、[前期生存流程](../early-game-flow.md) |

## 并行编辑

两台 Windows 电脑使用 `collab` 自动同步时，各自在其检出的仓库根目录启动同步器，具体操作见 [PowerShell 自动同步说明](AUTO-SYNC.md)。按 `AGENTS.md` 在修改前申请 [跨电脑文件锁](FILE-LOCKS.md)，确认推送后再释放。先按功能文件分工，跨模块的大改动可以暂停同步，完成后再一起保存和检查。

改战斗时从 `combat.js` 或 `combat-defence.js` 开始，改基地和自动熔炉时从 `supply-base.js` 开始。功能内部的小函数和临时状态放回该模块。模块通过 `features` 调用其他模块公开的动作，跨功能共享的数据在 `agent/state.js`，共享常量和连接参数在 `agent/config.js`。增加模块才需在 `runtime.js` 装配同名工厂。涉及优先级或共享状态的改动在合并时一起核对。用 `npm run test:syntax` 检查入口及每个功能模块。

## 战斗执行与恢复

紧急交战由本地调度。Bot 用武器冷却、视线和攻击距离约束出手，从服务器盾牌事件、自己的盾牌耐久变化或自身位置的格挡声音识别成功格挡，再在有效反击窗口内挥刀。低血撤离时只有沿安全路径前进且与追兵拉开后才开始边走边吃，受伤或追兵逼近会中断并尝试重新举盾。战斗前记录原导航目标或已提交的采矿目标，脱战后优先恢复；死亡、掉线、跨维度或记录过期时重新规划。

近战默认启用原版跳劈。没有待用的格挡反击时，状态和地形合适才起跳，确认已经下落、准星对准敌人且攻击已冷却后出手。指定玩家对手的近战在观察到对手挥空后利用短窗口起跳。格挡反击可打断待执行的跳劈。用环境变量 `MC_JUMP_ATTACKS=0` 关闭跳劈，方便在同一版本上做对照。运行事件 `combat jump swing` 记录了下落中的实际挥刀，实测暴击另外核对服务器的实体动画事件。

指定玩家对手举盾时，Bot 从实体正在使用的手和装备识别盾牌，切到可用的斧头，等新武器冷却后重新确认目标并挥刀。自身格挡后的反击保持优先，打盾后恢复常用武器。实测破盾以目标客户端收到的盾牌冷却包为准。

有弓和箭、身体状态允许、站稳并且目标在约 7 至 23 格且视线畅通时，`agent/combat-bow.js` 使用原版拉弓和放箭。按目标近期位移估计提前量，放箭前检查抛物线路径。目标贴近、自身受伤、需要举盾或离开安全状态时，换快捷栏取消本次拉弓并交回近战或防御。夜间执行模型选择的远距离射击时，超过 8 格且失去射击机会就结束本次进攻。HUD 显示「拉弓瞄准」和「放箭」，服务器伤害包才用于确认实际命中。

`node scripts/test-combat.js` 检查格挡反击判定、弓箭弹道、导航目标和采矿目标恢复。独立服的 Bot 对打用每个进程的 `MC_DUEL_OPPONENT` 指定唯一对手账号。正常运行保持此变量为空。

## 运行环境

- 验证环境为 Windows、Node.js 24、Java 25 和 Minecraft Java 26.1。原生旁观 Mod 使用 Fabric Loader 0.19.5。
- 正式随机档通常使用 Minecraft `25567` 和监控面板 `3001`。独立战斗服曾使用 `25573` 和 `3011`。隔离回归可在端口空闲时使用 `25574` 和 `3012`。
- 临时测试用独立服务器目录和客户端游戏目录。每个 Agent 用自己的 `MC_PORT`、`MC_DASHBOARD_PORT`、`RUNTIME_LOG_PATH` 和 `EXPERIENCE_LOG_PATH`。旁观启动时同时指定 `MC_CLIENT_SERVER` 与 `MC_OBSERVER_DASHBOARD_PORT`。启动脚本按当前工作目录选择 `client261-clean`。
- `MC_BOT_AUTOSTART=0` 可以只启动面板。`DEEPSEEK_AUTO_START` 默认关闭，启用需要进程环境里的 `DEEPSEEK_API_KEY`。可用 `DEEPSEEK_URL` 和 `DEEPSEEK_MODEL` 指向授权端点。面板暂停 Bot 会断开游戏连接并关闭模型。测试脚本可用本机模拟决策端点，避免真实 Token 消耗。

## 执行边界

- `decideAndAct` 管理高层任务。`minePlannerTick` 约每 750 ms 检查一次，执行器选定矿种和坐标后会保留目标。生存中断结束后可以返回原矿点，目标变化或确认不可达时才重选。
- `monitorSwimming` 持有水中移动控制，低氧优先级最高。检查水面及岸沿时要看实际水方块、岸边高度和头部空间。`lowerSwimBank` 的安全边界是挖低一格可采岩土，并确认下方仍是实心支撑。
- `leaveSpawnCanopy` 会在普通决策和 `collectWoodWithPlan` 两个入口运行。新增开局脚本时保留这两处，否则已锁定的采木任务会跳过脱困。
- `executeFlee` 负责短段撤离。`safeToEatOnRetreat` 检查近战和可见射手，`restAfterRetreat` 在安全窗口进食或等待回血。紧急威胁可以抢占日常任务。
- `autoEquipArmor` 应比较已穿的同槽装备。`clearBackpack` 只在安全的操作边界丢弃超额杂物或淘汰装备，保留资源下限、附魔装备和必要的可用工具。
- 在主世界穿齐四件钻石级护甲后，优先额外拾取 10 颗钻石。计入采矿目标的实际拾取增量，背包里原有的钻石不计。达标后调用 `surfaceResupply`，在露天地面补足 8 份食物，才由 `supply-base.js` 接管常规决策。钻石计数、补给完成标志和基地坐标保存在 `MC_BASE_STATE_PATH`，新世界使用单独的文件。基地采矿任务使用 `source: 'base'` 按数量和时限退出，蓝图施工备料继续使用自己的采矿目标。
- `recoverFoodSupply` 在饱食度降至 10 后接管采矿。先吃已有食物、利用可收集的小麦或干草、尝试烹饪或狩猎。实心顶盖下找不到食物时，与 `surfaceResupply` 共用 `approachFoodSurface`。它先尝试同维度 82 格内记住的露天地面，否则按当前高度尝试上行，短程寻路可以在长段失败时继续推进。近敌、水中接管、掉线会结束或中断补给路线。恢复到至少 14 后允许继续原采矿目标。

死亡掉落由 `recoverDeathDrops` 处理。死亡时记录有回收价值的物品名称和数量，包括身上的装备。木石装备和常见开局材料跳过。返程要求生命至少 16、饱食至少 14，并持续检查 Bot 与尸点周围的怪物。遇敌或受伤时中止，25 秒后再评估。最多两趟，回收途中再次死亡则放弃原点。核对 `death recovery skipped`、`death recovery deferred` 和 `death recovery finished`。

## 观察与排障

补给站是一次性任务。设置 `MC_BUILD_SUPPLY_STATION=1` 可在启动时直接开始，也可由模型选择 `build_camp` 触发。计划由 `supply-station.js` 维护。若要在进程重启后续建，把 `MC_SUPPLY_STATION_STATE` 指向该世界独用的 JSON 路径。重启时复用这个路径，新世界使用新路径。`/state` 的 `supplyStation` 显示阶段、工地中心、已确认和计划方块数。

地基、地板、双层墙、室内设施和屋顶按顺序施工，入口留出两格高空间。补给站备料调用现有的采木、采石、合成和熔炉流程。施工寻路不挖方块，核对实际方块后才更新进度。恢复施工要看 `supply station paused`、`supply station resumed`，以及复工前后是否是同一工地。`supply station completed` 的前置条件是整份蓝图一致、能走进入口，并成功打开箱子和熔炉。

### 村庄探险与临时基地

补给站和红石工坊完成整备后，Bot 在附近选择可用地形，搭建带门、完整屋顶、室内和四周火把的 4×4 临时基地。它从库存取得床或用三块同色羊毛合成床，进门后放床并与床交互，等待服务器确认个人重生点。出发前核对血量、饱食、8 份食物、16 根火把、四件护甲、盾和镐剑状态。未到出发条件时继续在补给站整备或在房内等待白天。

探险中根据已载入的村民、钟、农田、干草捆、床和工作站的组合识别村庄。远处发现迹象时，先规划接近路线，到村庄地标的水平距离不超过 12 格时才确认找到。启用 DeepSeek 后，由它从本地候选坐标里决定初始探索或接近方向，在后续每三个探路段重新选一次。确认村庄后会进入访村阶段，由 DeepSeek 从可执行动作中决定进村、采成熟小麦或干草、合成面包、带一张无人使用的备用床，或在安全位置观察。村庄已标记时也按同一流程再次出发。观察条件稳定时复用上次决定，避免空转消耗。网页及旁观 HUD 会显示决策和用量。

访村和采集过程中的实际走位也会加入同一条返程路线。血量降至 12、饱食降至 10、食物少于三份、火把不超过三根、关键装备磨损或天黑时，按路点倒序返程。因用尽搜索范围而结束探路时也回补给站。遭遇即时危险时仍由原战斗和撤离逻辑处理。

基地完成补给后，带有小麦种子的 Bot 会在基地附近选址，保存以一个水源为中心的 3×3 田块。优先利用已有水源，缺水时尝试用铁桶取水；它会做锄头、翻土、播种，并在以后回基地时只收割成熟小麦、拾取掉落和补种。田地坐标见 `/state` 的 `supplyBase.farm`。本地农事由执行器处理，未成熟的作物留待之后巡查。

查看 `/state` 的 `supplyBase.expedition`，其中有出发阶段、临时基地、已确认重生点、村庄、地标、当前路线和上次完整返程路线。独立测试世界设置单独的 `MC_BASE_STATE_PATH`、`MC_EXPEDITION_STATE_PATH`。运行 `node scripts/test-expedition.js` 验证几何布局、整备门槛、低血回撤、状态恢复和村庄识别。

### 原版结构 `.nbt`

设置 `MC_BUILD_NBT` 指向 Java 版结构方块导出的 `.nbt` 文件。文件本身会启用施工，尺寸顺序是 X、Y、Z，首版上限是 11×4×11。`structure-nbt.js` 读取压缩和未压缩两种文件，以 `size`、`palette` 和 `blocks` 建立相对坐标。给每个世界和图纸使用独立的进度 JSON。文件内容散列会与保存的进度核对。

现有采集器会按指定树种做木板，并能获取圆石或深板岩圆石。其他普通无状态方块从背包取用，缺货时记录 `structure material unavailable`。实体、自定义方块属性和方块实体数据在导入时报告，避免施工时出现不一致。空气和结构空位留空。按高度从低到高施工，世界方块一致才写入完成状态。

放置过程借鉴 Baritone 的现场差异检查和多落点视线检查。检测到屋顶角落被挡时，只临时挖除蓝图上的相邻屋顶木板，随后把它恢复。[Baritone `BuilderProcess`](https://github.com/cabaletta/baritone/blob/1.21.4/src/main/java/baritone/process/BuilderProcess.java)

```powershell
.\scripts\Get-NmoTelemetry.ps1 -Port 3001 -Events 3 -Usage
.\scripts\Get-NmoTelemetry.ps1 -Port 3011 -Events 3
```

日常排障优先读一行遥测。`/state` 是面板使用的完整当前状态，包括近几次事件。`/observer` 是供客户端每 500 ms 拉取的精简快照，包含当前动作、路线、装备格位、耐久和 Token。原版数据包可用 `/function nmo_telemetry:status` 独立核对服务器库存和挖掘计数。

观察者用 `spectate NMO-TestAgent NMOViewer` 跟随 Bot。Bot 断开后游戏可能解除跟随，重连后可再次执行。按 `K` 展开模型建议、实际操作和 Token 用量。

## 回归验收

1. 在有实体地面的高树上出生，确认逐段挖下、落地且生命保持 20。
2. 将 Bot 置于一个高一格的石岸附近，确认卡住后挖低一格并上岸。补做低氧时取消挖掘的检查。
3. 低血、有食物且有追兵时，核对 `fleeing` 先出现，`retreat food stop` 和 `food consumed successfully` 随后出现。已实测金苹果。追兵过近中断和满血再接战在这次发布中没有单独复测。
4. 穿齐钻石级护甲后，从 `/state` 的 `supplyBase.qualification` 核对实际拾取计数。第 9 颗时仍应锁定，第 10 颗后应先看到 `surface resupply required after diamonds`。回露天地面并备有至少 8 份食物后，依次确认 `surface resupply complete`、`supply base unlocked after resupply` 和基地选址。自动熔炉建成后投放粗铁和煤，核对铁锭进入下层木桶。拉杆开启时核对燃料漏斗锁住、指示火把熄灭。
5. 修改 JavaScript 后用 `npm run test:syntax`。修改旁观 Mod 后用 `node build-observer-mod.js`，在 26.1 Fabric 观察者中确认物品图标、格位和经验条上下位置。测试结束后先核对端口和 PID，再按当前场景保留或恢复 Bot、模型和客户端状态。
6. 在露天地面停留至记录位置，再进入覆顶矿洞。将饱食降到 10，观察 `food surface route started`、`food surface reached` 和 `food recovery complete`。记录真实落点和饱食度，可用 Y=68 以下的台阶出口复现固定高度路线的问题。排查失败时先看起点到露天地面的可达性、挖掘工具和垫路材料。

此前的 26.1 隔离服验证覆盖了有记录和无记录两种回地面路径。起点 Y=40、出口 Y=48，出洞后用测试提供的干草合成面包，吃到饱食度 14，并回收临时合成台。判断露天需要结合天光和实心顶盖，洞口附近的侧向光照有时也能达到 13。

发布只包含源码、配置模板和文档。运行时密钥、游戏 JAR、构建成品、存档、日志和本机诊断数据使用本地专用目录。
