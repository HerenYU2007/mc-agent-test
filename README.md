# Minecraft Java 1.21.11 生存 Agent

在随机世界中运行的 Minecraft Bot。它会收集材料、寻路采矿、制作装备、处理饥饿和威胁。可选 DeepSeek 高层决策，具体采集、移动和战斗由本地执行器处理。

项目还包含 Fabric 原生旁观 Mod、原版服务器遥测数据包，以及本地 Token 用量和路径监控面板。

## 启动测试服

准备 Node.js 24、Java 21 和 [Minecraft Java 1.21.11](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-11)。从项目目录安装依赖。

    npm ci
    npm run test:syntax

将官方 1.21.11 服务端 JAR 放到 `server12111-fresh/server.jar`，再将 `server.properties.example` 复制到该目录并命名为 `server.properties`。模板只监听本机 25567 端口，难度为困难，种子留空时随机生成新世界。1.21.11 用独立目录保存世界。首次运行会生成 EULA 文件。阅读并接受 Minecraft EULA 后，将其中的 `eula` 改为 `true` 并重启。

    .\start-test-server.ps1

运行 Agent。

    Copy-Item .env.example .env
    node --env-file=.env agent.js

Windows 也可双击 `1-启动服务端.bat`、`2-启动Agent.bat`。要连接其他服务器，在 `.env` 或进程环境中设置 `MC_HOST`、`MC_PORT` 和 `MC_VERSION`。

打开 [本地监控面板](http://127.0.0.1:3001/) 查看实时状态。DeepSeek 默认关闭，启用时使用官方 `https://api.deepseek.com/chat/completions` 和 `deepseek-flash`。在本地 `.env` 或进程环境里设置 `DEEPSEEK_API_KEY`，再通过面板开启，或设置 `DEEPSEEK_AUTO_START=1`。暂停 Bot 会同时关闭模型。比赛环境如需使用统一代理，可按规则配置 `DEEPSEEK_URL` 和 `DEEPSEEK_MODEL`。

## 遥测和原生旁观

测试服生成世界后，可安装 [遥测数据包](datapacks/nmo-telemetry/README.md)，随后在服务器控制台运行 `reload`。Fabric 旁观 Mod 和网页面板可直接从 Agent 读取遥测。

    .\scripts\Install-NmoTelemetry.ps1
    .\scripts\Get-NmoTelemetry.ps1 -Events 2 -Usage

使用 JDK 21 和 Gradle 9.2.1，从仓库根目录构建旁观 Mod。

    gradle -p observer-mod build

将 `observer-mod/build/libs/nmo-agent-observer-0.2.1+1.21.11.jar` 和 Fabric API `0.141.6+1.21.11` 放进 Minecraft 1.21.11 的 Fabric 客户端 `mods` 目录，使用 Fabric Loader 0.19.5 或更高版本。Windows 也可用 `3-启动观察者客户端.bat` 启动 Gradle 的测试客户端。该脚本读取 `MC_CLIENT_SERVER`（默认 `127.0.0.1:25567`）和 `MC_OBSERVER_DASHBOARD_PORT`（默认 `3001`）。

服务器管理员可执行 `gamemode spectator NMOViewer` 和 `spectate NMO-TestAgent NMOViewer`。Mod 默认读取 `http://127.0.0.1:3001/observer`，不同端口通过客户端 JVM 参数 `-Dnmo.observer.port=端口` 设置。按 K 展开决策、实际操作、坐标和 Token 用量。底部透明 HUD 显示 27 格主背包、9 格快捷栏、护甲、副手、数量和耐久。1.21.11 的 3D 画面通过原生客户端查看，网页继续提供控制和状态面板。旁观 Mod 默认给客户端玩家维持原版无限夜视，并清除本地的黑暗和失明画面遮挡。重新进服或更换世界后会自动恢复。联机时效果由旁观客户端处理。

## 功能文件与协作

Agent 的功能代码位于 `agent/`。命令入口继续是 `node agent.js`，功能位置和并行编辑约定见 [AI 接手文档](docs/AI-HANDOFF.md#并行编辑)。改完运行 `npm run test:syntax` 检查入口、功能模块和蓝图代码。

创造模式下可在空地逐块施工 `.litematic`。命令、测试样图和旁观步骤见 [创造模式逐块施工](docs/CREATIVE-BUILD.md)。

两台 Windows 电脑可使用同一个 `collab` 分支自动同步。首次配置、启动和冲突处理见 [PowerShell 自动同步说明](docs/AUTO-SYNC.md)。

## 钻石套后的补给基地

Agent 穿齐四件钻石级护甲后，优先额外拾取 10 颗钻石，再回主世界地面补到 8 份食物。完成补给后才会寻找开阔地，建造带工作台和储物桶的补给基地。回基地时会存放钻石等贵重物、补充食物和火把、检查工具耐久，并储备铁镐、铁剑和盾牌。缺少食物时会继续搜集或狩猎，死亡后仍能回到已记录的基地领取库存。

基地会继续建造自动熔炉。上层木桶投放粗铁或生食，侧面木桶投放煤炭或木炭，下层木桶接收产物。拉杆开启会锁住燃料漏斗，墙上的红石火把熄灭。拉杆关闭时恢复送料。炉内已有燃料仍会继续燃烧。Agent 会读取实际漏斗状态和红石信号，也会自动装料和取货。

监控接口 `/state` 的 `supplyBase` 字段显示基地坐标、建设阶段、工坊状态和食物库存。资格进度和坐标保存在本地 `supply-base-state.json`。可用 `MC_BASE_STATE_PATH` 给不同存档指定各自的文件，新建世界时使用新路径。

[前期生存流程](early-game-flow.md) · [更新日志](CHANGELOG.md) · [AI 接手文档](docs/AI-HANDOFF.md)
