#!/usr/bin/env node
/**
 * 站点结构与链接校验：部署前的守门脚本。
 * 用法：node tools/check.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const SITES_DIR = "sites";
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

let failed = 0;
const ok = (msg) => console.log("  \x1b[32mPASS\x1b[0m " + msg);
const bad = (msg) => { failed++; console.log("  \x1b[31mFAIL\x1b[0m " + msg); };
const info = (msg) => console.log("  \x1b[90m·\x1b[0m   " + msg);

console.log("检查 Pages 必要文件：");
for (const f of ["index.html", ".nojekyll", ".github/workflows/pages.yml"]) {
  fs.existsSync(path.join(root, f)) ? ok(f) : bad("缺少 " + f);
}

console.log("\n检查目录结构：");
fs.existsSync(path.join(root, SITES_DIR)) ? ok(SITES_DIR + "/ 目录存在") : bad("缺少 " + SITES_DIR + "/ 目录");
const stray = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(".html") && f !== "index.html");
stray.length === 0 ? ok("根目录只保留 index.html，导览页已归入 " + SITES_DIR + "/")
  : bad("根目录存在未归位的导览页：" + stray.join("、"));

const links = [...index.matchAll(/file:\s*"([^"]+\.html)"/g)].map((m) => m[1]);
console.log("\n检查卡片跳转目标（登记 " + links.length + " 条）：");
for (const name of new Set(links)) {
  const inSites = name.startsWith(SITES_DIR + "/");
  inSites ? ok("路径规范 · " + name) : bad("应写入 " + SITES_DIR + "/ 子目录：" + name);
  fs.existsSync(path.join(root, name)) ? ok("→ " + name) : bad("目标不存在：" + name);
}

const onDisk = fs.readdirSync(path.join(root, SITES_DIR))
  .filter((f) => f.toLowerCase().endsWith(".html")).map((f) => SITES_DIR + "/" + f);
const orphans = onDisk.filter((f) => !links.includes(f));
console.log("\n检查 " + SITES_DIR + "/ 目录（" + onDisk.length + " 个页面）：");
orphans.length === 0 ? ok("没有漏登记的导览页")
  : bad("以下页面未在 index.html 的 SITES 中登记，首页将无法访问：" + orphans.join("、"));

const dup = links.filter((n, i) => links.indexOf(n) !== i);
dup.length === 0 ? ok("SITES 中无重复条目") : bad("SITES 中重复登记：" + [...new Set(dup)].join("、"));

console.log("\n检查渲染资源：");
const arts = (index.match(/class="art"/g) || []).length;
arts === links.length ? ok("插画数量与站点数一致（" + arts + "）") : bad("插画数量不匹配：" + arts + " vs " + links.length);
index.includes("IntersectionObserver") ? ok("已启用滚动入场动效") : info("未启用 IntersectionObserver");

console.log(failed ? "\n\x1b[31m" + failed + " 项检查未通过\x1b[0m" : "\n\x1b[32m全部检查通过\x1b[0m");
process.exit(failed ? 1 : 0);
