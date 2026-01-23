-- Dune SQL Query for Zama Auction Dashboard
-- Query ID: 6586283
-- Combined Query: Uses user's proven logic for Bids/Wraps/Unwraps + Full Outer Join for passive holders

WITH bid_events AS (
    -- Fetch BidSubmitted events using raw logs
    SELECT
        bytearray_substring(topic2, 13, 20) AS bidder_address_bytes,
        -- Extract cleartextAmount (price) from data - it's the second 32-byte word
        bytearray_to_uint256(bytearray_substring(data, 33, 32)) AS bid_price_raw,
        tx_hash,
        block_time,
        "index"
    FROM ethereum.logs
    WHERE contract_address = 0x04a5b8C32f9c38092B008A4939f1F91D550C4345
      AND topic0 = 0x5986d4da84b4e4719683f1ba6994a5bac9ff76c75db61b1a949e5b7d3424e892
),

latest_bids AS (
    SELECT
        bidder_address_bytes,
        bid_price_raw,
        ROW_NUMBER() OVER (PARTITION BY bidder_address_bytes ORDER BY block_time DESC, "index" DESC) as rn
    FROM bid_events
),

bid_stats AS (
    SELECT
        bidder_address_bytes,
        COUNT(tx_hash) AS bid_count,
        MAX(block_time) AS last_bid_time,
        AVG(CAST(bid_price_raw AS double) / 1e6) AS avg_bid_fdv
    FROM bid_events
    GROUP BY 1
),

-- Shielding: USDT transfers TO the cUSDT contract (wrapping)
usdt_wraps AS (
    SELECT
        -- Retrieve address bytes from the "from" address (20 bytes)
        from_hex(SUBSTRING(CAST("from" AS VARCHAR), 3)) AS bidder_address_bytes,
        SUM(CAST(value AS double) / 1e6) AS total_wrapped_usdt
    FROM erc20_ethereum.evt_Transfer
    WHERE "to" = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
      AND contract_address = 0xdAC17F958D2ee523a2206206994597C13D831ec7
    GROUP BY 1
),

-- Unshielding: Unwrap events from cUSDT contract
unwraps AS (
    SELECT
        bytearray_substring(topic1, 13, 20) AS bidder_address_bytes,
        SUM(CAST(bytearray_to_uint256(bytearray_substring(data, 33, 32)) AS double) / 1e6) AS total_unwrapped_usdt
    FROM ethereum.logs
    WHERE contract_address = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
      AND topic0 = 0x2d4edf3c2943002120f53dab3f8940043f34799f4a92ab90f2f81f7dd004a49e
    GROUP BY 1
),

-- Merge Wraps and Unwraps first to get Net Balance for clear logic
balances AS (
  SELECT
    COALESCE(w.bidder_address_bytes, u.bidder_address_bytes) as address_bytes,
    COALESCE(w.total_wrapped_usdt, 0) as total_wrapped,
    COALESCE(u.total_unwrapped_usdt, 0) as total_unwrapped,
    COALESCE(w.total_wrapped_usdt, 0) - COALESCE(u.total_unwrapped_usdt, 0) as net_shielded
  FROM usdt_wraps w
  FULL OUTER JOIN unwraps u ON w.bidder_address_bytes = u.bidder_address_bytes
)

SELECT
    '0x' || to_hex(COALESCE(b.address_bytes, bs.bidder_address_bytes)) AS bidder_address,
    COALESCE(bs.bid_count, 0) AS bid_count,
    COALESCE(b.total_wrapped, 0) AS total_wrapped,
    COALESCE(b.total_unwrapped, 0) AS total_unwrapped,
    COALESCE(b.net_shielded, 0) AS net_shielded,
    
    -- Get latest bid price from CTE
    COALESCE(
        (SELECT CAST(lb.bid_price_raw AS double) / 1e6 
         FROM latest_bids lb 
         WHERE lb.bidder_address_bytes = COALESCE(b.address_bytes, bs.bidder_address_bytes) 
           AND lb.rn = 1),
        0
    ) AS latest_bid_fdv,
    
    COALESCE(bs.avg_bid_fdv, 0) AS avg_bid_fdv,
    bs.last_bid_time

FROM balances b
FULL OUTER JOIN bid_stats bs ON b.address_bytes = bs.bidder_address_bytes
WHERE (COALESCE(b.net_shielded, 0) > 0.01 OR COALESCE(bs.bid_count, 0) > 0)
ORDER BY net_shielded DESC
