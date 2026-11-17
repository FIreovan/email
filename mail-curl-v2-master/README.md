# Mail Curl - 臨時郵箱 Worker

一個使用 Cloudflare Workers + D1 實現的臨時郵箱服務，支持 Cloudflare Email Routing (catch-all)。

## 功能

- `GET /` - 返回 "made by yoyo qwq"
- `POST /api/remail?key=密鑰` - 刷新/創建新郵箱
- `GET /api/inbox?key=密鑰&mailbox_id=xxx` - 查看收件箱
- `GET /api/mail?key=密鑰&id=郵件ID` - 查看郵件內容
- `GET /api/ls?key=密鑰` - 查看所有郵箱

## ID 格式

- 郵箱ID: `xxxx-xx-xx-xxxx` (12位)
- 郵件ID: `xxxxxx-xxx-xxx-xxxxxx` (18位)
- 郵箱前綴: `yoyomail-{名詞}-{月日}-{3位隨機}` (如 yoyomail-cloud-0824-a1b)

## 多域名輪詢 & 泛域名支持

### 多域名輪詢
支援多域名時，系統會自動輪詢 (round-robin) 分配域名，實現均勻分布。

例如配置 `domain=domain1.com,domain2.com` 時：
- 第一個郵箱: xxx@domain1.com
- 第二個郵箱: xxx@domain2.com
- 第三個郵箱: xxx@domain1.com
- ...以此類推

### 泛域名支援
配置單一域名後，系統會自動接受該域名下的所有子域名的郵件。

例如配置 `domain=example.com` 時：
- `user@example.com` ✅ (精確匹配)
- `user@sub.example.com` ✅ (泛域名匹配)
- `user@mail.example.com` ✅ (泛域名匹配)
- `user@other.com` ❌ (拒絕)

This feature is useful when you want to receive emails from any subdomain of your configured domain.

## 部署

1. **創建 D1 數據庫**:
```bash
wrangler d1 create mail-curl-db
```

2. **創建數據表**:
```sql
CREATE TABLE IF NOT EXISTS mailboxes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  prefix TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS mails (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
);
```

3. **更新 wrangler.jsonc**:
```json
{
  "d1_databases": [{
    "binding": "DB",
    "database_name": "mail-curl-db",
    "database_id": "你的數據庫ID"
  }]
}
```

4. **設置環境變量**:
```bash
wrangler secret put JWT_KEY
# 輸入你的訪問密鑰
```

5. **部署**:
```bash
npm run deploy
```

## Email Routing 設置

1. 進入 Cloudflare Dashboard → 你的域名
2. 點擊 Email Routing → Rules
3. 創建 Catch-all 規則：
   - 當: `All emails`
   - 動作: `Send to Worker`
   - 選擇: `mail-curl`

## 使用示例

```bash
# 刷新郵箱 (隨機詞彙 + 隨機月日)
curl -X POST "https://your-worker.workers.dev/api/remail?key=YOUR_KEY"

# 刷新郵箱 (指定詞彙)
curl -X POST "https://your-worker.workers.dev/api/remail?key=YOUR_KEY&word=cloud"

# 刷新郵箱 (指定月日)
curl -X POST "https://your-worker.workers.dev/api/remail?key=YOUR_KEY&birthday=0824"

# 刷新郵箱 (指定詞彙 + 月日)
curl -X POST "https://your-worker.workers.dev/api/remail?key=YOUR_KEY&word=cloud&birthday=0824"

# 查看所有郵箱
curl "https://your-worker.workers.dev/api/ls?key=YOUR_KEY"

# 查看收件箱
curl "https://your-worker.workers.dev/api/inbox?key=YOUR_KEY&mailbox_id=xxxx-xx-xx-xxxx"

# 查看郵件
curl "https://your-worker.workers.dev/api/mail?key=YOUR_KEY&id=xxxxxx-xxx-xxx-xxxxxx"
```

## 環境變數

### 基礎配置

| 變數 | 說明 |
|------|------|
| `JWT_KEY` | 訪問密鑰 (必填) |
| `domain` | 郵箱域名 (必填，支援多域名或泛域名) |
| `MAIL_PREFIX` | 郵箱前綴 (可選，未設置時使用隨機人名) |

**domain 格式範例：**
```jsonc
// 單域名
"domain": "example.com"

// 多域名 (逗號分隔)
"domain": "example1.com,example2.com"

// 支援泛域名：配置 example.com 後，可接收所有 @*.example.com 的郵件
"domain": "example.com"
```

### Webhook 配置 (可選)

當 `WEBHOOK_URL` 和 `WEBHOOK_SECRET` 同時非空時，會啟用 **Webhook 收信模式**：
- 收到郵件後，直接轉發到你的後端 API
- **不走本地存儲/前端展示鏈路**
- 適合將郵件交給你的服務做驗證碼提取、自定義存儲等處理

| 變數 | 說明 |
|------|------|
| `WEBHOOK_URL` | Webhook 基礎地址 (如 `https://your-api.com`) |
| `WEBHOOK_SECRET` | Webhook 鑑權密鑰 (會放在請求頭 `X-Webhook-Secret` 中) |
| `WEBHOOK_TIMEOUT_MS` | 請求超時（毫秒），預設 `10000`，最大 `30000` |

**Webhook 請求格式：**
```http
POST /api/webhook/email
Content-Type: application/json
X-Webhook-Secret: your-secret
```

```json
{
  "message_id": "<message-id@example.com>",
  "to_addr": "target@example.com",
  "from_addr": "sender@example.com",
  "raw_content": "完整 RFC822 原始郵件內容",
  "timestamp": 1234567890
}
```

**调试日志：**
启用 Webhook 后，Worker 日志会打印：
- 收到邮件事件
- 准备发送 webhook
- 实际请求 URL
- 响应状态码
- 成功/失败返回内容

### Webhook 使用方法

1. **設置環境變量**：
```bash
wrangler secret put WEBHOOK_URL
wrangler secret put WEBHOOK_SECRET
# 可選：wrangler secret put WEBHOOK_TIMEOUT_MS
```

2. **檢查 Webhook 狀態**：
```bash
curl "https://your-worker.workers.dev/api/webhook/status?key=YOUR_KEY"
```

3. **Webhook 請求格式**：

收到郵件時，系統會發送 POST 請求到您的 Webhook URL：

```json
{
  "message_id": "<message-id@example.com>",
  "to_addr": "target@example.com",
  "from_addr": "sender@example.com",
  "timestamp": 1234567890
}
```

**完整郵件內容模式**（啟用後）：

```json
{
  "message_id": "<message-id@example.com>",
  "to_addr": "target@example.com",
  "from_addr": "sender@example.com",
  "raw_content": "完整 RFC822 原始郵件內容",
  "timestamp": 1234567890
}
```

4. **郵箱創建事件**：

當創建新郵箱時，也會發送郵箱創建事件：

```json
{
  "event_type": "mailbox_creation",
  "email": "user@domain.com",
  "prefix": "yoyomail-cloud-0824-a1b",
  "mailbox_id": "xxxx-xx-xx-xxxx",
  "timestamp": 1234567890
}
```

5. **郵件存儲事件**：

郵件存儲到數據庫後發送：

```json
{
  "event_type": "mail_storage",
  "mail_id": "xxxxxx-xxx-xxx-xxxxxx",
  "mailbox_id": "xxxx-xx-xx-xxxx",
  "sender_name": "sender@example.com",
  "subject": "郵件主題",
  "text_content": "郵件文本內容",
  "timestamp": 1234567890
}
```

### 使用範例

```bash
# 啟用 Webhook 後，所有收到的郵件都會自動轉發到您的 API
# 可以在您的後端 API 處理郵件內容、提取驗證碼等

# 設置 Webhook 後，Worker 日誌會顯示轉發狀態
```
