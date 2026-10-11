# GitHub 连通性修复工具

> 解决 GitHub 网页「有时能打开、有时超时」的问题。
> 自动实测 GitHub 官方 IP，选出当前网络最快最稳的一个写入 hosts。

[![PowerShell Syntax Check](https://github.com/CSQ798/github-connectivity-fix/actions/workflows/syntax-check.yml/badge.svg)](https://github.com/CSQ798/github-connectivity-fix/actions/workflows/syntax-check.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)

**English tl;dr** — A PowerShell script for Windows that fixes intermittent
`ERR_CONNECTION_TIMED_OUT` on github.com. It benchmarks GitHub's real edge IPs
(from `api.github.com/meta`), picks the fastest reachable ones, and pins them in
the `hosts` file. No proxy required. MIT licensed.

---

## 你是否遇到这些现象？

- 打开 github.com 有时正常，有时转很久然后报 `ERR_CONNECTION_TIMED_OUT`
- 但 `api.github.com`、`raw.githubusercontent.com` 却能正常访问
- 换了 DNS（8.8.8.8、223.5.5.5…）完全没用
- `ping github.com` 是通的，网页就是打不开

如果是，这个脚本正对你的问题。

## 问题根因

这类故障**不是 DNS 污染，也不是证书问题**，而是链路层对 GitHub **部分 IP 的 443 端口做了间歇性阻断**：

| 实测项 | 结果 |
| --- | --- |
| DNS 解析 `github.com` | ✅ 正常，稳定返回官方 IP，无污染 |
| `github.com:80` | ✅ 通 |
| `github.com:443` | ❌ **间歇性超时** |
| `api` / `raw` / `codeload`.github.com:443 | ✅ 正常 |
| 带 SNI 的 TLS 握手 | ✅ TLSv1.3，证书 CN=github.com（**不存在 SNI 阻断**） |

关键在于：**同一个 IP 会时好时坏**——可能连续 4 次全超时，20 分钟后同样的 IP 又 12/12 全通。这就是"有时能上有时不能"的来源。

👉 因为 DNS 没坏，所以**换 DNS 无效**；因为证书没被劫持，所以**装证书、清缓存也无效**。

## 工作原理

1. 从 `https://api.github.com/meta` 获取 GitHub **官方公布的** web / git IP 段
2. 对候选 IP 逐个实测：TCP 443 连接 × 5 次，统计成功率与平均延迟
3. 按「成功率优先、延迟次之」排序，取当前最优的 N 个（默认 3 个）
4. 写入 `hosts`，并在区块前后加标记，方便随时干净卸载

因为用的是 GitHub 真实边缘节点，TLS 证书完全匹配，**不会出现证书告警**。

## 快速开始

### 第一步：先看看效果（不改任何系统设置）

在普通 PowerShell 窗口里执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\fix-github.ps1 -TestOnly
```

你会看到类似输出：

```
[OK  ] 20.27.177.113    5/5 成功  平均  91 ms
[OK  ] 20.27.177.119    5/5 成功  平均  91 ms
[OK  ] 20.205.243.166   5/5 成功  平均 129 ms
[FAIL] 140.82.121.3     0/5 成功  平均 99999 ms
```

> 探测 28 个 IP 需要 **5～7 分钟**，属正常。

### 第二步：正式应用

**右键「开始」按钮 → 选「终端(管理员)」或「Windows PowerShell(管理员)」**，然后：

```powershell
powershell -ExecutionPolicy Bypass -File .\fix-github.ps1
```

看到 `[OK] hosts 已更新` 后，**完全关闭并重新打开浏览器**即可。

## 参数

| 参数 | 说明 |
| --- | --- |
| `-TestOnly` | 只测试并输出报告，不修改系统 |
| `-Restore` | 卸载：移除写入的 hosts 条目并刷新 DNS |
| `-Top N` | 取前 N 个 IP 写入（默认 3） |
| `-NoPause` | 结束后不等待按键，便于自动化调用 |

## 以后又打不开了怎么办

因为阻断是**间歇性**的，某个 IP 可能过一阵就不好用了。**重新跑一遍同一个命令**即可——

脚本每次都会重新实测并换一批当前最优的 IP，不需要你做任何判断。

## 卸载 / 恢复原状

```powershell
# 方式一：脚本自带卸载
powershell -ExecutionPolicy Bypass -File .\fix-github.ps1 -Restore

# 方式二：直接还原备份（首次运行时自动生成）
Copy-Item .\hosts.githubfix.bak "$env:SystemRoot\System32\drivers\etc\hosts" -Force

# 刷新 DNS 缓存
ipconfig /flushdns
```

## 常见问题

**Q：改 hosts 安全吗？会有什么副作用？**

脚本只接管 GitHub 的 5 个域名，不影响其它任何网站。原 hosts 会在首次运行时备份为 `hosts.githubfix.bak`。卸载只需一条命令。

**Q：会不会有证书安全警告？**

不会。写入的是 GitHub 官方边缘节点 IP，证书 CN 就是 `github.com`。

**Q：如果所有 IP 都不可达呢？**

脚本会明确提示「所有候选 IP 当前都不可达」。这说明当前网络对 GitHub 做了**全面**阻断，改 hosts 无法解决，此时只能使用代理或 VPN。

**Q：为什么提示需要管理员权限？**

`hosts` 文件位于 `C:\Windows\System32\drivers\etc\`，属于系统文件，Windows 强制要求管理员权限才能修改。

**Q：脚本里为什么有中文乱码相关的处理？**

脚本含中文，必须保存为 **UTF-8 带 BOM**。若被编辑器存成无 BOM，中文版 Windows PowerShell 5.1 会按 GBK 解析导致语法错误。脚本启动时会自动检测并补回 BOM。

## 适用环境

- Windows 10 / 11
- Windows PowerShell 5.1 或 PowerShell 7+
- 无需安装任何依赖

## 免责声明

- 本脚本通过修改本机 `hosts` 文件优化到 GitHub 的网络路径，**仅用于个人网络环境优化**。
- 请在使用前自行阅读并理解脚本内容；因使用本脚本产生的任何后果由使用者自行承担。
- 请遵守你所在地区的法律法规以及 GitHub 的服务条款。

## 许可证

[MIT](LICENSE)

## 贡献

欢迎提 Issue 和 PR。如果这个脚本帮到了你，给个 ⭐ 就是最好的支持。
