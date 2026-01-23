const https = require('https');

const API_KEY = 'wd-9XAJoEnMc8NWQXwT3Z';
const URL = `https://eth-mainnet.g.alchemy.com/v2/${API_KEY}`;
const CONTRACT = '0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50'; // cUSDT Proxy

const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "alchemy_getOwnersForToken",
    params: [CONTRACT]
});

const options = {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length
    }
};

const req = https.request(URL, options, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const json = JSON.parse(data);
            if (json.error) {
                console.error('Error:', json.error);
            } else {
                const owners = json.result.owners;
                console.log(`Total Owners: ${owners.length}`);
                if (owners.length < 20) console.log(owners);
            }
        } catch (e) {
            console.error('Parse Error:', e);
        }
    });
});

req.on('error', (e) => {
    console.error('Request Error:', e);
});

req.write(payload);
req.end();
