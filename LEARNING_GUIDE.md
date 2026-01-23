# Learning Guide: Fetching Blockchain Data & Writing Dune SQL

Welcome! This guide explains how we built the Zama Auction Dashboard. It breaks down the two most critical skills in Web3 development: **Fetching Data** (API Integration) and **Querying Data** (Dune SQL).

---

## Part 1: How We Fetch Data (The "Backend" Logic)

In this project, we don't just "read" data directly from the blockchain because it's slow and complex. Instead, we use an **API** (Application Programming Interface).

### 1. The Architecture
We use a **Serverless Function** (`api/dune.js`) as a middleman.
*   **Client (Browser)**: "Hey Server, give me the auction stats!"
*   **Server (Vercel/Node.js)**: "Let me check if I have it in memory (Redis Cache)."
    *   *If Yes*: "Here it is!" (Fast, Free)
    *   *If No*: "Hold on, I need to ask Dune Analytics." -> Call Dune API -> Save to Redis -> "Here it is!"

### 2. The Code Explained (`dune.js`)
Here is the simplified logic of how we fetch data safely:

```javascript
// We use 'fetch' - a standard tool to make web requests
const output = await fetch('https://api.dune.com/api/v1/query/12345/results', {
    headers: { 'X-Dune-Api-Key': 'MY_SECRET_KEY' }
});
```

**Key Concept: Caching**
APIs cost money (Credits). We use **Redis** (a super-fast key-value database) to remember the result for 30 minutes.
```javascript
// Step 1: Check Cache
const cachedData = await redis.get('my_dashboard_data');
if (cachedData) return cachedData; // Stop here! Don't pay Dune.

// Step 2: If empty, Pay Dune to get fresh data
const freshData = await fetchDune();

// Step 3: Save for next time
await redis.set('my_dashboard_data', freshData, { ex: 1800 }); // Expires in 1800s (30m)
```

---

## Part 2: How to Write Dune SQL (The "Database" Logic)

Dune Analytics indexes blockchain data into a giant SQL database. SQL (Structured Query Language) is how we ask questions like "Who bid the most?".

### 1. The Basics
Blockchain data is stored in **Tables**. The most important one is `ethereum.logs`.
*   **Logs**: Every time something smart happens on a contract (like a Bid), it emits an "Event".
*   **Topics**: These are the fingerprints of the event.
    *   `topic0`: The Event Signature (Hash of "BidSubmitted(...)")
    *   `topic1`, `topic2`: Indexed parameters (User Address, Amount).
    *   `data`: Non-indexed parameters (Price).

### 2. Deconstructing Our Query
We used a technique called **CTE (Common Table Expressions)** to build the query step-by-step. Think of `WITH` blocks as temporary mini-tables.

#### Step A: Find the Bids (`bid_events`)
```sql
WITH bid_events AS (
    SELECT
        -- 'topic2' holds the bidder address. We chop off the padding (13-32)
        bytearray_substring(topic2, 13, 20) AS bidder_address,
        
        -- 'data' holds the price. We grab 32 bytes and convert to a number
        bytearray_to_uint256(bytearray_substring(data, 33, 32)) AS price
    FROM ethereum.logs
    WHERE contract_address = 0x... -- The Auction Contract
    AND topic0 = 0x... -- The "BidSubmitted" Event Hash
)
```

#### Step B: Find the Money (`usdt_wraps`)
We need to see who sent USDT to the Shielding contract. This is a `Transfer` event.
```sql
usdt_wraps AS (
    SELECT
        "from" AS address,
        SUM(value) / 1e6 AS total_wrapped -- Divide by 1e6 because USDT has 6 decimals
    FROM erc20_ethereum.evt_Transfer
    WHERE "to" = 0x... -- The Shielding Contract
    GROUP BY 1 -- Group by Address to sum totals per user
)
```

#### Step C: The Grand Finale (`FULL OUTER JOIN`)
We have two lists:
1.  People who **Bid** (Active)
2.  People who **Shielded Money** (Passive)

We want **BOTH**.
*   `INNER JOIN`: Only shows people who did *both*. (Bad, we miss passive whales).
*   `LEFT JOIN`: Only shows Bidders. (Bad, we miss passive whales).
*   `FULL OUTER JOIN`: Shows everyone! If they bid but didn't shield (weird), or shielded but didn't bid (whales), they are included.

```sql
SELECT
    COALESCE(b.address, w.address) as wallet, -- Use whichever address exists
    COALESCE(b.bid_count, 0) as bids,
    COALESCE(w.amount, 0) as money
FROM bid_events b
FULL OUTER JOIN usdt_wraps w ON b.address = w.address
```

### 3. Tips for Learning
1.  **Start Small**: Don't try to write the whole query at once. Write a query just to find one specific transaction hash to see how usage looks.
2.  **Use `bytearray`**: Dune's raw data is in bytes. Learn `bytearray_substring` and `bytearray_to_uint256`. It's robust and never fails due to "schema errors".
3.  **Check `decimals`**: Always divide token amounts by `10^decimals` (USDT is 6, ETH is 18).

---

## Summary
*   **Web2 (App)**: Logic ensures we don't spam the API (Caching/Locking).
*   **Web3 (Data)**: Logic ensures we capture every byte of data accurately (Raw Logs + Full Joins).

Good luck on your coding journey! You have already built a professional-grade analytics dashboard.
