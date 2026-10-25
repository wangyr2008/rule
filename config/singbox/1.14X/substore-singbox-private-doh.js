// 用法（与 xream 的 sing-box 模板脚本同一套规范）：
//   1) 把本文件放到任意可访问的地址，脚本操作里填这个 URL
//   2) 参数写在 URL 的 # 后面，例如：
//      https://raw.githubusercontent.com/你/仓库/main/doh.js#doh=https%3A%2F%2Fdns-resolve.nowhere-backend.xyz%2Fdns-query%2Fa9e09e225e08d7caa10001ac
//      ⚠️ 在 URL 里传参时 doh 的值必须 encodeURIComponent；用前端参数框则不用编码
//   3) 也可以直接粘贴代码，然后改下面 DEFAULT_DOH 这一行
//
// 支持的参数（都可不传）：
//   doh        私有 DoH 完整链接（最常用；也可拆成 server / port / path 三个参数）
//   tag        私有 DoH 在配置里的 tag        默认 dns-node
//   bootstrap  解析该 DoH 域名用的引导 DNS    默认 ali
//   remove     要删除的旧 DNS tag，逗号分隔   默认空 = 只新增，保留 tx
//   detour     给私有 DoH 指定出站            默认不设置
//   resolver   是否把 route.default_domain_resolver 指向它   默认 1
//   pretty     输出缩进                       默认 2
//
// 默认行为：保留 tx / ali / hosts 等所有现有 DNS，只在 dns.servers 末尾新增一条私有 DoH，
//          并把 route.default_domain_resolver 指向它。其余配置一字不动。

/* ========== ★ 换机场 DoH 只改下面这一行（用 URL 传参时这行不用管）★ ========== */
const DEFAULT_DOH =
    'https://dns-resolve.nowhere-backend.xyz/dns-query/a9e09e225e08d7caa10001ac';
/* ============================================================================ */

const DEFAULTS = {
    tag: 'dns-node',
    bootstrap: 'ali',
    remove: '',
    detour: '',
    resolver: 1,
    pretty: 2,
};

function log(v) {
    try {
        console.log(`[📦 私有 DoH] ${v}`);
    } catch (e) {}
}

/* -------------------- 参数 -------------------- */
let ARGS = typeof $arguments === 'undefined' ? {} : $arguments;
if (typeof ARGS === 'string') {
    const s = ARGS.trim();
    if (/^https?:\/\//i.test(s) || (!s.includes('=') && s.includes('.'))) {
        ARGS = { doh: s }; // 只填了一个裸链接
    } else {
        try {
            ARGS = JSON.parse(s);
        } catch (e) {
            const obj = {};
            s.split('&').forEach((kv) => {
                if (!kv) return;
                const i = kv.indexOf('=');
                const k = i < 0 ? kv : kv.slice(0, i);
                const v = i < 0 ? '' : kv.slice(i + 1);
                try {
                    obj[decodeURIComponent(k)] = decodeURIComponent(v);
                } catch (e2) {
                    obj[k] = v;
                }
            });
            ARGS = obj;
        }
    }
}
if (!ARGS || typeof ARGS !== 'object') ARGS = {};

const A = (k) => {
    const v = ARGS[k];
    return v === undefined || v === null || String(v).trim() === ''
        ? undefined
        : v;
};

log(`传入参数 ${JSON.stringify(ARGS)}`);

const dohInput = A('doh') || DEFAULT_DOH;
const newTag = String(A('tag') || DEFAULTS.tag);
const bootstrap = String(A('bootstrap') || DEFAULTS.bootstrap);
const detour = A('detour') || DEFAULTS.detour;
const removeTags = String(
    A('remove') === undefined
        ? A('replace') === undefined
            ? DEFAULTS.remove
            : A('replace')
        : A('remove'),
)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((t) => t !== newTag);
const setDefaultResolver = !/^(0|false|no|off)$/i.test(
    String(A('resolver') === undefined ? DEFAULTS.resolver : A('resolver')),
);
const indentArg = parseInt(
    String(A('pretty') === undefined ? DEFAULTS.pretty : A('pretty')),
    10,
);
const indent = Number.isFinite(indentArg) && indentArg >= 0 ? indentArg : 2;

/* -------------------- 解析 DoH 链接 -------------------- */
function parseDoh(raw) {
    let s = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    const body = s.replace(/^https?:\/\//i, '');
    const slash = body.indexOf('/');
    const hostPort = (slash < 0 ? body : body.slice(0, slash)).replace(
        /^.*@/,
        '',
    );
    let path = slash < 0 ? '/dns-query' : body.slice(slash);
    if (path === '/') path = '/dns-query';

    let host = hostPort;
    let port = '';
    if (hostPort.startsWith('[')) {
        const i = hostPort.indexOf(']');
        host = hostPort.slice(0, i + 1);
        const rest = hostPort.slice(i + 1);
        if (rest.startsWith(':')) port = rest.slice(1);
    } else {
        const i = hostPort.lastIndexOf(':');
        if (i > 0) {
            host = hostPort.slice(0, i);
            port = hostPort.slice(i + 1);
        }
    }
    return { server: host, port, path };
}

const parsed = parseDoh(dohInput);
const dohServer = String(
    A('server') || (parsed ? parsed.server : ''),
);
const dohPort = String(A('port') || (parsed ? parsed.port : '')).trim();
const dohPath = String(A('path') || (parsed ? parsed.path : '')).trim();

/* -------------------- 核心转换 -------------------- */
function transform(text) {
    const src = String(text === undefined || text === null ? '' : text).replace(
        /^\uFEFF/,
        '',
    );
    if (!src.trim()) {
        log('WARN 没有取到配置内容（本脚本需用在「文件」类型的处理上）');
        return null;
    }
    if (!dohServer) {
        log(`ERROR 私有 DoH 链接无法解析：${dohInput}`);
        return null;
    }

    let cfg;
    try {
        cfg = JSON.parse(src);
    } catch (e) {
        try {
            const parser =
                typeof ProxyUtils !== 'undefined' && ProxyUtils.JSON5
                    ? ProxyUtils.JSON5
                    : JSON;
            cfg = parser.parse(src);
        } catch (e2) {
            log(`ERROR 配置不是合法 JSON：${e2.message || e2}`);
            return null;
        }
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        log('ERROR 配置根节点不是对象');
        return null;
    }

    // 1) 组装私有 DoH
    const dohEntry = { tag: newTag, type: 'https', server: dohServer };
    if (dohPort && dohPort !== '443') dohEntry.server_port = Number(dohPort);
    if (dohPath) dohEntry.path = dohPath;
    if (detour) dohEntry.detour = String(detour);
    if (bootstrap) dohEntry.domain_resolver = bootstrap;

    // 2) 写入 dns.servers（已存在同名 tag 就原位更新，保证幂等）
    if (!cfg.dns || typeof cfg.dns !== 'object') cfg.dns = {};
    if (!Array.isArray(cfg.dns.servers)) cfg.dns.servers = [];
    const existing = cfg.dns.servers.findIndex((s) => s && s.tag === newTag);
    if (existing >= 0) {
        cfg.dns.servers[existing] = dohEntry;
    } else {
        cfg.dns.servers.push(dohEntry);
    }

    // 3) 只有显式传 remove 才删旧 server
    const removeSet = new Set(removeTags);
    if (removeSet.size) {
        cfg.dns.servers = cfg.dns.servers.filter(
            (s) => !(s && typeof s === 'object' && removeSet.has(s.tag)),
        );
        const REF_KEYS = new Set([
            'server',
            'domain_resolver',
            'default_domain_resolver',
            'resolver',
        ]);
        const rename = new Map(removeTags.map((t) => [t, newTag]));
        const walk = (node) => {
            if (Array.isArray(node)) {
                node.forEach(walk);
                return;
            }
            if (!node || typeof node !== 'object') return;
            Object.keys(node).forEach((k) => {
                const v = node[k];
                if (typeof v === 'string') {
                    if (REF_KEYS.has(k) && rename.has(v)) node[k] = rename.get(v);
                } else {
                    walk(v);
                }
            });
        };
        walk(cfg);
    }

    // 4) 默认域名解析器指向私有 DoH（私有 DoH 真正生效的地方）
    if (setDefaultResolver) {
        if (!cfg.route || typeof cfg.route !== 'object') cfg.route = {};
        const ddr = cfg.route.default_domain_resolver;
        if (ddr && typeof ddr === 'object' && !Array.isArray(ddr)) {
            ddr.server = newTag;
        } else {
            cfg.route.default_domain_resolver = { server: newTag };
        }
    }

    log(
        `私有 DoH = https://${dohServer}${
            dohPort && dohPort !== '443' ? ':' + dohPort : ''
        }${dohPath} | tag=${newTag} | ${
            removeSet.size ? '删除=' + removeTags.join(',') : '保留原有 DNS，仅新增'
        } | default_domain_resolver=${setDefaultResolver ? newTag : '不改'}`,
    );

    return JSON.stringify(cfg, null, indent);
}

/* -------------------- 入口 1：文件脚本内联执行 -------------------- */
// Sub-Store 处理「文件」时会把脚本内联进包装函数，$content / $files 是局部变量
if (typeof $content !== 'undefined' || typeof $files !== 'undefined') {
    const srcText =
        (typeof $content !== 'undefined' && $content) ||
        (typeof $files !== 'undefined' && Array.isArray($files) ? $files[0] : '');
    const out = transform(srcText);
    if (out) $content = out;
}

/* -------------------- 入口 2：脚本操作 func 模式 -------------------- */
// 入参为 { $content, $files, $file, $options }，改完写回 $content 返回
function operator(proxies) {
    if (!proxies || Array.isArray(proxies)) {
        log('WARN 当前输入不是文件类型，已原样返回');
        return proxies;
    }
    const out = transform(proxies.$content || proxies.$files?.[0]);
    if (out) proxies.$content = out;
    return proxies;
}
