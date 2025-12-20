const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const tiles = {}; 
const clients = new Set();

// CONFIGURATION: 4x4 Tiles centered around origin
const AREA = { minX: -2, minY: -2, maxX: 1, maxY: 1 };
const HOLLOW = { minX: -1, minY: -1, maxX: 0, maxY: 0 };

// Helper to write text into the memory on startup
function serverWrite(tileX, tileY, charX, charY, text) {
    const key = `${tileY},${tileX}`;
    if (!tiles[key]) tiles[key] = { 
        content: " ".repeat(128), 
        properties: { color: new Array(128).fill(0), cell_props: {} } 
    };
    
    let content = tiles[key].content.split('');
    for (let i = 0; i < text.length; i++) {
        let cx = charX + i;
        let cy = charY;
        if (cx < 16) {
            content[cy * 16 + cx] = text[i];
        }
    }
    tiles[key].content = content.join('');
}

// Pre-seed the world with your text
// "Welcome to TinyOWOT!" on the top protected row
serverWrite(-1, -2, 4, 2, "Welcome to TinyOWOT!");
// "Square of Publicity" inside the hollow area
serverWrite(-1, -1, 4, 1, "Square of Publicity");

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync('index.html'));
});

const wss = new WebSocket.Server({ server });

function broadcast(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(client => {
        if (client !== skipWs && client.readyState === WebSocket.OPEN) client.send(msg);
    });
}

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 10000);
    ws.send(JSON.stringify({ kind: "channel", sender: ws.id, initial_user_count: clients.size }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);

        // FETCHING
        if (data.kind === "fetch") {
            const responseTiles = {};
            data.fetchRectangles.forEach(rect => {
                for (let y = rect.minY; y <= rect.maxY; y++) {
                    for (let x = rect.minX; x <= rect.maxX; x++) {
                        const key = `${y},${x}`;
                        responseTiles[key] = tiles[key] || null;
                    }
                }
            });
            ws.send(JSON.stringify({ kind: "fetch", tiles: responseTiles, request: data.request }));
        }

        // WRITING + HOLLOW PROTECTION LOGIC
        if (data.kind === "write") {
            const accepted = [], rejected = {}, tileUpdates = {};

            data.edits.forEach(edit => {
                const [y, x, charY, charX, time, char, id, color] = edit;
                
                // HOLLOW LOGIC:
                // Is it in the big square?
                const inArea = (x >= AREA.minX && x <= AREA.maxX && y >= AREA.minY && y <= AREA.maxY);
                // Is it in the hollow center?
                const inHollow = (x >= HOLLOW.minX && x <= HOLLOW.maxX && y >= HOLLOW.minY && y <= HOLLOW.maxY);

                // If it's in the area but NOT the hollow center, it's protected
                if (inArea && !inHollow) {
                    rejected[id] = 1; 
                    return;
                }

                const key = `${y},${x}`;
                if (!tiles[key]) tiles[key] = { content: " ".repeat(128), properties: { color: new Array(128).fill(0), cell_props: {} } };

                let content = tiles[key].content.split('');
                content[charY * 16 + charX] = char;
                tiles[key].content = content.join('');
                if (color !== undefined) tiles[key].properties.color[charY * 16 + charX] = color;
                
                accepted.push(id);
                tileUpdates[key] = tiles[key];
            });

            ws.send(JSON.stringify({ kind: "write", accepted, rejected, request: data.request }));
            if (Object.keys(tileUpdates).length > 0) broadcast({ kind: "tileUpdate", tiles: tileUpdates }, ws);
        }

        // CHAT
        if (data.kind === "chat") {
            broadcast({
                kind: "chat", nickname: data.nickname || "Guest", message: data.message,
                id: ws.id, color: data.color || "#000", location: data.location, date: Date.now()
            });
        }

        // LINKS
        if (data.kind === "link") {
            const { tileX, tileY, charX, charY, url, link_tileX, link_tileY } = data.data;
            const key = `${tileY},${tileX}`;
            if (!tiles[key]) tiles[key] = { content: " ".repeat(128), properties: { color: new Array(128).fill(0), cell_props: {} } };
            if (!tiles[key].properties.cell_props) tiles[key].properties.cell_props = {};
            if (!tiles[key].properties.cell_props[charY]) tiles[key].properties.cell_props[charY] = {};

            tiles[key].properties.cell_props[charY][charX] = {
                link: data.type === "url" ? { type: "url", url } : { type: "coord", link_tileX, link_tileY }
            };
            broadcast({ kind: "tileUpdate", tiles: { [key]: tiles[key] } });
        }

        // CURSOR
        if (data.kind === "cursor") {
            broadcast({ kind: "cursor", channel: ws.id, position: data.position, hidden: data.hidden }, ws);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcast({ kind: "cursor", channel: ws.id, hidden: true });
    });
});

server.listen(8080, () => console.log('Server running: http://localhost:8080'));
