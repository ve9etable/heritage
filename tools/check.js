#!/usr/bin/env node
/**
 * 站点结构与数据校验：部署前的守门脚本。
 * 用法：node tools/check.js
 */
const fs = require("fs");
const path = require("path");
const { build, listFiles } = require("./build.js");

const root = path.resolve(__dirname, "..");
const SITES_DIR = "sites";
const indexPath = path.join(root, "index.html");
const index = fs.readFileSync(indexPath, "utf8");

let failed = 0;
const ok = (m) => console.log("  \x1b[32mPASS\x1b[0m " + m);
const bad = (m) => { failed++; console.log("  \x1b[31mFAIL\x1b[0m " + m); };
const info = (m) => console.log("  \x1b[90m·\x1b[0m   " + m);

console.log("1. Pages 必要文件");
for (const f of ["index.html", ".nojekyll", "data/sites.js", "tools/build.js", ".github/workflows/pages.yml"]) {
  fs.existsSync(path.join(root, f)) ? ok(f) : bad("缺少 " + f);
}

console.log("\n2. 目录结构");
const onDisk = listFiles();
onDisk.length ? ok(SITES_DIR + "/ 下 " + onDisk.length + " 个导览页") : bad(SITES_DIR + "/ 下没有 .html 页面");
const stray = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(".html") && f !== "index.html");
stray.length === 0 ? ok("根目录只保留 index.html，导览页已归入 " + SITES_DIR + "/")
  : bad("根目录存在未归位的导览页：" + stray.join("、"));

console.log("\n3. 数据来源单一性");
/\bvar\s+SITES\s*=\s*\[/.test(index) ? bad("index.html 里又出现了内嵌的 SITES 数据数组，请改用 data/sites.js")
  : ok("index.html 不再内嵌单位数据");
index.includes('src="data/sites.js"') ? ok("index.html 已引用 data/sites.js") : bad("index.html 未引用 data/sites.js");

console.log("\n4. data/sites.js 与页面同步");
let fresh = null;
try {
  fresh = build();
} catch (e) { bad("build.js 执行失败：" + e.message); }
if (fresh) {
  const onDiskCode = fs.readFileSync(path.join(root, "data", "sites.js"), "utf8");
  onDiskCode === fresh.code ? ok("索引与 sites/*.html 完全一致（无需重新生成）")
    : bad("data/sites.js 已过期，请运行 node tools/build.js 重新生成");
  fs.writeFileSync(path.join(root, "data", "sites.js"), fresh.code, "utf8");
}

console.log("\n5. 收录完整性");
const records = fresh ? fresh.records : [];
const relOnDisk = onDisk.map((f) => SITES_DIR + "/" + f);
const inData = records.map((r) => r.file);
const missing = relOnDisk.filter((f) => !inData.includes(f));
const orphan = inData.filter((f) => !relOnDisk.includes(f));
missing.length === 0 ? ok("没有漏收录的导览页") : bad("以下页面未被抽取，请检查其结构：" + missing.join("、"));
orphan.length === 0 ? ok("data/sites.js 中没有指向不存在页面的记录")
  : bad("data/sites.js 指向了不存在的文件：" + orphan.join("、"));
new Set(inData).size === inData.length ? ok("无重复记录") : bad("存在重复记录");
records.every((r) => r.file.startsWith(SITES_DIR + "/")) ? ok("记录路径均位于 " + SITES_DIR + "/")
  : bad("存在未写入 " + SITES_DIR + "/ 的记录");

console.log("\n6. 数据质量");
const thin = records.filter((r) => (r.warn && r.warn.length) || !r.points.length || !r.desc || !r.year);
thin.length === 0 ? ok("所有记录均抽到名称/年代/简介/看点")
  : bad("以下记录字段不全（卡片会很单薄）：" + thin.map((r) => r.name + "(" + (r.warn || []).join("、") + ")").join("；"));
const artsUsed = [...new Set(records.map((r) => r.art))];
const artsDefined = [...index.matchAll(/^\s{4}(\w+):\s'<svg class="art"/gm)].map((m) => m[1]);
const noArt = artsUsed.filter((a) => !artsDefined.includes(a));
noArt.length === 0 ? ok("记录用到的插画 " + artsUsed.join("/") + " 均已在 index.html 的 ART 中定义")
  : bad("index.html 的 ART 缺少插画：" + noArt.join("、"));
const themeFile = path.join(root, "data", "theme.json");
if (fs.existsSync(themeFile)) {
  const theme = JSON.parse(fs.readFileSync(themeFile, "utf8").replace(/^\s*\/\/.*$/gm, ""));
  const stale = Object.keys(theme).map((k) => k.replace(/\.html$/i, ""))
    .filter((k) => !onDisk.some((f) => f.replace(/\.html$/i, "") === k));
  stale.length === 0 ? info("theme.json 覆盖项均对应当前页面")
    : bad("theme.json 中有已删除页面的配置：" + stale.join("、"));
}

console.log(failed ? "\n\x1b[31m✗ " + failed + " 项检查未通过\x1b[0m" : "\n\x1b[32m✓ 全部检查通过\x1b[0m");
process.exit(failed ? 1 : 0);
