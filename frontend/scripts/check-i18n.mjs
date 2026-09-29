// 校验 en / zh 两份语言包的键集合是否完全一致。
//
// 背景：两边的 JSON 靠人工同步，任何一侧漏键时界面会直接渲染出
// "confirm_master_password" 这样的原始 key（i18next 找不到翻译时的兜底行为），
// 而 tsc 与构建都不会报错。此脚本在 CI 中把这类问题拦下来。
//
// 用法：node scripts/check-i18n.mjs

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const localesDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "locales");
const languages = ["en", "zh"];

/** 递归展开为 "a.b.c" 形式的扁平键，便于直接比较键集合 */
function flatten(value, prefix = "", out = new Set()) {
    for (const [key, val] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (val !== null && typeof val === "object" && !Array.isArray(val)) {
            flatten(val, path, out);
        } else {
            out.add(path);
        }
    }
    return out;
}

function listNamespaces(lang) {
    return readdirSync(join(localesDir, lang))
        .filter((f) => f.endsWith(".json"))
        .sort();
}

function loadNamespace(lang, file) {
    const full = join(localesDir, lang, file);
    try {
        return JSON.parse(readFileSync(full, "utf8"));
    } catch (err) {
        console.error(`::error::${lang}/${file} 不是合法 JSON: ${err.message}`);
        process.exit(1);
    }
}

let failed = false;

const namespaceSets = languages.map((lang) => ({ lang, files: listNamespaces(lang) }));
const [first, ...rest] = namespaceSets;
for (const other of rest) {
    const missing = first.files.filter((f) => !other.files.includes(f));
    const extra = other.files.filter((f) => !first.files.includes(f));
    for (const f of missing) {
        console.error(`::error::${other.lang} 缺少语言文件 ${f}（${first.lang} 中存在）`);
        failed = true;
    }
    for (const f of extra) {
        console.error(`::error::${other.lang} 多出语言文件 ${f}（${first.lang} 中不存在）`);
        failed = true;
    }
}

for (const file of first.files) {
    if (!rest.every((o) => o.files.includes(file))) continue;

    const keysByLang = {};
    for (const lang of languages) {
        keysByLang[lang] = flatten(loadNamespace(lang, file));
    }

    const reference = languages[0];
    for (const lang of languages.slice(1)) {
        const missing = [...keysByLang[reference]].filter((k) => !keysByLang[lang].has(k));
        const extra = [...keysByLang[lang]].filter((k) => !keysByLang[reference].has(k));
        for (const k of missing) {
            console.error(`::error::${lang}/${file} 缺少键 "${k}"（${reference} 中存在）`);
            failed = true;
        }
        for (const k of extra) {
            console.error(`::error::${lang}/${file} 多出键 "${k}"（${reference} 中不存在）`);
            failed = true;
        }
    }
}

if (failed) {
    console.error("\ni18n 键一致性校验失败：请补齐上述键后再提交。");
    process.exit(1);
}

console.log(`i18n 键一致性校验通过（${first.files.length} 个命名空间，${languages.join(" / ")}）。`);