import {UUID_REGEX} from './panel.js';

const CFIP_API_URL = 'https://vps789.com/openApi/cfIpApi';
const SUBSCRIPTION_USERINFO = 'upload=0; download=0; total=1125899906842624; expire=253392451200';

const safeLine = (lineRaw = 'ALL') => {
    const line = String(lineRaw || 'ALL').toUpperCase();
    if (line === 'CT' || line === 'CU' || line === 'CM' || line === 'ALL') return line;
    return 'ALL';
};

const safeCount = (countRaw, fallback = 8) => {
    const n = Number.parseInt(String(countRaw || fallback), 10);
    if (Number.isNaN(n)) return fallback;
    return Math.max(1, Math.min(30, n));
};

const toBase64Utf8 = (input) => {
    const bytes = new TextEncoder().encode(input);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
};

const yamlQuote = (input = '') => `'${String(input).replace(/'/g, "''")}'`;

const buildNodeName = (line, index, ip) => {
    const namePrefix = line === 'CT' ? '电信' : line === 'CU' ? '联通' : '移动';
    return `${namePrefix}${String(index).padStart(2, '0')} ${ip}`;
};

const getLineEntries = (data, line, count) => {
    const src = Array.isArray(data?.[line]) ? data[line] : [];
    const out = [];
    for (let i = 0; i < src.length && out.length < count; i++) {
        const ip = String(src[i]?.ip || '').trim();
        if (ip) out.push(ip);
    }
    return out;
};

const buildVlWsLink = ({uuid, ip, host, path, name}) => {
    const encodedPath = encodeURIComponent(path);
    const encodedName = encodeURIComponent(name);
    return `vless://${uuid}@${ip}:443?encryption=none&security=tls&type=ws&host=${host}&path=${encodedPath}&sni=${host}#${encodedName}`;
};

const buildClashProxy = ({uuid, ip, host, path, name}) => {
    const safePath = path.startsWith('/') ? path : `/${path}`;
    return [
        `  - name: ${yamlQuote(name)}`,
        '    type: vless',
        `    server: ${yamlQuote(ip)}`,
        '    port: 443',
        `    uuid: ${yamlQuote(uuid)}`,
        '    tls: true',
        `    servername: ${yamlQuote(host)}`,
        '    network: ws',
        '    udp: true',
        '    ws-opts:',
        `      path: ${yamlQuote(safePath)}`,
        '      headers:',
        `        Host: ${yamlQuote(host)}`
    ].join('\n');
};

const buildClashConfig = (proxies, title = 'fxworkers') => {
    const names = proxies.map((p) => `      - ${yamlQuote(p.name)}`).join('\n');
    const proxyBlocks = proxies.map((p) => p.block).join('\n');
    const mainGroupName = String(title || 'fxworkers').trim() || 'fxworkers';
    return [
        `name: ${yamlQuote(mainGroupName)}`,
        'mixed-port: 7897',
        'allow-lan: true',
        'mode: rule',
        'log-level: info',
        'dns:',
        '  enable: true',
        '  ipv6: true',
        '  enhanced-mode: fake-ip',
        'proxies:',
        proxyBlocks,
        'proxy-groups:',
        `  - name: ${yamlQuote(mainGroupName)}`,
        '    type: select',
        '    proxies:',
        '      - AUTO',
        '      - DIRECT',
        names,
        '  - name: AUTO',
        '    type: url-test',
        '    url: http://www.gstatic.com/generate_204',
        '    interval: 300',
        '    tolerance: 50',
        '    proxies:',
        names,
        '  - name: FINAL',
        '    type: select',
        '    proxies:',
        `      - ${yamlQuote(mainGroupName)}`,
        '      - DIRECT',
        'rules:',
        '  - GEOIP,CN,DIRECT',
        '  - MATCH,FINAL'
    ].join('\n');
};

const detectFormat = (url, request) => {
    const ua = (request.headers.get('user-agent') || '').toLowerCase();
    if (ua.includes('clash') || ua.includes('mihomo') || ua.includes('meta')) return 'clash';
    return 'base64';
};

const fetchCfIpData = async (env) => {
    const apiUrl = (env?.CFIP_API_URL || CFIP_API_URL).trim() || CFIP_API_URL;
    const resp = await fetch(apiUrl, {cf: {cacheTtl: 0, cacheEverything: false}});
    if (!resp.ok) throw new Error(`cfIpApi 请求失败: ${resp.status}`);
    const json = await resp.json();
    if (json?.code !== 0 || !json?.data) throw new Error('cfIpApi 返回结构异常');
    return json.data;
};

export const handleSub = async (request, env, url, cfg) => {
    const uuid = cfg?.uuid || '';
    if (!UUID_REGEX.test(uuid || '')) return new Response('UUID 无效，请先在面板设置有效 UUID', {status: 400});

    const queryUuid = (url.searchParams.get('uuid') || '').trim();
    if (uuid && queryUuid !== uuid) return new Response('Not Found', {status: 404});

    const line = safeLine(url.searchParams.get('line'));
    const count = safeCount(url.searchParams.get('count'), Number.parseInt(env?.SUB_DEFAULT_COUNT || '8', 10) || 8);
    const host = (url.searchParams.get('host') || url.hostname).trim();
    const path = (url.searchParams.get('path') || '/').trim() || '/';
    const title = (url.searchParams.get('title') || env?.SUB_TITLE || 'fxworkers').trim() || 'fxworkers';
    const format = detectFormat(url, request);

    let data;
    try {
        data = await fetchCfIpData(env);
    } catch (err) {
        return new Response(`获取优选 IP 失败: ${err?.message || err}`, {status: 502});
    }

    const lines = line === 'ALL' ? ['CT', 'CU', 'CM'] : [line];
    const links = [];
    const clashProxies = [];
    for (const l of lines) {
        const ips = getLineEntries(data, l, count);
        for (let i = 0; i < ips.length; i++) {
            const ip = ips[i];
            const name = buildNodeName(l, i + 1, ip);
            links.push(buildVlWsLink({uuid, ip: ips[i], host, path, name}));
            clashProxies.push({name, block: buildClashProxy({uuid, ip: ips[i], host, path, name})});
        }
    }

    const raw = links.join('\n');
    if (format === 'raw') {
        return new Response(raw, {headers: {'Content-Type': 'text/plain; charset=utf-8'}});
    }

    if (format === 'clash') {
        return new Response(buildClashConfig(clashProxies, title), {
            headers: {
                'Content-Type': 'text/yaml; charset=utf-8',
                'Subscription-Userinfo': SUBSCRIPTION_USERINFO,
                'Profile-Title': `base64:${toBase64Utf8(title)}`
            }
        });
    }

    return new Response(toBase64Utf8(raw), {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Subscription-Userinfo': SUBSCRIPTION_USERINFO,
            'Profile-Title': `base64:${toBase64Utf8(title)}`
        }
    });
};
