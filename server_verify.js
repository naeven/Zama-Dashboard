const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;

const mockData = {
    rows: Array.from({ length: 30 }, (_, i) => ({
        bidder_address: `0x${(i + 1).toString(16).padStart(40, '0')}`,
        bid_count: i % 3 === 0 ? 0 : Math.floor(Math.random() * 10) + 1,
        total_wrapped: (Math.random() * 10000).toString(),
        total_unwrapped: (Math.random() * 5000).toString(),
        latest_bid_fdv: Math.random() * 2,
        avg_bid_fdv: Math.random() * 2,
        last_bid_time: new Date().toISOString().replace('T', ' ').replace('Z', ' UTC')
    })),
    cached_at: Date.now(),
    next_refresh_seconds: 1800,
    source: 'mock_server'
};

const server = http.createServer((req, res) => {
    // console.log(`${req.method} ${req.url}`);

    if (req.url === '/api/dune') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(mockData));
        return;
    }

    if (req.method === 'POST') {
        // Mock RPC calls
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            const json = JSON.parse(body);
            let response;

            if (Array.isArray(json)) {
                // Batch request (NFTs)
                response = json.map(req => ({
                    jsonrpc: '2.0',
                    id: req.id,
                    result: Math.random() > 0.5 ? '0x1' : '0x0' // Randomly own NFT or not
                }));
            } else {
                // Single request
                response = {
                    jsonrpc: '2.0',
                    id: json.id,
                    result: '0x0' // Default
                };
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
        });
        return;
    }

    let filePath = '.' + req.url;
    if (filePath === './') filePath = './index.html';

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
        case '.js': contentType = 'text/javascript'; break;
        case '.css': contentType = 'text/css'; break;
        case '.json': contentType = 'application/json'; break;
        case '.png': contentType = 'image/png'; break;
        case '.jpg': contentType = 'image/jpg'; break;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`Verification server running at http://localhost:${PORT}`);
    console.log('Press Ctrl+C to stop');
});
