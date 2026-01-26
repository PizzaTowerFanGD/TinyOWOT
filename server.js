const http = require('http');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const querystring = require('querystring');
const url = require('url');

// --- CONFIGURATION ---
const LOCAL_PORT = process.env.PORT || 8080; 
const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

const UVIAS_TOKEN = process.env.UVIAS_TOKEN || "";
const CSRF_TOKEN = process.env.CSRF_TOKEN || "default_middleware_token"; 
const CSRF_COOKIE_TOKEN = process.env.CSRF_COOKIE_TOKEN || "default_cookie_token";

// --- 3D STORAGE ---
const tiles3D = {};
const clients3D = new Set();

// --- GITHUB CONFIG ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || ""; 
const LOG_THRESHOLD = 10000;

const FAKE_SYSTEM_USER = 'GlobalRelay';
const CSRF_INPUT_TAG = `<input type="hidden" name="csrfmiddlewaretoken" value="${CSRF_TOKEN}">`;

const tiles = {}; 
const clients = new Set();
let owotBot = null;

// --- LOGGING STATE ---
let chatBuffer = "";
let messageCount = 0;

/**
 * GITHUB UPLOAD LOGIC
 */
function uploadToGithub() {
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
        console.error("GitHub logging failed: Missing Credentials");
        chatBuffer = ""; messageCount = 0;
        return;
    }

    const filename = `logs/chat_${Date.now()}.txt`;
    const base64Content = Buffer.from(chatBuffer).toString('base64');
    const data = JSON.stringify({
        message: `Archiving ${LOG_THRESHOLD} messages`,
        content: base64Content
    });

    const options = {
        hostname: 'api.github.com',
        path: `/repos/${GITHUB_REPO}/contents/${filename}`,
        method: 'PUT',
        headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'User-Agent': 'NodeJS-Relay',
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = https.request(options, (res) => {
        if (res.statusCode === 201) console.log("Log uploaded to GitHub.");
        else console.error(`GitHub Error: ${res.statusCode}`);
    });

    req.on('error', (e) => console.error(`GitHub Req Error: ${e.message}`));
    req.write(data);
    req.end();

    chatBuffer = ""; 
    messageCount = 0;
}

/**
 * FORMATTING LOGIC
 * realUsername: message\n
 * [id]: message\n
 * [*id] nickname: message\n
 */
function logChat(msgData) {
    const { realUsername, nickname, id, message } = msgData;
    let line = "";

    if (realUsername) {
        line = `${realUsername}: ${message}\n`;
    } else if (nickname) {
        line = `[*${id}] ${nickname}: ${message}\n`;
    } else {
        line = `[${id}]: ${message}\n`;
    }

    chatBuffer += line;
    messageCount++;

    if (messageCount >= LOG_THRESHOLD) {
        uploadToGithub();
    }
}

/**
 * TILE LOGIC
 */
function getOrInitTile(tx, ty) {
    const key = `${ty},${tx}`;
    if (tiles[key]) return tiles[key];
    const inArea = (tx >= -2 && tx <= 1 && ty >= -2 && ty <= 1);
    const inHollow = (tx >= -1 && tx <= 0 && ty >= -1 && ty <= 0);
    let writability = (inArea && !inHollow) ? 2 : 0;
    tiles[key] = {
        content: new Array(128).fill(" "),
        properties: {
            writability: writability,
            color: new Array(128).fill(0),
            bgcolor: new Array(128).fill(-1),
            cell_props: {}
        }
    };
    return tiles[key];
}

/**
 * HTTP SERVER
 */
const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        const { pathname } = url.parse(req.url || '/');
        
        if (pathname === '/3d') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            const indexPath = './3d.html';
            if (fs.existsSync(indexPath)) {
                res.end(fs.readFileSync(indexPath));
            } else {
                res.end("<h1>3D version not found</h1>");
            }
            return;
        }
        
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `csrftoken=${CSRF_COOKIE_TOKEN}; Path=/; SameSite=Lax` });
        const indexPath = './index.html';
        if (fs.existsSync(indexPath)) {
            let html = fs.readFileSync(indexPath).toString();
            html = html.includes('<body') ? html.replace(/(<body[^>]*>)/i, `$1\n    ${CSRF_INPUT_TAG}`) : CSRF_INPUT_TAG + html;
            res.end(html);
        } else {
            res.end("<h1>Server Running</h1>");
        }
        return;
    }
    // Handle POST (CSRF check)
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const postData = querystring.parse(body);
            const headerToken = req.headers['x-csrftoken'];
            if (postData.csrfmiddlewaretoken === CSRF_TOKEN || headerToken === CSRF_TOKEN) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: "ok" }));
            } else {
                res.writeHead(403); res.end("Forbidden");
            }
        });
        return;
    }
});

/**
 * WEBSOCKET SERVER
 */
const wss = new WebSocket.Server({ noServer: true });
const wss3D = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    const { pathname } = url.parse(request.url || '/');
    if (pathname === '/owotproxy') {
        wss.handleUpgrade(request, socket, head, (clientWs) => {
            const headers = { 'User-Agent': 'Mozilla/5.0', 'Origin': REMOTE_ORIGIN };
            if (UVIAS_TOKEN) headers['Cookie'] = `uvias=${UVIAS_TOKEN}; csrftoken=${CSRF_COOKIE_TOKEN}`;
            const remoteWs = new WebSocket(REMOTE_OWOT_URL, { headers });
            clientWs.on('message', (data) => { if (remoteWs.readyState === WebSocket.OPEN) remoteWs.send(data); });
            remoteWs.on('message', (data) => { if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data); });
            const closeAll = () => { clientWs.close(); remoteWs.close(); };
            clientWs.on('close', closeAll); remoteWs.on('close', closeAll);
        });
    } else if (pathname === '/3dws') {
        wss3D.handleUpgrade(request, socket, head, (ws) => { wss3D.emit('connection', ws, request); });
    } else {
        wss.handleUpgrade(request, socket, head, (ws) => { wss.emit('connection', ws, request); });
    }
});

function broadcastLocal(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => { 
        if (c !== skipWs && c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch(e) {}
        }
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 90000) + 10000;
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients.size }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        if (data.kind === "chat") {
            // Log local message
            logChat({
                realUsername: data.realUsername, // Undefined for local usually
                nickname: data.nickname,
                id: ws.id,
                message: data.message
            });

            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });
            if (owotBot && owotBot.readyState === WebSocket.OPEN) {
                owotBot.send(JSON.stringify({ kind: "chat", nickname: `[L] ${data.nickname || 'Anon'}`, message: data.message, location: "page" }));
            }
        }
        
        // Handle fetch/write/cursor... (omitted for brevity, keep your original logic)
        if (data.kind === "fetch") {
            const responseTiles = {};
            (data.fetchRectangles || []).forEach(rect => {
                for (let y = rect.minY; y <= rect.maxY; y++) {
                    for (let x = rect.minX; x <= rect.maxX; x++) {
                        responseTiles[`${y},${x}`] = getOrInitTile(x, y);
                    }
                }
            });
            ws.send(JSON.stringify({ kind: "fetch", tiles: responseTiles, request: data.request }));
        }
        if (data.kind === "write") {
            const accepted = [], rejected = {}, tileUpdates = {};
            (data.edits || []).forEach(edit => {
                const [tileY, tileX, charY, charX, time, char, id, color, bgcolor] = edit;
                const tile = getOrInitTile(tileX, tileY);
                if (tile.properties.writability === 2) { rejected[id] = 1; return; }
                const idx = charY * 16 + charX;
                tile.content[idx] = char;
                if (color !== undefined) tile.properties.color[idx] = color;
                if (bgcolor !== undefined) tile.properties.bgcolor[idx] = bgcolor;
                accepted.push(id);
                tileUpdates[`${tileY},${tileX}`] = tile;
            });
            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));
            if (Object.keys(tileUpdates).length > 0) broadcastLocal({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }
        if (data.kind === "cursor") {
            broadcastLocal({ kind: "cursor", channel: ws.id, position: data.position, hidden: data.hidden }, ws);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcastLocal({ kind: "cursor", channel: ws.id, hidden: true });
    });
});

/**
 * 3D WEBSOCKET SERVER
 */
function getOrInit3DTile(tx, ty, tz) {
    const key = `${tz},${ty},${tx}`;
    if (tiles3D[key]) return tiles3D[key];
    const inArea = (tx >= -2 && tx <= 1 && ty >= -2 && ty <= 1 && tz >= 0 && tz <= 3);
    const inHollow = (tx >= -1 && tx <= 0 && ty >= -1 && ty <= 0 && tz >= 1 && tz <= 2);
    let writability = (inArea && !inHollow) ? 2 : 0;
    tiles3D[key] = {
        content: new Array(128).fill(" "),
        dir: new Array(128).fill("x+"),
        properties: {
            writability: writability,
            color: new Array(128).fill(0),
            bgcolor: new Array(128).fill(-1),
            cell_props: {}
        }
    };
    return tiles3D[key];
}

function broadcast3D(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients3D.forEach(c => {
        if (c !== skipWs && c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch(e) {}
        }
    });
}

wss3D.on('connection', (ws) => {
    clients3D.add(ws);
    ws.id = Math.floor(Math.random() * 90000) + 10000;
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients3D.size }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        if (data.kind === "fetch") {
            const responseTiles = {};
            (data.fetchRectangles || []).forEach(rect => {
                for (let z = rect.minZ || 0; z <= (rect.maxZ || 0); z++) {
                    for (let y = rect.minY; y <= rect.maxY; y++) {
                        for (let x = rect.minX; x <= rect.maxX; x++) {
                            responseTiles[`${z},${y},${x}`] = getOrInit3DTile(x, y, z);
                        }
                    }
                }
            });
            ws.send(JSON.stringify({ kind: "fetch", tiles: responseTiles, request: data.request }));
        }
        if (data.kind === "write") {
            const accepted = [], rejected = {}, tileUpdates = {};
            (data.edits || []).forEach(edit => {
                const [tileZ, tileY, tileX, charY, charX, time, char, id, color, bgcolor, dir] = edit;
                const tile = getOrInit3DTile(tileX, tileY, tileZ);
                if (tile.properties.writability === 2) { rejected[id] = 1; return; }
                const idx = charY * 16 + charX;
                tile.content[idx] = char;
                if (color !== undefined) tile.properties.color[idx] = color;
                if (bgcolor !== undefined) tile.properties.bgcolor[idx] = bgcolor;
                if (dir !== undefined) tile.dir[idx] = dir;
                accepted.push(id);
                tileUpdates[`${tileZ},${tileY},${tileX}`] = tile;
            });
            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));
            if (Object.keys(tileUpdates).length > 0) broadcast3D({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }
        if (data.kind === "cursor") {
            broadcast3D({ kind: "cursor", channel: ws.id, position: data.position, hidden: data.hidden }, ws);
        }
    });

    ws.on('close', () => {
        clients3D.delete(ws);
        broadcast3D({ kind: "cursor", channel: ws.id, hidden: true });
    });
});

/**
 * BOT CLIENT
 */
function connectToRemoteOWOT() {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Origin': REMOTE_ORIGIN };
    if (UVIAS_TOKEN) headers['Cookie'] = `uvias=${UVIAS_TOKEN}; csrftoken=${CSRF_COOKIE_TOKEN}`;

    try {
        owotBot = new WebSocket(REMOTE_OWOT_URL, { headers });
        owotBot.on('open', () => {
            owotBot.send(JSON.stringify({ kind: "boundary", centerX: 0, centerY: 0, minX: -5, minY: -5, maxX: 5, maxY: 5 }));
        });

        owotBot.on('message', (message) => {
            let data;
            try { data = JSON.parse(message); } catch(e) { return; }
            if (data.kind === "chat") {
                if (data.nickname && data.nickname.startsWith('[L]')) return;
                
                // Log remote message
                logChat({
                    realUsername: data.real_username, // OWOT API property for registered users
                    nickname: data.nickname,
                    id: data.id || "Remote",
                    message: data.message
                });

                broadcastLocal({
                    kind: "chat", nickname: data.nickname || 'Anon', message: data.message,
                    realUsername: FAKE_SYSTEM_USER, registered: true, op: false, id: 99999,
                    color: data.color || "#00ffff", location: "page", date: Date.now()
                });
            }
            if (data.kind === "ping") owotBot.send(JSON.stringify({ kind: "ping", id: data.id }));
        });

        owotBot.on('close', () => setTimeout(connectToRemoteOWOT, 10000));
    } catch(e) { console.error("Bot Error", e); }
}

server.listen(LOCAL_PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${LOCAL_PORT}`);
    connectToRemoteOWOT();
});

process.on('uncaughtException', (err) => { console.error('CRITICAL ERROR:', err); });
