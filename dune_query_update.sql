-- Dune SQL Query for Zama Auction Dashboard
-- Query ID: 6586283
-- Uses raw ethereum.logs to avoid "Schema does not exist" errors

WITH auction_parsed AS (
    SELECT
        -- topic2 is "bidder" (indexed address, padded to 32 bytes)
        -- Extract last 20 bytes and convert to hex string
        '0x' || to_hex(bytearray_substring(topic2, 13, 20)) as bidder_address,
        -- Price is uint64 at offset 33 in data (after eQuantity bytes32)
        bytearray_to_uint256(bytearray_substring(data, 33, 32)) / 10000.0 as price_fdv,
        block_time
    FROM ethereum.logs
    WHERE contract_address = 0x04a5b8C32f9c38092B008A4939f1F91D550C4345
    AND topic0 = 0x5986d4da84b4e4719683f1ba6994a5bac9ff76c75db61b1a949e5b7d3424e892
),

auction_stats AS (
    SELECT 
        bidder_address,
        COUNT(*) as bid_count,
        MAX(price_fdv) as latest_bid_fdv,
        AVG(price_fdv) as avg_bid_fdv,
        MAX(block_time) as last_bid_time
    FROM auction_parsed
    GROUP BY 1
),

-- Shielding: USDT transfers TO the cUSDT contract (wrapping)
shielding AS (
    SELECT
        CAST("from" AS VARCHAR) as address,
        SUM(CAST(value AS DOUBLE) / 1e6) as amount_shielded
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address = 0xdAC17F958D2ee523a2206206994597C13D831ec7
    AND "to" = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
    GROUP BY 1
),

-- Unshielding: USDT transfers FROM the cUSDT contract (unwrapping)
unshielding AS (
    SELECT
        CAST("to" AS VARCHAR) as address,
        SUM(CAST(value AS DOUBLE) / 1e6) as amount_unshielded
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address = 0xdAC17F958D2ee523a2206206994597C13D831ec7
    AND "from" = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
    GROUP BY 1
),

net_balances AS (
    SELECT
        COALESCE(s.address, u.address) as address,
        COALESCE(s.amount_shielded, 0) - COALESCE(u.amount_unshielded, 0) as net_shielded,
        COALESCE(s.amount_shielded, 0) as total_wrapped,
        COALESCE(u.amount_unshielded, 0) as total_unwrapped
    FROM shielding s
    FULL OUTER JOIN unshielding u ON s.address = u.address
)

SELECT
    COALESCE(a.bidder_address, b.address) as bidder_address,
    COALESCE(a.bid_count, 0) as bid_count,
    COALESCE(b.total_wrapped, 0) as total_wrapped,
    COALESCE(b.total_unwrapped, 0) as total_unwrapped,
    COALESCE(a.latest_bid_fdv, 0) as latest_bid_fdv,
    COALESCE(a.avg_bid_fdv, 0) as avg_bid_fdv,
    a.last_bid_time
FROM net_balances b
FULL OUTER JOIN auction_stats a ON LOWER(b.address) = LOWER(a.bidder_address)
WHERE (COALESCE(b.net_shielded, 0) > 0.01 OR a.bid_count > 0)
ORDER BY COALESCE(b.net_shielded, 0) DESC
