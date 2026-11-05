import dotenv from 'dotenv';
dotenv.config();

const currentVersionParsed = parseInt(process.env.CURRENT_ENCRYPTION_KEY_VERSION || '1', 10);
if (isNaN(currentVersionParsed)) {
    throw new Error('CURRENT_ENCRYPTION_KEY_VERSION must be a valid number');
}

if (!process.env.SEP10_SERVER_SECRET) {
    throw new Error('SEP10_SERVER_SECRET environment variable is required');
}
if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
}

export const config = {
    PORT: process.env.PORT || 3000,
    WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN || '',
    WHATSAPP_PHONE_NUMBER_ID: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET || '',
    VERIFY_TOKEN: process.env.VERIFY_TOKEN || 'kolo_verify_token',
    DATABASE_URL: process.env.DATABASE_URL || '',
    STELLAR_NETWORK: process.env.STELLAR_NETWORK || 'TESTNET', // TESTNET or PUBLIC
    REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || '', // Must be a 32-byte hex string
    CURRENT_ENCRYPTION_KEY_VERSION: currentVersionParsed,
    ENCRYPTION_KEYS: {
        1: process.env.ENCRYPTION_KEY_V1 || process.env.ENCRYPTION_KEY || '',
        2: process.env.ENCRYPTION_KEY_V2 || '',
        3: process.env.ENCRYPTION_KEY_V3 || '',
    } as Record<number, string>,
    HMAC_KEY: process.env.HMAC_KEY || '', // Must be a 32-byte hex string, different from ENCRYPTION_KEY
    USDC_ISSUER_PUBLIC_KEY: process.env.USDC_ISSUER_PUBLIC_KEY || '', // SDF testnet issuer or Circle/centre.io mainnet issuer, depending on STELLAR_NETWORK
    SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org',
    CONTRACT_WASM_PATH: process.env.CONTRACT_WASM_PATH || 'contracts/savings_group.wasm',
    // Also the on-chain admin for every deployed group's contract (see
    // SorobanService.deployGroupContract) — PayoutService and
    // GroupExitService sign payout()/remove_member()/reset_cycle() calls
    // with this same identity, since the contract's admin.require_auth
    // checks must match whoever initialize() registered as admin.
    DEPLOYER_SECRET_KEY: process.env.DEPLOYER_SECRET_KEY || '',
    // Deliberately empty by default: the token contract is network/environment
    // specific and must be supplied explicitly rather than using a malformed
    // placeholder that fails only when a group is deployed.
    USDC_TOKEN_ADDRESS: process.env.USDC_TOKEN_ADDRESS || '',
    MAX_PAYOUT_DEADLINE_EXTENSIONS: parseInt(process.env.MAX_PAYOUT_DEADLINE_EXTENSIONS || '2', 10),
    SEP10_SERVER_SECRET: process.env.SEP10_SERVER_SECRET,
    SEP10_HOME_DOMAIN: process.env.SEP10_HOME_DOMAIN || 'localhost',
    JWT_SECRET: process.env.JWT_SECRET,
    SEP10_CHALLENGE_TTL_SECONDS: parseInt(process.env.SEP10_CHALLENGE_TTL_SECONDS || '300', 10),
};

