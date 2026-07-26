# PreciousMemory

PreciousMemory 是一个私人使用的双人聊天记录 Web 应用。它不是实时聊天软件：电脑端用于手动记录、修改和删除消息，手机端只展示历史记录。

## 第一版功能

- 固定两个角色：用户 A「我」、用户 B「对方」
- 电脑宽屏显示消息编辑面板
- 手机端自动切换为只读界面
- 用户 A 气泡靠右，用户 B 气泡靠左
- 支持 Markdown、代码块、表格和长文本
- 自动加载最新消息，上滑加载更早记录
- 聊天记录写入服务器的 `data/messages.json`
- 不使用数据库、账号系统、Docker 或 Kubernetes
- 提供新增、查询、修改、删除消息的 REST API，便于后期扩展

> 手机端“只读”是前端界面限制，不是权限控制。当前版本没有登录系统，因此能访问服务器端口的人仍可直接调用写入接口。建议暂时仅在可信网络中使用，后续再增加登录和鉴权。

## 技术结构

```text
浏览器 → Nginx :16023 → Node.js :3023 → data/messages.json
```

- Node.js 20+
- Express
- markdown-it
- sanitize-html
- Nginx
- systemd

## 目录说明

```text
PreciousMemory/
├── backend/
│   ├── app.js
│   ├── message-store.js
│   └── server.js
├── data/
│   └── messages.json       # 第一次启动时自动创建，不提交到 Git
├── deploy/
│   ├── nginx/
│   │   └── preciousmemory.conf
│   └── systemd/
│       └── preciousmemory.service
├── public/
│   ├── app.js
│   ├── index.html
│   └── styles.css
├── test/
│   └── api.test.js
├── package.json
└── README.md
```

## 本地运行

```bash
npm install
npm test
npm start
```

默认只监听：

```text
http://127.0.0.1:3023
```

可以使用环境变量修改：

```bash
HOST=127.0.0.1 PORT=3023 npm start
```

## Ubuntu 服务器完整部署

以下命令全部使用 `root` 用户执行，不需要 `sudo`。

### 1. 创建项目目录并下载代码

首次部署：

```bash
mkdir -p /opt
git clone https://github.com/LIKE9426334946/PreciousMemory.git /opt/PreciousMemory
cd /opt/PreciousMemory
npm ci --omit=dev
```

如果已经克隆过仓库：

```bash
cd /opt/PreciousMemory
git pull origin main
npm ci --omit=dev
```

`npm ci --omit=dev` 会严格按照 `package-lock.json` 安装生产依赖。聊天数据文件不会被 Git 跟踪，因此以后 `git pull` 不会覆盖已有聊天记录。

### 2. 创建并安装 systemd 服务

项目已经提供完整配置：

```text
/opt/PreciousMemory/deploy/systemd/preciousmemory.service
```

复制配置并启用：

```bash
cp /opt/PreciousMemory/deploy/systemd/preciousmemory.service /etc/systemd/system/preciousmemory.service
systemctl daemon-reload
systemctl enable --now preciousmemory
systemctl status preciousmemory
```

systemd 的核心配置为：

```ini
User=root
WorkingDirectory=/opt/PreciousMemory
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3023
ExecStart=/usr/bin/node /opt/PreciousMemory/backend/server.js
Restart=always
```

查看运行日志：

```bash
journalctl -u preciousmemory -f
```

### 3. 创建并启用 Nginx 配置

项目已经提供完整配置：

```text
/opt/PreciousMemory/deploy/nginx/preciousmemory.conf
```

复制并启用：

```bash
cp /opt/PreciousMemory/deploy/nginx/preciousmemory.conf /etc/nginx/sites-available/preciousmemory.conf
ln -s /etc/nginx/sites-available/preciousmemory.conf /etc/nginx/sites-enabled/preciousmemory.conf
nginx -t
systemctl reload nginx
```

如果启用链接已经存在，不要重复创建，直接执行：

```bash
nginx -t
systemctl reload nginx
```

Nginx 对外监听 `16023`，并转发到仅监听本机的 Node.js `3023` 端口。配置中已经保留 WebSocket 升级请求头，方便后期扩展。

### 4. 检查服务

检查 Node.js 内部接口：

```bash
curl http://127.0.0.1:3023/api/health
```

检查 Nginx 外部端口：

```bash
curl http://127.0.0.1:16023/api/health
```

浏览器访问：

```text
http://服务器公网IP:16023
```

电脑宽屏会显示聊天记录管理面板；手机窄屏只显示聊天内容，并每 5 秒自动读取最新记录。

## 更新项目

```bash
cd /opt/PreciousMemory
git pull origin main
npm ci --omit=dev
systemctl restart preciousmemory
nginx -t
systemctl reload nginx
```

只有在依赖发生变化时才必须重新执行 `npm ci --omit=dev`，但每次更新都执行也不会有问题。聊天记录位于 `/opt/PreciousMemory/data/messages.json`，不会被代码更新覆盖。

## 数据备份

停止服务后复制 JSON 文件即可：

```bash
systemctl stop preciousmemory
cp /opt/PreciousMemory/data/messages.json /opt/PreciousMemory/data/messages.backup.json
systemctl start preciousmemory
```

恢复时请先停止服务，再用备份文件替换 `messages.json`。

## API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/config` | 获取固定用户和前端配置 |
| `GET` | `/api/messages?limit=60` | 获取最新历史记录 |
| `GET` | `/api/messages?before=序号` | 向前分页 |
| `GET` | `/api/messages?after=序号` | 查询新增消息 |
| `POST` | `/api/messages` | 新增消息 |
| `PUT` | `/api/messages/:id` | 修改消息内容 |
| `DELETE` | `/api/messages/:id` | 删除消息 |

新增消息示例：

```bash
curl -X POST http://127.0.0.1:3023/api/messages \
  -H "Content-Type: application/json" \
  -d '{"sender":"A","content":"今天学习了 **Transformer** 架构"}'
```

