import { Redis } from '@upstash/redis';

// Initialize Redis client from auto-injected env vars
const redis = Redis.fromEnv();

// Cache configuration
const CACHE_TTL_SECONDS = 1800; // 30 minutes
const DUNE_QUERY_ID = '6586283';

export default async function handler(req, res) {
    const DUNE_API_KEY = process.env.DUNE_API_KEY;
    if (!DUNE_API_KEY) return res.status(500).json({ error: 'Server key missing' });

    // Only support GET requests for fetching data
    if (req.method !== 'GET') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const CACHE_KEY = `dune:dashboard:${DUNE_QUERY_ID}`;

    try {
        // 1. Check Redis Cache First
        const cached = await redis.get(CACHE_KEY);
        const now = Date.now();

        if (cached && cached.cached_at) {
            const cacheAgeSeconds = Math.floor((now - cached.cached_at) / 1000);

            // If cache is fresh (< 30 min), return it immediately
            if (cacheAgeSeconds < CACHE_TTL_SECONDS) {
                const nextRefreshSeconds = CACHE_TTL_SECONDS - cacheAgeSeconds;
                console.log(`Serving from Redis Cache. Age: ${cacheAgeSeconds}s, Next refresh in: ${nextRefreshSeconds}s`);

                return res.status(200).json({
                    rows: cached.rows,
                    cached_at: cached.cached_at,
                    cache_age_seconds: cacheAgeSeconds,
                    next_refresh_seconds: nextRefreshSeconds,
                    source: 'cache'
                });
            }
        }

        // 2. Cache is stale or empty - fetch from Dune's cached results (FREE, no credits)
        console.log('Cache stale/empty. Fetching from Dune cached results...');

        const duneUrl = `https://api.dune.com/api/v1/query/${DUNE_QUERY_ID}/results`;
        const response = await fetch(duneUrl, {
            method: 'GET',
            headers: {
                'X-Dune-Api-Key': DUNE_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Dune API Error:', errorData);

            // If Dune fails but we have stale cache, return it
            if (cached && cached.rows) {
                const cacheAgeSeconds = Math.floor((now - cached.cached_at) / 1000);
                return res.status(200).json({
                    rows: cached.rows,
                    cached_at: cached.cached_at,
                    cache_age_seconds: cacheAgeSeconds,
                    next_refresh_seconds: 0,
                    source: 'stale_cache',
                    warning: 'Using stale cache due to Dune API error'
                });
            }

            return res.status(response.status).json({
                error: 'Dune API error',
                details: errorData
            });
        }

        const data = await response.json();
        const rows = data.result?.rows || [];
        const executionEndedAt = data.execution_ended_at;

        // 3. Update Redis Cache
        const cacheData = {
            rows: rows,
            cached_at: now,
            execution_ended_at: executionEndedAt
        };

        await redis.set(CACHE_KEY, cacheData);
        console.log(`Updated Redis cache with ${rows.length} rows`);

        // 4. Return fresh data
        return res.status(200).json({
            rows: rows,
            cached_at: now,
            cache_age_seconds: 0,
            next_refresh_seconds: CACHE_TTL_SECONDS,
            source: 'dune_fresh'
        });

    } catch (error) {
        console.error('Handler Error:', error);
        return res.status(500).json({
            error: 'Failed to fetch data',
            details: error.message
        });
    }
}
