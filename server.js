const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const tiles = {}; 
const clients = new Set();

/**
 * Initializes a tile with the correct protection level based on its location.
 * Ring: (-2, -2) to (1, 1) is protected (Gray).
 * Square of Publicity (Hollow): (-1, -1) to (0, 0) is public (White).
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
 * Writes text across tile boundaries. 
 * Automatically calculates which tile each character belongs to.
 */
function writeText(startX, startY, startCX, startCY, text) {
    for (let i = 0; i < text.length; i++) {
        // Calculate global character positions
        let globalCharX = (startX * 16) + startCX + i;
        let globalCharY = (startY * 8) + startCY;

        // Convert back to Tile + Local Char coordinates
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

// 1. WELCOME TEXT (On the top protected wall)
writeText(-1, -2, 6, 4, "Welcome to TinyOWOT!");

// 2. PUBLIC SQUARE TEXT (Inside the hollow area)
writeText(-1, -1, 7, 4, "Square of Publicity");

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync('index.html'));
});

const wss = new WebSocket.Server({ server });

function broadcast(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => { if (c !== skipWs && c.readyState === WebSocket.OPEN) c.send(msg); });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 10000);
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients.size }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);

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

                // Reject if tile is Owner-Only (writability 2)
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
            if (Object.keys(tileUpdates).length > 0) broadcast({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }

        if (data.kind === "chat") {
            broadcast({
                kind: "chat", nickname: data.nickname, message: data.message,
                id: ws.id, color: data.color, location: data.location, date: Date.now()
            });
        }

        if (data.kind === "link") {
            const { tileX, tileY, charX, charY, url, link_tileX, link_tileY } = data.data;
            const tile = getOrInitTile(tileX, tileY);
            if (!tile.properties.cell_props[charY]) tile.properties.cell_props[charY] = {};
            tile.properties.cell_props[charY][charX] = {
                link: data.type === "url" ? { type: "url", url } : { type: "coord", link_tileX, link_tileY }
            };
            broadcast({ kind: "tileUpdate", tiles: { [`${tileY},${tileX}`]: tile } });
        }

        if (data.kind === "cursor") {
            broadcast({ kind: "cursor", channel: ws.id, position: data.position, hidden: data.hidden }, ws);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcast({ kind: "cursor", channel: ws.id, hidden: true });
    });
});

server.listen(8080, () => console.log('Server running on http://localhost:8080'));
