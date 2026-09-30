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

/** 古建色板：每项为 [浅色(主), 深色(强调)]，均已验证在米色底上可读 */
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

/** 插画关键词 → index.html 中 ART 的键；名称优先，其次类别，兜底按名称哈希轮换 */
const ART_RULES = [
  [/塔/, "pagoda"],
  [/城|垣|墙|关隘|堡|寨|炮台/, "xz"],
  [/楼|阁|亭|坊|桥|宫|殿/, "jxl"],
  [/书院|学宫|府学|讲堂|祠|庙|寺|观|院/, "cps"],
  [/园|林|圃|墅/, "garden"],
  [/墓|冢|碑|崖|遗址|窑/, "pagoda"]
];
const ART_KEYS = ["xz", "jxl", "cps", "garden", "pagoda"];

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

/** 按标点优先截断，max 为目标字数 */
function cut(s, max) {
  s = String(s).trim();
  if (s.length <= max) return s;
  const seg = s.slice(0, max + 6);
  const at = Math.max(seg.lastIndexOf("，"), seg.lastIndexOf("、"), seg.lastIndexOf("；"));
  return (at > max * 0.5 ? seg.slice(0, at) : seg.slice(0, max)) + "…";
}

/** 去掉行首行尾的装饰性标点与序号 */
const clean = (s) => String(s)
  .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, "")
  .replace(/^[（(]?\s*|\s*[）)]?$/g, "")
  .replace(/^[：:、,，]\s*|\s*[：:]$/g, "")
  .trim();

/** 稳定字符串哈希（跨平台一致，保证配色分配可复现） */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
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

  // 基本信息表
  const table = {};
  for (const m of strip(raw).matchAll(/<tr><td>([^<]*)<\/td><td>([\s\S]*?)<\/tr>/g)) {
    table[text(m[1])] = text(m[2]);
  }

  if (!h1) warn.push("未找到 <h1> 标题");

  // 名称 / 副名
  const alias = h1;
  const name = (h1.split(/[（(]/)[0] || path.basename(file, ".html")).trim();
  const full = table["单位全称"] || name;

  // 保护级别
  const levelRaw = table["保护级别"] || "";
  const levelShort = (levelRaw.split(/[（(]/)[0] || "").trim();
  let tier = "";
  if (/全国重点|国保|国遗/.test(levelRaw)) tier = "国保";
  else if (/省/.test(levelRaw)) tier = "省保";
  else if (/市/.test(levelRaw)) tier = "市保";
  else if (/县|区级/.test(levelRaw)) tier = "县保";
  if (!tier) { tier = "其他"; warn.push("无法判定保护级别：" + (levelShort || "空")); }

  // 地点：省 / 市 / 区县
  const addr = table["地址"] || "";
  const mAddr = addr.match(/^\s*((?:.{2,5}省|.{2,7}自治区)?\s*(?:.{2,6}市|.{2,7}自治州)?\s*(?:.{2,6}[区县])?)/);
  const region = (mAddr && mAddr[1] ? mAddr[1] : addr.slice(0, 12)).replace(/\s+/g, "");
  const afterProvince = region.replace(/^.{2,5}省|^.{2,7}自治区/, "");
  const city = (afterProvince.match(/.{2,6}市/) || [region.slice(0, 3)])[0];

  // 年代
  const built = table["始建"] || "";
  const ym = built.match(/(\d{3,4})\s*年/) || (table["规模"] || "").match(/(\d{3,4})\s*年/);
  const year = ym ? Number(ym[1]) : 0;
  const era = (built.split(/[，,]/)[0] || (year ? year + "年" : "年代不详")).replace(/\s+/g, " ").trim();
  if (!year) warn.push("未能从「始建」解析出年代");

  // 简介（页面导语）
  const desc = dropCite(text(pick(raw, /<p class="sub">([\s\S]*?)<\/p>/))).slice(0, 200);

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
  const ticket = info["门票"] || info["开放状态"] || info["开放"] || "";
  const openParts = [];
  if (time) openParts.push(cut(time, 28));
  if (/免费/.test(ticket) && !/免费/.test(time)) openParts.push("免费");
  const open = openParts.join(" · ") || "开放信息见导览页";

  // 标签：优先「身份叠加」，其次 类别细部 + 看点小标题 + 朝代
  const catRaw = table["类别"] || "";
  const category = (catRaw.split(/[（(]/)[0] || "文物").trim();
  const catDetail = (catRaw.match(/[（(]([^）)]+)[）)]/) || ["", ""])[1].trim();
  const eraTag = (ERAS.find(([e]) => era.includes(e)) || ["", ""])[1];
  let tags = (table["身份叠加"] || "").split(/[；;、，]/)
    .map((t) => dropCite(t).replace(/[（(][^）)]*[）)]/g, "").trim())
    .filter((t) => t.length >= 2 && t.length <= 12);
  if (!tags.length) {
    tags = [catDetail, ...points.map((p) => p.split("：")[0])]
      .map((t) => (t || "").split(/[，,（(]/)[0].trim())
      .filter((t) => t.length >= 2 && t.length <= 8);
  }
  if (eraTag && !tags.includes(eraTag)) tags.unshift(eraTag);
  tags = [...new Set(tags)].slice(0, 5);

  return { file, name, alias, full, tier, tierFull: levelShort || tier, levelNote: levelRaw,
    region, city, category, year, era, desc, points, route, open, tags, warn };
}

/* ------------------------------------------------------------------ */
/* 视觉主题分配                                                        */
/* ------------------------------------------------------------------ */
function decorate(rec, theme) {
  const key = path.basename(rec.file, ".html");
  const seed = hash(key);
  const hit = ART_RULES.find(([re]) => re.test(rec.name))
    || ART_RULES.find(([re]) => re.test(rec.category + rec.full));
  const art = hit ? hit[1] : ART_KEYS[seed % ART_KEYS.length];
  const [a, a2] = PALETTE[seed % PALETTE.length];
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

  const code = `/* 本文件由 tools/build.js 自动生成，请勿手工编辑。\n * 数据来源：sites/*.html —— 想新增或修改内容，请改 HTML 后重新运行 node tools/build.js\n * 生成方式：node tools/build.js   校验：node tools/check.js\n */\nwindow.SITES_DATA = [\n${body}\n];\n`;

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
module.exports = { build, listFiles, PALETTE, ART_KEYS };
