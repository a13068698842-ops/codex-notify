# Codex Notify：Windows 安装和使用

Codex Notify 把已登记的本机 Codex 聊天中的问题发到飞书，并把答案送回对应聊天。安装包面向 Windows x64，内含 Node.js 和生产依赖；安装者无需另外安装 Node.js、Git 或编译工具。Codex 桌面版本号只用于诊断。插件会校验当前聊天的实际桌面协议与会话归属；校验未通过时，不从该聊天发送问题或回传答案。

## 1. 安装 Windows 程序和 Codex 插件

解压整个安装 ZIP，在解压目录打开 PowerShell，运行：

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1
```

安装脚本将程序放在 `%LOCALAPPDATA%\Programs\CodexNotify`，并添加 `codex-notify-windows` 插件来源。打开 Codex Desktop 的插件页，从这个来源安装并启用 **Codex Notify**。若看不到来源，退出并重新打开 Codex。在 hook 审阅界面核对并信任 `SessionStart` 和 `UserPromptSubmit`，这样新聊天和提交消息时才能自动登记。参见 [Codex 插件与 hooks 文档](https://developers.openai.com/plugins/build/plugins#bundled-mcp-servers-and-lifecycle-hooks)。

已有安装时，请先按[更换为扫码版](#更换为扫码版)操作。

## 首次连接：扫码、确认创建、点测试卡

```powershell
$notify = Join-Path $env:LOCALAPPDATA 'Programs\CodexNotify\codex-notify.cmd'
& $notify init
```

1. **扫码连接飞书**：点「扫码连接飞书」，用手机上的国内版飞书扫描窗口里的二维码。
2. **在飞书确认创建**：选择可创建机器人的组织，审阅飞书页面里的权限，再确认创建。Notify 会自动向扫码的飞书账号发测试卡。
3. **点测试卡完成**：在新机器人的私聊里，于 **8 分钟内**点最新卡片上的「确认收到测试卡」。窗口显示「连接完成」后，本机已加密保存凭证并启动后台。登录 Windows 后是否自启，可在扫码前勾选。

如果二维码过期，可以重新生成；测试卡失败或超时，保持窗口打开，点「重新发送测试卡」，可以沿用刚创建的机器人。企业禁止扫码创建或需管理员批准时，按飞书提示处理。也可以选「使用已有应用」，按第 2–6 节手动配置；已配置的安装会直接打开手动表单。

## 2. 配置飞书自建应用

1. 打开[飞书开发者后台](https://open.feishu.cn/app)，创建一个**企业自建应用**。进入「添加应用能力」，添加「机器人」。
2. 在「权限管理」开通应用身份权限「以应用的身份发消息」`im:message:send_as_bot`。在「版本管理与发布」发布正式版本，把自己加入应用可用范围；如需管理员审核，等审核通过。[飞书机器人配置说明](https://open.feishu.cn/document/historical-version/quickly-develop-interactive-cards/step-one-create-and-configure-the-application?lang=zh-CN)
3. 在「凭证与基础信息」找到 **App ID** 和 **App Secret**。下面各步骤都用同一个应用和版本。App Secret 只填在本机的 Notify 设置窗口。
4. 在「事件与回调 → 回调配置」选择「使用长连接接收回调」，添加「卡片回传交互」`card.action.trigger`，再发布应用版本使回调生效。这一步无需填写公网回调地址。若飞书提示没有在线长连接，先完成下面的目标 ID 和 Notify 表单，点「发送测试卡并保存」让 Notify 建立临时连接；保持窗口打开，回飞书保存并发布。发布后再按第 5 节用新卡确认。[飞书长连接回调配置](https://open.feishu.cn/document/event-subscription-guide/callback-subscription/step-1-choose-a-subscription-mode/configure-callback-request-address)

## 3. 获取自己的目标 ID

在[飞书 API 调试台](https://open.feishu.cn/api-explorer)选择刚才的自建应用和对应版本。打开「通讯录 → 用户 → 获取单个用户信息」，将查询参数 `user_id_type` 设为 `open_id`，再在路径参数 `user_id` 旁点「获取」或「重新获取」。在成员选择框里选自己，复制 `user_id` 框中完整的 **`ou_` 开头**的值。

只需要复制 ID，无需获取 Token 或执行接口。同一个人在不同飞书应用下的 Open ID 不同；换了应用就重新取一次。[飞书官方 Open ID 获取说明](https://open.feishu.cn/document/faq/trouble-shooting/how-to-obtain-openid)

## 4. 打开 Notify 设置并填写单聊表单

```powershell
$notify = Join-Path $env:LOCALAPPDATA 'Programs\CodexNotify\codex-notify.cmd'
& $notify init
```

如果打开的是扫码页，点「使用已有应用」进入下方表单。

| 设置项 | 单聊发给自己怎么填 |
| --- | --- |
| App ID | 第 2 节拿到的 `cli_…`。 |
| App Secret | 同一个应用的密钥。 |
| 接收目标类型 | 选「单聊：用户 Open ID（ou_）」。 |
| 接收目标 ID | 第 3 节复制的自己的 `ou_…`。 |
| 可操作用户 Open ID | 留空，默认仅接收者可以确认和答题。 |
| 代理 | 先用默认的 `auto`；如需明确指定，填 `direct` 或当前可用的 HTTP(S) 代理地址。 |
| 登录 Windows 后自动启动 Codex Notify | 按需勾选。勾选后，今后登录 Windows 会自动启动后台；本次设置完成后仍要手动启动。 |

## 5. 确认测试卡，保存配置

1. 停止同一个飞书应用的其他回调监听；如果 Notify 后台已经在运行，先执行 `& $notify stop`。
2. 点击「发送测试卡并保存」，保持设置窗口打开。收到卡后，在 **8 分钟内**用接收卡片的飞书账号点击最新一张卡上的「确认收到测试卡」。如果用第一张卡建立长连接后才发布了回调，可关闭设置窗口结束那次监听，再打开 `init` 发送新卡。
3. 本机窗口显示「飞书收发已确认，配置已保存」才算完成。收到卡只表示发送成功；确认点击被收到后才会保存配置。超时请重新发卡；重发时如果密钥栏已清空，需要重新填写 App Secret。

## 6. 启动后台，验证第一张问答卡

```powershell
$notify = Join-Path $env:LOCALAPPDATA 'Programs\CodexNotify\codex-notify.cmd'
& $notify start
& $notify status
```

保存配置后关闭设置窗口，再执行上面的命令。等 `status` 显示飞书连接 `feishu: ready`。在 Codex Desktop 新开一个测试聊天并提交一次，例如让 Codex 先问「便签标题是什么？」再写便签。在飞书里回答，确认原聊天收到答案、Codex 用它继续任务，原卡显示「已回答」。测试卡只验证飞书收发；这里验证的是完整的 Codex 问答。

已打开的聊天在下一次提交时登记。若聊天已停在一个问题上，可复制聊天 UUID 或 `codex://threads/…` 链接，再用 `& $notify watch '<聊天 UUID 或链接>'` 手动登记。后台启动后可以关掉 PowerShell，使用时保持电脑联网并让 Codex Desktop 开着。休眠期间无法接收；恢复后后台会重新检查连接。

如果收不到测试卡，先检查机器人能力、发送权限和应用可用范围是否已随正确版本发布；如果能收到卡却无法保存，检查长连接回调、确认账号，以及点的是不是 8 分钟内的新卡。以设置窗口底部提示为准。

## 可选：把通知发到群聊

1. 把这个自建应用的机器人加入目标群。在飞书 API 调试台选择同一应用，用应用身份查询[用户或机器人所在的群列表](https://open.feishu.cn/document/server-docs/group/chat/list)，找到目标群并复制 `oc_` 开头的 `chat_id`。
2. 若已启用单聊，先运行 `& $notify stop`，再运行 `& $notify init`。接收目标类型改选「群聊：Chat ID（oc_）」，目标 ID 填该群的 `oc_…`。
3. 「可操作用户 Open ID」至少填一位答题人的应用内 `ou_…`；多个 ID 用英文逗号隔开。群里会收到卡片，只有名单中的人能提交答案。由名单中的账号确认新测试卡，保存后再启动后台。

## 更换为扫码版

1. 按下方[卸载](#卸载)步骤移除旧安装，保留默认的用户数据。旧构建也可能显示 `0.2.0`；安装器会拒绝覆盖。只在 Codex 里移除插件，不会移除 Windows 程序。
2. 从新 ZIP 运行 `Install.ps1`，重新安装并启用 Codex Notify，按 Codex 提示审阅 hook。
3. 已有飞书机器人和历史会继续使用。按第 6 节启动后台并确认飞书连接为 `ready`。如果要恢复登录自启，在 `init` 中勾选并确认测试卡。还没有飞书配置的用户走首次扫码流程。

从 `0.1.0` 升级时，新版会先在数据目录保留旧状态库备份 `state.sqlite.v2.*.bak`，再迁移现有历史。`0.1.0` 无法直接打开迁移后的状态库，请保留备份。

## 可选：从源码生成安装包

只有源码时，在 Windows 安装 Node.js `24.18.0`，在仓库根目录运行：

```powershell
npm.cmd ci
& .\scripts\package-windows.ps1
```

打包会联网下载依赖和 Windows Node.js 运行时。生成的 ZIP 位于 `dist/releases/`。

## 日常操作

| 命令 | 用途 |
| --- | --- |
| `status` | 查看后台 PID、桌面及飞书连接、登记数（`registered`）、当前已核对 owner 的聊天数（`connected`）、发送或提交失败及待确认数量。后台启动和飞书就绪是两个状态。 |
| `doctor` | 报告桌面版本并尝试本机 IPC 握手，检查数据目录、问题规则和飞书 REST 认证；不会发卡，也不抢占飞书长连接。某个聊天是否通过桌面协议校验，以及飞书长连接状态，见 `status`。 |
| `watch <聊天 UUID 或 codex://threads/...>` | 在后台运行时手动登记本机桌面中已打开的聊天。 |
| `unwatch <聊天 UUID 或 codex://threads/...>` | 停止跟踪该聊天；之后的 hook 不会自动恢复，重新跟踪时执行 `watch`。 |
| `stop` | 停止接受新的飞书答复，处理尚未确认的提交并关闭连接。保留当前登录自启选项。 |
| `disable` | 暂停后台并移除登录自启。另到 Codex 插件目录停用插件，即可停掉 hook。显式运行 `start` 可恢复后台；登录自启可在 `init` 中重新勾选。 |

数据存于 `%LOCALAPPDATA%\CodexNotify`。App Secret 由 Windows 当前用户 DPAPI 加密，配置文件只保存加密文件的引用。代理默认优先使用环境变量，其次使用 Windows 用户代理；也可在初始化窗口选直连或填写明确的 HTTP(S) 代理。代理含认证信息时通过进程环境提供。

## 卸载

在 PowerShell 运行：

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\CodexNotify\Uninstall.ps1"
```

脚本会停止后台、移除登录自启、Codex 插件和 Windows 程序。默认保留原飞书连接、聊天登记和问答历史。升级时使用上面的默认命令；确定连数据也不再需要时，才添加 `-PurgeData`。
