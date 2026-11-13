# Codex Notify

在飞书回答 Codex 的问题。比如 Codex 问「导出 CSV 还是 Excel？」，你在飞书卡片上选「Excel」，原聊天收到答案后继续执行。任务留在 Codex，飞书负责把问题送给你，并把答案带回原聊天。

**复制给你的 Agent：**

```text
请阅读 https://github.com/a13068698842-ops/codex-notify，并按仓库里的说明帮我安装 Codex Notify、连接飞书。
```

## 快速开始

需要 **Windows x64、Codex Desktop 和飞书**。Windows 安装包自带运行依赖，无需另装 Node.js。

从 [GitHub Releases](https://github.com/a13068698842-ops/codex-notify/releases/latest) 下载 Windows x64 安装 ZIP。按 [Windows 安装说明](docs/WINDOWS_INSTALL.md#1-安装-windows-程序和-codex-插件) 安装程序和 Codex 插件，再运行 `codex-notify.cmd init` 打开设置窗口：

1. **扫码连接飞书**：点「扫码连接飞书」，用手机飞书扫描二维码。
2. **在飞书确认创建**：按提示创建机器人，Notify 会自动给扫码账号发一张测试卡。
3. **点测试卡完成**：在飞书点击「确认收到测试卡」，Notify 会保存配置并自动启动后台。

如果电脑上已经安装过 Codex Notify，按[更换为扫码版](docs/WINDOWS_INSTALL.md#更换为扫码版)操作。原飞书配置和历史可以继续使用。

## 目前支持什么

- 在飞书卡片上选选项或填文字。Codex 原生提问、可识别的普通文字问题和结构化异步提问都可以送到飞书。
- 异步问题可以在 Codex 还在工作时回答，也可以在提问的那一轮结束后回答。
- 答案回到提出问题的原聊天。卡片显示「已回答」，表示 Codex 已收到答案。

目前支持 Windows 上的 Codex Desktop 和国内飞书。操作审批仍在 Codex 中处理。

## 设计思路与文档

开发思路参考了 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness) 的插件化设计，以及数字生命卡兹克的 [Agent Autoloop](https://github.com/KKKKhazix/agent-autoloop)。后续可接入钉钉、企业微信等渠道，或接入Claude code、deepseek harness等agent以此拓展你的工作流
