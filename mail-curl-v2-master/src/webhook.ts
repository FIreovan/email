/**
 * Webhook 收信模式核心功能
 * 支持將收到的郵件直接轉發到自定義後端 API
 * 
 * 環境變量要求:
 *   - WEBHOOK_URL: Webhook 基礎地址
 *   - WEBHOOK_SECRET: 鑑權密鑰 (會放在請求頭 X-Webhook-Secret)
 *   - WEBHOOK_TIMEOUT_MS: 請求超時（毫秒），默認 10000
 */

import type { EmailMessage } from "@cloudflare/workers-types";

// Webhook 環境變量接口
export interface WebhookEnv {
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  WEBHOOK_TIMEOUT_MS?: string;
}

// Webhook 配置檢查
export function isWebhookEnabled(env: WebhookEnv | any): boolean {
  const url = String(env?.WEBHOOK_URL || '').trim();
  const secret = String(env?.WEBHOOK_SECRET || '').trim();
  
  return !!url && !!secret;
}

// Webhook URL 解析和補全
export function resolveWebhookUrl(input: string): string {
  const raw = String(input || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!url.pathname || url.pathname === '/') {
      url.pathname = '/api/webhook/email';
    }
    return url.toString();
  } catch (_) {
    return raw;
  }
}

// Webhook 超時配置解析
export function getWebhookTimeoutMs(env: WebhookEnv | any): number {
  const timeoutStr = String(env?.WEBHOOK_TIMEOUT_MS || '10000').trim();
  const timeoutMs = Number.parseInt(timeoutStr, 10) || 10000;
  
  return Math.min(timeoutMs, 30000); // 限制最大 30 秒
}

// 構建 Webhook 請求負載
export function buildWebhookPayload(
  message: EmailMessage,
  env: WebhookEnv | any
): any {
  // 獲取郵件頭信息
  const headers = (message as any)?.headers || {};
  const fromHeader = headers?.get?.('from') || headers?.get?.('From') || '';
  const toAddr = String((message as any)?.to || '').trim().toLowerCase();
  const messageId = headers?.get?.('message-id') || headers?.get?.('Message-ID') || `<${crypto.randomUUID()}@mail-curl.local>`;

  return {
    message_id: String(messageId || '').trim(),
    to_addr: toAddr,
    from_addr: extractAddress(fromHeader),
    timestamp: Math.floor(Date.now() / 1000)
  };
}

// 構建完整的郵件內容 Webhook
export async function forwardCompleteEmailToWebhook(
  message: EmailMessage,
  env: WebhookEnv | any
): Promise<void> {
  const rawContent = await readMessageRaw(message);
  const payload = buildWebhookPayload(message, env);
  
  // 合併原始內容
  payload.raw_content = rawContent;
  payload.full_payload = true;

  console.log(`[Webhook] 準備發送郵件事件 -> to=${payload.to_addr || 'unknown'} message_id=${payload.message_id || 'unknown'}`);
  
  await postEmailWebhook(env, payload);
}

// 構建簡單的郵箱創建 Webhook
export async function forwardMailboxCreationToWebhook(
  email: string,
  prefix: string,
  mailboxId: string,
  env: WebhookEnv | any
): Promise<void> {
  const payload = {
    event_type: 'mailbox_creation',
    email: email,
    prefix: prefix,
    mailbox_id: mailboxId,
    timestamp: Math.floor(Date.now() / 1000)
  };

  console.log(`[Webhook] 準備發送郵箱創建事件 -> email=${email} mailbox_id=${mailboxId}`);
  
  await postEmailWebhook(env, payload);
}

// 構建郵件存儲 Webhook
export async function forwardMailStorageToWebhook(
  mailId: string,
  mailboxId: string,
  sender: string,
  subject: string,
  textContent: string,
  env: WebhookEnv | any
): Promise<void> {
  const payload = {
    event_type: 'mail_storage',
    mail_id: mailId,
    mailbox_id: mailboxId,
    sender_name: sender,
    subject: subject,
    text_content: textContent,
    timestamp: Math.floor(Date.now() / 1000)
  };

  console.log(`[Webhook] 準備發送郵件存儲事件 -> mail_id=${mailId} mailbox_id=${mailboxId}`);
  
  await postEmailWebhook(env, payload);
}

// 實際發送 Webhook 請求
async function postEmailWebhook(env: WebhookEnv | any, payload: any): Promise<void> {
  const url = resolveWebhookUrl(String(env?.WEBHOOK_URL || '').trim());
  
  if (!url) {
    throw new Error('WEBHOOK_URL 未配置');
  }

  console.log(`[Webhook] 開始請求 -> url=${url} to=${payload?.to_addr || 'unknown'}`);

  const timeoutMs = getWebhookTimeoutMs(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('email-webhook-timeout'), timeoutMs);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': String(env?.WEBHOOK_SECRET || '').trim()
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const bodyText = await resp.text();
    console.log(`[Webhook] 請求完成 -> status=${resp.status} ok=${resp.ok} to=${payload?.to_addr || 'unknown'}`);

    if (!resp.ok) {
      console.error(`[Webhook] 請求失敗 -> status=${resp.status} body=${bodyText}`);
      throw new Error(`Webhook 請求失敗: ${resp.status} ${bodyText}`);
    }

    try {
      const data = JSON.parse(bodyText || '{}');
      console.log(`[Webhook] 請求成功 -> response=${JSON.stringify(data)}`);
      return;
    } catch (_) {
      console.log(`[Webhook] 請求成功 -> raw=${bodyText}`);
      return;
    }
  } finally {
    clearTimeout(timer);
  }
}

// 讀取郵件原始內容
async function readMessageRaw(message: EmailMessage): Promise<string> {
  try {
    const resp = new Response((message as any)?.raw);
    const rawBuffer = await resp.arrayBuffer();
    return await new Response(rawBuffer).text();
  } catch (_) {
    return buildFallbackRawEmail(message);
  }
}

// 構建備用的原始郵件格式
function buildFallbackRawEmail(message: EmailMessage): string {
  const headers = (message as any)?.headers || {};
  const fromHeader = headers?.get?.('from') || headers?.get?.('From') || '';
  const toAddr = String((message as any)?.to || '').trim();
  const subject = headers?.get?.('subject') || headers?.get?.('Subject') || '(無主題)';

  return [
    `Message-ID: <${crypto.randomUUID()}@mail-curl.local>`,
    fromHeader ? `From: ${String(fromHeader).replace(/\r?\n/g, ' ').trim()}` : '',
    toAddr ? `To: ${String(toAddr).replace(/\r?\n/g, ' ').trim()}` : '',
    `Subject: ${String(subject || '(無主題)').replace(/\r?\n/g, ' ').trim()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
    ''
  ].filter(Boolean).join('\r\n');
}

// 提取郵件地址
function extractAddress(input: string): string {
  const value = String(input || '').trim();
  if (!value) return '';

  try {
    // 簡單郵件地址提取
    const emailMatch = value.match(/[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+/);
    if (emailMatch) return emailMatch[0];
    
    // 處理 "Name <email>" 格式
    const m = value.match(/<([^>]+)>/);
    return m ? m[1].trim() : value;
  } catch (_) {
    return value;
  }
}

// Webhook 驗證中間件
export function createWebhookAuthMiddleware() {
  return {
    async verify(request: Request, env: WebhookEnv): Promise<boolean> {
      const authHeader = request.headers.get('X-Webhook-Secret');
      const providedSecret = authHeader || request.headers.get('Authorization')?.replace('Bearer ', '') || '';
      
      const expectedSecret = String(env?.WEBHOOK_SECRET || '').trim();
      
      if (!providedSecret || providedSecret !== expectedSecret) {
        console.warn('[Webhook] 驗證失敗 - 無效或缺少密鑰');
        return false;
      }
      
       console.log('[Webhook] 驗證成功 - 密鑰匹配');
       return true;
     }
   }
 }
