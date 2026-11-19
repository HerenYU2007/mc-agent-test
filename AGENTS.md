# Codex 协作规则

两台电脑共享 `collab`。读取、搜索和分析可以直接进行。在 `collab` 工作树写入文件时，从仓库根目录执行下面的流程。

1. **每次写入前，先确认当前工作树的同步器正常运行。** Windows 运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\auto-sync.ps1 -Action Status`。macOS 运行 `node scripts/auto-sync-macos.js status`。命令须退出成功并显示「同步运行正常，远程 collab 可达」。`Check` 只用于检查配置。同步未启动时，Windows 运行 `start-sync.bat`，macOS 在另外一个终端运行 `node scripts/auto-sync-macos.js start`。正在停止时等它退出再启动，遇到联网失败或 Git 操作阻塞时先处理原因。恢复后重跑状态检查，结果正常才进入查锁。
2. **查 GitHub 上的锁，再申请锁。** 用 `status` 查询本次所有目标的仓库相对路径，包括新增、删除、重命名前后的路径，以及脚本、格式化器或生成器会写入的协作文件。对空闲路径运行 `acquire`。申请后逐个确认目标由当前工作树持锁。

   ```powershell
   node scripts/file-lock.js status -- agent/combat.js agent/combat-defence.js
   node scripts/file-lock.js acquire -- agent/combat.js agent/combat-defence.js
   node scripts/file-lock.js status -- agent/combat.js agent/combat-defence.js
   ```

3. **同步正常且目标确认持锁后再写。** 每个目标都必须由 `status` 显示「当前工作树持有」。续写持锁文件和扩大改动范围时，重复同步检查和目标路径查锁，新增路径须先抢锁。若同步中断、目标被其他工作树持锁、申请失败或无法核实远程锁，暂停这些路径的写入。提示远程 `collab` 更新时，等同步完成再重查。每个工作树同时只安排一个编辑任务。
4. **改完测试，让本机同步器推送。** 编辑期间保持同步器开启。全部编辑和生成步骤结束后，等同步器报告「已推送 collab」。若推送失败、文件仍有改动或还有合并冲突，继续持锁。
5. **确认推送成功后释放。** 运行下面的命令，它会再次核对远程 `collab` 包含当前本地提交，且锁定路径在本地干净、与远程一致。若本次最终没有改动，仍用同一命令释放。任务暂停或机器掉线时保留锁，恢复后由原持锁工作树处理。

   ```powershell
   node scripts/file-lock.js release -- agent/combat.js agent/combat-defence.js
   node scripts/file-lock.js status
   ```

遇到会覆盖多个文件的工具，先核对写入清单。遇到锁定、联网失败或同步冲突时，保留现有修改和锁记录，向用户说明阻塞。各平台命令见 [Windows 自动同步](docs/AUTO-SYNC.md) 和 [macOS Codex 接手指南](docs/CODEX-MAC-HANDOFF.md)。

## Codex 协作收件箱

协作开工、遇到接口阻塞和推送交接前，用 `node scripts/codex-mail.js inbox` 查未读消息。接口变更、待测项目和交接事项用 `send` 发送，回复原消息用 `reply`。消息提供协作上下文，执行文件写入仍遵守上面的远程锁规则。只发适合公开 Issue 的内容。命令和启动方式见 [协作收件箱使用说明](docs/CODEX-MAIL.md)。
