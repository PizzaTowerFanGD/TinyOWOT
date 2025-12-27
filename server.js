const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

// --- CONFIGURATION ---
const LOCAL_PORT = 8080;
const REMOTE_OWOT_URL = 'wss://www.ourworldoftext.com/ws/?hide=1';
const REMOTE_ORIGIN = 'https://www.ourworldoftext.com';

const tiles = {}; 
const clients = new Set();
let owotBot = null;

/**
 * LOCAL TILE LOGIC
 * Initializes a tile with protection levels based on location.
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
            cell_props: {}
        }
    };
    return tiles[key];
}

/**
 * HELPER: Write text to local tiles
 */
function writeText(startX, startY, startCX, startCY, text) {
    for (let i = 0; i < text.length; i++) {
        let globalCharX = (startX * 16) + startCX + i;
        let globalCharY = (startY * 8) + startCY;

        let tx = Math.floor(globalCharX / 16);
        let ty = Math.floor(globalCharY / 8);
        let cx = globalCharX - (tx * 16);
        let cy = globalCharY - (ty * 8);

        const tile = getOrInitTile(tx, ty);
        let contentArr = tile.content.split('');
        contentArr[cy * 16 + cx] = text[i];
        tile.content = contentArr.join('');
    }
}

// Initial Spawn Area Setup
writeText(-1, -2, 6, 4, "Welcome to TinyOWOT!");
writeText(-1, -1, 7, 4, "Square of Publicity");

/**
 * HTTP SERVER
 * Serves the index.html file to your browser
 */
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    try {
        res.end(fs.readFileSync('index.html'));
    } catch (e) {
        res.end("Error: index.html not found. Please ensure the client code is saved as index.html.");
    }
});

/**
 * LOCAL WEBSOCKET SERVER
 * Handles connections from your browser
 */
const wss = new WebSocket.Server({ server });

function broadcastLocal(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => { 
        if (c !== skipWs && c.readyState === WebSocket.OPEN) c.send(msg); 
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 10000);
    
    // Send initial channel info
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
                const [y, x, charY, charX, time, char, id, color] = edit;
                const tile = getOrInitTile(x, y);

                if (tile.properties.writability === 2) {
                    rejected[id] = 1; 
                    return;
                }

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

        if (data.kind === "chat") {
            // 1. Send to all local clients
            broadcastLocal({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });

            // 2. RELAY TO REAL OWOT: The bot repeats what local users say
            if (owotBot && owotBot.readyState === WebSocket.OPEN) {
                owotBot.send(JSON.stringify({
                    kind: "chat",
                    nickname: `[Local] ${data.nickname || 'Anon'}`,
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
 * REMOTE BOT LOGIC
 * Connects to the official OurWorldOfText as a client
 */
function connectToRemoteOWOT() {
    console.log(`[Bot] Attempting to connect to ${REMOTE_OWOT_URL}...`);

    // The Origin header is required by official OWOT to prevent unauthorized bots
    owotBot = new WebSocket(REMOTE_OWOT_URL, {
        origin: REMOTE_ORIGIN,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
        }
    });

    owotBot.on('open', () => {
        console.log("[Bot] Connected to official OurWorldOfText!");
        
        // Let people on the real site know the bot is there
        owotBot.send(JSON.stringify({
            kind: "chat",
            nickname: "TinyServerBot",
            message: "TinyOWOT relay active.",
            location: "page"
        }));

        // Send a boundary so the official server sends us live updates for the center area
        owotBot.send(JSON.stringify({
            kind: "boundary",
            centerX: 0, centerY: 0,
            minX: -10, minY: -10, maxX: 10, maxY: 10
        }));
    });

    owotBot.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        // RELAY FROM REAL OWOT TO LOCAL:
        // When someone chats on the real main page, display it in the local server
        if (data.kind === "chat") {
            broadcastLocal({
                kind: "chat",
                nickname: `[Global] ${data.nickname || 'Anon'}`,
                message: data.message,
                id: 8888, // Custom ID for remote users
                color: "#ff0000",
                location: "page",
                date: Date.now()
            });
        }
        
        // Keep-alive/Ping handling
        if (data.kind === "ping") {
            owotBot.send(JSON.stringify({ kind: "ping", id: data.id }));
        }
    });

    owotBot.on('close', () => {
        console.log("[Bot] Connection to remote OWOT lost. Reconnecting in 10s...");
        setTimeout(connectToRemoteOWOT, 10000);
    });

    owotBot.on('error', (err) => {
        console.error("[Bot] WebSocket Error:", err.message);
    });
}

// Start the bot connection
connectToRemoteOWOT();

// Start the local server
server.listen(LOCAL_PORT, () => {
    console.log(`TinyOWOT Server running at http://localhost:${LOCAL_PORT}`);
});
