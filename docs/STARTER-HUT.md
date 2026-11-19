# 5×5 生存小屋

蓝图是 `starter-hut.js` 中的原版方块布局。Bot 在主世界找可走到的 5×5 地块，逐块施工。玻璃窗在封上第三层墙前安装，屋顶使用下半木台阶。门会随入口方向旋转。床、箱子、熔炉、工作台放在 3×3 室内，门口与中间留通道。Bot 会搭临时台阶施工，封好屋顶前拆除。施工期间用床设置重生点，收到服务器确认且所有方块验收通过后才记为已建成。

墙板可以混用任何原版木板，屋顶可以混用任意原版木制台阶。基础材料是 15 块圆石、29 块木板、25 个下半木台阶、2 格玻璃、门、床、箱子、熔炉、工作台和 4 根火把。斜地地基和可回收施工台阶另外备料。缺玻璃时按服务器下发的视距扫描已加载区块，优先找露出水面的普通沙子或红沙。需要过水时，Bot 会尝试选定目标一带可继续步行的岸边，低氧时先上浮。挖掘并拾取沙子后用熔炉烧制玻璃。燃料优先用煤或木炭，也可以用木板。

在生存服使用现有 Agent 入口，给这个蓝图使用单独的进度路径。中断后保留该路径，在同一个世界以相同方式启动即可续建。

```powershell
$env:MC_BUILD_STARTER_HUT = '1'
$env:MC_SUPPLY_STATION_STATE = Join-Path $env:TEMP 'mc-agent-starter-hut.json'
npm run agent
```

实测时可给 Bot 圆石、已加工的木材、室内设施、火把和燃料，以及一把石镐和石锹。从库存没有沙子和玻璃开始，观察「starter hut sand selected」「starter hut sand collected」「starter hut glass collected」。用 `data get entity NMO-HutBot respawn` 核实服务器存下的重生点，确认它对应室内的床。
