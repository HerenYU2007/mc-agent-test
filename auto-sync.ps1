[CmdletBinding()]
param(
    [ValidateSet('Start', 'Stop', 'Restart', 'Check')]
    [string]$Action = 'Start',
    [ValidateRange(1, 3600)][int]$IntervalSeconds = 30,
    [ValidateRange(1, 3600)][int]$StableSeconds = 30,
    [switch]$AllowLocalRemote
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\', '/')
$branch = 'collab'
$remoteRef = 'refs/heads/collab'
$script:runId = $null
$script:lastSnapshot = $null
$script:stagedBySync = $null
$checkedBlobs = [Collections.Generic.HashSet[string]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)

function ConvertTo-ProcessArgument([string]$Text) {
    if ($Text -ne '' -and $Text -notmatch '[\s"]') { return $Text }
    $escaped = $Text -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Invoke-Git {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [int[]]$Allowed = @(0),
        [switch]$Network
    )

    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $gitExe
    $info.WorkingDirectory = $root
    $tokens = @('-C', $root)
    if ($Arguments[0] -ne 'check-ignore') { $tokens += '--literal-pathspecs' }
    $tokens += $Arguments
    $info.Arguments = ($tokens | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = $utf8
    $info.StandardErrorEncoding = $utf8
    $info.EnvironmentVariables['GIT_TERMINAL_PROMPT'] = '0'
    $info.EnvironmentVariables['GCM_INTERACTIVE'] = 'Never'
    $info.EnvironmentVariables['GIT_OPTIONAL_LOCKS'] = '0'
    $info.EnvironmentVariables['GIT_EDITOR'] = 'true'
    $process = [Diagnostics.Process]::Start($info)
    try {
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if ($Network -and -not $process.WaitForExit(90000)) {
            $process.Kill()
            throw "Git $($Arguments[0]) 网络操作超时。下轮会重新核对远程。"
        }
        $process.WaitForExit()
        $null = $errors.GetAwaiter().GetResult()
        $result = [pscustomobject]@{
            Code = $process.ExitCode
            Text = $output.GetAwaiter().GetResult()
        }
        if ($Allowed -notcontains $result.Code) {
            # Git 错误正文可能包含凭据或敏感 URL，只记录命令名和退出码。
            throw "Git $($Arguments[0]) 失败，退出码 $($result.Code)。"
        }
        return $result
    } finally {
        $process.Dispose()
    }
}

function Split-GitRecords([string]$Text) {
    if ($Text.Length) { $Text.Split([char[]]@([char]0), [StringSplitOptions]::RemoveEmptyEntries) }
}

function Get-RemoteIdentity {
    $fetch = @((Invoke-Git @('remote', 'get-url', '--all', 'origin')).Text.Trim() -split '\r?\n')
    $push = @((Invoke-Git @('remote', 'get-url', '--push', '--all', 'origin')).Text.Trim() -split '\r?\n')
    if ($fetch.Count -ne 1 -or $push.Count -ne 1 -or $fetch[0] -cne $push[0]) {
        throw 'origin 必须只有一个地址，拉取与推送地址必须一致。'
    }
    $url = $fetch[0]
    $github = '^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/|ssh://git@ssh\.github\.com:443/)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/?$'
    if ($AllowLocalRemote) {
        if (-not [IO.Path]::IsPathRooted($url) -or $url.StartsWith('\\') -or
            -not (Test-Path -LiteralPath $url -PathType Container)) {
            throw '测试模式只允许本机绝对目录形式的 origin。'
        }
    } elseif ($url -notmatch $github) {
        throw 'origin 必须是无内嵌凭据的 GitHub HTTPS 或 SSH 地址。'
    }
    return $url
}

function Assert-Worktree {
    $actual = (Invoke-Git @('rev-parse', '--show-toplevel')).Text.Trim()
    $resolved = [IO.Path]::GetFullPath($actual).TrimEnd('\', '/')
    if ($resolved -ine $root) { throw '请从这个项目的 Git 根目录启动。无法同步上一级仓库。' }
    return (Invoke-Git @('rev-parse', '--absolute-git-dir')).Text.Trim()
}

function Assert-SyncTarget {
    if ((Assert-Worktree) -cne $gitDir) { throw '检测到工作树的 Git 元数据路径发生变化，已暂停。' }
    $current = Invoke-Git @('symbolic-ref', '--quiet', '--short', 'HEAD') -Allowed @(0, 1)
    if ($current.Code -ne 0 -or $current.Text.Trim() -cne $branch) {
        throw '当前工作树必须检出 collab 分支。同步器不会替你切换分支。'
    }
    if ((Get-RemoteIdentity) -cne $expectedRemote) { throw 'origin 地址发生变化，已暂停。' }
}

function Get-GitOperation {
    foreach ($name in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer', 'BISECT_START', 'index.lock')) {
        if (Test-Path -LiteralPath (Join-Path $gitDir $name)) { return $name }
    }
    if ((Invoke-Git @('ls-files', '--unmerged', '-z')).Text.Length) { return '未解决的冲突' }
    return $null
}

function Assert-IgnoreCoverage {
    foreach ($item in @('.env', 'config/.env.local', 'certs/private.pem', 'keys/id_ed25519', 'cache/.cache/index', 'node_modules/pkg/index.js', 'observer-mod/build/output.jar', 'build/output.exe', 'dist/bundle.js')) {
        $result = Invoke-Git @('check-ignore', '--no-index', '-q', '--', $item) -Allowed @(0, 1)
        if ($result.Code -ne 0) { throw ".gitignore 需要覆盖 $item。" }
    }
}

function Test-BlockedPath([string]$Path) {
    $leaf = ($Path -split '/')[-1]
    if ($Path -match '(?:^|/)(?:node_modules|\.cache|\.gradle|\.pytest_cache|\.mypy_cache|__pycache__|build|dist|out)(?:/|$)') {
        return $true
    }
    if ($leaf -ieq '.env.example') { return $false }
    return $leaf -match '^(?:\.env(?:$|\.)|id_(?:rsa|ed25519|ecdsa|dsa)(?:$|\.)|(?:credentials|secrets)\.json$)' -or
        $leaf -match '\.(?:pem|key|pfx|p12|token|log|jsonl|jar|class|zip|pyc)$'
}

function Assert-SafeChanges([string[]]$Difference) {
    $names = Split-GitRecords (Invoke-Git (@('diff-tree', '--no-commit-id', '--no-renames', '-r', '-z', '--name-only', '--diff-filter=ACMRT') + $Difference + @('--'))).Text
    $tree = $Difference[-1]
    foreach ($name in $names) {
        if (Test-BlockedPath $name) { throw "内容检查阻止同步：$name 属于敏感文件或生成产物。" }
        $entry = (Invoke-Git @('ls-tree', '-z', $tree, '--', $name)).Text
        if ($entry -notmatch '^\d+ blob ([0-9a-f]+)\t') { throw "内容检查无法确认普通 Git 文件：$name。" }
        $blob = $Matches[1]
        if ($checkedBlobs.Contains($blob)) { continue }
        $body = (Invoke-Git @('cat-file', 'blob', $blob)).Text
        $keyLike = '(?i)(?:sk-(?:proj-|svcacct-)?[a-z0-9_-]{24,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|https?://[^/\s:@]+:[^/\s@]+@)'
        if ($body -match $keyLike) { throw "内容检查发现疑似凭据：$name。日志不会输出凭据。" }
        $null = $checkedBlobs.Add($blob)
    }
}

function Assert-SafeHistory([string]$Tip, [string]$Exclude) {
    $revision = @('rev-list', '--reverse', $Tip)
    if ($Exclude) { $revision += @('--not', $Exclude) }
    $history = (Invoke-Git $revision).Text.Trim() -split '\r?\n'
    foreach ($commit in $history) {
        if (-not $commit) { continue }
        $parents = (Invoke-Git @('rev-list', '--parents', '-n', '1', $commit)).Text.Trim().Split(' ')
        if ($parents.Length -eq 1) {
            Assert-SafeChanges @('--root', $commit)
        } else {
            foreach ($parent in $parents[1..($parents.Length - 1)]) {
                Assert-SafeChanges @($parent, $commit)
            }
        }
    }
}

function Get-ContentHash([string]$Path) {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = [IO.File]::Open($Path, 'Open', 'Read', $share)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')
    } finally {
        $sha.Dispose()
        $stream.Dispose()
    }
}

function Get-Snapshot {
    $status = (Invoke-Git @('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none')).Text
    $paths = @((Split-GitRecords $status) | ForEach-Object { $_.Substring(3) } | Sort-Object -CaseSensitive -Unique)
    $parts = foreach ($file in $paths) {
        $absolute = [IO.Path]::GetFullPath((Join-Path $root $file))
        if (-not $absolute.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '检测到工作树以外的路径。' }
        $info = Get-Item -LiteralPath $absolute -Force -ErrorAction SilentlyContinue
        if (-not $info) {
            [pscustomobject]@{ File = $file; Missing = $true }
            continue
        }
        if ($info.PSIsContainer -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "暂缓自动提交目录或重解析点：$file。"
        }
        if (Test-BlockedPath $file) { throw "暂缓自动提交：$file 属于敏感文件或生成产物。" }
        $length = $info.Length
        $writeTime = $info.LastWriteTimeUtc.Ticks
        $hash = Get-ContentHash $absolute
        $info.Refresh()
        if (-not $info.Exists -or $length -ne $info.Length -or $writeTime -ne $info.LastWriteTimeUtc.Ticks) {
            throw "文件仍在修改，等待下一轮：$file。"
        }
        [pscustomobject]@{ File = $file; Length = $length; Time = $writeTime; Hash = $hash }
    }
    $staged = (Invoke-Git @('diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD', '--')).Text
    $head = (Invoke-Git @('rev-parse', 'HEAD')).Text.Trim()
    return [pscustomobject]@{
        Head = $head
        Dirty = $status.Length -gt 0
        Staged = $staged.Length -gt 0
        WorkKey = ConvertTo-Json -InputObject @($parts) -Compress -Depth 4
        IndexKey = $staged
        StatusKey = $status
    }
}

function Get-RemoteTip {
    $advertised = Invoke-Git @('ls-remote', '--exit-code', '--refs', 'origin', $remoteRef) -Allowed @(0, 2) -Network
    if ($advertised.Code -eq 2) { return $null }
    if ($advertised.Text -notmatch "(?m)^([0-9a-f]{40,64})\t$remoteRef\r?$") { throw '无法确认远程 collab 引用。' }
    $tip = $Matches[1]
    $present = Invoke-Git @('cat-file', '-e', "$tip^{commit}") -Allowed @(0, 1, 128)
    if ($present.Code -ne 0) {
        $null = Invoke-Git @('fetch', '--no-tags', '--no-recurse-submodules', 'origin', $remoteRef) -Network
        $fetched = (Invoke-Git @('rev-parse', '--verify', 'FETCH_HEAD^{commit}')).Text.Trim()
        if ($fetched -cne $tip) { throw '远程在查询与拉取之间前进，留到下一轮再合并。' }
    }
    return $tip
}

function Write-SyncLog([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -ge 2MB) {
        Move-Item -LiteralPath $logPath -Destination (Join-Path $runtimeDir 'sync.previous.log') -Force
    }
    [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $utf8)
}

function Open-WorkerLock {
    param([switch]$NewRun)
    $mode = if ($NewRun) { 'Create' } else { 'OpenOrCreate' }
    try { return [IO.File]::Open($lockPath, $mode, 'ReadWrite', 'Read') }
    catch [IO.IOException] { return $null }
}

function Read-WorkerId {
    $stream = [IO.File]::Open($lockPath, 'Open', 'Read', 'ReadWrite')
    try {
        $reader = [IO.StreamReader]::new($stream, $utf8)
        return $reader.ReadToEnd().Trim()
    } finally {
        $stream.Dispose()
    }
}

function Request-WorkerStop {
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $probe = Open-WorkerLock
        if ($probe) {
            $probe.Dispose()
            Write-Host '此工作树没有同步进程。'
            return
        }
        try { $id = Read-WorkerId } catch [IO.IOException] { $id = $null }
        if ($id -match '^[0-9a-f]{32}$') {
            [IO.File]::WriteAllText($stopPath, $id, $utf8)
            Write-Host '已请求停止。当前 Git 操作结束后会安全退出。'
            return
        }
        Start-Sleep -Milliseconds 100
    }
    throw '同步进程正在初始化，尚未读取到运行标识。'
}

function Test-StopRequested {
    if (-not (Test-Path -LiteralPath $stopPath)) { return $false }
    try { return [IO.File]::ReadAllText($stopPath, $utf8).Trim() -ceq $script:runId }
    catch [IO.IOException] { return $false }
}

function Sync-Round {
    Assert-SyncTarget
    $operation = Get-GitOperation
    if ($operation) { Write-SyncLog "等待完成现有 Git 操作 $operation，工作树和暂存区保持原样。"; return }
    $tip = Get-RemoteTip
    if (Test-StopRequested) { return }
    $current = Get-Snapshot
    if ($current.Dirty) {
        $previous = $script:lastSnapshot
        if (-not $previous -or $previous.Head -cne $current.Head -or
            $previous.WorkKey -cne $current.WorkKey -or $previous.IndexKey -cne $current.IndexKey -or
            $previous.StatusKey -cne $current.StatusKey) {
            $script:lastSnapshot = $current | Add-Member -NotePropertyName SeenAt -NotePropertyValue ([DateTime]::UtcNow) -PassThru
            Write-SyncLog '发现本地修改。等待文件内容、时间戳和暂存状态保持稳定。'
            return
        }
        if (([DateTime]::UtcNow - $previous.SeenAt).TotalSeconds -lt $StableSeconds) { return }
        Assert-SyncTarget
        Assert-IgnoreCoverage
        if ((Get-GitOperation) -or (Test-StopRequested)) { return }
        $beforeStage = Get-Snapshot
        if ($beforeStage.Head -cne $current.Head -or $beforeStage.WorkKey -cne $current.WorkKey -or
            $beforeStage.IndexKey -cne $current.IndexKey -or $beforeStage.StatusKey -cne $current.StatusKey) {
            $script:lastSnapshot = $null
            return
        }
        $ownedStage = $script:stagedBySync
        if (-not $current.Staged -or ($ownedStage -and $ownedStage.Head -ceq $current.Head -and $ownedStage.IndexKey -ceq $current.IndexKey)) {
            $null = Invoke-Git @('add', '-A', '--', '.')
            $index = (Invoke-Git @('diff', '--cached', '--raw', '-z', '--no-renames', 'HEAD', '--')).Text
            $script:stagedBySync = [pscustomobject]@{ Head = $current.Head; IndexKey = $index }
        }
        $staged = Get-Snapshot
        if (-not $staged.Staged -or $staged.Head -cne $current.Head -or $staged.WorkKey -cne $current.WorkKey) {
            $script:lastSnapshot = $null
            Write-SyncLog '暂存期间检测到变化，保留现场并重新等待稳定。'
            return
        }
        $tree = (Invoke-Git @('write-tree')).Text.Trim()
        Assert-SafeChanges @($staged.Head, $tree)
        $ready = Get-Snapshot
        if ($ready.Head -cne $staged.Head -or $ready.WorkKey -cne $staged.WorkKey -or $ready.IndexKey -cne $staged.IndexKey -or
            (Get-GitOperation) -or (Test-StopRequested)) {
            $script:lastSnapshot = $null
            return
        }
        Assert-SyncTarget
        $null = Invoke-Git @('commit', '-m', ('同步协作修改 {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')))
        $script:stagedBySync = $null
        $script:lastSnapshot = $null
        Write-SyncLog '已提交稳定的本地修改。'
        $current = Get-Snapshot
    }
    if ($current.Dirty) { return }
    $script:lastSnapshot = $null
    if ((Get-GitOperation) -or (Test-StopRequested)) { return }

    if ($tip -and $tip -cne $current.Head) {
        $localAncestor = (Invoke-Git @('merge-base', '--is-ancestor', $current.Head, $tip) -Allowed @(0, 1)).Code -eq 0
        $remoteAncestor = (Invoke-Git @('merge-base', '--is-ancestor', $tip, $current.Head) -Allowed @(0, 1)).Code -eq 0
        if (-not $remoteAncestor) {
            Assert-SafeHistory $tip $current.Head
            Assert-SyncTarget
            $beforeMerge = Get-Snapshot
            if ($beforeMerge.Head -cne $current.Head -or $beforeMerge.Dirty -or (Get-GitOperation) -or (Test-StopRequested)) { return }
            if ($localAncestor) {
                $null = Invoke-Git @('merge', '--ff-only', '--no-autostash', '--no-overwrite-ignore', $tip)
                Write-SyncLog '已快进到远程 collab。'
            } else {
                $merge = Invoke-Git @('merge', '--no-ff', '--no-commit', '--no-autostash', '--no-overwrite-ignore', $tip) -Allowed @(0, 1, 128)
                if ($merge.Code -ne 0) {
                    Write-SyncLog '合并暂停。Git 已保留双方提交和当前工作树，请检查 git status。'
                    return
                }
                $tree = (Invoke-Git @('write-tree')).Text.Trim()
                Assert-SafeChanges @($current.Head, $tree)
                Assert-SyncTarget
                $mergeHead = Join-Path $gitDir 'MERGE_HEAD'
                $afterMerge = Get-Snapshot
                $unstaged = Invoke-Git @('diff', '--quiet', '--') -Allowed @(0, 1)
                $untracked = (Invoke-Git @('ls-files', '--others', '--exclude-standard', '-z')).Text
                if (-not (Test-Path -LiteralPath $mergeHead) -or
                    [IO.File]::ReadAllText($mergeHead).Trim() -cne $tip -or
                    $afterMerge.Head -cne $current.Head -or $unstaged.Code -ne 0 -or $untracked.Length -or
                    (Invoke-Git @('write-tree')).Text.Trim() -cne $tree) {
                    Write-SyncLog '合并后发现新的本地编辑，保留合并现场，请先检查 git status。'
                    return
                }
                $null = Invoke-Git @('commit', '--no-edit')
                Write-SyncLog '已安全合并双方提交。'
            }
            $current = Get-Snapshot
        }
    }

    if ($current.Dirty -or (Get-GitOperation) -or (Test-StopRequested)) { return }
    if ($tip -ceq $current.Head) { return }
    Assert-SafeHistory $current.Head $tip
    Assert-SyncTarget
    $beforePush = Get-Snapshot
    if ($beforePush.Head -cne $current.Head -or $beforePush.Dirty -or (Get-GitOperation) -or (Test-StopRequested)) { return }
    $push = Invoke-Git @('-c', 'remote.origin.mirror=false', 'push', '--no-follow-tags', '--porcelain', 'origin', "$($current.Head):$remoteRef") -Allowed @(0, 1, 128) -Network
    if ($push.Code -eq 0) {
        Write-SyncLog "已推送 collab $($current.Head.Substring(0, 8))。"
    } else {
        Write-SyncLog '推送未完成。保留本地提交，下轮重新查询远程。'
    }
}

try {
    foreach ($key in @('GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_NAMESPACE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES')) {
        if ([Environment]::GetEnvironmentVariable($key)) { throw "运行环境设置了 $key，请在普通 PowerShell 窗口打开脚本。" }
    }
    $gitExe = (Get-Command git.exe -CommandType Application | Select-Object -First 1).Source
    $gitDir = Assert-Worktree
    $runtimeDir = Join-Path $gitDir 'codex-auto-sync'
    $lockPath = Join-Path $runtimeDir 'worker.lock'
    $stopPath = Join-Path $runtimeDir 'stop.request'
    $logPath = Join-Path $runtimeDir 'sync.log'

    if ($Action -in @('Stop', 'Restart')) {
        $null = [IO.Directory]::CreateDirectory($runtimeDir)
        Request-WorkerStop
        if ($Action -eq 'Stop') { return }
    }
    $expectedRemote = Get-RemoteIdentity
    Assert-SyncTarget
    Assert-IgnoreCoverage
    $null = Invoke-Git @('var', 'GIT_AUTHOR_IDENT')
    $null = Invoke-Git @('var', 'GIT_COMMITTER_IDENT')
    if ($Action -eq 'Check') {
        $snapshot = Get-Snapshot
        Write-Host "工作树 $root"
        Write-Host "Git 元数据 $gitDir"
        Write-Host "分支 $branch，GitHub 远程检查及忽略规则通过。本地有变更 $($snapshot.Dirty)，已暂存 $($snapshot.Staged)。"
        $operation = Get-GitOperation
        if ($operation) { Write-Host "当前 Git 操作 $operation" }
        Write-Host "日志位置 $logPath"
        return
    }

    $null = [IO.Directory]::CreateDirectory($runtimeDir)
    $lock = Open-WorkerLock -NewRun
    if (-not $lock -and $Action -eq 'Restart') {
        $until = [DateTime]::UtcNow.AddSeconds(120)
        while (-not $lock -and [DateTime]::UtcNow -lt $until) {
            Start-Sleep -Milliseconds 500
            $lock = Open-WorkerLock -NewRun
        }
    }
    if (-not $lock) { throw '该工作树已有同步进程。重复启动已阻止。' }
    $script:runId = [Guid]::NewGuid().ToString('N')
    try {
        $lock.SetLength(0)
        $bytes = $utf8.GetBytes($script:runId)
        $lock.Write($bytes, 0, $bytes.Length)
        $lock.Flush()
        Write-SyncLog "启动 collab 同步。每 $IntervalSeconds 秒检查，稳定等待至少 $StableSeconds 秒。"
        while (-not (Test-StopRequested)) {
            $next = [DateTime]::UtcNow.AddSeconds($IntervalSeconds)
            try { Sync-Round }
            catch {
                $script:lastSnapshot = $null
                Write-SyncLog $_.Exception.Message
            }
            do {
                if (Test-StopRequested) { break }
                $remaining = ($next - [DateTime]::UtcNow).TotalMilliseconds
                if ($remaining -le 0) { break }
                Start-Sleep -Milliseconds ([int][Math]::Min(500, [Math]::Ceiling($remaining)))
            } while ($true)
        }
        Write-SyncLog '同步进程已安全停止。'
    } finally {
        $lock.Dispose()
    }
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
