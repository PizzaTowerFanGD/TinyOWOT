const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

// --- CONFIGURATION ---
const LOCAL_PORT = 8080;
const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

// Loads token from environment (e.g., UVIAS_TOKEN="..." node server.js)
const UVIASTOKEN = process.env.UVIAS_TOKEN; 

// The identity shown ONLY on your local server for relayed messages
const FAKE_SYSTEM_USER = 'GlobalRelay'; 

if (!UVIASTOKEN) {
    console.error("====================================================");
    console.error("ERROR: UVIAS_TOKEN environment variable is not set!");
    console.error("Please run the server with your token like this:");
    console.error('UVIAS_TOKEN="your_token_here" node server.js');
    console.error("====================================================");
    process.exit(1);
}

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

function writeText(startX, startY, startCX, startCY, text) {
    for (let i = 0; i < text.length; i++) {
        let gx = (startX * 16) + startCX + i;
        let gy = (startY * 8) + startCY;
        let tx = Math.floor(gx / 16);
        let ty = Math.floor(gy / 8);
        let cx = gx - (tx * 16);
        let cy = gy - (ty * 8);
        const tile = getOrInitTile(tx, ty);
        let contentArr = tile.content.split('');
        contentArr[cy * 16 + cx] = text[i];
        tile.content = contentArr.join('');
    }
}

writeText(-1, -2, 6, 4, "Welcome to TinyOWOT!");
writeText(-1, -1, 7, 4, "Square of Publicity");

/**
 * LOCAL WEB SERVER
 */
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    try { res.end(fs.readFileSync('index.html')); } catch (e) { res.end("Missing index.html"); }
});

const wss = new WebSocket.Server({ server });

function broadcastLocal(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => { if (c !== skipWs && c.readyState === WebSocket.OPEN) c.send(msg); });
}

/**
 * LOCAL WSS HANDLER
 */
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 10000);
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients.size }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        // Handle Tile Requests
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

        // Handle Writing
        if (data.kind === "write") {
            const accepted = [], rejected = {}, tileUpdates = {};
            data.edits.forEach(edit => {
                const [y, x, charY, charX, time, char, id, color] = edit;
                const tile = getOrInitTile(x, y);
                if (tile.properties.writability === 2) { rejected[id] = 1; return; }
                let contentArr = tile.content.split('');
                contentArr[charY * 16 + charX] = char;
                tile.content = contentArr.join('');
                if (color !== undefined) tile.properties.color[charY * 16 + charX] = color;
                accepted.push(id);
                tileUpdates[`${y},${x}`] = tile;
            });
            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));
            if (Object.keys(tileUpdates).length > 0) broadcastLocal({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }

        // Handle Chat
        if (data.kind === "chat") {
            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });

            // RELAY TO OFFICIAL OWOT (with loop prevention prefix [L])
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
 * REMOTE BOT CLIENT (OWOT SIDE)
 */
function connectToRemoteOWOT() {
    console.log(`[Bot] Authenticating with remote server...`);

    owotBot = new WebSocket(REMOTE_OWOT_URL, {
        origin: REMOTE_ORIGIN,
        headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Cookie': `uvias=${UVIASTOKEN}`
        }
    });

    owotBot.on('open', () => {
        console.log("[Bot] Logged in and Connected to OurWorldOfText!");
        // Set boundary to receive center updates
        owotBot.send(JSON.stringify({ kind: "boundary", centerX: 0, centerY: 0, minX: -10, minY: -10, maxX: 10, maxY: 10 }));
    });

    owotBot.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        if (data.kind === "chat") {
            // LOOP PREVENTION: Ignore if message starts with our prefix
            if (data.nickname && data.nickname.startsWith('[L]')) return;

            // RELAY TO TINYOWOT (The local side)
            broadcastLocal({
                kind: "chat",
                nickname: data.nickname || 'Anon',
                message: data.message,
                // These metadata fields fake the identity in your provided client code
                realUsername: FAKE_SYSTEM_USER, 
                registered: true,
                op: true, // Gives it the blue (OP) tag
                id: 8888, // Constant ID for global users
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

    owotBot.on('error', (err) => console.error("[Bot] Error:", err.message));
}

// Start everything
connectToRemoteOWOT();
server.listen(LOCAL_PORT, () => console.log(`TinyOWOT local server: http://localhost:${LOCAL_PORT}`));
