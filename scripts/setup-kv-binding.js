const fs = require('node:fs');
const path = require('node:path');
const {execSync} = require('node:child_process');

const ROOT = process.cwd();
const WRANGLER_TOML = path.join(ROOT, 'wrangler.toml');
const BINDING = process.argv[2] || 'CONFIG_KV';
const KV_TITLE = process.argv[3] || 'fxkv';

const run = (cmd) => {
    console.log(`\n> ${cmd}`);
    return execSync(cmd, {encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe']});
};

const extractNamespaceId = (rawOutput) => {
    const text = (rawOutput || '').trim();

    try {
        const parsed = JSON.parse(text);
        const candidates = Array.isArray(parsed) ? parsed : [parsed, parsed?.result].filter(Boolean);
        for (const item of candidates) {
            if (item && typeof item === 'object') {
                if (typeof item.id === 'string' && item.id) return item.id;
                if (item.namespace_id) return item.namespace_id;
            }
        }
    } catch {}

    const match = text.match(/[a-f0-9]{32}/i);
    return match ? match[0] : null;
};

const parseNamespaceList = (rawOutput) => {
    const text = (rawOutput || '').trim();
    const result = [];

    // 1) 优先尝试 JSON（某些 wrangler 版本可能直接返回 JSON）
    try {
        const parsed = JSON.parse(text);
        const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.result) ? parsed.result : []);
        for (const item of arr) {
            if (!item || typeof item !== 'object') continue;
            const id = String(item.id || item.namespace_id || '').trim();
            const title = String(item.title || item.name || '').trim();
            if (id && title) result.push({id, title});
        }
        if (result.length) return result;
    } catch {}

    // 2) 兼容文本/表格输出，提取 id + title
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
        // 例：fb318...  fxkv
        const m1 = line.match(/\b([a-f0-9]{32})\b\s+(.+)$/i);
        if (m1) {
            const id = m1[1];
            const title = m1[2].replace(/^"|"$/g, '').trim();
            if (id && title && !/^\|?-+/.test(title)) result.push({id, title});
            continue;
        }

        // 例："id": "...", "title": "..."
        const m2 = line.match(/"id"\s*:\s*"([a-f0-9]{32})".*"title"\s*:\s*"([^"]+)"/i);
        if (m2) result.push({id: m2[1], title: m2[2]});
    }

    return result;
};

const findExistingNamespaceId = (title) => {
    try {
        const output = run('npx wrangler kv namespace list');
        const all = parseNamespaceList(output);
        const hit = all.find(x => x.title === title);
        return hit ? hit.id : null;
    } catch {
        return null;
    }
};

const createNamespace = (title, preview = false) => {
    const cmd = `npx wrangler kv namespace create ${title}${preview ? ' --preview' : ''}`;
    try {
        const output = run(cmd);
        const id = extractNamespaceId(output);
        if (!id) throw new Error(`未能从输出中解析到 KV ID:\n${output}`);
        return id;
    } catch (err) {
        const stderr = err?.stderr?.toString?.() || err?.message || String(err);
        const existsMatch = stderr.match(/A KV namespace with the title "([^"]+)" already exists/i);
        if (existsMatch) {
            const existsTitle = existsMatch[1];
            const id = findExistingNamespaceId(existsTitle);
            if (id) {
                console.log(`ℹ️ 检测到已存在 KV: ${existsTitle}，复用 id=${id}`);
                return id;
            }
            throw new Error(`命名空间已存在但未能自动查到 ID，请手动执行: npx wrangler kv namespace list`);
        }
        throw new Error(`执行失败: ${cmd}\n${stderr}\n请确认已先执行: npx wrangler login`);
    }
};

const updateWranglerToml = (filePath, binding, id, previewId) => {
    if (!fs.existsSync(filePath)) {
        throw new Error(`未找到文件: ${filePath}`);
    }

    let content = fs.readFileSync(filePath, 'utf8');
    const escapedBinding = binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const blockRegex = new RegExp(
        `(\\[\\[kv_namespaces\\]\\][\\s\\S]*?binding\\s*=\\s*"${escapedBinding}"[\\s\\S]*?id\\s*=\\s*")[^"]*("[\\s\\S]*?preview_id\\s*=\\s*")[^"]*(")`,
        'm'
    );

    if (blockRegex.test(content)) {
        content = content.replace(blockRegex, `$1${id}$2${previewId}$3`);
    } else {
        content += `\n\n[[kv_namespaces]]\nbinding = "${binding}"\nid = "${id}"\npreview_id = "${previewId}"\n`;
    }

    fs.writeFileSync(filePath, content, 'utf8');
};

const main = () => {
    console.log(`开始创建并绑定 KV，binding = ${BINDING}, title = ${KV_TITLE}`);
    const id = createNamespace(KV_TITLE, false);
    const previewId = createNamespace(KV_TITLE, true);
    updateWranglerToml(WRANGLER_TOML, BINDING, id, previewId);

    console.log('\n✅ KV 创建并写入 wrangler.toml 完成');
    console.log(`- id: ${id}`);
    console.log(`- preview_id: ${previewId}`);
    console.log(`- file: ${WRANGLER_TOML}`);
};

main();
