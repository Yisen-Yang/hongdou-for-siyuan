"use strict";

/**
 * 红豆文献联动 for 思源笔记
 * 通过红豆本机 MCP 服务（默认 127.0.0.1:18500/mcp）读写文献库。
 *
 * 数据层设计说明：
 *   红豆不同接口返回的字段粒度并不一致 ——
 *   - hongdou_search_items / hongdou_get_item 返回 creators、year，但期刊、卷期页、DOI、
 *     日期都塞在 fields 子对象里；
 *   - hongdou_list_items / hongdou_get_ui_focus 只返回 id / key / title / itemType。
 *   所以任何条目进插件后都必须过 normalizeItem()，必要时再用 hydrate() 回查完整字段，
 *   否则就会出现「作者年份期刊全空」的情况。
 */

const siyuan = require("siyuan");
const { Plugin, Dialog, Setting, showMessage, fetchSyncPost, openTab } = siyuan;

const VERSION = "0.4.2";
const MAX_SELECT = 20;
const CACHE_TTL = 5 * 60 * 1000;
const HYDRATE_CONCURRENCY = 4;

const DEFAULTS = {
    endpoint: "http://127.0.0.1:18500/mcp",
    notebook: "",
    folder: "红豆文献",
    linkStyle: "title",
    linkTemplate: "{author} {year}",
    scheme: "hongdou",
    /** 多篇文献的排列方式：line 每行一条 / para 独立段落 / bullet 无序列表 / number 编号 / semicolon 连排 */
    layout: "line",
    separator: "；",
    insertAbstract: false,
    styleID: "",
    styleTitle: "",
    noteTemplate: "",
    showDetail: true,
    confirmWrite: true,
    annoOnlyComment: false,
    browseLimit: 100,

    /* ---- 引用体系（v0.4.0） ---- */
    /** 正文引用形态：auto 按样式自动判断 / authorDate 作者-年份 / numeric 数字式 */
    citeForm: "auto",
    /** 新插入的引用默认用叙述式 Chen et al. (2024) */
    citeNarrative: false,
    /** 数字式正文是否带上标（思源里用 <sup> 包裹） */
    citeSuperscript: false,
    /** 插入引用后自动维护文末参考文献表 */
    bibAuto: true,
    /** 文末表标题；留空表示不生成标题 */
    bibTitle: "参考文献",
    /** 文末表标题级别 1-6 */
    bibLevel: "2",
    /** 引用快照：把条目元数据存进文档属性，红豆断连时也能重排 */
    citeSnapshot: true,
    /** 导出默认格式 */
    exportFormat: "gbt",
    /** 引用键生成格式：{author} {year} {title} 占位符 */
    citeKeyFormat: "{author}{year}{title}",
    /** 重复引用提醒 */
    citeWarnDup: true,
    /** 首次使用引导是否已看过 */
    welcomed: false,

    /* ---- 红豆桥接（v0.6.0）：红豆右键「发送到思源」→ 这边自动落笔 ---- */
    /** 红豆端 bridge 插件监听端口 */
    bridgePort: 18501,
    /** 配对令牌（配对成功后写入） */
    bridgeToken: "",
    /** 收到红豆推送时自动插入到当前光标处 */
    bridgeAutoInsert: true,
    /** 轮询间隔（秒），2-30 */
    bridgePollSec: 3,

    /** PDF 用什么打开：hongdou 红豆阅读器（批注可同步）/ system 系统默认阅读器 */
    pdfOpenWith: "hongdou",

    /** Word 导出目录；留空用桌面 */
    wordExportDir: "",
};

/* ---------------------------------------------------------------- 引用常量 */

const CITE_PREFIX = "custom-hongdou-";
/** 文末参考文献块标记：重排时只认这些块，绝不动用户自己写的内容 */
const ATTR_BIB = CITE_PREFIX + "bib";
const ATTR_BIB_ID = CITE_PREFIX + "bib-id";
const ATTR_BIB_VER = CITE_PREFIX + "bib-ver";
const ATTR_SNAP = CITE_PREFIX + "citesnap";
const ATTR_CITE = CITE_PREFIX + "cite";
/** 文档级引用样式覆盖（存 styleID）；空表示跟随全局设置 */
const ATTR_STYLE = CITE_PREFIX + "style";

/**
 * 红豆端配套插件（双向联动）。
 * BRIDGE_XPI_URL 是具体到文件的完整地址，点开即下载，不用再在 release 页里找。
 * 注意：升级 bridge 版本时这里要同步改版本号。
 */
const BRIDGE_XPI_URL = "https://github.com/Yisen-Yang/hongdou-siyuan-bridge/releases/download/v0.3.1/hongdou-siyuan-bridge-0.3.1.xpi";

/**
 * 样式 ID / 标题里出现这些关键词时判为数字式（顺序编码）。
 * 注意别放太宽的词：「science」会误伤 american-political-science-association，
 * 「nature」只匹配 nature 系样式而不是泛指。
 */
const NUMERIC_HINT = [
    "numeric", "numbered", "numbered-references", "vancouver", "ieee", "nature",
    "science-magazine", "gbt", "gb-t-7714", "顺序编码", "ama", "acs", "nlm",
    "citation-sequence", "acm", "cell", "bmj", "annual-reviews", "karger",
    "springer-basic", "elsevier-vancouver", "chicago-notes", "mhra-notes",
    "notes-bibliography", "turabian", "american-chemical-society",
    "american-medical-association", "plos", "jama", "nejm", "lancet",
];
const AUTHOR_DATE_HINT = [
    "author-date", "authoryear", "author_year", "apa", "harvard",
    "chicago-author-date", "asa", "apsa", "anthropological",
    "modern-language-association", "mla", "著者", "出版年",
];

/** 匹配正文里由本插件写入的引用链接（兼容 sy 导出的转义、尖括号与标题写法） */
const CITE_RE = /\[((?:\\.|[^\[\]\\])*)\]\(<?(?:hongdou|zotero):\/\/select\/library\/items\/([A-Za-z0-9]+)((?:\?[^)\s>]*)?)>?(?:\s+"[^"]*")?\)/g;

/** 中文按「等」、拉丁按 et al. */
const ZH_RE = /[\u3400-\u9fff]/;

/** 条目类型的中文名 */
const TYPE_LABELS = {
    journalArticle: "期刊论文",
    magazineArticle: "杂志文章",
    newspaperArticle: "报纸文章",
    book: "图书",
    bookSection: "图书章节",
    conferencePaper: "会议论文",
    thesis: "学位论文",
    patent: "专利",
    preprint: "预印本",
    report: "报告",
    standard: "标准",
    webpage: "网页",
    blogPost: "博客",
    dataset: "数据集",
    manuscript: "手稿",
    document: "文档",
    presentation: "演示文稿",
    artwork: "艺术品",
    audioRecording: "音频",
    videoRecording: "视频",
    film: "影片",
    computerProgram: "软件",
    map: "地图",
    letter: "信件",
    interview: "访谈",
    attachment: "附件",
    note: "笔记",
};

/* ------------------------------------------------------------------ 工具 */

function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/** 链接文字里不能出现未转义的方括号 */
function linkText(s) {
    return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

/** 表格单元格 / 标题里不能出现裸竖线 */
function cell(s) {
    return String(s == null ? "" : s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function clip(s, n) {
    s = String(s == null ? "" : s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * 红豆偶尔把 HTML 塞进标题/摘要里（典型是 UK Biobank 被包成
 * <span style="font-variant:small-caps;">UK</span>），不清掉就会把标签原样插进正文。
 * 这里只去标签、还原常见实体，不动空白与换行。
 */
function stripTags(s) {
    return String(s == null ? "" : s)
        .replace(/<[^>]{1,200}>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .trim();
}

function pad(n) {
    return n < 10 ? "0" + n : String(n);
}

function stamp(d) {
    d = d || new Date();
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function nowText() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件名里不能出现的字符 */
function safeName(s) {
    return String(s == null ? "" : s)
        .replace(/[\\/:*?"<>|#^\[\]\r\n\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function debounce(fn, wait) {
    let t = null;
    return function () {
        const args = arguments;
        clearTimeout(t);
        t = setTimeout(() => fn.apply(null, args), wait);
    };
}

/** 限制并发地跑一组异步任务 */
async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let cursor = 0;
    const workers = new Array(Math.min(limit, list.length || 1)).fill(0).map(async () => {
        while (cursor < list.length) {
            const i = cursor++;
            try {
                out[i] = await fn(list[i], i);
            } catch (err) {
                out[i] = null;
            }
        }
    });
    await Promise.all(workers);
    return out;
}

/**
 * PDF 高亮颜色 → 笔记里的语义标记。
 * 沿用 Zotero 官方 8 色调色板，把颜色变成"为什么划这条"的标签。
 */
const ANNO_COLOR_LABEL = {
    "#ffd400": "🔑 核心",
    "#ff6666": "⚠️ 争议",
    "#5fb236": "✅ 结论",
    "#2ea8e5": "❓ 待查",
    "#a28ae5": "💡 想法",
    "#e56eee": "🧩 关联",
    "#f19837": "📌 方法",
    "#aaaaaa": "· 备注",
};

/** 颜色值 → 标签；未知颜色返回空串 */
function annoColorLabel(color) {
    const c = String(color || "").trim().toLowerCase();
    if (!c) return "";
    const hit = ANNO_COLOR_LABEL[c];
    if (hit) return hit;
    // 有些版本存成不带 # 的 6 位
    if (/^[0-9a-f]{6}$/.test(c)) return ANNO_COLOR_LABEL["#" + c] || "";
    return "";
}

/**
 * 按文献类型分段解析模板。
 * 语法：用独占一行的 [itemType] 分段，未分段的开头部分作为默认模板。
 * 例：
 *   ## {title}          ← 默认（所有类型）
 *   [journalArticle]
 *   ## 期刊论文 {title}
 *   [book]
 *   ## 图书 {title}
 */
function parseTemplateSections(raw, fallback) {
    const s = String(raw || "");
    if (!s.trim()) return { def: String(fallback || ""), byType: {} };
    const byType = {};
    let def = "";
    let cur = null;
    for (const line of s.split(/\r?\n/)) {
        const m = line.match(/^\s*\[([A-Za-z][A-Za-z0-9]*)\]\s*$/);
        if (m) {
            cur = m[1];
            if (byType[cur] === undefined) byType[cur] = "";
            continue;
        }
        if (cur) byType[cur] += line + "\n";
        else def += line + "\n";
    }
    const out = {};
    Object.keys(byType).forEach(k => {
        const v = byType[k].trim();
        if (v) out[k] = v;
    });
    return { def: def.trim() || String(fallback || ""), byType: out };
}

/** 粗粒度 HTML → 纯文本，够用即可 */
function html2text(html) {
    if (!html) return "";
    let s = String(html);
    s = s.replace(/<img[^>]*>/gi, "");
    s = s.replace(/<br\s*\/?>/gi, "\n");
    s = s.replace(/<\/(p|div|h1|h2|h3|h4|h5|h6|li|tr|blockquote)>/gi, "\n");
    s = s.replace(/<li[^>]*>/gi, "- ");
    s = s.replace(/<[^>]+>/g, "");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
}

/** 摘掉思源导出 Markdown 时带的 YAML 头 */
function stripFrontMatter(md) {
    const s = String(md || "");
    if (!/^---\r?\n/.test(s)) return s.trim();
    const end = s.indexOf("\n---", 4);
    if (end < 0) return s.trim();
    return s.slice(end + 4).replace(/^\r?\n+/, "").trim();
}

/* -------------------------------------------------------------- 字段归一 */

function yearFrom(date) {
    if (!date) return "";
    const m = String(date).match(/(1[5-9]\d{2}|20\d{2}|2100)/);
    return m ? m[1] : "";
}

function creatorName(c) {
    if (!c) return "";
    if (c.name) return String(c.name).trim();
    const ln = (c.lastName || "").trim();
    const fn = (c.firstName || "").trim();
    if (!fn) return ln;
    if (!ln) return fn;
    // 中文姓名不加空格：陈 + 昊 → 陈昊
    if (/[\u3400-\u9fff]/.test(ln + fn)) return ln + fn;
    return ln + " " + fn;
}

function firstAuthor(item) {
    const cs = item && item.creators;
    if (!cs || !cs.length) return "";
    return creatorName(cs[0]);
}

function authorsText(item, max) {
    const cs = (item && item.creators) || [];
    max = max || 3;
    const names = cs.slice(0, max).map(creatorName).filter(Boolean);
    if (cs.length > max) names.push("等");
    return names.join(", ");
}

function yearOf(item) {
    if (!item) return "";
    if (item.year) return String(item.year);
    const f = item.fields || {};
    return yearFrom(item.date || f.date || f.year);
}

function pubText(item) {
    if (!item) return "";
    const journal = item.publicationTitle || (item.fields && item.fields.publicationTitle) || "";
    const vol = item.volume || "";
    const issue = item.issue || "";
    const pages = item.pages || "";
    let s = journal;
    if (vol) s += `, ${vol}`;
    if (issue) s += `(${issue})`;
    if (pages) s += `: ${pages}`;
    return s;
}

function typeLabel(t) {
    return TYPE_LABELS[t] || String(t || "");
}

/**
 * 把任意接口返回的条目摊平成插件内部统一结构。
 * 关键点：红豆的 fields 子对象里才有 publicationTitle / volume / issue / pages / date / url 等。
 */
function normalizeItem(raw) {
    if (!raw) return null;
    const id = raw.id != null ? raw.id : raw.itemID;
    if (id == null) return null;
    const f = raw.fields || {};
    const pick = (k) => {
        if (f[k] != null && f[k] !== "") return f[k];
        if (raw[k] != null && raw[k] !== "") return raw[k];
        return "";
    };
    const tags = (Array.isArray(raw.tags) ? raw.tags : []).map(t => {
        if (typeof t === "string") return t;
        if (t && typeof t === "object") return t.name || t.tag || "";
        return "";
    }).filter(Boolean);
    const date = String(pick("date") || "");
    return {
        id: Number(id),
        key: raw.key || "",
        itemType: raw.itemType || "",
        title: stripTags(raw.title || f.title || ""),
        creators: Array.isArray(raw.creators) ? raw.creators : [],
        date: date,
        year: String(raw.year || yearFrom(date) || ""),
        publicationTitle: stripTags(pick("publicationTitle") || pick("bookTitle") || pick("proceedingsTitle")
            || pick("websiteTitle") || pick("blogTitle") || ""),
        journalAbbreviation: String(pick("journalAbbreviation") || ""),
        volume: String(pick("volume") || ""),
        issue: String(pick("issue") || ""),
        pages: String(pick("pages") || ""),
        DOI: String(pick("DOI") || ""),
        url: String(pick("url") || ""),
        ISSN: String(pick("ISSN") || ""),
        PMID: String(pick("PMID") || ""),
        language: String(pick("language") || ""),
        extra: String(pick("extra") || ""),
        abstract: stripTags(raw.abstractNote || f.abstractNote || raw.abstract || ""),
        tags: tags,
        collectionIDs: Array.isArray(raw.collections) ? raw.collections.slice() : [],
        dateAdded: raw.dateAdded || "",
        dateModified: raw.dateModified || "",
        parentItemID: raw.parentItemID == null ? null : raw.parentItemID,
        attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
        notes: Array.isArray(raw.notes) ? raw.notes : [],
        relatedItems: Array.isArray(raw.relatedItems) ? raw.relatedItems : [],
        _hydrated: !!(raw.fields && Object.keys(raw.fields).length),
    };
}

function hasPdf(item) {
    const list = (item && item.attachments) || [];
    return list.some(a => String(a.contentType || "").indexOf("pdf") >= 0);
}

/* ------------------------------------------------------------ 引用：工具 */

/**
 * 取姓氏。红豆里的西文条目常见 firstName / lastName 录反
 * （lastName 只有一两个字母、firstName 才是真姓），这里做个启发式纠正；
 * fieldMode === 1 表示 Zotero 的单字段姓名，整串就是一个完整名称。
 */
function surnameOf(c) {
    if (!c) return "";
    const ln = String(c.lastName || "").trim();
    const fn = String(c.firstName || "").trim();
    const single = String(c.name || "").trim();
    if (!ln && !fn) return single;
    if (!ln) return fn;
    if (!fn) return ln;
    if (Number(c.fieldMode) === 1) return ln;
    if (ZH_RE.test(ln)) return ln;
    const lnAscii = ln.replace(/[^A-Za-z]/g, "");
    const fnAscii = fn.replace(/[^A-Za-z]/g, "");
    if (lnAscii.length <= 2 && fnAscii.length > 3) {
        // A.-O. K. → 取第一个词
        return fn.split(/[\s,]+/).filter(Boolean)[0] || ln;
    }
    return ln;
}

/** 只取作者（creatorTypeID 1 = author），没有标注时退回全部创建者 */
function authorsOf(item) {
    const all = (item && item.creators) || [];
    const only = all.filter(c => {
        if (c.creatorType) return /^author$/i.test(String(c.creatorType));
        if (c.creatorTypeID != null) return Number(c.creatorTypeID) === 1;
        return true;
    });
    return only.length ? only : all;
}

function citeAuthorOf(item) {
    const list = authorsOf(item);
    if (!list.length) return { name: "", count: 0, list: [] };
    return { name: surnameOf(list[0]), count: list.length, list: list };
}

/** 中文作者用「等」，西文用 et al.；两位作者用「和 / &」 */
function citeWho(item) {
    const a = citeAuthorOf(item);
    const zh = ZH_RE.test(a.name || "") || (!a.name && ZH_RE.test(String(item.title || "")));
    if (!a.name) return zh ? "佚名" : "Anon.";
    if (a.count === 2) return a.name + (zh ? "和" : " & ") + surnameOf(a.list[1]);
    if (a.count > 2) return a.name + (zh ? "等" : " et al.");
    return a.name;
}

/** 样式是数字式还是作者年式；override 为 auto 时按样式名猜 */
function isNumericStyle(style, override) {
    if (override === "numeric") return true;
    if (override === "authorDate") return false;
    const s = String((style && ((style.styleID || "") + " " + (style.title || ""))) || "").toLowerCase();
    if (!s.trim()) return false;
    // 中文样式名最直白
    if (s.indexOf("顺序编码") >= 0) return true;
    if (s.indexOf("著者") >= 0 || s.indexOf("出版年") >= 0) return false;
    // 作者年特征先判：它比数字式更不容易误伤
    for (const k of AUTHOR_DATE_HINT) if (s.indexOf(k) >= 0) return false;
    for (const k of NUMERIC_HINT) if (s.indexOf(k) >= 0) return true;
    return false;
}

/** BibTeX / 文件名用的 ASCII 片段 */
function asciiSlug(s) {
    return String(s == null ? "" : s).toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]/g, "");
}

/**
 * 引用键：优先用 Better BibTeX 写进 Extra 的 Citation Key，
 * 没有就按可配置的格式现造一个（纯 ASCII，供 LaTeX / Typst 用）。
 * 中文条目没有可转的字母，退回 zh<id><year>，至少短且唯一。
 * fmt 支持 {author} {year} {title} 占位符，默认 "{author}{year}{title}"。
 */
function citeKeyOf(item, fmt) {
    const extra = String((item && item.extra) || "");
    const m = extra.match(/Citation\s*Key\s*:\s*([^\s,;]+)/i);
    if (m) return m[1];
    if (item && item.citationKey) return String(item.citationKey);
    const a = citeAuthorOf(item || {});
    const y = yearOf(item) || "nd";
    const who = asciiSlug(a.name);
    if (!who) {
        return ("zh" + (item && item.id != null ? item.id : "") + y).toLowerCase();
    }
    let head = asciiSlug(String((item && item.title) || "").split(/\s+/)[0] || "");
    if (head.length > 16) head = head.slice(0, 16);
    const pat = String(fmt || "{author}{year}{title}");
    let out = pat.replace(/\{author\}/g, who).replace(/\{year\}/g, y).replace(/\{title\}/g, head);
    // 去掉不认识的占位符与非法字符，只留字母数字和下划线/连字符
    out = out.replace(/\{[a-z]+\}/gi, "").replace(/[^a-z0-9_-]/gi, "");
    if (!out) out = who + y + head;
    return out.slice(0, 64).toLowerCase();
}

/** 同作者同一年出现多篇时，按出现顺序补 a / b / c（APA、GB/T 著者-出版年都要） */
function yearSuffixMap(list) {
    const buckets = new Map();
    (list || []).forEach(it => {
        const k = citeAuthorOf(it).name + "|" + yearOf(it);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(it);
    });
    const out = new Map();
    buckets.forEach(arr => {
        if (arr.length < 2) { arr.forEach(it => out.set(itemKey(it), "")); return; }
        arr.forEach((it, i) => out.set(itemKey(it), String.fromCharCode(97 + Math.min(i, 25))));
    });
    return out;
}

/** [1,3,4,5] → "1,3-5" */
function compressNums(nums) {
    const list = Array.from(new Set(nums.filter(n => n > 0))).sort((a, b) => a - b);
    const out = [];
    let i = 0;
    while (i < list.length) {
        let j = i;
        while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
        if (j - i >= 2) out.push(list[i] + "-" + list[j]);
        else for (let k = i; k <= j; k++) out.push(String(list[k]));
        i = j + 1;
    }
    return out.join(",");
}

/** 条目在文档引用里对应的 key（红豆侧 key 变了也能对上原文） */
function itemKey(it) {
    return (it && (it._k || it.key)) || "";
}

/**
 * 一处引用（可能合并多篇）的正文标签。
 * opts: { numeric, nums:Map(key→序号), suffix:Map(key→后缀), narrative }
 */
function citeText(list, opts) {
    const items = (list || []).filter(Boolean);
    if (!items.length) return "";
    const numeric = !!opts.numeric;
    const narr = !!opts.narrative && !numeric;
    if (numeric) {
        const nums = items.map(it => (opts.nums && opts.nums.get(itemKey(it))) || 0);
        return "[" + (compressNums(nums) || "?") + "]";
    }
    const parts = items.map(it => {
        const who = it._who || citeWho(it);
        const y = (yearOf(it) || "n.d.") + ((opts.suffix && opts.suffix.get(itemKey(it))) || "");
        return narr ? `${who} (${y})` : `${who}, ${y}`;
    });
    if (narr && parts.length === 1) return parts[0];
    return "(" + parts.join("; ") + ")";
}

/** 生成正文引用链接；keys 第一项作主键，其余进 zkeys；i= 记录条目 ID 供重排反查 */
function citeMarkdown(items, opts) {
    const keys = items.map(it => it.key).filter(Boolean);
    if (!keys.length) return "";
    const text = citeText(items, opts);
    const scheme = opts.scheme === "zotero" ? "zotero" : "hongdou";
    const q = ["f=" + (opts.narrative && !opts.numeric ? "narr" : (opts.numeric ? "num" : "csl"))];
    if (items[0] && items[0].id) q.push("i=" + items[0].id);
    if (keys.length > 1) q.push("zkeys=" + keys.slice(1).join(","));
    const url = `${scheme}://select/library/items/${keys[0]}?${q.join("&")}`;
    const body = `[${linkText(text)}](${url})`;
    return opts.superscript && opts.numeric ? `<sup>${body}</sup>` : body;
}

/** 解析链接 query：形态、条目 ID、额外 keys */
function parseCiteQuery(q) {
    const out = { form: "csl", keys: [], id: 0 };
    String(q || "").replace(/^\?/, "").split("&").forEach(kv2 => {
        if (!kv2) return;
        const i = kv2.indexOf("=");
        const k = i < 0 ? kv2 : kv2.slice(0, i);
        const v = i < 0 ? "" : decodeURIComponent(kv2.slice(i + 1));
        if (k === "f") out.form = v || "csl";
        else if (k === "zkeys") out.keys = v.split(",").map(s => s.trim()).filter(Boolean);
        else if (k === "i") out.id = Number(v) || 0;
        else if (k === "bib") out.bib = v === "1" || v === "";
    });
    return out;
}

/**
 * 扫一段 markdown / kramdown 里的引用链接。
 * 返回按出现顺序的数组，每项带 key 列表、形态、条目 ID、以及是否属于文末条目（?bib=1）。
 */
function scanCites(md) {
    const out = [];
    const s = String(md || "");
    CITE_RE.lastIndex = 0;
    let m;
    while ((m = CITE_RE.exec(s))) {
        const q = parseCiteQuery(m[3]);
        const keys = [m[2]].concat(q.keys).filter(Boolean);
        out.push({
            raw: m[0],
            text: m[1].replace(/\\([\[\]\\])/g, "$1"),
            key: m[2],
            keys: keys,
            id: q.id || 0,
            query: m[3] || "",
            form: q.form,
            bib: !!q.bib,
            start: m.index,
            end: m.index + m[0].length,
        });
    }
    return out;
}

/** 把 markdown 里的引用链接整段替换成 replacer 返回的新串 */
function replaceCites(md, replacer) {
    const s = String(md || "");
    let out = "";
    let last = 0;
    CITE_RE.lastIndex = 0;
    let m;
    while ((m = CITE_RE.exec(s))) {
        const q = parseCiteQuery(m[3]);
        const keys = [m[2]].concat(q.keys).filter(Boolean);
        const hit = {
            raw: m[0], text: m[1].replace(/\\([\[\]\\])/g, "$1"), key: m[2],
            keys: keys, query: m[3] || "", form: q.form, bib: !!q.bib,
        };
        const rep = replacer(hit);
        out += s.slice(last, m.index) + (rep == null ? m[0] : String(rep));
        last = m.index + m[0].length;
    }
    return out + s.slice(last);
}

/**
 * 思源里以「1. 」开头的行会被当成有序列表。
 * 参考文献条目遇到数字式前缀时转义句点，保持纯文本。
 */
function escapeOl(line) {
    return String(line || "").replace(/^(\s*)(\d{1,3})\.(\s|$)/, "$1$2\\.$3");
}

/* ---------------------------------------------------------- 引用导出：格式 */

const RIS_TYPES = {
    journalArticle: "JOUR", magazineArticle: "MGZN", newspaperArticle: "NEWS",
    book: "BOOK", bookSection: "CHAP", conferencePaper: "CONF", thesis: "THES",
    report: "RPRT", patent: "PAT", webpage: "ELEC", blogPost: "BLOG",
    preprint: "UNPB", dataset: "DATA", standard: "STAND", manuscript: "MANSCPT",
    document: "GEN", presentation: "SLIDE", computerProgram: "COMP", map: "MAP",
    artwork: "ART", audioRecording: "SOUND", videoRecording: "VIDEO",
    film: "MPCT", letter: "LETT", interview: "INTV",
};

const CSL_TYPES = {
    journalArticle: "article-journal", magazineArticle: "article-magazine",
    newspaperArticle: "article-newspaper", book: "book", bookSection: "chapter",
    conferencePaper: "paper-conference", thesis: "thesis", report: "report",
    patent: "patent", webpage: "webpage", blogPost: "post-weblog",
    preprint: "article", dataset: "dataset", standard: "standard",
    manuscript: "manuscript", presentation: "speech", map: "map",
    computerProgram: "software", interview: "interview", letter: "personal_communication",
    audioRecording: "song", videoRecording: "motion_picture", film: "motion_picture",
};

function risName(c) {
    const ln = String((c && c.lastName) || "").trim();
    const fn = String((c && c.firstName) || "").trim();
    if (!ln && !fn) return String((c && c.name) || "").trim();
    if (Number(c.fieldMode) === 1) return ln || fn;
    if (!fn) return ln;
    if (!ln) return fn;
    if (ZH_RE.test(ln)) return ln + fn;
    return ln + ", " + fn;
}

function risLine(tag, val) {
    const v = String(val == null ? "" : val).replace(/[\r\n]+/g, " ").trim();
    return v ? `${tag}  - ${v}` : "";
}

/** RIS：EndNote / NoteExpress / 红豆都能直接导入 */
function toRIS(items, keyFmt) {
    const blocks = (items || []).map(it => {
        const rows = ["TY  - " + (RIS_TYPES[it.itemType] || "GEN")];
        authorsOf(it).forEach(c => {
            const n = risName(c);
            if (n) rows.push(risLine("AU", n));
        });
        rows.push(risLine("TI", it.title));
        rows.push(risLine(it.itemType === "book" ? "PB" : "JO", it.publicationTitle));
        rows.push(risLine("PY", yearOf(it)));
        // PY 已经是年份时不再重复写 DA，只有完整日期才补
        if (/[-\/]/.test(String(it.date || ""))) rows.push(risLine("DA", it.date));
        rows.push(risLine("VL", it.volume));
        rows.push(risLine("IS", it.issue));
        const pg = String(it.pages || "");
        if (pg) {
            const seg = pg.split(/[-–—~]/);
            rows.push(risLine("SP", seg[0]));
            if (seg[1]) rows.push(risLine("EP", seg[1]));
        }
        rows.push(risLine("DO", it.DOI));
        rows.push(risLine("UR", it.url));
        rows.push(risLine("SN", it.ISSN));
        (it.tags || []).filter(t => t && t.charAt(0) !== "/").forEach(t => rows.push(risLine("KW", t)));
        if (it.abstract) rows.push(risLine("AB", clip(it.abstract, 900)));
        rows.push(risLine("ID", citeKeyOf(it, keyFmt)));
        rows.push("ER  - ");
        return rows.filter(Boolean).join("\r\n");
    });
    return blocks.join("\r\n\r\n") + (blocks.length ? "\r\n" : "");
}

/** CSL-JSON：Pandoc / Quarto / citeproc 直接吃 */
function toCSLJSON(items, keyFmt) {
    return (items || []).map(it => {
        const o = {
            id: citeKeyOf(it, keyFmt),
            type: CSL_TYPES[it.itemType] || "document",
            title: it.title || "",
        };
        const au = authorsOf(it).map(c => {
            const ln = String((c && c.lastName) || "").trim();
            const fn = String((c && c.firstName) || "").trim();
            if (Number(c.fieldMode) === 1 || (!fn && ln)) return { literal: ln || fn };
            if (ZH_RE.test(ln)) return { family: ln, given: fn };
            if (!ln) return { literal: fn };
            return { family: ln, given: fn };
        }).filter(x => x.family || x.literal);
        if (au.length) o.author = au;
        const y = yearOf(it);
        if (y) o.issued = { "date-parts": [[Number(y)]] };
        if (it.publicationTitle) o["container-title"] = it.publicationTitle;
        if (it.volume) o.volume = it.volume;
        if (it.issue) o.issue = it.issue;
        if (it.pages) o.page = it.pages;
        if (it.DOI) o.DOI = it.DOI;
        if (it.url) o.URL = it.url;
        if (it.ISSN) o.ISSN = it.ISSN;
        if (it.abstract) o.abstract = it.abstract;
        const kw = (it.tags || []).filter(t => t && t.charAt(0) !== "/");
        if (kw.length) o.keyword = kw.join(", ");
        return o;
    });
}

/** Markdown 表格：方便直接贴进综述初稿 */
function toMdTable(items) {
    const rows = ["| 年份 | 作者 | 标题 | 来源 | DOI |", "| --- | --- | --- | --- | --- |"];
    (items || []).forEach(it => {
        rows.push(`| ${cell(yearOf(it))} | ${cell(clip(authorsText(it, 3), 40))} | ${cell(it.title || "")} | ${cell(clip(pubText(it), 50))} | ${cell(it.DOI || "")} |`);
    });
    return rows.join("\n");
}

/**
 * 正文引用命令：供 LaTeX / Typst 写作直接粘贴。
 * 每行一条，含 citekey 与标题，便于按需取用。
 */
function toCiteCommands(items, keyFmt) {
    const list = (items || []).filter(Boolean);
    const keys = list.map(it => citeKeyOf(it, keyFmt));
    const out = [];
    out.push("```latex");
    out.push("\\cite{" + keys.join(",") + "}      % 数字式引用");
    out.push("\\parencite{" + keys.join(",") + "}   % 作者-年份引用");
    out.push("\\textcite{" + keys.join(",") + "}    % 叙述式：Author (Year)");
    out.push("```");
    out.push("");
    out.push("```typst");
    out.push("@key " + keys.join(", ").replace(/([a-z0-9_-]+)/g, "@$1"));
    out.push("```");
    out.push("");
    list.forEach((it, i) => out.push(`// ${keys[i]}  =  ${clip(it.title || "", 60)}`));
    return out.join("\n");
}

async function copyText(txt) {
    const s = String(txt == null ? "" : txt);
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(s);
            return true;
        }
    } catch (err) { /* 退回到 execCommand */ }
    try {
        const ta = document.createElement("textarea");
        ta.value = s;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        return !!ok;
    } catch (err) {
        return false;
    }
}

function downloadText(txt, name) {
    try {
        const blob = new Blob([String(txt == null ? "" : txt)], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        return true;
    } catch (err) {
        return false;
    }
}

/* -------------------------------------------------------- 红豆 MCP 客户端 */

class HongdouClient {
    constructor(endpoint) {
        this.endpoint = (endpoint || "").trim() || DEFAULTS.endpoint;
        this._seq = 0;
        this._sid = "";
        this._ready = false;
        this.serverInfo = null;
        this._items = new Map();
        this._coll = null;
        this._collAt = 0;
        this._styles = null;
    }

    setEndpoint(ep) {
        const v = (ep || "").trim() || DEFAULTS.endpoint;
        if (v !== this.endpoint) {
            this.endpoint = v;
            this._ready = false;
            this._sid = "";
            this._items.clear();
            this._coll = null;
            this._styles = null;
        }
    }

    async _rpc(method, params, timeout) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout || 25000);
        const id = ++this._seq;
        try {
            const headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "MCP-Protocol-Version": "2024-11-05",
            };
            if (this._sid) headers["Mcp-Session-Id"] = this._sid;
            const resp = await fetch(this.endpoint, {
                method: "POST",
                headers,
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} }),
                signal: ctrl.signal,
            });
            const sid = resp.headers.get("Mcp-Session-Id");
            if (sid) this._sid = sid;
            const text = await resp.text();
            if (!resp.ok) throw new Error(`红豆接口返回 HTTP ${resp.status}`);
            const ct = resp.headers.get("Content-Type") || "";
            let msg = null;
            if (ct.indexOf("event-stream") >= 0) {
                text.split(/\r?\n/).forEach(line => {
                    if (!line.startsWith("data:")) return;
                    const raw = line.slice(5).trim();
                    if (!raw) return;
                    try {
                        const o = JSON.parse(raw);
                        if (o && o.id === id) msg = o;
                    } catch (e) { /* 忽略心跳等非 JSON 行 */ }
                });
            } else {
                try {
                    msg = JSON.parse(text);
                } catch (e) {
                    throw new Error("红豆接口返回无法解析：" + clip(text, 120));
                }
            }
            if (!msg) throw new Error("红豆接口返回空响应");
            if (msg.error) throw new Error(msg.error.message || "红豆接口报错");
            return msg.result || {};
        } catch (err) {
            if (err && err.name === "AbortError") throw new Error("红豆接口超时，请确认红豆正在运行");
            if (err instanceof TypeError) {
                throw new Error(`连不上红豆（${this.endpoint}）。请确认红豆已启动，并在 红豆 → 设置 → MCP 服务 中开启本地服务`);
            }
            throw err;
        } finally {
            clearTimeout(timer);
        }
    }

    async init(force) {
        if (this._ready && !force) return this.serverInfo;
        const r = await this._rpc("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "hongdou-for-siyuan", version: VERSION },
        });
        this._ready = true;
        this.serverInfo = r.serverInfo || {};
        return this.serverInfo;
    }

    async call(name, args, timeout) {
        await this.init();
        const res = await this._rpc("tools/call", { name, arguments: args || {} }, timeout);
        if (res.structuredContent) return res.structuredContent;
        let payload = null;
        const content = res.content || [];
        for (let i = 0; i < content.length; i++) {
            if (content[i].type === "text") {
                try {
                    payload = JSON.parse(content[i].text);
                } catch (e) {
                    payload = content[i].text;
                }
                break;
            }
        }
        if (res.isError) {
            throw new Error(typeof payload === "string" ? payload : (payload && payload.message) || "红豆接口执行失败");
        }
        return payload == null ? {} : payload;
    }

    status() { return this.call("hongdou_get_status", {}, 10000); }

    /**
     * 检索。field=all 走关键词检索，其余走高级检索。
     */
    async search(q, opt) {
        opt = opt || {};
        const limit = opt.limit || 40;
        const field = opt.field || "all";
        if (field !== "all" && q) {
            const args = { limit: limit };
            if (field === "title") args.title = q;
            else if (field === "creator") args.creator = q;
            else if (field === "year") args.year = q;
            else if (field === "publication") args.publicationTitle = q;
            else if (field === "tag") args.tags = [q];
            const r = await this.call("hongdou_advanced_search", args, 45000);
            return r;
        }
        return this.call("hongdou_search_items", { query: q, limit: limit }, 45000);
    }

    async listItems(opt) {
        opt = opt || {};
        const args = { limit: opt.limit || 60 };
        if (opt.collectionID) args.collectionID = opt.collectionID;
        if (opt.cursor) args.cursor = opt.cursor;
        if (opt.includeChildren) args.includeChildren = true;
        return this.call("hongdou_list_items", args, 45000);
    }

    async collectionItems(collectionID, opt) {
        opt = opt || {};
        const args = { collectionID: collectionID, limit: opt.limit || 60, recursive: true };
        if (opt.cursor) args.cursor = opt.cursor;
        return this.call("hongdou_get_collection_items", args, 45000);
    }

    async getItem(id) {
        const raw = await this.call("hongdou_get_item", { itemID: id }, 30000);
        return normalizeItem(raw);
    }

    /** 补全条目字段（带缓存），列表/当前选中这类精简结构必须过这一道 */
    async hydrate(item) {
        if (!item) return item;
        if (item._hydrated && item.creators && item.creators.length) return item;
        const hit = this._items.get(item.id);
        if (hit && Date.now() - hit.t < CACHE_TTL) return hit.item;
        try {
            const full = await this.getItem(item.id);
            if (!full) return item;
            const merged = Object.assign({}, item, full);
            // 精简结构里的 title 更可信时保留
            if (!merged.title && item.title) merged.title = item.title;
            this._items.set(item.id, { t: Date.now(), item: merged });
            return merged;
        } catch (err) {
            return item;
        }
    }

    async hydrateAll(items) {
        const list = (items || []).slice();
        const out = await mapLimit(list, HYDRATE_CONCURRENCY, (it) => this.hydrate(it));
        return out.map((x, i) => x || list[i]);
    }

    /** 分类树 + 扁平索引，5 分钟缓存 */
    async collections(force) {
        if (!force && this._coll && Date.now() - this._collAt < CACHE_TTL) return this._coll;
        const r = await this.call("hongdou_get_collections", {}, 30000);
        const tree = r.collections || [];
        const flat = new Map();
        const walk = (nodes, path, depth) => {
            (nodes || []).forEach(n => {
                const p = path ? path + " / " + n.name : n.name;
                flat.set(n.id, {
                    id: n.id, name: n.name, key: n.key, count: n.itemCount || 0,
                    path: p, depth: depth, parentID: n.parentID,
                });
                if (n.children && n.children.length) walk(n.children, p, depth + 1);
            });
        };
        walk(tree, "", 0);
        this._coll = { tree: tree, flat: flat, total: r.totalCollections || flat.size };
        this._collAt = Date.now();
        return this._coll;
    }

    async collectionPath(ids) {
        if (!ids || !ids.length) return [];
        let c = null;
        try {
            c = await this.collections();
        } catch (err) {
            return [];
        }
        return ids.map(id => (c.flat.get(id) || {}).path).filter(Boolean);
    }

    getNotes(id) { return this.call("hongdou_get_notes", { itemID: id, limit: 100 }, 40000); }
    getAnnotations(id) { return this.call("hongdou_get_annotations", { itemID: id }, 60000); }
    getAttachments(id) { return this.call("hongdou_get_attachments", { itemID: id, limit: 100 }, 30000); }
    focus() { return this.call("hongdou_get_ui_focus", { limit: 20 }, 10000); }

    async styles() {
        if (this._styles) return this._styles;
        const r = await this.call("hongdou_get_citation_styles", { limit: 200, hasBibliography: true }, 30000);
        this._styles = (r && r.styles) || [];
        this._stylesDefault = (r && r.defaultStyleID) || "";
        this._localeDefault = (r && r.defaultLocale) || "";
        return this._styles;
    }

    /** 样式元信息（默认样式 ID / 默认语言），顺带把样式列表拉一遍 */
    async styleMeta() {
        await this.styles().catch(() => null);
        return { defaultStyleID: this._stylesDefault || "", locale: this._localeDefault || "", list: this._styles || [] };
    }

    formatBibliography(ids, styleID, opt) {
        const args = { itemIDs: ids, format: (opt && opt.format) || "text" };
        if (styleID) args.styleID = styleID;
        if (opt && opt.locale) args.locale = opt.locale;
        return this.call("hongdou_format_bibliography", args, 60000);
    }

    bibtex(ids) {
        return this.call("hongdou_export_to_bibtex", { itemIDs: ids }, 40000);
    }

    citationCounts(ids) {
        return this.call("hongdou_get_citation_counts", { itemIDs: ids }, 40000);
    }

    /** 在红豆里新建笔记（双向联动的写入端） */
    createNote(itemID, content, tags) {
        const args = { itemID: itemID, content: content };
        if (tags && tags.length) args.tags = tags;
        return this.call("hongdou_create_note", args, 40000);
    }

    updateNote(noteID, content) {
        return this.call("hongdou_update_note", { noteID: noteID, content: content }, 40000);
    }

    /** 高危操作：先拿确认令牌，再带令牌执行 */
    manageCollections(itemIDs, add, remove) {
        const args = { itemIDs: itemIDs };
        if (add && add.length) args.addToCollections = add;
        if (remove && remove.length) args.removeFromCollections = remove;
        return this.call("hongdou_manage_collections", args, 40000);
    }

    confirmCollections(args, token) {
        const a = Object.assign({}, args, { confirmationToken: token });
        return this.call("hongdou_manage_collections", a, 40000);
    }

    batchTags(itemIDs, add, remove) {
        const args = { itemIDs: itemIDs };
        if (add && add.length) args.addTags = add;
        if (remove && remove.length) args.removeTags = remove;
        return this.call("hongdou_batch_update_tags", args, 40000);
    }

    confirmTags(args, token) {
        const a = Object.assign({}, args, { confirmationToken: token });
        return this.call("hongdou_batch_update_tags", a, 40000);
    }
}

/* -------------------------------------------------------------- 红豆桥接端 */

/**
 * 红豆端 bridge 客户端。
 * 走思源 /api/network/forwardProxy 代理，绕开 CORS / CSP 限制。
 * 对应红豆里的 hongdou-siyuan-bridge 插件，默认监听 18501。
 */
class BridgeClient {
    constructor(port) {
        this.port = Number(port) || 18501;
        this.token = "";
    }

    get base() {
        return `http://127.0.0.1:${this.port}`;
    }

    async _req(path, method, body, timeout) {
        const headers = [];
        if (this.token) headers.push({ "X-Hongdou-Token": this.token });
        const r = await kernel("/api/network/forwardProxy", {
            url: this.base + path,
            method: method || "GET",
            timeout: timeout || 6000,
            contentType: "application/json",
            headers: headers,
            payload: body ? JSON.stringify(body) : "",
            payloadEncoding: "text",
            responseEncoding: "text",
        });
        if (!r) throw new Error("红豆桥接无响应");
        if (r.status < 200 || r.status >= 300) {
            let msg = "";
            try { msg = (JSON.parse(r.body) || {}).message || ""; } catch (err) { /* 忽略 */ }
            const e = new Error(msg || ("红豆桥接返回 " + r.status));
            e.status = r.status;
            throw e;
        }
        try {
            return JSON.parse(r.body);
        } catch (err) {
            throw new Error("红豆桥接返回的不是 JSON");
        }
    }

    ping() { return this._req("/ping", "GET", null, 3000); }
    pair(code) { return this._req("/pair", "POST", { code: code }, 8000); }
    pending(keep) { return this._req("/pending?keep=" + (keep ? 1 : 0), "GET", null, 8000); }
    queue() { return this._req("/queue", "GET", null, 4000); }
    attachments(id) { return this._req("/attachments?id=" + encodeURIComponent(id), "GET", null, 10000); }
}

/**
 * 把 bridge 返回的条目转成 normalizeItem 认得的结构。
 * 关键：造出 fields，让 normalizeItem 判定 _hydrated，从而跳过 MCP 二次补全。
 */
function adaptBridgeItem(b) {
    if (!b || !b.itemID) return null;
    return normalizeItem({
        id: b.itemID,
        itemID: b.itemID,
        key: b.key || "",
        itemType: b.itemType || "",
        title: b.title || "",
        creators: (b.creators || []).map(c => ({
            firstName: c.firstName || "",
            lastName: c.lastName || "",
            name: c.name || "",
            creatorType: c.creatorType || "author",
        })),
        date: b.date || "",
        year: b.year || "",
        fields: {
            title: b.title || "",
            date: b.date || "",
            publicationTitle: b.publication || b.journal || "",
            volume: b.volume || "",
            issue: b.issue || "",
            pages: b.pages || "",
            DOI: b.doi || "",
            ISBN: b.isbn || "",
            ISSN: b.issn || "",
            url: b.url || "",
            language: b.language || "",
            publisher: b.publisher || "",
            abstractNote: b.abstract || "",
        },
        tags: b.tags || [],
        attachments: (b.attachments || []).map(a => ({
            itemID: a.itemID,
            key: a.key,
            title: a.title,
            contentType: a.contentType,
            path: a.path,
            exists: a.exists,
        })),
        collections: [],
        abstractNote: b.abstract || "",
    });
}

/* --------------------------------------------------------------- 思源内核 */

async function kernel(path, payload) {
    const res = await fetchSyncPost(path, payload || {});
    if (!res) throw new Error("思源内核无响应：" + path);
    if (res.code !== 0) throw new Error(res.msg || "思源接口出错：" + path);
    return res.data;
}

/** 取单个块的 kramdown（对顶层块会连子块一起返回） */
async function blockKramdown(id) {
    try {
        const r = await kernel("/api/block/getBlockKramdown", { id: id });
        return (r && r.kramdown) || "";
    } catch (err) {
        return "";
    }
}

/** 顶层块列表（文档顺序） */
async function topBlocks(docId) {
    try {
        const r = await kernel("/api/block/getChildBlocks", { id: docId });
        return Array.isArray(r) ? r : [];
    } catch (err) {
        return [];
    }
}

async function updateBlockMd(id, md) {
    return kernel("/api/block/updateBlock", { id: id, dataType: "markdown", data: md });
}

async function deleteBlockById(id) {
    try {
        await kernel("/api/block/deleteBlock", { id: id });
        return true;
    } catch (err) {
        return false;
    }
}

/** 从 insertBlock / appendBlock 的返回里抽出新块 ID */
function txIds(ret) {
    const out = [];
    (Array.isArray(ret) ? ret : []).forEach(t => {
        ((t && t.doOperations) || []).forEach(op => {
            if (op && op.id && (!op.action || /insert/i.test(op.action))) out.push(op.id);
        });
    });
    return out;
}

function kv(k, v) {
    return `| ${cell(k)} | ${cell(v)} |`;
}

/** Setting 回调在不同版本里可能给值，也可能给事件 */
function valOf(v) {
    return (v && v.target && typeof v.target.value === "string") ? v.target.value : (v == null ? "" : String(v));
}

function boolOf(v) {
    return (v && v.target && "checked" in v.target) ? !!v.target.checked : !!v;
}

/** 内置阅读笔记模板 */
const NOTE_TEMPLATE = [
    "| 项目 | 内容 |",
    "| --- | --- |",
    "| 作者 | {authors} |",
    "| 期刊 | {pub} |",
    "| 年份 | {year} |",
    "| 类型 | {type} |",
    "| DOI | {doilink} |",
    "| 分类 | {collections} |",
    "| 标签 | {hashtags} |",
    "| 红豆 | {link} |",
    "",
    "## 一句话总结",
    "",
    "## 研究问题",
    "",
    "## 方法与数据",
    "",
    "## 主要结果",
    "",
    "## 局限与可质疑处",
    "",
    "## 可引用原句",
    "",
    "## 我的思考",
    "",
    "## 红豆材料",
    "",
].join("\n");



/* --------------------------------------------------------------- 主插件 */

class HongdouPlugin extends Plugin {
    async onload() {
        this.client = new HongdouClient(DEFAULTS.endpoint);
        this.data = Object.assign({}, DEFAULTS);
        this._activeEditor = null;
        this._dialog = null;
        this._savedRange = null;
        // 撤销栈：docId → [{ ts, blocks:[{id, md}] }]，每篇独立，最多 20 步
        this._undoStack = new Map();

        this.addIcons(`<symbol id="iconHongdou" viewBox="0 0 32 32">
<path d="M6 5.5A2.5 2.5 0 0 1 8.5 3H25a1 1 0 0 1 1 1v21.5a1 1 0 0 1-1 1H8.5A2.5 2.5 0 0 0 6 28V5.5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
<path d="M6 24.5A2.5 2.5 0 0 1 8.5 22H26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
<path d="M12 9.5h8M12 14h8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</symbol>`);

        const saved = await this.loadData("settings.json");
        if (saved && typeof saved === "object") Object.assign(this.data, saved);
        this.client.setEndpoint(this.data.endpoint);

        this.registerCommands();
        this.registerTopBar();
        this.registerLinkHandler();
        this.registerSlash();

        // 红豆桥接：连上红豆端的 bridge 插件，接收「发送到思源」
        this.initBridge();

        // 首次启用：等内核与红豆都就绪再弹引导，避免初始化时抢焦点
        if (!this.data.welcomed) {
            setTimeout(() => { this.showWelcome(false); }, 4000);
        }
    }

    /* ------------------------------------------------------------ 红豆桥接 */

    /** 初始化 bridge 客户端并开始轮询 */
    initBridge() {
        this.bridge = new BridgeClient(this.data.bridgePort);
        this.bridge.token = this.data.bridgeToken || "";
        this._bridgeQueue = 0;
        this._bridgeBusy = false;
        this._bridgeOnline = false;
        this.startBridgeWatch();
    }

    /** 起/重起轮询定时器 */
    startBridgeWatch() {
        this.stopBridgeWatch();
        const sec = Math.min(30, Math.max(2, Number(this.data.bridgePollSec) || 3));
        this._bridgeTimer = setInterval(() => {
            this.pollBridge().catch(() => null);
        }, sec * 1000);
        // 启动后先探一次
        setTimeout(() => { this.pollBridge().catch(() => null); }, 1200);
    }

    stopBridgeWatch() {
        if (this._bridgeTimer) {
            clearInterval(this._bridgeTimer);
            this._bridgeTimer = null;
        }
    }

    /** 每次轮询：看队列有没有新文献，有就拉下来落笔 */
    async pollBridge() {
        if (!this.bridge || this._bridgeBusy) return;
        if (!this.bridge.token) {
            // 没配对也要探一下在线状态，方便设置面板显示
            try {
                const p = await this.bridge.ping();
                this._bridgeOnline = !!(p && p.ok);
                this.updateBridgeBadge();
            } catch (err) {
                this._bridgeOnline = false;
                this.updateBridgeBadge();
            }
            return;
        }
        this._bridgeBusy = true;
        try {
            const q = await this.bridge.queue();
            this._bridgeOnline = !!(q && q.ok);
            const cnt = (q && q.count) || 0;
            const changed = cnt !== this._bridgeQueue;
            this._bridgeQueue = cnt;
            if (changed) this.updateBridgeBadge();

            if (cnt > 0 && this.data.bridgeAutoInsert && this.activeEditor) {
                await this.pullBridgeQueue(true);
            } else if (cnt > 0) {
                this.updateBridgeBadge();
            }
        } catch (err) {
            this._bridgeOnline = false;
            this.updateBridgeBadge();
        } finally {
            this._bridgeBusy = false;
        }
    }

    /** 拉取队列并插入。silent=true 时不打扰用户 */
    async pullBridgeQueue(silent) {
        if (!this.bridge) throw new Error("红豆桥接未初始化");
        if (!this.bridge.token) {
            showMessage(this.i18n.bridgeNeedPair || "还没和红豆配对，请先在设置里输入配对码", 5000, "error");
            return;
        }
        const r = await this.bridge.pending(false);
        const raw = (r && r.items) || [];
        const items = raw.map(adaptBridgeItem).filter(Boolean);
        this._bridgeQueue = 0;
        this.updateBridgeBadge();
        if (!items.length) {
            if (!silent) showMessage(this.i18n.bridgeEmpty || "红豆待发送队列是空的", 3000);
            return;
        }
        if (!this.activeEditor) {
            // 没有活动编辑器就放回队列，避免丢任务
            showMessage(this.i18n.bridgeNoEditor || "先把光标放到正文里，再从红豆发送", 5000, "error");
            return;
        }
        await this.insertCitation(items);
        showMessage((this.i18n.bridgeInserted || "已从红豆插入 %n 篇文献").replace("%n", items.length), 3000);
    }

    /** 顶栏图标上的小红点 */
    updateBridgeBadge() {
        const el = this._topBarEl;
        if (!el) return;
        try {
            let dot = el.querySelector(".hd-badge");
            const n = this._bridgeQueue;
            if (n > 0) {
                if (!dot) {
                    dot = document.createElement("span");
                    dot.className = "hd-badge";
                    el.appendChild(dot);
                }
                dot.textContent = n > 99 ? "99+" : String(n);
                dot.style.display = "";
            } else if (dot) {
                dot.style.display = "none";
            }
            el.classList.toggle("hd-offline", !this._bridgeOnline && !!this.bridge && !!this.bridge.token);
        } catch (err) { /* 忽略 */ }
    }

    /** 打开配对对话框：输入红豆里显示的 6 位码 */
    openBridgePair() {
        if (!this.bridge) this.initBridge();
        const dlg = new Dialog({
            title: this.i18n.bridgePairTitle || "和红豆配对",
            content: `<div class="b3-dialog__content hd-dialog hd-bridge-pair">
    <div class="hd-bp-tip">${esc(this.i18n.bridgePairTip || "在红豆里点「工具 → 红豆 ↔ 思源：显示配对码」，把 6 位数字填到下面。")}</div>
    <input class="b3-text-field fn__block hd-bp-input" maxlength="6" inputmode="numeric" placeholder="000000" value="">
    <div class="hd-bp-status fn__flex-1"></div>
    <div class="fn__flex hd-bp-actions">
        <button class="b3-button b3-button--cancel fn__flex-1">${esc(this.i18n.cancel || "取消")}</button>
        <div class="fn__space"></div>
        <button class="b3-button b3-button--text fn__flex-1 hd-bp-ok">${esc(this.i18n.bridgePairOk || "配对")}</button>
    </div>
</div>`,
            width: "420px",
        });
        this._pairDlg = dlg;
        const el = dlg.element;
        const input = el.querySelector(".hd-bp-input");
        const status = el.querySelector(".hd-bp-status");
        const btnOk = el.querySelector(".hd-bp-ok");
        const btnCancel = el.querySelector(".b3-button--cancel");
        if (input) setTimeout(() => input.focus(), 60);
        if (btnCancel) btnCancel.addEventListener("click", () => dlg.destroy());

        const doPair = async () => {
            const code = (input && input.value || "").replace(/\D/g, "").slice(0, 6);
            if (code.length !== 6) {
                status.textContent = this.i18n.bridgeCodeBad || "请输入 6 位数字";
                status.className = "hd-bp-status fn__flex-1 hd-err";
                return;
            }
            status.textContent = this.i18n.bridgePairing || "正在配对…";
            status.className = "hd-bp-status fn__flex-1";
            try {
                const r = await this.bridge.pair(code);
                if (!r || !r.ok || !r.token) throw new Error((r && r.message) || "配对失败");
                this.bridge.token = r.token;
                this.data.bridgeToken = r.token;
                this.data.bridgePort = this.bridge.port;
                await this.saveSettings(true);
                status.textContent = this.i18n.bridgePaired || "配对成功";
                status.className = "hd-bp-status fn__flex-1 hd-ok";
                this._bridgeOnline = true;
                this.updateBridgeBadge();
                setTimeout(() => { try { dlg.destroy(); } catch (e) { /* 忽略 */ } }, 700);
                this.pollBridge().catch(() => null);
            } catch (err) {
                status.textContent = (err && err.message) || "配对失败";
                status.className = "hd-bp-status fn__flex-1 hd-err";
            }
        };
        if (btnOk) btnOk.addEventListener("click", doPair);
        if (input) {
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") { e.preventDefault(); doPair(); }
            });
        }
    }

    /** 检测 bridge 状态，给设置面板显示用 */
    async bridgeStatusText() {
        if (!this.bridge) return this.i18n.bridgeOff || "未启用";
        try {
            const p = await this.bridge.ping();
            if (!p || !p.ok) return this.i18n.bridgeOff || "未连接";
            if (!p.paired) return this.i18n.bridgeNotPaired || "已连接，但未配对";
            if (!this.bridge.token) return this.i18n.bridgeNeedToken || "红豆已配对，这边还没输入令牌";
            return (this.i18n.bridgeConnected || "已连接（端口 %p）").replace("%p", p.port || this.bridge.port);
        } catch (err) {
            return this.i18n.bridgeOff || "未连接（红豆端插件没在跑？）";
        }
    }

    /** 编辑器里敲 /hd 直接开搜索窗 */
    registerSlash() {
        try {
            this.protyleSlash = [{
                filter: ["hongdou", "hd", "红豆", "引用", "cite"],
                html: `<div class="b3-list-item__first"><span class="b3-list-item__text">${esc(this.i18n.slashCite || "红豆：插入文献引用")}</span></div>`,
                id: "hongdouCite",
                callback: (protyle) => {
                    try {
                        const sel = window.getSelection();
                        this._savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
                    } catch (err) { this._savedRange = null; }
                    this.openSearch("citation");
                },
            }];
        } catch (err) { /* 旧版本没有 protyleSlash 就跳过 */ }
    }

    registerCommands() {
        const cmds = [
            ["cmdCitation", "⇧⌘I", () => this.openSearch("citation")],
            ["cmdRefreshCite", "⇧⌘R", () => this.refreshCitations({})],
            ["cmdUndoCite", "⌥⌘Z", () => this.undoLast({})],
            ["cmdCiteStyle", null, () => this.openCiteStyle()],
            ["cmdExport", "⇧⌘E", () => this.openSearch("export")],
            ["cmdWelcome", null, () => this.showWelcome(true)],
            ["cmdInsert", "⇧⌘H", () => this.openSearch("cite")],
            ["cmdNote", "⇧⌘J", () => this.openSearch("note")],
            ["cmdNoteLink", null, () => this.openSearch("noteLink")],
            ["cmdBib", null, () => this.openSearch("bib")],
            ["cmdCite", null, () => this.openSearch("citeFull")],
            ["cmdInfo", null, () => this.openSearch("info")],
            ["cmdCard", null, () => this.openSearch("card")],
            ["cmdFull", null, () => this.openSearch("full")],
            ["cmdAnnots", null, () => this.openSearch("annots")],
            ["cmdNotes", null, () => this.openSearch("notes")],
            ["cmdFocused", null, () => this.insertFocused()],
            ["cmdMaterial", null, () => this.saveMaterialNote()],
            ["cmdUpdateMaterial", null, () => this.updateMaterial()],
            ["cmdBackups", null, () => this.showBackups()],
            ["cmdPushNote", "⇧⌘U", () => this.pushCurrentNote()],
            ["cmdTag", null, () => this.tagBoundItem()],
            ["cmdCollection", null, () => this.collectionBoundItem()],
            ["cmdBound", null, () => this.showBoundItem()],
            ["cmdOpenItem", null, () => this.openFocusedItem(false)],
            ["cmdOpenPdf", null, () => this.openFocusedItem(true)],
            ["cmdCheck", null, () => this.checkConnection()],
            ["cmdSettings", null, () => this.openSettings()],
            // 红豆桥接
            ["cmdBridgePair", null, () => this.openBridgePair()],
            ["cmdBridgePull", "⇧⌘K", () => this.pullBridgeQueue(false).catch(err => showMessage(err.message, 5000, "error"))],
            // 引用增强（S 级）
            ["cmdCopyBib", "⇧⌘B", () => this.copyBibliography()],
            ["cmdCiteList", "⇧⌘L", () => this.openCiteList()],
            // A 级
            ["cmdStaleCheck", null, () => this.checkStaleCites()],
            ["cmdDocStyle", null, () => this.openDocStyle()],
            ["cmdExportWord", "⇧⌘W", () => this.exportWord()],
            ["cmdCitedBy", null, () => this.showCitedBy(null)],
            ["cmdCiteGraph", null, () => this.buildCiteGraph()],
        ];
        cmds.forEach(([langKey, hotkey, cb]) => {
            const c = { langKey: langKey, callback: cb };
            if (hotkey) c.hotkey = hotkey;
            this.addCommand(c);
        });
    }

    registerTopBar() {
        this._topBarEl = this.addTopBar({
            // 引用自己注册的 iconHongdou 符号；用 svg+use 形式最稳，
            // 直接写 icon id 若符号未注入会得到空白块
            icon: '<svg><use xlink:href="#iconHongdou"></use></svg>',
            title: this.i18n.topbarTitle || "红豆文献",
            position: "right",
            callback: () => this.openSearch("citation"),
        });
    }

    /** 让 hongdou:// / zotero:// 链接在正文里点得动，并在引用上挂右键菜单 */
    registerLinkHandler() {
        const pick = (e) => (e.target && e.target.closest
            ? e.target.closest('a[href^="hongdou://"], a[href^="zotero://"]')
            : null);
        this._clickHandler = (e) => {
            const a = pick(e);
            if (!a) return;
            // 只接管条目跳转与 PDF 打开，批注回跳之类交给思源自己处理
            const href = a.getAttribute("href") || "";
            if (href.indexOf("/library/items/") < 0 && href.indexOf("open-pdf") < 0) return;
            e.preventDefault();
            e.stopPropagation();
            this.openExternal(href.replace(/[?&]bib=1/, ""));
        };
        document.addEventListener("click", this._clickHandler, true);

        // 悬停预览：写作时不切窗口就能看到完整条目
        this._hoverIn = (e) => {
            const a = pick(e);
            if (!a) return;
            const href = a.getAttribute("href") || "";
            if (href.indexOf("/library/items/") < 0) return;
            if (this._hoverTimer) clearTimeout(this._hoverTimer);
            this._hoverTimer = setTimeout(() => { this.showCitePopover(a, href); }, 260);
        };
        this._hoverOut = (e) => {
            const a = pick(e);
            if (!a) return;
            if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
            this.scheduleHidePopover();
        };
        document.addEventListener("mouseover", this._hoverIn, true);
        document.addEventListener("mouseout", this._hoverOut, true);

        this._ctxHandler = (e) => {
            const a = pick(e);
            if (!a) return;
            const href = a.getAttribute("href") || "";
            if (href.indexOf("/select/library/items/") < 0) return;
            this.showCiteMenu(e, a);
        };
        document.addEventListener("contextmenu", this._ctxHandler, true);
    }

    /* --------------------------------------------------- 引用悬停预览（S1） */

    ensurePopover() {
        if (this._popover && this._popover.isConnected) return this._popover;
        const el = document.createElement("div");
        el.className = "hd-popover";
        el.style.display = "none";
        el.addEventListener("mouseenter", () => { this._popHover = true; });
        el.addEventListener("mouseleave", () => {
            this._popHover = false;
            this.scheduleHidePopover();
        });
        document.body.appendChild(el);
        this._popover = el;
        return el;
    }

    scheduleHidePopover() {
        if (this._popHideTimer) clearTimeout(this._popHideTimer);
        this._popHideTimer = setTimeout(() => {
            if (!this._popHover) this.hidePopover();
        }, 220);
    }

    hidePopover() {
        if (this._popHideTimer) { clearTimeout(this._popHideTimer); this._popHideTimer = null; }
        this._popHover = false;
        this._popAnchor = null;
        if (this._popover) {
            this._popover.style.display = "none";
            this._popover.innerHTML = "";
        }
        if (this._popSeq) this._popSeq++;
    }

    /** 悬停内容取数：优先缓存 → MCP 完整元数据 + CSL 渲染一条 */
    async citeInfo(key, id) {
        if (!this._citeInfoCache) this._citeInfoCache = new Map();
        const ck = key || ("id:" + id);
        if (this._citeInfoCache.has(ck)) return this._citeInfoCache.get(ck);
        let item = null;
        try {
            if (id) item = await this.client.getItem(id);
            if (!item && key) {
                const docId = this.currentDocId();
                if (docId) {
                    const snap = await this.snapLoad(docId);
                    if (snap && snap[key]) item = this.snapToItem(key, snap[key]);
                }
            }
        } catch (err) { item = null; }
        if (!item) return null;

        let formatted = "";
        try {
            if (item.id) {
                const r = await this.client.formatBibliography([item.id], this.data.styleID);
                formatted = String((r && r.content) || "").replace(/\r/g, "").split("\n")[0] || "";
            }
        } catch (err) { /* 断连时没有格式化文本，退回字段拼 */ }
        if (!formatted) {
            const bits = [citeWho(item), yearOf(item), item.title].filter(Boolean);
            formatted = bits.join(". ") + (item.publicationTitle ? ". " + item.publicationTitle : "");
        }
        const info = { item, formatted };
        this._citeInfoCache.set(ck, info);
        return info;
    }

    positionPopover(el, anchor) {
        const r = anchor.getBoundingClientRect();
        el.style.visibility = "hidden";
        el.style.display = "block";
        const w = el.offsetWidth || 340;
        const h = el.offsetHeight || 120;
        let left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
        let top = r.bottom + 8;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
        el.style.left = left + "px";
        el.style.top = top + "px";
        el.style.visibility = "visible";
    }

    async showCitePopover(anchor, href) {
        const m = href.match(/items\/([A-Za-z0-9]+)/);
        const key = m ? m[1] : "";
        const q = parseCiteQuery((href.split("?")[1] || ""));
        const id = q.id || 0;
        if (!key && !id) return;

        const el = this.ensurePopover();
        this._popSeq = (this._popSeq || 0) + 1;
        const seq = this._popSeq;
        this._popAnchor = anchor;

        el.innerHTML = `<div class="hd-pop-loading">${esc(this.i18n.popLoading || "读取条目…")}</div>`;
        this.positionPopover(el, anchor);

        const info = await this.citeInfo(key, id);
        if (seq !== this._popSeq || !this._popAnchor) return;   // 鼠标已走/换了目标
        if (!info) {
            el.innerHTML = `<div class="hd-pop-empty">${esc(this.i18n.popEmpty || "红豆里取不到这条，可能已删除")}</div>`;
            this.positionPopover(el, anchor);
            return;
        }
        const it = info.item;
        const tags = (it.tags || []).filter(t => t && t.charAt(0) !== "/").slice(0, 6);
        el.innerHTML = `
<div class="hd-pop-body">
    <div class="hd-pop-cite">${esc(info.formatted)}</div>
    <div class="hd-pop-meta">
        ${it.itemType ? `<span class="hd-pop-chip">${esc(typeLabel(it.itemType))}</span>` : ""}
        ${it.publicationTitle ? `<span class="hd-pop-j">${esc(clip(it.publicationTitle, 42))}</span>` : ""}
        ${it.DOI ? `<span class="hd-pop-doi">DOI ${esc(clip(it.DOI, 30))}</span>` : ""}
    </div>
    ${tags.length ? `<div class="hd-pop-tags">${tags.map(t => `<span>#${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="hd-pop-actions">
        <button class="b3-button b3-button--outline hd-pop-open">${esc(this.i18n.popOpenHongdou || "在红豆打开")}</button>
        <button class="b3-button b3-button--outline hd-pop-pdf">${esc(this.i18n.popOpenPdf || "打开 PDF")}</button>
    </div>
</div>`;
        this.positionPopover(el, anchor);

        const btnOpen = el.querySelector(".hd-pop-open");
        const btnPdf = el.querySelector(".hd-pop-pdf");
        if (btnOpen) btnOpen.addEventListener("click", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            this.openExternal(this.itemUrl(it, "select"));
            this.hidePopover();
        });
        if (btnPdf) btnPdf.addEventListener("click", (ev) => {
            ev.preventDefault(); ev.stopPropagation();
            this.openPdf(it);
            this.hidePopover();
        });
    }

    /* ------------------------------------------- 复制参考文献（S2） */

    /**
     * 把文末参考文献复制成富文本（HTML + 纯文本双写），
     * 粘到 Word / 邮件里保留斜体、缩进和 DOI 链接。
     */
    async copyBibliography() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needDoc || "先打开一篇文档", 4000, "error");
            return;
        }
        const scan = await this.scanDocCites(docId);
        if (!scan.order.length) {
            showMessage(this.i18n.copyBibEmpty || "本篇还没有引用任何文献", 3000);
            return;
        }
        const snap = await this.snapLoad(docId);
        const hint = new Map();
        scan.occ.forEach(c => { if (c.id) hint.set(c.key, c.id); });
        const map = await this.resolveItems(scan.order, snap, hint);
        const items = scan.order.map(k => map.get(k)).filter(it => it && it.id && !it._snap);
        if (!items.length) {
            showMessage(this.i18n.copyBibNoItems || "红豆断连，取不到条目", 4500, "error");
            return;
        }
        const style = await this.citationStyle(docId);
        const ids = items.map(x => x.id);
        let html = "";
        let text = "";
        try {
            const rh = await this.client.formatBibliography(ids, style && style.styleID, { format: "html" });
            html = String((rh && rh.content) || "").trim();
            const rt = await this.client.formatBibliography(ids, style && style.styleID, { format: "text" });
            text = String((rt && rt.content) || "").trim();
        } catch (err) {
            showMessage((this.i18n.copyBibFail || "生成参考文献失败：") + err.message, 5000, "error");
            return;
        }
        if (!html && !text) {
            showMessage(this.i18n.copyBibFail || "生成参考文献失败", 4000, "error");
            return;
        }
        const ok = await writeClipboard(html || text, text || stripHtml(html));
        showMessage(
            ok ? (this.i18n.copyBibDone || "已复制 %n 条参考文献，可直接粘到 Word").replace("%n", items.length)
               : (this.i18n.copyBibFailed || "复制失败"),
            3200, ok ? "" : "error"
        );
    }

    /* ------------------------------------------- 引用清单面板（S3） */

    /** 列出本篇所有引用，可逐条打开红豆/PDF/定位到正文 */
    async openCiteList() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needDoc || "先打开一篇文档", 4000, "error");
            return;
        }
        const scan = await this.scanDocCites(docId);
        if (!scan.order.length) {
            showMessage(this.i18n.copyBibEmpty || "本篇还没有引用任何文献", 3000);
            return;
        }
        const snap = await this.snapLoad(docId);
        const hint = new Map();
        scan.occ.forEach(c => { if (c.id) hint.set(c.key, c.id); });
        const map = await this.resolveItems(scan.order, snap, hint);

        const rows = scan.order.map((k, i) => {
            const it = map.get(k) || null;
            const num = scan.nums.get(k) || (i + 1);
            const who = it && !it._snap ? citeWho(it) : (snap[k] && snap[k].w) || "";
            const year = it && !it._snap ? yearOf(it) : (snap[k] && snap[k].y) || "";
            const title = (it && it.title) || (snap[k] && snap[k].t) || k;
            const stale = !it || it._snap;
            return `<div class="hd-cl-row" data-key="${esc(k)}" data-id="${it && it.id ? it.id : 0}">
    <div class="hd-cl-num">${num}</div>
    <div class="hd-cl-main">
        <div class="hd-cl-title${stale ? " hd-stale" : ""}">${esc(title)}</div>
        <div class="hd-cl-meta">${esc(who)}${year ? " · " + esc(year) : ""}${stale ? " · " + esc(this.i18n.clStale || "红豆里已找不到") : ""}</div>
    </div>
    <div class="hd-cl-acts">
        <button class="b3-button b3-button--text hd-cl-open" title="${esc(this.i18n.popOpenHongdou || "在红豆打开")}">红豆</button>
        <button class="b3-button b3-button--text hd-cl-pdf" title="${esc(this.i18n.popOpenPdf || "打开 PDF")}">PDF</button>
        <button class="b3-button b3-button--text hd-cl-locate" title="${esc(this.i18n.clLocate || "定位到正文")}">定位</button>
    </div>
</div>`;
        }).join("");

        const dlg = new Dialog({
            title: (this.i18n.clTitle || "本篇引用清单（%n 条）").replace("%n", scan.order.length),
            content: `<div class="b3-dialog__content hd-dialog hd-citelist">
    <div class="hd-cl-head">
        <span class="fn__flex-1">${esc(this.data.styleTitle || (this.i18n.clStyle || "按当前样式排序"))}</span>
        <button class="b3-button b3-button--outline hd-cl-copy">${esc(this.i18n.clCopyAll || "复制全部参考文献")}</button>
    </div>
    <div class="hd-cl-body">${rows}</div>
</div>`,
            width: "560px",
        });
        this._citeListDlg = dlg;
        const el = dlg.element;

        el.querySelectorAll(".hd-cl-row").forEach(row => {
            const key = row.dataset.key;
            const id = Number(row.dataset.id) || 0;
            const it = map.get(key) || null;
            const btnOpen = row.querySelector(".hd-cl-open");
            const btnPdf = row.querySelector(".hd-cl-pdf");
            const btnLoc = row.querySelector(".hd-cl-locate");
            if (btnOpen) btnOpen.addEventListener("click", () => {
                const t = it && !it._snap ? it : { key: key };
                if (t.key) this.openExternal(this.itemUrl(t, "select"));
            });
            if (btnPdf) btnPdf.addEventListener("click", async () => {
                const t = it && !it._snap ? it : (id ? { id: id, key: key } : { key: key });
                await this.openPdf(t);
            });
            if (btnLoc) btnLoc.addEventListener("click", () => {
                dlg.destroy();
                setTimeout(() => this.locateCiteInDoc(key), 80);
            });
        });

        const btnCopy = el.querySelector(".hd-cl-copy");
        if (btnCopy) btnCopy.addEventListener("click", () => this.copyBibliography());
    }

    /** 在正文里定位某个 key 的引用并滚动高亮 */
    locateCiteInDoc(key) {
        try {
            const links = document.querySelectorAll('a[href*="/library/items/"]');
            for (const a of links) {
                const h = a.getAttribute("href") || "";
                if (h.indexOf("/items/" + key) < 0) continue;
                a.scrollIntoView({ behavior: "smooth", block: "center" });
                a.classList.add("hd-cite-flash");
                setTimeout(() => a.classList.remove("hd-cite-flash"), 1600);
                return true;
            }
            showMessage(this.i18n.clNotFound || "正文里没找到这处引用（可能在别的文档）", 4000, "error");
        } catch (err) { /* 忽略 */ }
        return false;
    }

    /* ------------------------------------------- 检查失效引用（A6） */

    /** 扫本篇引用，标出红豆里已经找不到的（被删或换了 key） */
    async checkStaleCites() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needDoc || "先打开一篇文档", 4000, "error");
            return;
        }
        const scan = await this.scanDocCites(docId);
        if (!scan.order.length) {
            showMessage(this.i18n.copyBibEmpty || "本篇还没有引用任何文献", 3000);
            return;
        }
        const snap = await this.snapLoad(docId);
        const hint = new Map();
        scan.occ.forEach(c => { if (c.id) hint.set(c.key, c.id); });
        const map = await this.resolveItems(scan.order, snap, hint);
        const stale = scan.order.filter(k => {
            const it = map.get(k);
            return !it || it._snap;
        });

        if (!stale.length) {
            showMessage((this.i18n.staleNone || "检查完毕：%n 条引用都能在红豆里找到").replace("%n", scan.order.length), 3200);
            return;
        }

        const rows = stale.map((k, i) => {
            const s = snap[k] || {};
            return `<div class="hd-cl-row">
    <div class="hd-cl-num">${i + 1}</div>
    <div class="hd-cl-main">
        <div class="hd-cl-title hd-stale">${esc(s.t || k)}</div>
        <div class="hd-cl-meta">${esc(s.w || "")}${s.y ? " · " + esc(s.y) : ""} · key ${esc(k)}</div>
    </div>
</div>`;
        }).join("");

        const dlg = new Dialog({
            title: (this.i18n.staleTitle || "有 %n 条引用在红豆里找不到").replace("%n", stale.length),
            content: `<div class="b3-dialog__content hd-dialog hd-citelist">
    <div class="hd-ss-tip">${esc(this.i18n.staleTip || "多半是红豆里删了这篇，或条目 key 变了。可以一键移除这些引用，再重排参考文献。")}</div>
    <div class="hd-cl-body">${rows}</div>
    <div class="fn__flex hd-bp-actions">
        <button class="b3-button b3-button--cancel fn__flex-1 hd-stale-close">${esc(this.i18n.cancel || "关闭")}</button>
        <div class="fn__space"></div>
        <button class="b3-button b3-button--text fn__flex-1 hd-stale-remove">${esc(this.i18n.staleRemove || "移除这些引用")}</button>
    </div>
</div>`,
            width: "520px",
        });
        this._staleDlg = dlg;
        const el = dlg.element;
        const btnClose = el.querySelector(".hd-stale-close");
        if (btnClose) btnClose.addEventListener("click", () => { try { dlg.destroy(); } catch (e) { /* 忽略 */ } });
        const btnRemove = el.querySelector(".hd-stale-remove");
        if (btnRemove) btnRemove.addEventListener("click", async () => {
            if (!window.confirm((this.i18n.staleConfirm || "将从正文里删掉这 %n 条引用，确定？").replace("%n", stale.length))) return;
            try { dlg.destroy(); } catch (e) { /* 忽略 */ }
            await this.removeStaleCites(docId, stale);
        });
    }

    /** 删掉整处都失效的引用（部分失效的保留不动，避免误伤） */
    async removeStaleCites(docId, staleKeys) {
        const stale = new Set(staleKeys || []);
        if (!stale.size) return;
        let blocks = [];
        try { blocks = await topBlocks(docId); } catch (err) { blocks = []; }
        if (!blocks.length) return;
        await this.pushUndo(docId, blocks);

        let removed = 0;
        for (const b of blocks) {
            let kr = "";
            try { kr = await blockKramdown(b.id); } catch (err) { continue; }
            if (!kr || kr.indexOf("hongdou://") < 0 && kr.indexOf("zotero://") < 0) continue;
            const next = replaceCites(kr, (c) => {
                if (c.bib) return null;                        // 文末表交给重排
                const allStale = c.keys.length > 0 && c.keys.every(k => stale.has(k));
                if (!allStale) return null;                    // 还有有效条目，别动
                removed++;
                return "";
            });
            if (next !== kr) {
                try { await updateBlockMd(b.id, next); } catch (err) { /* 跳过这块 */ }
            }
        }
        if (removed) {
            await this.refreshCitations({ docId: docId, quiet: true });
            showMessage((this.i18n.staleDone || "已移除 %n 处失效引用，参考文献已重排").replace("%n", removed), 3600);
        } else {
            showMessage(this.i18n.staleNothing || "没有可整处移除的引用（失效条目与其他文献混在同一处）", 4500);
        }
    }

    /* ------------------------------------------- 导出 Word（A1） */

    /** 用户主目录（Electron 里有 process；浏览器里退回空） */
    homeDir() {
        try {
            if (typeof process !== "undefined" && process.env) {
                return process.env.USERPROFILE || process.env.HOME || "";
            }
        } catch (err) { /* 忽略 */ }
        return "";
    }

    /** 导出目录：设置里指定的优先，否则桌面 */
    exportDir() {
        const cfg = String(this.data.wordExportDir || "").trim();
        if (cfg) return cfg;
        const home = this.homeDir();
        if (home) return home + (home.indexOf("\\") >= 0 ? "\\Desktop" : "/Desktop");
        return "";
    }

    /** 导出当前文档为 Word（正文引用 + 文末参考文献都已就位） */
    async exportWord() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needDoc || "先打开一篇文档", 4000, "error");
            return;
        }
        const dir = this.exportDir();
        if (!dir) {
            showMessage(this.i18n.wordNoDir || "找不到导出目录，请在设置里指定一个", 5000, "error");
            return;
        }
        showMessage(this.i18n.wordPreparing || "正在整理引用并导出…", 2600);
        try {
            await this.refreshCitations({ docId: docId, quiet: true }).catch(() => null);
            const r = await kernel("/api/export/exportDocx", {
                id: docId,
                savePath: dir,
                removeAssets: false,
                merge: false,
                docxTemplate: "",
            });
            const p = (r && r.path) || dir;
            try { if (navigator.clipboard) await navigator.clipboard.writeText(p); } catch (err) { /* 忽略 */ }
            showMessage((this.i18n.wordDone || "已导出：%p（路径已复制）").replace("%p", p), 7000);
            /* 已导出 */
        } catch (err) {
            showMessage((this.i18n.wordFail || "导出失败：") + err.message, 6000, "error");
        }
    }

    /* ------------------------------------------- Cited By 反向索引（A2） */

    /** 用内核 SQL 找出引用了某个 key 的所有文档 */
    async findCiters(key) {
        if (!key || !/^[A-Za-z0-9]+$/.test(key)) return [];
        try {
            const rows = await kernel("/api/query/sql", {
                stmt: `SELECT DISTINCT root_id FROM blocks WHERE content LIKE '%/items/${key}%' AND root_id != ''`,
            });
            const ids = (Array.isArray(rows) ? rows : []).map(r => r.root_id).filter(Boolean);
            if (!ids.length) return [];
            const out = [];
            for (const id of ids.slice(0, 50)) {
                try {
                    const t = await kernel("/api/query/sql", {
                        stmt: `SELECT content FROM blocks WHERE id = '${id}'`,
                    });
                    const title = (Array.isArray(t) && t[0] && t[0].content) || id;
                    out.push({ id: id, title: title });
                } catch (err) { out.push({ id: id, title: id }); }
            }
            return out;
        } catch (err) {
            return [];
        }
    }

    /** 列出引用了这条文献的所有文档 */
    async showCitedBy(item) {
        const it = item || (await this.client.focus().then(r => (r.items || [])[0]).catch(() => null));
        if (!it || !it.key) {
            showMessage(this.i18n.citedByNoKey || "取不到这条文献的 key", 4000, "error");
            return;
        }
        const docId = this.currentDocId();
        let name = it.title || it.key;
        if (!name || name === it.key) {
            try {
                const full = await this.client.getItem(it.id);
                if (full && full.title) name = full.title;
            } catch (err) { /* 忽略 */ }
        }
        const list = await this.findCiters(it.key);
        // 当前文档可能也在里面，标出来
        const rows = list.length
            ? list.map(d => `<div class="hd-cl-row hd-cb-row" data-id="${esc(d.id)}">
    <div class="hd-cl-main">
        <div class="hd-cl-title">${esc(d.title)}${d.id === docId ? ` <span class="hd-pop-chip">${esc(this.i18n.citedByCurrent || "当前文档")}</span>` : ""}</div>
    </div>
    <div class="hd-cl-acts"><button class="b3-button b3-button--text">${esc(this.i18n.citedByOpen || "打开")}</button></div>
</div>`).join("")
            : `<div class="hd-pop-empty">${esc(this.i18n.citedByNone || "还没有任何文档引用这条文献")}</div>`;

        const dlg = new Dialog({
            title: (this.i18n.citedByTitle || "引用了「%s」的文档（%n）")
                .replace("%s", clip(name, 40)).replace("%n", list.length),
            content: `<div class="b3-dialog__content hd-dialog hd-citelist">
    <div class="hd-cl-body">${rows}</div>
    <div class="fn__flex hd-bp-actions">
        <button class="b3-button b3-button--cancel fn__flex-1 hd-cb-close">${esc(this.i18n.cancel || "关闭")}</button>
    </div>
</div>`,
            width: "520px",
        });
        this._citedByDlg = dlg;
        const el = dlg.element;
        el.querySelectorAll(".hd-cb-row").forEach(row => {
            row.addEventListener("click", () => {
                const id = row.dataset.id;
                try { dlg.destroy(); } catch (e) { /* 忽略 */ }
                if (id) this.openDoc(id);
            });
        });
        const btn = el.querySelector(".hd-cb-close");
        if (btn) btn.addEventListener("click", () => { try { dlg.destroy(); } catch (e) { /* 忽略 */ } });
    }

    /* ------------------------------------------- 引用图谱索引（A3） */

    /**
     * 生成「文献引用索引」文档：每篇文献下面列出引用它的文档（块链接），
     * 思源关系图就会把"同一篇文献被哪些文章引用"连成网。
     */
    async buildCiteGraph() {
        showMessage(this.i18n.graphBuilding || "正在扫描全库引用…", 3000);
        let rows = [];
        try {
            rows = await kernel("/api/query/sql", {
                stmt: `SELECT DISTINCT root_id, content FROM blocks WHERE content LIKE '%/library/items/%' AND root_id != ''`,
            });
        } catch (err) {
            showMessage((this.i18n.graphFail || "扫描失败：") + err.message, 5000, "error");
            return;
        }
        rows = Array.isArray(rows) ? rows : [];
        if (!rows.length) {
            showMessage(this.i18n.graphEmpty || "全库还没有任何引用", 3500);
            return;
        }

        // key → Set(docId)
        const byKey = new Map();
        const docIds = new Set();
        rows.forEach(r => {
            const docId = r.root_id;
            if (!docId) return;
            docIds.add(docId);
            const s = String(r.content || "");
            const re = /\/items\/([A-Za-z0-9]+)/g;
            let m;
            while ((m = re.exec(s))) {
                const k = m[1];
                if (!byKey.has(k)) byKey.set(k, new Set());
                byKey.get(k).add(docId);
            }
        });

        // 文档标题
        const titleOf = new Map();
        const ids = Array.from(docIds).slice(0, 400);
        for (const id of ids) {
            try {
                const t = await kernel("/api/query/sql", { stmt: `SELECT content FROM blocks WHERE id = '${id}'` });
                titleOf.set(id, (Array.isArray(t) && t[0] && t[0].content) || id);
            } catch (err) { titleOf.set(id, id); }
        }

        // 文献标题：从红豆批量取（失败就只显示 key）
        const keys = Array.from(byKey.keys());
        const nameOf = new Map();
        try {
            const r = await this.client.listItems({ limit: 300 });
            const list = (r && (r.items || r.results)) || [];
            list.forEach(x => { if (x && x.key) nameOf.set(x.key, x.title || ""); });
        } catch (err) { /* 红豆断连就只用 key */ }

        const lines = [];
        lines.push("# 文献引用索引");
        lines.push("");
        lines.push(`> 由红豆插件生成于 ${new Date().toLocaleString()} · 共 ${byKey.size} 篇文献 / ${docIds.size} 篇文档`);
        lines.push("");
        const sorted = keys.sort((a, b) => (byKey.get(b).size - byKey.get(a).size));
        sorted.forEach(k => {
            const docs = Array.from(byKey.get(k));
            const name = nameOf.get(k) || k;
            lines.push(`## ${name}`);
            lines.push("");
            lines.push(`\`${k}\` · 被 ${docs.length} 篇文档引用`);
            lines.push("");
            docs.forEach(id => {
                const t = titleOf.get(id) || id;
                lines.push(`- ((${id} "${t.replace(/"/g, "'")}"))`);
            });
            lines.push("");
        });

        // 写进当前笔记本
        try {
            const notebook = await this.resolveNotebook();
            const folder = this.data.folder || DEFAULTS.folder;
            await this.ensureDocPath(notebook, "/" + folder);
            const path = `/${folder}/文献引用索引`;
            const md = lines.join("\n");
            const docId = await kernel("/api/filetree/createDocWithMd", { notebook: notebook, path: path, markdown: md });
            if (docId) {
                this.openDoc(docId);
                showMessage((this.i18n.graphDone || "已生成索引：%n 篇文献").replace("%n", byKey.size), 4000);
            }
        } catch (err) {
            showMessage((this.i18n.graphFail || "生成失败：") + err.message, 6000, "error");
        }
    }

    onunload() {
        this.stopBridgeWatch();
        this.hidePopover();
        if (this._hoverTimer) { clearTimeout(this._hoverTimer); this._hoverTimer = null; }
        if (this._hoverIn) {
            document.removeEventListener("mouseover", this._hoverIn, true);
            this._hoverIn = null;
        }
        if (this._hoverOut) {
            document.removeEventListener("mouseout", this._hoverOut, true);
            this._hoverOut = null;
        }
        if (this._popover && this._popover.parentNode) {
            this._popover.parentNode.removeChild(this._popover);
        }
        this._popover = null;
        if (this._clickHandler) {
            document.removeEventListener("click", this._clickHandler, true);
            this._clickHandler = null;
        }
        if (this._ctxHandler) {
            document.removeEventListener("contextmenu", this._ctxHandler, true);
            this._ctxHandler = null;
        }
        this.closeMenu();
        this._dialog = null;
        if (this._editCiteDlg) {
            try { this._editCiteDlg.destroy(); } catch (err) { /* 忽略 */ }
            this._editCiteDlg = null;
        }
        if (this._pairDlg) {
            try { this._pairDlg.destroy(); } catch (err) { /* 忽略 */ }
            this._pairDlg = null;
        }
        if (this._citeListDlg) {
            try { this._citeListDlg.destroy(); } catch (err) { /* 忽略 */ }
            this._citeListDlg = null;
        }
    }

    async saveSettings(quiet) {
        this.client.setEndpoint(this.data.endpoint);
        await this.saveData("settings.json", this.data);
        if (!quiet) showMessage(this.i18n.settingsSaved || "设置已保存");
    }

    /* ------------------------------------------------------------ 基础能力 */

    get activeEditor() {
        if (typeof siyuan.getActiveEditor === "function") {
            try {
                const e = siyuan.getActiveEditor();
                if (e && e.protyle) return e;
            } catch (err) { /* 忽略 */ }
        }
        return this._activeEditor || null;
    }

    currentDocId() {
        const e = this.activeEditor;
        const p = e && (e.protyle || e);
        if (!p) return "";
        const bg = p.background && p.background.element;
        return (bg && bg.getAttribute("data-node-id")) || (p.options && p.options.docId) || (p.block && p.block.rootID) || "";
    }

    insertMarkdown(md) {
        if (!md) return false;
        const editor = this.activeEditor;
        if (!editor) {
            showMessage(this.i18n.needEditor || "请先把光标放到正文里，再执行这个命令", 4000, "error");
            return false;
        }
        // 弹窗会夺走焦点，插入前把选区还原回正文
        const range = this._savedRange;
        let usableRange = null;
        try {
            const wys = editor.protyle && editor.protyle.wysiwyg && editor.protyle.wysiwyg.element;
            if (range && wys && wys.contains(range.startContainer) && wys.contains(range.endContainer)) {
                usableRange = range;
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        } catch (err) { /* 选区失效就走编辑器自身的光标 */ }
        try {
            if (typeof siyuan.insertContent === "function") {
                const payload = { data: md, dataType: "markdown", editor };
                if (usableRange) payload.range = usableRange;
                const r = siyuan.insertContent(payload);
                this._savedRange = null;
                const status = r && r.status;
                if (status === "inserted") return true;
                const map = {
                    "no-editor": this.i18n.needEditor,
                    readonly: this.i18n.readonly,
                    "invalid-range": this.i18n.invalidRange,
                    "unsupported-range": this.i18n.unsupportedRange,
                    "unsupported-content": this.i18n.unsupportedContent,
                    "empty-content": this.i18n.emptyContent,
                };
                showMessage(map[status] || ("插入失败：" + status), 4000, "error");
                return false;
            }
            const p = editor.protyle || editor;
            if (p && typeof p.insert === "function") {
                p.insert(md);
                return true;
            }
        } catch (err) {
            showMessage("插入失败：" + err.message, 5000, "error");
        }
        return false;
    }

    openDoc(id) {
        if (!id) return;
        openTab({ app: this.app, doc: { id } });
    }

    openExternal(url) {
        if (!url) return false;
        try {
            // 桌面端交给系统处理自定义协议，浏览器环境可能没有 electron
            const electron = require("electron");
            if (electron && electron.shell && electron.shell.openExternal) {
                electron.shell.openExternal(url);
                return true;
            }
        } catch (err) { /* 继续尝试 window.open */ }
        try {
            const w = window.open(url, "_blank");
            if (w === null) throw new Error("blocked");
            return true;
        } catch (err) {
            if (navigator.clipboard) {
                navigator.clipboard.writeText(url);
                showMessage(this.i18n.copiedLink || "已复制链接", 4000);
            }
            return false;
        }
    }

    /** 用系统默认应用打开本地文件（桌面端走 shell.openPath，最可靠） */
    openPath(p) {
        if (!p) return false;
        try {
            const electron = require("electron");
            if (electron && electron.shell && typeof electron.shell.openPath === "function") {
                return Promise.resolve(electron.shell.openPath(p)).then((errMsg) => {
                    if (errMsg) {
                        // 打开失败退回资源管理器选中文件
                        if (electron.shell && electron.shell.showItemInFolder) {
                            electron.shell.showItemInFolder(p);
                        }
                        return false;
                    }
                    return true;
                });
            }
        } catch (err) { /* 浏览器环境没有 electron */ }
        return Promise.resolve(this.openExternal("file:///" + String(p).replace(/\\/g, "/")));
    }

    /** 取一篇文献的本地 PDF 附件（优先 hasFile+exists 的 pdf） */
    /**
     * 取 PDF 文件附件（含附件 key）。
     * open-pdf 协议要的是【附件】key，传父条目 key 红豆会判定
     * "not a file attachment" 后静默返回——这是之前点了没反应的真正原因。
     */
    async firstPdfAttachment(item, wantKey) {
        try {
            const atts = await this.client.getAttachments(item.id);
            const list = (atts && atts.attachments) || [];
            const pdf = list.find(a => a.hasFile && a.exists && String(a.contentType || "").indexOf("pdf") >= 0);
            if (!pdf) return null;
            if (wantKey !== false) {
                const attID = pdf.attachmentID || pdf.id;
                if (attID) {
                    if (!this._attKeyCache) this._attKeyCache = new Map();
                    if (this._attKeyCache.has(attID)) {
                        pdf.attKey = this._attKeyCache.get(attID);
                    } else {
                        try {
                            const full = await this.client.getItem(attID);
                            if (full && full.key) {
                                pdf.attKey = full.key;
                                this._attKeyCache.set(attID, full.key);
                            }
                        } catch (err) { /* 拿不到 key 就走本地文件 */ }
                    }
                }
            }
            return pdf;
        } catch (err) {
            return null;
        }
    }

    /**
     * 打开一篇文献的 PDF。
     * 默认交给红豆自己的阅读器（批注、笔记都在红豆里）；
     * pdfOpenWith 设为 system 时才用系统默认阅读器。
     */
    async openPdf(item) {
        const full = item && item.id ? (await this.client.getItem(item.id).catch(() => null)) : item;
        const it = (full && (full.key || full.id)) ? full : item;
        if (!it || !it.id) return false;

        const mode = this.data.pdfOpenWith || DEFAULTS.pdfOpenWith;
        const pdf = await this.firstPdfAttachment(it, true);

        const tryHongdou = () => {
            if (!pdf || !pdf.attKey) return false;
            const url = this.itemUrl({ key: pdf.attKey }, "pdf");
            return !!(url && this.openExternal(url));
        };
        const trySystem = async () => {
            if (!pdf || !pdf.path) return false;
            const ok = await this.openPath(pdf.path);
            return ok !== false;
        };

        if (mode === "system") {
            if (await trySystem()) return true;
            if (tryHongdou()) return true;
        } else {
            // 默认：红豆阅读器优先（批注、笔记都在红豆里，可与文末引用联动）
            if (tryHongdou()) return true;
            if (await trySystem()) return true;
        }

        if (!pdf) {
            showMessage(this.i18n.noPdf || "这篇文献在红豆里没有本地 PDF 附件", 4000, "error");
            // 至少把条目跳出来，别让用户以为按钮坏了
            if (it.key) this.openExternal(this.itemUrl(it, "select"));
            return false;
        }

        // 3) 有附件但既没 key 也没本地文件
        if (it.key) return this.openExternal(this.itemUrl(it, "select"));
        return false;
    }

    /* -------------------------------------------------------------- 格式化 */

    itemUrl(item, kind) {
        const scheme = this.data.scheme === "zotero" ? "zotero" : "hongdou";
        const key = item && item.key ? item.key : "";
        if (!key) return "";
        if (kind === "pdf") {
            // open-pdf 只认【文件附件】的 key，父条目 key 会被红豆判为
            // "not a file attachment" 后静默返回。能拿到附件 key 就优先用它。
            const atts = (item && item.attachments) || [];
            const pdfAtt = atts.find(a => a && a.key && String(a.contentType || "").toLowerCase().indexOf("pdf") >= 0);
            return `${scheme}://open-pdf/library/items/${(pdfAtt && pdfAtt.key) || key}`;
        }
        return `${scheme}://select/library/items/${key}`;
    }

    displayText(item) {
        const style = this.data.linkStyle || "title";
        if (style === "authorYear") {
            const a = firstAuthor(item);
            const y = yearOf(item);
            return [a, y].filter(Boolean).join(" ") || item.title || "";
        }
        if (style === "custom") {
            const tpl = this.data.linkTemplate || DEFAULTS.linkTemplate;
            return this.applyVars(tpl, item, {}).replace(/\s+/g, " ").trim() || item.title || "";
        }
        return item.title || "";
    }

    abstractText(item) {
        let s = String((item && item.abstract) || "");
        if (!s) return "";
        s = s.replace(/\r/g, "");
        // 红豆里的摘要常见「BACKGROUND            Previous studies」这种被 PubMed 拉宽的段落
        s = s.replace(/[ \t]{2,}/g, " ");
        s = s.replace(/\s*\b(BACKGROUND|OBJECTIVE|OBJECTIVES|PURPOSE|METHODS?|MATERIALS AND METHODS|RESULTS?|CONCLUSIONS?|DESIGN|SETTING|PARTICIPANTS|INTERVENTIONS?|MEASUREMENTS?)\s*[:：]/g,
            "\n\n**$1** ");
        // 有的摘要不带冒号，直接「Background The ... Methods and Results We ... Conclusions Our ...」
        if (s.indexOf("\n\n") < 0 && s.length > 500) {
            s = s.replace(/^(Background|Objectives?|Purpose)\s+(?=[A-Z“"(])/, "**$1** ");
            s = s.replace(/([.!?])\s+(Background|Objectives?|Purpose|Materials and Methods|Methods and Results|Methods|Results|Conclusions?)\s+(?=[A-Z“"(])/g,
                "$1\n\n**$2** ");
        }
        s = s.replace(/[ \t]{2,}/g, " ");
        // 去标签后常留下「( BMI )」「BMI ,」这类空格，顺手收一下
        s = s.replace(/\s+([,.;:!?])/g, "$1").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
        s = s.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
        return s.trim();
    }

    /** 模板变量替换；collections 由调用方异步取好传入 */
    applyVars(tpl, item, opt) {
        opt = opt || {};
        const url = this.itemUrl(item);
        const doi = item.DOI || "";
        const doiLink = doi ? `[${doi}](https://doi.org/${doi})` : "";
        const tags = (item.tags || []).filter(t => t && t.charAt(0) !== "/");
        const paths = opt.collections || [];
        const vars = {
            title: item.title || "",
            authors: authorsText(item, 6),
            author: firstAuthor(item),
            year: yearOf(item),
            date: item.date || "",
            journal: item.publicationTitle || "",
            pub: pubText(item),
            volume: item.volume || "",
            issue: item.issue || "",
            pages: item.pages || "",
            doi: doi,
            doilink: doiLink,
            url: item.url || url,
            link: url ? `[在红豆中打开](${url})` : "",
            pdflink: url ? `[打开 PDF](${this.itemUrl(item, "pdf")})` : "",
            tags: tags.join(", "),
            hashtags: tags.map(t => "#" + t.replace(/\s+/g, "_")).join(" "),
            collections: paths.join("；"),
            abstract: this.abstractText(item),
            type: typeLabel(item.itemType),
            citekey: item.citationKey || item.key || "",
            key: item.key || "",
        };
        return String(tpl || "").replace(/\{(\w+)\}/g, (m, name) => {
            return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name] == null ? "" : vars[name]) : m;
        });
    }

    /**
     * 多篇文献如何连在一起。
     * 默认一行一条：思源里软换行即可，视觉上每篇各占一行，且不会把多篇挤进同一段落。
     */
    joinItems(parts) {
        const list = (parts || []).filter(p => String(p == null ? "" : p).trim());
        if (!list.length) return "";
        const layout = this.data.layout || DEFAULTS.layout;
        if (layout === "para") return list.join("\n\n");
        if (layout === "bullet") return list.map(p => "- " + p).join("\n");
        if (layout === "number") return list.map((p, i) => `${i + 1}. ${p}`).join("\n");
        if (layout === "semicolon") return list.join(this.data.separator || DEFAULTS.separator);
        return list.join("\n");
    }

    /** 一条文献的「卡片」：标题可点 + 关键信息 + 摘要（可选） */
    async itemCard(item, opt) {
        opt = opt || {};
        const paths = opt.collections || await this.client.collectionPath(item.collectionIDs).catch(() => []);
        const url = this.itemUrl(item);
        const head = url ? `### [${linkText(item.title || "(无标题)")}](${url})` : `### ${linkText(item.title || "(无标题)")}`;
        const out = [head, ""];
        const rows = [];
        if ((item.creators || []).length) rows.push(`- **作者**：${authorsText(item, 6)}`);
        const y = yearOf(item);
        if (item.publicationTitle) {
            let src = item.publicationTitle;
            if (y) src += `, ${y}`;
            if (item.volume) src += `, ${item.volume}`;
            if (item.issue) src += `(${item.issue})`;
            if (item.pages) src += `: ${item.pages}`;
            rows.push(`- **来源**：${src}`);
        } else if (y) {
            rows.push(`- **年份**：${y}`);
        }
        rows.push(`- **类型**：${typeLabel(item.itemType)}`);
        if (item.DOI) rows.push(`- **DOI**：[${item.DOI}](https://doi.org/${item.DOI})`);
        if (item.PMID) rows.push(`- **PMID**：${item.PMID}`);
        if (paths.length) rows.push(`- **分类**：${paths.join("；")}`);
        const tags = (item.tags || []).filter(t => t && t.charAt(0) !== "/");
        if (tags.length) {
            // MeSH 标签动辄二十几个，卡片里只留前 6 个
            const shown = tags.slice(0, 6).join(", ");
            rows.push(`- **标签**：${shown}${tags.length > 6 ? `（等 ${tags.length} 个）` : ""}`);
        }
        if (url) rows.push(`- **红豆**：[在红豆中打开](${url})`);
        out.push(rows.join("\n"));
        if (opt.abstract) {
            const abs = this.abstractText(item);
            if (abs) {
                out.push("");
                out.push("> **摘要**");
                out.push(">");
                out.push(abs.split("\n").map(l => (l ? "> " + l : ">")).join("\n"));
            }
        }
        return out.join("\n");
    }

    /** 信息 + 红豆笔记 + PDF 批注，一次插入 */
    async itemFull(item) {
        const parts = [await this.itemCard(item, { abstract: !!this.data.insertAbstract })];
        const notes = await this.notesMarkdown(item, true);
        if (notes) parts.push(notes);
        const anns = await this.annotationsMarkdown(item, true);
        if (anns) parts.push(anns);
        return parts.join("\n\n");
    }

    /* ---------------------------------------------------------------- 文档 */

    async resolveNotebook() {
        if (this.data.notebook) return this.data.notebook;
        const list = await kernel("/api/notebook/lsNotebooks");
        const open = (list.notebooks || []).filter(n => !n.closed);
        if (!open.length) throw new Error("没有打开的笔记本，无法创建阅读笔记");
        return open[0].id;
    }

    /** 逐级保证 /a/b 这样的文档路径存在 */
    async ensureDocPath(notebook, hpath) {
        const segs = String(hpath).split("/").filter(Boolean);
        let cur = "";
        for (let i = 0; i < segs.length; i++) {
            cur += "/" + segs[i];
            const ids = await kernel("/api/filetree/getIDsByHPath", { notebook: notebook, path: cur });
            if (ids && ids.length) continue;
            await kernel("/api/filetree/createDocWithMd", { notebook: notebook, path: cur, markdown: "" });
        }
    }

    async findDocByItemId(itemID) {
        const stmt = `select id from blocks where type = 'd' and ial like '%custom-hongdou-item-id="${itemID}"%' limit 1`;
        try {
            const rows = await kernel("/api/query/sql", { stmt: stmt });
            return rows && rows.length ? rows[0].id : "";
        } catch (err) {
            return "";
        }
    }

    noteFileName(item) {
        const y = yearOf(item);
        const a = firstAuthor(item) || "未知作者";
        const prefix = safeName(`${y ? y + " " : ""}${a}`) + " - ";
        const room = Math.max(24, 72 - prefix.length);
        return safeName(prefix + clip(safeName(item.title || "未命名"), room));
    }

    /** 按文献类型挑模板：有该类型的段就用，否则用默认段 */
    noteTemplateFor(item) {
        const raw = this.data.noteTemplate || "";
        const sec = parseTemplateSections(raw, NOTE_TEMPLATE);
        const t = item && item.itemType ? String(item.itemType) : "";
        if (t && sec.byType[t]) return sec.byType[t];
        return sec.def || NOTE_TEMPLATE;
    }

    async noteMarkdown(item) {
        const paths = await this.client.collectionPath(item.collectionIDs).catch(() => []);
        const tpl = this.noteTemplateFor(item);
        let md = this.applyVars(tpl, item, { collections: paths });
        if (this.data.insertAbstract && md.indexOf("{abstract}") < 0 && item.abstract) {
            md += "\n## 摘要\n\n" + this.abstractText(item) + "\n";
        }
        if (md.indexOf("红豆材料") < 0) md += "\n## 红豆材料\n";
        return md;
    }

    async ensureReadingNote(item) {
        const exist = await this.findDocByItemId(item.id);
        if (exist) return exist;
        const notebook = await this.resolveNotebook();
        const folder = this.data.folder || DEFAULTS.folder;
        await this.ensureDocPath(notebook, "/" + folder);
        const path = `/${folder}/${this.noteFileName(item)}`;
        const ids = await kernel("/api/filetree/getIDsByHPath", { notebook: notebook, path: path });
        let id = ids && ids.length ? ids[0] : "";
        if (!id) {
            const md = await this.noteMarkdown(item);
            id = await kernel("/api/filetree/createDocWithMd", { notebook: notebook, path: path, markdown: md });
        }
        if (id) {
            try {
                await kernel("/api/attr/setBlockAttrs", {
                    id: id,
                    attrs: {
                        "custom-hongdou-item-id": String(item.id),
                        "custom-hongdou-key": item.key || "",
                    },
                });
            } catch (err) { /* 属性失败不影响主体 */ }
        }
        return id;
    }

    /** 当前文档绑定的红豆条目 ID（读文档属性） */
    async boundItemId(docId) {
        const id = docId || this.currentDocId();
        if (!id) return 0;
        try {
            const rows = await kernel("/api/query/sql", {
                stmt: `select ial from blocks where id = '${id}' limit 1`,
            });
            const ial = (rows && rows[0] && rows[0].ial) || "";
            const m = /custom-hongdou-item-id="(\d+)"/.exec(ial);
            if (!m) return 0;
            return Number(m[1]);
        } catch (err) {
            return 0;
        }
    }

    async docAttr(docId, name) {
        try {
            const attrs = await kernel("/api/attr/getBlockAttrs", { id: docId });
            return (attrs && attrs[name]) || "";
        } catch (err) {
            return "";
        }
    }

    /* --------------------------------------------------------------- 插入流 */

    async runInsert(mode, picked) {
        const list = picked.slice(0, MAX_SELECT);
        try {
            if (mode === "citation") {
                await this.insertCitation(list);
            } else if (mode === "cite") {
                const items = await this.client.hydrateAll(list);
                const parts = items.map(it => {
                    const url = this.itemUrl(it);
                    const text = this.displayText(it);
                    return url ? `[${linkText(text)}](${url})` : linkText(text);
                });
                this.insertMarkdown(this.joinItems(parts));
            } else if (mode === "citeFull") {
                const items = await this.client.hydrateAll(list);
                const style = await this.citationStyle();
                const r = await this.client.formatBibliography(items.map(x => x.id), style.styleID);
                const lines = String((r && r.content) || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                if (!lines.length) {
                    showMessage(this.i18n.bibEmpty || "红豆没有返回参考文献，请检查样式设置", 4000, "error");
                    return;
                }
                this.insertMarkdown(lines.map(escapeOl).join("\n\n"));
            } else if (mode === "bib") {
                const items = await this.client.hydrateAll(list);
                const style = await this.citationStyle();
                const r = await this.client.formatBibliography(items.map(x => x.id), style.styleID);
                const content = (r && r.content) || "";
                const lines = content.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                if (!lines.length) {
                    showMessage(this.i18n.bibEmpty || "红豆没有返回参考文献，请检查样式设置", 4000, "error");
                    return;
                }
                const out = [];
                const title = String(this.data.bibTitle || "").trim();
                if (title) {
                    const lv = Math.min(6, Math.max(1, Number(this.data.bibLevel) || 2));
                    out.push("#".repeat(lv) + " " + title, "");
                }
                lines.forEach(l => out.push(escapeOl(l)));
                this.insertMarkdown(out.join("\n\n"));
            } else if (mode === "note") {
                const items = await this.client.hydrateAll(list);
                const parts = [];
                for (const it of items) {
                    const id = await this.ensureReadingNote(it);
                    parts.push(`[${linkText(this.noteFileName(it))}](siyuan://blocks/${id})`);
                }
                this.insertMarkdown(this.joinItems(parts));
                showMessage(this.i18n.noteCreated || "阅读笔记已创建或打开", 3000);
            } else if (mode === "noteLink") {
                const items = await this.client.hydrateAll(list);
                const out = [];
                let missing = 0;
                for (const it of items) {
                    const id = await this.findDocByItemId(it.id);
                    if (id) out.push(`[${linkText(this.noteFileName(it))}](siyuan://blocks/${id})`);
                    else missing++;
                }
                if (!out.length) {
                    showMessage(this.i18n.noNoteYet || "这些文献还没有阅读笔记，先用「新建阅读笔记」建一篇", 5000, "error");
                    return;
                }
                if (missing) showMessage((this.i18n.someNoNote || "有 %n 篇还没有阅读笔记，已跳过").replace("%n", missing), 4000);
                this.insertMarkdown(this.joinItems(out));
            } else if (mode === "card") {
                const items = await this.client.hydrateAll(list);
                const blocks = [];
                for (const it of items) {
                    blocks.push(await this.itemCard(it, { abstract: !!this.data.insertAbstract }));
                }
                this.insertMarkdown(blocks.join("\n\n"));
            } else if (mode === "full") {
                const items = await this.client.hydrateAll(list);
                const blocks = [];
                for (const it of items) {
                    blocks.push(await this.itemFull(it));
                }
                this.insertMarkdown(blocks.join("\n\n"));
            } else if (mode === "attach") {
                const it = list[0];
                const full = (await this.client.hydrate(it).catch(() => null)) || it;
                const ok = await this.openPdf(full);
                if (!ok) {
                    showMessage(this.i18n.noPdf || "这篇文献在红豆里没有本地 PDF 附件", 4000, "error");
                }
                return;
            } else if (mode === "info") {
                const items = await this.client.hydrateAll(list);
                this.insertMarkdown(await this.infoTable(items));
            } else if (mode === "annots") {
                const items = await this.client.hydrateAll(list);
                const blocks = [];
                for (const it of items) {
                    blocks.push(await this.annotationsMarkdown(it));
                }
                this.insertMarkdown(blocks.join("\n\n"));
            } else if (mode === "notes") {
                const items = await this.client.hydrateAll(list);
                const blocks = [];
                for (const it of items) {
                    blocks.push(await this.notesMarkdown(it));
                }
                this.insertMarkdown(blocks.join("\n\n"));
            } else if (mode === "bibtex") {
                const items = await this.client.hydrateAll(list);
                const r = await this.client.bibtex(items.map(x => x.id));
                const txt = (r && (r.bibtex || r.content || r.text)) || "";
                if (!txt) {
                    showMessage(this.i18n.bibtexEmpty || "红豆没有返回 BibTeX", 4000, "error");
                    return;
                }
                this.insertMarkdown("```bibtex\n" + String(txt).trim() + "\n```");
            } else if (mode === "export") {
                const items = await this.client.hydrateAll(list);
                this.openExport(items);
            } else if (mode === "index") {
                await this.buildCollectionIndex(list);
            }
        } catch (err) {
            showMessage(err.message, 7000, "error");
        }
    }

    async infoTable(items) {
        const blocks = [];
        for (const it of items) {
            const paths = await this.client.collectionPath(it.collectionIDs).catch(() => []);
            const lines = ["| 项目 | 内容 |", "| --- | --- |"];
            lines.push(kv("标题", it.title || ""));
            lines.push(kv("作者", authorsText(it, 6)));
            if (it.publicationTitle) lines.push(kv("出版物", pubText(it)));
            lines.push(kv("年份", yearOf(it)));
            lines.push(kv("类型", typeLabel(it.itemType)));
            if (it.DOI) lines.push(kv("DOI", `[${it.DOI}](https://doi.org/${it.DOI})`));
            if (it.PMID) lines.push(kv("PMID", it.PMID));
            if (it.tags.length) lines.push(kv("标签", it.tags.filter(t => t.charAt(0) !== "/").join(", ")));
            if (paths.length) lines.push(kv("分类", paths.join("；")));
            const url = this.itemUrl(it);
            if (url) lines.push(kv("红豆", `[在红豆中打开](${url})`));
            blocks.push(lines.join("\n"));
            if (this.data.insertAbstract && it.abstract) {
                blocks.push(this.abstractText(it));
            }
        }
        return blocks.join("\n\n");
    }

    /** 单篇批注 → Markdown，带页码与评论 */
    async annotationsMarkdown(item, plain) {
        let r = null;
        try {
            r = await this.client.getAnnotations(item.id);
        } catch (err) {
            return `> ${item.title}：读取批注失败（${err.message}）`;
        }
        const atts = (r && r.attachments) || [];
        const rows = [];
        atts.forEach(a => {
            (a.annotations || []).forEach(x => rows.push({ att: a, ann: x }));
        });
        const onlyComment = !!this.data.annoOnlyComment;
        const list = rows.filter(x => {
            if (onlyComment) return String(x.ann.comment || "").trim();
            return String(x.ann.text || "").trim() || String(x.ann.comment || "").trim();
        });
        const head = plain ? "#### PDF 批注" : `### ${item.title}`;
        if (!list.length) {
            return `${head}\n\n_（这篇文献在红豆里还没有批注）_`;
        }
        const out = [head, ""];
        list.sort((a, b) => (Number(a.ann.page) || 0) - (Number(b.ann.page) || 0));
        list.forEach(x => {
            const a = x.ann;
            const page = a.page ? `第 ${a.page} 页` : "";
            const tag = annoColorLabel(a.color);
            const text = String(a.text || "").trim();
            const comment = String(a.comment || "").trim();
            const foot = [page, tag].filter(Boolean).join(" · ");
            if (text) {
                out.push(`> ${text.replace(/\n/g, "\n> ")}`);
                if (foot) {
                    out.push(`>`);
                    out.push(`> — ${foot}`);
                }
                out.push("");
            }
            if (comment) {
                out.push(comment);
                out.push("");
            }
        });
        out.push(plain
            ? `> 共 ${list.length} 条批注`
            : `> 共 ${list.length} 条批注 · 来源：[${item.title}](${this.itemUrl(item) || "#"})`);
        return out.join("\n");
    }

    /** 红豆里的笔记 → Markdown */
    async notesMarkdown(item, plain) {
        let r = null;
        try {
            r = await this.client.getNotes(item.id);
        } catch (err) {
            return `> ${item.title}：读取笔记失败（${err.message}）`;
        }
        const notes = (r && r.notes) || [];
        const head = plain ? "#### 红豆笔记" : `### ${item.title}`;
        if (!notes.length) return plain ? "" : `${head}\n\n_（这篇文献在红豆里还没有笔记）_`;
        const out = [head, ""];
        notes.forEach((n, i) => {
            const body = html2text(n.note || n.content || "");
            if (notes.length > 1) out.push(`#### 笔记 ${i + 1}`);
            out.push(body);
            out.push("");
        });
        out.push(plain
            ? `> 共 ${notes.length} 条笔记`
            : `> 共 ${notes.length} 条笔记 · 来源：[${item.title}](${this.itemUrl(item) || "#"})`);
        return out.join("\n");
    }

    /** 把一个分类（或选中的一批文献）生成为索引文档 */
    async buildCollectionIndex(items) {
        if (!items.length) return;
        const notebook = await this.resolveNotebook();
        const folder = this.data.folder || DEFAULTS.folder;
        await this.ensureDocPath(notebook, "/" + folder);
        const title = items.length === 1 ? `${items[0].title} 相关文献索引` : `文献索引 ${stamp()}`;
        const lines = ["| # | 年份 | 作者 | 标题 | 期刊 | 笔记 |", "| --- | --- | --- | --- | --- | --- |"];
        items.forEach((it, i) => {
            const url = this.itemUrl(it);
            const link = url ? `[${cell(clip(it.title, 60))}](${url})` : cell(clip(it.title, 60));
            lines.push(`| ${i + 1} | ${cell(yearOf(it))} | ${cell(clip(authorsText(it, 2), 30))} | ${link} | ${cell(clip(it.publicationTitle, 40))} |  |`);
        });
        const md = lines.join("\n");
        const path = `/${folder}/索引 ${stamp()}`;
        const id = await kernel("/api/filetree/createDocWithMd", { notebook: notebook, path: path, markdown: md });
        this.openDoc(id);
        showMessage((this.i18n.indexCreated || "索引文档已创建，共 %n 条").replace("%n", items.length));
    }

    /* --------------------------------------------------------------- 搜索窗 */

    async openSearch(mode) {
        if (this._dialog) return;
        this._activeEditor = (typeof siyuan.getActiveEditor === "function") ? siyuan.getActiveEditor() : null;
        try {
            const sel = window.getSelection();
            this._savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        } catch (err) {
            this._savedRange = null;
        }
        this._openedDocId = this.currentDocId();
        this._dialog = this.buildDialog(mode || "cite");
    }

    buildDialog(mode) {
        const i18n = this.i18n;
        const showDetail = !!this.data.showDetail;
        const dialog = new Dialog({
            title: i18n.dialogTitle || "红豆文献",
            width: showDetail ? "1000px" : "800px",
            height: "680px",
            content: `<div class="hd-dialog">
  <div class="hd-bar">
    <input class="b3-text-field hd-input" placeholder="${esc(i18n.searchPlaceholder || "搜索标题 / 作者 / 年份 / DOI")}">
    <select class="b3-select hd-field">
      <option value="all">${esc(i18n.fieldAll || "全部字段")}</option>
      <option value="title">${esc(i18n.fieldTitle || "标题")}</option>
      <option value="creator">${esc(i18n.fieldCreator || "作者")}</option>
      <option value="year">${esc(i18n.fieldYear || "年份")}</option>
      <option value="publication">${esc(i18n.fieldPub || "期刊")}</option>
      <option value="tag">${esc(i18n.fieldTag || "标签")}</option>
    </select>
    <span class="fn__flex-1"></span>
    <select class="b3-select hd-mode">
      <optgroup label="${esc(i18n.groupCite || "引用")}">
        <option value="citation">${esc(i18n.modeCitation || "正文引用 + 文末表（推荐）")}</option>
        <option value="cite">${esc(i18n.modeCite || "文献链接")}</option>
        <option value="citeFull">${esc(i18n.modeCiteFull || "完整引用")}</option>
        <option value="bib">${esc(i18n.modeBib || "参考文献表")}</option>
        <option value="export">${esc(i18n.modeExport || "导出引用（多格式）")}</option>
        <option value="bibtex">${esc(i18n.modeBibtex || "BibTeX")}</option>
      </optgroup>
      <optgroup label="${esc(i18n.groupNote || "笔记材料")}">
        <option value="note">${esc(i18n.modeNote || "新建阅读笔记")}</option>
        <option value="noteLink">${esc(i18n.modeNoteLink || "阅读笔记链接")}</option>
        <option value="info">${esc(i18n.modeInfo || "文献信息表")}</option>
        <option value="card">${esc(i18n.modeCard || "文献卡片（信息）")}</option>
        <option value="full">${esc(i18n.modeFull || "信息 + 笔记 + 批注")}</option>
        <option value="annots">${esc(i18n.modeAnnots || "PDF 批注")}</option>
        <option value="notes">${esc(i18n.modeNotes || "红豆笔记")}</option>
      </optgroup>
      <optgroup label="${esc(i18n.groupDoc || "文档")}">
        <option value="index">${esc(i18n.modeIndex || "生成文献索引文档")}</option>
        <option value="attach">${esc(i18n.modeAttach || "在红豆中打开附件")}</option>
      </optgroup>
    </select>
  </div>
  <div class="hd-body${showDetail ? "" : " hd-body--nodetail"}">
    <div class="hd-side">
      <div class="hd-side-head">
        <span>${esc(i18n.sideCollections || "分类")}</span>
        <span class="hd-refresh" title="${esc(i18n.refresh || "刷新分类")}">⟳</span>
      </div>
      <div class="hd-tree"><div class="hd-tree-loading">${esc(i18n.loading || "加载中…")}</div></div>
    </div>
    <div class="hd-main">
      <div class="hd-list"><div class="hd-empty">${esc(i18n.loading || "加载中…")}</div></div>
      <div class="hd-foot">
        <span class="hd-count"></span>
        <span class="fn__flex-1"></span>
        <button class="b3-button b3-button--cancel hd-relocate" title="${esc(i18n.relocateTip || "弹窗打开后如果换了笔记或光标位置，点这里改为插入到当前光标处")}">${esc(i18n.relocate || "用当前位置")}</button>
        <button class="b3-button b3-button--cancel hd-cancel">${esc(i18n.cancel || "取消")}</button>
        <button class="b3-button b3-button--text hd-ok">${esc(i18n.insert || "插入")}</button>
      </div>
    </div>
    ${showDetail ? `<div class="hd-detail"><div class="hd-detail-empty">${esc(i18n.detailEmpty || "选中一篇文献查看详情")}</div></div>` : ""}
  </div>
</div>`,
            destroyCallback: () => { this._dialog = null; },
        });

        const el = dialog.element;
        const input = el.querySelector(".hd-input");
        const fieldEl = el.querySelector(".hd-field");
        const listEl = el.querySelector(".hd-list");
        const countEl = el.querySelector(".hd-count");
        const modeEl = el.querySelector(".hd-mode");
        const okEl = el.querySelector(".hd-ok");
        const treeEl = el.querySelector(".hd-tree");
        const detailEl = el.querySelector(".hd-detail");
        modeEl.value = mode || "cite";

        const state = {
            items: [],
            picked: new Map(),
            active: -1,
            seq: 0,
            error: "",
            q: "",
            field: "all",
            scope: { type: "all", id: 0, name: i18n.allItems || "全部文献" },
            cursor: null,
            more: false,
            loading: false,
            detailSeq: 0,
        };
        const expanded = new Set();

        const updateCount = () => {
            const n = state.picked.size;
            countEl.textContent = n ? (i18n.picked || "已选") + " " + n + "/" + MAX_SELECT : "";
            okEl.disabled = !n;
        };

        const rowHtml = (it, idx) => {
            const on = state.picked.has(it.id);
            const authors = authorsText(it, 2);
            const year = yearOf(it);
            const meta = [];
            if (year) meta.push(`<span class="hd-year">${esc(year)}</span>`);
            if (authors) meta.push(`<span>${esc(authors)}${(it.creators || []).length > 2 ? " 等" : ""}</span>`);
            if (it.publicationTitle) meta.push(`<span class="hd-journal">${esc(clip(it.publicationTitle, 32))}</span>`);
            const badges = [];
            if (hasPdf(it)) badges.push('<span class="hd-badge hd-badge--pdf">PDF</span>');
            if ((it.notes || []).length) badges.push('<span class="hd-badge">笔记</span>');
            return `<div class="hd-row${on ? " hd-row--on" : ""}${idx === state.active ? " hd-row--active" : ""}" data-id="${it.id}" data-idx="${idx}">
  <span class="hd-check${on ? " hd-check--on" : ""}"></span>
  <div class="hd-row-main">
    <div class="hd-row-title">${esc(it.title || "(无标题)")}</div>
    <div class="hd-row-meta">${meta.join('<span class="hd-dot">·</span>')}${badges.join("")}</div>
  </div>
</div>`;
        };

        const render = () => {
            if (state.error) {
                listEl.innerHTML = `<div class="hd-empty hd-error">${esc(state.error)}</div>`;
                return;
            }
            if (!state.items.length) {
                listEl.innerHTML = `<div class="hd-empty">${esc(i18n.noResult || "没有找到文献，换个关键词试试")}</div>`;
                return;
            }
            const rows = state.items.map(rowHtml).join("");
            const more = state.more ? `<div class="hd-more">${esc(i18n.loadMore || "滚动加载更多…")}</div>` : "";
            listEl.innerHTML = rows + more;
        };

        /* 分类树 */
        const renderTree = (data) => {
            const rows = [];
            const fixed = [
                { type: "all", name: i18n.allItems || "全部文献" },
            ];
            rows.push(`<div class="hd-tree-group">${esc(i18n.sideLibrary || "浏览")}</div>`);
            fixed.forEach(f => {
                const on = !state.q && state.scope.type === f.type;
                rows.push(`<div class="hd-tree-item${on ? " hd-tree-item--on" : ""}" data-type="${f.type}" style="padding-left:10px">
  <span class="hd-tree-name">${esc(f.name)}</span>
</div>`);
            });
            rows.push(`<div class="hd-tree-group">${esc(i18n.sideCollections || "分类")}</div>`);
            const walk = (nodes, depth) => {
                (nodes || []).forEach(n => {
                    const hasKids = n.children && n.children.length;
                    const open = expanded.has(n.id);
                    const on = !state.q && state.scope.type === "collection" && state.scope.id === n.id;
                    rows.push(`<div class="hd-tree-item${on ? " hd-tree-item--on" : ""}" data-coll="${n.id}" data-name="${esc(n.name)}" style="padding-left:${10 + depth * 14}px">
  <span class="hd-tree-arrow${hasKids ? "" : " hd-tree-arrow--none"}">${hasKids ? (open ? "▾" : "▸") : ""}</span>
  <span class="hd-tree-name" title="${esc(n.name)}">${esc(n.name)}</span>
  <span class="hd-tree-count">${n.itemCount || 0}</span>
</div>`);
                    if (hasKids && open) walk(n.children, depth + 1);
                });
            };
            walk(data.tree, 0);
            treeEl.innerHTML = rows.join("");
        };

        const loadTree = async (force) => {
            try {
                const data = await this.client.collections(force);
                if (!expanded.size) {
                    (data.tree || []).forEach(n => expanded.add(n.id));
                }
                renderTree(data);
            } catch (err) {
                treeEl.innerHTML = `<div class="hd-tree-loading hd-error">${esc(err.message)}</div>`;
            }
        };

        /* 详情 */
        const renderDetail = (item) => {
            if (!detailEl) return;
            if (!item) {
                detailEl.innerHTML = `<div class="hd-detail-empty">${esc(i18n.detailEmpty || "选中一篇文献查看详情")}</div>`;
                return;
            }
            const authors = (item.creators || []).map(creatorName).filter(Boolean);
            const tags = (item.tags || []).filter(t => t && t.charAt(0) !== "/");
            const paths = state.paths || [];
            const lines = [];
            lines.push(`<div class="hd-detail-title">${esc(item.title || "")}</div>`);
            const meta = [];
            if (yearOf(item)) meta.push(esc(yearOf(item)));
            if (item.publicationTitle) meta.push(esc(item.publicationTitle));
            if (item.itemType) meta.push(esc(typeLabel(item.itemType)));
            lines.push(`<div class="hd-detail-meta">${meta.join(" · ")}</div>`);
            if (authors.length) {
                lines.push(`<div class="hd-detail-authors">${esc(authors.join(", "))}</div>`);
            }
            const kvRows = [];
            if (item.volume || item.issue || item.pages) {
                kvRows.push(`<div class="hd-kv"><span>卷期页</span><b>${esc([item.volume, item.issue, item.pages].filter(Boolean).join(" / "))}</b></div>`);
            }
            if (item.DOI) {
                kvRows.push(`<div class="hd-kv"><span>DOI</span><b><a href="https://doi.org/${esc(item.DOI)}" target="_blank">${esc(item.DOI)}</a></b></div>`);
            }
            if (item.PMID) kvRows.push(`<div class="hd-kv"><span>PMID</span><b>${esc(item.PMID)}</b></div>`);
            if (paths.length) kvRows.push(`<div class="hd-kv hd-kv--wrap"><span>分类</span><b>${esc(paths.join("；"))}</b></div>`);
            if (tags.length) {
                kvRows.push(`<div class="hd-detail-tags">${tags.slice(0, 12).map(t => `<span class="hd-chip">${esc(t)}</span>`).join("")}</div>`);
            }
            if (kvRows.length) lines.push(`<div class="hd-detail-kv">${kvRows.join("")}</div>`);
            if (item.abstract) {
                lines.push(`<div class="hd-detail-abstract"><div class="hd-detail-h">${esc(i18n.abstract || "摘要")}</div><div class="hd-detail-abs-text">${esc(clip(this.abstractText(item), 800))}</div></div>`);
            }
            const acts = [];
            if (item.key) {
                acts.push(`<a class="hd-act" data-act="open">${esc(i18n.openInHongdou || "在红豆打开")}</a>`);
                if (hasPdf(item)) acts.push(`<a class="hd-act" data-act="pdf">${esc(i18n.openPdf || "打开 PDF")}</a>`);
            }
            if (acts.length) lines.push(`<div class="hd-detail-acts">${acts.join("")}</div>`);
            detailEl.innerHTML = lines.join("");
        };

        const showDetailFor = async (item) => {
            if (!detailEl || !item) return;
            const my = ++state.detailSeq;
            state.paths = [];
            renderDetail(item);
            try {
                const full = await this.client.hydrate(item);
                if (my !== state.detailSeq) return;
                const paths = await this.client.collectionPath(full.collectionIDs).catch(() => []);
                if (my !== state.detailSeq) return;
                state.paths = paths;
                renderDetail(full);
            } catch (err) { /* 详情失败不影响列表 */ }
        };

        /* 列表加载 */
        const fetchPage = async (cursor) => {
            if (state.q) {
                return await this.client.search(state.q, { limit: 80, field: state.field });
            }
            if (state.scope.type === "all") {
                return await this.client.listItems({ limit: 60, cursor: cursor });
            }
            return await this.client.collectionItems(state.scope.id, { limit: 60, cursor: cursor });
        };

        const toItems = (r) => {
            const raw = (r && (r.items || r.results)) || [];
            return raw
                .map(normalizeItem)
                .filter(x => x && x.title)
                .filter(x => !x.parentItemID);
        };

        const nextCursor = (r) => {
            if (!r) return null;
            if (r.pagination && r.pagination.nextCursor) return r.pagination.nextCursor;
            if (r.nextCursor) return r.nextCursor;
            return null;
        };

        const load = async (reset) => {
            const my = ++state.seq;
            state.error = "";
            if (reset) {
                state.items = [];
                state.active = -1;
                state.cursor = null;
                state.more = false;
            }
            state.loading = true;
            if (reset) listEl.innerHTML = `<div class="hd-empty">${esc(i18n.loading || "加载中…")}</div>`;
            try {
                const r = await fetchPage(state.cursor);
                if (my !== state.seq) return;
                const items = toItems(r);
                state.items = reset ? items : state.items.concat(items);
                state.cursor = nextCursor(r);
                state.more = !!state.cursor;
                state.loading = false;
                if (state.active < 0 && state.items.length) state.active = 0;
                render();
                if (state.active >= 0) showDetailFor(state.items[state.active]);
                enrichVisible(state.items);
            } catch (err) {
                if (my !== state.seq) return;
                state.loading = false;
                state.error = err.message;
                render();
            }
        };

        /** 分类接口不带期刊/附件，首屏这批回查一次，让列表信息完整 */
        const enrichVisible = async (items) => {
            const targets = items.slice(0, 12).filter(x => !x._hydrated);
            if (!targets.length) return;
            const my = state.seq;
            await mapLimit(targets, 4, async (it) => {
                const full = await this.client.hydrate(it).catch(() => null);
                if (full) Object.assign(it, full);
            });
            if (my !== state.seq) return;
            const top = listEl.scrollTop;
            render();
            listEl.scrollTop = top;
        };

        const loadMore = async () => {
            if (state.loading || !state.more) return;
            await load(false);
        };

        const toggle = (id) => {
            if (state.picked.has(id)) {
                state.picked.delete(id);
            } else {
                if (state.picked.size >= MAX_SELECT) {
                    showMessage((i18n.tooMany || "最多选 %n 篇").replace("%n", MAX_SELECT), 3000, "error");
                    return;
                }
                const it = state.items.find(x => x.id === id);
                if (it) state.picked.set(id, it);
            }
            render();
            updateCount();
        };

        const doInsert = () => {
            const picked = Array.from(state.picked.values());
            if (!picked.length) {
                if (state.active >= 0 && state.items[state.active]) {
                    picked.push(state.items[state.active]);
                } else {
                    return;
                }
            }
            // 弹窗期间换过文档：旧选区已经不属于当前文档，改用当前光标
            const nowDoc = this.currentDocId();
            if (this._openedDocId && nowDoc && nowDoc !== this._openedDocId) {
                this._savedRange = null;
                this._openedDocId = nowDoc;
            }
            const m = modeEl.value;
            dialog.destroy();
            this._dialog = null;
            this.runInsert(m, picked);
        };

        /* 事件 */
        listEl.addEventListener("click", (e) => {
            const row = e.target.closest(".hd-row");
            if (!row) return;
            const idx = Number(row.dataset.idx);
            state.active = idx;
            toggle(Number(row.dataset.id));
            const it = state.items[idx];
            if (it) showDetailFor(it);
        });

        listEl.addEventListener("dblclick", (e) => {
            const row = e.target.closest(".hd-row");
            if (!row) return;
            const id = Number(row.dataset.id);
            if (!state.picked.has(id)) toggle(id);
            doInsert();
        });

        listEl.addEventListener("scroll", () => {
            if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 60) loadMore();
        });

        treeEl.addEventListener("click", (e) => {
            const arrow = e.target.closest(".hd-tree-arrow");
            const item = e.target.closest(".hd-tree-item");
            if (!item) return;
            if (item.dataset.coll) {
                const id = Number(item.dataset.coll);
                if (arrow && !arrow.classList.contains("hd-tree-arrow--none")) {
                    if (expanded.has(id)) expanded.delete(id);
                    else expanded.add(id);
                    this.client.collections().then(renderTree).catch(() => {});
                    return;
                }
                state.scope = { type: "collection", id: id, name: item.dataset.name || "" };
                input.value = "";
                state.q = "";
            } else if (item.dataset.type) {
                state.scope = { type: item.dataset.type, id: 0, name: item.textContent.trim() };
                input.value = "";
                state.q = "";
            }
            this.client.collections().then(renderTree).catch(() => {});
            load(true);
        });

        el.querySelector(".hd-refresh").addEventListener("click", () => {
            this.client.collections(true).then(renderTree).catch(() => {});
        });

        if (detailEl) {
            detailEl.addEventListener("click", (e) => {
                const a = e.target.closest(".hd-act");
                if (!a) return;
                const item = state.items[state.active];
                if (!item) return;
                const act = a.dataset.act;
                if (act === "pdf") {
                    this.openPdf(item).then(ok => {
                        if (!ok) showMessage(i18n.noPdf || "这篇文献在红豆里没有本地 PDF 附件", 4000, "error");
                    });
                } else {
                    this.openExternal(this.itemUrl(item, "select"));
                }
            });
        }

        okEl.addEventListener("click", doInsert);
        el.querySelector(".hd-cancel").addEventListener("click", () => dialog.destroy());

        // 弹窗打开后切过笔记 / 挪过光标时，用这里重新锚定插入位置
        el.querySelector(".hd-relocate").addEventListener("click", () => {
            const editor = (typeof siyuan.getActiveEditor === "function") ? siyuan.getActiveEditor() : null;
            if (!editor) {
                showMessage(i18n.needEditor || "请先把光标放到正文里", 4000, "error");
                return;
            }
            this._activeEditor = editor;
            this._savedRange = null;
            try {
                const sel = window.getSelection();
                const wys = editor.protyle && editor.protyle.wysiwyg && editor.protyle.wysiwyg.element;
                if (sel && sel.rangeCount && wys && wys.contains(sel.getRangeAt(0).startContainer)) {
                    this._savedRange = sel.getRangeAt(0).cloneRange();
                }
            } catch (err) { /* 用编辑器自身光标 */ }
            this._openedDocId = this.currentDocId();
            showMessage(i18n.relocated || "已改为插入到当前笔记的光标位置", 2500);
        });

        const searchLater = debounce(() => {
            state.q = input.value.trim();
            state.field = fieldEl.value;
            load(true);
        }, 280);
        input.addEventListener("input", searchLater);
        fieldEl.addEventListener("change", () => {
            state.field = fieldEl.value;
            if (state.q) load(true);
        });

        input.addEventListener("keydown", (e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (!state.items.length) return;
                const step = e.key === "ArrowDown" ? 1 : -1;
                state.active = (state.active + step + state.items.length) % state.items.length;
                render();
                const row = listEl.querySelector(`.hd-row[data-idx="${state.active}"]`);
                if (row) row.scrollIntoView({ block: "nearest" });
                const it = state.items[state.active];
                if (it) showDetailFor(it);
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (state.picked.size) {
                    doInsert();
                } else if (state.active >= 0 && state.items[state.active]) {
                    toggle(state.items[state.active].id);
                }
            } else if (e.key === "Escape") {
                dialog.destroy();
            }
        });

        setTimeout(() => input.focus(), 50);
        loadTree(false);
        load(true);
        updateCount();
        return dialog;
    }

    /** 插入红豆里当前选中的文献 */
    async insertFocused() {
        this._activeEditor = (typeof siyuan.getActiveEditor === "function") ? siyuan.getActiveEditor() : null;
        try {
            const r = await this.client.focus();
            const items = (r.items || [])
                .filter(x => x.parentItemID === null || x.parentItemID === undefined)
                .map(normalizeItem)
                .filter(Boolean);
            if (!items.length) {
                showMessage(this.i18n.noFocus || "红豆里没有选中的文献", 4000, "error");
                return;
            }
            await this.runInsert("cite", items);
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 在红豆里打开当前选中的文献，或它的 PDF 附件 */
    async openFocusedItem(pdf) {
        try {
            const r = await this.client.focus();
            const item = (r.items || [])[0];
            if (!item) {
                showMessage(this.i18n.noFocus || "红豆里没有选中的文献", 4000, "error");
                return;
            }
            if (pdf) {
                const ok = await this.openPdf(item);
                if (!ok) {
                    showMessage(this.i18n.noPdf || "这篇文献在红豆里没有本地 PDF 附件", 4000, "error");
                }
                return;
            }
            const full = await this.client.getItem(item.id).catch(() => null);
            const key = (full && full.key) || item.key;
            if (!key) {
                showMessage(this.i18n.noKey || "这篇文献缺少定位标识，无法在红豆中打开", 4000, "error");
                return;
            }
            this.openExternal(this.itemUrl({ key: key }, "select"));
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /* --------------------------------------------------------------- 材料 */

    async buildMaterialMarkdown(item) {
        const lines = [];
        const paths = await this.client.collectionPath(item.collectionIDs).catch(() => []);
        lines.push(`> 来源：[${linkText(item.title || "")}](${this.itemUrl(item) || "#"})　·　导出时间：${nowText()}`);
        if (paths.length) lines.push(`> 分类：${paths.join("；")}`);
        lines.push("");

        let notes = [];
        let anns = null;
        try {
            const r = await this.client.getNotes(item.id);
            notes = (r && r.notes) || [];
        } catch (err) { /* 无笔记 */ }
        try {
            anns = await this.client.getAnnotations(item.id);
        } catch (err) { /* 无批注 */ }

        if (notes.length) {
            lines.push("## 笔记");
            lines.push("");
            notes.forEach((n, i) => {
                if (notes.length > 1) {
                    lines.push(`### 笔记 ${i + 1}`);
                    lines.push("");
                }
                lines.push(html2text(n.note || n.content || ""));
                lines.push("");
            });
        }

        const atts = (anns && anns.attachments) || [];
        const annList = [];
        atts.forEach(a => {
            (a.annotations || []).forEach(x => annList.push({ att: a, ann: x }));
        });
        if (annList.length) {
            annList.sort((a, b) => (Number(a.ann.page) || 0) - (Number(b.ann.page) || 0));
            lines.push("## 批注");
            lines.push("");
            annList.forEach(x => {
                const a = x.ann;
                const page = a.page ? `第 ${a.page} 页` : "";
                const text = String(a.text || "").trim();
                const comment = String(a.comment || "").trim();
                if (!text && !comment) return;
                if (text) {
                    lines.push(`> ${text.replace(/\n/g, "\n> ")}`);
                    if (page) lines.push(`>`);
                    if (page) lines.push(`> — ${page}`);
                    lines.push("");
                }
                if (comment) {
                    lines.push(comment);
                    lines.push("");
                }
            });
        }

        if (!notes.length && !annList.length) {
            lines.push("_（这篇文献在红豆里还没有笔记，也没有 PDF 批注）_");
            lines.push("");
        }
        let md = lines.join("\n");
        if (md.length > 60000) md = md.slice(0, 60000) + "\n\n> （内容过长，已截断）";
        return md;
    }

    /** 另存为独立的材料文档 */
    async saveMaterialNote() {
        this._activeEditor = (typeof siyuan.getActiveEditor === "function") ? siyuan.getActiveEditor() : null;
        try {
            const r = await this.client.focus();
            let item = (r.items || [])[0];
            if (!item) {
                showMessage(this.i18n.noFocus || "红豆里没有选中的文献", 4000, "error");
                return;
            }
            showMessage(this.i18n.reading || "正在读取红豆材料…", 2000);
            item = (await this.client.hydrate(normalizeItem(item))) || normalizeItem(item);
            const md = await this.buildMaterialMarkdown(item);
            const notebook = await this.resolveNotebook();
            const folder = this.data.folder || DEFAULTS.folder;
            await this.ensureDocPath(notebook, `/${folder}/材料`);
            const name = safeName(`${this.noteFileName(item)} - 材料 ${stamp()}`);
            const id = await kernel("/api/filetree/createDocWithMd", {
                notebook: notebook,
                path: `/${folder}/材料/${name}`,
                markdown: md,
            });
            await kernel("/api/attr/setBlockAttrs", {
                id: id,
                attrs: {
                    "custom-hongdou-item-id": String(item.id),
                    "custom-hongdou-key": item.key || "",
                    "custom-hongdou-material": "1",
                },
            }).catch(() => {});
            this.openDoc(id);
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 更新当前阅读笔记里的「红豆材料」小节 */
    async updateMaterial() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needEditor || "请先把光标放到阅读笔记里", 4000, "error");
            return;
        }
        try {
            const itemID = await this.boundItemId(docId);
            if (!itemID) {
                showMessage(this.i18n.notReadingNote || "当前文档不是插件生成的阅读笔记（缺少红豆标识）", 5000, "error");
                return;
            }
            const kids = await kernel("/api/block/getChildBlocks", { id: docId });
            const list = Array.isArray(kids) ? kids : [];
            const idx = list.findIndex(k => k.type === "h" && String(k.content || "").indexOf("红豆材料") >= 0);
            if (idx < 0) {
                showMessage(this.i18n.noMaterialSection || "没找到「红豆材料」小节，请手动加一个二级标题", 5000, "error");
                return;
            }
            const doomed = list.slice(idx + 1);
            const ok = window.confirm(
                (this.i18n.updateConfirm || "将替换「红豆材料」小节下的 %n 个块，你自己的心得不受影响。继续？").replace("%n", doomed.length)
            );
            if (!ok) return;

            showMessage(this.i18n.reading || "正在读取红豆材料…", 2000);
            const full = await this.client.getItem(itemID).catch(() => null);
            const item = full || normalizeItem({ id: itemID, title: "红豆材料" });
            const md = await this.buildMaterialMarkdown(item);

            // 更新前留一份副本，误覆盖时能捞回来
            await this.backupBeforeUpdate(docId);

            for (const k of doomed) {
                await kernel("/api/block/deleteBlock", { id: k.id });
            }
            await kernel("/api/block/insertBlock", {
                dataType: "markdown",
                data: md,
                previousID: list[idx].id,
            });
            showMessage(this.i18n.updated || "红豆材料已更新");
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 更新材料前把整篇文档备份一份（最多留 10 份） */
    async backupBeforeUpdate(docId) {
        try {
            const data = await kernel("/api/export/exportMdContent", { id: docId });
            const md = (data && data.content) || "";
            if (!md.trim()) return;
            const name = (data && data.hPath ? String(data.hPath).split("/").pop() : "") || docId;
            const list = await this.loadBackups();
            list.unshift({ time: nowText(), docId: docId, name: name, md: md });
            this._backups = list.slice(0, 10);
            await this.saveData("backups.json", this._backups);
        } catch (err) { /* 备份失败不阻塞更新 */ }
    }

    async loadBackups() {
        if (this._backups) return this._backups;
        try {
            const r = await this.loadData("backups.json");
            this._backups = Array.isArray(r) ? r : [];
        } catch (err) {
            this._backups = [];
        }
        return this._backups;
    }

    /** 列出材料更新前的备份，可复制或插回当前文档 */
    async showBackups() {
        const list = await this.loadBackups();
        if (!list.length) {
            showMessage(this.i18n.backupEmpty || "还没有备份。更新「红豆材料」时插件会自动留一份副本。", 5000);
            return;
        }
        this._activeEditor = (typeof siyuan.getActiveEditor === "function") ? siyuan.getActiveEditor() : null;
        try {
            const sel = window.getSelection();
            this._savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        } catch (err) { this._savedRange = null; }

        const rows = list.map((b, i) => `<div class="hd-bk-row">
  <div class="hd-bk-main">
    <div class="hd-bk-time">${esc(b.time || "")}</div>
    <div class="hd-bk-name" title="${esc(b.name || "")}">${esc(clip(b.name || "", 40))}　<span class="hd-bk-size">${Math.round((b.md || "").length / 100) / 10}k 字</span></div>
  </div>
  <button class="b3-button b3-button--cancel hd-bk-copy" data-i="${i}">${esc(this.i18n.copy || "复制")}</button>
  <button class="b3-button b3-button--text hd-bk-insert" data-i="${i}">${esc(this.i18n.insert || "插入")}</button>
</div>`).join("");

        const d = new Dialog({
            title: this.i18n.backupTitle || "材料更新备份",
            width: "640px",
            content: `<div class="hd-backups">
  <div class="hd-bk-tip">${esc(this.i18n.backupTip || "每次更新「红豆材料」前，插件会把当篇文档存一份副本；最多保留 10 份。")}</div>
  <div class="hd-bk-list">${rows}</div>
</div>`,
        });
        d.element.addEventListener("click", async (e) => {
            const ins = e.target.closest(".hd-bk-insert");
            const cp = e.target.closest(".hd-bk-copy");
            if (ins) {
                const b = list[Number(ins.dataset.i)];
                if (!b) return;
                d.destroy();
                this.insertMarkdown(b.md);
                return;
            }
            if (cp) {
                const b = list[Number(cp.dataset.i)];
                if (!b) return;
                try {
                    await navigator.clipboard.writeText(b.md || "");
                    showMessage(this.i18n.copied || "已复制", 2500);
                } catch (err) {
                    showMessage(err.message, 4000, "error");
                }
            }
        });
    }

    /* ----------------------------------------------------------- 双向联动 */

    /** 把当前思源文档写回红豆条目笔记 */
    async pushCurrentNote() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needEditor || "请先把光标放到阅读笔记里", 4000, "error");
            return;
        }
        const itemId = await this.boundItemId(docId);
        if (!itemId) {
            showMessage(this.i18n.notReadingNote || "当前文档没有绑定红豆文献，无法写回", 5000, "error");
            return;
        }
        try {
            const data = await kernel("/api/export/exportMdContent", { id: docId });
            let md = stripFrontMatter((data && data.content) || "");
            const docTitle = (data && data.hPath ? String(data.hPath).split("/").pop() : "") || "";
            // 导出内容开头会重复一次文档标题
            if (docTitle && md.indexOf("# " + docTitle) === 0) {
                md = md.slice(("# " + docTitle).length).replace(/^\n+/, "");
            }
            md = md.replace(/\{:[^}]*\}/g, "").replace(/\(\(([\w-]{22})\s+"([^"]*)"\)\)/g, "$2");
            if (!md.trim()) {
                showMessage(this.i18n.emptyDoc || "文档是空的，没有可写回的内容", 4000, "error");
                return;
            }
            const html = md2html(md);
            const item = (await this.client.getItem(itemId).catch(() => null)) || normalizeItem({ id: itemId });
            if (this.data.confirmWrite) {
                const ok = window.confirm(
                    `将把当前文档写回红豆文献《${item.title || itemId}》的笔记。\n\n` +
                    `已有笔记会更新（按插件记录），首次写回会新建一条红豆笔记。继续？`
                );
                if (!ok) return;
            }
            showMessage(this.i18n.writing || "正在写回红豆…", 2000);
            const noteAttr = await this.docAttr(docId, "custom-hongdou-note-id");
            if (noteAttr) {
                try {
                    await this.client.updateNote(Number(noteAttr), html);
                    showMessage(this.i18n.pushed || "已更新红豆里的笔记");
                    return;
                } catch (err) {
                    // 笔记被删或并发冲突，退化为新建
                }
            }
            const before = ((await this.client.getNotes(itemId).catch(() => ({}))).notes) || [];
            const r = await this.client.createNote(itemId, html);
            let noteID = (r && (r.noteID || r.id)) || (r && r.note && r.note.id) || 0;
            if (!noteID) {
                const after = ((await this.client.getNotes(itemId).catch(() => ({}))).notes) || [];
                const fresh = after.filter(n => !before.some(b => (b.id || b.noteID) === (n.id || n.noteID)));
                if (fresh.length) noteID = fresh[0].id || fresh[0].noteID;
            }
            if (noteID) {
                await kernel("/api/attr/setBlockAttrs", {
                    id: docId,
                    attrs: { "custom-hongdou-note-id": String(noteID) },
                }).catch(() => {});
            }
            showMessage(this.i18n.pushed || "已写回红豆笔记");
        } catch (err) {
            showMessage(err.message, 7000, "error");
        }
    }

    /** 给当前绑定的文献加标签 */
    async tagBoundItem() {
        const itemId = await this.boundItemId();
        if (!itemId) {
            showMessage(this.i18n.notReadingNote || "先打开一篇由插件创建的阅读笔记，再执行这个命令", 5000, "error");
            return;
        }
        const text = await this.promptDialog(
            this.i18n.tagDialogTitle || "给红豆文献加标签",
            this.i18n.tagDialogTip || "多个标签用逗号分隔，不带 #。标签会写进红豆（不影响思源）。",
            ""
        );
        if (text == null) return;
        const tags = String(text).split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);
        if (!tags.length) return;
        try {
            const args = { itemIDs: [itemId], addTags: tags };
            const prev = await this.client.batchTags([itemId], tags, null);
            await this.applyHighRisk(prev, args, "batchTags");
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 把当前绑定的文献加入红豆分类 */
    async collectionBoundItem() {
        const itemId = await this.boundItemId();
        if (!itemId) {
            showMessage(this.i18n.notReadingNote || "先打开一篇由插件创建的阅读笔记，再执行这个命令", 5000, "error");
            return;
        }
        let data = null;
        try {
            data = await this.client.collections(true);
        } catch (err) {
            showMessage(err.message, 6000, "error");
            return;
        }
        const options = Array.from(data.flat.values());
        const listHtml = options.slice(0, 400).map(o =>
            `<option value="${esc(o.name)}">${esc(o.path)}（${o.count}）</option>`
        ).join("");
        const name = await this.promptDialog(
            this.i18n.moveDialogTitle || "加入红豆分类",
            this.i18n.moveDialogTip || "输入分类名（可用下拉提示），文献会被加入该分类，不会移出原有分类。",
            "",
            `<datalist id="hd-coll-list">${listHtml}</datalist>`,
            "hd-coll-list"
        );
        if (name == null) return;
        const target = String(name).trim();
        if (!target) return;
        try {
            const args = { itemIDs: [itemId], addToCollections: [target] };
            const prev = await this.client.manageCollections([itemId], [target], null);
            await this.applyHighRisk(prev, args, "manageCollections");
            this.client.collections(true).catch(() => {});
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 高危写操作：展示红豆给的预览，用户确认后带令牌执行 */
    async applyHighRisk(preview, args, kind) {
        if (!preview || !preview.confirmationRequired) {
            showMessage(this.i18n.writeDone || "已在红豆中更新", 3000);
            return;
        }
        const intro = preview.operation && preview.operation.introduction ? preview.operation.introduction : {};
        const text = [
            intro.description || "",
            intro.impact || "",
            "",
            (this.i18n.writeConfirm || "这是对红豆文献库的写入操作，确认执行？"),
        ].filter(Boolean).join("\n");
        if (!window.confirm(text)) return;
        const token = preview.confirmationToken;
        if (kind === "batchTags") {
            await this.client.confirmTags(args, token);
        } else {
            await this.client.confirmCollections(args, token);
        }
        showMessage(this.i18n.writeDone || "已在红豆中更新", 3000);
    }

    /** 查看当前文档绑定的红豆文献 */
    async showBoundItem() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needEditor || "请先把光标放到正文里", 4000, "error");
            return;
        }
        const itemId = await this.boundItemId(docId);
        if (!itemId) {
            showMessage(this.i18n.notReadingNote || "当前文档没有绑定红豆文献", 5000, "error");
            return;
        }
        try {
            const item = await this.client.getItem(itemId);
            if (!item) throw new Error("红豆里找不到这篇文献");
            const paths = await this.client.collectionPath(item.collectionIDs).catch(() => []);
            const lines = [
                `**${item.title}**`,
                "",
                `- 作者：${authorsText(item, 6) || "—"}`,
                `- 出处：${pubText(item) || "—"}`,
                `- 年份：${yearOf(item) || "—"}　类型：${typeLabel(item.itemType)}`,
            ];
            if (item.DOI) lines.push(`- DOI：${item.DOI}`);
            if (paths.length) lines.push(`- 分类：${paths.join("；")}`);
            if (item.tags.length) lines.push(`- 标签：${item.tags.join(", ")}`);
            lines.push(`- 红豆：[在红豆中打开](${this.itemUrl(item)})`);
            const d = new Dialog({
                title: this.i18n.boundTitle || "当前文档绑定的文献",
                width: "620px",
                content: `<div class="b3-dialog__content hd-bound">${md2html(lines.join("\n"))}</div>`,
            });
            setTimeout(() => d.destroy(), 60000);
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /* ------------------------------------------------------------ 引用体系 */

    /** 当前生效的 CSL 样式 */
    /**
     * 当前生效的引用样式。
     * 优先级：文档级覆盖（块属性）→ 全局设置 → 红豆默认样式。
     */
    async citationStyle(docId) {
        let meta = { defaultStyleID: "", list: [] };
        try { meta = await this.client.styleMeta(); } catch (err) { /* 红豆没连上就退回设置里的记录 */ }
        const list = meta.list || [];

        let want = "";
        const did = docId || this.currentDocId();
        if (did) {
            try {
                const v = await this.docAttr(did, ATTR_STYLE);
                if (v) want = String(v).trim();
            } catch (err) { /* 忽略 */ }
        }
        if (!want) want = String(this.data.styleID || "").trim();

        const pick = want || meta.defaultStyleID || "";
        if (!pick) return { styleID: "", title: this.data.styleTitle || "" };
        const hit = list.find(s => s.styleID === pick);
        if (hit) return hit;
        return { styleID: pick, title: this.data.styleTitle || pick };
    }

    /** 设置本篇的引用样式（不影响其他文档） */
    async openDocStyle() {
        const docId = this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needDoc || "先打开一篇文档", 4000, "error");
            return;
        }
        let styles = [];
        try { styles = await this.client.styles(); } catch (err) { styles = []; }
        if (!styles.length) {
            showMessage(this.i18n.styleNone || "红豆里取不到样式列表", 4000, "error");
            return;
        }
        let current = "";
        try { current = String(await this.docAttr(docId, ATTR_STYLE) || "").trim(); } catch (err) { /* 忽略 */ }

        const width = 480;
        const listHtml = styles.map(s => {
            const on = s.styleID === current ? " hd-ss-on" : "";
            return `<div class="hd-ss-row${on}" data-id="${esc(s.styleID)}">
    <div class="hd-ss-t">${esc(s.title || s.styleID)}</div>
    ${s.styleID === current ? `<div class="hd-ss-badge">${esc(this.i18n.ssCurrent || "本篇使用中")}</div>` : ""}
</div>`;
        }).join("");

        const dlg = new Dialog({
            title: this.i18n.ssTitle || "设置本篇引用样式",
            content: `<div class="b3-dialog__content hd-dialog">
    <div class="hd-ss-tip">${esc((this.i18n.ssTip || "只影响这一篇文档；留空则跟随全局设置（当前全局：%s）").replace("%s", this.data.styleTitle || (this.i18n.styleDefault || "红豆默认"))) }</div>
    <div class="hd-ss-list">${listHtml}</div>
    <div class="fn__flex hd-bp-actions">
        <button class="b3-button b3-button--cancel fn__flex-1 hd-ss-clear">${esc(this.i18n.ssClear || "跟随全局")}</button>
        <div class="fn__space"></div>
        <button class="b3-button b3-button--cancel fn__flex-1 hd-ss-close">${esc(this.i18n.cancel || "关闭")}</button>
    </div>
</div>`,
            width: width + "px",
        });
        this._ssDlg = dlg;
        const el = dlg.element;

        const apply = async (styleID) => {
            try {
                await kernel("/api/attr/setBlockAttrs", { id: docId, attrs: { [ATTR_STYLE]: styleID || "" } });
                showMessage(styleID
                    ? (this.i18n.ssDone || "本篇样式已更新，正在重排…")
                    : (this.i18n.ssFollowGlobal || "已改为跟随全局样式，正在重排…"), 2600);
                try { dlg.destroy(); } catch (e) { /* 忽略 */ }
                await this.refreshCitations({ docId: docId });
            } catch (err) {
                showMessage(err.message, 5000, "error");
            }
        };

        el.querySelectorAll(".hd-ss-row").forEach(row => {
            row.addEventListener("click", () => apply(row.dataset.id));
        });
        const btnClear = el.querySelector(".hd-ss-clear");
        if (btnClear) btnClear.addEventListener("click", () => apply(""));
        const btnClose = el.querySelector(".hd-ss-close");
        if (btnClose) btnClose.addEventListener("click", () => { try { dlg.destroy(); } catch (e) { /* 忽略 */ } });
    }

    /** 条目 → 快照（只留重排正文需要的几个字段） */
    snapOf(item) {
        return {
            id: Number(item.id) || 0,
            k: item.key || "",
            w: item._who || citeWho(item),
            y: yearOf(item),
            t: clip(stripTags(item.title || ""), 80),
        };
    }

    snapToItem(key, s) {
        return {
            id: Number(s.id) || 0,
            key: s.k || key,
            title: s.t || "",
            year: s.y || "",
            itemType: "",
            creators: [],
            _who: s.w || "",
            _snap: true,
        };
    }

    async snapLoad(docId) {
        try {
            const v = await this.docAttr(docId, ATTR_SNAP);
            if (!v) return {};
            const o = JSON.parse(v);
            return (o && typeof o === "object") ? o : {};
        } catch (err) {
            return {};
        }
    }

    async snapSave(docId, map) {
        if (!this.data.citeSnapshot) return;
        try {
            const txt = JSON.stringify(map);
            if (txt.length > 80000) return;   // 条数太多就不写属性，免得拖慢文档
            await kernel("/api/attr/setBlockAttrs", { id: docId, attrs: { [ATTR_SNAP]: txt } });
        } catch (err) { /* 快照只是兜底，失败不影响主体 */ }
    }

    /** 扫描整篇文档的正文引用（走导出的 markdown，一次请求，按顺序） */
    async scanDocCites(docId) {
        try {
            const data = await kernel("/api/export/exportMdContent", { id: docId });
            const md = (data && data.content) || "";
            const occ = scanCites(md).filter(c => !c.bib);
            const order = [];
            const seen = new Set();
            occ.forEach(c => c.keys.forEach(k => {
                if (!seen.has(k)) { seen.add(k); order.push(k); }
            }));
            const nums = new Map();
            order.forEach((k, i) => nums.set(k, i + 1));
            return { md: md, occ: occ, order: order, nums: nums };
        } catch (err) {
            return { md: "", occ: [], order: [], nums: new Map() };
        }
    }

    /**
     * key → 条目。三条路依次尝试：
     * ① 快照里记的条目 ID；② 引用链接里的 i= 参数；③ 前两者都没有就只能留空（正文保持原文不动）
     */
    async resolveItems(keys, snap, hintIds) {
        const out = new Map();
        const need = [];
        (keys || []).forEach(k => {
            const s = snap[k];
            const hint = hintIds && hintIds.get(k);
            if (s && s.id) need.push({ k: k, id: s.id });
            else if (hint) need.push({ k: k, id: hint });
        });
        const got = await mapLimit(need, HYDRATE_CONCURRENCY, async (rec) => {
            try {
                const raw = await this.client.getItem(rec.id);
                const item = normalizeItem(raw);
                if (!item) return null;
                if (!item.key) item.key = rec.k;
                return { k: rec.k, item: item };
            } catch (err) {
                return null;
            }
        });
        got.forEach(r => { if (r && r.item) out.set(r.k, r.item); });
        (keys || []).forEach(k => {
            if (out.get(k)) return;
            out.set(k, snap[k] ? this.snapToItem(k, snap[k]) : null);
        });
        return out;
    }

    /** 插入正文引用（正文标签 + 文末表由 refreshCitations 统一收口） */
    async insertCitation(picked) {
        try {
            const docId = this.currentDocId();
            const items = (await this.client.hydrateAll(picked)).filter(it => it && it.key);
            if (!items.length) {
                showMessage(this.i18n.citeNoKey || "这些条目在红豆里取不到 key，换一篇试试", 5000, "error");
                return;
            }
            const style = await this.citationStyle(docId);
            const numeric = isNumericStyle(style, this.data.citeForm);
            const scan = docId ? await this.scanDocCites(docId) : { order: [], nums: new Map(), occ: [] };
            const nums = new Map(scan.nums);
            items.forEach(it => { if (!nums.has(it.key)) nums.set(it.key, nums.size + 1); });

            // 重复引用提醒（同一处位置重复插同一篇，多半是手滑）
            if (this.data.citeWarnDup) {
                const dup = items.filter(it => scan.order.indexOf(it.key) >= 0);
                if (dup.length && dup.length === items.length) {
                    const ok = window.confirm(
                        (this.i18n.citeDup || "这 %n 篇在本文已经引用过，仍要再插一条？")
                            .replace("%n", dup.length)
                    );
                    if (!ok) return;
                }
            }

            const md = citeMarkdown(items, {
                numeric: numeric,
                narrative: !!this.data.citeNarrative,
                nums: nums,
                suffix: new Map(),
                scheme: this.data.scheme,
                superscript: !!this.data.citeSuperscript,
            });
            if (!md) {
                showMessage(this.i18n.citeNoKey || "生成引用失败", 4000, "error");
                return;
            }
            if (docId) {
                const snap = await this.snapLoad(docId);
                items.forEach(it => { snap[it.key] = this.snapOf(it); });
                await this.snapSave(docId, snap);
            }
            if (!this.insertMarkdown(md)) return;
            if (this.data.bibAuto && docId) {
                // 等编辑器把块写进内核再重排，否则扫不到刚插入的这条
                setTimeout(() => {
                    this.refreshCitations({ docId: docId, quiet: true }).catch(() => null);
                }, 1000);
            }
        } catch (err) {
            showMessage(err.message, 7000, "error");
        }
    }

    /** 清掉旧的参考文献区，返回插入锚点 */
    async clearBibArea(docId) {
        const blocks = await topBlocks(docId);
        if (!blocks.length) return { prevId: "" };
        let head = -1;
        try {
            const rows = await kernel("/api/query/sql", {
                stmt: `select id from blocks where root_id = '${docId}' and ial like '%${ATTR_BIB}%'`,
            });
            const ids = (rows || []).map(x => String(x.id));
            if (ids.length) head = blocks.findIndex(b => ids.indexOf(String(b.id)) >= 0);
        } catch (err) { /* 属性查不到就走标题兜底 */ }
        if (head < 0) {
            const title = String(this.data.bibTitle || "").trim();
            if (title) {
                for (let i = blocks.length - 1; i >= 0; i--) {
                    if (blocks[i].type === "h" && String(blocks[i].content || "").trim() === title) { head = i; break; }
                }
            }
        }
        if (head < 0) return { prevId: blocks.length ? blocks[blocks.length - 1].id : "" };

        const prevId = head > 0 ? blocks[head - 1].id : "";
        const doomed = [];
        for (let i = head; i < blocks.length; i++) {
            // 遇到下一个标题就收手，表后面的致谢、附录不会被卷进来
            if (i > head && blocks[i].type === "h") break;
            doomed.push(blocks[i].id);
        }
        for (const id of doomed) await deleteBlockById(id);
        return { prevId: prevId };
    }

    /** 按当前样式重建文末参考文献表，返回条目数 */
    async rebuildBibliography(docId, list, style, opt) {
        opt = opt || {};
        const real = (list || []).filter(it => it && it.id && !it._snap);
        const anchor = await this.clearBibArea(docId);
        if (!real.length) return 0;

        let r = null;
        try {
            r = await this.client.formatBibliography(real.map(it => it.id), style && style.styleID);
        } catch (err) {
            showMessage((this.i18n.bibFail || "参考文献表生成失败：") + err.message, 6000, "error");
            return 0;
        }
        const content = String((r && r.content) || "").trim();
        if (!content) return 0;
        let lines = content.split(/\r?\n/)
            .map(s => s.replace(/\s+$/, ""))
            .filter(s => s.trim());

        // 数字式样式的条目顺序 = 传入顺序，可以逐条挂回链；作者年式 CSL 会重排，
        // 行与条目的对应关系不可靠，就不挂，正文引用照样能点回红豆。
        if (opt.numeric && lines.length === real.length) {
            const base = this.data.scheme === "zotero" ? "zotero" : "hongdou";
            lines = lines.map((l, i) => {
                const key = real[i] ? itemKey(real[i]) : "";
                if (!key) return l;
                return l + ` [↗](${base}://select/library/items/${key}?bib=1)`;
            });
        }
        lines = lines.map(escapeOl);

        const parts = [];
        const title = String(this.data.bibTitle || "").trim();
        if (title) {
            const lv = Math.min(6, Math.max(1, Number(this.data.bibLevel) || 2));
            parts.push("#".repeat(lv) + " " + title);
        }
        lines.forEach(l => parts.push(l));
        const md = parts.join("\n\n");

        let created = [];
        try {
            const payload = { dataType: "markdown", data: md };
            if (anchor.prevId) payload.previousID = anchor.prevId;
            else payload.parentID = docId;
            created = txIds(await kernel("/api/block/insertBlock", payload));
        } catch (err) {
            showMessage(err.message, 6000, "error");
            return 0;
        }
        if (created.length) {
            try {
                await kernel("/api/attr/setBlockAttrs", { id: created[0], attrs: { [ATTR_BIB]: "head" } });
            } catch (err) { /* 打标记失败，下轮靠标题文字兜底 */ }
        }
        return lines.length;
    }

    /**
     * 重排本篇：正文引用标签按首次出现顺序重编，文末表按当前 CSL 样式重建。
     * 内容没变的块一个字节都不写。
     */
    async refreshCitations(opts) {
        opts = opts || {};
        const docId = opts.docId || this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needEditor || "请先把光标放到正文里，再执行这个命令", 4000, "error");
            return false;
        }
        // 插入引用后会延迟触发一次重排，这时用户可能又插了一条：串行化，避免文末表被写两遍
        if (this._refreshing) {
            this._refreshQueue = true;
            return false;
        }
        this._refreshing = true;
        try {
            return await this.doRefresh(docId, opts);
        } finally {
            this._refreshing = false;
            if (this._refreshQueue) {
                this._refreshQueue = false;
                setTimeout(() => this.refreshCitations({ docId: docId, quiet: true }), 400);
            }
        }
    }

    async doRefresh(docId, opts) {
        const style = await this.citationStyle(docId);
        const numeric = isNumericStyle(style, this.data.citeForm);

        // 先用导出的 markdown 探一下有没有引用；没有就不必逐块扫
        const probe = await this.scanDocCites(docId);
        if (!probe.occ.length) {
            if (!opts.quiet) showMessage(this.i18n.noCite || "本篇还没有红豆引用。先用「插入引用」放一条。", 4000);
            return false;
        }

        const blocks = await topBlocks(docId);
        if (!blocks.length) {
            if (!opts.quiet) showMessage(this.i18n.emptyDoc || "这篇文档还是空的", 3000, "error");
            return false;
        }
        // 改动前留一份可撤销快照（引用重排走内核 API，普通 Ctrl+Z 管不到）
        if (opts.undo !== false) await this.pushUndo(docId, blocks);
        const pairs = await mapLimit(blocks, 5, async (b) => {
            const kr = await blockKramdown(b.id);
            const has = !!kr && (kr.indexOf("hongdou://") >= 0 || kr.indexOf("zotero://") >= 0);
            return { id: b.id, type: b.type, kr: kr, cites: has ? scanCites(kr) : [] };
        });

        const order = [];
        const seen = new Set();
        const hintIds = new Map();
        let occCount = 0;
        pairs.forEach(p => {
            if (!p || !p.cites.length) return;
            p.cites.forEach(c => {
                if (c.bib) return;                 // 文末条目由 rebuildBibliography 负责
                occCount++;
                if (c.id && !hintIds.has(c.key)) hintIds.set(c.key, c.id);
                c.keys.forEach(k => {
                    if (!seen.has(k)) { seen.add(k); order.push(k); }
                });
            });
        });
        if (!occCount) {
            if (!opts.quiet) showMessage(this.i18n.noCite || "本篇还没有红豆引用。先用「插入引用」放一条。", 4000);
            return false;
        }

        const snap = await this.snapLoad(docId);
        const map = await this.resolveItems(order, snap, hintIds);
        // 记住文档里用的 key，红豆侧 key 变动时仍能对上原文
        order.forEach(k => { const it = map.get(k); if (it) it._k = k; });
        const list = order.map(k => map.get(k)).filter(Boolean);
        const lost = order.filter(k => {
            const it = map.get(k);
            return !it || it._snap;
        });
        const nums = new Map();
        order.forEach((k, i) => nums.set(k, i + 1));
        const suffix = yearSuffixMap(list);

        let changed = 0;
        for (const p of pairs) {
            if (!p || !p.kr || !p.cites.length) continue;
            const next = replaceCites(p.kr, (hit) => {
                if (hit.bib) return null;
                const its = hit.keys.map(k => map.get(k)).filter(Boolean);
                if (!its.length) return null;
                const text = citeText(its, {
                    numeric: numeric, nums: nums, suffix: suffix, narrative: hit.form === "narr",
                });
                if (!text) return null;
                const i = hit.raw.indexOf("](");
                if (i < 0) return null;
                return "[" + linkText(text) + hit.raw.slice(i);
            });
            if (next && next !== p.kr) {
                await updateBlockMd(p.id, next);
                changed++;
            }
        }

        let bibCount = 0;
        if (this.data.bibAuto && opts.bib !== false) {
            bibCount = await this.rebuildBibliography(docId, list, style, { numeric: numeric });
        }

        if (this.data.citeSnapshot) {
            const next = {};
            list.forEach(it => { if (it && it.key) next[it.key] = this.snapOf(it); });
            await this.snapSave(docId, next);
        }

        if (!opts.quiet) {
            let msg = (this.i18n.citeRefreshed || "已刷新 %a 处引用、%b 条参考文献")
                .replace("%a", occCount).replace("%b", bibCount);
            if (lost.length) {
                msg += (this.i18n.citeLost || "；%n 条在红豆里查不到，已按快照保留")
                    .replace("%n", lost.length);
            }
            showMessage(msg, 5000);
        }
        return true;
    }

    /** 改动前给整篇顶层块留一份快照（撤销用），每篇独立栈、最多 20 步 */
    async pushUndo(docId, blocks) {
        try {
            if (!this._undoStack) this._undoStack = new Map();
            const snap = await mapLimit(blocks, 6, async (b) => ({ id: b.id, md: await blockKramdown(b.id) }));
            let stack = this._undoStack.get(docId) || [];
            stack.push({ ts: Date.now(), blocks: snap });
            if (stack.length > 20) stack = stack.slice(stack.length - 20);
            this._undoStack.set(docId, stack);
        } catch (err) { /* 快照失败不阻塞主流程 */ }
    }

    /** 撤销最近一次引用操作：按 id 恢复旧内容，删掉快照之后多出来的块 */
    async undoLast(opts) {
        opts = opts || {};
        const docId = opts.docId || this.currentDocId();
        if (!docId) {
            showMessage(this.i18n.needEditor || "请先把光标放到正文里", 4000, "error");
            return false;
        }
        if (!this._undoStack) this._undoStack = new Map();
        const stack = this._undoStack.get(docId) || [];
        if (!stack.length) {
            showMessage(this.i18n.undoEmpty || "没有可撤销的引用操作", 3000);
            return false;
        }
        const frame = stack.pop();
        this._undoStack.set(docId, stack);
        const old = new Map((frame.blocks || []).map(b => [b.id, b.md]));

        const now = await topBlocks(docId);
        // 1) 快照里没有、现在有的块 = 这次新增（文末表），删掉
        let restored = 0;
        for (const b of now) {
            if (!old.has(b.id)) {
                await deleteBlockById(b.id);
                continue;
            }
            // 2) 内容被改过的块，恢复旧 markdown
            const cur = await blockKramdown(b.id);
            if (cur !== old.get(b.id)) {
                await updateBlockMd(b.id, old.get(b.id));
                restored++;
            }
        }
        if (!opts.quiet) {
            showMessage((this.i18n.undoDone || "已撤销，恢复 %n 个块").replace("%n", restored), 3000);
        }
        return true;
    }

    /** 切换某一处引用的形态：默认 ↔ 叙述式 */
    async toggleCiteForm(blockId, anchor, toNarr) {
        try {
            const kr = await blockKramdown(blockId);
            if (!kr) return;
            const want = anchor.getAttribute("href") || "";
            let hit = false;
            const next = replaceCites(kr, (c) => {
                if (hit) return null;
                if (want.indexOf(c.key) < 0) return null;
                hit = true;
                const i = c.raw.indexOf("](");
                if (i < 0) return null;
                let url = c.raw.slice(i + 2, c.raw.length - 1);
                url = url.replace(/([?&])f=[^&]*/g, "$1f=" + (toNarr ? "narr" : "csl"));
                if (url.indexOf("f=") < 0) {
                    url += (url.indexOf("?") >= 0 ? "&" : "?") + "f=" + (toNarr ? "narr" : "csl");
                }
                return "[" + c.raw.slice(1, i) + "](" + url + ")";
            });
            if (!hit) return;
            if (next !== kr) await updateBlockMd(blockId, next);
            await this.refreshCitations({ docId: this.currentDocId(), quiet: true });
        } catch (err) {
            showMessage(err.message, 6000, "error");
        }
    }

    /** 编辑一处引用：列出该处所有条目，可取消勾选移除、从红豆当前选中或搜索补充 */
    async editCiteDialog(blockId, anchor) {
        const i18n = this.i18n;
        const href = anchor.getAttribute("href") || "";
        const q = parseCiteQuery(href.split("?")[1] || "");
        const primary = (href.split("/items/")[1] || "").split(/[?&#]/)[0];
        const keys = [primary].concat(q.keys).filter(Boolean);
        if (!keys.length) {
            showMessage(i18n.editCiteEmpty || "这处引用已经空了", 4000);
            return;
        }
        // 先拿到这处引用当前的条目（快照 + 反查），保证能显示标题与作者
        const docId = this.currentDocId();
        const snap = docId ? await this.snapLoad(docId) : {};
        const hintIds = new Map();
        if (q.id) hintIds.set(primary, q.id);
        const map = await this.resolveItems(keys, snap, hintIds);
        const items = keys.map(k => map.get(k)).filter(Boolean);

        // 从红豆当前选中项里读候选，方便「添加」
        let focused = [];
        try {
            const r = await this.client.focus();
            focused = (r.items || []).filter(it => it && it.id);
        } catch (err) { /* 忽略 */ }

        const dialog = new Dialog({
            title: i18n.editCiteTitle || "编辑引用",
            width: "520px",
            height: "560px",
            content: `<div class="hd-dialog hd-editcite">
  <div class="hd-ec-tip">${esc(i18n.editCiteTip || "取消勾选可从这处引用里移除；点「添加文献」从红豆当前选中或搜索补充。")}</div>
  <div class="hd-ec-list"></div>
  <div class="hd-foot">
    <span class="fn__flex-1"></span>
    <button class="b3-button b3-button--cancel hd-ec-remove">${esc(i18n.editCiteRemoveAll || "移除这处引用")}</button>
    <button class="b3-button b3-button--cancel hd-ec-add">${esc(i18n.editCiteAdd || "添加文献…")}</button>
    <button class="b3-button b3-button--text hd-ec-save">${esc(i18n.editCiteSave || "保存修改")}</button>
  </div>
</div>`,
            destroyCallback: () => { this._editCiteDlg = null; },
        });
        this._editCiteDlg = dialog;
        const el = dialog.element;
        const listEl = el.querySelector(".hd-ec-list");

        // 状态：选中的 key 集合（初始全部选中）
        const picked = new Set(keys);
        const current = items.slice();

        const render = () => {
            listEl.innerHTML = "";
            if (!current.length) {
                listEl.innerHTML = `<div class="hd-empty">${esc(i18n.editCiteEmpty || "这处引用已经空了")}</div>`;
                return;
            }
            current.forEach(it => {
                const k = itemKey(it);
                const on = picked.has(k);
                const row = document.createElement("label");
                row.className = "hd-row hd-ec-row";
                row.innerHTML = `<span class="hd-check${on ? " hd-check--on" : ""}"></span>
<div class="hd-row-main">
  <div class="hd-row-title">${esc(it.title || "（无标题）")}</div>
  <div class="hd-row-meta"><span class="hd-year">${esc(yearOf(it) || "")}</span><span class="hd-dot">·</span><span>${esc(citeWho(it) || "")}</span></div>
</div>`;
                row.addEventListener("click", () => {
                    if (on) picked.delete(k); else picked.add(k);
                    render();
                });
                listEl.appendChild(row);
            });
        };
        render();

        el.querySelector(".hd-ec-save").addEventListener("click", async () => {
            const keep = current.filter(it => picked.has(itemKey(it)));
            const blockKr = await blockKramdown(blockId).catch(() => "");
            if (blockKr == null) { dialog.destroy(); return; }
            const style = await this.citationStyle().catch(() => null);
            const numeric = isNumericStyle(style, this.data.citeForm);
            let hit = false;
            const want = href;
            const next = replaceCites(blockKr, (c) => {
                if (hit) return null;
                if (want.indexOf(c.key) < 0) return null;
                hit = true;
                if (!keep.length) return "";   // 整处删掉
                const keysNow = keep.map(x => x.key).filter(Boolean);
                if (!keysNow.length) return "";
                const text = numeric
                    ? "[?]"   // 数字式序号交给 refreshCitations 统一重排
                    : citeText(keep, { numeric: false, narrative: q.form === "narr", suffix: new Map() });
                const qNew = ["f=" + (q.form || "csl")];
                if (keep[0] && keep[0].id) qNew.push("i=" + keep[0].id);
                if (keysNow.length > 1) qNew.push("zkeys=" + keysNow.slice(1).join(","));
                const url = `${this.data.scheme === "zotero" ? "zotero" : "hongdou"}://select/library/items/${keysNow[0]}?${qNew.join("&")}`;
                const body = `[${linkText(text)}](${url})`;
                return this.data.citeSuperscript && numeric ? `<sup>${body}</sup>` : body;
            });
            if (!hit) { dialog.destroy(); return; }
            if (next !== blockKr) await updateBlockMd(blockId, next);
            dialog.destroy();
            await this.refreshCitations({ docId: docId, quiet: true });
            showMessage(i18n.editCiteSaved || "引用已更新");
        });

        el.querySelector(".hd-ec-remove").addEventListener("click", async () => {
            const blockKr = await blockKramdown(blockId).catch(() => "");
            if (blockKr == null) { dialog.destroy(); return; }
            let hit = false;
            const next = replaceCites(blockKr, (c) => {
                if (hit) return null;
                if (href.indexOf(c.key) < 0) return null;
                hit = true;
                return "";
            });
            if (hit && next !== blockKr) await updateBlockMd(blockId, next);
            dialog.destroy();
            await this.refreshCitations({ docId: docId, quiet: true });
            showMessage(i18n.editCiteSaved || "引用已更新");
        });

        el.querySelector(".hd-ec-add").addEventListener("click", () => {
            dialog.destroy();
            // 复用主搜索窗补充条目：这里直接打开，用户勾选后插入为新引用
            this.openSearch("citation");
        });

        // 让当前选中项一键加入
        if (focused.length) {
            const addBtn = document.createElement("div");
            addBtn.className = "hd-ec-focus";
            addBtn.innerHTML = `<span class="hd-ec-focus-t">${esc(i18n.openInHongdou || "当前选中")}（${focused.length}）</span><span class="hd-act">${esc(i18n.editCiteAdd || "加入这处引用")}</span>`;
            addBtn.querySelector(".hd-act").addEventListener("click", async () => {
                const hydrated = await this.client.hydrateAll(focused);
                hydrated.forEach(it => {
                    const k = it.key;
                    if (!k) return;
                    const idx = current.findIndex(x => itemKey(x) === k);
                    if (idx < 0) current.push(it);
                    picked.add(k);
                });
                render();
            });
            listEl.parentNode.insertBefore(addBtn, listEl.nextSibling);
        }
    }

    /** 在文末高亮某条文献（只在本编辑器里找，避免命中另一个标签页） */
    locateBib(key) {
        if (!key) return;
        const editor = this.activeEditor;
        const root = (editor && editor.protyle && editor.protyle.wysiwyg && editor.protyle.wysiwyg.element)
            || document.querySelector(".protyle-wysiwyg");
        if (!root) return;
        const links = Array.prototype.slice.call(root.querySelectorAll('a[href*="' + key + '"]'));
        const target = links.reverse().find(a => (a.getAttribute("href") || "").indexOf("bib=1") >= 0) || links[0];
        if (!target) {
            showMessage(this.i18n.bibEntryMissing || "文末还没有这条文献，先刷新一次本篇引用", 4000);
            return;
        }
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        const box = target.closest("[data-node-id]") || target;
        box.classList.add("hd-cite-flash");
        setTimeout(() => box.classList.remove("hd-cite-flash"), 1900);
    }

    closeMenu() {
        if (this._menuCloser) {
            document.removeEventListener("click", this._menuCloser, true);
            this._menuCloser = null;
        }
        if (this._menu && this._menu.parentNode) this._menu.parentNode.removeChild(this._menu);
        this._menu = null;
    }

    openMenu(x, y, items) {
        this.closeMenu();
        const el = document.createElement("div");
        el.className = "b3-menu hd-menu";
        items.forEach(it => {
            if (!it) return;
            if (it.sep) {
                const s = document.createElement("div");
                s.className = "b3-menu__separator";
                el.appendChild(s);
                return;
            }
            const b = document.createElement("button");
            b.className = "b3-menu__item";
            b.innerHTML = `<span class="b3-menu__label">${esc(it.label)}</span>`;
            if (it.disabled) b.setAttribute("disabled", "disabled");
            b.addEventListener("click", (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this.closeMenu();
                if (!it.disabled) it.click();
            });
            el.appendChild(b);
        });
        document.body.appendChild(el);
        const r = el.getBoundingClientRect();
        el.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 10)) + "px";
        el.style.top = Math.max(6, Math.min(y, window.innerHeight - r.height - 10)) + "px";
        this._menu = el;
        this._menuCloser = (ev) => {
            if (this._menu && this._menu.contains(ev.target)) return;
            this.closeMenu();
        };
        setTimeout(() => document.addEventListener("click", this._menuCloser, true), 0);
    }

    /** 引用链接上右键：切换形态 / 定位文末 / 刷新本篇 / 打开设置 */
    showCiteMenu(e, a) {
        const href = a.getAttribute("href") || "";
        const q = parseCiteQuery((href.split("?")[1] || ""));
        const key = (href.split("/items/")[1] || "").split(/[?&#]/)[0];
        const blockEl = a.closest("[data-node-id]");
        const blockId = blockEl ? blockEl.getAttribute("data-node-id") : "";
        const isBib = href.indexOf("bib=1") >= 0;
        const narr = q.form === "narr";
        const i18n = this.i18n;
        this.openMenu(e.clientX, e.clientY, [
            isBib ? null : {
                label: i18n.citeAsDefault || "默认形态（作者-年份 / 数字）",
                disabled: !narr,
                click: () => this.toggleCiteForm(blockId, a, false),
            },
            isBib ? null : {
                label: i18n.citeAsNarrative || "叙述式 Chen et al. (2024)",
                disabled: narr,
                click: () => this.toggleCiteForm(blockId, a, true),
            },
            isBib ? null : {
                label: i18n.citeEdit || "编辑这条引用…",
                click: () => this.editCiteDialog(blockId, a),
            },
            isBib ? null : { sep: true },
            {
                label: i18n.citeLocate || "定位到文末这条文献",
                click: () => this.locateBib(key),
            },
            {
                label: i18n.citeRefresh || "刷新本篇引用与参考文献",
                click: () => this.refreshCitations({ docId: this.currentDocId() }),
            },
            { sep: true },
            {
                label: i18n.citeOpenHongdou || "在红豆中打开",
                click: () => this.openExternal(href.replace(/&?bib=1/, "")),
            },
            {
                label: i18n.citeUndo || "撤销上一次引用操作",
                click: () => this.undoLast({ docId: this.currentDocId() }),
            },
            {
                label: i18n.cmdSettings || "红豆插件设置",
                click: () => this.openSettings(),
            },
        ].filter(Boolean));
        e.preventDefault();
        e.stopPropagation();
    }

    /* ------------------------------------------------------- 引用导出（多格式） */

    /** 常用样式排前面 */
    styleRank(s) {
        const t = String((s.title || "") + " " + (s.styleID || "")).toLowerCase();
        const prefer = ["gb-t-7714", "gbt7714", "顺序编码", "apa", "ieee", "nature",
            "vancouver", "harvard", "chicago", "elsevier", "ama", "acs"];
        for (let i = 0; i < prefer.length; i++) if (t.indexOf(prefer[i]) >= 0) return i;
        return 99;
    }

    /** 导出对话框：格式来自红豆已装 CSL 样式，另加 BibTeX / RIS / CSL-JSON / 表格 */
    async openExport(items) {
        const list = (items || []).filter(it => it && it.id);
        if (!list.length) {
            showMessage(this.i18n.exportEmpty || "没有可导出的文献", 4000, "error");
            return;
        }
        let styles = [];
        let defStyle = "";
        let locale = "";
        try {
            const meta = await this.client.styleMeta();
            styles = (meta.list || []).slice().sort((a, b) => this.styleRank(a) - this.styleRank(b));
            defStyle = meta.defaultStyleID || "";
            locale = meta.locale || "";
        } catch (err) { styles = []; }

        const extra = [
            { styleID: "__bibtex", title: "BibTeX（LaTeX / Typst）" },
            { styleID: "__ris", title: "RIS（EndNote / NoteExpress / 红豆）" },
            { styleID: "__csljson", title: "CSL-JSON（Pandoc / Quarto）" },
            { styleID: "__mdtable", title: "Markdown 表格" },
            { styleID: "__citecmd", title: "引用命令（LaTeX / Typst）" },
        ];
        const opts = styles.concat(extra);
        const keyFmt = this.data.citeKeyFormat || "{author}{year}{title}";
        const def = this.data.styleID || defStyle || (styles[0] && styles[0].styleID) || "__bibtex";
        const sel = this.data.exportFormat && opts.some(o => o.styleID === this.data.exportFormat)
            ? this.data.exportFormat : def;

        const html = opts.map(o =>
            `<option value="${esc(o.styleID)}"${o.styleID === sel ? " selected" : ""}>${esc(o.title || o.styleID)}</option>`
        ).join("");

        const d = new Dialog({
            title: (this.i18n.exportTitle || "导出引用") + "　·　" + list.length + " 篇",
            width: "760px",
            content: `<div class="hd-export">
  <div class="hd-exp-bar">
    <select class="b3-select hd-exp-fmt">${html}</select>
    <span class="fn__flex-1"></span>
    <span class="hd-exp-tip">${esc(this.i18n.exportTip || "格式由红豆的 CSL 引擎渲染，与「引用样式」一致")}</span>
  </div>
  <textarea class="b3-text-field hd-exp-out" readonly spellcheck="false"></textarea>
  <div class="hd-exp-foot">
    <button class="b3-button b3-button--cancel hd-exp-ins">${esc(this.i18n.insert || "插入文档")}</button>
    <button class="b3-button b3-button--cancel hd-exp-dl">${esc(this.i18n.download || "下载文件")}</button>
    <button class="b3-button b3-button--text hd-exp-copy">${esc(this.i18n.copy || "复制")}</button>
  </div>
</div>`,
        });
        if (!d.element) return;
        const fmtEl = d.element.querySelector(".hd-exp-fmt");
        const outEl = d.element.querySelector(".hd-exp-out");
        if (!fmtEl || !outEl) return;

        const render = async () => {
            const fmt = fmtEl.value;
            outEl.value = this.i18n.loading || "生成中…";
            let txt = "";
            try {
                if (fmt === "__bibtex") {
                    const r = await this.client.bibtex(list.map(it => it.id));
                    txt = (r && (r.bibtex || r.content || r.text)) || "";
                } else if (fmt === "__ris") {
                    txt = toRIS(list, keyFmt);
                } else if (fmt === "__csljson") {
                    txt = JSON.stringify(toCSLJSON(list, keyFmt), null, 2);
                } else if (fmt === "__mdtable") {
                    txt = toMdTable(list);
                } else if (fmt === "__citecmd") {
                    txt = toCiteCommands(list, keyFmt);
                } else {
                    const r = await this.client.formatBibliography(list.map(it => it.id), fmt, { locale: locale });
                    txt = (r && r.content) || "";
                }
            } catch (err) {
                txt = "（生成失败：" + err.message + "）";
            }
            outEl.value = String(txt || "").trim();
            this.data.exportFormat = fmt;
            this.saveData("settings.json", this.data).catch(() => null);
        };

        fmtEl.addEventListener("change", render);
        d.element.querySelector(".hd-exp-copy").addEventListener("click", async () => {
            const ok = await copyText(outEl.value);
            showMessage(ok ? (this.i18n.copied || "已复制到剪贴板") : (this.i18n.copyFail || "复制失败"), 3000, ok ? undefined : "error");
        });
        d.element.querySelector(".hd-exp-dl").addEventListener("click", () => {
            const fmt = fmtEl.value;
            const ext = fmt === "__bibtex" ? "bib" : fmt === "__ris" ? "ris" : fmt === "__csljson" ? "json" : fmt === "__mdtable" ? "md" : "txt";
            downloadText(outEl.value, `references-${stamp()}.${ext}`);
        });
        d.element.querySelector(".hd-exp-ins").addEventListener("click", () => {
            const txt = outEl.value;
            d.destroy();
            const fmt = fmtEl.value;
            if (fmt === "__bibtex") this.insertMarkdown("```bibtex\n" + txt + "\n```");
            else if (fmt === "__csljson" || fmt === "__mdtable" || fmt === "__ris") this.insertMarkdown("```\n" + txt + "\n```");
            else this.insertMarkdown(txt.split(/\r?\n/).map(l => escapeOl(l.trim())).filter(Boolean).join("\n\n"));
        });
        render();
    }

    /** 切换 CSL 样式，换完全篇重排 */
    async openCiteStyle() {
        let meta = { defaultStyleID: "", list: [], locale: "" };
        try { meta = await this.client.styleMeta(); } catch (err) { /* 没连上就只列空表 */ }
        const styles = (meta.list || []).slice().sort((a, b) => this.styleRank(a) - this.styleRank(b));
        if (!styles.length) {
            showMessage(this.i18n.styleNone || "没读到红豆已装的引用样式，请先在红豆里装一个 CSL 样式", 5000, "error");
            return;
        }
        const cur = String(this.data.styleID || meta.defaultStyleID || "");
        const rows = styles.map(s => `<div class="hd-style-row${s.styleID === cur ? " hd-style-row--on" : ""}" data-id="${esc(s.styleID)}" data-title="${esc(s.title || s.styleID)}">
  <div class="hd-style-name">${esc(s.title || s.styleID)}</div>
  <div class="hd-style-id">${esc(s.styleID)}</div>
</div>`).join("");

        const d = new Dialog({
            title: this.i18n.styleTitle || "引用样式",
            width: "680px",
            height: "560px",
            content: `<div class="hd-styles">
  <div class="hd-style-tip">${esc(this.i18n.styleTip || "样式来自红豆已安装的 CSL 样式；换样式后正文与文末表会一起重排。")}</div>
  <div class="hd-style-list">${rows}</div>
</div>`,
        });
        if (!d.element) return;
        const styleList = d.element.querySelector(".hd-style-list");
        if (!styleList) return;
        styleList.addEventListener("click", async (e) => {
            const row = e.target.closest(".hd-style-row");
            if (!row) return;
            this.data.styleID = row.dataset.id;
            this.data.styleTitle = row.dataset.title;
            d.destroy();
            this.client.setEndpoint(this.data.endpoint);
            await this.saveData("settings.json", this.data);
            await this.refreshCitations({ docId: this.currentDocId() });
        });
    }

    /** 首次使用引导：四步 */
    showWelcome(force) {
        if (!force && this.data.welcomed) return;
        const i18n = this.i18n;
        const step = (n, t, b) => `<div class="hd-w-step"><div class="hd-w-n">${n}</div>
  <div class="hd-w-main"><div class="hd-w-t">${esc(t)}</div><div class="hd-w-b">${b}</div></div></div>`;
        const d = new Dialog({
            title: i18n.welcomeTitle || "红豆文献联动 · 上手四步",
            width: "640px",
            content: `<div class="hd-welcome">
  ${this.data.bridgeToken
        ? `<div class="hd-w-bridge hd-w-bridge--ok">
    <div class="hd-w-bridge-main">
        <div class="hd-w-bridge-t">${esc(i18n.welcomeBridgeOkT || "双向联动已配对")}</div>
        <div class="hd-w-bridge-b">${esc(i18n.welcomeBridgeOkB || "现在可以在红豆里右键文献「发送到思源」，这边会自动插入。")}</div>
    </div>
</div>`
        : `<div class="hd-w-bridge">
    <div class="hd-w-bridge-main">
        <div class="hd-w-bridge-t">${esc(i18n.welcomeBridgeT || "想在红豆里右键「发送到思源」？")}</div>
        <div class="hd-w-bridge-b">${esc(i18n.welcomeBridgeB || "双向联动需要先在红豆里装一个配套插件（Zotero 格式 .xpi），装完两边输一次配对码即可。不装也能正常用引用功能。")}</div>
        <div class="hd-w-bridge-url">${esc(BRIDGE_XPI_URL)}</div>
    </div>
    <div class="hd-w-bridge-acts">
        <button class="b3-button b3-button--text hd-w-dl">${esc(i18n.welcomeBridgeDl || "直接下载 xpi")}</button>
        <button class="b3-button b3-button--cancel hd-w-copy">${esc(i18n.welcomeBridgeCopy || "复制完整地址")}</button>
    </div>
</div>`}
  <div class="hd-w-head">${esc(i18n.welcomeLead || "红豆管文献，思源写论文。插件通过本机 MCP 直连红豆，不需要额外装插件或配对。")}</div>
  ${step(1, i18n.welcome1t || "确认连得上红豆",
            esc(i18n.welcome1b || "红豆保持运行，插件默认连 127.0.0.1:18500。连不上就到设置里点「测试连接」。"))}
  ${step(2, i18n.welcome2t || "选一个引用样式",
            esc(i18n.welcome2b || "命令面板搜「引用样式」，选 GB/T 7714 或 APA。正文与文末表都由这套样式决定。"))}
  ${step(3, i18n.welcome3t || "插入第一条引用",
            esc(i18n.welcome3b || "把光标放到要引用的位置，按 Shift+Ctrl+I 选文献。正文出现引用，文末自动长出参考文献表。"))}
  ${step(4, i18n.welcome4t || "改完再刷新一次",
            esc(i18n.welcome4b || "增删文献后按 Shift+Ctrl+R 重排：编号连号、文末表跟着变。右键点引用还能切叙述式、跳到文末条目。"))}
  <div class="hd-w-foot">
    <label class="hd-w-nomore"><input type="checkbox" class="hd-w-cb"> ${esc(i18n.welcomeNever || "不再自动弹出")}</label>
    <span class="fn__flex-1"></span>
    <button class="b3-button b3-button--cancel hd-w-test">${esc(i18n.testConn || "测试连接")}</button>
    <button class="b3-button b3-button--text hd-w-ok">${esc(i18n.gotIt || "知道了")}</button>
  </div>
</div>`,
        });
        if (!d.element) return;
        const finish = () => {
            const cb = d.element.querySelector(".hd-w-cb");
            if (cb && cb.checked) this.data.welcomed = true;
            else if (!force) this.data.welcomed = true;
            this.saveData("settings.json", this.data).catch(() => null);
            d.destroy();
        };
        const okBtn = d.element.querySelector(".hd-w-ok");
        const testBtn = d.element.querySelector(".hd-w-test");
        if (okBtn) okBtn.addEventListener("click", finish);
        if (testBtn) testBtn.addEventListener("click", () => this.checkConnection());
        const dlBtn = d.element.querySelector(".hd-w-dl");
        if (dlBtn) dlBtn.addEventListener("click", () => this.openExternal(BRIDGE_XPI_URL));
        const copyBtn = d.element.querySelector(".hd-w-copy");
        if (copyBtn) copyBtn.addEventListener("click", async () => {
            try {
                await navigator.clipboard.writeText(BRIDGE_XPI_URL);
                showMessage(i18n.welcomeBridgeCopied || "下载地址已复制", 2600);
            } catch (err) { showMessage(BRIDGE_XPI_URL, 6000); }
        });
    }

    /** 简单输入对话框，返回 Promise<string|null> */
    promptDialog(title, tip, value, extraHtml, listId) {
        return new Promise((resolve) => {
            let done = false;
            const d = new Dialog({
                title: title,
                width: "560px",
                content: `<div class="hd-prompt">
  <div class="hd-prompt-tip">${esc(tip || "")}</div>
  <input class="b3-text-field fn__block hd-prompt-input" ${listId ? `list="${listId}"` : ""} value="${esc(value || "")}">
  ${extraHtml || ""}
  <div class="hd-prompt-foot">
    <button class="b3-button b3-button--cancel hd-p-cancel">${esc(this.i18n.cancel || "取消")}</button>
    <button class="b3-button b3-button--text hd-p-ok">${esc(this.i18n.confirm || "确定")}</button>
  </div>
</div>`,
                destroyCallback: () => {
                    this._dialog = null;
                    if (!done) resolve(null);
                },
            });
            const input = d.element.querySelector(".hd-prompt-input");
            const finish = (v) => {
                done = true;
                d.destroy();
                resolve(v);
            };
            d.element.querySelector(".hd-p-cancel").addEventListener("click", () => finish(null));
            d.element.querySelector(".hd-p-ok").addEventListener("click", () => finish(input.value));
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") finish(input.value);
                if (e.key === "Escape") finish(null);
            });
            setTimeout(() => input.focus(), 60);
        });
    }

    /* --------------------------------------------------------------- 设置 */

    async openTemplateEditor() {
        let done = false;
        const d = new Dialog({
            title: this.i18n.tplTitle || "阅读笔记模板",
            width: "760px",
            height: "600px",
            content: `<div class="hd-tpl">
  <div class="hd-tpl-tip">${esc(this.i18n.tplTip || "可用变量")}：{title} {authors} {author} {year} {date} {journal} {pub} {volume} {issue} {pages} {doi} {doilink} {url} {link} {pdflink} {tags} {hashtags} {collections} {abstract} {type} {citekey}</div>
  <div class="hd-tpl-tip hd-tpl-tip2">${esc(this.i18n.tplTypeTip || "按文献类型分模板：另起一行写 [journalArticle] / [book] / [conferencePaper]，该段只对这类文献生效；开头没分段的部分是默认模板。")}</div>
  <textarea class="b3-text-field hd-tpl-text" spellcheck="false"></textarea>
  <div class="hd-tpl-foot">
    <button class="b3-button b3-button--cancel hd-tpl-reset">${esc(this.i18n.tplReset || "恢复默认")}</button>
    <span class="fn__flex-1"></span>
    <button class="b3-button b3-button--cancel hd-tpl-cancel">${esc(this.i18n.cancel || "取消")}</button>
    <button class="b3-button b3-button--text hd-tpl-ok">${esc(this.i18n.save || "保存")}</button>
  </div>
</div>`,
            destroyCallback: () => { this._dialog = null; },
        });
        const ta = d.element.querySelector(".hd-tpl-text");
        ta.value = this.data.noteTemplate || NOTE_TEMPLATE;
        d.element.querySelector(".hd-tpl-reset").addEventListener("click", () => { ta.value = NOTE_TEMPLATE; });
        d.element.querySelector(".hd-tpl-cancel").addEventListener("click", () => d.destroy());
        d.element.querySelector(".hd-tpl-ok").addEventListener("click", async () => {
            done = true;
            const v = ta.value;
            this.data.noteTemplate = (v.trim() === NOTE_TEMPLATE.trim()) ? "" : v;
            await this.saveSettings();
            d.destroy();
        });
    }

    async openSettings() {
        let styles = [];
        try {
            styles = await this.client.styles();
        } catch (err) {
            styles = [];
        }
        let notebooks = [];
        try {
            const r = await kernel("/api/notebook/lsNotebooks");
            notebooks = (r.notebooks || []).filter(n => !n.closed);
        } catch (err) { /* 忽略 */ }

        const d = this.data;
        const setting = new Setting({
            confirmCallback: () => { this.saveSettings(); },
        });

        setting.addItem({
            title: this.i18n.setEndpoint || "红豆接口地址",
            description: this.i18n.setEndpointDesc || "红豆默认在本机 18500 端口提供 MCP 服务",
            action: {
                type: "textinput",
                value: d.endpoint,
                placeholder: DEFAULTS.endpoint,
                changeCallback: (v) => { this.data.endpoint = valOf(v).trim() || DEFAULTS.endpoint; },
            },
        });

        setting.addItem({
            title: this.i18n.setNotebook || "阅读笔记放在哪个笔记本",
            description: this.i18n.setNotebookDesc || "留空则用第一个打开的笔记本",
            action: {
                type: "select",
                value: d.notebook || "",
                list: [{ text: "（自动）", value: "" }].concat(notebooks.map(n => ({ text: n.name, value: n.id }))),
                changeCallback: (v) => { this.data.notebook = valOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setFolder || "阅读笔记文件夹",
            description: this.i18n.setFolderDesc || "阅读笔记与材料都放在这个文档文件夹下",
            action: {
                type: "textinput",
                value: d.folder,
                placeholder: DEFAULTS.folder,
                changeCallback: (v) => { this.data.folder = valOf(v).trim() || DEFAULTS.folder; },
            },
        });

        setting.addItem({
            title: this.i18n.setLinkStyle || "引用显示文字",
            action: {
                type: "select",
                value: d.linkStyle,
                list: [
                    { text: this.i18n.styleTitle || "文献标题", value: "title" },
                    { text: this.i18n.styleAuthorYear || "作者 年份", value: "authorYear" },
                    { text: this.i18n.styleCustom || "自定义模板", value: "custom" },
                ],
                changeCallback: (v) => { this.data.linkStyle = valOf(v) || "title"; },
            },
        });

        setting.addItem({
            title: this.i18n.setTemplate || "引用文字模板",
            description: "{author} {year} {title} {journal} {doi}",
            action: {
                type: "textinput",
                value: d.linkTemplate,
                placeholder: DEFAULTS.linkTemplate,
                changeCallback: (v) => { this.data.linkTemplate = valOf(v) || DEFAULTS.linkTemplate; },
            },
        });

        setting.addItem({
            title: this.i18n.setNoteTpl || "阅读笔记模板",
            description: this.i18n.setNoteTplDesc || "自定义新建阅读笔记时的正文结构",
            action: {
                type: "button",
                label: this.i18n.editTpl || "编辑模板",
                callback: () => this.openTemplateEditor(),
            },
        });

        setting.addItem({
            title: this.i18n.setScheme || "文献链接协议",
            description: this.i18n.setSchemeDesc || "点击链接时由系统唤起红豆；若无效可换成 zotero://",
            action: {
                type: "select",
                value: d.scheme,
                list: [
                    { text: "hongdou://", value: "hongdou" },
                    { text: "zotero://", value: "zotero" },
                ],
                changeCallback: (v) => { this.data.scheme = valOf(v) === "zotero" ? "zotero" : "hongdou"; },
            },
        });

        setting.addItem({
            title: this.i18n.setPdfOpen || "PDF 用什么打开",
            description: this.i18n.setPdfOpenDesc || "红豆阅读器能同步批注到文末引用；系统阅读器启动更快",
            action: {
                type: "select",
                value: d.pdfOpenWith || DEFAULTS.pdfOpenWith,
                list: [
                    { text: this.i18n.pdfOpenHongdou || "红豆阅读器（推荐）", value: "hongdou" },
                    { text: this.i18n.pdfOpenSystem || "系统默认阅读器", value: "system" },
                ],
                changeCallback: (v) => { this.data.pdfOpenWith = valOf(v) === "system" ? "system" : "hongdou"; },
            },
        });

        setting.addItem({
            title: this.i18n.setWordDir || "Word 导出目录",
            description: this.i18n.setWordDirDesc || "留空导出到桌面；路径如 D:\\论文\\导出",
            action: {
                type: "textinput",
                value: d.wordExportDir || "",
                placeholder: "D:\\论文\\导出",
                changeCallback: (v) => { this.data.wordExportDir = valOf(v).trim(); },
            },
        });

        setting.addItem({
            title: this.i18n.setStyle || "参考文献样式",
            description: d.styleTitle || (this.i18n.setStyleDesc || "留空使用红豆当前的默认样式"),
            action: {
                type: "select",
                value: d.styleID || "",
                list: [{ text: this.i18n.styleDefault || "（红豆默认）", value: "" }].concat(
                    styles.map(s => ({ text: s.title, value: s.styleID }))
                ),
                changeCallback: (v) => {
                    const id = valOf(v);
                    this.data.styleID = id;
                    const hit = styles.find(x => x.styleID === id);
                    this.data.styleTitle = hit ? hit.title : "";
                },
            },
        });

        /* ---------------- 引用体系 ---------------- */

        setting.addItem({
            title: this.i18n.setCiteForm || "正文引用形态",
            description: this.i18n.setCiteFormDesc || "自动 = 按所选样式判断：顺序编码走 [1]，APA 走 (Zhang, 2024)",
            action: {
                type: "select",
                value: d.citeForm || "auto",
                list: [
                    { text: this.i18n.citeFormAuto || "自动（跟随样式）", value: "auto" },
                    { text: this.i18n.citeFormAD || "作者-年份 (Zhang et al., 2024)", value: "authorDate" },
                    { text: this.i18n.citeFormNum || "数字式 [1]", value: "numeric" },
                ],
                changeCallback: (v) => { this.data.citeForm = valOf(v) || "auto"; },
            },
        });

        setting.addItem({
            title: this.i18n.setCiteNarr || "新插入的引用用叙述式",
            description: this.i18n.setCiteNarrDesc || "Zhang et al. (2024)；只影响下次插入，已有引用可右键单独切换",
            action: {
                type: "checkbox",
                checked: !!d.citeNarrative,
                changeCallback: (v) => { this.data.citeNarrative = !!v; },
            },
        });

        setting.addItem({
            title: this.i18n.setCiteSup || "数字式引用带上标",
            description: this.i18n.setCiteSupDesc || "看起来更像 GB/T 7714 的角标；排版异常就关掉",
            action: {
                type: "checkbox",
                checked: !!d.citeSuperscript,
                changeCallback: (v) => { this.data.citeSuperscript = !!v; },
            },
        });

        setting.addItem({
            title: this.i18n.setBibAuto || "插入引用后自动维护文末表",
            description: this.i18n.setBibAutoDesc || "按首次出现顺序重编号，并重建「参考文献」小节；只动插件自己生成的块",
            action: {
                type: "checkbox",
                checked: !!d.bibAuto,
                changeCallback: (v) => { this.data.bibAuto = !!v; },
            },
        });

        setting.addItem({
            title: this.i18n.setBibTitle || "文末表标题",
            description: this.i18n.setBibTitleDesc || "留空则不生成标题；中文稿建议「参考文献」，英文稿建议 References",
            action: {
                type: "textinput",
                value: d.bibTitle || "",
                placeholder: this.i18n.bibTitlePh || "参考文献",
                changeCallback: (v) => { this.data.bibTitle = valOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setBibLevel || "文末表标题级别",
            action: {
                type: "select",
                value: String(d.bibLevel || "2"),
                list: [1, 2, 3, 4, 5, 6].map(n => ({ text: "H" + n, value: String(n) })),
                changeCallback: (v) => { this.data.bibLevel = valOf(v) || "2"; },
            },
        });

        setting.addItem({
            title: this.i18n.setSnap || "引用快照",
            description: this.i18n.setSnapDesc || "把用到的条目元数据存进文档属性（约 100 字节/条）。红豆没开或条目被删时，正文仍按上次的写法保留",
            action: {
                type: "checkbox",
                checked: !!d.citeSnapshot,
                changeCallback: (v) => { this.data.citeSnapshot = !!v; },
            },
        });

        setting.addItem({
            title: this.i18n.setKeyFmt || "引用键格式",
            description: this.i18n.setKeyFmtDesc || "导出 BibTeX / RIS / 引用命令时用的键。占位符：{author} {year} {title}；结果转小写 ASCII",
            action: {
                type: "textinput",
                value: d.citeKeyFormat || "{author}{year}{title}",
                placeholder: "{author}{year}{title}",
                changeCallback: (v) => { this.data.citeKeyFormat = valOf(v) || "{author}{year}{title}"; },
            },
        });

        setting.addItem({
            title: this.i18n.setDup || "重复引用提醒",
            description: this.i18n.setDupDesc || "同一篇已经在本文引用过时，再插会先问一句",
            action: {
                type: "checkbox",
                checked: !!d.citeWarnDup,
                changeCallback: (v) => { this.data.citeWarnDup = !!v; },
            },
        });

        setting.addItem({
            title: this.i18n.setStyleMore || "换个样式看看",
            description: this.i18n.setStyleMoreDesc || "列出红豆已装的 CSL 样式，选定后整篇引用与文末表一起重排",
            action: {
                type: "button",
                label: this.i18n.stylePick || "选择样式…",
                callback: () => this.openCiteStyle(),
            },
        });

        setting.addItem({
            title: this.i18n.setGuide || "使用指南",
            description: this.i18n.setGuideDesc || "四步上手：连红豆、选样式、插引用、重排",
            action: {
                type: "button",
                label: this.i18n.setGuideBtn || "重新查看",
                callback: () => this.showWelcome(true),
            },
        });

        setting.addItem({
            title: this.i18n.setShowDetail || "搜索时显示右侧详情栏",
            description: this.i18n.setShowDetailDesc || "可以看到作者、分类、标签和摘要",
            action: {
                type: "checkbox",
                checked: !!d.showDetail,
                changeCallback: (v) => { this.data.showDetail = boolOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setAbstract || "插入文献卡片 / 信息表时带上摘要",
            action: {
                type: "checkbox",
                checked: !!d.insertAbstract,
                changeCallback: (v) => { this.data.insertAbstract = boolOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setAnnoOnlyComment || "插入批注时只要带评论的",
            description: this.i18n.setAnnoOnlyCommentDesc || "过滤掉只划了线、没写想法的批注",
            action: {
                type: "checkbox",
                checked: !!d.annoOnlyComment,
                changeCallback: (v) => { this.data.annoOnlyComment = boolOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setConfirmWrite || "写回红豆前再次确认",
            action: {
                type: "checkbox",
                checked: !!d.confirmWrite,
                changeCallback: (v) => { this.data.confirmWrite = boolOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.setLayout || "多篇文献的排列方式",
            description: this.i18n.setLayoutDesc || "一次插入多篇时，每篇如何摆放；默认每篇单独一行",
            action: {
                type: "select",
                value: d.layout || DEFAULTS.layout,
                list: [
                    { text: this.i18n.layoutLine || "每篇一行（默认）", value: "line" },
                    { text: this.i18n.layoutPara || "每篇一个段落", value: "para" },
                    { text: this.i18n.layoutBullet || "无序列表", value: "bullet" },
                    { text: this.i18n.layoutNumber || "编号列表", value: "number" },
                    { text: this.i18n.layoutSemicolon || "连成一行（用分隔符）", value: "semicolon" },
                ],
                changeCallback: (v) => { this.data.layout = valOf(v) || DEFAULTS.layout; },
            },
        });

        setting.addItem({
            title: this.i18n.setSeparator || "连排时的分隔符",
            description: this.i18n.setSeparatorDesc || "只有上面选了「连成一行」时才用得到",
            action: {
                type: "textinput",
                value: d.separator,
                placeholder: DEFAULTS.separator,
                changeCallback: (v) => { this.data.separator = valOf(v) || DEFAULTS.separator; },
            },
        });

        setting.addItem({
            title: this.i18n.setRegTitle || "在红豆里看到哪些思源笔记引用了文献",
            description: this.i18n.setRegDesc || "红豆尚未开放第三方引用登记接口，无法像 Obsidian 版那样登记引用位置。可改用「把当前笔记写回红豆」——笔记正文会作为红豆笔记出现，在红豆里打开该文献就能看到。",
            action: {
                type: "button",
                label: this.i18n.setRegBtn || "写回红豆笔记",
                callback: () => this.pushCurrentNote(),
            },
        });

        setting.addItem({
            title: this.i18n.setBackupTitle || "材料更新备份",
            description: this.i18n.setBackupDesc || "每次更新「红豆材料」前自动留一份整篇文档副本，最多 10 份",
            action: {
                type: "button",
                label: this.i18n.setBackupBtn || "查看备份",
                callback: () => this.showBackups(),
            },
        });

        /* ---------------- 红豆桥接（红豆 → 思源 反向推送） ---------------- */

        // 第一项就放下载入口，没装红豆端插件的人一眼能看到
        setting.addItem({
            title: this.i18n.bridgeDlTitle || "① 下载红豆端插件（双向联动必备）",
            description: (this.i18n.bridgeDlDesc || "还没装？下载 hongdou-siyuan-bridge.xpi，在红豆「工具 → 插件中心 → 从文件安装」，重启红豆。\n完整地址：%s")
                .replace("%s", BRIDGE_XPI_URL),
            action: {
                type: "button",
                label: this.i18n.bridgeDlBtn || "直接下载 xpi",
                callback: () => this.openExternal(BRIDGE_XPI_URL),
            },
        });

        setting.addItem({
            title: this.i18n.bridgeSection || "② 配对（装好红豆端插件后做这一步）",
            description: this.i18n.bridgeSectionDesc || "在红豆里点「工具 → 红豆 ↔ 思源：显示配对码」，把 6 位数字填到这里。",
            action: {
                type: "button",
                label: this.i18n.bridgePairBtn || (d.bridgeToken ? "重新配对" : "输入配对码"),
                callback: () => this.openBridgePair(),
            },
        });

        setting.addItem({
            title: this.i18n.bridgeStatus || "桥接状态",
            description: (() => {
                const txt = d.bridgeToken ? "已配对" : "未配对";
                return (this.i18n.bridgeStatusDesc || "点右侧按钮刷新。当前：%s").replace("%s", txt);
            })(),
            action: {
                type: "button",
                label: this.i18n.bridgeCheck || "刷新状态",
                callback: async () => {
                    const txt = await this.bridgeStatusText();
                    showMessage(txt, 5000);
                },
            },
        });

        setting.addItem({
            title: this.i18n.bridgePort || "桥接端口",
            description: this.i18n.bridgePortDesc || "红豆端 bridge 插件监听的端口，默认 18501；改完需重开思源",
            action: {
                type: "textinput",
                value: String(d.bridgePort || DEFAULTS.bridgePort),
                placeholder: String(DEFAULTS.bridgePort),
                changeCallback: (v) => {
                    const n = parseInt(valOf(v), 10);
                    this.data.bridgePort = (n > 0 && n < 65536) ? n : DEFAULTS.bridgePort;
                    if (this.bridge) this.bridge.port = this.data.bridgePort;
                },
            },
        });

        setting.addItem({
            title: this.i18n.bridgeAuto || "收到就自动插入光标处",
            description: this.i18n.bridgeAutoDesc || "关掉后只计数并在顶栏显示红点，点命令手动拉取",
            action: {
                type: "checkbox",
                value: !!d.bridgeAutoInsert,
                changeCallback: (v) => { this.data.bridgeAutoInsert = !!valOf(v); },
            },
        });

        setting.addItem({
            title: this.i18n.bridgePoll || "轮询间隔（秒）",
            description: this.i18n.bridgePollDesc || "多久问一次红豆有没有新推送，2-30 秒",
            action: {
                type: "textinput",
                value: String(d.bridgePollSec || DEFAULTS.bridgePollSec),
                placeholder: String(DEFAULTS.bridgePollSec),
                changeCallback: (v) => {
                    const n = parseInt(valOf(v), 10);
                    this.data.bridgePollSec = (n >= 2 && n <= 30) ? n : DEFAULTS.bridgePollSec;
                    this.startBridgeWatch();
                },
            },
        });

        setting.addItem({
            title: this.i18n.checkTitle || "连接自检",
            description: this.i18n.checkDesc || "检查红豆服务、文献库、分类与写权限",
            action: {
                type: "button",
                label: this.i18n.checkBtn || "检查连接",
                callback: () => this.checkConnection(),
            },
        });

        setting.open(this.name);
    }

    async checkConnection() {
        try {
            const st = await this.client.status();
            let collText = "";
            try {
                const c = await this.client.collections(true);
                collText = `分类 ${c.flat.size} 个`;
            } catch (err) {
                collText = "分类读取失败";
            }
            const perm = st.permissions || {};
            let libText = "";
            try {
                const s = await this.client.call("hongdou_get_statistics", {}, 15000);
                const n = s && (s.totalItems || s.itemCount || (s.counts && s.counts.items) || (s.summary && s.summary.totalItems));
                if (n) libText = `共 ${n} 条文献`;
            } catch (err) { /* 统计失败不影响自检 */ }
            const lines = [
                `红豆 ${st.appVersion || "?"} 已连接`,
                `工具 ${st.toolCount || (st.tools || []).length} 个　${collText}${libText ? "　" + libText : ""}`,
                `写权限：${perm.writeEnabled ? "开启" : "关闭（笔记/标签/分类写回不可用）"}`,
                `接口：${this.data.endpoint}`,
            ];
            showMessage(lines.join("<br>"), 8000);
        } catch (err) {
            showMessage(err.message, 8000, "error");
        }
    }
}

/* --------------------------------------------------------- Markdown → HTML */

/** 行内标记 */
function inlineMd(s) {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    return t;
}

/** 富文本写剪贴板：HTML + 纯文本双写，粘到 Word 保留格式 */
async function writeClipboard(html, text) {
    try {
        if (navigator.clipboard && typeof window.ClipboardItem === "function" && html) {
            const item = new window.ClipboardItem({
                "text/html": new Blob([html], { type: "text/html" }),
                "text/plain": new Blob([text || stripHtml(html)], { type: "text/plain" }),
            });
            await navigator.clipboard.write([item]);
            return true;
        }
    } catch (err) { /* 退回纯文本 */ }
    try {
        await navigator.clipboard.writeText(text || stripHtml(html));
        return true;
    } catch (err) {
        return false;
    }
}

/** 粗暴去标签，只用于剪贴板纯文本兜底 */
function stripHtml(html) {
    return String(html || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(div|p|li)>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** 够用的 Markdown → HTML，供写回红豆笔记使用 */
function md2html(md) {
    const lines = String(md || "").replace(/\r/g, "").split("\n");
    const out = [];
    const listBuf = [];
    const flushList = () => {
        if (listBuf.length) {
            out.push("<ul>" + listBuf.map(x => `<li>${x}</li>`).join("") + "</ul>");
            listBuf.length = 0;
        }
    };
    let i = 0;
    let inCode = false;
    const codeBuf = [];
    while (i < lines.length) {
        const line = lines[i];
        if (/^```/.test(line)) {
            if (inCode) {
                out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
                codeBuf.length = 0;
                inCode = false;
            } else {
                flushList();
                inCode = true;
            }
            i++;
            continue;
        }
        if (inCode) {
            codeBuf.push(line);
            i++;
            continue;
        }
        if (/^\s*$/.test(line)) {
            flushList();
            i++;
            continue;
        }
        // 表格
        if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
            flushList();
            const parse = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
            const head = parse(line);
            i += 2;
            const rows = [];
            while (i < lines.length && /^\s*\|/.test(lines[i])) {
                rows.push(parse(lines[i]));
                i++;
            }
            out.push("<table><thead><tr>" + head.map(h => `<th>${inlineMd(h)}</th>`).join("") +
                "</tr></thead><tbody>" +
                rows.map(r => "<tr>" + r.map(c => `<td>${inlineMd(c)}</td>`).join("") + "</tr>").join("") +
                "</tbody></table>");
            continue;
        }
        const h = /^(#{1,6})\s+(.*)$/.exec(line);
        if (h) {
            flushList();
            const lv = h[1].length;
            out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
            i++;
            continue;
        }
        const li = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (li) {
            listBuf.push(inlineMd(li[1]));
            i++;
            continue;
        }
        const ol = /^\s*\d+\.\s+(.*)$/.exec(line);
        if (ol) {
            listBuf.push(inlineMd(ol[1]));
            i++;
            continue;
        }
        if (/^>\s?/.test(line)) {
            flushList();
            out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ""))}</blockquote>`);
            i++;
            continue;
        }
        const buf = [line];
        i++;
        while (i < lines.length && !/^\s*$/.test(lines[i])
            && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>|\||```)/.test(lines[i])) {
            buf.push(lines[i]);
            i++;
        }
        out.push(`<p>${inlineMd(buf.join(" "))}</p>`);
    }
    flushList();
    if (codeBuf.length) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    return out.join("\n");
}

module.exports = HongdouPlugin;
// 供自测与二次开发复用
module.exports.normalizeItem = normalizeItem;
module.exports.yearFrom = yearFrom;
module.exports.md2html = md2html;
module.exports.typeLabel = typeLabel;
module.exports.NOTE_TEMPLATE = NOTE_TEMPLATE;
/* 引用体系（供自动化测试直接调用） */
module.exports.surnameOf = surnameOf;
module.exports.citeWho = citeWho;
module.exports.citeKeyOf = citeKeyOf;
module.exports.isNumericStyle = isNumericStyle;
module.exports.scanCites = scanCites;
module.exports.replaceCites = replaceCites;
module.exports.citeText = citeText;
module.exports.citeMarkdown = citeMarkdown;
module.exports.parseCiteQuery = parseCiteQuery;
module.exports.compressNums = compressNums;
module.exports.escapeOl = escapeOl;
module.exports.yearSuffixMap = yearSuffixMap;
module.exports.toRIS = toRIS;
module.exports.toCSLJSON = toCSLJSON;
module.exports.toMdTable = toMdTable;
module.exports.toCiteCommands = toCiteCommands;
/* 红豆桥接（供自动化测试直接调用） */
module.exports.BridgeClient = BridgeClient;
module.exports.adaptBridgeItem = adaptBridgeItem;
