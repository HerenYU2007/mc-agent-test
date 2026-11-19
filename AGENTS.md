# Codex 协作规则

两台电脑共享 `collab`。读取、搜索和分析可以直接进行。在 `collab` 工作树写入文件时，从仓库根目录执行下面的流程。

1. **每次写入前先查 GitHub 上的锁。** 用 `status` 查询本次所有目标的仓库相对路径，包括新增、删除、重命名前后的路径，以及脚本、格式化器或生成器会写入的协作文件。路径空闲时，先用 `acquire` 申请锁。

   ```powershell
   node scripts/file-lock.js status -- agent/combat.js agent/combat-defence.js
   node scripts/file-lock.js acquire -- agent/combat.js agent/combat-defence.js
   ```

2. **逐个确认当前工作树持锁后再写。** 每个目标都必须由 `status` 显示“当前工作树持有”，或由成功的 `acquire` 显示“可以编辑”。若其他工作树持锁、申请失败或无法核实远程锁状态，暂停写入这些路径。提示 `collab` 更新时，等待同步后重新检查。扩大改动范围前，先查并锁定新增路径。每个工作树同时只安排一个编辑任务。
3. **改完测试，通过本机的同步器推送。** Windows 双击 `start-sync.bat`，macOS 运行 `node scripts/auto-sync-macos.js start`。全部编辑和生成步骤结束后，等同步器报告“已推送 collab”。若推送失败、文件仍有改动或还有合并冲突，继续持锁。
4. **确认推送成功后释放。** 运行下面的命令，它会再次核对远程 `collab` 包含当前本地提交，且锁定路径在本地干净、与远程一致。若本次最终没有改动，仍用同一命令释放。任务暂停或机器掉线时保留锁，恢复后由原持锁工作树处理。

   ```powershell
   node scripts/file-lock.js release -- agent/combat.js agent/combat-defence.js
   node scripts/file-lock.js status
   ```

遇到会覆盖多个文件的工具，先核对写入清单。遇到锁定、联网失败或同步冲突时，保留现有修改和锁记录，向用户说明阻塞。各平台命令见 [Windows 自动同步](docs/AUTO-SYNC.md) 和 [macOS Codex 接手指南](docs/CODEX-MAC-HANDOFF.md)。
