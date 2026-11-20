# 5×5 生存小屋

正式生存流程在补给站与红石工坊完成后、出发寻找村庄前自动建造这款小屋。仓库内的 [Litematic 蓝图](../blueprints/starter-hut-5x5.litematic) 随项目分发，常规流程启动时无需额外配置。生存与创造 Build 共用支撑面射线检查、放置、确认和重试。生存 Bot 自己寻找施工站位，用背包物品建造和拆除临时踏脚块，装门后进屋用床设重生点。

蓝图是 `starter-hut.js` 中的原版方块布局。Bot 在主世界找可走到的 5×5 地块，逐块施工。玻璃窗在封上第三层墙前安装，屋顶先封外圈，再补齐内圈的下半木台阶。门会随入口方向旋转。床、箱子、熔炉、工作台放在 3×3 室内，门口与中间留通道。Bot 会搭临时踏脚块施工，封好屋顶前拆除。收到床的重生点确认且所有方块验收通过后才记为已建成。

生存施工按现场缺口与背包材料选目标，再核对实际射线是否击中正确的支撑面。需要换站位时交给生存寻路。着手方式参考 [Baritone 26.1 的 BuilderProcess](https://github.com/cabaletta/baritone/blob/26.1/src/main/java/baritone/process/BuilderProcess.java) 中的库存扫描、可达面检查和放置确认。

墙板可以混用任何原版木板，屋顶可以混用任意原版木制台阶。基础材料是 15 块圆石、29 块木板、25 个下半木台阶、2 格玻璃、门、床、箱子、熔炉、工作台和 4 根火把。斜地地基和可回收施工台阶另外备料。缺玻璃时按服务器下发的视距扫描已加载区块，优先找露出水面的普通沙子或红沙。需要过水时，Bot 会尝试选定目标一带可继续步行的岸边，低氧时先上浮。挖掘并拾取沙子后用熔炉烧制玻璃。燃料优先用煤或木炭，也可以用木板。

在生存服使用现有 Agent 入口，给这个蓝图使用单独的进度路径。中断后保留该路径，在同一个世界以相同方式启动即可续建。

```powershell
$env:MC_BUILD_STARTER_HUT = '1'
$env:MC_SUPPLY_STATION_STATE = Join-Path $env:TEMP 'mc-agent-starter-hut.json'
npm run agent
```

实测时可给 Bot 圆石、已加工的木材、室内设施、火把和燃料，以及一把石镐和石锹。从库存没有沙子和玻璃开始，观察「starter hut sand selected」「starter hut sand collected」「starter hut glass collected」。用 `data get entity NMO-HutBot respawn` 核实服务器存下的重生点，确认它对应室内的床。

也可以给生存施工入口传入这款小屋的 Litematic v6 蓝图。设置 `MC_BUILD_STARTER_HUT_BLUEPRINT` 为文件的绝对路径，给它使用单独的进度文件，再运行 `npm run agent`。原点设在小屋中心、门朝南。导入时核对小屋的方块坐标与门、床和下半台阶，墙板和屋顶仍可使用手头同类木料。

蓝图在入口正前方用空气标记需清理的格子。Bot 进门前从上往下，用背包里的工具挖掉这些格子的障碍。其他留空的位置用 `structure_void` 表示，避免把地面和周围方块当成施工目标。测试日志中每次成功挖除都会出现 `starter hut entrance cleared`。
