import { MessageProcessor } from '../services/message-processor.service';
import { GroupExitError } from '../services/group-exit.service';

// Mock locale.service so tests never depend on i18next initialisation.
// t() returns "<key>|<serialised-params>" making assertions precise and language-agnostic.
jest.mock('../services/locale.service', () => ({
    t: (key: string, _lang: string, params?: Record<string, string | number>) => {
        const paramStr = params ? '|' + JSON.stringify(params) : '';
        return `${key}${paramStr}`;
    },
    loadLocale: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../lib/redis', () => ({
    redisClient: {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn()
    }
}));
const { redisClient } = require('../lib/redis');
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSet = redisClient.set as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;


const mockSendMessage = jest.fn().mockResolvedValue(true);
const mockCheckBalance = jest.fn().mockResolvedValue([
    { assetCode: 'XLM', issuer: '', balance: '100.50' },
    { assetCode: 'USDC', issuer: 'G_USDC_ISSUER', balance: '50.00' },
]);
const mockSendPayment = jest.fn().mockResolvedValue({ successful: true, hash: 'tx123' });
// Return a proper 32-byte Buffer so Keypair.fromRawEd25519Seed succeeds
const mockDecrypt = jest.fn().mockReturnValue(Buffer.alloc(32, 0x42));
const mockGetOrCreateUser = jest.fn().mockResolvedValue({
    id: 'u1', phoneNumber: '12345', username: 'john',
    stellarWallet: JSON.stringify({ publicKey: 'G_PUB', encryptedSecret: 'ENC_SEC', iv: 'IV', authTag: 'TAG' }),
    createdAt: new Date(),
});
const mockResolveUser = jest.fn().mockResolvedValue({
    id: 'u2', phoneNumber: '67890', username: 'jane',
    stellarWallet: JSON.stringify({ publicKey: 'G_PUB2', encryptedSecret: 'ENC_SEC2', iv: 'IV2', authTag: 'TAG2' }),
});
const mockCreateGroup = jest.fn().mockResolvedValue({ id: 'g1' });
const mockJoinGroup = jest.fn().mockResolvedValue({ id: 'gm1' });
// Group requires 10 XLM per contribution cycle
const mockGetGroupStatus = jest.fn().mockResolvedValue([
    { role: 'CREATOR', groupId: 'g1', group: { id: 'g1', name: 'G1', contributionAmount: 10, contributionFrequency: 'MONTHLY', stellarContractId: 'group_pub_key', currentPayoutIndex: 0, totalCycles: 0, members: [] } },
]);
const mockAddContribution = jest.fn().mockResolvedValue({ id: 'c1' });
const mockAddWithdrawal = jest.fn().mockResolvedValue({ id: 'w1' });

jest.mock('../utils/encryption.util', () => ({
    decrypt: (...args: any[]) => mockDecrypt(...args),
}));

// Mock secret-registry so registerSecret/unregisterSecret are no-ops in tests
jest.mock('../utils/secret-registry', () => ({
    registerSecret: jest.fn(),
    unregisterSecret: jest.fn(),
    zeroAllInFlightSecrets: jest.fn(),
}));

// Stub StellarSdk Keypair.fromRawEd25519Seed so it returns a usable mock keypair
// without needing a real 32-byte seed. The sorobanService is mocked anyway so
// the keypair is only used to extract a publicKey for the invoke call.
jest.mock('@stellar/stellar-sdk', () => {
    const real = jest.requireActual('@stellar/stellar-sdk');
    const mockKp = { publicKey: () => 'G_MOCK_PUB_KEY', sign: jest.fn(), verify: jest.fn() };
    return {
        ...real,
        Keypair: {
            ...real.Keypair,
            fromRawEd25519Seed: jest.fn().mockReturnValue(mockKp),
            random: jest.fn().mockReturnValue(mockKp),
        },
    };
});

const mockCreatePaymentRequest = jest.fn().mockResolvedValue({ id: 'req1', amount: '25', status: 'PENDING' });
const mockAcceptPaymentRequest = jest.fn();
const mockDeclinePaymentRequest = jest.fn();
const mockPaymentRequestService = {
    createRequest: mockCreatePaymentRequest,
    acceptRequest: mockAcceptPaymentRequest,
    declineRequest: mockDeclinePaymentRequest,
};

jest.mock('../queue/payment-request.queue', () => ({
    scheduleRequestCompletion: jest.fn().mockResolvedValue(undefined),
    scheduleRequestExpiry: jest.fn().mockResolvedValue(undefined),
}));
const { scheduleRequestExpiry, scheduleRequestCompletion } = require('../queue/payment-request.queue');

const mockWhatsAppService = { sendMessage: mockSendMessage };
const mockGetTransactionHistory = jest.fn().mockResolvedValue({
    transactions: [
        { date: '2026-06-25T00:00:00Z', type: 'payment sent', amount: '10', asset: 'XLM', counterparty: 'G_PUB2', hash: 'HASH123' }
    ],
    nextCursor: 'cursor_123'
});
const mockStellarService = { getTransactionHistory: mockGetTransactionHistory, checkBalance: mockCheckBalance, sendPayment: mockSendPayment, generateWallet: jest.fn(), fundTestnetAccount: jest.fn() };
const mockUserService = { getOrCreateUser: mockGetOrCreateUser, resolveUser: mockResolveUser, getUserByPublicKey: jest.fn() };
const mockGroupService = { createGroup: mockCreateGroup, joinGroup: mockJoinGroup, getGroupStatus: mockGetGroupStatus, addContribution: mockAddContribution, addWithdrawal: mockAddWithdrawal };

const mockInvokeContribute = jest.fn().mockResolvedValue({ hash: 'soroban_tx_123', status: 'SUCCESS' });
const mockWithdrawSavings = jest.fn().mockResolvedValue({ hash: 'soroban_withdraw_tx_123', status: 'SUCCESS' });
const mockSorobanService = { invokeContribute: mockInvokeContribute, withdrawSavings: mockWithdrawSavings };

const mockSetPayoutOrder = jest.fn().mockResolvedValue(['u1', 'u2']);
const mockGetEffectivePayoutOrder = jest.fn().mockResolvedValue(['u1', 'u2']);
const mockLockOrderForCycle = jest.fn().mockResolvedValue(undefined);
const mockExtendDeadline = jest.fn().mockResolvedValue(new Date());
const mockProceedWithPartialPool = jest.fn().mockResolvedValue({ id: 'p1' });
const mockSkipDefaultingMember = jest.fn().mockResolvedValue(['u2', 'u1']);
const mockPayoutService = {
    setPayoutOrder: mockSetPayoutOrder,
    getEffectivePayoutOrder: mockGetEffectivePayoutOrder,
    lockOrderForCycle: mockLockOrderForCycle,
    extendDeadline: mockExtendDeadline,
    proceedWithPartialPool: mockProceedWithPartialPool,
    skipDefaultingMember: mockSkipDefaultingMember,
};

const mockLeaveGroup = jest.fn().mockResolvedValue({ member: { userId: 'u1' }, groupPaused: false });
const mockKickMember = jest.fn().mockResolvedValue({ member: { userId: 'u2' }, groupPaused: false });
const mockGroupExitService = {
    leaveGroup: mockLeaveGroup,
    kickMember: mockKickMember,
};

describe('MessageProcessor', () => {
    let processor: MessageProcessor;

    beforeEach(() => {
        jest.clearAllMocks();
        processor = new MessageProcessor(
            mockWhatsAppService as any,
            mockStellarService as any,
            mockUserService as any,
            mockGroupService as any,
            mockPayoutService as any,
            mockPaymentRequestService as any,
            mockSorobanService as any,
            mockGroupExitService as any,
        );
    });

    describe('processCommand routing', () => {
        it('should handle BALANCE command', async () => {
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('balance.success'));
        });

        it('should list every asset balance for a bare BALANCE command', async () => {
            await processor.processCommand('12345', 'BALANCE');
            const [, message] = mockSendMessage.mock.calls[0];
            expect(message).toContain('"balances":"XLM: 100.50\\nUSDC: 50.00"');
        });

        it('should filter to a single asset for BALANCE <asset>', async () => {
            await processor.processCommand('12345', 'BALANCE USDC');
            const [, message] = mockSendMessage.mock.calls[0];
            expect(message).toContain('balance.success');
            expect(message).toContain('"balances":"USDC: 50.00"');
        });

        it('should report when the requested asset has no trustline', async () => {
            await processor.processCommand('12345', 'BALANCE EURC');
            expect(mockSendMessage).toHaveBeenCalledWith(
                '12345',
                expect.stringContaining('balance.asset_not_found'),
            );
        });

        it('should handle PROFILE command', async () => {
            await processor.processCommand('12345', 'PROFILE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('profile.card'));
        });

        it('should handle HISTORY command and show transactions', async () => {
            await processor.processCommand('12345', 'HISTORY');
            expect(mockGetTransactionHistory).toHaveBeenCalledWith('G_PUB', undefined, 10);
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('history.header'));
        });

        it('should handle HISTORY MORE command', async () => {
            mockRedisGet.mockResolvedValueOnce('cursor_123'); // For history cursor
            await processor.processCommand('12345', 'HISTORY MORE');
            expect(mockGetTransactionHistory).toHaveBeenCalledWith('G_PUB', 'cursor_123', 10);
            expect(mockRedisSet).toHaveBeenCalledWith('user_state:12345:history_cursor', 'cursor_123', 'EX', 3600);
        });

        it('should handle HELP command', async () => {
            await processor.processCommand('12345', 'HELP');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('help.text'));
        });

        it('should handle UNKNOWN command', async () => {
            await processor.processCommand('12345', 'INVALID');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('unknown.command'));
        });

        it('should handle CREATE GROUP command', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Family 100 WEEKLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Family', '100', 'WEEKLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.success'));
        });

        it('should handle JOIN GROUP command', async () => {
            await processor.processCommand('12345', 'JOIN GROUP g1');
            expect(mockJoinGroup).toHaveBeenCalledWith('u1', 'g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('join_group.success'));
        });

        it('should handle INVITE MEMBER command', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER 0987654321');
            expect(mockResolveUser).toHaveBeenCalledWith('0987654321');
            expect(mockGetGroupStatus).toHaveBeenCalledWith('u1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.success'));
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('invite_member.notify_recipient'));
        });

        it('should handle GROUP STATUS command', async () => {
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockGetGroupStatus).toHaveBeenCalledWith('u1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_status.header'));
        });
    });

    describe('handleSend', () => {
        it('should require amount and target', async () => {
            await processor.processCommand('12345', 'SEND');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.usage'));
        });

        it('should decrypt sender secret and send payment on success', async () => {
            await processor.processCommand('12345', 'SEND 10 @jane');

            expect(mockGetOrCreateUser).toHaveBeenCalledWith('12345');
            expect(mockResolveUser).toHaveBeenCalledWith('@jane');
            // keyVersion param may be undefined depending on user record
            expect(mockDecrypt).toHaveBeenCalledWith('ENC_SEC', 'IV', 'TAG', undefined);
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.initiating'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.success'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'SEND 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.usage'));
        });

        it('should validate amount format', async () => {
            await processor.processCommand('12345', 'SEND abc @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should check if sender has a wallet', async () => {
            const walletUser = {
                id: 'u1', phoneNumber: '12345', username: 'john',
                stellarWallet: JSON.stringify({ publicKey: 'G_PUB', encryptedSecret: 'ENC_SEC', iv: 'IV', authTag: 'TAG' }),
                createdAt: new Date(), language: 'en'
            };
            mockGetOrCreateUser.mockResolvedValueOnce(walletUser).mockResolvedValueOnce(walletUser);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.initiating'));
        });

        it('should check if recipient exists and has a wallet', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
        });

        it('should handle missing recipient wallet', async () => {
            mockResolveUser.mockResolvedValueOnce({
                id: 'u2', phoneNumber: '67890', stellarWallet: null, language: 'en',
            });
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle missing recipient entirely', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.no_recipient'));
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('should handle send payment failure', async () => {
            mockSendPayment.mockRejectedValueOnce(new Error('Insufficient balance'));
            await processor.processCommand('12345', 'SEND 10 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('send.failed'));
        });
    });

    describe('handleContribute', () => {
        it('invokes the Soroban contract (not sendPayment) on a valid contribution', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockInvokeContribute).toHaveBeenCalledTimes(1);
            expect(mockSendPayment).not.toHaveBeenCalled();
        });

        it('writes DB record ONLY after on-chain SUCCESS confirmation', async () => {
            mockInvokeContribute.mockResolvedValueOnce({ hash: 'soroban_tx_123', status: 'SUCCESS' });
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockAddContribution).toHaveBeenCalledWith('u1', 'g1', '10', 'soroban_tx_123');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });

        it('does NOT write COMPLETED DB record when invokeContribute returns PENDING', async () => {
            mockInvokeContribute.mockResolvedValueOnce({ hash: 'slow_tx', status: 'PENDING' });
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            // Should record as PENDING status, not COMPLETED
            expect(mockAddContribution).toHaveBeenCalledWith('u1', 'g1', '10', 'slow_tx', 'PENDING');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.pending'));
            // lockOrderForCycle must NOT be called when contribution is still pending
            expect(mockLockOrderForCycle).not.toHaveBeenCalled();
        });

        it('sends contribute.failed_onchain when the Soroban tx is FAILED on ledger', async () => {
            mockInvokeContribute.mockRejectedValueOnce(new Error('Transaction failed on ledger: bad_hash'));
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockAddContribution).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.failed_onchain'));
        });

        it('sends contribute.failed for non-ledger errors (e.g. network error)', async () => {
            mockInvokeContribute.mockRejectedValueOnce(new Error('RPC unavailable'));
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockAddContribution).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.failed'));
        });

        it('locks the payout order after recording a successful contribution', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockLockOrderForCycle).toHaveBeenCalledWith('g1');
        });

        it('shows usage when no args provided', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.usage'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('handles missing group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.no_group'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('passes the correct stroop amount to invokeContribute', async () => {
            // 10 XLM = 100_000_000 stroops
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            const call = mockInvokeContribute.mock.calls[0];
            expect(call[3]).toBe(100_000_000n);
        });
    });

    describe('handleContribute amount validation', () => {
        it('should reject a non-numeric amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE abc');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should reject zero amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 0');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should reject a negative amount', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE -5');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should reject amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 10.12345678');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should reject amount exceeding 1,000,000 XLM', async () => {
            await processor.processCommand('12345', 'CONTRIBUTE 1000001');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.exceeds_max'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should reject amount that does not match the group required contribution', async () => {
            // Group requires 10 XLM; user tries to contribute a different amount
            await processor.processCommand('12345', 'CONTRIBUTE 50');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.amount_mismatch'));
            expect(mockInvokeContribute).not.toHaveBeenCalled();
        });

        it('should accept a valid amount that exactly matches group requirement', async () => {
            // Group requires 10 XLM
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockInvokeContribute).toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });

        it('should accept a valid decimal amount matching the group requirement', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'MEMBER', groupId: 'g2', group: { id: 'g2', name: 'G2', contributionAmount: 10.5, contributionFrequency: 'WEEKLY', stellarContractId: 'g2_pub_key', members: [] } },
            ]);
            await processor.processCommand('12345', 'CONTRIBUTE 10.5');
            expect(mockInvokeContribute).toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.success'));
        });
    });

    describe('handleCreateGroup amount validation', () => {
        it('should reject zero contribution amount', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 0 MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
        });

        it('should reject non-numeric contribution amount', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings abc MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should reject contribution amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 5.12345678 MONTHLY');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
        });
    });

    describe('handleWithdraw amount validation', () => {
        it('should reject zero withdrawal amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW 0');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.zero_amount'));
        });

        it('should reject non-numeric withdrawal amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW abc');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.invalid_format'));
        });

        it('should reject withdrawal amount with more than 7 decimal places', async () => {
            await processor.processCommand('12345', 'WITHDRAW 1.12345678');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('validation.precision_exceeded'));
        });
    });

    describe('handleRequest', () => {
        it('should send request to recipient and confirmation to sender', async () => {
            await processor.processCommand('12345', 'REQUEST 25 @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('request.notify_recipient'));
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.confirmation'));
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'REQUEST 25');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'REQUEST 25 @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('request.no_user'));
        });
    });

    describe('handleCreateGroup', () => {
        it('should create group with parsed args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockCreateGroup).toHaveBeenCalledWith('u1', 'Savings', '50', 'MONTHLY');
        });

        it('should show usage when insufficient args', async () => {
            await processor.processCommand('12345', 'CREATE GROUP');
            expect(mockCreateGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.usage'));
        });

        it('should handle group creation failure', async () => {
            mockCreateGroup.mockRejectedValueOnce(new Error('Name taken'));
            await processor.processCommand('12345', 'CREATE GROUP Savings 50 MONTHLY');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('create_group.failed'));
        });
    });

    describe('handleJoinGroup', () => {
        it('should join group', async () => {
            await processor.processCommand('12345', 'JOIN GROUP g1');
            expect(mockJoinGroup).toHaveBeenCalledWith('u1', 'g1');
        });

        it('should show usage when missing groupId', async () => {
            await processor.processCommand('12345', 'JOIN GROUP');
            expect(mockJoinGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('join_group.usage'));
        });
    });

    describe('handleInviteMember', () => {
        it('should show usage when missing target', async () => {
            await processor.processCommand('12345', 'INVITE MEMBER');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.usage'));
        });

        it('should handle missing recipient', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'INVITE MEMBER @ghost');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.no_user'));
        });

        it('should handle user not being a group creator', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'INVITE MEMBER @jane');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('invite_member.not_creator'));
        });
    });

    describe('handleGroupStatus', () => {
        it('should handle no groups', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'GROUP STATUS');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_status.no_groups'));
        });
    });

    describe('handleLeaveGroup', () => {
        it('should show usage when missing groupId', async () => {
            await processor.processCommand('12345', 'LEAVE GROUP');
            expect(mockLeaveGroup).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('leave_group.usage'));
        });

        it('should leave the group', async () => {
            await processor.processCommand('12345', 'LEAVE GROUP g1');
            expect(mockLeaveGroup).toHaveBeenCalledWith('u1', 'g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('leave_group.success'));
        });

        it('should surface a typed exit error', async () => {
            mockLeaveGroup.mockRejectedValueOnce(new GroupExitError('payout_received'));
            await processor.processCommand('12345', 'LEAVE GROUP g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_exit.error_payout_received'));
        });

        it('should surface an unexpected error', async () => {
            mockLeaveGroup.mockRejectedValueOnce(new Error('DB unavailable'));
            await processor.processCommand('12345', 'LEAVE GROUP g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('leave_group.failed'));
        });
    });

    describe('handleKickMember', () => {
        it('should show usage when missing args', async () => {
            await processor.processCommand('12345', 'KICK @jane');
            expect(mockKickMember).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('kick_member.usage'));
        });

        it('should reject when the target cannot be resolved', async () => {
            mockResolveUser.mockResolvedValueOnce(null);
            await processor.processCommand('12345', 'KICK @ghost g1');
            expect(mockKickMember).not.toHaveBeenCalled();
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_exit.error_target_not_found'));
        });

        it('should kick the resolved member from the group', async () => {
            await processor.processCommand('12345', 'KICK @jane g1');
            expect(mockResolveUser).toHaveBeenCalledWith('@jane');
            expect(mockKickMember).toHaveBeenCalledWith('u1', 'g1', 'u2');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('kick_member.success'));
        });

        it('should surface a typed exit error', async () => {
            mockKickMember.mockRejectedValueOnce(new GroupExitError('not_creator'));
            await processor.processCommand('12345', 'KICK @jane g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('group_exit.error_not_creator'));
        });

        it('should surface an unexpected error', async () => {
            mockKickMember.mockRejectedValueOnce(new Error('DB unavailable'));
            await processor.processCommand('12345', 'KICK @jane g1');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('kick_member.failed'));
        });
    });

    describe('handleContribute — group paused', () => {
        it('should block contributions once the group is paused', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'CREATOR', groupId: 'g1', group: { id: 'g1', name: 'G1', contributionAmount: 10, contributionFrequency: 'MONTHLY', isPaused: true, members: [] } },
            ]);
            await processor.processCommand('12345', 'CONTRIBUTE 10');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('contribute.group_paused'));
        });
    });

    describe('handleWithdraw', () => {
        it('should show usage when missing amount', async () => {
            await processor.processCommand('12345', 'WITHDRAW');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.usage'));
        });

        it('should handle no group membership', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([]);
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.no_group'));
        });

        it('rejects withdrawal for a Rotational group — no on-chain mechanism for it', async () => {
            // The default mockGetGroupStatus fixture has no groupType set,
            // i.e. the Rotational default (see schema.prisma).
            await processor.processCommand('12345', 'WITHDRAW 100');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.not_goalbased'));
            expect(mockWithdrawSavings).not.toHaveBeenCalled();
        });

        it('withdraws from a GoalBased group and records the DB withdrawal on confirmation', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'MEMBER', groupId: 'g1', group: { id: 'g1', name: 'G1', groupType: 'GoalBased', stellarContractId: 'group_pub_key' } },
            ]);

            await processor.processCommand('12345', 'WITHDRAW 100');

            expect(mockWithdrawSavings).toHaveBeenCalledTimes(1);
            expect(mockAddWithdrawal).toHaveBeenCalledWith('u1', 'g1', '100', 'soroban_withdraw_tx_123');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.success'));
        });

        it('records a PENDING withdrawal and does not mark it successful when confirmation times out', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'MEMBER', groupId: 'g1', group: { id: 'g1', name: 'G1', groupType: 'GoalBased', stellarContractId: 'group_pub_key' } },
            ]);
            mockWithdrawSavings.mockResolvedValueOnce({ hash: 'slow_withdraw_tx', status: 'PENDING' });

            await processor.processCommand('12345', 'WITHDRAW 100');

            expect(mockAddWithdrawal).toHaveBeenCalledWith('u1', 'g1', '100', 'slow_withdraw_tx', 'PENDING');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.pending'));
        });

        it('reports an on-chain failure distinctly from a network error', async () => {
            mockGetGroupStatus.mockResolvedValueOnce([
                { role: 'MEMBER', groupId: 'g1', group: { id: 'g1', name: 'G1', groupType: 'GoalBased', stellarContractId: 'group_pub_key' } },
            ]);
            mockWithdrawSavings.mockRejectedValueOnce(new Error('Transaction failed on ledger: bad_hash'));

            await processor.processCommand('12345', 'WITHDRAW 100');

            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('withdraw.failed_onchain'));
            expect(mockAddWithdrawal).not.toHaveBeenCalled();
        });
    });

    describe('PAYOUT commands', () => {
        describe('PAYOUT ORDER', () => {
            it('should show usage when no members supplied', async () => {
                await processor.processCommand('12345', 'PAYOUT ORDER');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.order_usage'));
                expect(mockSetPayoutOrder).not.toHaveBeenCalled();
            });

            it('should reject when the requester is not a group creator', async () => {
                mockGetGroupStatus.mockResolvedValueOnce([{ role: 'MEMBER', groupId: 'g1', group: { id: 'g1' } }]);
                await processor.processCommand('12345', 'PAYOUT ORDER @jane');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.not_creator'));
                expect(mockSetPayoutOrder).not.toHaveBeenCalled();
            });

            it('should reject when a listed member cannot be resolved', async () => {
                mockResolveUser.mockResolvedValueOnce(null);
                await processor.processCommand('12345', 'PAYOUT ORDER @ghost');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.order_invalid_member'));
                expect(mockSetPayoutOrder).not.toHaveBeenCalled();
            });

            it('should set the payout order by resolved userIds', async () => {
                await processor.processCommand('12345', 'PAYOUT ORDER @jane');
                expect(mockSetPayoutOrder).toHaveBeenCalledWith('g1', 'u1', ['u2']);
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.order_success'));
            });

            it('should surface service errors (e.g. locked order)', async () => {
                mockSetPayoutOrder.mockRejectedValueOnce(new Error('Payout order is locked for this cycle'));
                await processor.processCommand('12345', 'PAYOUT ORDER @jane');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.order_failed'));
            });
        });

        describe('PAYOUT STATUS', () => {
            it('should handle no group membership', async () => {
                mockGetGroupStatus.mockResolvedValueOnce([]);
                await processor.processCommand('12345', 'PAYOUT STATUS');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.no_group'));
            });

            it('should report the current rotation order', async () => {
                await processor.processCommand('12345', 'PAYOUT STATUS');
                expect(mockGetEffectivePayoutOrder).toHaveBeenCalledWith('g1');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.status'));
            });
        });

        describe('PAYOUT WAIT', () => {
            it('should reject when not a creator', async () => {
                mockGetGroupStatus.mockResolvedValueOnce([{ role: 'MEMBER', groupId: 'g1', group: { id: 'g1' } }]);
                await processor.processCommand('12345', 'PAYOUT WAIT');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.not_creator'));
                expect(mockExtendDeadline).not.toHaveBeenCalled();
            });

            it('should extend the deadline', async () => {
                await processor.processCommand('12345', 'PAYOUT WAIT');
                expect(mockExtendDeadline).toHaveBeenCalledWith('g1');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.wait_success'));
            });

            it('should surface an error once the extension cap is reached', async () => {
                mockExtendDeadline.mockRejectedValueOnce(new Error('Maximum deadline extensions (2) already used for this cycle.'));
                await processor.processCommand('12345', 'PAYOUT WAIT');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.wait_failed'));
            });
        });

        describe('PAYOUT PROCEED', () => {
            it('should reject when not a creator', async () => {
                mockGetGroupStatus.mockResolvedValueOnce([{ role: 'MEMBER', groupId: 'g1', group: { id: 'g1' } }]);
                await processor.processCommand('12345', 'PAYOUT PROCEED');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.not_creator'));
                expect(mockProceedWithPartialPool).not.toHaveBeenCalled();
            });

            it('should process the partial pool payout', async () => {
                await processor.processCommand('12345', 'PAYOUT PROCEED');
                expect(mockProceedWithPartialPool).toHaveBeenCalledWith('g1');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.proceed_success'));
            });
        });

        describe('PAYOUT SKIP', () => {
            it('should show usage when no target supplied', async () => {
                await processor.processCommand('12345', 'PAYOUT SKIP');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.skip_usage'));
                expect(mockSkipDefaultingMember).not.toHaveBeenCalled();
            });

            it('should reject when the target cannot be resolved', async () => {
                mockResolveUser.mockResolvedValueOnce(null);
                await processor.processCommand('12345', 'PAYOUT SKIP @ghost');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.skip_no_user'));
                expect(mockSkipDefaultingMember).not.toHaveBeenCalled();
            });

            it('should skip the defaulting member', async () => {
                await processor.processCommand('12345', 'PAYOUT SKIP @jane');
                expect(mockSkipDefaultingMember).toHaveBeenCalledWith('g1', 'u1', 'u2');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.skip_success'));
            });
        });

        describe('unknown PAYOUT subcommand', () => {
            it('should show general payout usage', async () => {
                await processor.processCommand('12345', 'PAYOUT');
                expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payout.usage'));
            });
        });
    });

    describe('error handling', () => {
        it('should catch and report errors from handlers', async () => {
            mockGetOrCreateUser.mockRejectedValueOnce(new Error('DB connection failed')).mockRejectedValueOnce(new Error('DB connection failed'));
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('error.generic'));
        });
    });

    describe('handleBalance edge cases', () => {
        it('should handle missing wallet', async () => {
            const noWalletUser = { id: 'u2', language: 'en' };
            mockGetOrCreateUser.mockResolvedValueOnce(noWalletUser).mockResolvedValueOnce(noWalletUser);
            await processor.processCommand('12345', 'BALANCE');
            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('balance.no_wallet'));
        });
    });

    describe('payment requests (issue #65)', () => {
        it('REQUEST creates a tracked request and sends the recipient the requestId', async () => {
            mockCreatePaymentRequest.mockResolvedValue({ id: 'REQ-1', expiresAt: new Date(Date.now() + 86400000) });

            await processor.processCommand('12345', 'REQUEST 50 @jane');

            expect(mockCreatePaymentRequest).toHaveBeenCalledWith('u1', 'u2', '50');
            expect(scheduleRequestExpiry).toHaveBeenCalledWith('REQ-1', expect.any(Date));
            const recipientMsg = mockSendMessage.mock.calls[0][1];
            expect(recipientMsg).toContain('request.notify_recipient');
            expect(recipientMsg).toContain('"requestId":"REQ-1"');
        });

        it('REQUEST rejects when the sender already has 5 pending requests', async () => {
            const { PaymentRequestError } = require('../services/payment-request.service');
            mockCreatePaymentRequest.mockRejectedValue(new PaymentRequestError('too_many_pending'));

            await processor.processCommand('12345', 'REQUEST 50 @jane');

            expect(mockSendMessage).toHaveBeenCalledWith('12345', expect.stringContaining('payment_request.error_too_many_pending'));
        });

        it('ACCEPT places the escrow hold and schedules completion', async () => {
            mockAcceptPaymentRequest.mockResolvedValue({
                request: { id: 'REQ-1', amount: '50', assetCode: 'XLM' },
                balanceId: 'CB-1',
                hash: 'HOLD_HASH',
            });

            await processor.processCommand('67890', 'ACCEPT REQ-1');

            expect(mockAcceptPaymentRequest).toHaveBeenCalledWith('REQ-1', '67890');
            expect(scheduleRequestCompletion).toHaveBeenCalledWith('REQ-1');
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('payment_request.accepted'));
        });

        it('ACCEPT refuses a request addressed to someone else', async () => {
            const { PaymentRequestError } = require('../services/payment-request.service');
            mockAcceptPaymentRequest.mockRejectedValue(new PaymentRequestError('not_responder'));

            await processor.processCommand('67890', 'ACCEPT REQ-1');

            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('payment_request.error_not_responder'));
        });

        it('DECLINE marks the request declined and notifies the requester', async () => {
            mockDeclinePaymentRequest.mockResolvedValue({
                amount: '50',
                assetCode: 'XLM',
                requester: { phoneNumber: '1111', language: 'en', username: null },
                responder: { username: 'jane', phoneNumber: '2222' },
            });

            await processor.processCommand('67890', 'DECLINE REQ-1');

            expect(mockDeclinePaymentRequest).toHaveBeenCalledWith('REQ-1', '67890');
            // Requester gets the declined notice, responder gets the confirmation
            expect(mockSendMessage).toHaveBeenCalledWith('1111', expect.stringContaining('payment_request.declined'));
            expect(mockSendMessage).toHaveBeenCalledWith('67890', expect.stringContaining('payment_request.decline_confirmed'));
        });
    });
});
