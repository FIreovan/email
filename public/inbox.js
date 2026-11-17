(() => {
	"use strict";

	const { $, esc, api, toast, copy, formatTime, initial } = window.MC;

	const POLL_MS = 4000;
	const LS_READ = "mailcurl.read.";
	const LS_LAST = "mailcurl.lastMailbox.";

	const state = {
		user: null,
		mailboxes: [],
		mailbox: null,
		mails: [],
		filter: "",
		selectedId: "",
		selectedMail: null,
		view: "text",
		loading: false,
		timer: 0,
		readIds: new Set(),
	};

	function readIdsKey() {
		return LS_READ + (state.mailbox ? state.mailbox.id : "none");
	}

	function loadReadIds() {
		try {
			const raw = localStorage.getItem(readIdsKey());
			const list = raw ? JSON.parse(raw) : [];
			state.readIds = new Set(Array.isArray(list) ? list : []);
		} catch (_) {
			state.readIds = new Set();
		}
	}

	function saveReadIds() {
		try {
			localStorage.setItem(readIdsKey(), JSON.stringify(Array.from(state.readIds).slice(-400)));
		} catch (_) { /* ignore */ }
	}

	function updateAddressUI() {
		const address = state.mailbox ? state.mailbox.email : "";
		$("accountEmail").textContent = address || "尚未分配信箱";
		$("accountAvatar").textContent = initial(address || "?");
		$("accountChip").disabled = !address;
	}

	function renderMailboxNav() {
		const nav = $("mailboxNav");
		if (!state.mailboxes.length) {
			nav.innerHTML = '<div class="side-card" style="margin-top:0">管理員還沒有分配信箱給你。</div>';
			return;
		}
		nav.innerHTML = state.mailboxes.map((mailbox) => `
			<button class="nav-item ${state.mailbox && mailbox.id === state.mailbox.id ? "active" : ""}" data-mailbox="${esc(mailbox.id)}" title="${esc(mailbox.email)}">
				<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M4 5h16v14H4z"></path><path d="m4 7 8 6 8-6"></path>
				</svg>
				<span class="label">${esc(mailbox.email)}</span>
			</button>`).join("");

		nav.querySelectorAll("[data-mailbox]").forEach((button) => {
			button.addEventListener("click", () => selectMailbox(button.dataset.mailbox));
		});
	}

	function showNoMailbox() {
		$("mailList").innerHTML = `
			<div class="empty">
				<div class="big">📮</div>
				管理員還沒有分配收信地址給你<br />
				請聯絡管理員在後台建立並分配
			</div>`;
		$("listStatus").textContent = "";
		$("inboxCount") && ($("inboxCount").textContent = "0");
		updateAddressUI();
	}

	async function selectMailbox(mailboxId) {
		const mailbox = state.mailboxes.find((item) => item.id === mailboxId);
		if (!mailbox) return;

		state.mailbox = mailbox;
		state.selectedId = "";
		state.selectedMail = null;
		state.mails = [];
		state.filter = "";
		$("searchInput").value = "";

		localStorage.setItem(LS_LAST + state.user.id, mailbox.id);
		loadReadIds();
		renderMailboxNav();
		updateAddressUI();
		renderList();
		renderReader();
		await refresh({ silent: true });
	}

	async function refresh(options = {}) {
		if (!state.mailbox || state.loading) return;
		state.loading = true;

		try {
			const data = await api("/api/inbox", { params: { mailbox_id: state.mailbox.id } });
			const mails = Array.isArray(data.mails) ? data.mails : [];
			const previousTop = state.mails[0] ? state.mails[0].mail_id : "";

			state.mails = mails;
			if (data.mailbox && data.mailbox.email) {
				state.mailbox.email = data.mailbox.email;
				updateAddressUI();
			}

			if (previousTop && mails[0] && mails[0].mail_id !== previousTop) {
				toast("收到新郵件");
			}

			renderList();
			$("listStatus").textContent = "已更新 " + new Date().toLocaleTimeString("zh-TW", {
				hour: "2-digit", minute: "2-digit", second: "2-digit",
			});

			if (state.selectedId && !mails.some((mail) => mail.mail_id === state.selectedId)) {
				state.selectedId = "";
				state.selectedMail = null;
				renderReader();
			}
		} catch (error) {
			if (error.status === 401) {
				location.replace("/");
				return;
			}
			if (error.status === 404 && error.data && error.data.code === "no_mailbox") {
				state.mailbox = null;
				showNoMailbox();
			} else if (!options.silent) {
				toast("更新失敗：" + error.message);
			}
		} finally {
			state.loading = false;
		}
	}

	function visibleMails() {
		const filter = state.filter.trim().toLowerCase();
		if (!filter) return state.mails;
		return state.mails.filter((mail) => {
			return [mail.sender_name, mail.subject, mail.preview, mail.code]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()
				.includes(filter);
		});
	}

	function renderList() {
		const list = $("mailList");
		if (!state.mailbox) return;

		const mails = visibleMails();

		if (!mails.length) {
			list.innerHTML = `
				<div class="empty">
					<div class="big">📭</div>
					${state.filter ? "沒有符合搜尋的郵件" : "收件匣是空的<br />把上面的地址拿去註冊，信就會出現在這裡"}
				</div>`;
			return;
		}

		list.innerHTML = mails.map((mail) => {
			const unread = !state.readIds.has(mail.mail_id);
			return `
				<button class="mail-row ${unread ? "unread" : ""} ${mail.mail_id === state.selectedId ? "active" : ""}" data-id="${esc(mail.mail_id)}">
					<div class="avatar">${esc(initial(mail.sender_name))}</div>
					<div style="min-width:0">
						<div class="who">${esc(mail.sender_name || "未知寄件人")}</div>
						<div class="subject-line">${esc(mail.subject || "(無主題)")}</div>
						<div class="preview">${esc(mail.preview || "—")}</div>
						${mail.code ? `<span class="code-badge">🔑 ${esc(mail.code)}</span>` : ""}
					</div>
					<div class="when">${esc(formatTime(mail.created_at))}</div>
				</button>`;
		}).join("");

		list.querySelectorAll(".mail-row").forEach((row) => {
			row.addEventListener("click", () => openMail(row.dataset.id));
		});
	}

	async function openMail(mailId) {
		state.selectedId = mailId;
		state.view = "text";
		renderList();
		$("readerBody").innerHTML = '<div class="empty">載入中…</div>';
		$("readerPane").classList.add("open");

		try {
			const mail = await api("/api/mail", { params: { id: mailId } });
			state.selectedMail = mail;
			state.readIds.add(mailId);
			saveReadIds();
			renderReader();
			renderList();
		} catch (error) {
			$("readerBody").innerHTML = `<div class="empty">讀取失敗：${esc(error.message)}</div>`;
		}
	}

	function renderReader() {
		const body = $("readerBody");
		const mail = state.selectedMail;
		const toggle = $("viewToggle");
		const copyCode = $("copyMailCodeBtn");

		if (!mail || !state.selectedId) {
			body.innerHTML = '<div class="empty"><div class="big">📬</div>選一封信來閱讀</div>';
			toggle.classList.add("hidden");
			copyCode.classList.add("hidden");
			return;
		}

		toggle.classList.toggle("hidden", !mail.html);
		copyCode.classList.toggle("hidden", !mail.code);
		toggle.querySelectorAll("button").forEach((button) => {
			button.classList.toggle("on", button.dataset.view === state.view);
		});

		const codePanel = mail.code ? `
			<div class="code-panel">
				<div>
					<div class="label">偵測到的驗證碼</div>
					<div class="value">${esc(mail.code)}</div>
				</div>
				<button class="btn btn-primary" data-copy-code>複製</button>
			</div>` : "";

		let content;
		if (state.view === "html" && mail.html) {
			content = '<iframe class="mail-html" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>';
		} else {
			const text = mail.text || (mail.html ? "（此郵件只有 HTML 內容，請切換到 HTML 檢視）" : "（無內容）");
			content = `<div class="reader-text">${esc(text)}</div>`;
		}

		body.innerHTML = `
			<h2 class="reader-subject">${esc(mail.subject || "(無主題)")}</h2>
			<div class="sender-line">
				<div class="avatar">${esc(initial(mail.sender_name))}</div>
				<div>
					<div class="name">${esc(mail.sender_name || "未知寄件人")}</div>
					<div class="addr">寄給 ${esc(state.mailbox ? state.mailbox.email : "")}</div>
				</div>
				<div class="time">${esc(formatTime(mail.created_at))}</div>
			</div>
			${codePanel}
			${content}`;

		if (state.view === "html" && mail.html) {
			const frame = body.querySelector("iframe.mail-html");
			if (frame) frame.srcdoc = mail.html;
		}

		const button = body.querySelector("[data-copy-code]");
		if (button) {
			button.addEventListener("click", async () => {
				const ok = await copy(mail.code);
				toast(ok ? "驗證碼已複製" : "複製失敗，請手動選取");
			});
		}

		body.scrollTop = 0;
	}

	function startPolling() {
		stopPolling();
		state.timer = setInterval(() => {
			if (document.visibilityState === "visible") refresh({ silent: true });
		}, POLL_MS);
	}

	function stopPolling() {
		if (state.timer) clearInterval(state.timer);
		state.timer = 0;
	}

	/* ---------------- 事件 ---------------- */

	$("copyAddressBtn").addEventListener("click", async () => {
		if (!state.mailbox) return toast("目前沒有信箱");
		const ok = await copy(state.mailbox.email);
		toast(ok ? "地址已複製" : "複製失敗");
	});

	$("accountChip").addEventListener("click", async () => {
		if (!state.mailbox) return;
		const ok = await copy(state.mailbox.email);
		toast(ok ? "地址已複製" : "複製失敗");
	});

	$("refreshBtn").addEventListener("click", () => refresh());

	$("logoutBtn").addEventListener("click", async () => {
		try {
			await api("/api/logout", { method: "POST" });
		} catch (_) { /* ignore */ }
		location.replace("/");
	});

	$("searchInput").addEventListener("input", (event) => {
		state.filter = event.target.value;
		renderList();
	});

	$("backBtn").addEventListener("click", () => {
		$("readerPane").classList.remove("open");
	});

	$("viewToggle").addEventListener("click", (event) => {
		const button = event.target.closest("button[data-view]");
		if (!button) return;
		state.view = button.dataset.view;
		renderReader();
	});

	$("copyMailCodeBtn").addEventListener("click", async () => {
		const code = state.selectedMail && state.selectedMail.code;
		const ok = await copy(code);
		toast(ok ? "驗證碼已複製" : "沒有可複製的驗證碼");
	});

	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible" && state.mailbox) refresh({ silent: true });
	});

	/* ---------------- 啟動 ---------------- */

	(async () => {
		const me = await window.MC.requireUser();
		state.user = me.user;
		state.mailboxes = Array.isArray(me.mailboxes) ? me.mailboxes : [];

		$("userEmail").textContent = me.user.email;
		$("adminLink").classList.toggle("hidden", me.user.role !== "admin");

		renderMailboxNav();

		if (!state.mailboxes.length) {
			showNoMailbox();
			return;
		}

		const lastId = localStorage.getItem(LS_LAST + me.user.id);
		const target = state.mailboxes.find((mailbox) => mailbox.id === lastId) || state.mailboxes[0];
		await selectMailbox(target.id);
		startPolling();
	})();
})();
