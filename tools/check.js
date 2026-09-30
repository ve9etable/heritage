#!/usr/bin/env node
/**
 * 构建校验：确保站点结构与链接完好，可直接作为 Pages 部署前的检查步骤。
 * 用法：node tools/check.js
 */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

let failed = 0;
const ok = (msg) => console.log("  \x1b[32mPASS\x1b[0m " + msg);
const bad = (msg) => { failed++; console.log("  \x1b[31mFAIL\x1b[0m " + msg); };

console.log("检查 Pages 必要文件：");
for (const f of ["index.html", ".nojekyll", ".github/workflows/pages.yml"]) {
  fs.existsSync(path.join(root, f)) ? ok(f) : bad("缺少 " + f);
}

const links = [...index.matchAll(/file:\s*"([^"]+\.html)"/g)].map((m) => m[1]);
console.log("\n检查卡片跳转目标（" + links.length + " 条）：");
for (const name of new Set(links)) {
  fs.existsSync(path.join(root, name)) ? ok("→ " + name) : bad("目标不存在：" + name);
}

const cardCount = (index.match(/class="card"/g) || []).length;
const artCount = (index.match(/class="art"/g) || []).length;
console.log("\n检查渲染资源：");
links.length === artCount ? ok("插画数量与站点数一致（" + artCount + "）") : bad("插画数量不匹配：" + artCount);
index.includes("IntersectionObserver") ? ok("已启用滚动入场动效") : console.log("  · 未启用 IntersectionObserver");
if (cardCount) console.log("  · 静态 HTML 中的卡片节点：" + cardCount + "（卡片由 JS 动态生成，属正常）");

console.log(failed ? "\n" + failed + " 项检查未通过" : "\n全部检查通过");
process.exit(failed ? 1 : 0);
