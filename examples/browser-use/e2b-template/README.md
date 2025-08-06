# Browser-Use 远程 Chromium 连接解决方案

这是一个完整的解决方案，让 `browser-use` 可以在本地通过 Chrome DevTools Protocol (CDP) 连接到运行在 E2B sandbox 中的远程 Chromium 实例。

## 核心问题

在云端 sandbox 环境中，`browser-use` 连接远程 Chromium 面临两个主要挑战：

1. **Host Header 安全限制** - Chromium 拒绝来自非本地域名的 CDP 连接请求
2. **WebSocket URL 重写** - 需要将内部地址 (`127.0.0.1:9222`) 重写为外部可访问地址

## 解决方案架构

### 整体流程

```
本地 browser-use → E2B外部域名:9223 → Go反向代理 → Chromium:9222
```

### 核心组件

1. **手动下载的 Chromium** - 最新版本，避免包管理器限制
2. **增强版 Go 反向代理** - 智能处理 Host header 和 WebSocket URL 重写  
3. **E2B Sandbox** - 提供容器化运行环境

## 工作流程

### 1. 容器启动阶段
- 从 Google 官方下载最新 Chromium 二进制文件
- 启动 Chromium，绑定到内部地址 `127.0.0.1:9222`
- 启动 Go 反向代理，监听外部地址 `0.0.0.0:9223`

### 2. 连接建立阶段  
- `browser-use` 向 E2B 外部域名发起连接请求
- 反向代理拦截请求，重写 Host header 为 `127.0.0.1:9222`
- Chromium 接收到"本地请求"，通过安全验证

### 3. CDP 协议交互阶段

`browser-use` 遵循标准的 Chrome DevTools Protocol 连接流程：

**第一步：获取 WebSocket 连接信息**
```
browser-use → GET https://9223-sandbox-host/json/version/
            ↓ (反向代理重写 Host header)
            → GET http://127.0.0.1:9222/json/version/
```

**Chrome 原始响应：**
```json
{
  "Browser": "Chrome/138.0.7204.168",
  "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/browser/abc123"
}
```

**反向代理动态重写响应：**
```json
{
  "Browser": "Chrome/138.0.7204.168", 
  "webSocketDebuggerUrl": "wss://9223-sandbox-host/devtools/browser/abc123"
}
```

**第二步：建立 WebSocket 连接**
```
browser-use → WSS wss://9223-sandbox-host/devtools/browser/abc123
            ↓ (反向代理处理 WebSocket 升级 + Host 重写)
            → WS ws://127.0.0.1:9222/devtools/browser/abc123
```

**关键重写点：**
- `ws://` → `wss://` (E2B HTTPS 环境要求安全 WebSocket)
- `127.0.0.1:9222` → `9223-sandbox-host` (重写为外部可访问地址)
- Host header: `sandbox-host` → `127.0.0.1:9222` (绕过 Chromium 安全限制)

**为什么需要重写：**
- Chromium 的安全机制只允许本地地址访问 CDP
- E2B sandbox 通过 HTTPS 对外提供服务，需要 WSS 协议
- `browser-use` 需要获得正确的外部 WebSocket URL 才能连接

### 4. 实时通信阶段
- WebSocket 连接建立后，所有 CDP 命令透明代理
- `browser-use` 发送操作指令 (点击、输入、截图等)
- Chromium 返回页面状态和响应数据
- 反向代理确保双向通信的稳定性

## 关键特性

### 🛡️ 安全绕过
- 智能 Host header 重写，绕过 Chromium 安全限制
- 支持多种 URL 格式识别和转换

### 🔌 协议兼容  
- 完整支持 HTTP 和 WebSocket 协议
- 自动处理 `/json/version` 和 `/json` 端点

### 📊 生产就绪
- 内置健康检查 (`/health`) 和性能监控 (`/metrics`)
- 可配置的超时、日志级别等参数

### 🎯 高性能
- 只对必要的端点进行拦截处理
- 其他流量直接透明代理，最小化开销

## 部署方式

### 一键构建（推荐）
```bash
# 运行一键构建脚本
./build.sh
```

构建脚本会自动：
1. 检查 Go 和 E2B CLI 依赖
2. 编译 Go 反向代理为 Linux x86 二进制文件  
3. 构建 E2B Template

### 手动构建
如需手动构建，可以分步执行：

```bash
# 1. 编译反向代理
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags="-s -w" -o reverse-proxy reverse-proxy.go

# 2. 构建模板
e2b template build -c "/app/.browser-use/start-up.sh"
```

### 本地连接
```python
from e2b_code_interpreter import Sandbox
from browser_use import Agent

# 创建 sandbox
sandbox = Sandbox(template="your-template-id")

# 获取 Chrome 连接地址（端口 9223）
host = sandbox.get_host(9223)
cdp_url = f"https://{host}"

# 连接 browser-use
agent = Agent(
    task="你的任务",
    llm=llm,
    use_vision=True
)

# 使用远程 Chrome
result = agent.run(cdp_url=cdp_url)
```

## 网络架构

```
┌─────────────────┐    HTTPS     ┌──────────────────┐
│   browser-use   │─────────────→│  E2B External    │
│     (本地)      │              │   Domain:9223    │
└─────────────────┘              └──────────────────┘
                                           │
                                           │ HTTP
                                           ▼
                                 ┌──────────────────┐
                                 │   Go Reverse     │
                                 │     Proxy        │
                                 │  (Host重写)      │
                                 └──────────────────┘
                                           │
                                           │ HTTP  
                                           ▼
                                 ┌──────────────────┐
                                 │     Chromium     │
                                 │  127.0.0.1:9222  │
                                 └──────────────────┘
```

## 方案优势

- ✅ **开箱即用** - 一次配置，稳定运行
- ✅ **版本最新** - 总是使用 Google 最新 Chromium 构建
- ✅ **性能优化** - 精确拦截，最小化代理开销  
- ✅ **监控完善** - 内置健康检查和性能指标
- ✅ **容器友好** - 专为 Docker/E2B 环境设计
- ✅ **协议完整** - 全面支持 CDP 的 HTTP 和 WebSocket 通信
