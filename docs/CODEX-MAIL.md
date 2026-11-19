# Codex 协作收件箱

Windows 的 `HerenYU2007` 和 Mac 的 `AndyMaa` 通过同一个 [协作 Issue #1](https://github.com/HerenYU2007/mc-agent-test/issues/1) 交换接口变化、提交编号、测试结果、阻塞和交接事项。收件器以实际登录的 GitHub 账号识别当前这一端，只接收另一协作账号发给本端的结构化评论。Issue 是公开可读的，凭据、私有文件内容和完整本机日志请保留在本地。

## 启动与查看状态

1. 把本地 `collab` 更新到最新。进入 Git 工作树的仓库根目录，准备 Git 和 Node.js 22 或更高版本。
2. 使用本机已有的 GitHub HTTPS 凭据。需要登录时，可使用 Git Credential Manager，或在安装了 GitHub CLI 的电脑执行 `gh auth login --hostname github.com --git-protocol https --web` 和 `gh auth setup-git --hostname github.com`。通过 `status` 确认 Mac 登录为 `AndyMaa`，Windows 登录为 `HerenYU2007`。 [GitHub CLI 登录说明](https://cli.github.com/manual/gh_auth_login)
3. 在专用终端运行 `watch`，保持该进程运行。它启动时查询一次，随后每 30 秒查询新评论。代码仍由原有 `collab` 同步器同步，文件锁仍按 `AGENTS.md` 执行。每个工作树运行一个收件器即可。

```sh
node scripts/codex-mail.js status
node scripts/codex-mail.js watch
```

在另一个终端再运行 `status`，可看到最近成功收取的 `checkedAt` 和未读数。按 `Ctrl+C`，或执行 `node scripts/codex-mail.js stop`，可让收件器在当前查询结束后停止。缓存与已读标记保存在该工作树的 Git 元数据目录下，重启收件器后会继续使用。

## 发消息、查未读和回复

以下是命令示例。发布前替换成实际协作内容。

```sh
node scripts/codex-mail.js inbox
node scripts/codex-mail.js send "逐块建造联调" "BUILD_PROGRESS 调整了 target 字段，请验证 Mac 样图。提交 4465008。"
node scripts/codex-mail.js reply 1234567890 "收到。样图通过，9 个目标方块状态一致。"
node scripts/codex-mail.js read 1234567890
```

- `inbox` 会立即查询一次 GitHub，并显示未读中的前 20 条，包括原评论链接、消息 ID 和所回复的 ID。可在开工、遇到阻塞或交接前主动运行。
- `send` 默认发给另一个协作账号。发接口变更时带上相关文件、字段名或提交编号，便于对方复现。
- `reply` 使用 `inbox` 返回的原消息 ID。GitHub 确认回复后，原消息会标记为已读。如果输出 `readReceiptPending`，消息已发出，可单独运行 `read` 补写本地已读标记。
- `read` 只更新本工作树的已读状态。希望对方知道已经接手时，用 `reply` 回执。需要更正已发内容时，发一条新回复，便于双方跟踪。

收件器只负责轮询和缓存。打开的 Codex 在处理相关任务时读写消息。可运行 `node scripts/test-codex-mail.js` 在本地验证双向收发、分页、去重、回复和未读行为；测试使用模拟 API。
