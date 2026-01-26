const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');

const PORT = process.env.PORT3D || 8081;

const tiles = {};
const clients = new Set();

function getTileKey(x, y, z) {
    return `${x},${y},${z}`;
}

function initTile(x, y, z) {
    const key = getTileKey(x, y, z);
    const tile = {
        content: new Array(128).fill(" "),
        directions: new Array(128).fill("x+"),
        properties: {
            color: new Array(128).fill(0),
            bgcolor: new Array(128).fill(-1)
        }
    };
    tiles[key] = tile;
    return tile;
}

function getOrInitTile(x, y, z) {
    const key = getTileKey(x, y, z);
    return tiles[key] || initTile(x, y, z);
}

function broadcast(data, skipWs = null) {
    const msg = JSON.stringify(data);
    clients.forEach(c => {
        if (c !== skipWs && c.readyState === WebSocket.OPEN) {
            try { c.send(msg); } catch(e) {}
        }
    });
}

const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/') {
        fs.readFile('./3dindex.html', (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            res.writeHead(200, {'Content-Type': 'text/html'});
            res.end(data);
        });
    } else {
        res.writeHead(404);
        res.end('not found');
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    clients.add(ws);
    ws.id = Math.floor(Math.random() * 90000) + 10000;
    ws.send(JSON.stringify({ kind: "init", id: ws.id }));

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch(e) { return; }

        if (data.kind === "fetch") {
            const response = {};
            (data.regions || []).forEach(region => {
                for (let x = region.xMin; x <= region.xMax; x++) {
                    for (let y = region.yMin; y <= region.yMax; y++) {
                        for (let z = region.zMin; z <= region.zMax; z++) {
                            const key = getTileKey(x, y, z);
                            if (!tiles[key]) initTile(x, y, z);
                            response[key] = tiles[key];
                        }
                    }
                }
            });
            ws.send(JSON.stringify({ kind: "fetch", tiles: response }));
        }

        if (data.kind === "write") {
            const updates = {};
            (data.edits || []).forEach(edit => {
                const [x, y, z, charIndex, char, direction, color, bgcolor] = edit;
                const tile = getOrInitTile(x, y, z);
                tile.content[charIndex] = char || " ";
                tile.directions[charIndex] = direction || "x+";
                if (color !== undefined) tile.properties.color[charIndex] = color;
                if (bgcolor !== undefined) tile.properties.bgcolor[charIndex] = bgcolor;
                updates[getTileKey(x, y, z)] = tile;
            });
            ws.send(JSON.stringify({ kind: "write", status: "ok" }));
            broadcast({ kind: "tileUpdate", updates }, ws);
        }

        if (data.kind === "cursor") {
            broadcast({ kind: "cursor", id: ws.id, position: data.position, hidden: data.hidden }, ws);
        }

        if (data.kind === "chat") {
            broadcast({ kind: "chat", id: ws.id, message: data.message, nickname: data.nickname }, ws);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        broadcast({ kind: "cursor", id: ws.id, hidden: true });
    });
});

server.listen(PORT, () => {
    console.log(`3d server listening on port ${PORT}`);
});
