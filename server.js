const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

// In-memory storage for tiles: "y,x": { content: "...", properties: {} }
const tiles = {};
const clients = new Set();

// 1. Minimal HTTP Server to serve your client code
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync('index.html'));
});

// 2. WebSocket Server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    clients.add(ws);
    
    // Send initial channel info
    ws.send(JSON.stringify({
        kind: "channel",
        sender: "user_" + Math.random().toString(16).slice(2, 6),
        initial_user_count: clients.size
    }));

    ws.on('message', (message) => {
        const data = JSON.parse(message);

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

        if (data.kind === "write") {
            const accepted = [];
            const tileUpdates = {};
            
            data.edits.forEach(edit => {
                const [y, x, charY, charX, time, char, id, color] = edit;
                const key = `${y},${x}`;
                
                if (!tiles[key]) {
                    tiles[key] = { content: " ".repeat(128), properties: { color: new Array(128).fill(0) } };
                }
                
                // Update content
                let content = tiles[key].content.split('');
                content[charY * 16 + charX] = char;
                tiles[key].content = content.join('');
                
                // Update color
                if (color !== undefined) tiles[key].properties.color[charY * 16 + charX] = color;
                
                accepted.push(id);
                if (!tileUpdates[key]) tileUpdates[key] = tiles[key];
            });

            ws.send(JSON.stringify({ kind: "write", accepted, rejected: {}, request: data.request }));
            
            // Broadcast the update to everyone else
            const updateMsg = JSON.stringify({ kind: "tileUpdate", tiles: tileUpdates });
            clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) client.send(updateMsg);
            });
        }

        if (data.kind === "cursor") {
            // Broadcast cursor movements
            const cursorMsg = JSON.stringify({ kind: "cursor", channel: ws.id, position: data.position, hidden: data.hidden });
            clients.forEach(client => {
                if (client !== ws && client.readyState === WebSocket.OPEN) client.send(cursorMsg);
            });
        }
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(8080, () => console.log('OWOT Server running on http://localhost:8080'));
