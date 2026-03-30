const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const CONFIG_CACHE_TTL_MS = 5000;
export const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
export const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const textEncoder = new TextEncoder();
let configCache = {expires: 0, value: null};

const parseUuidBytes = (uuid) => {
    const clean = uuid.replace(/-/g, '').toLowerCase();
    if (clean.length !== 32) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        const hi = parseInt(clean[i * 2], 16);
        const lo = parseInt(clean[i * 2 + 1], 16);
        if (Number.isNaN(hi) || Number.isNaN(lo)) return null;
        out[i] = (hi << 4) | lo;
    }
    return out;
};
const defaultUuidBytes = parseUuidBytes(DEFAULT_UUID);

export const getDefaultUuidBytes = () => defaultUuidBytes;

const getCookieValue = (cookieHeader, key) => {
    if (!cookieHeader) return null;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const trimmed = part.trim();
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        if (trimmed.slice(0, eq) === key) return decodeURIComponent(trimmed.slice(eq + 1));
    }
    return null;
};
const randomToken = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
};
const toHex = (u8) => Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (input) => {
    const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
    return toHex(new Uint8Array(digest));
};
const htmlEscape = (s = '') => s.replace(/[&<>'"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const redirect = (location, cookie) => {
    const headers = new Headers({Location: location});
    if (cookie) headers.append('Set-Cookie', cookie);
    return new Response(null, {status: 302, headers});
};

const readConfigFromKv = async (env) => {
    const kv = env?.CONFIG_KV;
    const safeDefaultUuid = DEFAULT_UUID;
    if (!kv) return {uuid: safeDefaultUuid, uuidBytes: parseUuidBytes(safeDefaultUuid) || defaultUuidBytes, customProxyIp: '', hasPassword: false};

    const [uuidRaw, customProxyRaw, passwordHash] = await Promise.all([
        kv.get('cfg:uuid'),
        kv.get('cfg:custom_proxyip'),
        kv.get('cfg:panel_password_hash')
    ]);
    const uuid = UUID_REGEX.test(uuidRaw || '') ? uuidRaw : safeDefaultUuid;
    return {
        uuid,
        uuidBytes: parseUuidBytes(uuid) || defaultUuidBytes,
        customProxyIp: (customProxyRaw || '').trim(),
        hasPassword: !!passwordHash
    };
};

export const getRuntimeConfig = async (env) => {
    const now = Date.now();
    if (configCache.value && configCache.expires > now) return configCache.value;
    const value = await readConfigFromKv(env);
    configCache = {value, expires: now + CONFIG_CACHE_TTL_MS};
    return value;
};

const verifySession = async (request, env) => {
    const kv = env?.CONFIG_KV;
    if (!kv) return false;
    const token = getCookieValue(request.headers.get('Cookie'), 'panel_session');
    if (!token) return false;
    const [savedToken, expireRaw] = await Promise.all([kv.get('cfg:panel_session_token'), kv.get('cfg:panel_session_expire')]);
    if (!savedToken || savedToken !== token) return false;
    return Number(expireRaw || '0') > Date.now();
};

const panelHtml = ({mode, message = '', uuid = DEFAULT_UUID, customProxyIp = '', subUrl = ''}) => {
    const msg = message ? `<div style="margin:12px 0;padding:10px;border:1px solid #333;">${htmlEscape(message)}</div>` : '';
    const commonStyle = '<style>*{box-sizing:border-box}body{margin:0;background:#f7f7f7;color:#111;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,PingFang SC,Microsoft YaHei,sans-serif}main{max-width:820px;margin:4vh auto;padding:24px;border:1px solid #111;border-radius:20px;background:#fff;box-shadow:0 8px 28px #0000000d}h1{font-size:22px;line-height:1.2;margin:0 0 8px}p{margin:0 0 16px;color:#444}label{display:block;margin:10px 0 6px;font-weight:600}.card{border:1px solid #111;border-radius:16px;background:#fff;padding:14px 14px 12px}.stack{display:grid;gap:12px}.input-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center}input{width:100%;padding:12px 13px;border:1px solid #111;border-radius:12px;background:#fff;color:#000;outline:none}input:focus{border-color:#000;box-shadow:0 0 0 2px #00000012}button{margin-top:12px;padding:11px 14px;border:1px solid #000;border-radius:12px;background:#000;color:#fff;cursor:pointer;font-weight:600}button.secondary{background:#fff;color:#000}.btn-inline{margin-top:0;padding:11px 12px;white-space:nowrap}.hint{display:block;margin-top:6px;color:#666}.actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:10px}.mono{font-size:12px;line-height:1.45;overflow-wrap:anywhere;word-break:break-word;border:1px dashed #000;border-radius:12px;padding:10px;margin-top:8px;min-width:0;background:#fafafa}.section{margin-top:14px}.field{min-width:0}@media (max-width:760px){main{margin:0;padding:14px 12px;border:none;border-radius:0;min-height:100vh;box-shadow:none}h1{font-size:20px}.card{padding:12px}.actions{grid-template-columns:1fr}.input-row{grid-template-columns:1fr}button{width:100%}.btn-inline{width:auto}}</style>';
    if (mode === 'init') return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${commonStyle}<title>Panel Init</title></head><body><main><h1>首次初始化密码</h1><p>检测到尚未设置面板密码，请先初始化。</p>${msg}<form method="post" action="/panel/init"><label>新密码</label><input name="password" type="password" minlength="6" required><label>确认密码</label><input name="confirm" type="password" minlength="6" required><button type="submit">保存密码</button></form></main></body></html>`;
    if (mode === 'login') return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${commonStyle}<title>Panel Login</title></head><body><main><h1>面板登录</h1><p>请输入密码继续。</p>${msg}<form method="post" action="/panel/login"><label>密码</label><input name="password" type="password" required><button type="submit">登录</button></form></main></body></html>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${commonStyle}<title>Panel</title></head><body><main><h1>fx-worker 面板</h1>${msg}<div class="section stack"><div class="card field"><label>订阅地址（自适应）</label><div class="mono" id="sub-url">${htmlEscape(subUrl)}</div><div class="actions"><button type="button" onclick="copyText('${htmlEscape(subUrl)}')">复制自适应订阅</button></div><small class="hint">同一地址自动适配：Clash/Mihomo 返回 YAML，其它客户端返回 Base64。</small></div></div><form method="post" action="/panel/save" class="stack"><div class="card"><label>UUID</label><div class="input-row"><input id="uuid-input" name="uuid" value="${htmlEscape(uuid)}" required><button class="secondary btn-inline" type="button" onclick="fillRandomUuid()">随机</button></div><small class="hint">点击随机可快速生成 UUIDv4。</small></div><div class="card"><label>自定义 ProxyIP（可空，格式 host 或 host:port）</label><input name="custom_proxyip" value="${htmlEscape(customProxyIp)}"><small class="hint">优先级：URL参数 > 自定义 > 分区域 > 兜底</small></div><button type="submit">保存配置</button></form><form method="post" action="/panel/logout"><button class="secondary" type="submit">退出登录</button></form></main><script>function copyText(t){navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(t).catch(()=>{}):void 0}function fillRandomUuid(){const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0'));const u=h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+'-'+h.slice(8,10).join('')+'-'+h.slice(10,16).join('');const el=document.getElementById('uuid-input');if(el)el.value=u;}</script></body></html>`;
};

export const handlePanel = async (request, env, url) => {
    const kv = env?.CONFIG_KV;
    if (!kv) return new Response('CONFIG_KV 未绑定，请先在 wrangler.toml 配置 KV。', {status: 500});

    const pathname = url.pathname;
    const cfg = await getRuntimeConfig(env);
    const authed = await verifySession(request, env);

    if (request.method === 'GET' && pathname === '/panel') {
        const message = url.searchParams.get('msg') || '';
        const mode = cfg.hasPassword ? (authed ? 'settings' : 'login') : 'init';
        const base = `${url.origin}/fxworkers?uuid=${encodeURIComponent(cfg.uuid)}`;
        return new Response(panelHtml({mode, message, uuid: cfg.uuid, customProxyIp: cfg.customProxyIp, subUrl: base}), {headers: {'Content-Type': 'text/html; charset=UTF-8'}});
    }
    if (request.method === 'POST' && pathname === '/panel/init') {
        if (cfg.hasPassword) return redirect('/panel?msg=密码已存在，请直接登录');
        const form = await request.formData();
        const password = String(form.get('password') || '');
        const confirm = String(form.get('confirm') || '');
        if (password.length < 6) return redirect('/panel?msg=密码长度至少6位');
        if (password !== confirm) return redirect('/panel?msg=两次密码不一致');
        await kv.put('cfg:panel_password_hash', await sha256Hex(password));
        configCache.expires = 0;
        return redirect('/panel?msg=初始化成功，请登录');
    }
    if (request.method === 'POST' && pathname === '/panel/login') {
        if (!cfg.hasPassword) return redirect('/panel?msg=请先初始化密码');
        const form = await request.formData();
        const password = String(form.get('password') || '');
        const inputHash = await sha256Hex(password);
        const savedHash = await kv.get('cfg:panel_password_hash');
        if (!savedHash || inputHash !== savedHash) return redirect('/panel?msg=密码错误');
        const token = randomToken();
        const expire = Date.now() + SESSION_TTL_MS;
        await Promise.all([kv.put('cfg:panel_session_token', token), kv.put('cfg:panel_session_expire', String(expire))]);
        return redirect('/panel?msg=登录成功', `panel_session=${encodeURIComponent(token)}; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=86400`);
    }
    if (request.method === 'POST' && pathname === '/panel/save') {
        if (!authed) return redirect('/panel?msg=请先登录');
        const form = await request.formData();
        const newUuid = String(form.get('uuid') || '').trim();
        const customProxyIp = String(form.get('custom_proxyip') || '').trim();
        if (!UUID_REGEX.test(newUuid)) return redirect('/panel?msg=UUID格式无效');
        await Promise.all([kv.put('cfg:uuid', newUuid), kv.put('cfg:custom_proxyip', customProxyIp)]);
        configCache.expires = 0;
        return redirect('/panel');
    }
    if (request.method === 'POST' && pathname === '/panel/logout') {
        await Promise.all([kv.delete('cfg:panel_session_token'), kv.delete('cfg:panel_session_expire')]);
        return redirect('/panel?msg=已退出', 'panel_session=; HttpOnly; Secure; Path=/; SameSite=Strict; Max-Age=0');
    }
    return new Response('Not Found', {status: 404});
};
