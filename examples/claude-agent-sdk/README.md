# 🛠️ PPIO Sandbox × Claude SDK 开发者指南

## 🚀 开发环境搭建

### 前置要求

- **Node.js**: v20+ (推荐使用 LTS 版本)
- **npm**: v9+
- **TypeScript**: 项目自带，无需全局安装

### 安装依赖

```bash
git clone <repo-url>
cd anthropic-ai-sdk-demo
npm install
```

### 环境变量配置

创建 `.env` 文件（可选，也可在运行时交互输入）：

```bash
# PPIO API Key, https://ppio.com/settings/key-management
PPIO_API_KEY=sk_your_api_key_here
```

---

## 🏃 运行与调试

### 开发模式运行

```bash
npm run agent
```

### 调试模式

在 CLI 中启用详细日志：

```bash
📝 你的需求 > debug on
✅ 详细日志已开启
```

开启后会输出：

- 沙箱创建/销毁日志
- HTTP 健康检查详情
- 工具调用参数与响应
- 服务器进程状态

---

## 🏗️ 代码架构详解

### 核心类：`SandboxAgent`

```
SandboxAgent
├── 状态管理
│   ├── sandbox: Sandbox | null         # PPIO 沙箱实例
│   ├── anthropic: Anthropic | null     # Anthropic SDK 客户端
│   ├── messages: MessageParam[]        # 对话历史
│   ├── serverHandle: CommandHandle     # HTTP 服务器进程句柄
│   └── previewUrl: string | null       # 当前预览 URL
│
├── 生命周期方法
│   ├── initialize()                    # 创建沙箱，注册工具
│   ├── cleanup()                       # 清理资源，关闭沙箱
│   └── refreshSandboxTimeout()         # 刷新沙箱超时时间
│
├── 对话处理
│   ├── chat(userMessage)               # 主对话入口（Agentic Loop）
│   ├── streamResponse()                # 流式响应处理
│   └── processToolCalls()              # 工具调用处理
│
└── 工具实现
    ├── handleWriteFile(input)          # 写入文件到沙箱
    └── handleGetPreviewUrl()           # 启动服务器获取 URL
```

### Agentic Loop 工作流程

```
用户输入
    │
    ▼
┌─────────────────┐
│ 刷新沙箱超时     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 调用 Claude API │◄────────────────┐
└────────┬────────┘                 │
         │                          │
         ▼                          │
┌─────────────────┐                 │
│ 流式输出响应     │                 │
└────────┬────────┘                 │
         │                          │
         ▼                          │
    ┌────────────┐                  │
    │ 有工具调用？ │                  │
    └─────┬──────┘                  │
     是   │   否                    │
          │    └──────► 结束        │
          ▼                         │
    ┌────────────┐                  │
    │ 执行工具    │                  │
    └─────┬──────┘                  │
          │                         │
          ▼                         │
    ┌────────────┐                  │
    │ 添加工具结果 │──────────────────┘
    └────────────┘
```

### 工具定义结构

```typescript
const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "write_file",
    description: "在沙箱中创建或修改文件",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        content: { type: "string", description: "文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "get_preview_url",
    description: "启动服务器并获取预览 URL",
    input_schema: { type: "object", properties: {} },
  },
];
```

---

## 🔧 扩展开发

### 添加新工具

1. **定义工具 schema**：

```typescript
// 在 TOOLS 数组中添加
{
  name: "run_command",
  description: "在沙箱中执行 shell 命令",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的命令" },
      timeout: { type: "number", description: "超时时间(ms)" },
    },
    required: ["command"],
  },
}
```

2. **实现工具处理器**：

```typescript
private async handleRunCommand(input: unknown): Promise<string> {
  const { command, timeout = 30000 } = input as { command: string; timeout?: number };

  if (!this.sandbox) throw new Error("沙箱未初始化");

  try {
    const result = await this.sandbox.commands.run(command, { timeout });
    return `stdout: ${result.stdout}\nstderr: ${result.stderr}`;
  } catch (error) {
    return `执行失败: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

3. **注册处理器**：

```typescript
private registerToolHandlers(): void {
  this.toolHandlers.set("write_file", this.handleWriteFile.bind(this));
  this.toolHandlers.set("get_preview_url", this.handleGetPreviewUrl.bind(this));
  this.toolHandlers.set("run_command", this.handleRunCommand.bind(this));  // 新增
}
```

### 自定义 System Prompt

修改 `SYSTEM_PROMPT` 常量来调整 AI 的行为：

```typescript
const SYSTEM_PROMPT = `你是一个专业的前端开发助手...

新增规则：
6. 所有页面必须支持深色模式
7. 优先使用 CSS Grid 进行布局
8. 添加必要的 ARIA 属性保证可访问性`;
```

### 调整配置参数

```typescript
const CONFIG = {
  model: "zai-org/glm-4.7", // 更换模型
  maxTokens: 16384, // 调整输出长度
  serverPort: 3000, // 更改服务端口
  sandboxTimeoutMs: 10 * 60 * 1000, // 沙箱超时时间
  healthCheck: {
    maxRetries: 30, // 健康检查重试次数
    intervalMs: 2000, // 检查间隔
  },
} as const;
```

---

## 📦 构建发布

### 构建 CommonJS 包（用于调试）

```bash
npm run build:cjs
```

### 构建跨平台可执行文件

```bash
npm run build:release
```

使用 pkg 生成平台原生可执行文件
生成 SHA256 校验和文件

**支持的目标平台**：

- macOS x64 (Intel)
- macOS arm64 (Apple Silicon)
- Linux x64
- Windows x64

### 构建产物

```
release/
├── agent-macos-arm64      # macOS Apple Silicon
├── agent-macos-x64        # macOS Intel
├── agent-linux-x64        # Linux
├── agent-win-x64.exe      # Windows
├── agent-en-macos-arm64   # 英文版...
├── ...
└── checksums.txt          # SHA256 校验和
```

---

## 🔍 核心机制深入

### Context Management（上下文管理）

利用 Claude Beta API 的 `context-management` 特性，自动清理过长的对话历史：

```typescript
const CONTEXT_MANAGEMENT_CONFIG = {
  edits: [
    {
      type: "clear_tool_uses_20250919",
      trigger: { type: "input_tokens", value: 10000 }, // 超过 10k tokens 时触发
      keep: { type: "tool_uses", value: 2 }, // 保留最近 2 次工具调用
      clear_tool_inputs: true, // 清理工具输入
    },
  ],
};
```

**工作原理**：

- 当上下文超过 10,000 tokens 时，API 自动清理旧的工具调用记录
- 保留最近 2 次工具调用，确保 AI 有足够上下文
- 防止"记忆污染"导致的行为退化

### 服务器自愈机制

```typescript
// 检查进程是否存活
private async checkServerProcessAlive(): Promise<boolean> {
  const result = await this.sandbox.commands.run(
    `kill -0 ${this.serverHandle.pid} 2>/dev/null && echo "alive" || echo "dead"`
  );
  return result.stdout.trim() === "alive";
}

// 清理端口占用
private async killPortProcess(port: number): Promise<void> {
  await this.sandbox.commands.run(
    `lsof -ti :${port} 2>/dev/null | xargs -r kill -9 2>/dev/null; echo "done"`
  );
}
```

### 流式响应处理

```typescript
for await (const event of stream) {
  if (event.type === "content_block_delta") {
    if (event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text); // 实时输出
    } else if (event.delta.type === "input_json_delta") {
      // 工具参数流式接收，显示进度
    }
  }
}
```

---

## 🧪 测试与验证

### 手动测试清单

- [ ] 首次启动，交互式输入 API Key
- [ ] 生成简单 HTML 页面
- [ ] 多轮对话修改页面
- [ ] `debug` 命令查看状态
- [ ] `restart` 命令重启服务器
- [ ] `cat index.html` 查看文件内容
- [ ] 服务器超时后自动重启
- [ ] 沙箱销毁后自动重建

### 调试技巧

```bash
# 开启详细日志
📝 你的需求 > debug on

# 查看完整状态
📝 你的需求 > debug

# 查看生成的文件
📝 你的需求 > cat index.html

# 发现 sandbox 服务无法响应
📝 你的需求 > restart
```

## 📚 相关资源

- [Anthropic SDK 文档](https://docs.anthropic.com/claude/reference/client-sdks)
- [PPIO Sandbox API](https://ppio.com/docs/sandbox/overview)
- [Claude Context Management](https://platform.claude.com/docs/en/build-with-claude/context-editing)
- [pkg 打包工具](https://github.com/yao-pkg/pkg)
- [esbuild 文档](https://esbuild.github.io/)

---
