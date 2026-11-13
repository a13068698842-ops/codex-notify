param(
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$Worker
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()

$form = [Windows.Forms.Form]::new()
$form.Text = 'Codex Notify · 飞书设置'
$form.ClientSize = [Drawing.Size]::new(660, 515)
$form.AutoScaleMode = 'Dpi'
$form.FormBorderStyle = 'FixedDialog'
$form.StartPosition = 'CenterScreen'
$form.MaximizeBox = $false

$manualPanel = [Windows.Forms.Panel]::new()
$manualPanel.SetBounds(0, 0, 660, 465)
$form.Controls.Add($manualPanel)
$scanPanel = [Windows.Forms.Panel]::new()
$scanPanel.SetBounds(0, 0, 660, 465)
$form.Controls.Add($scanPanel)
$layout = $manualPanel

function Add-Label([string]$Caption, [int]$X, [int]$Y, [int]$Width, [int]$Height = 24) {
    $item = [Windows.Forms.Label]::new()
    $item.SetBounds($X, $Y, $Width, $Height)
    $item.Text = $Caption
    $layout.Controls.Add($item)
    return $item
}

function Add-Input([string]$Caption, [int]$Y, [int]$Limit = 256) {
    $null = Add-Label $Caption 24 ($Y + 3) 133
    $item = [Windows.Forms.TextBox]::new()
    $item.SetBounds(156, $Y, 478, 28)
    $item.MaxLength = $Limit
    $layout.Controls.Add($item)
    return $item
}

$null = Add-Label '填写飞书自建应用及接收目标。发送测试卡后，请在飞书用允许操作的账号点击确认。' 24 19 612 35
$appId = Add-Input 'App ID' 65
$appSecret = Add-Input 'App Secret' 101 4096
$appSecret.UseSystemPasswordChar = $true
$secretHint = Add-Label 'App Secret 使用 Windows 当前用户加密保存。' 156 128 476 20

$null = Add-Label '接收目标类型' 24 160 133
$targetType = [Windows.Forms.ComboBox]::new()
$targetType.SetBounds(156, 155, 478, 28)
$targetType.DropDownStyle = 'DropDownList'
$null = $targetType.Items.Add('单聊：用户 Open ID（ou_）')
$null = $targetType.Items.Add('群聊：Chat ID（oc_）')
$targetType.SelectedIndex = 0
$manualPanel.Controls.Add($targetType)
$targetId = Add-Input '接收目标 ID' 191
$operators = Add-Input '可操作用户 Open ID' 227 2048
$null = Add-Label '多位用户用英文逗号隔开。单聊留空时只允许接收者操作。' 156 254 476 21
$proxy = Add-Input '代理' 282 1024
$proxy.Text = 'auto'
$null = Add-Label 'auto 自动读取环境和系统代理；direct 直连；也可填 http:// 或 https:// 地址。' 156 309 476 21

$autoStart = [Windows.Forms.CheckBox]::new()
$autoStart.SetBounds(156, 336, 476, 23)
$autoStart.Text = '登录 Windows 后自动启动 Codex Notify'
$manualPanel.Controls.Add($autoStart)
$manualStatus = Add-Label '发送测试卡之前请确认接收目标正确，并停止旧版监听。' 24 367 612 50

$send = [Windows.Forms.Button]::new()
$send.SetBounds(376, 421, 161, 31)
$send.Text = '发送测试卡并保存'
$manualPanel.Controls.Add($send)
$layout = $scanPanel

$title = Add-Label '连接飞书' 24 20 612 34
$title.Font = [Drawing.Font]::new($form.Font.FontFamily, 17, [Drawing.FontStyle]::Bold)
$steps = Add-Label '1 扫码连接飞书    →    2 在飞书确认创建    →    3 点测试卡完成' 24 66 612 29
$steps.Font = [Drawing.Font]::new($form.Font, [Drawing.FontStyle]::Bold)
$qr = [Windows.Forms.PictureBox]::new()
$qr.SetBounds(24, 102, 350, 350)
$qr.BackColor = [Drawing.Color]::White
$qr.SizeMode = 'CenterImage'
$qr.AccessibleName = '飞书创建机器人的二维码'
$scanPanel.Controls.Add($qr)
$qrHint = [Windows.Forms.Label]::new()
$qrHint.Dock = 'Fill'
$qrHint.TextAlign = 'MiddleCenter'
$qrHint.ForeColor = [Drawing.Color]::DimGray
$qrHint.Text = '点击「扫码连接飞书」生成二维码'
$qr.Controls.Add($qrHint)
$scanStatus = Add-Label '' 395 109 239 156
$scanStart = [Windows.Forms.Button]::new()
$scanStart.SetBounds(395, 275, 239, 36)
$scanStart.Text = '扫码连接飞书'
$scanPanel.Controls.Add($scanStart)
$scanLogin = [Windows.Forms.CheckBox]::new()
$scanLogin.SetBounds(395, 328, 239, 30)
$scanLogin.Text = '登录 Windows 后自动启动'
$scanPanel.Controls.Add($scanLogin)
$null = Add-Label '只给扫码的飞书账号发卡。' 395 374 239 42

$mode = [Windows.Forms.Button]::new()
$mode.SetBounds(24, 474, 152, 30)
$form.Controls.Add($mode)
$cancel = [Windows.Forms.Button]::new()
$cancel.SetBounds(547, 474, 87, 30)
$cancel.Text = '关闭'
$form.Controls.Add($cancel)
$cancel.Add_Click({ $form.Close() })
$fields = @($appId, $appSecret, $targetType, $targetId, $operators, $proxy, $autoStart)

$configFile = Join-Path $env:LOCALAPPDATA 'CodexNotify\config.json'
$hasConfig = Test-Path -LiteralPath $configFile -PathType Leaf
if ($hasConfig) {
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $appId.Text = $config.channel.appId
    $targetType.SelectedIndex = [int]($config.channel.targetType -eq 'chat_id')
    $targetId.Text = $config.channel.targetId
    $operators.Text = $config.channel.allowedOperatorIds -join ', '
    $proxy.Text = $config.proxy
    $autoStart.Checked = $config.autoStart
    $secretHint.Text = '保留同一 App ID 时，留空可继续使用原凭证。'
}

$messages = @{
    'bot_created' = '飞书已确认创建。正在准备测试卡…'
    'connecting' = '正在检查飞书长连接及消息发送权限…'
    'card_sent' = '测试卡已发送。请在 8 分钟内打开飞书，由允许操作的账号点击「确认收到测试卡」。'
    'saving' = '已确认测试卡点击，正在加密并保存配置…'
    'saved' = '飞书收发已确认，配置已保存。关闭此窗口后可运行 codex-notify start。'
    'saved_paused' = '飞书收发已确认，配置已保存。当前仍处于暂停状态；运行 codex-notify start 可恢复并应用自启设置。'
    'saved_autostart_failed' = '飞书收发已确认，配置已保存；Windows 登录自启任务更新失败，请检查计划任务权限。'
    'scan_done' = '连接完成。飞书测试卡已确认，Codex Notify 后台已启动。'
    'scan_done_login_failed' = '连接完成，后台已启动。Windows 登录自启设置未能更新。'
    'scan_saved_start_failed' = '飞书收发已确认，配置已保存。后台未能启动，请运行 codex-notify start。'
    'feishu_registration_failed' = '无法完成扫码连接。请检查网络后重试，或使用已有应用。'
    'feishu_registration_denied' = '飞书未授权创建机器人。可以重试或使用已有应用。'
    'feishu_registration_expired' = '二维码已过期，请重新生成后扫码。'
    'feishu_registration_missing_identity' = '飞书没有返回扫码人的接收身份，无法发送测试卡。请用已有应用手动配置。'
    'feishu_registration_unsupported_brand' = '请用国内版飞书扫码。此入口暂不支持国际版 Lark。'
    'feishu_credentials_missing_or_invalid' = '请填写有效的 App ID 和 App Secret。'
    'feishu_target_missing_or_invalid' = '接收目标 ID 格式不正确，请核对单聊或群聊类型。'
    'feishu_operators_missing_or_invalid' = '请填写至少一位允许操作的用户 Open ID（ou_ 开头）。'
    'windows_proxy_unreadable' = '无法读取 Windows 代理，请输入明确的代理地址，或选择 direct。'
    'windows_pac_requires_explicit_proxy' = '当前 Windows 使用 PAC 脚本，请输入明确的代理地址，或选择 direct。'
    'unsupported_proxy' = '代理格式不支持，请使用 auto、direct 或 HTTP(S) 代理地址。'
    'proxy_credentials_in_config' = '配置文件不能保存代理口令；请通过 HTTPS_PROXY 环境变量提供认证代理。'
    'feishu_setup_connection_failed' = '无法连接飞书，请核对 App ID、App Secret、长连接回调配置和网络。'
    'feishu_setup_card_rejected' = '飞书拒绝发送测试卡，请检查机器人权限及接收目标。'
    'feishu_setup_card_send_unconfirmed' = '未能确认测试卡送达，请检查接收目标、应用权限和网络。'
    'feishu_setup_click_timeout' = '8 分钟内未收到有效点击。请核对操作人 Open ID 和长连接回调，再发送新测试卡。'
    'credential_unreadable_or_invalid' = '原凭证无法解密，请重新输入 App Secret。'
    'credential_protection_failed' = 'Windows 无法加密凭证，请检查当前用户配置。'
    'data_directory_not_private' = '无法限制数据目录访问权限，请检查本机目录权限。'
    'config_unreadable_or_invalid' = '当前配置无法读取，请核对本机配置文件。'
    'config_write_failed' = '无法保存配置，请检查本机数据目录权限。'
    'feishu_app_busy' = '这个飞书应用已被本机另一监听使用。请停止该监听再重试。'
    'setup_runtime_busy' = 'Codex Notify 正在运行或设置中。请执行 codex-notify stop 后重试。'
    'setup_input_invalid' = '设置表单无法读取，请重试。'
    'setup_failed' = '设置未完成，请检查运行环境后重试。'
}

$script:child = $null
$script:line = $null
$script:stderr = $null
$script:saved = $false
$script:saving = $false
$script:reportedError = $false
$script:scanMode = !$hasConfig
$script:retryCard = $false
$timer = [Windows.Forms.Timer]::new()
$timer.Interval = 100

function Clear-QRCode {
    $qrHint.Visible = $true
    if ($null -eq $qr.Image) { return }
    $image = $qr.Image
    $qr.Image = $null
    $image.Dispose()
}

function Show-SetupMode {
    $scanPanel.Visible = $script:scanMode
    $manualPanel.Visible = !$script:scanMode
    $mode.Visible = !$hasConfig
    $mode.Text = if ($script:scanMode) { '使用已有应用' } else { '返回扫码连接' }
    $form.AcceptButton = if ($script:scanMode) { $scanStart } else { $send }
}

$mode.Add_Click({
    $script:scanMode = !$script:scanMode
    Show-SetupMode
})
$scanStatus.Text = '用手机飞书扫一扫。按飞书提示确认创建后，测试卡会自动发到你的飞书。'
Show-SetupMode

function Restore-Form {
    $timer.Stop()
    if ($null -ne $script:child) {
        try { $script:child.StandardInput.Close() } catch {}
        $script:child.Dispose()
        $script:child = $null
    }
    Clear-QRCode
    $script:line = $null
    $script:stderr = $null
    $script:saving = $false
    $script:retryCard = $false
    $cancel.Enabled = $true
    if (-not $script:saved) {
        foreach ($field in $fields) { $field.Enabled = $true }
        $send.Enabled = $true
        $scanLogin.Enabled = $true
        $scanStart.Text = '扫码连接飞书'
        $scanStart.Enabled = $true
        $mode.Enabled = $true
        $qrHint.Text = '点击「扫码连接飞书」重新生成二维码'
    }
}

$timer.Add_Tick({
    if ($null -eq $script:line -or -not $script:line.IsCompleted) { return }
    try { $code = $script:line.GetAwaiter().GetResult() } catch { $code = $null }
    $status = if ($script:scanMode) { $scanStatus } else { $manualStatus }
    if ($null -eq $code) {
        if (-not $script:saved -and -not $script:reportedError) { $status.Text = $messages['setup_failed'] }
        Restore-Form
        return
    }
    if ($script:scanMode -and $code.StartsWith('{') -and $code.Length -le 200000) {
        try {
            $payload = $code | ConvertFrom-Json
            $bytes = [Convert]::FromBase64String($payload.qr)
            $stream = [IO.MemoryStream]::new($bytes)
            try {
                $image = [Drawing.Image]::FromStream($stream)
                try {
                    Clear-QRCode
                    $qr.Image = [Drawing.Bitmap]::new($image)
                    $qrHint.Visible = $false
                } finally { $image.Dispose() }
            } finally { $stream.Dispose() }
            $status.Text = "第 1 步：用手机飞书扫一扫左侧二维码。`r`n`r`n第 2 步：在飞书里确认创建。"
        } catch {
            $script:reportedError = $true
            $status.Text = $messages['setup_failed']
            if (!$script:child.HasExited) { try { $script:child.Kill() } catch {} }
        }
    } elseif ($code -eq 'retry_card') {
        $script:retryCard = $true
        $scanStart.Text = '重新发送测试卡'
        $scanStart.Enabled = $true
        $status.Text += "`r`n`r`n保持此窗口打开，即可用刚创建的机器人重发。"
    } elseif ($messages.ContainsKey($code)) {
        $status.Text = $messages[$code]
        switch ($code) {
            'bot_created' { Clear-QRCode; $qrHint.Text = '机器人已创建' }
            'connecting' { }
            'card_sent' {
                if ($script:scanMode) {
                    $qrHint.Text = '测试卡已发送'
                    $status.Text = '第 3 步：打开飞书里的新机器人私聊，在 8 分钟内点击最新卡片的「确认收到测试卡」。'
                }
            }
            'saving' {
                $script:saving = $true
                $cancel.Enabled = $false
                if ($script:scanMode) { try { $script:child.StandardInput.Close() } catch {} }
            }
            { $_ -in @('saved', 'saved_paused', 'saved_autostart_failed', 'scan_done', 'scan_done_login_failed', 'scan_saved_start_failed') } {
                $script:saved = $true
                $script:saving = $false
                $cancel.Enabled = $true
                if ($script:scanMode) { $qrHint.Text = '飞书连接已保存' }
            }
            default {
                $script:reportedError = $true
                if ($script:scanMode -and $code -like 'feishu_setup_*') {
                    $qrHint.Text = '测试卡未确认'
                }
            }
        }
    }
    $script:line = $script:child.StandardOutput.ReadLineAsync()
})

function Start-SetupWorker([hashtable]$values) {
    $status = if ($script:scanMode) { $scanStatus } else { $manualStatus }
    $script:reportedError = $false
    foreach ($field in $fields) { $field.Enabled = $false }
    $send.Enabled = $false
    $scanStart.Enabled = $false
    $scanLogin.Enabled = $false
    $mode.Enabled = $false
    if ($script:scanMode) { $qrHint.Text = '正在生成二维码…' }
    $status.Text = if ($script:scanMode) { '正在生成飞书二维码…' } else { '正在检查配置…' }
    try {
        $info = [Diagnostics.ProcessStartInfo]::new()
        $info.FileName = $NodeExecutable
        $info.Arguments = '"' + $Worker + '"'
        if ($script:scanMode) { $info.Arguments += ' --scan' }
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $info.RedirectStandardInput = $true
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $info.StandardOutputEncoding = [Text.Encoding]::UTF8
        $script:child = [Diagnostics.Process]::Start($info)
        $script:stderr = $script:child.StandardError.ReadToEndAsync()
        $script:line = $script:child.StandardOutput.ReadLineAsync()
        $payload = [Text.Encoding]::UTF8.GetBytes(($values | ConvertTo-Json -Compress) + "`n")
        try {
            $script:child.StandardInput.BaseStream.Write($payload, 0, $payload.Length)
            $script:child.StandardInput.BaseStream.Flush()
        }
        finally {
            [Array]::Clear($payload, 0, $payload.Length)
            if (!$script:scanMode) { $script:child.StandardInput.Close(); $appSecret.Clear() }
        }
        $timer.Start()
    } catch {
        if ($null -ne $script:child -and -not $script:child.HasExited) { try { $script:child.Kill() } catch {} }
        Restore-Form
        $status.Text = $messages['setup_failed']
    }
}

$send.Add_Click({
    Start-SetupWorker @{
        appId = $appId.Text
        appSecret = $appSecret.Text
        targetType = @('open_id', 'chat_id')[$targetType.SelectedIndex]
        targetId = $targetId.Text
        operators = $operators.Text
        proxy = $proxy.Text
        autoStart = $autoStart.Checked
    }
})

$scanStart.Add_Click({
    if (!$script:retryCard) {
        Start-SetupWorker @{ proxy = $proxy.Text; autoStart = $scanLogin.Checked }
        return
    }
    $script:retryCard = $false
    $scanStart.Enabled = $false
    $scanStatus.Text = '正在重新发送测试卡…'
    try {
        $retry = [Text.Encoding]::UTF8.GetBytes("retry`n")
        $script:child.StandardInput.BaseStream.Write($retry, 0, $retry.Length)
        $script:child.StandardInput.BaseStream.Flush()
    } catch {
        if (!$script:child.HasExited) { try { $script:child.Kill() } catch {} }
        Restore-Form
        $scanStatus.Text = $messages['setup_failed']
    }
})

$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ($script:saving) { $eventArgs.Cancel = $true; return }
    if ($null -ne $script:child -and -not $script:child.HasExited -and -not $script:saved) {
        try { $script:child.Kill() } catch {}
    }
})

try { $null = $form.ShowDialog() }
finally { Clear-QRCode; $timer.Dispose(); $form.Dispose() }
if ($script:saved) { exit 0 }
exit 2
