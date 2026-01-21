import { Redis } from '@upstash/redis';

// Initialize Redis client from auto-injected env vars
const redis = Redis.fromEnv();

export default async function handler(req, res) {
    const DUNE_API_KEY = process.env.DUNE_API_KEY;
    if (!DUNE_API_KEY) return res.status(500).json({ error: 'Server key missing' });

    const { endpoint } = req.query;
    if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });

    // --- REDIS CACHING LOGIC ---
    // Key for storing the latest result object
    const CACHE_KEY = `dune:result:${endpoint}`;

    // 1. GET Request: Check Redis First
    if (req.method === 'GET' && endpoint.endsWith('/results')) {
        try {
            const cached = await redis.get(CACHE_KEY);

            if (cached && cached.execution_ended_at) {
                const ageSeconds = (Date.now() - new Date(cached.execution_ended_at).getTime()) / 1000;

                // STRICT RULE: If data is less than 35 mins old (2100s), RETURN IT.
                // Do not allow any new execution or fetch.
                if (ageSeconds < 2100) {
                    // console.log('Serving from Redis Cache (Free)');
                    return res.status(200).json({ result: { rows: cached.rows }, execution_ended_at: cached.execution_ended_at });
                }
            }
        } catch (e) {
            console.error('Redis Read Error:', e);
            // Fallthrough to Dune if Redis fails
        }
    }
    // ---------------------------

    const targetUrl = `https://api.dune.com/api/v1/${endpoint}`;

    // SPECIAL: GET /execute -> POST upstream (Thundering Herd Protection)
    let upstreamMethod = req.method;
    if (req.method === 'GET' && endpoint.endsWith('/execute')) {
        upstreamMethod = 'POST';
    }

    try {
        const response = await fetch(targetUrl, {
            method: upstreamMethod,
            headers: {
                'X-Dune-Api-Key': DUNE_API_KEY,
                'Content-Type': 'application/json'
            },
            body: (upstreamMethod === 'POST' || upstreamMethod === 'PUT') ? JSON.stringify(req.body) : undefined
        });

        const data = await response.json();

        // --- CACHE UPDATE LOGIC ---
        // If we successfully fetched fresh results (via GET), save them to Redis
        if (req.method === 'GET' && response.status === 200 && endpoint.endsWith('/results')) {
            if (data.result && data.result.rows) {
                // Save just the rows and timestamp to save space
                await redis.set(CACHE_KEY, {
                    rows: data.result.rows,
                    execution_ended_at: data.execution_ended_at
                });
            }
        }
        // --------------------------

        return res.status(response.status).json(data);

    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch from Dune API', details: error.message });
    }
}
