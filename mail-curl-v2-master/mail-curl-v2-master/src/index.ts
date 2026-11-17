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
  forwardMailStorageToWebhook,
  createWebhookAuthMiddleware,
  getWebhookTimeoutMs
} from "./webhook";
import { isAllowedDomain, isInternalEmail, getEnvDomains } from "./domain-utils";

// 多域名轮询索引
let domainIndex = 0;

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method;

		// 根目錄
		if (path === "/") {
			return new Response("made by yoyo qwq", { status: 200 });
		}

		// API 路由
		if (path.startsWith("/api/")) {
			// 檢查 JWT_KEY
			const authHeader = request.headers.get("Authorization");
			const providedKey = authHeader?.replace("Bearer ", "") || url.searchParams.get("key");

			if (!providedKey) {
				return new Response(JSON.stringify({ error: "Missing key" }), {
					status: 401,
					headers: { "Content-Type": "application/json" }
			});
		}

			// /api/remail - 刷新郵箱
			if (path === "/api/remail" && method === "POST") {
				return await handleRemail(
					env, 
					url.searchParams.get("word") || undefined,
					url.searchParams.get("birthday") || undefined
				);
			}

			// /api/inbox - 查看收件箱
			if (path === "/api/inbox" && method === "GET") {
				const mailboxId = url.searchParams.get("mailbox_id");
				if (!mailboxId) {
					return new Response(JSON.stringify({ error: "Missing mailbox_id" }), {
						status: 400,
						headers: { "Content-Type": "application/json" }
					});
				}
				return await handleInbox(env, mailboxId);
			}

			// /api/mail - 查看郵件內容
			if (path === "/api/mail" && method === "GET") {
				const mailId = url.searchParams.get("id");
				if (!mailId) {
					return new Response(JSON.stringify({ error: "Missing mail id" }), {
						status: 400,
						headers: { "Content-Type": "application/json" }
					});
				}
				return await handleGetMail(env, mailId);
			}

			// /api/ls - 查看所有郵箱
			if (path === "/api/ls" && method === "GET") {
				return await handleListMailboxes(env);
			}

			// Webhook 管理路由
			if (path === "/api/webhook/status" && method === "GET") {
				return await handleWebhookStatus(env);
			}
		}

		return new Response("Not Found", { status: 404 });
	},

	/**
	 * 處理收到的郵件 (Cloudflare Email Routing)
	 */
	async email(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
		await handleIncomingEmail(message, env);
	},
} satisfies ExportedHandler<Env, unknown, unknown, { emailMessage: EmailMessage }>;

interface Env {
	DB: D1Database;
	JWT_KEY: string;
	domain: string;  // 支持多域名，逗號分隔，如 domain1.com,domain2.com
	MAIL_PREFIX?: string;  // 郵箱前綴 (未設置時使用隨機人名)
	WEBHOOK_URL?: string;  // Webhook 基礎地址
	WEBHOOK_SECRET?: string;  // Webhook 鑑權密鑰
	WEBHOOK_TIMEOUT_MS?: string;  // Webhook 請求超時（毫秒）
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
 * 處理 /api/remail - 刷新郵箱
 * 創建郵箱後，如果啟用了 Webhook，會發送郵箱創建事件
 */
async function handleRemail(env: Env, word?: string, birthday?: string): Promise<Response> {
	const prefix = generatePrefix(env.MAIL_PREFIX, word, birthday);
	// 獲取域名 (支持多域名)
	const domain = getDomain(env.domain);
	const email = `${prefix}@${domain}`;
	const mailboxId = generateMailboxId();

	try {
		await env.DB.prepare(
			"INSERT INTO mailboxes (id, email, prefix) VALUES (?, ?, ?)"
		).bind(mailboxId, email, prefix).run();

		// 如果啟用了 Webhook，發送郵箱創建事件
		try {
			if (isWebhookEnabled(env)) {
				await forwardMailboxCreationToWebhook(email, prefix, mailboxId, env);
			}
		} catch (webhookError) {
			console.error('[Webhook] 發送郵箱創建事件失敗:', webhookError);
			// Webhook 失敗不影響主流程
		}

		return new Response(JSON.stringify({
			email: email,
			id: mailboxId
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ error: e.message }), {
			status: 500,
			headers: { "Content-Type": "application/json" }
		});
	}
}

/**
 * 處理 /api/inbox - 查看收件箱
 */
async function handleInbox(env: Env, mailboxId: string): Promise<Response> {
	try {
		// 驗證郵箱是否存在
		const mailbox = await env.DB.prepare(
			"SELECT id FROM mailboxes WHERE id = ?"
		).bind(mailboxId).first();

		if (!mailbox) {
			return new Response(JSON.stringify({ error: "Mailbox not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" }
			});
		}

		// 獲取該郵箱的所有郵件
		const mails = await env.DB.prepare(
			"SELECT sender_name, id FROM mails WHERE mailbox_id = ? ORDER BY created_at DESC"
		).bind(mailboxId).all();

		const result = (mails.results || []).map((mail: any) => ({
			sender_name: mail.sender_name,
			mail_id: mail.id
		}));

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ error: e.message }), {
			status: 500,
			headers: { "Content-Type": "application/json" }
		});
	}
}

/**
 * 處理 /api/mail - 查看郵件內容
 */
async function handleGetMail(env: Env, mailId: string): Promise<Response> {
	try {
		const mail = await env.DB.prepare(
			"SELECT * FROM mails WHERE id = ?"
		).bind(mailId).first();

		if (!mail) {
			return new Response(JSON.stringify({ error: "Mail not found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" }
			});
		}

		return new Response(JSON.stringify({
			id: mail.id,
			mailbox_id: mail.mailbox_id,
			sender_name: mail.sender_name,
			content: mail.content,
			created_at: mail.created_at
		}), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ error: e.message }), {
			status: 500,
			headers: { "Content-Type": "application/json" }
		});
	}
}

/**
 * 處理 /api/ls - 查看所有郵箱
 */
async function handleListMailboxes(env: Env): Promise<Response> {
	try {
		const mailboxes = await env.DB.prepare(
			"SELECT email, id FROM mailboxes ORDER BY created_at DESC"
		).all();

		const result = (mailboxes.results || []).map((mb: any) => ({
			email: mb.email,
			id: mb.id
		}));

		return new Response(JSON.stringify(result), {
			status: 200,
			headers: { "Content-Type": "application/json" }
		});
	} catch (e: any) {
		return new Response(JSON.stringify({ error: e.message }), {
			status: 500,
			headers: { "Content-Type": "application/json" }
		});
	}
}

/**
 * 處理收到的郵件 (Cloudflare Email Routing)
 * 解析郵件並存儲到 D1
 * 同時根據配置轉發到 Webhook
 */
async function handleIncomingEmail(message: EmailMessage, env: Env): Promise<void> {
	// 首先解析郵件內容
	let textContent = "";
	let htmlContent = "";
	let subject = "";
	let fromAddress = "unknown";
	let toAddress = "unknown";
	let fromDomain = "";

		try {
			// 獲取 headers
			const headers = (message as any)?.headers || {};
			fromAddress = headers?.get?.("from") || (message as any)?.from || "unknown";
			toAddress = headers?.get?.("to") || (message as any)?.to || "unknown";

			// 提取發件人域名 (用於日誌和檢查)
			const fromEmailMatch = String(fromAddress).match(/[a-zA-Z0-9._-]+@([a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+)/);
			if (fromEmailMatch) {
				fromDomain = fromEmailMatch[1].toLowerCase();
			}

			// 提取郵箱前綴
			const atIndex = toAddress.indexOf("@");
			const prefix = atIndex > 0 ? toAddress.substring(0, atIndex) : "";

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

			// 讀取並解析郵件內容
		try {
			// 獲取 raw 郵件流
			const rawStream = (message as any)?.raw;
			if (rawStream) {
				// 將 ReadableStream 轉為字符串
				const reader = rawStream.getReader();
				const chunks: Uint8Array[] = [];
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					chunks.push(value);
				}
				const rawBytes = new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0));
				let offset = 0;
				for (const chunk of chunks) {
					rawBytes.set(chunk, offset);
					offset += chunk.length;
				}
				const rawText = new TextDecoder().decode(rawBytes);

				// 使用 postal-mime 解析
				const parser = PostalMime;
				const parsed = await parser.parse(rawText);

				subject = parsed.subject || "";
				textContent = parsed.text || "";
				htmlContent = parsed.html || "";
			}
		} catch (e: any) {
			console.error("Error parsing email:", e.message);
		}

		// 組裝郵件內容
		const mailContent = JSON.stringify({
			subject: subject,
			text: textContent,
			html: htmlContent
		});

		console.log(`Processing email: ${fromAddress} -> ${toAddress}`);

		// 嘗試根據前綴找到對應的郵箱
		let mailbox = await env.DB.prepare(
			"SELECT id FROM mailboxes WHERE prefix = ? OR email = ?"
		).bind(prefix, toAddress).first();

		// 如果找不到，自動創建一個郵箱
		if (!mailbox) {
			const newMailboxId = generateMailboxId();
			await env.DB.prepare(
				"INSERT INTO mailboxes (id, email, prefix) VALUES (?, ?, ?)"
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

		console.log(`Email stored: ${fromAddress} -> ${toAddress}, mail_id: ${mailId}`);

		// 如果啟用了 Webhook，發送郵件存儲事件
		try {
			if (isWebhookEnabled(env)) {
				await forwardMailStorageToWebhook(mailId, String(mailbox.id), fromAddress, subject, textContent, env);
			}
		} catch (webhookError) {
			console.error('[Webhook] 發送郵件存儲事件失敗:', webhookError);
			// Webhook 失敗不影響主流程
		}

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
