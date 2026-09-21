/**
 * markdown 代码块的语法高亮：highlight.js（与 claude CLI TUI 同款 tokenizer——
 * 二进制里有 `syntaxHighlighting.hljsLanguages` 的插件配置，CLI 侧就是用它）。
 *
 * 只注册常用语言、走 `highlight.js/lib/core`，不引全量包；未注册的语言原样转义输出，
 * 不做 highlightAuto（猜错的观感比不着色更差）。
 *
 * token 颜色在 styles.css 的 `.md-body .hljs-*` 一组规则里（深浅主题各一套 token），
 * 这里只负责产出 `<pre><code class="hljs language-x">…` 结构。
 */
import hljs from "highlight.js/lib/core";
import { marked } from "marked";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/** 围栏里写的别名 → 已注册的语言名（hljs 自带别名只有一部分，这几种得自己接） */
const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  html: "xml",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  py: "python",
  yml: "yaml",
  md: "markdown",
  patch: "diff",
};

for (const [name, lang] of Object.entries({
  bash,
  css,
  diff,
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  scss,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, lang);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** marked 的 code renderer：返回字符串即生效（返回 false 会让 marked 回落默认实现） */
export function renderCode({ text, lang }: { text: string; lang?: string }): string {
  const raw = (lang ?? "").trim().toLowerCase();
  const name = ALIASES[raw] ?? raw;
  const usable = name !== "" && hljs.getLanguage(name) !== undefined;
  const body = usable ? hljs.highlight(text, { language: name }).value : escapeHtml(text);
  return `<pre><code class="${usable ? `hljs language-${name}` : "hljs"}">${body}</code></pre>`;
}

let installed = false;

/**
 * 给全局 marked 装上高亮 renderer。幂等是必需的：`marked.use` 是全局副作用，
 * HMR 或多次 import 会一层层叠加覆盖。
 */
export function installMarkdownHighlighting(): void {
  if (installed) return;
  installed = true;
  marked.use({ renderer: { code: renderCode } });
}
