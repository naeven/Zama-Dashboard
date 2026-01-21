// Contract addresses
const CONTRACTS = {
    CUSDT_PROXY: '0xAe0207C757Aa2B4019AD96edD0092ddc63EF0c50',
    CUSDT_IMPLEMENTATION: '0x0309b4308A6AC121B9b3A960aC7Bc9bd8256cf38',
    AUCTION: '0x04a5b8C32f9c38092B008A4939f1F91D550C4345',
    USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7' // Mainnet USDT
};

// cUSDT Implementation ABI (relevant events/functions)
const CUSDT_ABI = [
    // Events
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "receiver", "type": "address"},
            {"indexed": false, "internalType": "euint64", "name": "encryptedAmount", "type": "bytes32"},
            {"indexed": false, "internalType": "uint64", "name": "cleartextAmount", "type": "uint64"}
        ],
        "name": "UnwrapFinalized",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "receiver", "type": "address"},
            {"indexed": false, "internalType": "euint64", "name": "amount", "type": "bytes32"}
        ],
        "name": "UnwrapRequested",
        "type": "event"
    },
    // Functions
    {
        "inputs": [{"internalType": "address", "name": "to", "type": "address"}, {"internalType": "uint256", "name": "amount", "type": "uint256"}],
        "name": "wrap",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "name",
        "outputs": [{"internalType": "string", "name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "symbol",
        "outputs": [{"internalType": "string", "name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "decimals",
        "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalSupply",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function"
    }
];

// Auction ABI (relevant events/functions)
const AUCTION_ABI = [
    // Events
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "uint256", "name": "bidId", "type": "uint256"},
            {"indexed": true, "internalType": "address", "name": "bidder", "type": "address"},
            {"indexed": false, "internalType": "euint64", "name": "eQuantity", "type": "bytes32"},
            {"indexed": false, "internalType": "uint64", "name": "price", "type": "uint64"},
            {"indexed": false, "internalType": "euint64", "name": "ePaid", "type": "bytes32"}
        ],
        "name": "BidSubmitted",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "uint256", "name": "bidId", "type": "uint256"},
            {"indexed": true, "internalType": "address", "name": "bidder", "type": "address"},
            {"indexed": false, "internalType": "euint64", "name": "eRefund", "type": "bytes32"}
        ],
        "name": "BidCanceled",
        "type": "event"
    },
    // View functions
    {
        "inputs": [],
        "name": "auctionConfig",
        "outputs": [
            {"internalType": "uint256", "name": "startAuctionTime", "type": "uint256"},
            {"internalType": "uint256", "name": "endAuctionTime", "type": "uint256"},
            {"internalType": "uint64", "name": "zamaTokenSupply", "type": "uint64"},
            {"internalType": "uint64", "name": "maxCumulativeBidQuantity", "type": "uint64"},
            {"internalType": "address", "name": "zamaTokenAddress", "type": "address"},
            {"internalType": "address", "name": "zamaTreasuryAddress", "type": "address"},
            {"internalType": "address", "name": "complianceAddress", "type": "address"},
            {"internalType": "address", "name": "kycAllowlistRegistryAddress", "type": "address"},
            {"internalType": "address", "name": "paymentTokenAddress", "type": "address"},
            {"internalType": "uint256", "name": "walletCount", "type": "uint256"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "auctionState",
        "outputs": [
            {"internalType": "uint64", "name": "settlementPrice", "type": "uint64"},
            {"internalType": "uint64", "name": "unallocatedZamaSupply", "type": "uint64"},
            {"internalType": "uint64", "name": "lastBidId", "type": "uint64"},
            {"internalType": "uint64", "name": "totalNumberOfUsers", "type": "uint64"},
            {"internalType": "bool", "name": "zamaTokenReceived", "type": "bool"},
            {"internalType": "bool", "name": "settlementOpen", "type": "bool"},
            {"internalType": "bool", "name": "claimingOpen", "type": "bool"},
            {"internalType": "bool", "name": "auctionCanceled", "type": "bool"}
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "totalNumberOfBids",
        "outputs": [{"internalType": "uint64", "name": "", "type": "uint64"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "FLOOR_PRICE_VALUE",
        "outputs": [{"internalType": "uint64", "name": "", "type": "uint64"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "MAX_PRICE_VALUE",
        "outputs": [{"internalType": "uint64", "name": "", "type": "uint64"}],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{"internalType": "uint256", "name": "bidId", "type": "uint256"}],
        "name": "getBid",
        "outputs": [
            {
                "components": [
                    {"internalType": "uint256", "name": "bidId", "type": "uint256"},
                    {"internalType": "euint64", "name": "eQuantity", "type": "bytes32"},
                    {"internalType": "euint64", "name": "ePaid", "type": "bytes32"},
                    {"internalType": "address", "name": "bidder", "type": "address"},
                    {"internalType": "uint64", "name": "price", "type": "uint64"},
                    {"internalType": "bool", "name": "externalBid", "type": "bool"},
                    {"internalType": "bool", "name": "canceled", "type": "bool"},
                    {"internalType": "bool", "name": "allocated", "type": "bool"},
                    {"internalType": "uint64", "name": "createdAt", "type": "uint64"},
                    {"internalType": "uint64", "name": "canceledAt", "type": "uint64"}
                ],
                "internalType": "struct IAuctionToken.Bid",
                "name": "",
                "type": "tuple"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];

// ERC20 Transfer event ABI for tracking USDT transfers
const ERC20_TRANSFER_ABI = [
    {
        "anonymous": false,
        "inputs": [
            {"indexed": true, "internalType": "address", "name": "from", "type": "address"},
            {"indexed": true, "internalType": "address", "name": "to", "type": "address"},
            {"indexed": false, "internalType": "uint256", "name": "value", "type": "uint256"}
        ],
        "name": "Transfer",
        "type": "event"
    }
];
