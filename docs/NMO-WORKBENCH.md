# 用 NMO 赛事 API 合成第一张工作台

在仓库根目录使用 Node.js 22 或更新版本。运行 `npm run nmo:workbench` 会通过赛事 HTTP API 控制皮肤站角色。这个入口只用 Node 内置模块，找树和合成由确定性逻辑完成。原有本机 Mineflayer Agent 仍可用 `npm run agent` 启动。

## 登录和运行

在本机仓库根目录的 `.env` 设置下列两项。Git 会忽略这个文件。也可以在当前终端设置同名环境变量。

```dotenv
MC_AGENT_USERNAME=你的皮肤站用户名
MC_AGENT_PASSWORD=你的皮肤站密码
```

手头已有有效会话时，只设置 `MC_AGENT_TOKEN` 即可，程序会优先使用它。账号密码登录会使同角色的旧 token 失效，任务结束时会登出自己创建的会话。传入已有 token 时，任务结束后保留该会话。

```sh
npm run nmo:workbench
```

默认入口是赛事教学包给出的 `https://mc-api.windywindie.top/api/v1`。组委会另发练习服地址时，用 `MC_AGENT_API_URL` 设置包含 `/api/v1` 的完整地址。远程地址使用 HTTPS，本机回环地址也可以使用 HTTP。

## 怎样判断跑通

空背包时，程序等待角色就绪、存活且空闲，通过 `find_blocks` 查询暴露树干，向观测坐标移动，到达后再用 `get_block` 核对方块。它调用 `dig` 拾取原木，用对应树种合成木板，再合成工作台。终端会打印树干坐标和实际背包增量。最后出现 `背包确认合成 crafting_table × 1` 且退出码为 0，表示背包已收到工作台。

已有原木或木板时会接着当前背包继续。已有工作台时直接报告数量。角色处于旁观模式会停止并提示切换到生存模式。没有找到可采集的树时会逐步把半径扩大到 64 格，寻路失败时尝试其他观测到的树干。动作请求中断后可重新运行，程序会重新查询背包。

## 本地回归

```sh
npm run test:nmo-workbench
npm run test:syntax
```

第一条命令在本机临时 HTTP 端口模拟赛事 API，覆盖空背包起步、受保护树干、已有材料、会话鉴权和动作中断等情形。测试采用独立的模拟凭据和背包。赛事服验收时运行上面的 `nmo:workbench` 命令。

协议字段见比赛教学包的 `reference/API_群文件_v1.3.md` 及[上游 API 文档](https://github.com/Zyzzyva0381/mc-agent-api/blob/main/docs/API.md)。
