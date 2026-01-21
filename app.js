/**
 * Zama Auction Dashboard
 * Tracks bidders and their net shielded USDT amounts using Dune Analytics
 */

// Configuration  
const ALCHEMY_HTTP_URL = 'https://eth-mainnet.g.alchemy.com/v2/wd-9XAJoEnMc8NWQXwT3Z';
// Embedded Credentials for Public Deployment
const DUNE_API_KEY = 'vWnN5GqG2MA2nR4PAA0ICL68oBpiGD9g';
const DUNE_QUERY_ID = '6574674';

// Optimization Logic
const DUNE_CREDITS_REMAINING = 712; // Snapshot as of jan 2025
const COST_PER_QUERY = 10;
const SAFETY_FACTOR = 0.85; // Use 85% of credits
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
    bidChartCanvas: document.getElementById('bidChart'),
    chartSection: document.querySelector('.chart-section'),
    chartLegend: document.getElementById('chartLegend'),
    paginationContainer: null // Will be created dynamically
};

// Pagination State
let currentPage = 1;
const ITEMS_PER_PAGE = 50;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
    setupEventListeners();
    setupEventListeners();
    // initChart removed
    await loadInitialData();
    fetchTVS(); // Fetch global TVS independently
}

function setupEventListeners() {
    elements.refreshBtn.addEventListener('click', refresh);
    elements.searchInput.addEventListener('input', debounce(renderTable, 300));
    elements.sortBy.addEventListener('change', renderTable);
    elements.sortOrder.addEventListener('change', renderTable);
}

// Data Fetching
async function loadInitialData() {
    try {
        setLoading(true, 'Fetching latest data...');
        await fetchAuctionInfo();
        // fetchTVS is called in init()

        // 1. Fetch latest cached results immediately
        // This returns the data + metadata like execution timestamp
        const cachedData = await fetchLatestDuneResults(DUNE_API_KEY, DUNE_QUERY_ID);

        updateConnectionStatus('connected');

        // 2. Check if data is stale (older than 5 minutes)
        const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
        const lastExecution = new Date(cachedData.execution_ended_at).getTime();
        const now = Date.now();
        const age = now - lastExecution;

        console.log(`Data age: ${Math.round(age / 1000)}s`);

        if (age > STALE_THRESHOLD) {
            console.log('Data is stale, refreshing in background...');
            refreshInBackground();
        } else {
            console.log('Data is fresh enough, skipping background refresh.');
            scheduleNextRefresh(); // Schedule next
        }

    } catch (e) {
        console.error(e);
        // If cache fetch fails, try full execution
        setLoading(true, `Error getting cache, retrying full fetch...`);
        try {
            await executeDuneQuery(DUNE_API_KEY, DUNE_QUERY_ID);
            updateConnectionStatus('connected');
        } catch (err) {
            setLoading(true, `Error: ${err.message}`);
            updateConnectionStatus('error');
        }
    }
}

async function refreshInBackground() {
    console.log('Starting background refresh...');
    elements.lastUpdated.textContent = 'Updating...';
    try {
        await executeDuneQuery(DUNE_API_KEY, DUNE_QUERY_ID);
    } catch (e) {
        console.warn('Background refresh failed:', e);
    }
    // Always schedule next attempt
    scheduleNextRefresh();
}

function scheduleNextRefresh() {
    if (!auctionConfig) {
        console.warn('Auction config missing, using fallback interval.');
        setTimeout(refreshInBackground, FALLBACK_INTERVAL);
        return;
    }

    const now = Date.now();
    const endTime = auctionConfig.endAuctionTime * 1000;
    const remainingTime = endTime - now;

    if (remainingTime <= 0) {
        console.log('Auction ended. Stopping auto-refresh.');
        return;
    }

    // Calculation:
    // Available Credits = 712 * 0.85 = 605
    // Queries Allowed = 605 / 10 = 60
    // Interval = RemainingTime / 60

    const safeCredits = DUNE_CREDITS_REMAINING * SAFETY_FACTOR;
    const allowedQueries = Math.floor(safeCredits / COST_PER_QUERY);

    // If no queries allowed, stop or use very long interval? 
    // Let's assume at least 1 to be safe, or just stop.
    if (allowedQueries <= 0) {
        console.warn('Insufficient credits calculated for auto-refresh.');
        return;
    }

    let calculatedInterval = Math.floor(remainingTime / allowedQueries);

    // Enforce limits
    if (calculatedInterval < MIN_REFRESH_INTERVAL) {
        calculatedInterval = MIN_REFRESH_INTERVAL;
    }

    console.log(`Auto-Refresh Scheduled:
        Remaining Time: ${(remainingTime / 3600000).toFixed(2)}h
        Allowed Queries: ${allowedQueries}
        Calculated Interval: ${(calculatedInterval / 60000).toFixed(1)}m
    `);

    setTimeout(refreshInBackground, calculatedInterval);
}

async function fetchLatestDuneResults(apiKey, queryId) {
    const resp = await fetch(`https://api.dune.com/api/v1/query/${queryId}/results`, {
        headers: { 'X-Dune-Api-Key': apiKey }
    });

    if (!resp.ok) {
        throw new Error('No cached results available');
    }

    const data = await resp.json();
    if (data.result && data.result.rows) {
        processDuneResults(data.result.rows);
    }
    return data;
}

async function executeDuneQuery(apiKey, queryId) {
    // 1. Execute Query
    const executeResp = await fetch(`https://api.dune.com/api/v1/query/${queryId}/execute`, {
        method: 'POST',
        headers: { 'X-Dune-Api-Key': apiKey }
    });

    if (!executeResp.ok) {
        const err = await executeResp.json();
        throw new Error(err.error || 'Failed to execute Dune query');
    }

    const executeData = await executeResp.json();
    const executionId = executeData.execution_id;

    // 2. Poll for Results
    let attempts = 0;
    while (attempts < 60) {
        attempts++;
        // Do not update main loading screen if we have data
        if (bidders.size === 0) {
            setLoading(true, `Waiting for Dune results... (${attempts * 2}s)`);
        } else {
            // Maybe update status text slightly?
            elements.lastUpdated.textContent = `Updating... (${attempts * 2}s)`;
        }

        await new Promise(r => setTimeout(r, 2000));

        const statusResp = await fetch(`https://api.dune.com/api/v1/execution/${executionId}/results`, {
            headers: { 'X-Dune-Api-Key': apiKey }
        });

        if (!statusResp.ok) throw new Error('Failed to check execution status');

        const statusData = await statusResp.json();

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
    console.log('Processing Dune rows:', rows.length);

    for (const row of rows) {
        if (!row.bidder_address) continue;

        const address = String(row.bidder_address);
        const addrLower = address.toLowerCase();

        bidders.set(addrLower, {
            address: address,
            bidCount: parseInt(row.bid_count || 0),
            wrapped: BigInt(Math.floor(parseFloat(row.total_wrapped || 0) * 1e6)),
            unwrapped: BigInt(Math.floor(parseFloat(row.total_unwrapped || 0) * 1e6)),
            latestBidFdv: parseFloat(row.latest_bid_fdv || 0),
            // Dune returns "YYYY-MM-DD HH:MM:SS.SSS UTC". Convert to ISO "YYYY-MM-DDTHH:MM:SS.SSSZ"
            lastBidTime: row.last_bid_time ? new Date(row.last_bid_time.replace(' UTC', 'Z').replace(' ', 'T')).getTime() : 0
        });
    }

    updateStats();
    renderBidDistribution();
    renderTable();
    updateLastUpdated();
    setLoading(false); // Ensure loading is cleared when data arrives
}

async function fetchAuctionInfo() {
    try {
        const configData = await rpcCall('eth_call', [{
            to: CONTRACTS.AUCTION,
            data: ethers.id('auctionConfig()').slice(0, 10)
        }, 'latest']);

        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const decoded = abiCoder.decode(
            ['uint256', 'uint256', 'uint64', 'uint64', 'address', 'address', 'address', 'address', 'address', 'uint256'],
            configData
        );

        auctionConfig = {
            startAuctionTime: Number(decoded[0]),
            endAuctionTime: Number(decoded[1]),
            zamaTokenSupply: decoded[2]
        };

        const stateData = await rpcCall('eth_call', [{
            to: CONTRACTS.AUCTION,
            data: ethers.id('auctionState()').slice(0, 10)
        }, 'latest']);

        const stateDecoded = abiCoder.decode(
            ['uint64', 'uint64', 'uint64', 'uint64', 'bool', 'bool', 'bool', 'bool'],
            stateData
        );

        auctionState = {
            settlementPrice: stateDecoded[0],
            auctionCanceled: stateDecoded[7]
        };

        updateAuctionInfo();
        updateAuctionInfo();
    } catch (e) {
        console.warn('Could not fetch auction info:', e);
    }
}

async function fetchTVS() {
    try {
        // balanceOf(CUSDT_PROXY) on USDT contract
        const data = await rpcCall('eth_call', [{
            to: CONTRACTS.USDT,
            data: '0x70a08231' + CONTRACTS.CUSDT_PROXY.slice(2).padStart(64, '0')
        }, 'latest']);

        const balance = BigInt(data);
        elements.totalShielded.textContent = formatUSDT(balance);
    } catch (e) {
        console.warn('Failed to fetch TVS:', e);
    }
}

const CONTRACTS = {
    AUCTION: '0x04a5b8C32f9c38092B008A4939f1F91D550C4345',
    CUSDT_PROXY: '0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7'
};

async function rpcCall(method, params) {
    const response = await fetch(ALCHEMY_HTTP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: method,
            params: params
        })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    return data.result;
}

// UI Updates
function setLoading(loading, status = '') {
    isLoading = loading;

    if (loading) {
        // Only block UI if we have absolutely no data to show
        if (bidders.size === 0) {
            elements.loadingContainer.style.display = 'flex';
            elements.tableContainer.style.display = 'none';
            if (status) elements.loadingStatus.textContent = status;
        } else {
            // Background update mode - keep table visible
            elements.loadingContainer.style.display = 'none';
            elements.tableContainer.style.display = 'block';
        }
    } else {
        // Not loading
        elements.loadingContainer.style.display = 'none';
        elements.tableContainer.style.display = 'block';
    }
}

function updateConnectionStatus(status) {
    elements.connectionStatus.className = 'connection-status ' + status;
    const statusText = {
        connected: 'Connected',
        disconnected: 'Disconnected',
        error: 'Error'
    };
    elements.connectionStatus.querySelector('.status-text').textContent = statusText[status] || 'Connecting...';
}

function updateAuctionInfo() {
    if (!auctionConfig) return;

    elements.auctionStart.textContent = formatDate(auctionConfig.startAuctionTime * 1000);
    elements.auctionEnd.textContent = formatDate(auctionConfig.endAuctionTime * 1000);
    elements.tokenSupply.textContent = formatNumber(Number(auctionConfig.zamaTokenSupply) / 1e6) + 'M ZAMA';

    const now = Date.now();
    const start = auctionConfig.startAuctionTime * 1000;
    const end = auctionConfig.endAuctionTime * 1000;

    if (auctionState?.auctionCanceled) {
        elements.auctionStatus.textContent = 'Canceled';
        elements.auctionStatus.className = 'info-value status-badge ended';
    } else if (now < start) {
        elements.auctionStatus.textContent = 'Not Started';
        elements.auctionStatus.className = 'info-value status-badge pending';
    } else if (now >= start && now < end) {
        elements.auctionStatus.textContent = 'Active';
        elements.auctionStatus.className = 'info-value status-badge active';
    } else {
        elements.auctionStatus.textContent = 'Ended';
        elements.auctionStatus.className = 'info-value status-badge ended';
    }
}

function updateStats() {
    const allBidders = Array.from(bidders.values());
    const totalBidCount = allBidders.reduce((sum, b) => sum + b.bidCount, 0);

    elements.totalBidders.textContent = formatNumber(allBidders.length);
    elements.totalBids.textContent = formatNumber(totalBidCount);
}

function renderTable() {
    const search = elements.searchInput.value.toLowerCase();
    const sortBy = elements.sortBy.value;
    const sortOrder = elements.sortOrder.value;

    let data = Array.from(bidders.values()).filter(b => b.bidCount > 0);

    if (search) {
        data = data.filter(b => b.address.toLowerCase().includes(search));
    }

    data = data.map(b => ({
        ...b,
        netShielded: b.wrapped - b.unwrapped
    }));

    data.sort((a, b) => {
        let valA, valB;
        switch (sortBy) {
            case 'wrapped':
                valA = a.wrapped; valB = b.wrapped;
                break;
            case 'unwrapped':
                valA = a.unwrapped; valB = b.unwrapped;
                break;
            case 'bids':
                valA = BigInt(a.bidCount); valB = BigInt(b.bidCount);
                break;
            case 'fdv':
                valA = a.latestBidFdv; valB = b.latestBidFdv;
                break;
            case 'time':
                valA = a.lastBidTime || 0; valB = b.lastBidTime || 0;
                break;
            default:
                valA = a.netShielded; valB = b.netShielded;
        }
        const cmp = valA > valB ? 1 : valA < valB ? -1 : 0;
        return sortOrder === 'desc' ? -cmp : cmp;
    });

    const totalPages = Math.ceil(data.length / ITEMS_PER_PAGE);

    // Ensure current page is valid
    if (currentPage > totalPages) currentPage = 1;
    if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const itemsToShow = data.slice(startIndex, endIndex);

    if (data.length === 0) {
        elements.tableContainer.style.display = 'none';
        elements.emptyState.style.display = 'flex';
        updatePaginationControls(0);
        return;
    }

    elements.tableContainer.style.display = 'block';
    elements.emptyState.style.display = 'none';

    elements.tableBody.innerHTML = itemsToShow.map((b, i) => `
        <tr>
            <td class="wallet-address">
                <a href="https://etherscan.io/address/${b.address}" target="_blank" rel="noopener">
                    ${truncateAddress(b.address)}
                </a>
            </td>
            <td><span class="bid-count">${b.bidCount}</span></td>
            <td class="amount fdv">$${b.latestBidFdv.toFixed(4)}</td>
            <td class="amount time">${formatRelativeTime(b.lastBidTime)}</td>
            <td class="amount">${formatUSDT(b.wrapped)}</td>
            <td class="amount ${b.unwrapped > 0n ? 'unshielded' : 'neutral'}">${formatUSDT(b.unwrapped)}</td>
            <td class="amount net-shielded">
                ${formatUSDT(b.netShielded)}
            </td>
            <td>
                <a class="action-btn" href="https://etherscan.io/address/${b.address}" target="_blank" rel="noopener">
                    VIEW
                </a>
            </td>
        </tr>
    `).join('');

    updatePaginationControls(totalPages);
}

function updatePaginationControls(totalPages) {
    if (!elements.paginationContainer) {
        // Create container if not exists
        const container = document.createElement('div');
        container.className = 'pagination-controls';
        elements.tableContainer.appendChild(container);
        elements.paginationContainer = container;
    }

    if (totalPages <= 1) {
        elements.paginationContainer.style.display = 'none';
        return;
    }

    elements.paginationContainer.style.display = 'flex';
    elements.paginationContainer.innerHTML = `
        <button class="btn btn-secondary" ${currentPage === 1 ? 'disabled' : ''} onclick="changePage(-1)">
            Preview
        </button>
        <span class="page-info">Page ${currentPage} of ${totalPages}</span>
        <button class="btn btn-secondary" ${currentPage === totalPages ? 'disabled' : ''} onclick="changePage(1)">
            Next
        </button>
    `;
}

// Global scope for onclick
window.changePage = function (delta) {
    currentPage += delta;
    renderTable();
    // Scroll to top of table
    elements.tableContainer.scrollIntoView({ behavior: 'smooth' });
};

function updateLastUpdated() {
    elements.lastUpdated.textContent = new Date().toLocaleTimeString();
}

async function refresh() {
    elements.refreshBtn.disabled = true;
    try {
        await executeDuneQuery(DUNE_API_KEY, DUNE_QUERY_ID);
    } catch (e) {
        console.error('Manual refresh failed:', e);
        alert('Refresh failed: ' + e.message);
    }
    elements.refreshBtn.disabled = false;
}

// Formatting Helpers
function formatUSDT(value) {
    const num = Number(value) / 1e6;
    return '$' + num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNumber(num) {
    return num.toLocaleString('en-US');
}

function formatDate(timestamp) {
    return new Date(timestamp).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatRelativeTime(timestamp) {
    if (!timestamp) return '-';
    const now = Date.now();
    const diff = now - timestamp;

    // Adjust for basic timezone offsets if needed, but Dune usually gives UTC
    // Assuming timestamp is correct UTC

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'Just now';
}

function truncateAddress(address) {
    return address.slice(0, 8) + '...' + address.slice(-6);
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// Distribution List Logic (Replaces Chart)
function renderBidDistribution() {
    const allBidders = Array.from(bidders.values());
    if (allBidders.length === 0) {
        elements.chartSection.style.display = 'none';
        return;
    }

    elements.chartSection.style.display = 'flex';

    // Buckets
    const buckets = {
        '$0.005 - $0.01': 0,
        '$0.01 - $0.025': 0,
        '$0.025 - $0.05': 0,
        '$0.05 - $0.10': 0,
        '$0.10 - $0.25': 0,
        '$0.25 - $0.50': 0,
        '$0.50 - $1.00': 0,
        '$1.00+': 0
    };

    allBidders.forEach(b => {
        const p = b.latestBidFdv;
        if (p >= 1.00) buckets['$1.00+']++;
        else if (p >= 0.50) buckets['$0.50 - $1.00']++;
        else if (p >= 0.25) buckets['$0.25 - $0.50']++;
        else if (p >= 0.10) buckets['$0.10 - $0.25']++;
        else if (p >= 0.05) buckets['$0.05 - $0.10']++;
        else if (p >= 0.025) buckets['$0.025 - $0.05']++;
        else if (p >= 0.01) buckets['$0.01 - $0.025']++;
        else if (p >= 0.005) buckets['$0.005 - $0.01']++;
    });

    // Zama Theme Colors
    const colors = [
        '#FFE600', // Zama Yellow
        '#E6CF00',
        '#00FF94', // Tech Green
        '#00E685',
        '#FFFFFF', // White
        '#E0E0E0',
        '#888888', // Grey
        '#333333'  // Dark Grey
    ];
    let colorIndex = 0;

    // Container now acts as a horizontal grid/flex-row
    const container = elements.chartLegend;
    container.innerHTML = '';

    // Optional section title if not already present in HTML
    if (!document.getElementById('distTitle')) {
        const titleDiv = document.createElement('div');
        titleDiv.id = 'distTitle';
        titleDiv.innerText = 'BID DISTRIBUTION // PRICE ($)';
        titleDiv.style.width = '100%';
        titleDiv.style.marginBottom = '12px';
        titleDiv.style.color = '#888888';
        titleDiv.style.fontFamily = "'JetBrains Mono', monospace";
        titleDiv.style.fontSize = '12px';
        titleDiv.style.fontWeight = 'bold';
        container.appendChild(titleDiv);
    }

    // Create a wrapper for the cards to keep title separate if using flex wrap
    const cardsWrapper = document.createElement('div');
    cardsWrapper.className = 'distribution-grid';
    container.appendChild(cardsWrapper);

    for (const [key, value] of Object.entries(buckets)) {
        if (value > 0) {
            const color = colors[colorIndex % colors.length];
            const item = document.createElement('div');
            item.className = 'range-card';

            // Set left border color
            item.style.borderLeftColor = color;

            item.innerHTML = `
                <span class="range-label">${key}</span>
                <span class="range-value">${value}</span>
            `;

            cardsWrapper.appendChild(item);
            colorIndex++;
        }
    }
}
// Old functions removed: initChart, updateChart, generateCustomLegend


