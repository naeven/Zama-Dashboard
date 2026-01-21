/**
 * Zama Auction Dashboard
 * Tracks bidders and their net shielded USDT amounts using Dune Analytics
 */

// Configuration  
const ALCHEMY_HTTP_URL = 'https://eth-mainnet.g.alchemy.com/v2/wd-9XAJoEnMc8NWQXwT3Z';
const DUNE_QUERY_ID = '6574674';

// Optimization Logic
const DUNE_CREDITS_REMAINING = 1600;
const COST_PER_QUERY = 10;
const SAFETY_FACTOR = 0.85; // 15% safety factor (uses 85% of credits)
const MIN_REFRESH_INTERVAL = 300000; // Min 5 mins
const FALLBACK_INTERVAL = 3600000; // 1 hour if calculation fails

// State
let bidders = new Map();
let auctionConfig = null;
let auctionState = null;
let isLoading = true;

// DOM Elements
const elements = {
    connectionStatus: document.getElementById('connectionStatus'),
    refreshBtn: document.getElementById('refreshBtn'),
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
    elements.refreshBtn.addEventListener('click', refresh);
    elements.searchInput.addEventListener('input', debounce(renderTable, 300));
    elements.sortBy.addEventListener('change', renderTable);
    elements.sortOrder.addEventListener('change', renderTable);
}

// --- Data Fetching ---

async function loadInitialData() {
    try {
        setLoading(true, 'Fetching latest data...');
        await fetchAuctionInfo();

        // 1. Fetch latest cached results via Proxy
        const cachedData = await fetchLatestDuneResults(DUNE_QUERY_ID);
        updateConnectionStatus('connected');

        // 2. Check stale/schema
        const STALE_THRESHOLD = 5 * 60 * 1000;
        const lastExecution = new Date(cachedData.execution_ended_at).getTime();
        const now = Date.now();
        const age = now - lastExecution;

        const rows = cachedData.result?.rows || [];
        const hasTimeColumn = rows[0] && (rows[0].last_bid_time !== undefined);

        if (rows.length > 0 && !hasTimeColumn) {
            console.log('Cache missing new columns, forcing refresh...');
            refreshInBackground();
        } else if (age > STALE_THRESHOLD) {
            console.log('Data is stale, refreshing in background...');
            refreshInBackground();
        } else {
            console.log('Data is fresh enough, skipping background refresh.');
            scheduleNextRefresh();
        }

    } catch (e) {
        console.error(e);
        setLoading(true, `Error getting cache, retrying full fetch...`);
        try {
            await executeDuneQuery();
            updateConnectionStatus('connected');
        } catch (err) {
            setLoading(true, `Error: ${err.message}`);
            updateConnectionStatus('error');
        }
    }
}

async function refresh() {
    if (isLoading) return;
    try {
        setLoading(true, 'Refreshing data...');
        await fetchAuctionInfo();
        fetchTVS();
        await executeDuneQuery();
    } catch (e) {
        console.error(e);
        alert('Refresh failed: ' + e.message);
    } finally {
        setLoading(false);
    }
}

async function refreshInBackground() {
    console.log('Starting background refresh...');
    elements.lastUpdated.textContent = 'Updating...';
    try {
        await executeDuneQuery();
    } catch (e) {
        console.warn('Background refresh failed:', e);
    }
    scheduleNextRefresh();
}

function scheduleNextRefresh() {
    if (!auctionConfig) {
        setTimeout(refreshInBackground, FALLBACK_INTERVAL);
        return;
    }

    const now = Date.now();
    const endTime = auctionConfig.endAuctionTime * 1000;
    const remainingTime = endTime - now;

    if (remainingTime <= 0) return;

    const safeCredits = DUNE_CREDITS_REMAINING * SAFETY_FACTOR;
    const allowedQueries = Math.floor(safeCredits / COST_PER_QUERY);

    if (allowedQueries <= 0) return;

    let calculatedInterval = Math.floor(remainingTime / allowedQueries);
    if (calculatedInterval < MIN_REFRESH_INTERVAL) calculatedInterval = MIN_REFRESH_INTERVAL;

    setTimeout(refreshInBackground, calculatedInterval);
}

// --- Dune Proxy Helpers ---

async function fetchDuneData(endpoint, options = {}) {
    // Vercel Proxy URL
    const url = `/api/dune?endpoint=${encodeURIComponent(endpoint)}`;
    const resp = await fetch(url, options);

    if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Dune Proxy Error');
    }
    return await resp.json();
}

async function fetchLatestDuneResults(queryId) {
    const data = await fetchDuneData(`query/${queryId}/results`);
    if (data.result && data.result.rows) {
        processDuneResults(data.result.rows);
    }
    return data;
}

async function executeDuneQuery() {
    const executeData = await fetchDuneData(`query/${DUNE_QUERY_ID}/execute`, { method: 'POST' });
    const executionId = executeData.execution_id;

    let attempts = 0;
    while (attempts < 60) {
        attempts++;
        if (bidders.size === 0) {
            setLoading(true, `Waiting for Dune results... (${attempts * 2}s)`);
        } else {
            elements.lastUpdated.textContent = `Updating... (${attempts * 2}s)`;
        }

        await new Promise(r => setTimeout(r, 2000));

        const statusData = await fetchDuneData(`execution/${executionId}/results`);

        if (statusData.state === 'QUERY_STATE_COMPLETED') {
            processDuneResults(statusData.result.rows);
            setLoading(false);
            return;
        } else if (statusData.state === 'QUERY_STATE_FAILED') {
            throw new Error(`Dune Query Failed: ${statusData.error || 'Unknown error'}`);
        }
    }
    throw new Error('Dune query timed out');
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
    updateLastUpdated();
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
function updateLastUpdated() { elements.lastUpdated.textContent = new Date().toLocaleTimeString(); }
function debounce(f, w) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => f(...a), w); }; }
