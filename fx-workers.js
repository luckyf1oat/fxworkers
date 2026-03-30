import {connect} from 'cloudflare:sockets';
import {getRuntimeConfig, getDefaultUuidBytes, handlePanel} from './panel.js';
import {handleSub} from './sub.js';

const bufferSize = 512 * 1024;
const startThreshold = 50 * 1024 * 1024;
const maxChunkLen = 64 * 1024;
const flushTime = 20;
const concurrency = 3;

const proxyIpAddrs = {EU: 'ProxyIP.DE.CMLiussss.net', AS: 'ProxyIP.SG.CMLiussss.net', JP: 'ProxyIP.JP.CMLiussss.net', US: 'ProxyIP.US.CMLiussss.net'};
const DEFAULT_FALLBACK_PROXYIP = 'ProxyIP.CMLiussss.net';
const coloRegions = {
    JP: new Set(['FUK', 'ICN', 'KIX', 'NRT', 'OKA']),
    EU: new Set([
        'ACC', 'ADB', 'ALA', 'ALG', 'AMM', 'AMS', 'ARN', 'ATH', 'BAH', 'BCN', 'BEG', 'BGW', 'BOD', 'BRU', 'BTS', 'BUD', 'CAI',
        'CDG', 'CPH', 'CPT', 'DAR', 'DKR', 'DMM', 'DOH', 'DUB', 'DUR', 'DUS', 'DXB', 'EBB', 'EDI', 'EVN', 'FCO', 'FRA', 'GOT',
        'GVA', 'HAM', 'HEL', 'HRE', 'IST', 'JED', 'JIB', 'JNB', 'KBP', 'KEF', 'KWI', 'LAD', 'LED', 'LHR', 'LIS', 'LOS', 'LUX',
        'LYS', 'MAD', 'MAN', 'MCT', 'MPM', 'MRS', 'MUC', 'MXP', 'NBO', 'OSL', 'OTP', 'PMO', 'PRG', 'RIX', 'RUH', 'RUN', 'SKG',
        'SOF', 'STR', 'TBS', 'TLL', 'TLV', 'TUN', 'VIE', 'VNO', 'WAW', 'ZAG', 'ZRH']),
    AS: new Set([
        'ADL', 'AKL', 'AMD', 'BKK', 'BLR', 'BNE', 'BOM', 'CBR', 'CCU', 'CEB', 'CGK', 'CMB', 'COK', 'DAC', 'DEL', 'HAN', 'HKG',
        'HYD', 'ISB', 'JHB', 'JOG', 'KCH', 'KHH', 'KHI', 'KTM', 'KUL', 'LHE', 'MAA', 'MEL', 'MFM', 'MLE', 'MNL', 'NAG', 'NOU',
        'PAT', 'PBH', 'PER', 'PNH', 'SGN', 'SIN', 'SYD', 'TPE', 'ULN', 'VTE'])
};
const coloToProxyMap = new Map();
for (const [region, colos] of Object.entries(coloRegions)) for (const colo of colos) coloToProxyMap.set(colo, proxyIpAddrs[region]);

const textDecoder = new TextDecoder();
const createConnect = (hostname, port, socket = connect({hostname, port})) => socket.opened.then(() => socket);
const concurrentConnect = (hostname, port, limit = concurrency) => Promise.any(Array(limit).fill(0).map(() => createConnect(hostname, port)));

const parseHostPort = (addr, defaultPort = 443) => {
    let host = String(addr || '').trim();
    let port = defaultPort;
    if (!host) return {host: DEFAULT_FALLBACK_PROXYIP, port: defaultPort};
    if (host.charCodeAt(0) === 91) {
        const endBracket = host.indexOf(']');
        if (endBracket !== -1) {
            const after = host.slice(endBracket + 1);
            if (after.startsWith(':')) {
                const parsed = Number.parseInt(after.slice(1), 10);
                if (!Number.isNaN(parsed)) port = parsed;
            }
            host = host.slice(0, endBracket + 1);
            return {host, port};
        }
    }
    const idx = host.lastIndexOf(':');
    if (idx > -1 && host.indexOf(':') === idx) {
        const parsed = Number.parseInt(host.slice(idx + 1), 10);
        if (!Number.isNaN(parsed)) {
            port = parsed;
            host = host.slice(0, idx);
        }
    }
    return {host, port};
};

const manualPipe = async (readable, writable) => {
    const _bufferSize = bufferSize, _maxChunkLen = maxChunkLen, _startThreshold = startThreshold, _flushTime = flushTime, _safeBufferSize = _bufferSize - _maxChunkLen;
    let mainBuf = new ArrayBuffer(_bufferSize), offset = 0, time = 2, timerId = null, resume = null, isReading = false, needsFlush = false, totalBytes = 0;
    const flush = () => {
        if (isReading) return needsFlush = true;
        offset > 0 && (writable.send(mainBuf.slice(0, offset)), offset = 0);
        needsFlush = false, timerId && (clearTimeout(timerId), timerId = null), resume?.(), resume = null;
    };
    const reader = readable.getReader({mode: 'byob'});
    try {
        while (true) {
            isReading = true;
            const {done, value} = await reader.read(new Uint8Array(mainBuf, offset, _maxChunkLen));
            if (isReading = false, done) break;
            mainBuf = value.buffer;
            const chunkLen = value.byteLength;
            if (chunkLen < _maxChunkLen) {
                time = 2, chunkLen < 4096 && (totalBytes = 0);
                offset > 0 ? (offset += chunkLen, flush()) : writable.send(value.slice());
            } else {
                totalBytes += chunkLen;
                offset += chunkLen, timerId ||= setTimeout(flush, time), needsFlush && flush();
                offset > _safeBufferSize && (totalBytes > _startThreshold && (time = _flushTime), await new Promise(r => resume = r));
            }
        }
    } finally {isReading = false, flush(), reader.releaseLock()}
};

const handleWebSocketConn = async (webSocket, request, env) => {
    const cfg = await getRuntimeConfig(env);
    const fallbackProxyHost = DEFAULT_FALLBACK_PROXYIP;
    const expectedUuidBytes = cfg.uuidBytes || getDefaultUuidBytes();
    const protocolHeader = request.headers.get('sec-websocket-protocol');
    // @ts-ignore
    const earlyData = protocolHeader ? Uint8Array.fromBase64(protocolHeader, {alphabet: 'base64url'}) : null;
    let tcpWrite, processingChain = Promise.resolve(), tcpSocket;
    const closeSocket = () => {if (!earlyData) {tcpSocket?.close(), webSocket?.close()}};
    const processMessage = async (chunk) => {
        try {
            if (tcpWrite) return tcpWrite(chunk);
            chunk = earlyData ? chunk : new Uint8Array(chunk);
            webSocket.send(new Uint8Array([chunk[0], 0]));
            for (let i = 0; i < 16; i++) if (chunk[i + 1] !== expectedUuidBytes[i]) return null;

            let offset = 19 + chunk[17];
            const port = (chunk[offset] << 8) | chunk[offset + 1];
            offset += 2;
            const addrType = chunk[offset++];
            let newOffset, hostname;
            if (addrType === 2) {
                const len = chunk[offset++];
                newOffset = offset + len;
                hostname = textDecoder.decode(chunk.subarray(offset, newOffset));
            } else if (addrType === 1) {
                newOffset = offset + 4;
                const bytes = chunk.subarray(offset, newOffset);
                hostname = `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
            } else {
                newOffset = offset + 16;
                let ipv6Str = ((chunk[offset] << 8) | chunk[offset + 1]).toString(16);
                for (let i = 1; i < 8; i++) ipv6Str += ':' + ((chunk[offset + i * 2] << 8) | chunk[offset + i * 2 + 1]).toString(16);
                hostname = `[${ipv6Str}]`;
            }

            tcpSocket = await concurrentConnect(hostname, port).catch(async () => {
                const url = new URL(request.url);
                const selectedProxy = url.searchParams.get('proxyip')?.trim() || cfg.customProxyIp || coloToProxyMap.get(request.cf?.colo) || fallbackProxyHost;
                const {host, port: proxyPort} = parseHostPort(selectedProxy, 443);
                return concurrentConnect(host, proxyPort);
            });

            const tcpWriter = tcpSocket.writable.getWriter();
            const payload = chunk.subarray(newOffset);
            if (payload.byteLength) tcpWriter.write(payload);
            tcpWrite = (c) => tcpWriter.write(c);
            manualPipe(tcpSocket.readable, webSocket);
        } catch {closeSocket()}
    };

    if (earlyData) processingChain = processingChain.then(() => processMessage(earlyData));
    webSocket.addEventListener('message', event => processingChain = processingChain.then(() => processMessage(event.data)));
};

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname.startsWith('/panel')) return handlePanel(request, env, url);
        if (url.pathname === '/sub') {
            const cfg = await getRuntimeConfig(env);
            return handleSub(request, env, url, cfg);
        }

        if (request.headers.get('Upgrade') === 'websocket') {
            const {0: clientSocket, 1: webSocket} = new WebSocketPair();
            webSocket.accept(), webSocket.binaryType = 'arraybuffer';
            handleWebSocketConn(webSocket, request, env);
            return new Response(null, {status: 101, webSocket: clientSocket});
        }

        return new Response('Not Found', {status: 404});
    }
};
