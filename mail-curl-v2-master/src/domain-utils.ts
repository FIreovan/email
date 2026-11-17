/**
 * 域名工具函數庫
 * 支持泛域名匹配 (wildcard domain matching)
 * 
 * 例如:
 *   domain = "example.com"
 *   user@sub.example.com → 匹配到 example.com (泛域名)
 *   user@example.com → 精確匹配
 */

export interface DomainEnv {
	domain?: string;
}

/**
 * 域名规范化：去除空格、轉小寫、移除首尾的點
 */
export function normalizeDomain(domain: string | undefined | null): string {
	if (!domain || typeof domain !== 'string') {
		return '';
	}
	return domain.trim().toLowerCase().replace(/^\.+|\.+$/g, '');
}

/**
 * 從環境變數獲取域名列表
 * 支持字串 "domain1.com,domain2.com" 或數組 ["domain1.com", "domain2.com"]
 */
export function getEnvDomains(domainList: any): string[] {
	if (!domainList) {
		return [];
	}
	
	// 如果是字串，尝试解析为数组 (兼容旧格式 JSON 數組字串)
	if (typeof domainList === 'string') {
		try {
			// 先尝试解析为 JSON 数组
			const parsed = JSON.parse(domainList);
			if (Array.isArray(parsed)) {
				domainList = parsed;
			} else {
				// 如果不是数组，當作逗號分隔的字符串處理
				domainList = domainList.split(',');
			}
		} catch (error) {
			// JSON 解析失敗，當作逗號分隔的字符串處理
			domainList = domainList.split(',');
		}
	}
	
	if (!Array.isArray(domainList)) {
		return [];
	}
	
	return domainList
		.map((item: any) => normalizeDomain(item))
		.filter(Boolean);
}

/**
 * 查找匹配的根域名
 * 支援泛域名匹配 (sub.example.com 匹配 example.com)
 * 
 * @param domain 要檢查的域名 (如 "sub.example.com")
 * @param allowDomains 允許的域名列表 (如 ["example.com"])
 * @returns 匹配到的根域名，或 null
 */
export function findMatchedDomain(domain: string | undefined, allowDomains: any = []): string | null {
	const curDomain = normalizeDomain(domain);
	if (!curDomain) return null;
	
	const roots = getEnvDomains(allowDomains).sort((a, b) => b.length - a.length);
	
	for (const root of roots) {
		// 精確匹配
		if (curDomain === root) {
			return root;
		}
		// 泛域名匹配: sub.example.com 匹配 example.com
		if (curDomain.endsWith(`.${root}`)) {
			return root;
		}
	}
	
	return null;
}

/**
 * 檢查域名是否在允許列表中
 * @returns boolean
 */
export function isAllowedDomain(domain: string | undefined, allowDomains: any = []): boolean {
	return !!findMatchedDomain(domain, allowDomains);
}

/**
 * 檢查是否為內部郵箱 (同域名體系)
 * @param email 郵箱地址 (如 "user@sub.example.com")
 * @param allowDomains 允許的域名列表
 * @returns boolean
 */
export function isInternalEmail(email: string | undefined, allowDomains: any = []): boolean {
	if (!email) return false;
	const domain = email.split('@')[1];
	return isAllowedDomain(domain, allowDomains);
}
