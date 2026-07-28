# PreciousMemory

PreciousMemory 是一个部署在私人 Ubuntu 服务器上的实时 AI 聊天应用。系统中只有“我”和“AI”两个角色，可以新建、命名、重命名、删除多个对话。

每个对话都是独立上下文：发送消息时，后端只读取当前对话的 SQLite 历史并调用 OpenAI 兼容的 Chat Completions 接口，不会把其他对话的内容发送给模型。

## 当前功能

- 新建多个独立 AI 对话
- 命名、重命名和删除对话
- 电脑端与手机端都可以聊天
- AI 回复实时流式显示
- 支持停止生成；已收到的部分会保存
- 使用 SQLite 保存全部消息
- 支持搜索对话名称和消息正文
- 点击搜索结果定位具体消息
- 支持 Markdown、代码块、表格和长文本
- 不存储、不显示消息时间或对话时间
- API Key 只保存在服务器，不会发送到浏览器
- 可连接 OpenAI，也可连接采用相同 `/v1/chat/completions` 格式的服务
- AI 系统提示词保存在独立文本文件中，修改提示词不需要改代码

## 调用流程

```text
浏览器
  ↓ POST /api/conversations/:id/chat
Nginx :16023
  ↓ SSE 实时转发
Node.js :3023
  ├─ 读取当前对话的 SQLite 历史
  ├─ 调用 OpenAI 兼容 /v1/chat/completions
  └─ 保存“我”和“AI”的消息
```

对话之间不会共用历史：

```text
对话 A → 只发送 A 的消息历史 → AI
对话 B → 只发送 B 的消息历史 → AI
```

为了避免对话过长导致请求超出模型上下文或费用不断增加，默认最多向 AI 发送当前对话最近 `200` 条、合计约 `120000` 个字符。SQLite 中的更早消息不会删除，仍然可以查看和搜索。

## 技术结构

- Node.js 20+
- Express 5
- SQLite + WAL
- SQLite FTS5 trigram 中文搜索
- OpenAI 兼容 Chat Completions
- SSE 流式输出
- markdown-it
- sanitize-html
- Nginx
- systemd

## 目录

```text
PreciousMemory/
├── backend/
│   ├── app.js
│   ├── conversation-store.js
│   ├── openai-client.js
│   └── server.js
├── config/
│   └── system-prompt.txt
├── data/
│   └── precious-memory.sqlite
├── deploy/
│   ├── nginx/preciousmemory.conf
│   └── systemd/preciousmemory.service
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── test/api.test.js
├── .env.example
├── package.json
└── README.md
```

正式数据库和 `.env` 都已加入 `.gitignore`，不会提交到 GitHub。

## AI 接口配置

应用使用 OpenAI Chat Completions 格式：

```http
POST /v1/chat/completions
Authorization: Bearer OPENAI_API_KEY
Content-Type: application/json
```

核心请求体：

```json
{
  "model": "gpt-5.6",
  "messages": [
    {
      "role": "system",
      "content": "config/system-prompt.txt 中的提示词"
    },
    {
      "role": "user",
      "content": "你好"
    }
  ],
  "stream": true
}
```

复制配置模板：

```bash
cd /opt/PreciousMemory
cp .env.example .env
chmod 600 .env
nano .env
```

OpenAI 官方接口示例：

```ini
OPENAI_API_KEY=你的真实APIKey
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.6

AI_SYSTEM_PROMPT_FILE=/opt/PreciousMemory/config/system-prompt.txt
AI_MAX_CONTEXT_MESSAGES=200
AI_MAX_CONTEXT_CHARACTERS=120000
OPENAI_TIMEOUT_MS=180000
```

如果使用其他 OpenAI 兼容服务，修改下面三个值即可：

```ini
OPENAI_API_KEY=兼容服务的Key
OPENAI_BASE_URL=https://兼容服务地址/v1
OPENAI_MODEL=兼容服务提供的模型名称
```

`OPENAI_BASE_URL` 可以填写 `/v1` 基础地址，也可以直接填写完整的 `/chat/completions` 地址，程序会自动识别。

API Key 不能写入 `public/app.js`、HTML、systemd 配置文件或任何将提交到 GitHub 的文件。

## 修改 AI 提示词

直接编辑：

```bash
nano /opt/PreciousMemory/config/system-prompt.txt
systemctl restart preciousmemory
```

每次 Node.js 服务启动时会重新读取该文件。所有对话使用同一份系统提示词，但消息历史仍按对话完全隔离。

## Ubuntu 服务器部署

以下命令全部使用 `root` 用户执行，不需要 `sudo`。

### 1. 下载项目并安装依赖

首次部署：

```bash
mkdir -p /opt
git clone https://github.com/LIKE9426334946/PreciousMemory.git /opt/PreciousMemory
cd /opt/PreciousMemory
git checkout main
npm ci --omit=dev
```

已有项目更新：

```bash
cd /opt/PreciousMemory
git pull origin main
npm ci --omit=dev
```

### 2. 配置 AI 接口

```bash
cd /opt/PreciousMemory
cp -n .env.example .env
chmod 600 .env
nano .env
```

把 `OPENAI_API_KEY` 改成真实 Key，并检查 `OPENAI_BASE_URL` 与 `OPENAI_MODEL`。

不要使用下面这种命令直接显示真实 Key：

```text
cat .env
```

因为它可能将 Key 留在终端录屏、日志或聊天截图中。

### 3. 安装 systemd 服务

```bash
cp /opt/PreciousMemory/deploy/systemd/preciousmemory.service \
  /etc/systemd/system/preciousmemory.service

systemctl daemon-reload
systemctl enable --now preciousmemory
systemctl status preciousmemory
```

systemd 会读取：

```text
/opt/PreciousMemory/.env
```

服务仍然使用：

```ini
User=root
WorkingDirectory=/opt/PreciousMemory
Environment=HOST=127.0.0.1
Environment=PORT=3023
Environment=DATABASE_FILE=/opt/PreciousMemory/data/precious-memory.sqlite
EnvironmentFile=-/opt/PreciousMemory/.env
```

查看日志：

```bash
journalctl -u preciousmemory -f
```

### 4. 更新 Nginx 配置

这一版必须更新 Nginx 配置，因为实时回复需要关闭代理缓冲并延长读取超时：

```bash
cp /opt/PreciousMemory/deploy/nginx/preciousmemory.conf \
  /etc/nginx/sites-available/preciousmemory.conf

ln -s /etc/nginx/sites-available/preciousmemory.conf \
  /etc/nginx/sites-enabled/preciousmemory.conf

nginx -t
systemctl reload nginx
```

如果启用链接已经存在，`ln -s` 报 `File exists` 时可忽略，然后继续执行：

```bash
nginx -t
systemctl reload nginx
```

端口保持不变：

```text
公网 16023 → Nginx → 127.0.0.1:3023
```

### 5. 重启并检查

```bash
systemctl restart preciousmemory
systemctl status preciousmemory

curl http://127.0.0.1:3023/api/health
curl http://127.0.0.1:16023/api/config
```

`/api/config` 返回下面的状态时，说明 Key 和模型配置已被服务读取：

```json
{
  "ai": {
    "configured": true,
    "model": "gpt-5.6"
  }
}
```

该接口不会返回 API Key。

浏览器访问：

```text
http://服务器公网IP:16023
```

## 后续更新命令

```bash
cd /opt/PreciousMemory
git pull origin main
npm ci --omit=dev

cp deploy/systemd/preciousmemory.service \
  /etc/systemd/system/preciousmemory.service
cp deploy/nginx/preciousmemory.conf \
  /etc/nginx/sites-available/preciousmemory.conf

systemctl daemon-reload
systemctl restart preciousmemory
nginx -t
systemctl reload nginx
```

## 数据备份

停止服务后复制 SQLite 文件：

```bash
systemctl stop preciousmemory
cp /opt/PreciousMemory/data/precious-memory.sqlite \
  /opt/PreciousMemory/data/precious-memory.backup.sqlite
systemctl start preciousmemory
```

恢复时也先停止服务，再替换正式数据库。

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/config` | 获取前端配置和 AI 配置状态，不包含 Key |
| `GET` | `/api/stats` | 获取对话、消息和字符总数 |
| `GET` | `/api/search?q=关键词` | 查找对话名称和消息正文 |
| `GET` | `/api/conversations` | 获取全部对话 |
| `POST` | `/api/conversations` | 新建独立对话 |
| `PUT` | `/api/conversations/:conversationId` | 重命名对话 |
| `DELETE` | `/api/conversations/:conversationId` | 删除对话及其消息 |
| `GET` | `/api/conversations/:conversationId/messages` | 获取该对话消息 |
| `POST` | `/api/conversations/:conversationId/chat` | 发送用户消息并流式返回 AI 回复 |

新建对话：

```bash
curl -X POST http://127.0.0.1:3023/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"name":"新的对话"}'
```

聊天接口使用 SSE 响应：

```bash
curl -N -X POST \
  http://127.0.0.1:3023/api/conversations/对话ID/chat \
  -H "Content-Type: application/json" \
  -d '{"content":"你好，请介绍一下你自己"}'
```

事件类型：

- `user`：用户消息已经保存
- `delta`：AI 新生成的一段文字
- `done`：AI 完整消息已经保存
- `stopped`：生成被中止
- `error`：上游 AI 接口返回错误

## 重要安全说明

当前版本仍然没有登录功能。虽然 API Key 不会暴露给浏览器，但任何能访问公网 `16023` 端口的人都可以通过你的服务器调用 AI 接口并产生费用。

正式长期使用前，应至少通过防火墙限制访问来源，或在下一版加入登录和鉴权。不要把这个端口直接分享给其他人。

## 验证

```bash
npm run check
npm test
```

自动化测试覆盖：

- OpenAI Chat Completions 请求格式
- SSE 流式片段解析
- AI 回复实时转发与 SQLite 保存
- 不同对话的上下文隔离
- API 未配置时拒绝聊天
- 多对话增删改
- Markdown 安全过滤
- 中文搜索
- 消息分页
- 不保存时间字段
