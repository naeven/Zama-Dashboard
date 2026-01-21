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

    // SPECIAL: Allow "GET" to trigger execution (so we can cache the Execution ID globally)
    // If endpoint ends in /execute and method is GET, force POST upstream.
    let upstreamMethod = req.method;
    if (req.method === 'GET' && endpoint.endsWith('/execute')) {
        upstreamMethod = 'POST';
    }

    try {
        // 4. Forward the request
        const response = await fetch(targetUrl, {
            method: upstreamMethod,
            headers: {
                'X-Dune-Api-Key': DUNE_API_KEY,
                'Content-Type': 'application/json'
            },
            // Forward body if it's a POST/PUT request
            body: (upstreamMethod === 'POST' || upstreamMethod === 'PUT') ? JSON.stringify(req.body) : undefined
        });

        const data = await response.json();

        // 5. Add Cache-Control for GET requests (results fetching)
        // 5. Smart Global Caching logic
        if (req.method === 'GET' && response.status === 200) {

            // Default: 5 minute cache for STALE data (gives time for update to propagate)
            // This prevents "flickering" where a second user triggers a duplicate update immediately.
            let cacheDuration = 300; // 5 minutes (was 60)

            // Check data freshness
            if (data.execution_ended_at) {
                const endedAt = new Date(data.execution_ended_at).getTime();
                const now = Date.now();
                const ageSeconds = (now - endedAt) / 1000;

                // If data is "fresh" (younger than 35 mins), cache it for the remaining safe time
                // This protects credits globally.
                if (ageSeconds < 2100) {
                    cacheDuration = 2100; // 35 minutes
                }
            }

            // Special Cache for Execution IDs (Thundering Herd Protection)
            // If we just triggered an execution, cache that ID for 5 mins so everyone joins it.
            if (endpoint.endsWith('/execute')) {
                // Force 5 mins for execution IDs regardless of other logic
                cacheDuration = 300;
                res.setHeader('Cache-Control', `s-maxage=300, stale-while-revalidate=60`);
            } else {
                // Normal Results Logic
                res.setHeader('Cache-Control', `s-maxage=${cacheDuration}, stale-while-revalidate=60`);
            }
        }

        // 6. Return the response to the frontend
        return res.status(response.status).json(data);

    } catch (error) {
        return res.status(500).json({ error: 'Failed to fetch from Dune API', details: error.message });
    }
}
