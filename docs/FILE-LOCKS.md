# `collab` 跨电脑文件锁

Windows 和 macOS 分别在自己的 `collab` 工作树使用 Node.js 和现有 Git 凭据。远程 `collab` 已发布后才可申请锁。两台电脑拿到同版脚本和 `AGENTS.md` 后，把项目根目录作为 Codex 工作目录。每个工作树同时安排一个编辑任务。

```powershell
# 查看所有锁，也可以在 status 后列出要查询的路径
node scripts/file-lock.js status

# 一次申请多个文件。退出码为 0 后再写文件
node scripts/file-lock.js acquire -- agent/combat.js "agent/带空格的文件.js"

# 完成修改后等待原有同步器提交和推送，再释放
node scripts/file-lock.js release -- agent/combat.js "agent/带空格的文件.js"
```

申请时，脚本会核对工作树与远程 `collab`，并检查新申请路径是否干净。远程刚有新提交时，先等本机同步器完成同步，再重复申请。Windows 使用 `start-sync.bat`，macOS 使用 `node scripts/auto-sync-macos.js start`。若提示“已持锁，但远程 collab 在抢锁时更新”，说明锁已保留给当前工作树。等同步完成，重新执行 `acquire` 并看到“可以编辑”后再动手。

释放前，脚本从远程重新读取 `collab`，确认当前本地 `HEAD` 已包含在该分支的历史里、目标文件与远程版本一致，且目标文件没有待提交的修改。它会等待本地提交全部发布，即使尚未发布的提交只改了别的文件。断网、提交未推送、或人在执行 Git 合并时，保留锁并在恢复后重试。

`codex-file-locks` 分支记录锁定路径和随机工作树标识。它使用普通的快进推送来排他地更新整批锁。两个客户端同时从同一状态申请同一路径，只有一个更新能被远程接受。锁分支的提交只包含锁元数据。该分支需要两台电脑都有写权限，并允许普通的快进推送。 [Git 推送与快进规则](https://git-scm.com/docs/git-push#_note_about_fast_forwards)

锁没有自动过期时间，掉线的工作树可能仍有未发布的修改。重新打开原工作树即可识别原来的锁。若工作树丢失，先由双方核查未发布的修改和远程版本，再联系仓库维护者处理；日常使用请保留 `.git` 元数据。文件锁通过 `AGENTS.md` 约束 Codex 写入。同一个工作树内的编辑任务、手工写入和绕过规则的工具需要遵守同一约定。

## 本地测试

在项目根目录运行 `node scripts/test-file-lock.js`。测试自行创建临时 bare 远程和独立工作树，使用临时文本文件模拟对同一个路径的竞争、推送后释放和接手编辑。在 Windows 上也会启动原有 PowerShell 同步器进行推送测试。
