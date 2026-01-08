import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox, CommandHandle } from "ppio-sandbox/code-interpreter";
import open from "open";
import * as readline from "readline";

// ============================================================================
// Types
// ============================================================================

interface WriteFileInput {
  path: string;
  content: string;
}

interface ToolHandler {
  (input: unknown): Promise<string>;
}

interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  model: "zai-org/glm-4.7",
  maxTokens: 16384, // 增加到 16K 以支持长代码
  serverPort: 3000,
  sandboxTimeoutMs: 10 * 60 * 1000, // 10 分钟
  maxContinueAttempts: 3, // 最多续写 3 次
  healthCheck: {
    maxRetries: 30,
    intervalMs: 2000,
    quickCheckRetries: 5,
    quickCheckIntervalMs: 500,
  },
} as const;

const SYSTEM_PROMPT = `你是一个专业的前端开发助手，擅长使用 Tailwind CSS 创建现代化的网页。

规则：
1. 当用户要求创建或修改网页时，使用 write_file 工具写入文件
2. 写入文件后，使用 get_preview_url 工具启动服务器并获取预览地址
3. 当用户要求修改现有网页时，直接修改相应文件，服务器会自动更新
4. 始终使用 Tailwind CSS CDN 来快速实现样式
5. 代码要简洁、现代、美观`;

const TOOLS: Anthropic.Beta.Messages.BetaTool[] = [
  {
    name: "write_file",
    description: "在沙箱中创建或修改文件",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径，如 index.html" },
        content: { type: "string", description: "文件完整内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "get_preview_url",
    description: "启动 Web 服务器并获取预览 URL（如果服务器已运行则返回现有地址）",
    input_schema: { type: "object", properties: {} },
  },
];

const CONTEXT_MANAGEMENT_CONFIG = {
  edits: [
    {
      type: "clear_tool_uses_20250919" as const,
      trigger: { type: "input_tokens", value: 10000 },
      keep: { type: "tool_uses", value: 2 },
      clear_tool_inputs: true,
    },
  ],
};

// ============================================================================
// Utilities
// ============================================================================

// 全局调试模式开关
let DEBUG_MODE = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function logDebug(context: string, message: string, data?: unknown): void {
  if (!DEBUG_MODE) return;
  
  const timestamp = new Date().toISOString().slice(11, 19); // 只显示时间 HH:MM:SS
  console.log(`[${timestamp}] 🔍 [${context}] ${message}`);
  if (data !== undefined) {
    // 精简输出：只显示关键字段
    const simplified = simplifyDebugData(data);
    if (simplified) {
      console.log(`   └─ ${simplified}`);
    }
  }
}

function simplifyDebugData(data: unknown): string {
  if (typeof data !== "object" || data === null) {
    return String(data);
  }
  
  const obj = data as Record<string, unknown>;
  const parts: string[] = [];
  
  // 只显示关键字段
  const keyFields = ["status", "ok", "error", "pid", "url", "previewUrl", "isHealthy", "isReady", "sandboxId"];
  for (const key of keyFields) {
    if (key in obj) {
      parts.push(`${key}=${JSON.stringify(obj[key])}`);
    }
  }
  
  return parts.length > 0 ? parts.join(", ") : JSON.stringify(data);
}

async function waitForServer(
  url: string,
  maxRetries: number,
  intervalMs: number,
  silent = false
): Promise<boolean> {
  let spinner: Spinner | null = null;
  
  if (!silent) {
    spinner = new Spinner(`正在等待服务器就绪... (0/${maxRetries})`);
    spinner.start();
    logDebug("waitForServer", `开始健康检查`, { url, maxRetries, intervalMs });
  }

  for (let i = 0; i < maxRetries; i++) {
    if (spinner) {
      spinner.update(`正在等待服务器就绪... (${i + 1}/${maxRetries})`);
    }
    
    try {
      const response = await fetch(url, { method: "HEAD" });
      if (!silent) {
        logDebug("waitForServer", `收到响应`, { 
          attempt: i + 1, 
          status: response.status, 
          ok: response.ok,
          statusText: response.statusText
        });
      }
      if (response.ok) {
        if (spinner) {
          spinner.stop(`✅ 服务器已就绪`);
        }
        return true;
      }
    } catch (error) {
      // 服务器尚未就绪，继续重试
      if (!silent) {
        logDebug("waitForServer", `请求失败 (${i + 1}/${maxRetries})`, { 
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    await sleep(intervalMs);
  }

  if (spinner) {
    spinner.stop(`❌ 服务器响应超时`);
  }
  if (!silent) {
    logDebug("waitForServer", `健康检查失败，已达到最大重试次数`, { maxRetries });
  }
  return false;
}

async function openBrowser(url: string): Promise<void> {
  console.log(`🌐 正在打开浏览器: ${url}`);
  await open(url);
}

function createReadlineInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

// Spinner 动画类
class Spinner {
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentFrame = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start(): void {
    process.stdout.write(`\r${this.frames[0]} ${this.message}`);
    this.interval = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.message}`);
    }, 80);
  }

  update(message: string): void {
    this.message = message;
    process.stdout.write(`\r${this.frames[this.currentFrame]} ${this.message}   `);
  }

  stop(finalMessage?: string): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (finalMessage) {
      process.stdout.write(`\r${finalMessage}\n`);
    } else {
      process.stdout.write("\r" + " ".repeat(this.message.length + 5) + "\r");
    }
  }
}

async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

function isValidApiKey(key: string): boolean {
  // 简单验证：非空且长度合理
  return key.trim().length >= 10;
}

// ============================================================================
// Agent Core
// ============================================================================

class SandboxAgent {
  private sandbox: Sandbox | null = null;
  private anthropic: Anthropic | null = null;
  private toolHandlers: Map<string, ToolHandler> = new Map();
  private messages: Anthropic.Beta.Messages.BetaMessageParam[] = [];
  private serverHandle: CommandHandle | null = null;
  private previewUrl: string | null = null;
  private browserOpened = false;
  private apiKey: string | null = null;

  constructor() {
    // 尝试从环境变量获取 API Key
    this.apiKey = process.env.PPIO_API_KEY || null;
  }

  hasApiKey(): boolean {
    return this.apiKey !== null && isValidApiKey(this.apiKey);
  }

  setApiKey(key: string): boolean {
    if (!isValidApiKey(key)) {
      return false;
    }
    this.apiKey = key.trim();
    this.anthropic = new Anthropic({
      baseURL: "https://api.ppinfra.com/anthropic",
      apiKey: this.apiKey,
    });
    console.log(`✅ API Key 已设置: ${maskApiKey(this.apiKey)}`);
    return true;
  }

  getPreviewUrl(): string | null {
    return this.previewUrl;
  }

  async forceRestartServer(): Promise<void> {
    if (!this.sandbox) {
      console.log("⚠️  沙箱未初始化");
      return;
    }
    await this.restartServer();
    if (this.previewUrl) {
      console.log(`🌐 预览地址: ${this.previewUrl}`);
    }
  }

  private ensureAnthropicClient(): void {
    if (!this.anthropic) {
      if (!this.apiKey) {
        throw new Error("API Key 未设置");
      }
      this.anthropic = new Anthropic({
        baseURL: "https://api.ppinfra.com/anthropic",
        apiKey: this.apiKey,
      });
    }
  }

  async initialize(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("API Key 未设置，无法初始化沙箱");
    }

    const spinner = new Spinner("正在初始化沙箱环境...");
    spinner.start();
    logDebug("initialize", "开始创建沙箱", {
      timeoutMs: CONFIG.sandboxTimeoutMs,
      hasApiKey: !!this.apiKey,
    });

    this.sandbox = await Sandbox.create({
      apiKey: this.apiKey,
      timeoutMs: CONFIG.sandboxTimeoutMs,
    });

    const sandboxId = (this.sandbox as { id?: string }).id ?? "unknown";
    logDebug("initialize", "沙箱创建成功", {
      sandboxId,
      timeoutMs: CONFIG.sandboxTimeoutMs,
    });
    spinner.stop(`✅ 沙箱启动成功 (ID: ${sandboxId})\n`);

    this.registerToolHandlers();
  }

  private async refreshSandboxTimeout(): Promise<void> {
    logDebug("refreshSandboxTimeout", "尝试刷新沙箱超时时间", {
      hasSandbox: !!this.sandbox,
      newTimeoutMs: CONFIG.sandboxTimeoutMs,
    });

    if (this.sandbox) {
      try {
        await this.sandbox.setTimeout(CONFIG.sandboxTimeoutMs);
        logDebug("refreshSandboxTimeout", "沙箱超时时间刷新成功");
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error("⚠️  更新沙箱超时时间失败:", error);
        logDebug("refreshSandboxTimeout", "❌ 沙箱超时时间刷新失败", {
          error: errorMessage,
          stack: error instanceof Error ? error.stack : undefined,
        });

        // 检查是否是沙箱已被销毁的错误 (404 Not Found)
        if (errorMessage.includes("404") || errorMessage.includes("not found")) {
          logDebug("refreshSandboxTimeout", "🔄 沙箱已被销毁，正在重新创建...", {
            hadPreviewUrl: !!this.previewUrl,
            hadServerHandle: !!this.serverHandle,
          });

          // 清理旧状态
          this.clearSandboxState();

          // 重新创建沙箱
          await this.recreateSandbox();
        }
      }
    } else {
      logDebug("refreshSandboxTimeout", "⚠️ 沙箱实例不存在，正在创建新沙箱...");
      await this.recreateSandbox();
    }
  }

  private clearSandboxState(): void {
    logDebug("clearSandboxState", "清理旧的沙箱状态", {
      hadPreviewUrl: !!this.previewUrl,
      hadServerHandle: !!this.serverHandle,
      oldPreviewUrl: this.previewUrl,
      oldServerPid: this.serverHandle?.pid ?? null,
    });

    this.sandbox = null;
    this.serverHandle = null;
    this.previewUrl = null;
    this.browserOpened = false;
  }

  private async recreateSandbox(): Promise<void> {
    if (!this.apiKey) {
      throw new Error("API Key 未设置，无法创建沙箱");
    }

    const spinner = new Spinner("正在重新创建沙箱环境...");
    spinner.start();
    logDebug("recreateSandbox", "开始创建新沙箱", {
      timeoutMs: CONFIG.sandboxTimeoutMs,
      hasApiKey: !!this.apiKey,
    });

    try {
      this.sandbox = await Sandbox.create({
        apiKey: this.apiKey,
        timeoutMs: CONFIG.sandboxTimeoutMs,
      });

      const sandboxId = (this.sandbox as { id?: string }).id ?? "unknown";
      logDebug("recreateSandbox", "新沙箱创建成功", {
        sandboxId,
        timeoutMs: CONFIG.sandboxTimeoutMs,
      });
      spinner.stop(`✅ 新沙箱已创建 (ID: ${sandboxId})`);
      console.log("📝 注意：之前创建的文件已丢失，需要重新生成\n");
    } catch (error) {
      spinner.stop("❌ 创建新沙箱失败");
      logDebug("recreateSandbox", "❌ 创建新沙箱失败", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      console.error("错误详情:", error);
      throw error;
    }
  }

  private registerToolHandlers(): void {
    this.toolHandlers.set("write_file", this.handleWriteFile.bind(this));
    this.toolHandlers.set("get_preview_url", this.handleGetPreviewUrl.bind(this));
  }

  private async checkServerProcessAlive(): Promise<boolean> {
    if (!this.sandbox || !this.serverHandle?.pid) {
      return false;
    }

    try {
      // 使用 kill -0 检查进程是否存在（不会真的杀死进程）
      const result = await this.sandbox.commands.run(
        `kill -0 ${this.serverHandle.pid} 2>/dev/null && echo "alive" || echo "dead"`
      );
      const isAlive = result.stdout.trim() === "alive";
      logDebug("checkServerProcessAlive", "进程检查结果", {
        pid: this.serverHandle.pid,
        isAlive,
        stdout: result.stdout.trim(),
      });
      return isAlive;
    } catch (error) {
      logDebug("checkServerProcessAlive", "进程检查失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private async killPortProcess(port: number): Promise<void> {
    if (!this.sandbox) return;

    try {
      // 查找并杀死占用指定端口的所有进程
      const result = await this.sandbox.commands.run(
        `lsof -ti :${port} 2>/dev/null | xargs -r kill -9 2>/dev/null; echo "done"`
      );
      logDebug("killPortProcess", "清理端口占用", {
        port,
        result: result.stdout.trim(),
      });
      
      // 等待一小段时间确保进程完全退出
      await sleep(200);
    } catch (error) {
      // 如果没有进程占用端口，命令可能会失败，这是正常的
      logDebug("killPortProcess", "清理端口时出错（可忽略）", {
        port,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async restartServer(): Promise<void> {
    if (!this.sandbox) return;

    logDebug("restartServer", "开始重启服务器", {
      oldPid: this.serverHandle?.pid ?? null,
    });

    // 清理旧状态
    this.serverHandle = null;

    // 清理端口
    await this.killPortProcess(CONFIG.serverPort);

    // 启动新服务器
    try {
      this.serverHandle = await this.sandbox.commands.run(
        `npx -y http-server . -p ${CONFIG.serverPort} -c-1`,
        {
          background: true,
          onStdout: (data) => {
            if (DEBUG_MODE) {
              console.log(`[server] ${data.trim()}`);
            }
          },
          onStderr: (data) => {
            if (DEBUG_MODE) {
              console.error(`[server:err] ${data.trim()}`);
            }
          },
        }
      );
      
      console.log(`🔄 服务器已重启 (PID: ${this.serverHandle.pid})`);
      logDebug("restartServer", "服务器重启成功", {
        pid: this.serverHandle.pid,
      });

      // 等待服务器就绪
      if (this.previewUrl) {
        const isReady = await waitForServer(
          this.previewUrl,
          10, // 快速检查 10 次
          500, // 每次间隔 500ms
          true // 静默模式
        );
        if (isReady) {
          console.log(`✅ 服务器已就绪`);
          // 延迟 3 秒后自动刷新浏览器，确保服务器完全稳定
          console.log(`⏳ 3 秒后自动刷新浏览器...`);
          setTimeout(async () => {
            await this.refreshBrowser();
          }, 3000);
        } else {
          console.log(`⚠️  服务器可能未完全就绪，请稍后刷新页面`);
        }
      }
    } catch (error) {
      console.error(`❌ 服务器重启失败:`, error);
      logDebug("restartServer", "服务器重启失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async refreshBrowser(): Promise<void> {
    if (!this.previewUrl || !this.browserOpened) {
      return;
    }

    try {
      // 使用 AppleScript 刷新当前浏览器标签页 (macOS)
      // 这比重新打开 URL 更优雅，不会创建新标签页
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);

      // 尝试刷新 Chrome
      const chromeScript = `
        tell application "Google Chrome"
          if (count of windows) > 0 then
            tell active tab of front window
              reload
            end tell
          end if
        end tell
      `;

      await execAsync(`osascript -e '${chromeScript}'`).catch(() => {
        // Chrome 可能没有运行，忽略错误
      });

      console.log(`🔄 已发送刷新请求到浏览器`);
      logDebug("refreshBrowser", "浏览器刷新请求已发送");
    } catch (error) {
      // 如果刷新失败，不影响主流程
      logDebug("refreshBrowser", "浏览器刷新失败（可忽略）", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async handleWriteFile(input: unknown): Promise<string> {
    logDebug("handleWriteFile", "开始写入文件", {
      hasSandbox: !!this.sandbox,
    });

    if (!this.sandbox) throw new Error("沙箱未初始化");

    const { path, content } = input as WriteFileInput;

    try {
      await this.sandbox.files.write(path, content);
      console.log(`📝 文件已写入: ${path}`);
      logDebug("handleWriteFile", "文件写入成功", {
        path,
        contentLength: content.length,
      });

      // 如果是 HTML 文件，检查服务器状态并在必要时重启
      if (path.endsWith(".html") && this.previewUrl) {
        const processAlive = await this.checkServerProcessAlive();
        if (!processAlive) {
          console.log(`⚠️  检测到服务器已停止，正在自动重启...`);
          setTimeout(async () => {
            await this.restartServer();
          }, 5000);
        }
      }

      return `文件 ${path} 已成功写入沙箱`;
    } catch (error) {
      logDebug("handleWriteFile", "❌ 文件写入失败", {
        path,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  private async handleGetPreviewUrl(): Promise<string> {
    logDebug("handleGetPreviewUrl", "开始处理获取预览URL请求", {
      hasSandbox: !!this.sandbox,
      hasPreviewUrl: !!this.previewUrl,
      hasServerHandle: !!this.serverHandle,
      currentPreviewUrl: this.previewUrl,
      serverPid: this.serverHandle?.pid ?? null,
    });

    if (!this.sandbox) throw new Error("沙箱未初始化");

    // 检查 sandbox 的状态
    try {
      const sandboxHost = this.sandbox.getHost(CONFIG.serverPort);
      logDebug("handleGetPreviewUrl", "Sandbox 状态检查", {
        sandboxHost,
        sandboxId: (this.sandbox as { id?: string }).id ?? "unknown",
      });
    } catch (error) {
      logDebug("handleGetPreviewUrl", "⚠️ Sandbox 状态检查失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    let serverAlreadyRunning = !!(this.previewUrl && this.serverHandle);
    logDebug("handleGetPreviewUrl", "服务器运行状态", {
      serverAlreadyRunning,
    });

    // 先验证进程是否真的存活
    if (serverAlreadyRunning) {
      const processAlive = await this.checkServerProcessAlive();
      if (!processAlive) {
        console.log(`⚠️  服务器进程已退出 (PID: ${this.serverHandle!.pid})，需要重启...`);
        logDebug("handleGetPreviewUrl", "服务器进程已退出，清理状态", {
          oldPid: this.serverHandle!.pid,
        });
        this.serverHandle = null;
        this.previewUrl = null;
        serverAlreadyRunning = false;
      }
    }

    if (serverAlreadyRunning) {
      console.log(`📋 服务器已在运行，PID: ${this.serverHandle!.pid}`);

      logDebug("handleGetPreviewUrl", "开始快速健康检查", {
        url: this.previewUrl,
        retries: CONFIG.healthCheck.quickCheckRetries,
        intervalMs: CONFIG.healthCheck.quickCheckIntervalMs,
      });

      // 快速健康检查确保服务仍在响应
      const isHealthy = await waitForServer(
        this.previewUrl!,
        CONFIG.healthCheck.quickCheckRetries,
        CONFIG.healthCheck.quickCheckIntervalMs,
        false // 改为 false，输出详细日志
      );

      logDebug("handleGetPreviewUrl", "健康检查结果", { isHealthy });

      if (isHealthy) {
        console.log(`✅ 服务器响应正常`);
        return `预览地址: ${this.previewUrl}（刷新浏览器查看更新）`;
      }

      // 服务器不响应，需要重启
      console.log(`⚠️  服务器无响应，正在重启...`);
      logDebug("handleGetPreviewUrl", "服务器无响应，准备重启", {
        oldPid: this.serverHandle!.pid,
        oldUrl: this.previewUrl,
      });

      try {
        await this.serverHandle!.kill();
        logDebug("handleGetPreviewUrl", "旧服务器进程已终止");
      } catch (error) {
        logDebug("handleGetPreviewUrl", "终止旧服务器进程时出错（可忽略）", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.serverHandle = null;
      this.previewUrl = null;
    }

    console.log("🔧 正在启动 HTTP 服务器...");
    logDebug("handleGetPreviewUrl", "准备启动新的 HTTP 服务器", {
      port: CONFIG.serverPort,
    });

    // 先清理可能占用端口的进程
    await this.killPortProcess(CONFIG.serverPort);

    // 启动后台服务器
    try {
      this.serverHandle = await this.sandbox.commands.run(
        `npx -y http-server . -p ${CONFIG.serverPort} -c-1`,
        {
          background: true,
          onStdout: (data) => {
            console.log(`[server] ${data.trim()}`);
            logDebug("server:stdout", data.trim());
          },
          onStderr: (data) => {
            console.error(`[server:err] ${data.trim()}`);
            logDebug("server:stderr", data.trim());
          },
        }
      );
      console.log(`📋 服务器进程 PID: ${this.serverHandle.pid}`);
      logDebug("handleGetPreviewUrl", "服务器进程已启动", {
        pid: this.serverHandle.pid,
      });
    } catch (error) {
      logDebug("handleGetPreviewUrl", "❌ 启动服务器失败", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }

    // 获取预览 URL
    try {
      const host = this.sandbox.getHost(CONFIG.serverPort);
      this.previewUrl = `https://${host}`;
      logDebug("handleGetPreviewUrl", "预览 URL 已生成", {
        host,
        previewUrl: this.previewUrl,
      });
    } catch (error) {
      logDebug("handleGetPreviewUrl", "❌ 获取预览 URL 失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // 健康检查
    logDebug("handleGetPreviewUrl", "开始完整健康检查", {
      url: this.previewUrl,
      maxRetries: CONFIG.healthCheck.maxRetries,
      intervalMs: CONFIG.healthCheck.intervalMs,
    });

    const isReady = await waitForServer(
      this.previewUrl,
      CONFIG.healthCheck.maxRetries,
      CONFIG.healthCheck.intervalMs
    );

    logDebug("handleGetPreviewUrl", "健康检查完成", {
      isReady,
      browserOpened: this.browserOpened,
    });

    if (isReady && !this.browserOpened) {
      await openBrowser(this.previewUrl);
      this.browserOpened = true;
      return `预览地址: ${this.previewUrl}`;
    }

    if (isReady) {
      return `预览地址: ${this.previewUrl}（刷新浏览器查看更新）`;
    }

    logDebug("handleGetPreviewUrl", "⚠️ 服务器启动完成但健康检查未通过", {
      previewUrl: this.previewUrl,
    });
    return `预览地址已生成但服务器可能未就绪: ${this.previewUrl}`;
  }

  async chat(userMessage: string): Promise<void> {
    logDebug("chat", "开始处理用户消息", {
      messageLength: userMessage.length,
      currentState: {
        hasSandbox: !!this.sandbox,
        hasPreviewUrl: !!this.previewUrl,
        hasServerHandle: !!this.serverHandle,
        previewUrl: this.previewUrl,
        serverPid: this.serverHandle?.pid ?? null,
      },
    });

    this.ensureAnthropicClient();

    // 每次用户输入时，刷新沙箱超时时间
    await this.refreshSandboxTimeout();

    console.log("\n" + "─".repeat(60));

    // 添加用户消息
    this.messages.push({ role: "user", content: userMessage });

    // Agentic Loop - 持续处理直到没有工具调用
    let continueLoop = true;
    while (continueLoop) {
      // 显示等待动画
      const waitingSpinner = new Spinner("AI 正在思考中...");
      waitingSpinner.start();

      // 使用流式输出
      const { response, assistantContent } = await this.streamResponse(waitingSpinner);

      logDebug("chat", "响应完成", {
        stopReason: response.stop_reason,
        contentBlocks: assistantContent.length,
      });

      // 将助手响应添加到消息历史
      this.messages.push({ role: "assistant", content: assistantContent });

      // 检查是否因为 max_tokens 被截断
      if (response.stop_reason === "max_tokens") {
        console.log("\n⚠️  输出被截断，正在继续生成...");
        // 添加续写提示
        this.messages.push({ 
          role: "user", 
          content: "请继续输出，从上次截断的地方继续（不要重复已输出的内容）" 
        });
        continueLoop = true;
        continue;
      }

      // 处理工具调用
      const { hasToolUse, toolResults } = await this.processToolCalls(assistantContent);

      // 如果有工具调用，添加工具结果并继续循环
      if (hasToolUse && toolResults.length > 0) {
        this.messages.push({ role: "user", content: toolResults });
        continueLoop = true;
      } else {
        continueLoop = false;
      }

      // 如果响应是 end_turn，停止循环
      if (response.stop_reason === "end_turn") {
        continueLoop = false;
      }
    }
  }

  private async streamResponse(waitingSpinner?: Spinner): Promise<{
    response: { stop_reason: string | null };
    assistantContent: Anthropic.Beta.Messages.BetaContentBlockParam[];
  }> {
    const assistantContent: Anthropic.Beta.Messages.BetaContentBlockParam[] = [];
    let currentTextBlock = "";
    let currentToolUse: { id: string; name: string; input: string } | null = null;
    let stopReason: string | null = null;
    let isFirstText = true;
    let spinnerStopped = false;

    const stream = this.anthropic!.beta.messages.stream({
      model: CONFIG.model,
      max_tokens: CONFIG.maxTokens,
      system: SYSTEM_PROMPT,
      betas: ["context-management-2025-06-27"],
      tools: TOOLS,
      messages: this.messages,
    } as Parameters<typeof Anthropic.prototype.beta.messages.stream>[0]);

    // 用于显示 write_file 进度
    let lastProgressUpdate = 0;
    const PROGRESS_INTERVAL = 500; // 每 500ms 更新一次进度

    for await (const event of stream) {
      // 收到第一个事件时停止等待动画
      if (waitingSpinner && !spinnerStopped) {
        waitingSpinner.stop();
        spinnerStopped = true;
        process.stdout.write("🤖 ");
      }

      if (event.type === "content_block_start") {
        if (event.content_block.type === "text") {
          currentTextBlock = "";
          if (isFirstText) {
            process.stdout.write("💬 ");
            isFirstText = false;
          }
        } else if (event.content_block.type === "tool_use") {
          currentToolUse = {
            id: event.content_block.id,
            name: event.content_block.name,
            input: "",
          };
          // 显示开始调用工具
          if (event.content_block.name === "write_file") {
            process.stdout.write(`\n📝 正在生成文件内容...`);
          } else {
            console.log(`\n🔨 调用工具: ${event.content_block.name}`);
          }
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          // 实时输出文本
          process.stdout.write(event.delta.text);
          currentTextBlock += event.delta.text;
        } else if (event.delta.type === "input_json_delta") {
          if (currentToolUse) {
            currentToolUse.input += event.delta.partial_json;
            
            // 对于 write_file，显示生成进度
            if (currentToolUse.name === "write_file") {
              const now = Date.now();
              if (now - lastProgressUpdate > PROGRESS_INTERVAL) {
                const size = currentToolUse.input.length;
                const sizeStr = size > 1024 ? `${(size / 1024).toFixed(1)}KB` : `${size}B`;
                process.stdout.write(`\r📝 正在生成文件内容... ${sizeStr}`);
                lastProgressUpdate = now;
              }
            }
          }
        }
      } else if (event.type === "content_block_stop") {
        if (currentTextBlock) {
          assistantContent.push({ type: "text", text: currentTextBlock });
          currentTextBlock = "";
        }
        if (currentToolUse) {
          try {
            const parsedInput = JSON.parse(currentToolUse.input || "{}");
            assistantContent.push({
              type: "tool_use",
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: parsedInput,
            });
            
            // 显示工具调用完成信息
            if (currentToolUse.name === "write_file" && parsedInput.path) {
              const contentSize = (parsedInput.content || "").length;
              const sizeStr = contentSize > 1024 ? `${(contentSize / 1024).toFixed(1)}KB` : `${contentSize}B`;
              console.log(`\r📝 生成完成: ${parsedInput.path} (${sizeStr})`);
            }
          } catch {
            // 如果 JSON 解析失败，使用空对象
            assistantContent.push({
              type: "tool_use",
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: {},
            });
            console.log(`\n⚠️ 工具参数解析失败`);
          }
          currentToolUse = null;
        }
      } else if (event.type === "message_stop") {
        // 消息结束
      } else if (event.type === "message_delta") {
        stopReason = event.delta.stop_reason;
      }
    }

    // 确保换行
    console.log("");

    return {
      response: { stop_reason: stopReason },
      assistantContent,
    };
  }

  private async processToolCalls(
    assistantContent: Anthropic.Beta.Messages.BetaContentBlockParam[]
  ): Promise<{
    hasToolUse: boolean;
    toolResults: ToolResult[];
  }> {
    const toolResults: ToolResult[] = [];
    let hasToolUse = false;

    for (const block of assistantContent) {
      if (block.type === "tool_use") {
        hasToolUse = true;
        const result = await this.executeTool(block.name, block.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result,
        });
      }
    }

    return { hasToolUse, toolResults };
  }

  private async executeTool(name: string, input: unknown): Promise<string> {
    const handler = this.toolHandlers.get(name);

    if (!handler) {
      console.error(`❌ 未知工具: ${name}`);
      return `错误: 未知工具 ${name}`;
    }

    console.log(`\n🔨 执行工具: ${name}`);
    try {
      const result = await handler(input);
      console.log(`✅ 工具执行成功`);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`❌ 工具执行失败:`, errorMessage);
      return `错误: ${errorMessage}`;
    }
  }

  clearHistory(): void {
    this.messages = [];
  }

  // ==================== 调试功能 ====================

  async listSandboxFiles(): Promise<string[]> {
    if (!this.sandbox) {
      console.log("⚠️  沙箱未初始化");
      return [];
    }

    try {
      const files = await this.sandbox.files.list(".");
      return files.map((f) => f.name);
    } catch (error) {
      console.error("❌ 获取文件列表失败:", error);
      return [];
    }
  }

  async readSandboxFile(path: string): Promise<string | null> {
    if (!this.sandbox) {
      console.log("⚠️  沙箱未初始化");
      return null;
    }

    try {
      const content = await this.sandbox.files.read(path);
      return content;
    } catch (error) {
      console.error(`❌ 读取文件 ${path} 失败:`, error);
      return null;
    }
  }

  async getServerStatus(): Promise<{ running: boolean; pid: number | null; url: string | null }> {
    const status = {
      running: false,
      pid: this.serverHandle?.pid ?? null,
      url: this.previewUrl,
    };

    if (!this.previewUrl) {
      return status;
    }

    try {
      const response = await fetch(this.previewUrl, { 
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
      });
      status.running = response.ok;
    } catch {
      status.running = false;
    }

    return status;
  }

  async showDebugInfo(): Promise<void> {
    console.log("\n" + "═".repeat(60));
    console.log("🔧 调试信息");
    console.log("═".repeat(60));

    // 沙箱状态
    const sandboxId = this.sandbox ? (this.sandbox as { id?: string }).id ?? "unknown" : "未初始化";
    console.log(`\n📦 沙箱状态:`);
    console.log(`   ID: ${sandboxId}`);
    console.log(`   实例: ${this.sandbox ? "✅ 存在" : "❌ 不存在"}`);

    // 服务器状态
    const serverStatus = await this.getServerStatus();
    const processAlive = await this.checkServerProcessAlive();
    console.log(`\n🌐 服务器状态:`);
    console.log(`   PID: ${serverStatus.pid ?? "无"}`);
    console.log(`   URL: ${serverStatus.url ?? "无"}`);
    console.log(`   进程存活: ${processAlive ? "✅ 是" : "❌ 否"}`);
    console.log(`   HTTP响应: ${serverStatus.running ? "✅ 正常" : "❌ 无响应"}`);

    // 如果进程不存在但有 PID，显示诊断信息并提供重启
    if (serverStatus.pid && !processAlive) {
      console.log(`   ⚠️  诊断: 进程 ${serverStatus.pid} 已退出`);
      console.log(`   💡 提示: 输入 'restart' 可手动重启服务器`);
    }

    // 查看沙箱中运行的进程
    if (this.sandbox) {
      console.log(`\n🔍 沙箱进程 (http-server 相关):`);
      try {
        const result = await this.sandbox.commands.run(`ps aux | grep -E "http-server|node" | grep -v grep | head -5`);
        if (result.stdout.trim()) {
          const lines = result.stdout.trim().split("\n");
          lines.forEach((line) => {
            // 简化输出，只显示关键信息
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 11) {
              const pid = parts[1];
              const cmd = parts.slice(10).join(" ").slice(0, 50);
              console.log(`   PID ${pid}: ${cmd}${cmd.length >= 50 ? "..." : ""}`);
            }
          });
        } else {
          console.log("   (无 http-server 相关进程)");
        }
      } catch {
        console.log("   (无法获取进程列表)");
      }
    }

    // 文件列表
    console.log(`\n📁 沙箱文件:`);
    const files = await this.listSandboxFiles();
    if (files.length === 0) {
      console.log("   (空)");
    } else {
      files.forEach((f) => console.log(`   - ${f}`));
    }

    // 调试模式
    console.log(`\n⚙️  调试模式: ${DEBUG_MODE ? "✅ 开启" : "❌ 关闭"}`);
    console.log("═".repeat(60) + "\n");
  }

  async cleanup(spinner?: Spinner): Promise<void> {
    logDebug("cleanup", "开始清理资源", {
      hasServerHandle: !!this.serverHandle,
      hasSandbox: !!this.sandbox,
      serverPid: this.serverHandle?.pid ?? null,
    });

    if (this.serverHandle) {
      spinner?.update("正在停止服务器...");
      try {
        await this.serverHandle.kill();
        logDebug("cleanup", "服务器进程已停止");
      } catch (error) {
        logDebug("cleanup", "停止服务器时出错（可忽略）", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.sandbox) {
      spinner?.update("正在清理沙箱资源...");
      try {
        await this.sandbox.kill();
        logDebug("cleanup", "沙箱已成功关闭");
      } catch (error) {
        logDebug("cleanup", "关闭沙箱时出错", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

// ============================================================================
// Interactive CLI
// ============================================================================

function printWelcome(): void {
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║       🚀 PPIO Sandbox × Claude 交互式开发助手                 ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  输入你的需求，AI 会自动生成代码并部署预览                     ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log("║  命令:                                                        ║");
  console.log("║    exit, quit     - 退出程序                                  ║");
  console.log("║    clear          - 清空对话历史                              ║");
  console.log("║    url            - 查看当前预览地址                          ║");
  console.log("║    key <api_key>  - 设置 API Key                              ║");
  console.log("║    debug          - 查看调试信息（沙箱/服务器/文件）           ║");
  console.log("║    debug on/off   - 开启/关闭详细日志                         ║");
  console.log("║    cat <file>     - 查看沙箱中的文件内容                       ║");
  console.log("║    restart        - 重启 HTTP 服务器                          ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
}

function normalizeApiKey(input: string): string {
  let key = input.trim();
  // 自动移除用户可能误输入的 "key " 前缀
  if (key.toLowerCase().startsWith("key ")) {
    key = key.slice(4).trim();
  }
  return key;
}

async function promptForApiKey(rl: readline.Interface): Promise<string> {
  console.log("⚠️  未检测到 API Key，请输入你的 PPIO API Key:");
  console.log("   (可从 https://ppio.com 获取)");
  console.log("");

  while (true) {
    const key = await prompt(rl, "🔑 API Key > ");
    const normalizedKey = normalizeApiKey(key);

    if (normalizedKey.toLowerCase() === "exit" || normalizedKey.toLowerCase() === "quit") {
      return "";
    }

    if (isValidApiKey(normalizedKey)) {
      return normalizedKey;
    }

    console.log("❌ 无效的 API Key，请重新输入 (至少 10 个字符)");
  }
}

async function runInteractiveMode(): Promise<void> {
  const agent = new SandboxAgent();
  const rl = createReadlineInterface();

  printWelcome();

  try {
    // 检查 API Key
    if (!agent.hasApiKey()) {
      const apiKey = await promptForApiKey(rl);
      if (!apiKey) {
        console.log("\n👋 再见！");
        rl.close();
        return;
      }
      agent.setApiKey(apiKey);
      console.log("");
    } else {
      console.log("✅ 已从环境变量加载 API Key");
      console.log("");
    }

    await agent.initialize();

    // 交互循环
    while (true) {
      const userInput = await prompt(rl, "📝 你的需求 > ");
      const trimmedInput = userInput.trim();

      // 处理特殊命令
      if (!trimmedInput) {
        continue;
      }

      // 退出命令
      if (trimmedInput.toLowerCase() === "exit" || trimmedInput.toLowerCase() === "quit") {
        console.log("\n👋 再见！");
        break;
      }

      // 清空历史命令
      if (trimmedInput.toLowerCase() === "clear") {
        agent.clearHistory();
        console.log("🗑️  对话历史已清空");
        continue;
      }

      // 查看 URL 命令
      if (trimmedInput.toLowerCase() === "url") {
        const url = agent.getPreviewUrl();
        if (url) {
          console.log(`🌐 当前预览地址: ${url}`);
        } else {
          console.log("⚠️  服务器尚未启动，请先创建网页");
        }
        continue;
      }

      // 设置 API Key 命令
      if (trimmedInput.toLowerCase().startsWith("key ")) {
        const newKey = trimmedInput.slice(4).trim();
        if (agent.setApiKey(newKey)) {
          console.log("🔄 API Key 已更新");
        } else {
          console.log("❌ 无效的 API Key");
        }
        continue;
      }

      // 调试命令
      if (trimmedInput.toLowerCase() === "debug") {
        await agent.showDebugInfo();
        continue;
      }

      // 开启/关闭详细日志
      if (trimmedInput.toLowerCase() === "debug on") {
        DEBUG_MODE = true;
        console.log("✅ 详细日志已开启");
        continue;
      }

      if (trimmedInput.toLowerCase() === "debug off") {
        DEBUG_MODE = false;
        console.log("✅ 详细日志已关闭");
        continue;
      }

      // 查看文件内容命令
      if (trimmedInput.toLowerCase().startsWith("cat ")) {
        const filePath = trimmedInput.slice(4).trim();
        if (!filePath) {
          console.log("⚠️  请指定文件路径，例如: cat index.html");
          continue;
        }
        const content = await agent.readSandboxFile(filePath);
        if (content) {
          console.log("\n" + "─".repeat(60));
          console.log(`📄 文件内容: ${filePath}`);
          console.log("─".repeat(60));
          // 限制输出长度，避免刷屏
          const maxLines = 100;
          const lines = content.split("\n");
          if (lines.length > maxLines) {
            console.log(lines.slice(0, maxLines).join("\n"));
            console.log(`\n... (省略了 ${lines.length - maxLines} 行，共 ${lines.length} 行)`);
          } else {
            console.log(content);
          }
          console.log("─".repeat(60) + "\n");
        }
        continue;
      }

      // 重启服务器命令
      if (trimmedInput.toLowerCase() === "restart") {
        if (!agent.getPreviewUrl()) {
          console.log("⚠️  服务器尚未启动，请先创建网页");
          continue;
        }
        console.log("🔄 正在重启服务器...");
        await agent.forceRestartServer();
        continue;
      }

      // 正常对话
      try {
        await agent.chat(trimmedInput);
      } catch (error) {
        if (error instanceof Error && error.message.includes("API Key")) {
          console.log("❌ API Key 无效或已过期，请使用 'key <your_api_key>' 设置新的 Key");
        } else {
          console.error("💥 处理请求时出错:", error);
        }
      }
    }
  } catch (error) {
    console.error("💥 运行出错:", error);
  } finally {
    rl.close();
    const spinner = new Spinner("正在退出，请稍候...");
    spinner.start();
    await agent.cleanup(spinner);
    spinner.stop("✅ 已退出，再见！");
    process.exit(0);
  }
}

// ============================================================================
// Main Entry
// ============================================================================

runInteractiveMode();
