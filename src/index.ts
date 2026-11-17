/**
 * 臨時郵箱 Worker - 使用 Cloudflare D1 存儲
 * 支持 Cloudflare Email Routing (catch-all)
 * 
 * 環境變量:
 *   - JWT_KEY: 訪問密鑰
 *   - domain: 郵箱後綴 (支持多域名，逗號分隔，如 domain1.com,domain2.com)
 *   - MAIL_PREFIX: 郵箱前綴 (默認 yoyomail)
 */

import PostalMime from "postal-mime";
import {
  isWebhookEnabled,
  forwardCompleteEmailToWebhook,
  forwardMailboxCreationToWebhook,
  getWebhookTimeoutMs
} from "./webhook";
import { isAllowedDomain, isInternalEmail, getEnvDomains } from "./domain-utils";
import {
	type AuthEnv,
	type User,
	ensureAdmin,
	getSessionUser,
	createSession,
	destroySession,
	destroyUserSessions,
	hashPassword,
	verifyPassword,
	sessionCookie,
	clearSessionCookie,
	getSessionToken,
	generateId,
} from "./auth";

// 多域名轮询索引
let domainIndex = 0;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function readKey(request: Request, url: URL): string {
	const authHeader = (request.headers.get("Authorization") || "").trim();
	const bearer = authHeader.toLowerCase().startsWith("bearer ")
		? authHeader.slice(7).trim()
		: authHeader;
	return (bearer || url.searchParams.get("key") || "").trim();
}

/** 可選：給 curl / 自動化用的管理員 API Key（設定 JWT_KEY 後才啟用） */
function isApiKeyAdmin(request: Request, url: URL, env: Env): boolean {
	const expected = String(env.JWT_KEY || "").trim();
	if (!expected) return false;
	return readKey(request, url) === expected;
}

async function readJson(request: Request): Promise<any> {
	try {
		return await request.json();
	} catch {
		return {};
	}
}

function normalizeEmail(value: unknown): string {
	return String(value || "").trim().toLowerCase();
}

/**
 * 登入帳號：可以用「純帳號名稱」（例如 admin、alice）或完整電郵。
 * 純帳號名稱限制 3~32 字元，只允許英數與 . _ - ，避免空白造成登入問題。
 */
function isAccount(value: string): boolean {
	if (!value || value.length > 64) return false;
	if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return true;
	return /^[a-z0-9][a-z0-9._-]{2,31}$/i.test(value);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// 靜態前端由 assets 處理，走到這裡代表是未知路徑
		if (!path.startsWith("/api/")) {
			return new Response("Not Found", { status: 404 });
		}

		try {
			// ---------- 公開：登入 / 登出 ----------
			if (path === "/api/login" && method === "POST") {
				return await handleLogin(request, env);
			}
			if (path === "/api/logout" && method === "POST") {
				return await handleLogout(request, env);
			}

			// ---------- 取得目前身份 ----------
			const sessionUser = await getSessionUser(request, env);
			const apiKeyAdmin = isApiKeyAdmin(request, url, env);
			const actor: User | null = sessionUser || (apiKeyAdmin
				? { id: "api-key", email: "api-key", role: "admin" }
				: null);

			if (path === "/api/me" && method === "GET") {
				if (!actor) return json({ user: null, mailboxes: [] });
				const mailboxes = await listMailboxesFor(env, actor).all();
				return json({
					user: actor,
					mailboxes: mailboxes.results || [],
				});
			}

			if (!actor) {
				return json({ error: "Unauthorized" }, 401);
			}

			// ---------- 一般使用者 ----------
			if (path === "/api/inbox" && method === "GET") {
				return await handleInbox(env, actor, url.searchParams);
			}
			if (path === "/api/mail" && method === "GET") {
				return await handleGetMail(env, actor, url.searchParams.get("id") || "");
			}

			// ---------- 管理員 ----------
			if (actor.role !== "admin") {
				return json({ error: "Forbidden" }, 403);
			}

			if (path === "/api/admin/overview" && method === "GET") {
				return await handleAdminOverview(env);
			}
			if (path === "/api/admin/users" && method === "POST") {
				return await handleCreateUser(request, env);
			}
			if (path === "/api/admin/users" && method === "PATCH") {
				return await handleUpdateUser(request, env);
			}
			if (path === "/api/admin/users" && method === "DELETE") {
				return await handleDeleteUser(request, env, actor, url.searchParams.get("id") || "");
			}
			if (path === "/api/admin/mailboxes" && method === "POST") {
				return await handleCreateMailbox(request, env);
			}
			if (path === "/api/admin/mailboxes" && method === "PATCH") {
				return await handleAssignMailbox(request, env);
			}
			if (path === "/api/admin/mailboxes" && method === "DELETE") {
				return await handleDeleteMailbox(env, url.searchParams.get("id") || "");
			}

			// 舊版相容：管理員用 query 產生地址
			if (path === "/api/remail" && method === "POST") {
				return await handleCreateMailboxFromQuery(env, url.searchParams);
			}
			if (path === "/api/ls" && method === "GET") {
				return await handleAdminOverview(env);
			}
			if (path === "/api/webhook/status" && method === "GET") {
				return await handleWebhookStatus(env);
			}

			return json({ error: "Not Found" }, 404);
		} catch (e: any) {
			return json({ error: e?.message || String(e) }, 500);
		}
	},

	/**
	 * 處理收到的郵件 (Cloudflare Email Routing)
	 */
	async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleIncomingEmail(message, env);
	},
} satisfies ExportedHandler<Env, unknown, unknown, { emailMessage: EmailMessage }>;

/* ------------------------------------------------------------------ */
/* 登入 / 登出                                                         */
/* ------------------------------------------------------------------ */

async function handleLogin(request: Request, env: Env): Promise<Response> {
	// 第一次登入時，若資料庫沒有管理員，用環境變數自動建立
	await ensureAdmin(env);

	const body = await readJson(request);
	const email = normalizeEmail(body.email);
	const password = String(body.password || "");

	if (!email || !password) {
		return json({ error: "請輸入帳號和密碼" }, 400);
	}

	const row: any = await env.DB.prepare(
		"SELECT id, email, password_hash, role FROM users WHERE email = ?"
	).bind(email).first();

	const valid = row ? await verifyPassword(password, row.password_hash) : false;
	if (!row || !valid) {
		return json({ error: "帳號或密碼不正確" }, 401);
	}

	const token = await createSession(env, row.id);
	const response = json({
		ok: true,
		user: { id: row.id, email: row.email, role: row.role === "admin" ? "admin" : "user" },
		redirect: row.role === "admin" ? "/admin.html" : "/inbox.html",
	});
	response.headers.append("Set-Cookie", sessionCookie(token));
	return response;
}

async function handleLogout(request: Request, env: Env): Promise<Response> {
	const token = getSessionToken(request);
	await destroySession(env, token);
	const response = json({ ok: true });
	response.headers.append("Set-Cookie", clearSessionCookie());
	return response;
}

/* ------------------------------------------------------------------ */
/* 信箱查詢                                                            */
/* ------------------------------------------------------------------ */

function listMailboxesFor(env: Env, actor: User): D1PreparedStatement {
	if (actor.role === "admin") {
		return env.DB.prepare(
			"SELECT id, email, user_id, created_at FROM mailboxes ORDER BY created_at DESC"
		);
	}
	return env.DB.prepare(
		"SELECT id, email, user_id, created_at FROM mailboxes WHERE user_id = ? ORDER BY created_at DESC"
	).bind(actor.id);
}

/**
 * 處理 /api/inbox - 查看收件箱
 * 一般使用者只能看自己的信箱；管理員可以看全部。
 */
async function handleInbox(env: Env, actor: User, params: URLSearchParams): Promise<Response> {
	const mailboxId = (params.get("mailbox_id") || "").trim();

	let mailbox: any = null;

	if (mailboxId) {
		mailbox = await env.DB.prepare(
			"SELECT id, email, user_id FROM mailboxes WHERE id = ?"
		).bind(mailboxId).first();

		if (!mailbox) return json({ error: "Mailbox not found" }, 404);
		if (actor.role !== "admin" && mailbox.user_id !== actor.id) {
			return json({ error: "Forbidden" }, 403);
		}
	} else {
		mailbox = actor.role === "admin"
			? await env.DB.prepare(
				"SELECT id, email, user_id FROM mailboxes ORDER BY created_at ASC LIMIT 1"
			).first()
			: await env.DB.prepare(
				"SELECT id, email, user_id FROM mailboxes WHERE user_id = ? ORDER BY created_at ASC LIMIT 1"
			).bind(actor.id).first();

		if (!mailbox) {
			return json({ error: "尚未分配信箱，請聯絡管理員", code: "no_mailbox" }, 404);
		}
	}

	const mails = await env.DB.prepare(
		"SELECT id, sender_name, content, created_at FROM mails WHERE mailbox_id = ? ORDER BY created_at DESC LIMIT 100"
	).bind(mailbox.id).all();

	return json({
		mailbox: { id: mailbox.id, email: mailbox.email, user_id: mailbox.user_id },
		mails: (mails.results || []).map(summarizeMail),
	});
}

/**
 * 處理 /api/mail - 查看郵件內容
 */
async function handleGetMail(env: Env, actor: User, mailId: string): Promise<Response> {
	if (!mailId) return json({ error: "Missing mail id" }, 400);

	const mail: any = await env.DB.prepare(
		`SELECT m.*, mb.user_id AS mailbox_user_id
		 FROM mails m JOIN mailboxes mb ON mb.id = m.mailbox_id
		 WHERE m.id = ?`
	).bind(mailId).first();

	if (!mail) return json({ error: "Mail not found" }, 404);
	if (actor.role !== "admin" && mail.mailbox_user_id !== actor.id) {
		return json({ error: "Forbidden" }, 403);
	}

	const content = safeJsonParse<MailContent>(String(mail.content || "{}"), {});
	const subject = content.subject || "(無主題)";
	const text = content.text || "";
	const html = content.html || "";

	return json({
		id: mail.id,
		mailbox_id: mail.mailbox_id,
		sender_name: mail.sender_name,
		subject,
		text,
		html,
		code: extractVerificationCode(subject, text, html),
		created_at: mail.created_at,
	});
}

/* ------------------------------------------------------------------ */
/* 管理員                                                              */
/* ------------------------------------------------------------------ */

async function handleAdminOverview(env: Env): Promise<Response> {
	const users = await env.DB.prepare(
		`SELECT u.id, u.email, u.role, u.created_at,
			(SELECT COUNT(*) FROM mailboxes mb WHERE mb.user_id = u.id) AS mailbox_count
		 FROM users u ORDER BY u.created_at ASC`
	).all();

	const mailboxes = await env.DB.prepare(
		`SELECT mb.id, mb.email, mb.user_id, mb.created_at,
			(SELECT COUNT(*) FROM mails m WHERE m.mailbox_id = mb.id) AS mail_count
		 FROM mailboxes mb ORDER BY mb.created_at DESC`
	).all();

	return json({
		users: users.results || [],
		mailboxes: mailboxes.results || [],
		domains: getEnvDomains(env.domain),
		allow_unknown_addresses: String(env.ALLOW_UNKNOWN_ADDRESSES || "false") === "true",
	});
}

async function handleCreateUser(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const email = normalizeEmail(body.email);
	const password = String(body.password || "");
	const role = body.role === "admin" ? "admin" : "user";

	if (!isAccount(email)) {
		return json({ error: "帳號格式不正確：請用 3~32 位英數字（可含 . _ -），或完整電郵" }, 400);
	}
	if (password.length < 6) return json({ error: "密碼至少 6 位" }, 400);

	const passwordHash = await hashPassword(password);
	const id = generateId();

	try {
		await env.DB.prepare(
			"INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)"
		).bind(id, email, passwordHash, role).run();
	} catch (e: any) {
		if (/unique/i.test(String(e?.message || ""))) {
			return json({ error: "這個帳號已經有人用了" }, 409);
		}
		throw e;
	}

	return json({ ok: true, user: { id, email, role } }, 201);
}

async function handleUpdateUser(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const id = String(body.id || "").trim();
	const password = String(body.password || "");

	if (!id) return json({ error: "Missing user id" }, 400);
	if (password.length < 6) return json({ error: "密碼至少 6 位" }, 400);

	const passwordHash = await hashPassword(password);
	const result = await env.DB.prepare(
		"UPDATE users SET password_hash = ? WHERE id = ?"
	).bind(passwordHash, id).run();

	if (!result.meta || result.meta.changes === 0) {
		return json({ error: "找不到使用者" }, 404);
	}

	// 改密碼後讓舊的登入狀態失效
	await destroyUserSessions(env, id);
	return json({ ok: true });
}

async function handleDeleteUser(request: Request, env: Env, actor: User, queryId: string): Promise<Response> {
	const body = await readJson(request);
	const id = String(queryId || body.id || "").trim();

	if (!id) return json({ error: "Missing user id" }, 400);
	if (id === actor.id) return json({ error: "不能刪除自己" }, 400);

	await env.DB.prepare("UPDATE mailboxes SET user_id = NULL WHERE user_id = ?").bind(id).run();
	await destroyUserSessions(env, id);
	const result = await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run();

	if (!result.meta || result.meta.changes === 0) {
		return json({ error: "找不到使用者" }, 404);
	}
	return json({ ok: true });
}

async function handleCreateMailbox(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	return await createMailbox(env, {
		prefix: body.prefix ? String(body.prefix) : undefined,
		word: body.word ? String(body.word) : undefined,
		birthday: body.birthday ? String(body.birthday) : undefined,
		domain: body.domain ? String(body.domain) : undefined,
		userId: body.user_id ? String(body.user_id) : null,
	});
}

async function handleCreateMailboxFromQuery(env: Env, params: URLSearchParams): Promise<Response> {
	return await createMailbox(env, {
		word: params.get("word") || undefined,
		birthday: params.get("birthday") || undefined,
		domain: params.get("domain") || undefined,
		userId: params.get("user_id") || null,
	});
}

async function createMailbox(
	env: Env,
	options: { prefix?: string; word?: string; birthday?: string; domain?: string; userId?: string | null }
): Promise<Response> {
	let domain: string;
	try {
		domain = getDomain(env.domain, options.domain);
	} catch (e: any) {
		return json({ error: e.message }, 400);
	}

	if (options.userId) {
		const owner = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(options.userId).first();
		if (!owner) return json({ error: "指定的使用者不存在" }, 400);
	}

	const cleanPrefix = options.prefix
		? options.prefix.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32)
		: "";
	const prefix = cleanPrefix
		? `${cleanPrefix}-${generateRandomSuffix(4)}`
		: generatePrefix(env.MAIL_PREFIX, options.word, options.birthday);
	const email = `${prefix}@${domain}`.toLowerCase();
	const id = generateMailboxId();

	try {
		await env.DB.prepare(
			"INSERT INTO mailboxes (id, email, prefix, user_id) VALUES (?, ?, ?, ?)"
		).bind(id, email, prefix, options.userId || null).run();
	} catch (e: any) {
		if (/unique/i.test(String(e?.message || ""))) {
			return json({ error: "地址重複，請再試一次" }, 409);
		}
		throw e;
	}

	try {
		if (isWebhookEnabled(env)) {
			await forwardMailboxCreationToWebhook(email, prefix, id, env);
		}
	} catch (webhookError) {
		console.error("[Webhook] 發送郵箱創建事件失敗:", webhookError);
	}

	return json({ ok: true, mailbox: { id, email, user_id: options.userId || null } }, 201);
}

async function handleAssignMailbox(request: Request, env: Env): Promise<Response> {
	const body = await readJson(request);
	const id = String(body.id || "").trim();
	const userId = body.user_id ? String(body.user_id) : null;

	if (!id) return json({ error: "Missing mailbox id" }, 400);

	if (userId) {
		const owner = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
		if (!owner) return json({ error: "指定的使用者不存在" }, 400);
	}

	const result = await env.DB.prepare(
		"UPDATE mailboxes SET user_id = ? WHERE id = ?"
	).bind(userId, id).run();

	if (!result.meta || result.meta.changes === 0) {
		return json({ error: "找不到地址" }, 404);
	}
	return json({ ok: true });
}

async function handleDeleteMailbox(env: Env, id: string): Promise<Response> {
	if (!id) return json({ error: "Missing mailbox id" }, 400);

	await env.DB.prepare("DELETE FROM mails WHERE mailbox_id = ?").bind(id).run();
	const result = await env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run();

	if (!result.meta || result.meta.changes === 0) {
		return json({ error: "找不到地址" }, 404);
	}
	return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* 郵件內容工具                                                        */
/* ------------------------------------------------------------------ */

interface MailContent {
	subject?: string;
	text?: string;
	html?: string;
}

function safeJsonParse<T>(value: string, fallback: T): T {
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function stripHtml(html: string): string {
	return html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/\s+/g, " ")
		.trim();
}

/**
 * 從郵件中抓驗證碼：先找「驗證碼關鍵字」附近 4~8 位數字，找不到再退回一般數字
 */
export function extractVerificationCode(subject: string, text: string, html: string): string | null {
	const haystack = [subject, text, stripHtml(html)].filter(Boolean).join("\n");
	if (!haystack.trim()) return null;

	const patterns = [
		/(?:verification|verify|security|login|sign[\s-]?in|one[\s-]?time|otp|passcode|code|pin|驗證碼|验证码|認證碼|確認碼|コード)[^\d]{0,40}(\d{4,8})/i,
		/\b(\d{6})\b/,
		/\b(\d{4,8})\b/,
	];

	for (const pattern of patterns) {
		const match = haystack.match(pattern);
		if (match) return match[1];
	}
	return null;
}

function summarizeMail(row: any) {
	const content = safeJsonParse<MailContent>(String(row.content || "{}"), {});
	const subject = content.subject || "(無主題)";
	const text = content.text || "";
	const html = content.html || "";
	const preview = (text.trim() || stripHtml(html)).slice(0, 160);

	return {
		mail_id: row.id,
		sender_name: row.sender_name,
		subject,
		code: extractVerificationCode(subject, text, html),
		preview,
		created_at: row.created_at,
	};
}

function extractAddress(input: string): string {
	const value = String(input || "").trim();
	const match = value.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
	return (match ? match[0] : value).toLowerCase();
}

interface Env extends AuthEnv {
	DB: D1Database;
	JWT_KEY?: string;  // 可選：給 curl 用的管理員 API Key
	domain: string;  // 郵箱域名，多個用逗號分隔
	MAIL_PREFIX?: string;  // 郵箱前綴 (未設置時使用隨機人名)
	ADMIN_EMAIL?: string;  // 管理員帳號（第一次登入時自動建立）
	ADMIN_PASSWORD?: string;  // 管理員密碼（請用 wrangler secret put 設定）
	ALLOW_UNKNOWN_ADDRESSES?: string;  // "true" = 沒事先建立的地址也收信
	WEBHOOK_URL?: string;
	WEBHOOK_SECRET?: string;
	WEBHOOK_TIMEOUT_MS?: string;
}

/**
 * 生成隨機 ID
 * 郵箱ID: xxxx-xx-xx-xxxx (12位)
 * 郵件ID: xxxxxx-xxx-xxx-xxxxxx (18位)
 */
function generateMailboxId(): string {
	const chars = "0123456789abcdef";
	const generatePart = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
	return `${generatePart(4)}-${generatePart(2)}-${generatePart(2)}-${generatePart(4)}`;
}

function generateMailId(): string {
	const chars = "0123456789abcdef";
	const generatePart = (len: number) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
	return `${generatePart(6)}-${generatePart(3)}-${generatePart(3)}-${generatePart(6)}`;
}

// 隨機人名列表 (當 MAIL_PREFIX 未設置時使用) - 多輪擴充名字池
export const RANDOM_NAMES = [
	// A-G 經典名字
	"alex", "aaron", "adam", "adrian", "alan", "albert", "alexander", "alice", "allan", "allen",
	"amanda", "amber", "amy", "andrea", "andrew", "angela", "anna", "anthony", "ashley", "austin",
	"benjamin", "beth", "beverly", "bill", "billy", "blake", "bob", "bobby", "brad", "bradley",
	"brandon", "brandy", "brent", "brian", "brittany", "brooke", "bruce", "bryan", "bryce", "buck",
	"caitlin", "cameron", "carl", "carlos", "carol", "caroline", "carolyn", "casey", "cassie", "charles",
	"charlie", "charlotte", "chase", "chris", "christian", "christina", "christine", "christopher", "chuck", "cindy",
	"claire", "clara", "clint", "cody", "cole", "colin", "colleen", "connor", "courtney", "craig",
	"crystal", "cynthia", "daisy", "dale", "dan", "dana", "daniel", "danielle", "danny", "dave",
	"david", "dawn", "dean", "debbie", "deborah", "debra", "denise", "dennis", "derek", "desiree",
	"destiny", "diana", "diane", "donna", "donny", "dora", "doug", "douglas", "drew", "duane",
	"dustin", "dwayne", "dylan", "ebony", "eddie", "edgar", "edith", "edmund", "edward", "edwin",
	"elaine", "elena", "elizabeth", "ella", "ellen", "emily", "emma", "eric", "erica", "erik",
	"ernie", "ethan", "eugene", "eva", "evan", "evelyn", "frank", "franklin", "fred", "freddy",
	"gabriel", "gail", "garry", "gary", "gavin", "gene", "george", "gerald", "gillian", "glenda",
	"glenn", "gloria", "gordon", "grace", "grant", "greg", "gregg", "gregory", "gretchen", "guy",
	// H-N 經典名字
	"haley", "hannah", "harold", "harris", "harrison", "harry", "hayden", "heather", "hector", "henry",
	"herbert", "howard", "hunter", "ian", "irene", "isaac", "isabel", "isabella", "jack", "jackson",
	"jacob", "jade", "jaime", "jake", "james", "jamie", "jane", "janet", "janice", "jared",
	"jasmine", "jason", "jay", "jean", "jeanette", "jeanne", "jeff", "jeffrey", "jennifer", "jenny",
	"jeremy", "jerry", "jesse", "jessica", "jill", "jim", "jimmy", "joan", "joann", "joanna",
	"joanne", "jocelyn", "jodi", "jody", "joe", "joel", "john", "johnny", "jon", "jonathan",
	"jonathon", "jordon", "jose", "joseph", "josh", "joshua", "juan", "jude", "julia", "juliana",
	"julianna", "julie", "julius", "justin", "karen", "karina", "karl", "kate", "katelyn", "katherine",
	"kathleen", "kathryn", "kathy", "katie", "katrina", "kayla", "kaylee", "kevin", "kim", "kimberly",
	"kristen", "kristin", "kristina", "kristine", "kristy", "krystal", "kyle", "lamar", "lance",
	"larry", "laura", "lauren", "laurie", "leah", "lee", "leigh", "lena", "leo", "leon",
	"leonard", "leroy", "leslie", "linda", "lindsay", "lindsey", "lionel", "lois", "lola", "louis",
	// M-T 經典名字
	"lucas", "lucia", "lucy", "lydia", "lynn", "mack", "madison", "mae", "maggie", "malcolm",
	"manuel", "marc", "marco", "marcus", "margaret", "maria", "marian", "marie", "marilyn", "marisa",
	"marissa", "mark", "martin", "marvin", "mary", "mason", "mathew", "matt", "matthew", "maurice",
	"max", "maxwell", "meagan", "megan", "melanie", "melissa", "melody", "mercedes", "michael", "michelle",
	"miguel", "mike", "mildred", "mindy", "miranda", "miriam", "misty", "mitchell", "nancy", "naomi",
	"natalie", "natasha", "nathan", "nathaniel", "neil", "nelson", "nicholas", "nicole", "nina", "noah",
	"norma", "norman", "oliver", "olivia", "oscar", "pablo", "palmer", "pam", "pamela", "pat",
	"patricia", "patrick", "patty", "paul", "paula", "peggy", "penny", "perry", "peter", "phil",
	"philip", "phillip", "phoebe", "pierre", "quinn", "rachael", "rachel", "raquel", "ray", "raymond",
	"reba", "rebecca", "rebekah", "regina", "rex", "rhonda", "richard", "rick", "ricky", "riley",
	"robert", "robin", "roderick", "rodney", "roger", "roland", "ron", "ronald", "ronnie", "rose",
	// S-Z 經典名字
	"ross", "roy", "ruben", "russell", "ryan", "sabrina", "sally", "sam", "samuel", "sandra",
	"sandy", "sara", "sarah", "sasha", "savannah", "scott", "sean", "seth", "shannon", "sharon",
	"shawn", "sheila", "shelby", "shelia", "shelley", "shelly", "sherry", "shirley", "sidney", "sierra",
	"silvia", "sophia", "sophie", "stacey", "stacie", "stacy", "stanley", "stefanie", "stella", "stephanie",
	"stephen", "steve", "steven", "stuart", "sue", "summer", "susan", "suzanne", "sybil", "sylvia",
	"taylor", "teresa", "terry", "theodore", "theresa", "thomas", "tiffany", "tim", "timothy", "tina",
	"todd", "tom", "tommy", "toni", "tony", "tracey", "traci", "tracie", "tracy", "travis",
	"trevor", "tricia", "trina", "trisha", "tristan", "troy", "tyler", "valerie", "vanessa", "vernon",
	"victoria", "vincent", "violet", "virginia", "vivian", "wade", "walker", "wallace", "walt", "walter",
	"warren", "wayne", "wendy", "william", "willie", "xavier", "yvonne", "zachary", "zena", "zoe",
	// 新世代常見名字
	"abigail", "addison", "aiden", "alina", "amara", "amelia", "aria", "asher", "aubrey", "aurora",
	"avery", "ayla", "beatrice", "bella", "bianca", "bonnie", "braxton", "brielle", "caleb", "callie",
	"celeste", "clay", "clover", "cooper", "delia", "delilah", "easton", "eleanor", "eli", "elodie",
	"elsie", "ezra", "felix", "fiona", "flora", "freya", "gianna", "gideon", "hadley", "harper",
	"harvey", "hazel", "holden", "hudson", "imani", "indigo", "isla", "ivy", "jasper", "josephine",
	"juniper", "kieran", "kira", "landon", "levi", "lila", "luca", "lyra", "mabel", "maia",
	"mila", "milo", "nico", "nora", "nova", "owen", "paige", "piper", "quincy", "remi",
	"romy", "rowan", "sawyer", "serena", "sloane", "thea", "viola", "willa", "wyatt", "zara",
	"zoey", "yuna", "xena",
	// 第二輪補充名字
	"alora", "ansel", "astrid", "briony", "cassian", "corin", "daphne", "elowen", "evander", "farah",
	"iapetus", "ines", "juno", "kaia", "lennon", "linnea", "marigold", "merritt", "nikolai", "orion",
	"percy", "primrose", "raina", "soren", "solene", "talia", "ursa", "vesper", "yasmin", "zeno",
	// 第三輪補充名字
	"aurelia", "bastian", "callista", "dorian", "elara", "finley", "gaia", "helena", "iora", "jasperine",
	"kael", "leora", "magnus", "nova-rose", "octavia", "peregrine", "rosalie", "selwyn", "thalia", "valen",
	// 第四輪補充名字
	"adaline", "ainsley", "alistair", "anika", "anouk", "arden", "arlo", "azalea", "bernadette", "bodhi",
	"cecily", "cerise", "cian", "cosette", "cressida", "daxton", "demetri", "eira", "emerson", "esme",
	"fergus", "greta", "imogen", "joelle", "lorcan", "lucian", "maelle", "marcellus", "maxine", "noemi",
	"odette", "oleander", "opaline", "oswin", "paloma", "renata", "sabine", "saskia", "thiago", "ulysses",
	"violetta", "winona", "yorick", "zelda", "amias", "beren", "cassia", "draven", "eulalie", "fintan",
	"ginevra", "hyacinth", "isolde", "kerensa", "lavinia", "maelis", "nereus", "olenna", "quilan", "romilly",
	// 第五輪補充名字
	"adara", "adelie", "aerin", "ahava", "ailis", "alouette", "altair", "amadeo", "anselm", "araminta",
	"arwen", "astoria", "auden", "aurelio", "basile", "belen", "bellerose", "birgit", "calix", "cassiel",
	"cataleya", "cato", "delphine", "desmond", "elio", "elowyn", "endellion", "enya", "eowyn", "faelan",
	"fiorella", "gael", "galatea", "gaelan", "hadrian", "halston", "illyria", "inara", "ione", "isandro",
	"jacinta", "jorah", "kaida", "kasimir", "keir", "lysander", "maelys", "malina", "marcella", "melisande",
	"mireille", "naia", "nicolette", "oisin", "orla", "ottilie", "pascaline", "petra", "quade", "raoul",
	"rhiannon", "ronan", "salome", "samira", "severin", "soraya", "tanith", "tamsin", "theodora", "thierry",
	"undine", "valeria", "valora", "verity", "vesna", "xanthe", "yseult", "zadie", "zorion", "auberon",
	"briar", "caelan", "caelum", "celine", "circe", "darian", "eamon", "elspeth", "emeric", "fenella",
	"florian", "imelda", "indra", "jocasta", "ksenia", "lazlo", "leocadia", "lorien", "maeven", "nadira",
	"nuala", "oberon", "odhran", "oriana", "quetzal", "rafferty", "saphira", "seraphine", "sylvan", "taliesin",
	"tiberius", "valerian", "viatrix", "wynter", "xavian", "yvaine", "zephyra",
	// 簡短暱稱風格
	"ash", "bell", "bird", "bliss", "blue", "bolt", "bond", "brew", "brook", "buck",
	"cam", "chips", "cobb", "dash", "dawn", "dust", "dax", "echo", "edge", "ember",
	"finn", "flux", "frost", "gale", "gem", "glint", "grove", "hank", "hawk", "haze",
	"jazz", "jet", "kai", "keen", "kite", "lark", "leaf", "lime", "link", "luna",
	"maple", "mariner", "max", "maze", "mint", "moxie", "neo", "nimbus", "oak", "onyx",
	"pearl", "pike", "pixie", "play", "pure", "rain", "raven", "reed", "ridge", "river",
	"roam", "ruby", "sage", "salt", "sandy", "scar", "shade", "shay", "silk", "sky",
	"slate", "snow", "spark", "spice", "star", "storm", "sully", "sunny", "sven", "swift",
	"syrup", "tango", "tawny", "teal", "tempo", "tide", "timber", "titan", "tonto", "topaz",
	"trix", "trout", "twix", "urban", "vega", "velvet", "volt", "vortex", "ward", "wild",
	"wolf", "wren", "wylie", "wynn", "xander", "yarrow", "yogi", "york", "zany", "zinc", "zippy", "zola"
];

// 默認名詞列表 (未指定 word 時使用) - 多輪擴充名詞池
export const DEFAULT_WORDS = [
	// 自然元素
	"cloud", "star", "moon", "sun", "sky", "rain", "snow", "wind", "fire", "water",
	"tree", "flower", "leaf", "grass", "garden", "forest", "mountain", "ocean", "river", "lake",
	"sea", "wave", "storm", "thunder", "lightning", "dawn", "dusk", "night", "day",
	// 動物
	"bird", "fish", "cat", "dog", "wolf", "fox", "bear", "lion", "tiger", "eagle",
	"butterfly", "dragon", "phoenix", "panda", "koala", "rabbit", "horse", "deer",
	// 植物水果
	"rose", "lily", "tulip", "orchid", "bamboo", "palm", "cactus", "apple", "orange",
	"grape", "peach", "cherry", "berry", "melon", "lemon",
	// 抽象 / 其他
	"dream", "hope", "love", "peace", "joy", "smile", "heart", "soul", "spirit", "magic",
	"unicorn", "crystal", "diamond", "golden", "silver", "bronze", "shadow", "light",
	"frost", "ice", "steam", "dust", "sand", "stone", "rock", "metal", "iron", "steel",
	"copper", "glass", "mirror", "window", "door", "house", "home", "nest", "cocoon", "shell",
	"pearl", "coral", "amber", "jade", "ruby", "emerald", "topaz", "opal", "sapphire", "amethyst", "quartz",
	"planet", "comet", "galaxy", "universe", "cosmos", "nebula", "aurora", "rainbow", "horizon", "stream", "brook", "waterfall",
	// 地景與方位
	"anchor", "atlas", "bay", "beacon", "branch", "canyon", "cavern", "cliff", "cove", "delta",
	"field", "fjord", "glacier", "grove", "harbor", "hollow", "island", "lagoon", "marsh", "meadow",
	"mesa", "oasis", "orbit", "path", "prairie", "reef", "ridge", "shore", "summit", "trail",
	"valley", "waypoint",
	// 器物與紋理
	"compass", "feather", "lantern", "map", "pebble", "quill", "sail", "signal", "thread", "whistle",
	// 生長與氛圍
	"breeze", "ember", "fern", "harvest", "hearth", "mist", "orchard", "sprout", "thicket", "voyage",
	"willow", "zephyr",
	// 第二輪地景與器物延伸
	"alcove", "arch", "campfire", "glow", "harvestmoon", "keep", "passage", "roamer", "shelter", "spindle",
	"terrace", "tundra", "citadel", "drift", "hinterland", "lookout", "mosaic", "northwind", "rosette", "wayfarer",
	// 第三輪地景與器物延伸
	"afterglow", "arbour", "bramble", "causeway", "crescent", "daybreak", "estuary", "firefly", "granite", "haven",
	"inkwell", "jetty", "knoll", "lodestar", "monolith", "nook", "outpost", "parchment", "seafoam", "windlass",
	// 第四輪地景與器物延伸
	"aperture", "aviary", "badlands", "boardwalk", "breakwater", "byway", "canopy", "cascade", "chamber", "crosswind",
	"dewfall", "downstream", "everglade", "fathom", "flagstone", "foothill", "foxglove", "glen", "hemlock", "highland",
	"iceberg", "junction", "keystone", "lamplight", "lowland", "moorland", "moonbeam", "narrows", "overlook", "peninsula",
	"quarry", "rill", "runestone", "sandbar", "shipyard", "starfall", "sunflare", "timberline", "undercliff", "upland",
	"verdure", "waystone", "westwind", "wildflower", "woodland", "yardarm", "zenith", "backwater", "courtyard", "gatehouse",
	"hillside", "moonrise", "nightfall", "raindrop", "saltmarsh", "seafarer", "torchlight", "trailhead", "windward", "brookside",
	// 第五輪地景與器物延伸
	"abutment", "aerie", "allotment", "antechamber", "archipelago", "armature", "arroyo", "ashfall", "basalt", "bastion",
	"bellwether", "berth", "bluff", "bothy", "bracken", "brickyard", "brink", "brooklet", "cairn", "caldera",
	"campanile", "catwalk", "chaparral", "churchyard", "cloudbank", "colonnade", "copse", "cornice", "cutwater", "dale",
	"dockland", "drawbridge", "drumlin", "dunegrass", "earthlight", "embankment", "fenland", "ferrywake", "flint", "fold",
	"foreland", "foundry", "frostline", "furrow", "garth", "glade", "headland", "hearthstone", "hedgerow", "hillfort",
	"hoarfrost", "inlet", "isthmus", "jetstream", "keyway", "kingsroad", "landbridge", "lee", "levee", "lichen",
	"lockgate", "longhouse", "marshlight", "mews", "millpond", "moonglade", "moor", "nettle", "northstar", "observatory",
	"oldgrowth", "oriel", "palisade", "parkland", "peatbog", "plinth", "promontory", "quarryside", "quicksilver", "ridgeline",
	"rookery", "rootcellar", "saltwind", "scarp", "seacliff", "seawall", "shipwake", "shoal", "skerry", "skylark",
	"slipway", "snowdrift", "sounding", "southridge", "springtide", "stargrove", "stepwell", "stonework", "sunwash", "swale",
	"tallow", "tidepool", "towpath", "traverse", "treeline", "turnstile", "underpass", "uplight", "viaduct", "watchtower",
	"waterline", "watershed", "weathervane", "wetlands", "wharf", "wildwood", "windbreak", "windchime", "yardang"
];

function generatePrefix(mailPrefix: string | undefined, word?: string, birthday?: string): string {
	// 如果 MAIL_PREFIX 未設置或為空，使用隨機人名
	const prefixBase = mailPrefix?.trim() || RANDOM_NAMES[Math.floor(Math.random() * RANDOM_NAMES.length)];
	// 如果沒有提供自定義詞，使用隨機默認詞
	const selectedWord = word || DEFAULT_WORDS[Math.floor(Math.random() * DEFAULT_WORDS.length)];
	// 如果沒有提供生日，隨機生成 MMDD 格式 (如 0824)
	const dateStr = birthday || generateRandomBirthday();
	// 隨機生成 3 位字符 (如 a1b)
	const randomSuffix = generateRandomSuffix(3);
	return `${prefixBase}-${selectedWord}-${dateStr}-${randomSuffix}`;
}

// 隨機生成 MMDD 格式的生日 (如 0824)
function generateRandomBirthday(): string {
	const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
	const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");
	return `${month}${day}`;
}

// 隨機生成指定位數的字符 (數字 + 小寫字母)
function generateRandomSuffix(length: number): string {
	const chars = "0123456789abcdef";
	let result = "";
	for (let i = 0; i < length; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	return result;
}

// 從環境變數中獲取域名 (支持多域名，逗號分隔)
// 使用輪詢 (round-robin) 方式，實現均勻分布
// 同時支持泛域名匹配 (如 domain=example.com，可接受 sub.example.com)
function getDomain(envDomain: string | undefined, requestedDomain?: string): string {
	// 如果請求中指定了域名，直接使用並驗證
	if (requestedDomain) {
		if (isAllowedDomain(requestedDomain, envDomain)) {
			return requestedDomain;
		}
		throw new Error(`域名 ${requestedDomain} 不在允許列表中`);
	}
	
	// 解析多域名列表
	const domains = getEnvDomains(envDomain);
	
	if (domains.length === 0) {
		throw new Error('未配置域名 (domain environment variable)');
	}
	
	// 如果只有一個域名，直接返回
	if (domains.length === 1) {
		return domains[0];
	}
	
	// 多域名時使用輪詢 (round-robin)
	const selected = domains[domainIndex % domains.length];
	domainIndex++;  // 遞增，為下次準備
	
	return selected;
}

/**
 * 處理收到的郵件 (Cloudflare Email Routing)
 * 解析郵件並存儲到 D1
 * 同時根據配置轉發到 Webhook
 */
async function handleIncomingEmail(message: EmailMessage, env: Env): Promise<void> {
	try {
		// 信封收件人（*@你的網域）與寄件人
		const toAddress = extractAddress(String((message as any)?.to || ""));
		const headers = (message as any)?.headers;
		const fromAddress = extractAddress(
			headers?.get?.("from") || (message as any)?.from || "unknown"
		);

		// 如果啟用了 Webhook，直接轉發郵件並返回 (不走本地存儲流程)
		if (isWebhookEnabled(env)) {
			await forwardCompleteEmailToWebhook(message, env);
			return;
		}

		// 檢查接收郵箱的域名是否在允許列表中 (支援泛域名)
		if (!isInternalEmail(toAddress, env.domain)) {
			console.log(`[Filter] 拒絕郵件: ${toAddress} 域名不被允許`);
			return;
		}

		let subject = "";
		let textContent = "";
		let htmlContent = "";

		try {
			const raw = (message as any)?.raw;
			if (raw) {
				const buffer = await new Response(raw).arrayBuffer();
				const parsed = await PostalMime.parse(buffer);
				subject = parsed.subject || "";
				textContent = (parsed.text || "").slice(0, 200_000);
				htmlContent = (parsed.html || "").slice(0, 200_000);
			}
		} catch (e: any) {
			console.error("Error parsing email:", e.message);
		}

		const code = extractVerificationCode(subject, textContent, htmlContent);
		const mailContent = JSON.stringify({
			subject,
			text: textContent,
			html: htmlContent,
			code
		});

		const prefix = toAddress.split("@")[0] || "";

		// 只收「管理員事先產生」的地址；除非 ALLOW_UNKNOWN_ADDRESSES=true
		let mailbox: any = await env.DB.prepare(
			"SELECT id FROM mailboxes WHERE email = ?"
		).bind(toAddress).first();

		if (!mailbox) {
			if (String(env.ALLOW_UNKNOWN_ADDRESSES || "false") !== "true") {
				console.log(`[Filter] 丟棄未建立的地址: ${toAddress}`);
				return;
			}

			const newMailboxId = generateMailboxId();
			await env.DB.prepare(
				"INSERT INTO mailboxes (id, email, prefix, user_id) VALUES (?, ?, ?, NULL)"
			).bind(newMailboxId, toAddress, prefix).run();
			mailbox = { id: newMailboxId };
			console.log(`Created new mailbox: ${toAddress} (${newMailboxId})`);
		}

		// 生成郵件ID
		const mailId = generateMailId();

		// 存儲郵件
		await env.DB.prepare(
			"INSERT INTO mails (id, mailbox_id, sender_name, content) VALUES (?, ?, ?, ?)"
		).bind(mailId, String(mailbox.id), fromAddress, mailContent).run();

		console.log(`Email stored: ${fromAddress} -> ${toAddress}, mail_id: ${mailId}, code: ${code ?? "-"}`);
	} catch (e: any) {
		console.error("Error processing email:", e.message, e.stack);
	}
}

/**
 * 處理 Webhook 狀態查詢
 * 檢查 Webhook 配置是否正確
 */
async function handleWebhookStatus(env: Env): Promise<Response> {
	const webhookEnabled = isWebhookEnabled(env);
	const webhookUrl = String(env?.WEBHOOK_URL || '').trim();
	const webhookSecret = String(env?.WEBHOOK_SECRET || '').trim();
	const timeoutMs = getWebhookTimeoutMs(env);

	const status = {
		webhook_enabled: webhookEnabled,
		webhook_url: webhookUrl,
		webhook_secret: webhookSecret ? '*****' : '', // 隱藏密鑰
		timeout_ms: timeoutMs,
		timestamp: Math.floor(Date.now() / 1000)
	};

	return new Response(JSON.stringify(status), {
		status: 200,
		headers: { "Content-Type": "application/json" }
	});
}
