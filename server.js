const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const querystring = require('querystring');

// --- CONFIGURATION ---
const LOCAL_PORT = 8080;
const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

// 1. Environment Variable Extraction
const UVIAS_TOKEN = process.env.UVIAS_TOKEN;
const CSRF_TOKEN = process.env.CSRF_TOKEN; // Used for middleware <input> and POST validation
const CSRF_COOKIE_TOKEN = process.env.CSRF_COOKIE_TOKEN; // Used for the "csrftoken" cookie string

// Fake system identity for the local server
const FAKE_SYSTEM_USER = 'GlobalRelay';

// Security check for missing environment variables
if (!UVIAS_TOKEN || !CSRF_TOKEN || !CSRF_COOKIE_TOKEN) {
    console.error("ERROR: Missing Environment Variables!");
    console.error("Required: UVIAS_TOKEN, CSRF_TOKEN, CSRF_COOKIE_TOKEN");
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
    let writability = (inArea && !inHollow) ? 2 : 0;
    tiles[key] = {
        content: " ".repeat(128),
        properties: { writability, color: new Array(128).fill(0), cell_props: {} }
    };
    return tiles[key];
}

/**
 * WEB SERVER (Middleware Layer)
 */
const server = http.createServer((req, res) => {
    
    // GET Handler: Sets Cookie + Injects Input Tag
    if (req.method === 'GET') {
        res.writeHead(200, { 
            'Content-Type': 'text/html',
            'Set-Cookie': `csrftoken=${CSRF_COOKIE_TOKEN}; Path=/; SameSite=Lax` 
        });
        try {
            let html = fs.readFileSync('index.html').toString();
            // Inject the hidden middleware token input
            html = html.replace('<body>', `<body>\n    ${CSRF_INPUT_TAG}`);
            res.end(html);
        } catch (e) {
            res.end("index.html is missing.");
        }
        return;
    }

    // POST Handler: Validates against CSRF_TOKEN
    if (req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            const postData = querystring.parse(body);
            const headerToken = req.headers['x-csrftoken'];

            // Validation against the Middleware Token
            if (postData.csrfmiddlewaretoken === CSRF_TOKEN || headerToken === CSRF_TOKEN) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: "ok" }));
            } else {
                console.warn(`[Security] Forbidden POST: Token Mismatch`);
                res.writeHead(403);
                res.end("CSRF Validation Failed.");
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

        if (data.kind === "chat") {
            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });

            // Relay to real OWOT (posts as your account)
            if (owotBot && owotBot.readyState === WebSocket.OPEN) {
                owotBot.send(JSON.stringify({
                    kind: "chat",
                    nickname: `[L] ${data.nickname || 'Anon'}`, 
                    message: data.message,
                    location: "page"
                }));
            }
        }
    });

    ws.on('close', () => clients.delete(ws));
});

/**
 * BOT CLIENT (Official OWOT side)
 */
function connectToRemoteOWOT() {
    console.log(`[Bot] Connecting...`);

    owotBot = new WebSocket(REMOTE_OWOT_URL, {
        origin: REMOTE_ORIGIN,
        headers: { 
            'User-Agent': 'Mozilla/5.0',
            // Authenticate using the env tokens
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
            // Loop prevention
            if (data.nickname && data.nickname.startsWith('[L]')) return;

            broadcastLocal({
                kind: "chat",
                nickname: data.nickname || 'Anon',
                message: data.message,
                realUsername: FAKE_SYSTEM_USER, 
                registered: true,
                op: false,
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

    owotBot.on('close', () => {
        console.log("[Bot] Reconnecting in 10s...");
        setTimeout(connectToRemoteOWOT, 10000);
    });
}

connectToRemoteOWOT();
server.listen(LOCAL_PORT, () => {
    console.log(`TinyOWOT Running: http://localhost:${LOCAL_PORT}`);
    console.log(`Middleware Token: ${CSRF_TOKEN.substring(0, 5)}...`);
    console.log(`Cookie Token: ${CSRF_COOKIE_TOKEN.substring(0, 5)}...`);
})
