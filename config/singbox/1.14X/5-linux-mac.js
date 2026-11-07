/**
 * ============================================================================
 * Sub-Store 脚本 ⑤ —— Linux / 服务器：按网卡 MAC 限定 TUN 接管范围
 * ============================================================================
 *
 * 用途
 *   路由 / NAS / 软路由上只接管指定设备的流量，其余设备走系统路由。
 *   底层是 sing-box TUN 的 include_mac_address / exclude_mac_address。
 *
 * 挂载位置
 *   文件的「脚本操作」里，放在 xream template.js 之后（也可以单独用）。
 *
 * 参数（URL fragment 里用 & 分隔，参考 xream 的写法）
 *   mac / mac1 / mac2 …   一个或多个 MAC，也支持一条里用逗号分隔
 *   mode                  replace（默认，覆盖模板）/ append（追加）/ clear（清空）
 *   inbound               指定 TUN 入站的 tag，留空自动找 type = tun
 *   exclude               可选，写入 exclude_mac_address
 *   verbose               打印处理结果
 *
 * 用法示例
 *   单个：
 *     .../5-linux-mac.js#mac=aa:bb:cc:dd:ee:ff
 *   一条里写多个（逗号分隔）：
 *     .../5-linux-mac.js#mac=aa:bb:cc:dd:ee:ff,11:22:33:44:55:66
 *   分开写（URL 更干净）：
 *     .../5-linux-mac.js#mac1=aa:bb:cc:dd:ee:ff&mac2=11:22:33:44:55:66
 *   追加到模板已有的列表：
 *     .../5-linux-mac.js#mac=aa:bb:cc:dd:ee:ff&mode=append
 *
 * MAC 写法随意，脚本会统一成 aa:bb:cc:dd:ee:ff：
 *   AA-BB-CC-DD-EE-FF / aabbccddeeff / aa:bb:cc:dd:ee:ff 都可以
 * ============================================================================
 */

const SB_MAC_DEFAULTS = {
    mode: 'replace', // replace | append | clear
    inbound: '',
    exclude: '',
    verbose: false,
};

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sbMacLog(msg) {
    console.log(`[🔌 Linux MAC] ${msg}`);
}

function sbMacParseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    const text = String(raw).trim();
    if (!text) return {};

    // 兼容 JSON 写法
    if (text.charAt(0) === '{') {
        try {
            return JSON.parse(text) || {};
        } catch (e) {
            // 落到 key=value 解析
        }
    }

    // 兼容 a=1&b=2 写法（脚本以链接方式挂载时可能拿到这种）
    const out = {};
    for (const pair of text.split('&')) {
        if (!pair) continue;
        const idx = pair.indexOf('=');
        if (idx === -1) {
            out[decodeURIComponent(pair)] = true;
            continue;
        }
        const key = decodeURIComponent(pair.slice(0, idx));
        const value = pair.slice(idx + 1);
        out[key] = value === '' ? true : decodeURIComponent(value);
    }
    return out;
}

function sbMacMerge(base, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return patch === undefined ? base : patch;
    }
    const out = base && typeof base === 'object' && !Array.isArray(base) ? { ...base } : {};
    for (const key of Object.keys(patch)) {
        const pv = patch[key];
        const bv = out[key];
        if (
            pv && typeof pv === 'object' && !Array.isArray(pv) &&
            bv && typeof bv === 'object' && !Array.isArray(bv)
        ) {
            out[key] = sbMacMerge(bv, pv);
        } else {
            out[key] = pv;
        }
    }
    return out;
}

function sbMacIsFileInput(input) {
    return !!input && !Array.isArray(input) &&
        (typeof input.$content === 'string' || Array.isArray(input.$files));
}

function sbMacReadContent(input) {
    const text = typeof input.$content === 'string'
        ? input.$content
        : (Array.isArray(input.$files) ? String(input.$files[0] || '') : '');
    if (!text.trim()) return null;
    const parser = (typeof ProxyUtils !== 'undefined' && ProxyUtils.JSON5) || JSON;
    try {
        return parser.parse(text);
    } catch (e) {
        return null;
    }
}

/** 统一成 aa:bb:cc:dd:ee:ff；不是 12 位十六进制就返回空串 */
function sbMacNormalize(raw) {
    const hex = String(raw == null ? '' : raw).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 12) return '';
    return hex.toLowerCase().match(/.{2}/g).join(':');
}

/** 一条字符串里可能塞了多个 MAC，按 , ; | 空格 切开 */
function sbMacSplit(value) {
    if (Array.isArray(value)) {
        return value.flatMap((v) => sbMacSplit(v));
    }
    if (typeof value !== 'string') return [];
    return value
        .split(/[,;|\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 收集 mac / mac1 / mac2 … 里的所有地址
 * 排序保证 mac 在最前，其余按数字递增，输出稳定
 */
function sbMacCollect(args, prefix) {
    const re = new RegExp('^' + prefix + '\\d*$', 'i');
    const keys = Object.keys(args).filter((k) => re.test(k));

    keys.sort((a, b) => {
        const rank = (k) => {
            if (k.toLowerCase() === prefix) return 0;
            const n = parseInt(k.replace(/\D/g, ''), 10);
            return Number.isNaN(n) ? 999 : n;
        };
        return rank(a) - rank(b);
    });

    const list = [];
    const bad = [];
    for (const key of keys) {
        for (const item of sbMacSplit(args[key])) {
            const mac = sbMacNormalize(item);
            if (!mac) {
                bad.push(item);
                continue;
            }
            if (list.indexOf(mac) === -1) list.push(mac);
        }
    }
    return { list, bad };
}

/** 找目标 TUN 入站 */
function sbMacFindTun(config, wantedTag) {
    const inbounds = Array.isArray(config.inbounds) ? config.inbounds : [];
    if (wantedTag) {
        return inbounds.find((i) => i.tag === wantedTag) || null;
    }
    return inbounds.find((i) => String(i.type).toLowerCase() === 'tun') || null;
}

// ---------------------------------------------------------------------------
// 核心
// ---------------------------------------------------------------------------
function sbMacApply(config, CFG) {
    const mode = String(CFG.mode || 'replace').toLowerCase();
    const include = sbMacCollect(CFG, 'mac');
    const exclude = sbMacCollect(CFG, 'exclude');

    if (include.bad.length) {
        sbMacLog(`忽略无法识别的地址：${include.bad.join(', ')}`);
    }
    if (exclude.bad.length) {
        sbMacLog(`忽略无法识别的排除地址：${exclude.bad.join(', ')}`);
    }

    const tun = sbMacFindTun(config, CFG.inbound);
    if (!tun) {
        sbMacLog(
            CFG.inbound
                ? `找不到 tag 为 ${CFG.inbound} 的入站，跳过`
                : '配置里没有 TUN 入站，跳过'
        );
        return config;
    }

    // ---- include_mac_address ----
    if (mode === 'clear') {
        delete tun.include_mac_address;
        sbMacLog('已清空 include_mac_address');
    } else if (!include.list.length) {
        // 没给地址就不要动，避免把模板里的列表误删
        sbMacLog('没有提供 MAC，include_mac_address 保持不变');
    } else if (mode === 'append') {
        const current = Array.isArray(tun.include_mac_address)
            ? tun.include_mac_address
            : [];
        const merged = current
            .map((m) => sbMacNormalize(m) || m)
            .filter(Boolean);
        for (const mac of include.list) {
            if (merged.indexOf(mac) === -1) merged.push(mac);
        }
        tun.include_mac_address = merged;
    } else {
        tun.include_mac_address = include.list.slice();
    }

    // ---- exclude_mac_address（可选）----
    if (exclude.list.length) {
        tun.exclude_mac_address = exclude.list.slice();
    } else if (mode === 'clear') {
        delete tun.exclude_mac_address;
    }

    // ---- 提示：这两个字段要靠 auto_route / auto_redirect 才生效 ----
    if (
        (tun.include_mac_address || tun.exclude_mac_address) &&
        !tun.auto_route && !tun.auto_redirect
    ) {
        sbMacLog('注意：TUN 未开 auto_route / auto_redirect，MAC 过滤不会生效');
    }

    // ---- 日志 ----
    const inc = tun.include_mac_address
        ? tun.include_mac_address.join(', ')
        : '(无)';
    sbMacLog(`tun=${tun.tag} mode=${mode} include: ${inc}`);

    if (tun.exclude_mac_address) {
        sbMacLog(`exclude: ${tun.exclude_mac_address.join(', ')}`);
    }
    if (CFG.verbose) {
        sbMacLog(`完整入站：${JSON.stringify(tun)}`);
    }

    return config;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function operator(input = [], targetPlatform, context) {
    const ARGS = sbMacParseArgs(typeof $arguments !== 'undefined' ? $arguments : {});
    const CFG = sbMacMerge(SB_MAC_DEFAULTS, ARGS);

    // 文件流程
    if (sbMacIsFileInput(input)) {
        const config = sbMacReadContent(input);
        if (!config || !Array.isArray(config.outbounds)) {
            sbMacLog('$content 不是合法的 sing-box 配置，已跳过');
            return input;
        }
        sbMacApply(config, CFG);
        input.$content = JSON.stringify(config, null, 2);
        return input;
    }

    // 配置对象
    if (input && !Array.isArray(input) && Array.isArray(input.outbounds)) {
        return sbMacApply(input, CFG);
    }

    sbMacLog('输入无法识别，已原样透传');
    return input;
}
