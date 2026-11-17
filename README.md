# Mail Curl — Cloudflare 臨時信箱（登入制）

Cloudflare Workers + D1 + Email Routing 的臨時信箱：

- **前台只有登入頁**（帳號＋密碼＋確認），不開放註冊
- **帳號、收信地址都只能由管理員在後台建立**
- 登入帳號可以是純帳號名稱（例如 `admin`、`alice`），也可以是完整電郵
- 管理員把地址分配給使用者，使用者登入後只看得到自己的收件匣
- 驗證碼自動抓取，一鍵複製
- 不需要 VPS、不需要 SMTP 伺服器，其他都在 Cloudflare 免費方案內

---

## 🌐 網域規劃（xzerox.xyz 已經有 VPS 網站）

`xzerox.xyz` 的根網域（A 記錄）指向你的 VPS 網站，**這個不會被動到**。這個專案用兩個不同的東西：

| 用途 | 位置 | 需要的 DNS | 會不會影響 VPS 網站 |
|---|---|---|---|
| 網站介面（登入 / 收件匣 / 後台） | `mail.xzerox.xyz` | 由 Cloudflare Worker「Custom domain」自動建立的 CNAME | ❌ 不會（不同子網域） |
| 收信地址 | `xxx@xzerox.xyz` | 根網域的 **MX** 記錄（Email Routing） | ❌ 不會（MX 與 A 記錄無關） |

也就是說：

- 你原本的 `xzerox.xyz` 網站照常運作。
- 這個臨時信箱網站在 `mail.xzerox.xyz`。
- 收到的信是 `隨便你@xzerox.xyz`（不是 `@mail.xzerox.xyz`）。

> ⚠️ **唯一要注意的**：如果你的 `xzerox.xyz` 現在**已經在用 Email Routing 以外的收信服務**
> （例如 Google Workspace、主機商的信箱、cPanel 郵件），
> 啟用 Cloudflare Email Routing 會**要求把 MX 記錄換成 Cloudflare 的**，
> 原本 `someone@xzerox.xyz` 的信就會改送到 Worker。
> 如果只是「VPS 上跑網站、沒有在用這個網域的電郵」，那就完全沒問題。

---

## ⚠️ 為什麼你的 GitHub 建置一直失敗

```
✘ [ERROR] Could not detect a directory containing static files (e.g. html, css and js) for the project
```

不是程式碼的問題，是 **GitHub repo 的目錄層級放錯**：

```
Fireovan/email            ← Cloudflare 從這裡開始找
└── mail-curl-v2-master   ← 但 wrangler.jsonc / package.json 在這裡
    ├── wrangler.jsonc
    ├── package.json
    └── src/
```

Workers Builds 的 Root directory 是 `/`，在根目錄找不到 `wrangler.jsonc` 和 `package.json`，
wrangler 就進入「自動偵測靜態網站」模式，找不到 html/css/js 便丟出上面那個錯誤。

**解法（二選一）**

| 方法 | 做法 | 建議 |
|---|---|---|
| A. 改 Root directory | Workers & Pages → `email` → Settings → Build → Root directory 填 `mail-curl-v2-master` | 最快 |
| B. 把檔案搬到 repo 根目錄 | `wrangler.jsonc`、`package.json`、`src/`、`public/`、`schema.sql` 直接放 repo 最上層 | ✅ 建議 |

---

## 部署步驟（照順序做）

### 1. 修正 Root directory

照上面 A 或 B 處理，讓 `wrangler.jsonc` 位於建置根目錄。

### 2. 建立 D1 資料庫

```bash
npx wrangler login
npx wrangler d1 create mail-curl-db
```

把印出的 `database_id` 貼進 `wrangler.jsonc`：

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "mail-curl-db",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
]
```

> 沒換掉 `REPLACE_WITH_YOUR_D1_DATABASE_ID` 的話，部署一定會失敗。

### 3. 建立資料表

```bash
npx wrangler d1 execute mail-curl-db --remote --file schema.sql
```

### 4. 設定域名、管理員與密碼

`wrangler.jsonc`（本專案已填好 `xzerox.xyz` 與管理員帳號 `admin`）：

```jsonc
"vars": {
  "domain": "xzerox.xyz",
  "ADMIN_EMAIL": "admin",
  "MAIL_PREFIX": "",
  "ALLOW_UNKNOWN_ADDRESSES": "false"
}
```

`ADMIN_EMAIL` 只是「登入帳號」，不需要是真的電郵；想改成 `boss`、`owner` 都可以。

密碼用 secret（不要寫進公開 repo）：

```bash
npx wrangler secret put ADMIN_PASSWORD
```

> 第一次用 `admin` + 你設定的 `ADMIN_PASSWORD` 登入時，系統會自動在資料庫建立管理員帳號。
> 建立後建議把 `ADMIN_PASSWORD` 換成別的密碼（secret 改掉不會影響已建立的帳號）。

### 5. 部署

```bash
npm run deploy
```

或 push 到 GitHub 讓 Workers Builds 自動部署。

### 6. 加上網站地址 `mail.xzerox.xyz`（不影響 VPS）

Worker 預設就有 `https://email.<你的子網域>.workers.dev`，可以直接用。

想改用 `mail.xzerox.xyz`：

1. Cloudflare Dashboard → **Workers & Pages** → `email` → **Settings** → **Domains & Routes**
2. **Add** → **Custom domain** → 輸入 `mail.xzerox.xyz` → **Add domain**
3. Cloudflare 會自動在 `xzerox.xyz` 區域建立一筆 `mail` 的 CNAME（Proxied）
4. 等狀態變成 **Active**（通常 1～2 分鐘）

根網域 `xzerox.xyz` 的 A 記錄不用改，VPS 網站照常。

> 前提：`xzerox.xyz` 的 DNS 必須托管在 Cloudflare（Nameservers 指向 Cloudflare）。
> 如果是在別家（例如主機商的 DNS），要先把網域移轉到 Cloudflare 才能用 Workers + Email Routing。

### 7. 開啟 Email Routing

Cloudflare Dashboard → `xzerox.xyz` → **Email Routing**：

1. 啟用 Email Routing（自動加 MX / SPF）
2. **Catch-all** → 動作選 **Send to a Worker** → 選 `email`
3. 存檔後等 MX 生效（通常幾分鐘）

`domain` 設 `xzerox.xyz` 時，`xxx@xzerox.xyz` 都會進到 Worker。

### 8. 第一次使用

1. 開 `https://mail.xzerox.xyz`（或 `https://email.<你的子網域>.workers.dev`）
2. 帳號填 `admin`、密碼填你剛剛 `wrangler secret put ADMIN_PASSWORD` 設的值 → 登入
3. 會自動進到 **管理後台**
4. 「建立使用者」→ 填使用者的登入帳號（例如 `alice`）與初始密碼
5. 「產生收信地址」→ 選 `@xzerox.xyz`、選要分配給誰 → 產生
6. 使用者到首頁用 `alice` + 密碼登入 → 只會看到被分配的收件匣

---

## 收信規則

| 情況 | 結果 |
|---|---|
| 寄到後台產生過的地址 | ✅ 存進 D1，擁有者看得到 |
| 寄到沒產生過的地址 | ❌ 直接丟棄（避免垃圾信灌爆 D1） |
| `ALLOW_UNKNOWN_ADDRESSES=true` | ⚠️ 任何 `*@你的網域` 都收，會自動建立「未分配」地址 |

管理員可以在後台把「未分配」的地址分配給任何使用者。

---

## API

全部回傳 JSON，使用 Cookie（`mc_session`）驗證。

| 方法 | 路徑 | 權限 | 說明 |
|---|---|---|---|
| POST | `/api/login` | 公開 | `{ email, password }`（`email` 欄位放登入帳號），成功後設定 Cookie |
| POST | `/api/logout` | 公開 | 清除登入狀態 |
| GET | `/api/me` | 登入 | 目前使用者 + 自己的地址列表 |
| GET | `/api/inbox?mailbox_id=…` | 登入 | 收件匣（只能看自己的；管理員可看全部） |
| GET | `/api/mail?id=…` | 登入 | 單封郵件（含自動抓出的 `code`） |
| GET | `/api/admin/overview` | 管理員 | 所有使用者與地址 |
| POST | `/api/admin/users` | 管理員 | `{ email, password }` 建立帳號（`email` 可是純帳號名稱或電郵） |
| PATCH | `/api/admin/users` | 管理員 | `{ id, password }` 重設密碼 |
| DELETE | `/api/admin/users?id=…` | 管理員 | 刪除帳號（地址變成未分配） |
| POST | `/api/admin/mailboxes` | 管理員 | `{ prefix?, domain?, user_id? }` 產生地址 |
| PATCH | `/api/admin/mailboxes` | 管理員 | `{ id, user_id }` 分配地址 |
| DELETE | `/api/admin/mailboxes?id=…` | 管理員 | 刪除地址與其信件 |
| GET | `/api/webhook/status` | 管理員 | Webhook 設定狀態 |

用 `curl` 時也可以帶管理員 API Key（設定 `JWT_KEY` 後）：

```bash
curl -X POST "https://你的worker.workers.dev/api/admin/mailboxes?key=YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{"prefix":"alex","domain":"example.com"}'
```

---

## 專案結構

```
wrangler.jsonc      Worker 設定（D1、vars、static assets）
schema.sql          D1 資料表（users / sessions / mailboxes / mails）
src/index.ts        API 路由 + 收信 + 驗證碼擷取
src/auth.ts         密碼雜湊（PBKDF2）、Session、管理員初始化
src/webhook.ts      可選的 Webhook 轉發
src/domain-utils.ts 多域名 / 泛域名比對
public/index.html   登入頁（前台唯一入口）
public/inbox.html   使用者收件匣
public/admin.html   管理後台
public/common.js    共用工具
public/inbox.js     收件匣邏輯
public/admin.js     後台邏輯
```

## 常用指令

```bash
npm run dev       # 本機開發（http://localhost:8787）
npm run deploy    # 部署
npm test          # 單元測試
npm run typecheck # TypeScript 檢查
npm run db:init   # 套用 schema.sql 到遠端 D1
```

## 安全性說明

- 密碼用 PBKDF2-SHA256（6000 次迭代）。Workers 免費方案每次請求只有 10ms CPU，
  迭代次數刻意調低；如果你升級到 Paid（$5/月），建議把 `src/auth.ts` 的
  `PBKDF2_ITERATIONS` 調高到 100000 以上。
- Session token 只把 SHA-256 存在 D1，Cookie 是 `HttpOnly; Secure; SameSite=Lax`。
- 改密碼或刪除使用者會讓該使用者的舊 session 立刻失效。
- 目前沒有登入失敗次數限制；若要公開營運，建議在 Cloudflare 加 Rate Limiting 規則
  或 Turnstile。

## 注意事項

- **只能收信，不能寄信。** Cloudflare 沒有免費的 outbound SMTP。
- 只保留每個信箱最近 100 封（`/api/inbox` 的 `LIMIT 100`），沒有自動清除機制。
- 很多服務會封鎖 disposable email 網域，這是產品本身的限制。
- 臨時信箱不適合註冊銀行、政府或任何重要帳號；也請勿用來大量註冊或繞過平台驗證。
