/**
 * Zama Auction Dashboard
 * Tracks bidders and their net shielded USDT amounts using Dune Analytics
 * Server-side data architecture - no client-side query execution
 */

// Configuration  
const ALCHEMY_HTTP_URL = 'https://eth-mainnet.g.alchemy.com/v2/wd-9XAJoEnMc8NWQXwT3Z';
const REFRESH_INTERVAL = 7200000; // 2 hours - matches server cache TTL

// State
let bidders = new Map();
let auctionConfig = null;
let auctionState = null;
let isLoading = true;

let refreshTimeoutId = null;
let isStatsView = false;

// DOM Elements
const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    totalBidders: document.getElementById('totalBidders'),
    totalBids: document.getElementById('totalBids'),
    totalShielded: document.getElementById('totalShielded'),
    auctionShielded: document.getElementById('auctionShielded'),
    auctionStart: document.getElementById('auctionStart'),
    auctionEnd: document.getElementById('auctionEnd'),
    tokenSupply: document.getElementById('tokenSupply'),
    auctionStatus: document.getElementById('auctionStatus'),
    loadingContainer: document.getElementById('loadingContainer'),
    loadingStatus: document.getElementById('loadingStatus'),
    tableContainer: document.getElementById('tableContainer'),
    tableBody: document.getElementById('tableBody'),
    emptyState: document.getElementById('emptyState'),
    searchInput: document.getElementById('searchInput'),
    sortBy: document.getElementById('sortBy'),
    sortOrder: document.getElementById('sortOrder'),
    lastUpdated: document.getElementById('lastUpdated'),
    dataAge: document.getElementById('dataAge'),
    chartSection: document.getElementById('chartSection'),
    chartLegend: document.getElementById('chartLegend'),
    statsToggle: document.getElementById('statsToggle'),
    statsHeader: document.getElementById('statsHeader'),
    totalCanceledBids: document.getElementById('totalCanceledBids'),
    tableHead: document.getElementById('tableHead'),
    maxBidFdv: document.getElementById('maxBidFdv'),
    minBidFdv: document.getElementById('minBidFdv'),
    avgBidFdv: document.getElementById('avgBidFdv')
};

// Pagination State
let currentPage = 1;
const ITEMS_PER_PAGE = 50;
let paginationContainer = null;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
    setupEventListeners();
    await loadInitialData();
    fetchTVS();
}

function setupEventListeners() {
    elements.searchInput.addEventListener('input', debounce(renderTable, 300));
    elements.sortBy.addEventListener('change', renderTable);
    elements.sortBy.addEventListener('change', renderTable);
    elements.sortOrder.addEventListener('change', renderTable);
    elements.statsToggle.addEventListener('change', (e) => {
        isStatsView = e.target.checked;
        renderTable();
    });
}

// --- Data Fetching (Server-Only) ---

async function loadInitialData() {
    try {
        setLoading(true, 'Loading data...');
        await fetchAuctionInfo();
        await fetchDashboardData();
        updateConnectionStatus('connected');
    } catch (e) {
        console.error('Failed to load data:', e);
        setLoading(true, `Error: ${e.message}`);
        updateConnectionStatus('error');
    }
}

async function fetchDashboardData() {
    try {
        setLoading(true, 'Fetching data from server...');

        // Simple call to server - server handles all caching
        // Smart Cache Busting: If we suspect stale data, we force refresh.
        let response = await fetch('/api/dune');

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }

        let data = await response.json();

        // Check for Stale Data (Missing Min/Max columns from old query)
        // If the first row exists but has 0/undefined for min_bid_fdv where latest > 0, it's stale.
        const isStale = data.rows && data.rows.length > 0 &&
            data.rows[0].min_bid_fdv === undefined &&
            data.rows[0].latest_bid_fdv > 0;

        if (isStale) {
            console.log('Detected stale data (missing Min/Max columns). Forcing refresh...');
            setLoading(true, 'Refreshing data cache...');
            response = await fetch('/api/dune?force=true');
            if (response.ok) {
                data = await response.json();
                console.log('Data refreshed successfully.');
            }
        }

        // Process the rows
        if (data.rows && data.rows.length > 0) {
            await processDuneResults(data.rows);
        }

        // Update UI with cache info from server
        updateCacheInfo(data);

        // Schedule next refresh based on server response
        scheduleNextRefresh(data.next_refresh_seconds);

        setLoading(false);
        return data;

    } catch (e) {
        console.error('Fetch error:', e);
        throw e;
    }
}

function scheduleNextRefresh(nextRefreshSeconds) {
    // Clear any existing timeout
    if (refreshTimeoutId) {
        clearTimeout(refreshTimeoutId);
    }

    // Use server-provided interval or default 30 minutes
    const intervalMs = (nextRefreshSeconds || 7200) * 1000;

    console.log(`Next refresh scheduled in: ${Math.round(intervalMs / 60000)} minutes`);

    refreshTimeoutId = setTimeout(async () => {
        console.log('Auto-refresh triggered');
        try {
            await fetchDashboardData();
            updateConnectionStatus('connected');
        } catch (e) {
            console.warn('Auto-refresh failed:', e);
            updateConnectionStatus('error');
            // Retry in 5 minutes on error
            scheduleNextRefresh(300);
        }
    }, intervalMs);
}

function updateCacheInfo(data) {
    if (!data) return;

    // Show when data was cached
    if (data.cached_at) {
        updateDataAge(data.cached_at);
    }

    // Update last updated time
    updateLastUpdated();

    // Log source for debugging
    if (data.source) {
        console.log(`Data source: ${data.source}`);
    }

    if (data.warning) {
        console.warn(`Server warning: ${data.warning}`);
    }
}

async function processDuneResults(rows) {
    bidders.clear();
    let totalCancellations = 0;

    // Populate bidders from Dune (Query 6592867 now handles all logic)
    for (const row of rows) {
        if (!row.bidder_address) continue;
        const address = String(row.bidder_address);

        // Cancellation count comes directly from Dune now
        const canceledCount = parseInt(row.canceled_count || 0);
        totalCancellations += canceledCount;

        bidders.set(address.toLowerCase(), {
            address: address,
            bidCount: parseInt(row.bid_count || 0), // This is Net Active Bids from SQL
            canceledCount: canceledCount, // Total cancellations for this user
            wrapped: BigInt(Math.floor(parseFloat(row.total_wrapped || 0) * 1e6)),
            unwrapped: BigInt(Math.floor(parseFloat(row.total_unwrapped || 0) * 1e6)),
            latestBidFdv: parseFloat(row.latest_bid_fdv || 0),
            minBidFdv: parseFloat(row.min_bid_fdv || 0),
            maxBidFdv: parseFloat(row.max_bid_fdv || 0),
            avgBidFdv: parseFloat(row.avg_bid_fdv || 0),
            lastBidTime: row.last_bid_time ? new Date(row.last_bid_time.replace(' UTC', 'Z').replace(' ', 'T')).getTime() : 0
        });
    }

    // Update Total Canceled Bids in UI
    if (elements.totalCanceledBids) {
        elements.totalCanceledBids.textContent = formatNumber(totalCancellations);
    }

    updateStats();
    renderBidDistribution();
    renderTable();
    setLoading(false);
}

// --- Blockchain Helpers ---

const CONTRACTS = {
    AUCTION: '0x04a5b8C32f9c38092B008A4939f1F91D550C4345',
    CUSDT_PROXY: '0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    ZAMA_OG_NFT: '0xb3F2dDaEd136Cf10d5b228EE2EfF29B71C7535Fc'
};

async function rpcCall(method, params) {
    const response = await fetch(ALCHEMY_HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
}

async function fetchAuctionInfo() {
    try {
        const configData = await rpcCall('eth_call', [{ to: CONTRACTS.AUCTION, data: ethers.id('auctionConfig()').slice(0, 10) }, 'latest']);
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint64', 'uint64', 'address', 'address', 'address', 'address', 'address', 'uint256'], configData);
        auctionConfig = { startAuctionTime: Number(decoded[0]), endAuctionTime: Number(decoded[1]), zamaTokenSupply: decoded[2] };

        const stateData = await rpcCall('eth_call', [{ to: CONTRACTS.AUCTION, data: ethers.id('auctionState()').slice(0, 10) }, 'latest']);
        const stateDecoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint64', 'uint64', 'uint64', 'uint64', 'bool', 'bool', 'bool', 'bool'], stateData);
        auctionState = { auctionCanceled: stateDecoded[7] };

        updateAuctionInfo();
    } catch (e) {
        console.warn('Auction info fetch failed:', e);
    }
}

async function fetchTVS() {
    try {
        const data = await rpcCall('eth_call', [{ to: CONTRACTS.USDT, data: '0x70a08231' + CONTRACTS.CUSDT_PROXY.slice(2).padStart(64, '0') }, 'latest']);
        elements.totalShielded.textContent = formatUSDT(BigInt(data));
    } catch (e) { console.warn('TVS fetch failed:', e); }
}

async function fetchNFTBalances(addresses) {
    // Filter out addresses we've already checked to fail-safe against loops
    const toCheck = addresses.filter(addr => {
        const b = bidders.get(addr.toLowerCase());
        return b && b.nftBalance === undefined;
    });

    if (toCheck.length === 0) return;

    // Mark as fetching to prevent parallel calls
    toCheck.forEach(addr => {
        const b = bidders.get(addr.toLowerCase());
        if (b) b.nftBalance = 'fetching';
    });

    try {
        // Construct batch request
        const batch = toCheck.map((addr, i) => ({
            jsonrpc: '2.0',
            id: i,
            method: 'eth_call',
            params: [{
                to: CONTRACTS.ZAMA_OG_NFT,
                data: '0x70a08231' + addr.slice(2).padStart(64, '0') // balanceOf(address)
            }, 'latest']
        }));

        const response = await fetch(ALCHEMY_HTTP_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batch)
        });

        const results = await response.json();

        // Process results
        results.forEach((res, i) => {
            const addr = toCheck[i];
            const b = bidders.get(addr.toLowerCase());
            if (b && !res.error) {
                b.nftBalance = parseInt(res.result, 16);
            } else if (b) {
                b.nftBalance = 0; // Default to 0 on error
            }
        });

        // Re-render table to show new data
        if (isStatsView) renderTable();

    } catch (e) {
        console.warn('NFT batch fetch failed:', e);
        // Reset so we can retry? Or just leave as fetching/error?
        toCheck.forEach(addr => {
            const b = bidders.get(addr.toLowerCase());
            if (b) b.nftBalance = null; // null triggers retry next render
        });
    }
}

// --- UI Logic ---

function setLoading(loading, status = '') {
    isLoading = loading;
    if (loading && bidders.size === 0) {
        elements.loadingContainer.style.display = 'flex';
        elements.tableContainer.style.display = 'none';
        if (status) elements.loadingStatus.textContent = status;
    } else {
        elements.loadingContainer.style.display = 'none';
        elements.tableContainer.style.display = 'block';
    }
}

function updateConnectionStatus(status) {
    elements.connectionStatus.className = 'connection-status ' + status;
    const texts = { connected: 'Connected', disconnected: 'Disconnected', error: 'Error' };
    elements.connectionStatus.querySelector('.status-text').textContent = texts[status] || 'Connecting...';
}

function updateAuctionInfo() {
    if (!auctionConfig) return;
    elements.auctionStart.textContent = formatDate(auctionConfig.startAuctionTime * 1000);
    elements.auctionEnd.textContent = formatDate(auctionConfig.endAuctionTime * 1000);
    elements.tokenSupply.textContent = formatNumber(Number(auctionConfig.zamaTokenSupply) / 1e6) + 'M ZAMA';

    const now = Date.now();
    const start = auctionConfig.startAuctionTime * 1000;
    const end = auctionConfig.endAuctionTime * 1000;

    const statusEl = elements.auctionStatus;
    if (auctionState?.auctionCanceled) {
        statusEl.textContent = 'Canceled'; statusEl.className = 'status-badge ended';
    } else if (now < start) {
        statusEl.textContent = 'Not Started'; statusEl.className = 'status-badge pending';
    } else if (now >= start && now < end) {
        statusEl.textContent = 'Active'; statusEl.className = 'status-badge active';
    } else {
        statusEl.textContent = 'Ended'; statusEl.className = 'status-badge ended';
    }
}

function updateStats() {
    const list = Array.from(bidders.values());
    elements.totalBidders.textContent = formatNumber(list.filter(b => b.bidCount > 0).length);
    elements.totalBids.textContent = formatNumber(list.reduce((s, b) => s + b.bidCount, 0));
    // Sum of net shielded (wrapped - unwrapped) for all auction participants
    const totalAuctionShielded = list
        .filter(b => b.bidCount > 0)
        .reduce((sum, b) => sum + (b.wrapped - b.unwrapped), 0n);
    elements.auctionShielded.textContent = formatUSDT(totalAuctionShielded);

    // Calculate Min, Max, Avg FDV for valid bids
    const activeBidders = list.filter(b => b.bidCount > 0);
    if (activeBidders.length > 0) {
        // We use latestBidFdv as a proxy for the user's bid price.
        const fdvs = activeBidders.map(b => b.latestBidFdv);
        const maxFdv = Math.max(...fdvs);
        const minFdv = Math.min(...fdvs);

        // Weighted Average by Bid Count? Or just average of latest bids?
        // "Avg Price" usually implies average price of all bids.
        // Since we don't have individual bids, we can estimate: Sum(latestFdv * bidCount) / TotalBids
        let weightedSum = 0;
        let totalBids = 0;
        activeBidders.forEach(b => {
            // Use avgBidFdv for weighted average calculation to be more accurate
            weightedSum += b.avgBidFdv * b.bidCount;
            totalBids += b.bidCount;
        });
        const avgFdv = totalBids > 0 ? weightedSum / totalBids : 0;

        if (elements.maxBidFdv) elements.maxBidFdv.textContent = '$' + maxFdv.toFixed(4);
        if (elements.minBidFdv) elements.minBidFdv.textContent = '$' + minFdv.toFixed(4);
        if (elements.avgBidFdv) elements.avgBidFdv.textContent = '$' + avgFdv.toFixed(4);
    } else {
        if (elements.maxBidFdv) elements.maxBidFdv.textContent = '-';
        if (elements.minBidFdv) elements.minBidFdv.textContent = '-';
        if (elements.avgBidFdv) elements.avgBidFdv.textContent = '-';
    }
}

function renderTable() {
    // --- Stats View Logic ---
    if (isStatsView) {
        elements.statsHeader.style.display = 'flex'; // Show canceled bids header

        // Let's prepare data for Table: Top 20 by Net Shielded (All walelts)
        let allData = Array.from(bidders.values());
        allData = allData.map(b => ({ ...b, netShielded: b.wrapped - b.unwrapped }));
        allData.sort((a, b) => {
            const valA = a.netShielded;
            const valB = b.netShielded;
            return valA > valB ? -1 : valA < valB ? 1 : 0; // Always descending by Net Shielded
        });

        const top20 = allData.slice(0, 20);

        // Update Header (Added Min/Max columns)
        elements.tableHead.innerHTML = `
            <tr>
                <th>Wallet Address</th>
                <th>Net Shielded</th>
                <th>Status</th>
                <th>Min FDV</th>
                <th>Max FDV</th>
                <th>Avg FDV</th>
                <th>OG NFT</th>
            </tr>
        `;

        // Check/Fetch NFTs
        const missingNftData = top20.filter(b => b.nftBalance === undefined).map(b => b.address);
        if (missingNftData.length > 0) {
            // Trigger fetch in background
            fetchNFTBalances(missingNftData);
        }

        // Render Body
        elements.tableBody.innerHTML = top20.map(b => {
            const hasBid = b.bidCount > 0;
            let nftDisplay = '<span style="color: grey">...</span>';
            if (b.nftBalance !== undefined && b.nftBalance !== 'fetching') {
                nftDisplay = b.nftBalance > 0
                    ? `<span style="color: #00FF94; font-weight: bold;">YES (${b.nftBalance})</span>`
                    : `<span style="color: #333;">NO</span>`;
            }

            return `
            <tr>
                <td class="wallet-address"><a href="https://etherscan.io/address/${b.address}" target="_blank">${truncateAddress(b.address)}</a></td>
                <td class="amount net-shielded">${formatUSDT(b.netShielded)}</td>
                <td class="status-cell">
                    <span class="status-badge ${hasBid ? 'active' : 'pending'}" style="font-size: 0.7rem; padding: 4px 8px;">
                        ${hasBid ? 'PLACED BID' : 'NO BID'}
                    </span>
                </td>
                <td class="amount fdv">${hasBid ? '$' + b.minBidFdv.toFixed(4) : '-'}</td>
                <td class="amount fdv">${hasBid ? '$' + b.maxBidFdv.toFixed(4) : '-'}</td>
                <td class="amount fdv">${hasBid ? '$' + b.avgBidFdv.toFixed(4) : '-'}</td>
                <td class="amount">${nftDisplay}</td>
            </tr>
            `;
        }).join('');

        elements.tableContainer.style.display = 'block';
        elements.emptyState.style.display = 'none';

        // Hide pagination in this view as it's a fixed top 20 list
        if (paginationContainer) paginationContainer.style.display = 'none';

        return;
    }

    // --- Standard View Logic ---
    elements.statsHeader.style.display = 'none';

    // Restore Standard Header
    elements.tableHead.innerHTML = `
        <tr>
            <th>Wallet Address</th>
            <th>Bids</th>
            <th>Bid FDV</th>
            <th>Avg Bid</th>
            <th>Last Bid</th>
            <th>Shielded</th>
            <th>Unshielded</th>
            <th>Net Shielded</th>
            <th>Actions</th>
        </tr>
    `;

    const search = elements.searchInput.value.toLowerCase();
    const sortBy = elements.sortBy.value;
    const sortOrder = elements.sortOrder.value;

    let data = Array.from(bidders.values()).filter(b => b.bidCount > 0);
    if (search) data = data.filter(b => b.address.toLowerCase().includes(search));

    data = data.map(b => ({ ...b, netShielded: b.wrapped - b.unwrapped }));
    data.sort((a, b) => {
        let valA, valB;
        switch (sortBy) {
            case 'wrapped': valA = a.wrapped; valB = b.wrapped; break;
            case 'unwrapped': valA = a.unwrapped; valB = b.unwrapped; break;
            case 'bids': valA = BigInt(a.bidCount); valB = BigInt(b.bidCount); break;
            case 'fdv': valA = a.latestBidFdv; valB = b.latestBidFdv; break;
            case 'time': valA = a.lastBidTime || 0; valB = b.lastBidTime || 0; break;
            default: valA = a.netShielded; valB = b.netShielded;
        }
        const cmp = valA > valB ? 1 : valA < valB ? -1 : 0;
        return sortOrder === 'desc' ? -cmp : cmp;
    });

    const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);
    if (currentPage > totalPages) currentPage = 1;

    const pageData = data.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    if (data.length === 0) {
        elements.tableContainer.style.display = 'none';
        elements.emptyState.style.display = 'flex';
        return;
    }

    elements.tableContainer.style.display = 'block';
    elements.emptyState.style.display = 'none';

    elements.tableBody.innerHTML = pageData.map(b => `
        <tr>
            <td class="wallet-address"><a href="https://etherscan.io/address/${b.address}" target="_blank">${truncateAddress(b.address)}</a></td>
            <td><span class="bid-count">${b.bidCount}</span></td>
            <td class="amount fdv">$${b.latestBidFdv.toFixed(4)}</td>
            <td class="amount fdv">$${b.avgBidFdv.toFixed(4)}</td>
            <td class="amount time">${formatRelativeTime(b.lastBidTime)}</td>
            <td class="amount">${formatUSDT(b.wrapped)}</td>
            <td class="amount ${b.unwrapped > 0n ? 'unshielded' : 'neutral'}">${formatUSDT(b.unwrapped)}</td>
            <td class="amount net-shielded">${formatUSDT(b.netShielded)}</td>
            <td><a class="action-btn" href="https://etherscan.io/address/${b.address}" target="_blank">VIEW</a></td>
        </tr>
    `).join('');
    updatePagination(totalPages);
}

function updatePagination(totalPages) {
    if (!paginationContainer) {
        paginationContainer = document.createElement('div');
        paginationContainer.className = 'pagination-controls';
        elements.tableContainer.appendChild(paginationContainer);
    }
    if (totalPages <= 1) { paginationContainer.style.display = 'none'; return; }
    paginationContainer.style.display = 'flex';
    paginationContainer.innerHTML = `
        <button class="btn btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(-1)">Previous</button>
        <span class="page-info">Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(1)">Next</button>
    `;
}

window.changePage = (delta) => { currentPage += delta; renderTable(); window.scrollTo({ top: 0, behavior: 'smooth' }); };

function renderBidDistribution() {
    const list = Array.from(bidders.values());
    if (!elements.chartSection || !elements.chartLegend) return;

    if (list.length === 0) { elements.chartSection.style.display = 'none'; return; }
    elements.chartSection.style.display = 'flex';

    // Original bucket definitions matching user's UI
    const buckets = {
        '< $0.01': { bids: 0, canceled: 0 },
        '$0.01 - $0.02': { bids: 0, canceled: 0 },
        '$0.02 - $0.03': { bids: 0, canceled: 0 },
        '$0.03 - $0.04': { bids: 0, canceled: 0 },
        '$0.04 - $0.05': { bids: 0, canceled: 0 },
        '$0.05 - $0.10': { bids: 0, canceled: 0 },
        '$0.10+': { bids: 0, canceled: 0 }
    };

    list.forEach(b => {
        if (b.bidCount === 0) return;

        const p = b.latestBidFdv;
        const count = b.bidCount;
        const canceled = b.canceledCount || 0;

        let bucketKey;
        if (p >= 0.10) bucketKey = '$0.10+';
        else if (p >= 0.05) bucketKey = '$0.05 - $0.10';
        else if (p >= 0.04) bucketKey = '$0.04 - $0.05';
        else if (p >= 0.03) bucketKey = '$0.03 - $0.04';
        else if (p >= 0.02) bucketKey = '$0.02 - $0.03';
        else if (p >= 0.01) bucketKey = '$0.01 - $0.02';
        else bucketKey = '< $0.01';

        if (bucketKey) {
            buckets[bucketKey].bids += count;
            buckets[bucketKey].canceled += canceled;
        }
    });

    const colors = ['#FFE600', '#E6CF00', '#00FF94', '#00E685', '#FFFFFF', '#E0E0E0', '#888888', '#333333'];
    elements.chartLegend.innerHTML = '<div style="color:#888888;font-family:JetBrains Mono;font-size:12px;font-weight:bold;margin-bottom:12px;">BID COUNT DISTRIBUTION // BY FDV PRICE ($)</div>';

    const grid = document.createElement('div');
    grid.className = 'distribution-grid';

    Object.entries(buckets).forEach(([key, data], i) => {
        if (data.bids > 0) {
            const card = document.createElement('div');
            card.className = 'range-card';
            card.style.borderLeftColor = colors[i % colors.length];

            let cancelHtml = '';
            if (data.canceled > 0) {
                cancelHtml = `<span class="cancel-count">-${data.canceled} canceled</span>`;
            }

            card.innerHTML = `<span class="range-label">${key}</span><span class="range-value">${data.bids}</span>${cancelHtml}`;
            grid.appendChild(card);
        }
    });
    elements.chartLegend.appendChild(grid);
}

// --- Utils ---
function formatUSDT(v) { return '$' + (Number(v) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function formatNumber(n) { return n.toLocaleString('en-US'); }
function formatDate(ts) { return new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function formatRelativeTime(ts) {
    if (!ts) return '-';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    const m = Math.floor(diff / 60000); if (m < 60) return m + 'm ago';
    const h = Math.floor(diff / 3600000); if (h < 24) return h + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
}
function truncateAddress(a) { return a.slice(0, 8) + '...' + a.slice(-6); }
function updateLastUpdated() {
    elements.lastUpdated.textContent = new Date().toLocaleTimeString();
}

function updateDataAge(timestamp) {
    if (!timestamp || !elements.dataAge) return;
    elements.dataAge.textContent = formatRelativeTime(timestamp).toUpperCase();
}
function debounce(f, w) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), w); }; }
