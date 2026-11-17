/* 共用工具：所有頁面都先載入這支 */
(() => {
	"use strict";

	const MC = {};

	MC.esc = function esc(value) {
		return String(value == null ? "" : value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	};

	MC.$ = (id) => document.getElementById(id);

	let toastTimer = 0;
	MC.toast = function toast(message) {
		let el = document.getElementById("toast");
		if (!el) {
			el = document.createElement("div");
			el.id = "toast";
			el.className = "toast";
			document.body.appendChild(el);
		}
		el.textContent = message;
		el.classList.add("show");
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
	};

	MC.copy = async function copyText(text) {
		if (!text) return false;
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch (_) {
			const area = document.createElement("textarea");
			area.value = text;
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			let ok = false;
			try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
			area.remove();
			return ok;
		}
	};

	MC.formatTime = function formatTime(seconds) {
		const value = Number(seconds) || 0;
		if (!value) return "";
		const date = new Date(value * 1000);
		const now = new Date();
		const diff = (now - date) / 1000;
		if (diff < 60) return "剛剛";
		if (date.toDateString() === now.toDateString()) {
			return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
		}
		if (diff < 86400 * 7) {
			return date.toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
		}
		return date.toLocaleDateString("zh-TW", { year: "2-digit", month: "2-digit", day: "2-digit" });
	};

	MC.formatDate = function formatDate(seconds) {
		const value = Number(seconds) || 0;
		if (!value) return "—";
		return new Date(value * 1000).toLocaleDateString("zh-TW", {
			year: "numeric", month: "2-digit", day: "2-digit",
		});
	};

	MC.initial = function initial(value) {
		const text = String(value || "?").trim();
		return (text[0] || "?").toUpperCase();
	};

	MC.api = async function api(path, options = {}) {
		const url = new URL(path, location.origin);
		for (const [name, value] of Object.entries(options.params || {})) {
			if (value !== undefined && value !== null && value !== "") {
				url.searchParams.set(name, value);
			}
		}

		const init = {
			method: options.method || "GET",
			headers: {},
			cache: "no-store",
			credentials: "same-origin",
		};

		if (options.body !== undefined) {
			init.headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(options.body);
		}

		const response = await fetch(url.toString(), init);
		let data = {};
		try { data = await response.json(); } catch (_) { data = {}; }

		if (!response.ok) {
			const error = new Error(data.error || ("HTTP " + response.status));
			error.status = response.status;
			error.data = data;
			throw error;
		}
		return data;
	};

	/** 需要登入的頁面呼叫：沒登入就回登入頁 */
	MC.requireUser = async function requireUser() {
		const me = await MC.api("/api/me");
		if (!me || !me.user) {
			location.replace("/");
			throw new Error("Unauthorized");
		}
		return me;
	};

	MC.setBusy = function setBusy(button, busy, label) {
		if (!button) return;
		if (busy) {
			button.dataset.original = button.innerHTML;
			button.disabled = true;
			button.innerHTML = '<span class="spinner"></span><span>' + MC.esc(label || "處理中…") + "</span>";
		} else {
			button.disabled = false;
			if (button.dataset.original) button.innerHTML = button.dataset.original;
		}
	};

	window.MC = MC;
})();
