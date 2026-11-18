# Minecraft 生存 Agent 接手说明

项目在 Minecraft Java 26.1 原版服务器上运行独立 Bot。DeepSeek 提供可选的高层决策，采矿、合成、战斗、游泳和救急由本地逻辑执行。旁观 Mod 只在观察者客户端加载。

## 从哪里开始

| 需要处理的内容 | 入口 |
| --- | --- |
| 启动与配置 | [README](../README.md)、[环境变量模板](../.env.example)、[服务端配置模板](../server.properties.example) |
| Bot 生命周期、DeepSeek、寻路和本地策略 | [`agent.js`](../agent.js) |
| 原生 HUD、线路、目标和背包 | [`ObserverHud.java`](../observer-mod/src/main/java/com/nmo/agentobserver/ObserverHud.java)、[`ObserverFrame.java`](../observer-mod/src/main/java/com/nmo/agentobserver/ObserverFrame.java)、[`AgentObserverClient.java`](../observer-mod/src/main/java/com/nmo/agentobserver/AgentObserverClient.java) |
| 精简运行快照 | [`Get-NmoTelemetry.ps1`](../scripts/Get-NmoTelemetry.ps1)、[原版遥测数据包](../datapacks/nmo-telemetry/README.md) |
| 已实现和实测范围 | [更新日志](../CHANGELOG.md)、[前期生存流程](../early-game-flow.md) |

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
- 穿齐四件钻石级护甲后，从实际拾取增量累计钻石。计数到 10 触发 `surfaceResupply`，补到 8 个可食用物品后清零。计数和最近的露天地面位置目前属于 Agent 进程状态，重启会重新开始记录。深层复杂洞穴仍取决于可达路线和库存中的垫路材料。

## 观察与排障

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
4. 穿齐钻石甲后挖够 10 颗实际拾到的钻石，确认 `surface resupply required after diamonds`，随后在露天地面制作面包或取得食物，事件 `surface resupply complete` 应显示至少 8 份。已实测干草制面包；自然村庄和长期找路需继续随机档验证。
5. 修改 JavaScript 后用 `npm run test:syntax`。修改旁观 Mod 后用 `node build-observer-mod.js`，在 26.1 Fabric 观察者中确认物品图标、格位和经验条上下位置。测试结束后先核对端口和 PID，再按当前场景保留或恢复 Bot、模型和客户端状态。

发布只包含源码、配置模板和文档。运行时密钥、游戏 JAR、构建成品、存档、日志和本机诊断数据使用本地专用目录。
