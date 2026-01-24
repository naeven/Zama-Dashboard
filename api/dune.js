import { Redis } from '@upstash/redis';

// Initialize Redis client from auto-injected env vars
const redis = Redis.fromEnv();

// Cache configuration
const CACHE_TTL_SECONDS = 7200; // 2 hours
const DUNE_QUERY_ID = '6586283';

const ALCHEMY_URL = 'https://eth-mainnet.g.alchemy.com/v2/wd-9XAJoEnMc8NWQXwT3Z';
const AUCTION_ADDRESS = '0x04a5b8C32f9c38092B008A4939f1F91D550C4345';
const TOPIC_BID_CANCELED = '0xbd8de31a25c2b7c2ddafffe72dab91b4ce5826cfd5664793eb206f572f732c27';

// Redis specific keys for cancellations
const REDIS_KEY_CANCELLATIONS = 'zama:cancellations:counts';
const REDIS_KEY_LAST_BLOCK = 'zama:cancellations:last_block';

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
        // [New] Trigger incremental sync of cancellations
        // We do this asynchronously or block? Blocking is safer for correctness, async is faster.
        // Given we want to move load to server, a small delay is fine.
        let cancellations = {};
        try {
            await syncCancellations();
            cancellations = await redis.hgetall(REDIS_KEY_CANCELLATIONS) || {};
        } catch (syncErr) {
            console.warn('Cancellation sync failed:', syncErr);
            // Fallback to existing redis data
            cancellations = await redis.hgetall(REDIS_KEY_CANCELLATIONS) || {};
        }

        // 1. Check Redis Cache First
        const { force } = req.query;

        // [New] If Force Refresh is requested, reset the cancellation sync state to ensure full accuracy
        if (force === 'true') {
            console.log('Force refresh: Resetting cancellation sync state...');
            await redis.del(REDIS_KEY_CANCELLATIONS);
            await redis.del(REDIS_KEY_LAST_BLOCK);
        }

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
                    cancellations: cancellations, // [New] Include cancellations
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
                    cancellations: cancellations, // [New] Include cancellations
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
                    return res.status(200).json({
                        rows: cached.rows,
                        cancellations: cancellations,
                        cached_at: cached.cached_at,
                        source: 'stale_on_fail'
                    });
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
                if (cached) return res.status(200).json({
                    rows: cached.rows,
                    cancellations: cancellations,
                    source: 'stale_on_timeout'
                });
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
                cancellations: cancellations, // [New] Include cancellations
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
                return res.status(200).json({
                    rows: cached.rows,
                    cancellations: cancellations,
                    cached_at: cached.cached_at,
                    source: 'stale_on_crash'
                });
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

// --- Incremental Sync Logic ---

async function syncCancellations() {
    // Alchemy allows wider ranges for filtered queries (topic + address). 
    // Sparse events mean we can query 1M blocks safely if result set is small.
    const MAX_BLOCK_RANGE = 2000000;
    const DEFAULT_START_BLOCK_HEX = '0x1312D00'; // Approx Start Block (~20M)
    const SYNC_LOCK_KEY = 'zama:cancellations:sync_lock';

    // Try to acquire lock to prevent double-counting race conditions
    // 'nx': true means set only if not exists. 'ex': 30 sets expiration to 30s.
    const acquired = await redis.set(SYNC_LOCK_KEY, 'locked', { nx: true, ex: 30 });

    if (!acquired) {
        console.log('Cancellation sync currently locked by another process. Skipping...');
        return;
    }

    try {
        // 1. Get State
        const lastBlockStr = await redis.get(REDIS_KEY_LAST_BLOCK);
        let startBlock = lastBlockStr ? parseInt(lastBlockStr) : parseInt(DEFAULT_START_BLOCK_HEX, 16);

        // 2. Fetch Latest Block
        const blockResp = await fetch(ALCHEMY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
        });
        const blockData = await blockResp.json();
        const currentBlock = parseInt(blockData.result, 16);

        // If we are up to date, skip
        if (startBlock >= currentBlock) return;

        console.log(`Starting sync from ${startBlock} to ${currentBlock} (Gap: ${currentBlock - startBlock} blocks)`);

        // 3. Loop until caught up
        while (startBlock < currentBlock) {
            // Calculate end of this chunk
            const endBlock = Math.min(startBlock + MAX_BLOCK_RANGE, currentBlock);
            const fromHex = `0x${startBlock.toString(16)}`;
            const toHex = `0x${endBlock.toString(16)}`;

            console.log(`Fetching logs from ${fromHex} to ${toHex}...`);

            const logsResp = await fetch(ALCHEMY_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
                    params: [{
                        address: AUCTION_ADDRESS,
                        topics: [TOPIC_BID_CANCELED],
                        fromBlock: fromHex,
                        toBlock: toHex
                    }]
                })
            });

            const logsData = await logsResp.json();
            if (logsData.error) throw new Error(logsData.error.message);
            const logs = logsData.result || [];

            if (logs.length > 0) {
                const pipeline = redis.pipeline();
                const updates = {};

                logs.forEach(log => {
                    if (log.topics && log.topics.length >= 3) {
                        const bidderTopic = log.topics[2];
                        const bidder = '0x' + bidderTopic.slice(26).toLowerCase();
                        updates[bidder] = (updates[bidder] || 0) + 1;
                    }
                });

                Object.entries(updates).forEach(([bidder, count]) => {
                    pipeline.hincrby(REDIS_KEY_CANCELLATIONS, bidder, count);
                });

                await pipeline.exec();
                console.log(`Chunk processed: ${logs.length} events.`);
            }

            // Update checkpoint *after* successful chunk
            await redis.set(REDIS_KEY_LAST_BLOCK, endBlock + 1);

            // Move start forward
            startBlock = endBlock + 1;

            // Small delay to prevent rate limits
            await new Promise(r => setTimeout(r, 200));
        }

        console.log('Sync complete.');

    } catch (e) {
        console.error('Sync failed:', e);
    } finally {
        // Release lock
        await redis.del(SYNC_LOCK_KEY);
    }
}
