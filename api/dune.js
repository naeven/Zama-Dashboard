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
    const LOCK_KEY = `dune:lock:${DUNE_QUERY_ID}`;

    try {
        // 1. Check Redis Cache First
        const { force } = req.query;
        const cached = await redis.get(CACHE_KEY);
        const now = Date.now();

        if (cached && cached.cached_at && !force) {
            const cacheAgeSeconds = Math.floor((now - cached.cached_at) / 1000);
            console.log(`Cache Check: Age=${cacheAgeSeconds}s, TTL=${CACHE_TTL_SECONDS}s`);

            // If cache is fresh (< 30 min), return it immediately
            if (cacheAgeSeconds < CACHE_TTL_SECONDS) {
                const nextRefreshSeconds = CACHE_TTL_SECONDS - cacheAgeSeconds;
                console.log(`Serving from Redis Cache. Next refresh in: ${nextRefreshSeconds}s`);

                return res.status(200).json({
                    rows: cached.rows,
                    cached_at: cached.cached_at,
                    cache_age_seconds: cacheAgeSeconds,
                    next_refresh_seconds: nextRefreshSeconds,
                    source: 'cache'
                });
            }
            console.log('Cache Expired. Proceeding to refresh...');
        } else if (force) {
            console.log('Force Refresh requested. Bypassing cache...');
        }

        // 2. Cache is stale or empty - Check for LOCK to prevent race conditions
        const isLocked = await redis.get(LOCK_KEY);

        if (isLocked) {
            console.log('Fetch already in progress (Locked). Waiting...');
            // Wait for up to 2 seconds for the other process to finish
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Check cache again after waiting
            const refetchedCache = await redis.get(CACHE_KEY);
            if (refetchedCache) {
                return res.status(200).json({
                    rows: refetchedCache.rows,
                    cached_at: refetchedCache.cached_at,
                    source: 'cache_after_lock_wait'
                });
            }
            // If still no cache after wait, return 429 to avoid hammering API
            return res.status(429).json({ error: 'System busy, please try again in a moment.' });
        }

        // Set Lock (expire in 60s as execution takes time)
        await redis.set(LOCK_KEY, 'locked', { ex: 60 });

        console.log('Cache stale/empty. Triggering new Dune execution...');

        try {
            // Step A: Trigger Execution
            const executeUrl = `https://api.dune.com/api/v1/query/${DUNE_QUERY_ID}/execute`;
            const execResp = await fetch(executeUrl, {
                method: 'POST',
                headers: { 'X-Dune-Api-Key': DUNE_API_KEY, 'Content-Type': 'application/json' }
            });

            if (!execResp.ok) {
                const err = await execResp.json();
                console.error('Dune Execute Failed:', err);
                // If execution fails, try fallback to stale cache
                if (cached && cached.rows) {
                    await redis.del(LOCK_KEY);
                    return res.status(200).json({ rows: cached.rows, cached_at: cached.cached_at, source: 'stale_on_fail' });
                }
                throw new Error(`Dune Execute failed: ${JSON.stringify(err)}`);
            }

            const { execution_id } = await execResp.json();
            console.log(`Execution Triggered: ${execution_id}. Polling...`);

            // Step B: Poll for Results
            let attempts = 0;
            let finalData = null;

            while (attempts < 15) { // Poll for max ~30 seconds
                await new Promise(r => setTimeout(r, 2000)); // Wait 2s
                const statusUrl = `https://api.dune.com/api/v1/execution/${execution_id}/results`;
                const statusResp = await fetch(statusUrl, {
                    headers: { 'X-Dune-Api-Key': DUNE_API_KEY }
                });

                if (statusResp.status === 200) {
                    finalData = await statusResp.json();
                    if (finalData.state === 'QUERY_STATE_COMPLETED') {
                        break; // Success!
                    }
                    if (finalData.state === 'QUERY_STATE_FAILED' || finalData.state === 'QUERY_STATE_CANCELLED') {
                        throw new Error(`Query failed state: ${finalData.state}`);
                    }
                }
                attempts++;
            }

            if (!finalData || finalData.state !== 'QUERY_STATE_COMPLETED') {
                // Timeout or failure
                console.error('Dune execution timed out or failed');
                await redis.del(LOCK_KEY);
                if (cached) return res.status(200).json({ rows: cached.rows, source: 'stale_on_timeout' });
                return res.status(504).json({ error: 'Dune query execution timed out' });
            }

            const rows = finalData.result?.rows || [];

            // 3. Update Redis Cache
            const cacheData = {
                rows: rows,
                cached_at: now,
                execution_ended_at: finalData.execution_ended_at
            };

            await redis.set(CACHE_KEY, cacheData);
            console.log(`Updated Redis cache with ${rows.length} rows`);

            // Release Lock
            await redis.del(LOCK_KEY);

            // 4. Return fresh data
            return res.status(200).json({
                rows: rows,
                cached_at: now,
                cache_age_seconds: 0,
                next_refresh_seconds: CACHE_TTL_SECONDS,
                source: 'dune_fresh_execution'
            });

        } catch (fetchError) {
            // Ensure lock is released even if fetch fails
            console.error(fetchError);
            await redis.del(LOCK_KEY);
            // Fallback to stale if available on crash
            if (cached && cached.rows) {
                return res.status(200).json({ rows: cached.rows, cached_at: cached.cached_at, source: 'stale_on_crash' });
            }
            throw fetchError;
        }

    } catch (error) {
        console.error('Handler Error:', error);
        return res.status(500).json({
            error: 'Failed to fetch data',
            details: error.message
        });
    }
}
