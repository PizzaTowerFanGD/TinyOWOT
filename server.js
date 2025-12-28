const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const querystring = require('querystring');

// --- CONFIGURATION ---
// FIX: Use Render's assigned port, fallback to 8080 for local testing
const LOCAL_PORT = process.env.PORT || 8080; 

const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

// 1. Load Credentials Safely
const UVIAS_TOKEN = process.env.UVIAS_TOKEN || "";
const CSRF_TOKEN = process.env.CSRF_TOKEN || "default_middleware_token"; 
const CSRF_COOKIE_TOKEN = process.env.CSRF_COOKIE_TOKEN || "default_cookie_token";

const FAKE_SYSTEM_USER = 'GlobalRelay';
const CSRF_INPUT_TAG = `<input type="hidden" name="csrfmiddlewaretoken" value="${CSRF_TOKEN}">`;

const tiles = {}; 
const clients = new Set();
let owotBot = null;

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
 * HTTP SERVER
 */
const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
        res.writeHead(200, { 
            'Content-Type': 'text/html',
            'Set-Cookie': `csrftoken=${CSRF_COOKIE_TOKEN}; Path=/; SameSite=Lax` 
        });
        
        try {
            let html = fs.readFileSync('index.html').toString();
            if (html.includes('<body')) {
                html = html.replace(/(<body[^>]*>)/i, `$1\n    ${CSRF_INPUT_TAG}`);
            } else {
                html = CSRF_INPUT_TAG + html;
            }
            res.end(html);
        } catch (e) {
            res.end("Error: index.html not found. Ensure it is in the same folder as server.js");
        }
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
                res.end("Forbidden: CSRF Invalid");
            }
        });
        return;
    }
});

/**
 * WEBSOCKET SERVER
 */
const wss = new WebSocket.Server({ server });

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

        if (data.kind === "write") {
            const accepted = [], rejected = {}, tileUpdates = {};
            data.edits.forEach(edit => {
                const [tileY, tileX, charY, charX, time, char, id, color, bgcolor] = edit;
                const tile = getOrInitTile(tileX, tileY);
                if (tile.properties.writability === 2) { rejected[id] = 1; return; }
                const idx = charY * 16 + charX;
                let contentArr = tile.content.split('');
                contentArr[idx] = char;
                tile.content = contentArr.join('');
                if (color !== undefined) tile.properties.color[idx] = color;
                if (bgcolor !== undefined) tile.properties.bgcolor[idx] = bgcolor;
                accepted.push(id);
                tileUpdates[`${tileY},${tileX}`] = tile;
            });
            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));
            if (Object.keys(tileUpdates).length > 0) broadcastLocal({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }

        if (data.kind === "chat") {
            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });
            if (owotBot && owotBot.readyState === WebSocket.OPEN) {
                owotBot.send(JSON.stringify({
                    kind: "chat", nickname: `[L] ${data.nickname || 'Anon'}`, message: data.message, location: "page"
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
 * BOT CLIENT
 */
function connectToRemoteOWOT() {
    const headers = { 'User-Agent': 'Mozilla/5.0', 'Origin': REMOTE_ORIGIN };
    if (UVIAS_TOKEN) headers['Cookie'] = `uvias=${UVIAS_TOKEN}; csrftoken=${CSRF_COOKIE_TOKEN}`;

    owotBot = new WebSocket(REMOTE_OWOT_URL, { headers });

    owotBot.on('open', () => {
        console.log("[Bot] Connected to OWOT");
        owotBot.send(JSON.stringify({ kind: "boundary", centerX: 0, centerY: 0, minX: -5, minY: -5, maxX: 5, maxY: 5 }));
    });

    owotBot.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }
        if (data.kind === "chat") {
            if (data.nickname && data.nickname.startsWith('[L]')) return;
            broadcastLocal({
                kind: "chat", nickname: data.nickname || 'Anon', message: data.message,
                realUsername: FAKE_SYSTEM_USER, registered: true, op: true, id: 8888,
                color: data.color || "#00ffff", location: "page", date: Date.now()
            });
        }
        if (data.kind === "ping") owotBot.send(JSON.stringify({ kind: "ping", id: data.id }));
    });

    owotBot.on('close', () => setTimeout(connectToRemoteOWOT, 10000));
}

// Ensure the server listens on 0.0.0.0 so Render can see it
server.listen(LOCAL_PORT, "0.0.0.0", () => {
    console.log(`Server listening on port ${LOCAL_PORT}`);
});

connectToRemoteOWOT();

process.on('uncaughtException', (err) => { console.error('Error:', err); });
