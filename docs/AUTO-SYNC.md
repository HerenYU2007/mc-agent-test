# 两台 Windows 电脑自动同步 `collab`

在两台电脑上分别打开此项目的 `collab` 工作树并运行同步器。它在一个 PowerShell 进程内持续运行，默认每 30 秒检查一轮。日常编辑可以继续交给 Codex，PowerShell 负责同步已经保存到磁盘的文件。

使用 macOS 的协作者请按 [macOS Codex 接手指南](CODEX-MAC-HANDOFF.md) 启动 Node.js 同步器。两种同步器共用 `collab` 分支和文件锁。

每次写入共享文件前，先在当前工作树运行 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\auto-sync.ps1 -Action Status`。看到「同步运行正常，远程 collab 可达」后，再查询和申请目标锁。逐个确认持锁后才编辑。等同步器发布提交后，用文件锁脚本确认远程已包含修改，再释放。 [跨电脑文件锁](FILE-LOCKS.md)

## 第一台电脑

在 Codex 中打开 `mc-agent-collab` 仓库根目录。在该目录的 PowerShell 中执行以下命令，检查当前工作树、分支、远程配置、Git 提交身份与忽略规则。独立 Git worktree 也可以使用，脚本会读 Git 返回的实际元数据目录。

```powershell
git branch --show-current
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\auto-sync.ps1 -Action Check
```

输出的分支应为 `collab`。若 Git 提交身份缺失，在当前仓库配置自己的身份，然后重复检查。此身份用于标记提交作者，GitHub 登录由本机已有的 Git 凭据管理器处理。

```powershell
git config user.name "你的名字"
git config user.email "你的 Git 提交邮箱"
```

你准备好把本地 `collab` 提交发布到 GitHub 时，双击 `start-sync.bat`，让窗口保持打开。远程分支尚未存在时，第一次成功的普通推送会创建它，并发布本地 `collab` 可达的历史。看到“已推送 collab”后，再配置第二台电脑。

## 第二台电脑

在准备存放项目的目录执行下面的命令，然后用 Codex 打开新生成的 `mc-agent-collab` 目录。使用已有 Git 凭据登录，必要时先完成 Git Credential Manager 的登录提示。

```powershell
git clone --branch collab https://github.com/HerenYU2007/mc-agent-test.git mc-agent-collab
Set-Location .\mc-agent-collab
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\auto-sync.ps1 -Action Check
```

检查通过后双击 `start-sync.bat`。如果你已在这台电脑上检出项目，也可以在现有仓库中执行 `git fetch origin`，再选择现有的 `collab` 工作树。分支尚未在该仓库建立时，可以用 `git switch --track origin/collab` 创建并切换，或用 `git worktree add --track -b collab <目录> origin/collab` 新建独立工作树。一个仓库中的同一分支通常只能被一个工作树检出。启动时以 `-Action Check` 显示的工作树根目录为准。

## 运行、停止、重启和日志

| 操作 | 方法 |
| --- | --- |
| 启动 | 双击 `start-sync.bat`，保持窗口打开 |
| 停止 | 双击 `stop-sync.bat`，等待启动窗口报告停止 |
| 重启 | 在仓库根目录运行下面的 `-Action Restart` 命令，保持新窗口打开 |
| 只检查本地配置 | 运行 `-Action Check` |
| 编辑前确认同步运行 | 运行 `-Action Status`，确认当前工作树的进程和远程 `collab` 状态 |
| 查看日志 | 用下面的命令定位当前工作树的 `sync.log` |

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\auto-sync.ps1 -Action Restart
$gitDir = git rev-parse --absolute-git-dir
Get-Content -LiteralPath (Join-Path $gitDir 'codex-auto-sync\sync.log') -Encoding UTF8 -Tail 30
```

日志达到 2 MB 会轮换到同目录的 `sync.previous.log`。同一工作树的第二次启动会被拦截。电脑关机、PowerShell 窗口关闭或进程异常退出后，再次双击启动即可从 Git 现有状态继续。网络或认证失败时，已经生成的提交仍在本地，下一轮会重新检查远程。若 Git 凭据过期，可在普通终端手动运行 `git ls-remote origin` 完成登录，然后让同步器重试。

## 文件稳定与同步顺序

- 每轮先查询 GitHub 上的 `collab`。本地有变化时，至少间隔 30 秒取得相同的内容哈希、文件时间戳和暂存状态后才会提交。文件继续写入时会重新计时。Codex 未保存的编辑缓冲区无法通过 Git 同步。
- 如果手动暂存了部分修改，同步器会先提交已经稳定的暂存内容，其余内容等下一次稳定检查。写入共享文件时保持同步器开启。若同步被停止，先恢复并复查进程和文件锁，再续写。
- 只有工作树干净时才合并远程分支。远程领先时快进，本地和远程各有提交时尝试普通合并。如果远程新跟踪的路径与本地已忽略文件重合，Git 会暂停合并并保留本地文件。先把本地文件移到另一个目录，再等待重试。推送使用普通 Git 推送，如果另一台电脑刚先推了一步，本地提交会保留到下轮再同步。

## 合并冲突

发生冲突时，Git 会保留双方提交和冲突文件，同步器会停在合并现场并记录日志。运行 `git status` 查看文件。用编辑器处理冲突，确认需要的双方修改都在之后，再暂存并提交。以下命令中的路径换成实际冲突文件。

```powershell
git status
git add -- "agent/实际冲突文件.js"
git commit --no-edit
```

确认 `git status` 中的合并已经完成，运行中的同步器会在后续轮次继续。两台电脑分工时，尽量各自负责不同功能文件，减少同时修改同一代码段。

## 密钥和生成文件

`.gitignore` 覆盖 `.env`、常见密钥文件、依赖目录、缓存、编译和运行产物。预检会检查代表性路径，提交和推送前还会检查敏感路径和常见明文凭据格式。可用 `git check-ignore -v -- .env` 检查单个路径。`.env.example` 只应填写变量名和示例占位值。

如果日志提示某个文件或旧提交被拦截，先用 `git status` 或 `git log --oneline` 定位。若真实密钥曾被提交，先轮换密钥，再检查如何清理待发布历史。凭据格式检测依赖已知规则，自定义格式的密钥也应放在 Git 忽略的文件中。
