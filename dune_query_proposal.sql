WITH shielding AS (
    SELECT
        "from" AS address,
        SUM(value / 1e6) AS amount_shielded
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address = 0xdAC17F958D2ee523a2206206994597C13D831ec7
    AND "to" = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
    GROUP BY 1
),
unshielding AS (
    SELECT
        "to" AS address,
        SUM(value / 1e6) AS amount_unshielded
    FROM erc20_ethereum.evt_Transfer
    WHERE contract_address = 0xdAC17F958D2ee523a2206206994597C13D831ec7
    AND "from" = 0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50
    GROUP BY 1
),
bids AS (
    SELECT
        "bidder" AS address,
        count(*) as bid_count,
        MAX("price") as max_bid_fdv, -- Need to decode logic if complex, but assuming price is simple
        AVG("price") as avg_bid_fdv,
        MAX(evt_block_time) as last_bid_time
    FROM (
        -- Replace with actual decoding if `price` is not raw. 
        -- Based on ABI: price is uint64.
        SELECT 
             topic2 as bidder_topic, -- indexed address is usually topic1 or topic2
             -- "bidder" is indexed param 2. topic0=hash, topic1=bidId, topic2=bidder.
             -- So we need to decode topic2 to address.
             bytea2numeric(topic2)::int as dummy, -- placeholder for decoding
             "bidder",
             "price",
             evt_block_time
        FROM zama_auction_ethereum.BidSubmitted -- Assuming decoded table exists on Dune?
        -- If decoded table doesn't exist, we use logs:
    ) b_decoded
    GROUP BY 1
),
-- Alternative Bids Query if using raw logs:
bids_raw AS (
    SELECT
        topic2 AS bidder_hash, -- specific decoding needed
        count(*) as bid_count,
        MAX(evt_block_time) as last_bid_time
    FROM ethereum.logs
    WHERE contract_address = 0x04a5b8C32f9c38092B008A4939f1F91D550C4345
    AND topic0 = 0x... -- BidSubmitted signature
    GROUP BY 1
)

-- ACTUAL QUERY TO USE (Assuming you can match the columns expected by app.js: 
-- bidder_address, bid_count, total_wrapped, total_unwrapped, latest_bid_fdv, avg_bid_fdv, last_bid_time)

SELECT
    COALESCE(s.address, u.address, b.bidder) AS bidder_address,
    COALESCE(b.bid_count, 0) AS bid_count,
    COALESCE(s.amount_shielded, 0) AS total_wrapped,
    COALESCE(u.amount_unshielded, 0) AS total_unwrapped,
    COALESCE(b.latest_bid_fdv, 0) AS latest_bid_fdv, -- simplified matching
    COALESCE(b.avg_bid_fdv, 0) AS avg_bid_fdv,
    b.last_bid_time
FROM shielding s
FULL OUTER JOIN unshielding u ON s.address = u.address
FULL OUTER JOIN (
    -- You should grab the Bid Logic from the existing Query 6586283 to ensure metrics match
    -- This is a placeholder for the Bid Logic Part
    SELECT 
        bidder, 
        count(*) as bid_count, 
        MAX(price) as latest_bid_fdv, 
        AVG(price) as avg_bid_fdv, 
        MAX(call_block_time) as last_bid_time
    FROM ... -- Existing query source
    GROUP BY 1
) b ON s.address = b.bidder OR u.address = b.bidder
ORDER BY (COALESCE(s.amount_shielded, 0) - COALESCE(u.amount_unshielded, 0)) DESC
