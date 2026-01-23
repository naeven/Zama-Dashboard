/**
 * Zama Auction Dashboard
 * Tracks bidders and their net shielded USDT amounts using Dune Analytics
 * Server-side data architecture - no client-side query execution
 */

// Configuration  
const ALCHEMY_HTTP_URL = 'https://eth-mainnet.g.alchemy.com/v2/wd-9XAJoEnMc8NWQXwT3Z';
const REFRESH_INTERVAL = 1800000; // 30 minutes - matches server cache TTL

// State
let bidders = new Map();
let auctionConfig = null;
let auctionState = null;
let isLoading = true;
let refreshTimeoutId = null;

// DOM Elements
const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    totalBidders: document.getElementById('totalBidders'),
    totalBids: document.getElementById('totalBids'),
    totalShielded: document.getElementById('totalShielded'),
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
    chartSection: document.querySelector('.chart-section'),
    chartLegend: document.getElementById('chartLegend')
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
    elements.sortOrder.addEventListener('change', renderTable);
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
        const response = await fetch('/api/dune');

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }

        const data = await response.json();

        // Process the rows
        if (data.rows && data.rows.length > 0) {
            processDuneResults(data.rows);
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
    const intervalMs = (nextRefreshSeconds || 1800) * 1000;

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

function processDuneResults(rows) {
    bidders.clear();
    for (const row of rows) {
        if (!row.bidder_address) continue;
        const address = String(row.bidder_address);
        bidders.set(address.toLowerCase(), {
            address: address,
            bidCount: parseInt(row.bid_count || 0),
            wrapped: BigInt(Math.floor(parseFloat(row.total_wrapped || 0) * 1e6)),
            unwrapped: BigInt(Math.floor(parseFloat(row.total_unwrapped || 0) * 1e6)),
            latestBidFdv: parseFloat(row.latest_bid_fdv || 0),
            lastBidTime: row.last_bid_time ? new Date(row.last_bid_time.replace(' UTC', 'Z').replace(' ', 'T')).getTime() : 0
        });
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
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
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
    elements.totalBidders.textContent = formatNumber(list.length);
    elements.totalBids.textContent = formatNumber(list.reduce((s, b) => s + b.bidCount, 0));
}

function renderTable() {
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
    if (list.length === 0) { elements.chartSection.style.display = 'none'; return; }
    elements.chartSection.style.display = 'flex';

    const buckets = { '$0.005 - $0.01': 0, '$0.01 - $0.025': 0, '$0.025 - $0.05': 0, '$0.05 - $0.10': 0, '$0.10 - $0.25': 0, '$0.25 - $0.50': 0, '$0.50 - $1.00': 0, '$1.00+': 0 };
    list.forEach(b => {
        const p = b.latestBidFdv;
        if (p >= 1.00) buckets['$1.00+']++; else if (p >= 0.50) buckets['$0.50 - $1.00']++; else if (p >= 0.25) buckets['$0.25 - $0.50']++; else if (p >= 0.10) buckets['$0.10 - $0.25']++; else if (p >= 0.05) buckets['$0.05 - $0.10']++; else if (p >= 0.025) buckets['$0.025 - $0.05']++; else if (p >= 0.01) buckets['$0.01 - $0.025']++; else if (p >= 0.005) buckets['$0.005 - $0.01']++;
    });

    const colors = ['#FFE600', '#E6CF00', '#00FF94', '#00E685', '#FFFFFF', '#E0E0E0', '#888888', '#333333'];
    elements.chartLegend.innerHTML = '<div style="color:#888888;font-family:JetBrains Mono;font-size:12px;font-weight:bold;margin-bottom:12px;">BID DISTRIBUTION // PRICE ($)</div>';
    const grid = document.createElement('div'); grid.className = 'distribution-grid';
    Object.entries(buckets).forEach(([key, val], i) => {
        if (val > 0) {
            const card = document.createElement('div'); card.className = 'range-card'; card.style.borderLeftColor = colors[i % colors.length];
            card.innerHTML = `<span class="range-label">${key}</span><span class="range-value">${val}</span>`;
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
