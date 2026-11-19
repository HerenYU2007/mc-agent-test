# macOS Codex 接手指南

你要协作维护的是 `HerenYU2007/mc-agent-test` 的 `collab` 分支。Mac 使用 `AndyMaa` 的 GitHub 账号，通过 Node.js 同步器每 30 秒检查一次。另一台电脑使用 Windows PowerShell，同步同一个分支并共用同一套文件锁。 [GitHub 仓库的 `collab` 分支](https://github.com/HerenYU2007/mc-agent-test/tree/collab)

## 首次接入

1. 在 Mac 终端确认 `git --version` 和 `node --version` 能运行。使用近期 Git 和 Node.js 22 或以上版本。检查已有 GitHub 凭据是否属于 `AndyMaa`。若需要为 HTTPS 登录，并且本机已安装 GitHub CLI，请让机主在浏览器中完成登录，再配置 Git 使用该凭据。检查下面两行查询的输出分别为 `AndyMaa` 和 `true`。 [GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login) · [配置 Git 凭据](https://cli.github.com/manual/gh_auth_setup-git)

   ```sh
   gh auth login --hostname github.com --git-protocol https --web
   gh auth setup-git --hostname github.com
   gh api user --jq .login
   gh api repos/HerenYU2007/mc-agent-test --jq .permissions.push
   ```

2. 在存放代码的目录克隆 `collab`。用 Codex 打开克隆得到的仓库根目录，确认 `origin` 指向 `HerenYU2007/mc-agent-test`，当前分支为 `collab`，再读 `AGENTS.md`。已有同名目录时，先检查它的远程和分支，再决定是否使用现有工作树。每个工作树同时安排一个编辑任务。

   ```sh
   git clone --branch collab https://github.com/HerenYU2007/mc-agent-test.git mc-agent-collab
   cd mc-agent-collab
   git remote get-url origin
   git branch --show-current
   git status --short --branch
   node scripts/auto-sync-macos.js check
   node scripts/file-lock.js status
   ```

3. 如 Git 提交身份缺失，用机主指定的名字和 GitHub 提交邮箱设置本仓库的 `user.name` 与 `user.email`。身份用于署名，写入权限由 GitHub 登录凭据决定。密钥和 Token 留在本机凭据管理器或项目忽略的本地文件中。

4. 在仓库根目录启动同步器并保持终端开启。同步由同一个 Node.js 进程持续执行。

   ```sh
   node scripts/auto-sync-macos.js start
   ```

## 每次修改的顺序

### 1. 先同步，再抢锁

读取和搜索可以直接进行。第一次写文件前，让同步器先接收远程提交，再列出本次会改动的全部路径，包括新增、删除、重命名前后和生成器会写入的跟踪文件。把示例路径换成实际路径。只有命令成功并列出每个文件“可以编辑”，才开始写文件。

```sh
node scripts/file-lock.js acquire -- agent/combat.js agent/combat-defence.js
```

如果正在继续一项持锁任务且已有改动，先用 `git status` 和 `node scripts/file-lock.js status` 确认它们归属原任务，保留现有改动与锁。若有路径被另一台电脑持锁，等待或改做其他文件。若脚本提示“已持锁，但远程 collab 在抢锁时更新”，等工作树同步后重复申请，见到“可以编辑”再动手。

### 2. 编辑、检查，等待自动推送

新增修改范围前先申请相应文件的锁。涉及 Agent 代码时运行 `npm run test:syntax`，其他改动按任务跑相关测试。`.env`、密钥、日志、缓存、编译产物和 Finder 生成的文件留在本地。需要先做成套修改或通过测试再发布时，用 `stop` 暂停同步，完成后再用 `start` 恢复。

同步器会等待文件内容和暂存状态至少稳定 30 秒，核对文件锁，再提交并推送。碰到对方先推送时，同步器保留本地提交，下一轮取回更新和合并。发现未持锁修改时，同步器会报告路径并等待。遇到合并冲突时，先用 `git status` 定位，保留双方内容和现有锁。协调解决并提交后，同步器会继续运行。禁止强推、硬重置、递归清理工作树或直接修改锁分支。 [Git 合并与冲突处理](https://git-scm.com/docs/git-merge#_pre_merge_checks)

### 3. 确认远程收到提交后解锁

本次所有编辑完成且看到“已推送 collab”后，用同一工作树执行 `release`。它会从 GitHub 核对本地提交已经在远程 `collab` 上，并确认目标路径与远程一致。这次没有产生改动时，可直接运行 `release` 核对并释放。

```sh
node scripts/file-lock.js release -- agent/combat.js agent/combat-defence.js
node scripts/file-lock.js status
```

脚本报告解锁失败时，根据输出检查网络、GitHub 登录、未提交改动和未推送提交。暂停或掉线时保留锁，恢复后使用原工作树。`codex-file-locks` 分支由脚本维护，首次成功申请锁时自动建立。

## 停止、重启与日志

在启动终端按 `Ctrl+C`，或在同一仓库的另一个终端运行 `stop`。需要重启时运行 `restart`，并保持新终端开启。异常关闭后可以从原工作树重新运行 `start`，Git 中已有的提交和文件锁会继续使用。

```sh
node scripts/auto-sync-macos.js stop
node scripts/auto-sync-macos.js restart
```

日志位于当前工作树的 Git 元数据目录，独立 worktree 可通过以下命令定位。达到 2 MB 时轮换到同目录的 `sync.previous.log`。

```sh
tail -n 30 "$(git rev-parse --absolute-git-dir)/codex-auto-sync-macos/sync.log"
```

## 仓库入口

- `AGENTS.md` 规定共享协作流程。Mac 端运行本指南的 Node.js 同步器。
- `docs/AI-HANDOFF.md` 说明 Agent 模块分工、运行环境与回归验收。
- `docs/FILE-LOCKS.md` 说明锁的规则和排障方式。`node scripts/test-auto-sync-macos.js` 在临时本地仓库验证同步器，`node scripts/test-file-lock.js` 验证锁功能。
