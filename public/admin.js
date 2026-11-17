(() => {
	"use strict";

	const { $, esc, api, toast, copy, formatDate, setBusy } = window.MC;

	const state = {
		user: null,
		users: [],
		mailboxes: [],
		domains: [],
		filter: "",
		loading: false,
	};

	function ownerOptions(selected) {
		const options = ['<option value="">— 未分配 —</option>'];
		for (const user of state.users) {
			const label = user.role === "admin" ? `${user.email}（管理員）` : user.email;
			options.push(
				`<option value="${esc(user.id)}" ${user.id === selected ? "selected" : ""}>${esc(label)}</option>`
			);
		}
		return options.join("");
	}

	function userEmail(id) {
		const user = state.users.find((item) => item.id === id);
		return user ? user.email : "";
	}

	function renderSelects() {
		const domainSelect = $("newMailboxDomain");
		domainSelect.innerHTML = state.domains.length
			? state.domains.map((domain) => `<option value="${esc(domain)}">@${esc(domain)}</option>`).join("")
			: '<option value="">（尚未設定 domain）</option>';

		const ownerSelect = $("newMailboxOwner");
		const previous = ownerSelect.value;
		ownerSelect.innerHTML = ownerOptions(previous);
	}

	function renderUsers() {
		const body = $("usersBody");
		$("usersCount").textContent = `${state.users.length} 個`;

		if (!state.users.length) {
			body.innerHTML = '<tr><td colspan="5" class="muted">還沒有使用者，先用上面的表單建立一個。</td></tr>';
			return;
		}

		body.innerHTML = state.users.map((user) => `
			<tr>
				<td><span class="mono">${esc(user.email)}</span></td>
				<td><span class="badge ${user.role === "admin" ? "admin" : ""}">${user.role === "admin" ? "管理員" : "使用者"}</span></td>
				<td>${Number(user.mailbox_count) || 0}</td>
				<td class="muted">${esc(formatDate(user.created_at))}</td>
				<td>
					<div class="row-actions">
						<button class="btn btn-ghost btn-sm" data-action="reset-password" data-id="${esc(user.id)}" data-email="${esc(user.email)}">重設密碼</button>
						${user.id === state.user.id ? "" : `<button class="btn btn-danger btn-sm" data-action="delete-user" data-id="${esc(user.id)}" data-email="${esc(user.email)}">刪除</button>`}
					</div>
				</td>
			</tr>`).join("");
	}

	function renderMailboxes() {
		const body = $("mailboxesBody");
		const filter = state.filter.trim().toLowerCase();

		const list = state.mailboxes.filter((mailbox) => {
			if (!filter) return true;
			return [mailbox.email, userEmail(mailbox.user_id)]
				.filter(Boolean)
				.join(" ")
				.toLowerCase()
				.includes(filter);
		});

		$("mailboxesCount").textContent = filter
			? `${list.length} / ${state.mailboxes.length} 個`
			: `${state.mailboxes.length} 個`;

		if (!list.length) {
			body.innerHTML = `<tr><td colspan="5" class="muted">${state.mailboxes.length ? "沒有符合搜尋的地址" : "還沒有地址，用上面的表單產生一個。"}</td></tr>`;
			return;
		}

		body.innerHTML = list.map((mailbox) => `
			<tr>
				<td><span class="mono">${esc(mailbox.email)}</span></td>
				<td>
					<select class="assign" data-action="assign" data-id="${esc(mailbox.id)}">
						${ownerOptions(mailbox.user_id || "")}
					</select>
				</td>
				<td>${Number(mailbox.mail_count) || 0}</td>
				<td class="muted">${esc(formatDate(mailbox.created_at))}</td>
				<td>
					<div class="row-actions">
						<button class="btn btn-ghost btn-sm" data-action="copy" data-address="${esc(mailbox.email)}">複製</button>
						<button class="btn btn-danger btn-sm" data-action="delete-mailbox" data-id="${esc(mailbox.id)}" data-address="${esc(mailbox.email)}">刪除</button>
					</div>
				</td>
			</tr>`).join("");
	}

	async function load() {
		if (state.loading) return;
		state.loading = true;
		try {
			const data = await api("/api/admin/overview");
			state.users = Array.isArray(data.users) ? data.users : [];
			state.mailboxes = Array.isArray(data.mailboxes) ? data.mailboxes : [];
			state.domains = Array.isArray(data.domains) ? data.domains : [];
			renderSelects();
			renderUsers();
			renderMailboxes();
		} catch (error) {
			if (error.status === 401) return location.replace("/");
			if (error.status === 403) return location.replace("/inbox.html");
			toast("載入失敗：" + error.message);
		} finally {
			state.loading = false;
		}
	}

	/* ---------------- 建立使用者 ---------------- */

	$("newUserForm").addEventListener("submit", async (event) => {
		event.preventDefault();

		const email = $("newUserEmail").value.trim();
		const password = $("newUserPassword").value;
		if (!email || password.length < 6) {
			return toast("請填帳號，密碼至少 6 位");
		}

		const button = $("createUserBtn");
		setBusy(button, true, "建立中…");

		try {
			await api("/api/admin/users", { method: "POST", body: { email, password } });
			$("newUserEmail").value = "";
			$("newUserPassword").value = "";
			toast("帳號已建立");
			await load();
		} catch (error) {
			toast(error.message);
		} finally {
			setBusy(button, false);
		}
	});

	/* ---------------- 產生地址 ---------------- */

	$("newMailboxForm").addEventListener("submit", async (event) => {
		event.preventDefault();

		const prefix = $("newMailboxPrefix").value.trim();
		const domain = $("newMailboxDomain").value;
		const userId = $("newMailboxOwner").value;

		if (!domain) return toast("後端尚未設定 domain");

		const button = $("createMailboxBtn");
		setBusy(button, true, "產生中…");

		try {
			const data = await api("/api/admin/mailboxes", {
				method: "POST",
				body: { prefix: prefix || undefined, domain, user_id: userId || null },
			});
			$("newMailboxPrefix").value = "";
			toast("已產生 " + data.mailbox.email);
			await load();
		} catch (error) {
			toast(error.message);
		} finally {
			setBusy(button, false);
		}
	});

	/* ---------------- 表格操作（事件委派） ---------------- */

	$("mailboxesBody").addEventListener("click", async (event) => {
		const button = event.target.closest("button[data-action]");
		if (!button) return;

		const action = button.dataset.action;

		if (action === "copy") {
			const ok = await copy(button.dataset.address);
			return toast(ok ? "地址已複製" : "複製失敗");
		}

		if (action === "delete-mailbox") {
			if (!confirm(`刪除地址 ${button.dataset.address}？\n底下的信件也會一併刪除。`)) return;
			try {
				await api("/api/admin/mailboxes", { method: "DELETE", params: { id: button.dataset.id } });
				toast("已刪除");
				await load();
			} catch (error) {
				toast(error.message);
			}
		}
	});

	$("mailboxesBody").addEventListener("change", async (event) => {
		const select = event.target.closest("select[data-action='assign']");
		if (!select) return;

		try {
			await api("/api/admin/mailboxes", {
				method: "PATCH",
				body: { id: select.dataset.id, user_id: select.value || null },
			});
			toast(select.value ? "已分配給使用者" : "已設為未分配");
			await load();
		} catch (error) {
			toast(error.message);
			await load();
		}
	});

	$("usersBody").addEventListener("click", async (event) => {
		const button = event.target.closest("button[data-action]");
		if (!button) return;

		if (button.dataset.action === "reset-password") {
			const password = prompt(`為 ${button.dataset.email} 設定新密碼（至少 6 位）：`);
			if (password === null) return;
			if (password.length < 6) return toast("密碼至少 6 位");

			try {
				await api("/api/admin/users", {
					method: "PATCH",
					body: { id: button.dataset.id, password },
				});
				toast("密碼已更新，該使用者的舊登入已失效");
			} catch (error) {
				toast(error.message);
			}
			return;
		}

		if (button.dataset.action === "delete-user") {
			if (!confirm(`刪除使用者 ${button.dataset.email}？\n他名下的地址會變成「未分配」，信不會被刪。`)) return;
			try {
				await api("/api/admin/users", { method: "DELETE", params: { id: button.dataset.id } });
				toast("使用者已刪除");
				await load();
			} catch (error) {
				toast(error.message);
			}
		}
	});

	$("mailboxSearch").addEventListener("input", (event) => {
		state.filter = event.target.value;
		renderMailboxes();
	});

	$("refreshBtn").addEventListener("click", () => load());

	$("logoutBtn").addEventListener("click", async () => {
		try { await api("/api/logout", { method: "POST" }); } catch (_) { /* ignore */ }
		location.replace("/");
	});

	/* ---------------- 啟動 ---------------- */

	(async () => {
		const me = await window.MC.requireUser();
		if (me.user.role !== "admin") return location.replace("/inbox.html");

		state.user = me.user;
		$("adminEmail").textContent = me.user.email;
		await load();
	})();
})();
