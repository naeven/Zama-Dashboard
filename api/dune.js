export default async function handler(req, res) {
    // 1. Get the DUNE_API_KEY from environment variables
    const DUNE_API_KEY = process.env.DUNE_API_KEY;

    if (!DUNE_API_KEY) {
        return res.status(500).json({ error: 'Server misconfiguration: DUNE_API_KEY missing' });
    }

    // 2. Extract query parameters (endpoint path is passed via "route" or just appended)
    // We expect the frontend to call: /api/dune?endpoint=query/123/results
    const { endpoint } = req.query;

    if (!endpoint) {
        return res.status(400).json({ error: 'Missing "endpoint" query parameter' });
    }

    // 3. Construct the target URL
    const targetUrl = `https://api.dune.com/api/v1/${endpoint}`;

    try {
        // 4. Forward the request
        const response = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'X-Dune-Api-Key': DUNE_API_KEY,
                'Content-Type': 'application/json'
            },
            // Forward body if it's a POST request (e.g. executing a query)
            body: (req.method === 'POST' || req.method === 'PUT') ? JSON.stringify(req.body) : undefined
        });

        const data = await response.json();

        // 5. Add Cache-Control for GET requests (results fetching)
        if (req.method === 'GET' && response.status === 200) {
            // Cache in CDN for 35 minutes (2100 seconds)
            res.setHeader('Cache-Control', 's-maxage=2100, stale-while-revalidate=60');
        }

        // 6. Return the response to the frontend
        return res.status(response.status).json(data);

    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch from Dune API', details: error.message });
    }
}
