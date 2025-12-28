const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const querystring = require('querystring');

// --- CONFIGURATION ---
const LOCAL_PORT = 8080;
const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

// 1. Environment Variables
const UVIAS_TOKEN = process.env.UVIAS_TOKEN;
const CSRF_TOKEN = process.env.CSRF_TOKEN;             // Middleware validation token
const CSRF_COOKIE_TOKEN = process.env.CSRF_COOKIE_TOKEN; // Browser cookie value

const FAKE_SYSTEM_USER = 'GlobalRelay';

if (!UVIAS_TOKEN || !CSRF_TOKEN || !CSRF_COOKIE_TOKEN) {
    console.error("ERROR: Missing Environment Variables (UVIAS_TOKEN, CSRF_TOKEN, CSRF_COOKIE_TOKEN)");
    process.exit(1);
}

const CSRF_INPUT_TAG = `<input type="hidden" name="csrfmiddlewaretoken" value="${CSRF_TOKEN}">`;

const tiles = {}; 
const clients = new Set();
let owotBot = null;

/**
 * TILE SYSTEM
 */
function getOrInitTile(tx, ty) {
    const key = `${ty},${tx}`;
    if (tiles[key]) return tiles[key];

    const inArea = (tx >= -2 && tx <= 1 && ty >= -2 && ty <= 1);
    const inHollow = (tx >= -1 && tx <= 0 && ty >= -1 && ty <= 0);

    // 2 = Owner-only (Gray), 0 = Public (White)
    let writability = (inArea && !inHollow) ? 2 : 0;

    tiles[key] = {
        content: " ".repeat(128),
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
 * WEB SERVER (CSRF Middleware)
 */
const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 
            'Content-Type': 'text/html',
            'Set-Cookie': `csrftoken=${CSRF_COOKIE_TOKEN}; Path=/; SameSite=Lax` 
        });
        try {
            let html = fs.readFileSync('index.html').toString();
            html = html.replace('<body>', `<body>\n    ${CSRF_INPUT_TAG}`);
            res.end(html);
        } catch (e) { res.end("index.html missing."); }
        return;
    }

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
                res.writeHead(403);
                res.end("CSRF Fail");
            }
        });
        return;
    }
});

/**
 * LOCAL WEBSOCKET SERVER
 */
const wss = new WebSocket.Server({ server });

function broadcastLocal(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => { if (c !== skipWs && c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 10000);
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients.size }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        // --- FETCH TILES ---
        if (data.kind === "fetch") {
            const responseTiles = {};
            data.fetchRectangles.forEach(rect => {
                for (let y = rect.minY; y <= rect.maxY; y++) {
                    for (let x = rect.minX; x <= rect.maxX; x++) {
                        responseTiles[`${y},${x}`] = getOrInitTile(x, y);
                    }
                }
            });
            ws.send(JSON.stringify({ kind: "fetch", tiles: responseTiles, request: data.request }));
        }

        // --- WRITING SYSTEM (Keystrokes) ---
        if (data.kind === "write") {
            const accepted = [];
            const rejected = {};
            const tileUpdates = {};

            data.edits.forEach(edit => {
                // Edit format: [tileY, tileX, charY, charX, time, char, id, color, bgcolor]
                const [tileY, tileX, charY, charX, timestamp, char, editId, color, bgcolor] = edit;
                const tile = getOrInitTile(tileX, tileY);

                // Check Permissions (writability 2 = Owner Only)
                if (tile.properties.writability === 2) {
                    rejected[editId] = 1; // 1 = No permission
                    return;
                }

                // Update Character Content
                const charIndex = charY * 16 + charX;
                let contentArr = tile.content.split('');
                contentArr[charIndex] = char;
                tile.content = contentArr.join('');

                // Update Colors
                if (color !== undefined) tile.properties.color[charIndex] = color;
                if (bgcolor !== undefined) tile.properties.bgcolor[charIndex] = bgcolor;

                accepted.push(editId);
                tileUpdates[`${tileY},${tileX}`] = tile;
            });

            // 1. Confirm to the user who wrote it
            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));

            // 2. Broadcast the change to everyone else so it shows up live
            if (Object.keys(tileUpdates).length > 0) {
                broadcastLocal({ kind: "tileUpdate", tiles: tileUpdates }, ws);
            }
        }

        // --- CHAT SYSTEM ---
        if (data.kind === "chat") {
            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });

            if (owotBot && owotBot.readyState === WebSocket.OPEN) {
                owotBot.send(JSON.stringify({
                    kind: "chat",
                    nickname: `[L] ${data.nickname || 'Anon'}`, 
                    message: data.message,
                    location: "page"
                }));
            }
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
 * BOT CLIENT (Official OWOT side)
 */
function connectToRemoteOWOT() {
    console.log(`[Bot] Connecting to Official OWOT...`);

    owotBot = new WebSocket(REMOTE_OWOT_URL, {
        origin: REMOTE_ORIGIN,
        headers: { 
            'User-Agent': 'Mozilla/5.0',
            'Cookie': `uvias=${UVIAS_TOKEN}; csrftoken=${CSRF_COOKIE_TOKEN}`
        }
    });

    owotBot.on('open', () => {
        console.log("[Bot] Authenticated and Connected!");
        owotBot.send(JSON.stringify({ kind: "boundary", centerX: 0, centerY: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 }));
    });

    owotBot.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        if (data.kind === "chat") {
            if (data.nickname && data.nickname.startsWith('[L]')) return;
            broadcastLocal({
                kind: "chat",
                nickname: data.nickname || 'Anon',
                message: data.message,
                realUsername: FAKE_SYSTEM_USER, 
                registered: true,
                op: true,
                id: 8888,
                color: data.color || "#00ffff",
                location: "page",
                date: Date.now()
            });
        }
        
        if (data.kind === "ping") {
            owotBot.send(JSON.stringify({ kind: "ping", id: data.id }));
        }
    });

    owotBot.on('close', () => setTimeout(connectToRemoteOWOT, 10000));
}

connectToRemoteOWOT();
server.listen(LOCAL_PORT, () => console.log(`TinyOWOT running at http://localhost:${LOCAL_PORT}`));
