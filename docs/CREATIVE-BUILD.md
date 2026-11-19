# 创造模式逐块施工

在自己的 Minecraft Java 26.1 超平坦测试服上使用。`npm run build:creative` 启动一个专用于施工的 Bot，按低层到高层比较蓝图和现场。Bot 寻找相邻支撑面，核对射线能否击中那一面，飞到可以点击的位置，再用创造栏里的材料逐块右键。每次放置都等待服务器方块状态，暂时够不到的点会在第一遍结束后重试。 [Baritone BuilderProcess](https://github.com/cabaletta/baritone/blob/1.21.4/src/main/java/baritone/process/BuilderProcess.java)

## 在 Mac 或 Windows 准备样图

在 `collab` 工作树运行 `npm ci` 和 `npm run test:creative-build`。测试在本地验证蓝图解析和放置计算。生成一份 9 格的小样图用于实机测试。

```sh
fixture_dir="$(mktemp -d)"
node scripts/test-creative-build.js --fixture "$fixture_dir/demo.litematic"
npm run build:creative -- --inspect "$fixture_dir/demo.litematic"
```

Windows PowerShell 生成同样的样图。

```powershell
$fixture = Join-Path $env:TEMP ('nmo-creative-' + [guid]::NewGuid().ToString('N') + '.litematic')
node scripts/test-creative-build.js --fixture $fixture
npm run build:creative -- --inspect $fixture
```

`--inspect` 无需连接服务器，会显示蓝图的坐标范围、需放置方块数和跳过的数据量。雪花殿堂原文件需要在本机提供；接力测试时可以先用上述样图。

## 启动施工和旁观

在新开的本地测试服上使用以下属性。常见的四层超平坦地图里第一个可建造的 Y 坐标是 `-60`。建立世界后可先用 `/execute if block 0 -60 0 minecraft:air` 检查原点，并把测试服出生点设到附近。

```properties
server-ip=127.0.0.1
server-port=25567
online-mode=false
enforce-secure-profile=false
level-type=minecraft:flat
generate-structures=false
gamemode=creative
difficulty=peaceful
```

在服务器控制台执行 `gamerule minecraft:spawn_mobs false` 和 `setworldspawn 0 -60 0`。普通玩家客户端连接 `127.0.0.1:25567`。启动后如果 Bot 进的是生存或旁观模式，可在 20 秒内由服务器管理员运行 `gamemode creative NMO-Builder`。Bot 应从工地附近开始，附近区块需已载入。

```sh
npm run build:creative -- "$fixture_dir/demo.litematic" 0 -60 0
```

在 PowerShell 中使用上一步生成的 `$fixture`。

```powershell
npm run build:creative -- $fixture 0 -60 0
```

原点参数对应 Litematica 的选区原点。负尺寸和偏移子区域会保留各自的相对位置。默认用 `NMO-Builder`、`127.0.0.1:25567` 和 26.1，亦可通过 `MC_USERNAME`、`MC_HOST`、`MC_PORT`、`MC_VERSION` 设置。此入口面向独立测试服的离线 Bot 登录。

需要替换施工点原有方块时，在蓝图文件名前加 `--replace-existing`。Bot 会逐块比较目标，再挖掉施工格内方块种类或状态不匹配的旧块并放上正确材料。模式只处理蓝图明确要求放置方块的坐标。符合蓝图的方块直接计入 `existing`，蓝图空气格与选区外方块保留原状。启用前请核对原点和施工区。

```sh
npm run build:creative -- --replace-existing "$fixture_dir/demo.litematic" 0 -60 0
```

在服务器控制台先执行 `gamemode spectator NMOViewer`，再执行 `spectate NMO-Builder NMOViewer`，即可从 Bot 视角看真实放置。按 Shift 可以退出跟随。

## 验收与继续施工

- 看终端的 `BUILD_PROGRESS` 和 `BUILD_FINISHED`。样图从空地开始时应达到 `placed=9`、`pending=0`。以相同原点再运行一次时应为 `existing=9`、`placed=0`。`cleared` 记录本次清除的旧方块数。
- 可用 `execute if block 2 -59 0 minecraft:smooth_quartz_stairs[facing=east,half=top,shape=straight,waterlogged=false]` 检查带属性的目标方块。
- `Ctrl+C` 可以结束客户端。再次使用同一文件、服务器和原点会按世界里的现有方块续建。开新世界或更换蓝图时先核对原点和已有建筑。
- 仍有未完成的格子时进程退出码为 `2`，终端列出前 20 个 `BUILD_UNRESOLVED`，包括位置、方块和原因。默认保留开工前已存在的异物。启用替换后，无法挖掘、遮挡或够不着的方块会留待后续处理。
- 本入口支持 Litematic v6 原版方块。实体、容器内容及其他方块实体附加数据会跳过。水流、重力和相邻更新仍按服务器的 Minecraft 规则执行。小型 `.nbt` 生存补给站继续走原有入口。
