#!/usr/bin/env node
/**
 * 从 sites/*.html 抽取卡片数据，生成 data/sites.js（window.SITES_DATA）。
 *
 * 设计要点：
 *  1. HTML 页面本身即唯一数据源，index.html 不再内嵌任何单位数据；
 *  2. 输出完全确定性（不含时间戳），check.js 可逐字节比对以判断索引是否过期；
 *  3. 抽取失败的页面仍会生成最简卡片（保证站点不崩），并在结果中标记 warn。
 *
 * 用法：node tools/build.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const SITES_DIR_NAME = "sites";
const SITES_DIR = path.join(root, SITES_DIR_NAME);
const DATA_DIR = path.join(root, "data");
const OUT_FILE = path.join(DATA_DIR, "sites.js");
const THEME_FILE = path.join(DATA_DIR, "theme.json");

/** 保护级别 → 卡片与插画配色：[主色(用于缩略图渐变下段/描边), 深色(用于文字)] */
const LEVEL_COLORS = {
  "国保": ["#b02a20", "#611410"], // 朱红
  "省保": ["#c26a12", "#6b3806"], // 赭橙
  "市保": ["#a98211", "#4f3c06"]  // 沉黄
};

/** 未能判定级别时的兜底色板：每项为 [主色, 深色]，均已验证在米色底上可读 */
const PALETTE = [
  ["#c9a227", "#7d6412"], // 城墙金
  ["#a03a2c", "#5c1712"], // 宫墙朱
  ["#c96a26", "#7d3d13"], // 书院橙
  ["#4f7a4a", "#2b4a2c"], // 松柏绿
  ["#3f6b7d", "#23414f"], // 黛瓦青
  ["#7a4a6b", "#46293c"], // 紫檀
  ["#93323f", "#571b26"], // 绛红
  ["#8a6b3a", "#5a4320"]  // 秋香褐
];

/**
 * 插画关键词 → index.html 中 ART 的键。匹配顺序：
 *   1. ART_NAME  专名形制词，只信 rec.name；
 *   2. ART_ALIAS 别名词，rec.name 命中不了时才允许看 rec.full 里的括注别名；
 *   3. ART_ROOF  屋顶形制词，近现代类别下跳过（否则「贵州省政法大楼」会被画成古楼阁）；
 *   4. ART_CATEGORY  类别兜底；
 *   5. 都未命中才按名称哈希轮换。
 * 强弱分层是必要的：「梁思成林徽因旧居」的「林」、「抗战胜利纪念堂（含…纪念碑）」的
 * 「碑」、「中共贵州省工委旧址（原称"高家花园"）」的「园」都只出现在名字或别名里，
 * 若不分层就会被误判成园林、碑墓。
 */
const ART_NAME = [
  [/墓|冢|碑/, "bei"],
  [/经幢|幢/, "pagoda"],
  [/塔/, "pagoda"],
  [/石窟|摩崖|石刻|千佛|造像|崖/, "shiku"],
  [/牌坊|牌楼|山坊|坊/, "paifang"],
  [/纪念门|牌门|辕门|仪门/, "paifang"],
  [/亭/, "ting"],
  [/桥/, "qiao"],
  [/城|垣|墙|关隘|堡|寨|炮台|遗址/, "xz"],
  [/园|圃|墅|园林/, "garden"],
  [/宅院|民居|公馆|旧居|故居|商号|老店|窖池|作坊|酒坊/, "minju"],
  [/厂房|厂|电站|泵房|水电|车间/, "gongchang"],
  [/精舍|会馆|书院|学宫|贡院|祠|庙|寺/, "cps"],
  [/道观|仙观|观$/, "cps"]
];
const ART_ALIAS = [
  [/石窟|摩崖|石刻|千佛/, "shiku"],
  [/宅院|民居|公馆|旧居|故居|商号|老店|窖池|作坊|酒坊/, "minju"]
];
const ART_ROOF = [
  [/楼|阁|宫|殿|堂|院/, "jxl"]
];
const ART_CATEGORY = [
  [/近现代/, "jindai"],
  [/石窟寺|石刻|摩崖/, "shiku"],
  [/古墓葬/, "bei"],
  [/古遗址|石城|城址/, "xz"],
  [/古建筑/, "cps"]
];
const ART_KEYS = ["xz", "jxl", "cps", "garden", "pagoda", "paifang", "qiao", "ting",
  "bei", "shiku", "minju", "jindai", "gongchang"];

const ERAS = [["商", "商代"], ["周", "周代"], ["秦", "秦代"], ["汉", "汉代"], ["三国", "三国"],
  ["晋", "晋代"], ["南北朝", "南北朝"], ["隋", "隋代"], ["唐", "唐代"], ["五代", "五代"],
  ["宋", "宋代"], ["辽", "辽代"], ["金", "金代"], ["元", "元代"], ["明", "明代"], ["清", "清代"],
  ["民国", "民国"]];

/* ------------------------------------------------------------------ */
/* 解析工具                                                            */
/* ------------------------------------------------------------------ */
const strip = (h) => h
  .replace(/<script[\s\S]*?<\/script>/g, "")
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<!--[\s\S]*?-->/g, "");

/** 抽取可见文本：标签本身不产生空格，避免「的 政治军事中心 ，」这类断裂 */
const text = (h) => strip(h)
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&#\d+;/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const pick = (h, re) => { const m = h.match(re); return m ? m[1] : ""; };

/** 去掉「（据…）」类出处标注与句末句号 */
const dropCite = (s) => String(s)
  .replace(/（\s*据[^）]*）/g, "")
  .replace(/（[^）]{0,40}?(19|20)\d{2}年[^）]*）/g, "")
  .replace(/[。；;]\s*$/, "")
  .replace(/\s+/g, " ")
  .trim();

/**
 * 修正括号配对。截断后常出现「…高5.4米（另一口径高3米…」这类半个括号，
 * 直接显示在卡片上很难看，这里统一处理：
 *   - 右侧多出右括号 → 删掉
 *   - 左侧有未闭合的左括号 → 从该括号处截断（保留已完整的前半句）
 */
function fixParens(s) {
  s = String(s);
  for (let i = 0; i < s.length; i++) {
    if ("）)".includes(s[i])) {
      s = s.slice(0, i) + s.slice(i + 1);
      i--;
    }
  }
  const open = s.search(/[（(]/);
  if (open > -1) s = s.slice(0, open).replace(/[，,、；;：:\s]+$/, "");
  return s.trim();
}

/** 按标点优先截断，max 为目标字数；截断点不会落在括号内部 */
function cut(s, max) {
  s = String(s).trim();
  if (s.length <= max) return s;
  const seg = s.slice(0, max + 6);
  const at = Math.max(seg.lastIndexOf("，"), seg.lastIndexOf("、"), seg.lastIndexOf("；"));
  const body = fixParens(at > max * 0.5 ? seg.slice(0, at) : seg.slice(0, max));
  return body + "…";
}

/** 去掉行首行尾的装饰性标点与序号（保留成对括号） */
const clean = (s) => {
  let t = String(s)
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, "")
    .replace(/^[（(]?\s*|\s*[）)]?$/g, "")
    .replace(/^[：:、,，]\s*|\s*[：:]$/g, "")
    .trim();
  // clean 的规则会把「（头佛）」的右括号单独去掉，这里补回配对
  const opens = (t.match(/[（(]/g) || []).length;
  const closes = (t.match(/[）)]/g) || []).length;
  if (opens > closes) t += "）".repeat(opens - closes);
  return t.trim();
};

/** 稳定字符串哈希（跨平台一致，保证配色分配可复现） */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

/**
 * 年号 → 起始西历年。仅在原文没给阿拉伯数字时使用（如「明万历年间改建」）。
 * 按朝代分组，同一年号名在不同朝代可能重名，故只收录本项目导览页中常见且无歧义的。
 */
const ERA_NAME_YEAR = {
  贞观: 627, 开元: 713, 天宝: 742, 大历: 766, 太和: 827, 大中: 847, 咸通: 860,
  至元: 1264, 大德: 1297, 洪武: 1368, 永乐: 1403, 景泰: 1450, 天顺: 1457,
  成化: 1465, 弘治: 1488, 正德: 1506, 嘉靖: 1522, 隆庆: 1567, 万历: 1573,
  天启: 1621, 崇祯: 1628, 顺治: 1644, 康熙: 1662, 雍正: 1723, 乾隆: 1736,
  嘉庆: 1796, 道光: 1821, 咸丰: 1851, 同治: 1862, 光绪: 1875, 宣统: 1909
};

/**
 * 营建动词表。只收确实描述「建造本体」的词；迁建、迁葬、重修、修缮、
 * 定级、公布一律不进表，避免把后世改易年当成始建年。
 */
const VERB = "始建于|创建于|营建|兴建|興建|建造|新建|落成|建成|竣工|动工|开工|开凿|凿成|刻成|安葬|葬于|而建|建祠|建街|开辟|所建|成立";

/** 命中这些词的句子直接跳过：讲的不是「始建」，或是原文自己说年代不详 */
const SKIP_CLAUSE = /不详|未见记载|无考|未能考定|迁葬|迁建|迁入|迁自|搬迁|迁至|修缮|重建|重修|改建|扩建|保护范围|定级|公布|揭牌|布展|陈列/;

/** 页面明确声明「始建年代不详」时的措辞 */
const UNKNOWN_YEAR = /不详|未见记载|无考|未能考定/;

/**
 * 表格里没有「始建」行时，从导语 / 历史沿革 / 其他单元格里找回始建年。
 * 三轮逐步放宽，且跳过 SKIP_CLAUSE 命中的句子：
 *   ① 年份在前、营建动词在后   「1926年11月7日……成立中国共产党云南特别支部」
 *   ② 动词在前、年份在后       「病逝安葬：1945年8月8日……」
 *   ③ 只给出朝代               「冠英街建于明代」
 * 返回整句与年份，交由上层统一算 year / era。
 */
function findBuildSentence(sources) {
  const clauses = [];
  for (const s of sources) {
    if (!s) continue;
    for (const c of splitClauses(s)) if (c && !SKIP_CLAUSE.test(c)) clauses.push(c);
  }
  for (const re of [
    new RegExp("(\\d{4})年(?:\\d{1,2}月(?:\\d{1,2}日)?)?[^。；]{0,28}?(?:" + VERB + ")"),
    new RegExp("(?:" + VERB + ")[^。；]{0,12}?(\\d{4})年"),
    // 朝代必须带「代」等后缀，否则「葬于昆明松花坝」里的「明」会被当成明代
    new RegExp("(?:" + VERB + ")[^。；]{0,10}?(" + DYNASTY_WORDS.source.slice(1, -1) + ")")
  ]) {
    for (const c of clauses) {
      const m = c.match(re);
      if (!m) continue;
      return { sentence: c, year: /^\d{4}$/.test(m[1]) ? Number(m[1]) : 0, dynasty: /^\d{4}$/.test(m[1]) ? "" : m[1] };
    }
  }
  return null;
}

/**
 * 从一段文字里取始建年份。按「可靠性」而非「出现顺序」匹配：
 *   1. 括注西历年    「唐太和三年（829年，南诏保和六年）」 → 829
 *   2. 年份区间起点  「唐南诏国时期（738—902年）」        → 738
 *   3. 带「年」的数字  「1936年3月筹建」                  → 1936
 *   4. 世纪          「建于12世纪」                      → 1100
 *   5. 年号          「明万历年间改建」                  → 1573
 *   6. 朝代起始年    「唐代至宋代凿刻」                  → 618
 * 之所以不直接取全文第一个年份：同一句里常混入重修/迁建年
 * （「唐大中八年（854年）始建…清光绪八年（1882）按原样重建」），需优先采信括注的始建年。
 * 返回 src（命中的原文片段），供调用方挑出与之对应的年代短句。
 */
const DYNASTY = [[/南诏|大理/, 937], [/三国/, 220], [/南北朝/, 420], [/隋/, 581],
  [/唐/, 618], [/五代/, 907], [/南宋/, 1127], [/宋/, 960], [/辽/, 916], [/金/, 1115],
  [/元/, 1271], [/明/, 1368], [/清/, 1644], [/民国/, 1912], [/近代/, 1840]];

/**
 * 正文里出现的朝代词。必须带「代」等后缀：光秃秃一个「明」字会命中
 * 「昆明松花坝」这类地名，把元代衣冠冢误判成明代。
 */
const DYNASTY_WORDS = /商代|周代|秦代|汉代|晋代|南北朝|隋代|唐代|五代|宋代|辽代|金代|元代|明代|清代|民国时期|民国|近代/;

function parseYearHit(s) {
  if (!s) return { y: 0, src: "" };
  const str = String(s);
  // 1) 括注西历年：跳过「（另有口径1944年动工）」「（1945年前后）」这类非始建括注
  for (const pm of str.matchAll(/[(（]([^()（）]{0,40})[)）]/g)) {
    const inner = pm[1];
    if (/(动工|重修|迁|重建|扩建|另[有据口]|前[后]|至今|迄今|另有|据说|相传|初|改)/.test(inner)) continue;
    const y = inner.match(/^[^0-9]{0,12}?(\d{3,4})(?!\d)/);
    if (y) return { y: Number(y[1]), src: pm[0] };
  }
  // 2) 区间取起点
  const range = str.match(/(\d{3,4})\s*[—\-~～至到]\s*\d{3,4}\s*年/);
  if (range) return { y: Number(range[1]), src: range[0] };
  // 3) 带「年」的四位数（早于世纪规则：「20世纪40年代」前通常已有更明确的始建年）
  const withYear = str.match(/(\d{4})\s*年/);
  if (withYear) return { y: Number(withYear[1]), src: withYear[0] };
  // 4) 世纪
  const cent = str.match(/(\d{1,2})\s*世纪/);
  if (cent) return { y: (Number(cent[1]) - 1) * 100, src: cent[0] };
  // 5) 年号
  for (const [k, y] of Object.entries(ERA_NAME_YEAR)) if (str.includes(k + "年")) return { y, src: k + "年" };
  // 6) 朝代起始年
  for (const [re, y] of DYNASTY) { const m = str.match(re); if (m) return { y, src: m[0] }; }
  return { y: 0, src: "" };
}

function parseYear(s) { return parseYearHit(s).y; }

/** 按标点切句，但不切进括号内部（否则「（829年，南诏保和六年）」会被腰斩） */
function splitClauses(s, seps) {
  const cut = seps || "，,；;。";
  const out = [];
  let depth = 0, cur = "";
  for (const ch of String(s)) {
    if ("（(".includes(ch)) depth++;
    else if ("）)".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0 && cut.includes(ch)) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
}


/**
 * 导语兜底：只认「1939年……落成」这种带营建动词的表述，
 * 避免把「1987年公布为省级文保」「1274年赴任」误当成始建年。
 */
function yearFromDesc(desc) {
  if (!desc) return 0;
  const m = desc.match(/(\d{4})\s*年[^。；]{0,18}?(?:落成|建成|始建|创建|始建于|修建|重修|兴建|興建|动工|竣工)/);
  return m ? Number(m[1]) : 0;
}


/* ------------------------------------------------------------------ */
/* 单页抽取                                                            */
/* ------------------------------------------------------------------ */
function extract(file) {
  const raw = fs.readFileSync(path.join(SITES_DIR, file), "utf8");
  const h1 = text(pick(raw, /<h1>([\s\S]*?)<\/h1>/));
  const sections = raw.split(/<section/).slice(1);
  const sec = (no) => sections.find((s) => s.includes('class="sec-no">' + no + "</span>")) || "";
  const warn = [];

  // 基本信息表。不同批次页面的表头用词不统一，按候选词表依次匹配。
  const table = {};
  for (const m of strip(raw).matchAll(/<tr><td>([^<]*)<\/td><td>([\s\S]*?)<\/tr>/g)) {
    table[text(m[1])] = text(m[2]);
  }
  /** 按候选 key 顺序取第一个非空值 */
  const pickField = (...names) => {
    for (const n of names) if (table[n]) return table[n];
    return "";
  };
  /** 候选表都对不上时，按表头包含的关键词兜底（如「始建/重修」「建造年代」） */
  const byKeyLike = (re) => {
    for (const k of Object.keys(table)) if (re.test(k) && table[k]) return table[k];
    return "";
  };

  if (!h1) warn.push("未找到 <h1> 标题");

  // 名称 / 副名
  const alias = h1;
  const name = (h1.split(/[（(]/)[0] || path.basename(file, ".html")).trim();
  const full = pickField("单位全称", "全称", "名称") || name;

  // 保护级别：表头可能是「保护级别」，也可能是「聂耳墓级别」这类带专名的写法
  const levelKey = ["保护级别", "级别"].find((k) => table[k])
    || Object.keys(table).find((k) => /级别$/.test(k) && table[k]) || "";
  const levelText = levelKey ? table[levelKey] : "";
  const levelShort = (levelText.split(/[（(]/)[0] || "").trim();
  let tier = "";
  if (/全国重点|国保|国遗/.test(levelText)) tier = "国保";
  else if (/省级|省重点|云南省|四川省|贵州省|省保/.test(levelText)) tier = "省保";
  else if (/市级|市重点|市保/.test(levelText)) tier = "市保";
  else if (/县级|县重点|区级|县保/.test(levelText)) tier = "县保";
  if (!tier) { tier = "其他"; warn.push("无法判定保护级别：" + (levelShort || "空")); }

  // 地点：省 / 市 / 区县。表头可能是「地址」也可能是「位置」
  const addr = pickField("地址", "位置", "现址", "所在地", "所处位置");
  const province = (addr.match(/^[^，,。；;\s]{2,6}?(?:省|自治区|特别行政区)/) || [""])[0];
  const afterProv = addr.slice(addr.indexOf(province) + province.length).replace(/^[\s，,]/, "");
  // 优先取「自治州/地区/盟」，再取第一个「市」（非贪婪，否则「昆明市安宁市」会被整体吞掉）
  const city = (afterProv.match(/[^，,。；;\s]{2,8}?(?:自治州|地区|盟)/)
    || afterProv.match(/[^，,。；;\s]{2,6}?市/)
    || [""])[0];
  const district = (afterProv.slice(afterProv.indexOf(city) + city.length).match(/[^，,。；;\s()（）]{2,6}?[区县市旗]/)
    || [""])[0];
  const region = [province, city, district].filter(Boolean).join("·") || addr.slice(0, 12).replace(/\s+/g, "");

  // 简介（页面导语）。年代兜底要用，先于年代块取出。
  const desc = dropCite(text(pick(raw, /<p class="sub">([\s\S]*?)<\/p>/))).slice(0, 200);

  // 年代：表头有 始建 / 始建年代 / 年代 / 建造年代 / 建造 / 始建与沿革 等多种写法，
  // 另有个别页面写成「始建/重修」这类复合表头，故再加一次按关键词的兜底匹配。
  // 年份可能写成「1937年」「清康熙四年（1665）」「738—902年」，也可能只给朝代。
  const built = pickField("始建", "始建年代", "年代", "建造年代", "建造", "始建与沿革",
    "建成年代", "创建年代", "重修年代", "建造时间")
    || byKeyLike(/^始建/) || byKeyLike(/年代|建造|创建|建成|开凿|动工|竣工/);

  // era：卡片上的年代短标签。取与命中年份 src 相对应的那个分句，
  // 找不到就退回首句；含「约/近/余/超 N 年」这类时长的句子不作首选。
  const isDuration = (s) => /[约近余超]?\d{3,4}\s*余年|约\s*\d{2,4}\s*年(?!始|建)/.test(s);
  const eraOf = (src, h) => {
    const segs = splitClauses(src);
    const cand = segs.find((s) => h.src && s.includes(h.src) && !isDuration(s))
      || segs.find((s) => !isDuration(s))
      || segs[0] || "";
    const e = fixParens(cand.replace(/^(相传|据说|原为|初为|现存)/, "").trim()
      .slice(0, 18).replace(/[，,、；;：:。\s]+$/, ""));
    return e;
  };

  let hit = parseYearHit(built);
  // 「始建于清乾隆年间；现建筑为民国十年（1921年）重修」：括注年份属于重修而非始建。
  // 仅当首子句是纯文字纪年（没有阿拉伯年份可采信）时，才改用其中的年号换算。
  const firstClause = splitClauses(built)[0] || "";
  if (/始建|创建|营建|兴建|建于/.test(firstClause) && !/\d{3,4}/.test(firstClause)) {
    for (const [k, y] of Object.entries(ERA_NAME_YEAR)) {
      if (firstClause.includes(k + "年")) { hit = { y, src: k + "年" }; break; }
    }
  }
  let year = hit.y;
  let era = eraOf(built, hit);
  // 页面自己写明「始建年代不详」时照原样呈现，不再向下猜，也不再报解析提示
  const unknown = UNKNOWN_YEAR.test(built);

  // 表格确实没有年代时，才依次从导语、历史沿革与其他单元格找回（宁缺毋滥）
  if (!year && !unknown) {
    const guess = yearFromDesc(desc);
    if (guess) { year = guess; if (!era) era = guess + "年"; }
  }
  if (!year && !unknown) {
    // 历史沿革逐条看，只取 <li> 正文，避免把节标题（「二 历史沿革」）也当成句子
    const hist = [...sec("二").matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1])).join("；");
    const guess = findBuildSentence([desc, hist, ...Object.values(table)]);
    if (guess) {
      year = guess.dynasty ? (DYNASTY.find(([re]) => re.test(guess.dynasty)) || [0, 0])[1] : guess.year;
      // 只给朝代时保留原句作标签（「冠英街建于明代」），有确切年份则用「1522年」
      era = guess.dynasty
        ? eraOf(guess.sentence, { src: guess.dynasty }).replace(/^[^：:]{1,6}[：:]/, "")
        : (year ? year + "年" : "");
    }
  }
  if (unknown) { year = 0; era = ""; }
  if (!era) era = year ? year + "年" : "年代不详";
  if (!year && !unknown) warn.push("未能从「始建」解析出年代（页面本身可能未标注）");

  // 核心看点（第五节）
  const points = [...sec("五").matchAll(/<li><strong>([\s\S]*?)<\/strong>([\s\S]*?)<\/li>/g)]
    .map((m) => {
      const t = clean(text(m[1]));
      const b = cut(dropCite(clean(text(m[2]))), 30);
      return b && b !== t ? t + "：" + b : (b || t);
    })
    .filter(Boolean)
    .slice(0, 6);
  if (!points.length) warn.push("未解析到「核心看点」");

  // 推荐路线（第七节）
  const route = [...sec("七").matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((m) => cut(dropCite(text(m[1])), 60))
    .filter(Boolean)
    .slice(0, 10);

  // 参观信息（第九节）
  const info = {};
  for (const m of sec("九").matchAll(/<li><strong>([\s\S]*?)<\/strong>([\s\S]*?)<\/li>/g)) {
    const k = clean(text(m[1]));
    if (k && !info[k]) info[k] = dropCite(clean(text(m[2])));
  }
  const time = info["开放时间"] || info["开放状态"] || info["开放"] || "";
  const ticket = info["门票"] || "";
  const openParts = [];
  if (time) openParts.push(cut(time, 28));
  if (/免费/.test(ticket) && !/免费/.test(time)) openParts.push("免费");
  const open = fixParens(openParts.join(" · ")) || "开放信息见导览页";

  // 标签：优先「身份叠加」，其次 类别细部 + 看点小标题 + 朝代
  // 「类别」单元格里偶尔是一整句（如同时介绍两处文保的页面），需截到第一个分句并去掉主语。
  const catRaw = table["类别"] || "";
  const catHead = (catRaw.split(/[（(；;]/)[0] || "文物")
    .replace(/^[^为]{2,10}为/, "")            // 「聂耳墓为近现代重要史迹」→「近现代重要史迹」
    .replace(/[\s，,。、]+$/, "")
    .trim();
  const category = cut(catHead, 14);
  const catDetail = (catRaw.match(/[（(]([^）)]+)[）)]/) || ["", ""])[1].trim();
  const eraTag = (ERAS.find(([e]) => era.includes(e)) || ["", ""])[1];
  // 「叠加身份」是顿号分条，但括注里也有顿号（「三大工程（护国门、护国桥、护国纪念标）之一」），
  // 故按「不切进括号」的方式切分，再去掉括注，最后按标签长度上限过滤。
  let tags = splitClauses(pickField("身份叠加", "叠加身份"), "、，,；;。")
    .map((t) => dropCite(t).replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter((t) => t.length >= 2 && t.length <= 14);
  // 叠加身份不足 3 条时，用「类别细部 + 看点小标题」补齐，卡片不至于只剩一两个标签
  if (tags.length < 3) {
    const extra = [catDetail, ...points.map((p) => p.split("：")[0])]
      .map((t) => (t || "").split(/[，,（(]/)[0].trim())
      .filter((t) => t.length >= 2 && t.length <= 8);
    tags = tags.concat(extra);
  }
  if (eraTag && !tags.includes(eraTag)) tags.unshift(eraTag);
  tags = [...new Set(tags)].slice(0, 5);

  return { file, name, alias, full, tier, tierFull: levelShort || tier, levelNote: levelText,
    region, city, category, year, era, desc, points, route, open, tags, warn };
}

/* ------------------------------------------------------------------ */
/* 视觉主题分配                                                        */
/* ------------------------------------------------------------------ */
function decorate(rec, theme) {
  const key = path.basename(rec.file, ".html");
  const seed = hash(key);
  const pick = (rules, text) => {
    const hit = rules.find(([re]) => re.test(text));
    return hit ? hit[1] : "";
  };
  const category = rec.category || "";
  const catHit = pick(ART_CATEGORY, category);
  const art = pick(ART_NAME, rec.name)
    || pick(ART_ALIAS, rec.name)
    || pick(ART_ALIAS, rec.full)
    || (category.includes("近现代") ? "" : pick(ART_ROOF, rec.name) || pick(ART_ROOF, rec.full))
    || catHit
    || ART_KEYS[seed % ART_KEYS.length];
  const [a, a2] = LEVEL_COLORS[rec.tier] || PALETTE[seed % PALETTE.length];
  const d = { art, a, a2, glyph: rec.name.slice(0, 1) };
  const ov = (theme && (theme[key] || theme[rec.name])) || {};
  return Object.assign(d, ov);
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */
function listFiles() {
  if (!fs.existsSync(SITES_DIR)) return [];
  return fs.readdirSync(SITES_DIR).filter((f) => f.toLowerCase().endsWith(".html")).sort();
}

function build() {
  const files = listFiles();
  if (!files.length) throw new Error("sites/ 目录下没有找到任何 .html 导览页");

  const rawTheme = fs.existsSync(THEME_FILE)
    ? JSON.parse(fs.readFileSync(THEME_FILE, "utf8").replace(/^\s*\/\/.*$/gm, ""))
    : {};
  // 键统一去掉 .html 后缀，用户写文件名或单位名都能命中
  const theme = {};
  for (const [k, v] of Object.entries(rawTheme)) theme[k.replace(/\.html$/i, "")] = v;

  const records = files.map((f) => {
    const rec = extract(f);
    rec.file = SITES_DIR_NAME + "/" + rec.file;
    if (rec.warn.length) rec.warn.forEach((w) => console.log(`  \x1b[33m注意\x1b[0m ${f}：${w}`));
    return Object.assign(rec, decorate(rec, theme));
  });

  // 默认按始建年代由早到晚（无年代的排在最后）
  records.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.file.localeCompare(b.file));

  const body = records.map((r) => JSON.stringify(r, null, 2).split("\n").map((l, i) => (i ? "  " + l : l)).join("\n")).join(",\n");

  const code = `/* 本文件由 tools/build.js 自动生成，请勿手工编辑。\n * 数据来源：sites/*.html —— 想新增或修改内容，请改 HTML 后重新运行 node tools/build.js\n * 生成方式：node tools/build.js   校验：node tools/check.js\n */\nwindow.TIER_COLORS = ${JSON.stringify(LEVEL_COLORS, null, 2)};\nwindow.SITES_DATA = [\n${body}\n];\n`;

  return { code, records };
}

function main() {
  const { code, records } = build();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, code, "utf8");
  console.log(`\x1b[32m已生成\x1b[0m data/sites.js —— ${records.length} 处文保单位`);
  records.forEach((r) => console.log(`  · ${r.name}（${r.tier} / ${r.year}） → ${r.file}`));
  const warnCount = records.reduce((n, r) => n + (r.warn ? r.warn.length : 0), 0);
  if (warnCount) console.log(`\x1b[33m共 ${warnCount} 条解析提示，请检查对应页面是否缺少相关小节\x1b[0m`);
}

if (require.main === module) main();
module.exports = { build, listFiles, PALETTE, ART_KEYS, LEVEL_COLORS };
