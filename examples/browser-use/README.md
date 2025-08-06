# 浏览器使用代理

基于 [Browser-use](https://github.com/browser-use/browser-use) 的 AI 代理，可以执行网页自动化任务。

## 前置要求

- Python 3.12+
- PPIO 账户和 [API 密钥](https://ppio.com/settings/key-management?utm_source=github&utm_medium=readme&utm_campaign=ppio-collab)

## 安装和设置指南

### 1. 创建 Python 虚拟环境

确保您已安装 Python 3.12+，然后创建虚拟环境：

```bash
# 创建虚拟环境
python -m venv .venv

# 激活虚拟环境
# macOS/Linux:
source .venv/bin/activate

# Windows:
# .venv\Scripts\activate
```

### 2. 安装依赖

确保虚拟环境已激活，然后安装所需的依赖：

```bash
pip install -r requirements.txt
```

### 3. 环境配置

复制示例环境文件并重命名：

```bash
cp .env.example .env
```

然后在 `.env` 文件中修改以下变量：

- `E2B_API_KEY`: 您的 PPIO AI API 密钥
- `LLM_API_KEY`: 您的 PPIO AI API 密钥  
- `LLM_MODEL`: 您想要使用的模型 ID（例如，`deepseek/deepseek-v3-0324`）

### 4. 运行程序

配置完成后，运行主程序：

```bash
python agent.py
```

## 程序功能

程序将：

1. 使用 `browser-chromium` 模板创建 E2B 沙箱
2. 连接到浏览器并使用 Browser-use 执行自动化任务
3. 默认任务：访问 Google 并搜索 "browser-use" 信息，然后总结结果
4. 在执行过程中自动截图并保存到 `./screenshots/` 目录

## 输出文件

- **截图文件**: 保存在 `./screenshots/{session_id}/` 目录中，文件名格式为 `{domain}_{timestamp}.png`
- **日志输出**: 详细的执行日志显示在控制台中

## 故障排除

1. **依赖安装失败**: 确保您使用的是 Python 3.12 和最新的 pip 版本
2. **环境变量错误**: 检查 `.env` 文件是否正确配置了所有必需的环境变量
3. **E2B 连接问题**: 验证 E2B API 密钥和域配置是否正确
4. **LLM API 错误**: 确认 LLM API 密钥有效且有足够的配额

## 自定义模板

此项目使用 PPIO 的默认 `browser-chromium` 模板。如果您需要使用额外的依赖或特定配置来自定义浏览器环境，可以基于它构建自己的模板。

### 构建自定义模板

导航到 [e2b-template](./e2b-template) 文件夹并按照以下步骤操作：

1. **修改依赖**: 编辑 `e2b.Dockerfile` 以添加您需要的任何额外包
2. **配置启动**: 修改 `start-up.sh` 以包含自定义启动脚本
3. **构建模板**: 运行构建脚本来创建您的自定义模板：
   ```bash
   ./build.sh
   ```

构建完成后，更新您的 `agent.py` 代码以使用新的模板 ID 而不是 `browser-chromium`。您可以在 [e2b-template](./e2b-template) 中新生成的 `e2b.toml` 文件中找到新的模板 ID。

```python
sandbox = Sandbox(
  timeout=600,  # seconds
  template="新的模板ID",
)
```
