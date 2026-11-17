/**
 * 帳號 / 工作階段 / 密碼雜湊
 *
 * 設計重點：
 * - 密碼用 PBKDF2-SHA256（Workers 免費方案的 CPU 限制很小，迭代次數調低到 6000）
 * - Session 只把 token 的 SHA-256 存進 D1，瀏覽器拿原始 token（HttpOnly Cookie）
 * - 管理員由環境變數 ADMIN_EMAIL / ADMIN_PASSWORD 自動建立，不開放註冊
 */

export interface AuthEnv {
	DB: D1Database;
	ADMIN_EMAIL?: string;
	ADMIN_PASSWORD?: string;
}

export interface User {
	id: string;
	email: string;
	role: "admin" | "user";
}

const SESSION_COOKIE = "mc_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const PBKDF2_ITERATIONS = 6000;

/* ---------------- 編碼工具 ---------------- */

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(byteLength = 32): string {
	const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
	return bytesToBase64(bytes)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export function generateId(length = 16): string {
	const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
	return bytesToHex(bytes).slice(0, length);
}

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/* ---------------- 密碼 ---------------- */

export async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"]
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
		key,
		256
	);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = String(stored || "").split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

	const iterations = Number.parseInt(parts[1], 10);
	if (!Number.isFinite(iterations) || iterations <= 0) return false;

	const salt = base64ToBytes(parts[2]);
	const expected = parts[3];

	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"]
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt, iterations },
		key,
		256
	);

	return timingSafeEqual(bytesToBase64(new Uint8Array(bits)), expected);
}

/* ---------------- Cookie ---------------- */

export function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get("Cookie") || "";
	const result: Record<string, string> = {};
	for (const part of header.split(";")) {
		const index = part.indexOf("=");
		if (index < 0) continue;
		const name = part.slice(0, index).trim();
		const value = part.slice(index + 1).trim();
		if (name) result[name] = decodeURIComponent(value);
	}
	return result;
}

export function getSessionToken(request: Request): string {
	return parseCookies(request)[SESSION_COOKIE] || "";
}

export function sessionCookie(token: string): string {
	return [
		`${SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_SECONDS}`,
	].join("; ");
}

export function clearSessionCookie(): string {
	return [
		`${SESSION_COOKIE}=`,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
		"Max-Age=0",
	].join("; ");
}

/* ---------------- 工作階段 ---------------- */

async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return bytesToHex(new Uint8Array(digest));
}

export async function createSession(env: AuthEnv, userId: string): Promise<string> {
	const token = randomToken();
	const tokenHash = await hashToken(token);
	const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;

	await env.DB.prepare(
		"INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)"
	).bind(tokenHash, userId, expiresAt).run();

	return token;
}

export async function destroySession(env: AuthEnv, token: string): Promise<void> {
	if (!token) return;
	const tokenHash = await hashToken(token);
	await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(tokenHash).run();
}

export async function destroyUserSessions(env: AuthEnv, userId: string): Promise<void> {
	await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function getSessionUser(request: Request, env: AuthEnv): Promise<User | null> {
	const token = getSessionToken(request);
	if (!token) return null;

	const tokenHash = await hashToken(token);
	const now = Math.floor(Date.now() / 1000);

	const row: any = await env.DB.prepare(
		`SELECT u.id, u.email, u.role
		 FROM sessions s JOIN users u ON u.id = s.user_id
		 WHERE s.token_hash = ? AND s.expires_at > ?`
	).bind(tokenHash, now).first();

	if (!row) return null;
	return { id: row.id, email: row.email, role: row.role === "admin" ? "admin" : "user" };
}

/* ---------------- 管理員初始化 ---------------- */

/**
 * 如果資料庫裡還沒有管理員，就用 ADMIN_EMAIL / ADMIN_PASSWORD 建一個。
 * 只會在登入 / 取得目前使用者時呼叫。
 */
export async function ensureAdmin(env: AuthEnv): Promise<void> {
	const existing = await env.DB.prepare(
		"SELECT id FROM users WHERE role = 'admin' LIMIT 1"
	).first();
	if (existing) return;

	const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
	const password = String(env.ADMIN_PASSWORD || "");
	if (!email || !password) return;

	const passwordHash = await hashPassword(password);
	await env.DB.prepare(
		"INSERT OR IGNORE INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin')"
	).bind(generateId(), email, passwordHash).run();
}
