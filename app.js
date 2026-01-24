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
    chartSection: document.querySelector('.chart-section'),
    chartSection: document.querySelector('.chart-section'),
    chartLegend: document.getElementById('chartLegend'),
    statsToggle: document.getElementById('statsToggle'),
    statsHeader: document.getElementById('statsHeader'),
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
// ... (skip data fetching unchanged) ...

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

        // Update Header
        elements.tableHead.innerHTML = `
            <tr>
                <th>Wallet Address</th>
                <th>Net Shielded</th>
                <th>Status</th>
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
                <td class="amount fdv">${hasBid ? '$' + b.latestBidFdv.toFixed(4) : '-'}</td>
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
    if (list.length === 0) { elements.chartSection.style.display = 'none'; return; }
    elements.chartSection.style.display = 'flex';

    const buckets = { '$0.005 - $0.01': 0, '$0.01 - $0.025': 0, '$0.025 - $0.05': 0, '$0.05 - $0.10': 0, '$0.10 - $0.25': 0, '$0.25 - $0.50': 0, '$0.50 - $1.00': 0, '$1.00+': 0 };
    list.forEach(b => {
        // Only count active bidders
        if (b.bidCount === 0) return;

        const p = b.latestBidFdv;
        const count = b.bidCount;
        if (p >= 1.00) buckets['$1.00+'] += count;
        else if (p >= 0.50) buckets['$0.50 - $1.00'] += count;
        else if (p >= 0.25) buckets['$0.25 - $0.50'] += count;
        else if (p >= 0.10) buckets['$0.10 - $0.25'] += count;
        else if (p >= 0.05) buckets['$0.05 - $0.10'] += count;
        else if (p >= 0.025) buckets['$0.025 - $0.05'] += count;
        else if (p >= 0.01) buckets['$0.01 - $0.025'] += count;
        else if (p >= 0.005) buckets['$0.005 - $0.01'] += count;
    });

    const colors = ['#FFE600', '#E6CF00', '#00FF94', '#00E685', '#FFFFFF', '#E0E0E0', '#888888', '#333333'];
    elements.chartLegend.innerHTML = '<div style="color:#888888;font-family:JetBrains Mono;font-size:12px;font-weight:bold;margin-bottom:12px;">BID COUNT DISTRIBUTION // BY FDV PRICE ($)</div>';
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
