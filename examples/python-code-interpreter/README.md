# Python Code Interpreter

本示例演示了如何使用 [PPIO LLM API](https://ppio.com/docs/model/overview) 和 [PPIO Agent Sandbox](https://ppio.com/docs/sandbox/overview) 产品实现一个简单的 Python Code Interpreter，其能将自然语言描述转换为可执行的 Python 代码，并在安全的沙箱环境中运行。

**注意：本示例只用于参考，在实际项目中请根据自身需求完善安全限制、异常处理和权限校验等重要环节，避免潜在风险。**

## ✨ 功能特性

- 🤖 **AI 代码生成**：使用 PPIO LLM API（DeepSeek V3.2）将自然语言转换为 Python 代码
- 🔒 **安全执行**：使用 PPIO Agent Sandbox 在隔离环境中运行代码
- 🐛 **自动调试**：代码执行出错时，自动分析错误并尝试修复
- 💭 **思考过程可见**：实时展示 AI 的推理过程
- ⚡ **流式输出**：流式返回生成内容，提供流畅的用户体验

## 🚀 快速开始

### 环境要求

- Python 3.8+
- 已注册 PPIO 账号并创建了 API Key，参考：https://ppio.com/docs/support/quickstart

### 安装依赖

```bash
pip install -r requirements.txt
```

**依赖包：**
- `ppio-sandbox>=1.0.4` - PPIO 沙箱执行环境
- `openai>=2.3.0` - OpenAI API 客户端

### 配置环境变量

```bash
export PPIO_API_KEY="your-ppio-api-key"
```

### 运行示例

```bash
python main.py
```

### 通过代码调用

```python
from python_code_interpreter import PythonCodeInterpreter
import asyncio

interpreter = PythonCodeInterpreter()
result = await interpreter.run(" Calculate the factorial of 10")

print(result)
```

## 🔧 实现逻辑详解

### 1. 使用 PPIO LLM API 生成 Python 代码

PPIO LLM API 是 OpenAI API 兼容的，您可以直接使用 OpenAI SDK：

```python
import os
from openai import AsyncOpenAI

LLM_MODEL = "deepseek/deepseek-v3.2-exp"

client = AsyncOpenAI(
    api_key=os.getenv("PPIO_API_KEY"),
    base_url="https://api.ppinfra.com/openai"
)

response = await client.chat.completions.create(
    model=LLM_MODEL,
    messages=messages,
    # ...
)
```

### 2. 使用 PPIO Agent Sandbox 执行代码

使用 `ppio-sandbox` Python SDK 在安全的沙箱环境中执行代码：

```python
from ppio_sandbox.code_interpreter import Sandbox

# 创建沙箱实例
sandbox = Sandbox.create(timeout=5 * 60)

# 执行 Python 代码
result = sandbox.run_code(code)

print(result)

# 清理资源
sandbox.kill()
```
