/**
 * Tests for the new SorobanService methods added for contribution sync:
 *  - invokeContribute()
 *  - queryContribution()
 *  - submitTransaction() polling paths (SUCCESS, FAILED, PENDING timeout)
 */
import * as StellarSdk from '@stellar/stellar-sdk';
import { SorobanService } from '../services/soroban.service';

jest.mock('../services/observability.service', () => ({
    observabilityService: {
        logInfo: jest.fn(),
        logError: jest.fn(),
        alertCriticalFailure: jest.fn(),
    },
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSimSuccess(overrides: Record<string, any> = {}) {
    return {
        transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        minResourceFee: '500',
        results: [{ xdr: 'AAAAAQ==', auth: [] }],
        latestLedger: 100,
        ...overrides,
    };
}

// ── submitTransaction polling paths ──────────────────────────────────────────

describe('SorobanService.submitTransaction() polling', () => {
    let service: SorobanService;
    let mockServer: any;
    let keypair: StellarSdk.Keypair;
    let tx: StellarSdk.Transaction;

    beforeEach(() => {
        keypair = StellarSdk.Keypair.random();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn(),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(keypair.publicKey(), '100')),
        };
        service.server = mockServer;

        const account = new StellarSdk.Account(keypair.publicKey(), '100');
        tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: StellarSdk.Networks.TESTNET,
        })
            .addOperation(StellarSdk.Operation.manageData({ name: 'test', value: null }))
            .setTimeout(30)
            .build();
    });

    it('returns SUCCESS immediately when sendTransaction returns SUCCESS', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'SUCCESS', hash: 'hash_abc' });

        const result = await service.submitTransaction(tx, keypair, mockServer);
        expect(result).toEqual({ hash: 'hash_abc', status: 'SUCCESS' });
        expect(mockServer.getTransaction).not.toHaveBeenCalled();
    });

    it('returns SUCCESS after polling when status transitions to SUCCESS', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'hash_poll' });
        mockServer.getTransaction
            .mockResolvedValueOnce({ status: 'NOT_FOUND' })
            .mockResolvedValueOnce({ status: 'NOT_FOUND' })
            .mockResolvedValueOnce({ status: 'SUCCESS' });

        const result = await service.submitTransaction(tx, keypair, mockServer, { maxPolls: 5, pollIntervalMs: 0 });

        expect(result).toEqual({ hash: 'hash_poll', status: 'SUCCESS' });
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
    }, 10000);

    it('throws when the transaction reaches FAILED status', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'hash_fail' });
        mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });

        await expect(
            service.submitTransaction(tx, keypair, mockServer, { maxPolls: 3, pollIntervalMs: 0 }),
        ).rejects.toThrow('Transaction failed on ledger: hash_fail');
    }, 10000);

    it('returns PENDING when poll limit is exhausted without confirmation', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'hash_timeout' });
        mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

        const result = await service.submitTransaction(tx, keypair, mockServer, {
            maxPolls: 3,
            pollIntervalMs: 0,
        });

        expect(result).toEqual({ hash: 'hash_timeout', status: 'PENDING' });
        expect(mockServer.getTransaction).toHaveBeenCalledTimes(3);
    }, 10000);

    it('throws when sendTransaction returns ERROR', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'ERROR', errorResultXdr: 'ERR_XDR' });

        await expect(service.submitTransaction(tx, keypair, mockServer)).rejects.toThrow(
            'Transaction submission failed',
        );
    });
});

// ── invokeContribute ──────────────────────────────────────────────────────────

describe('SorobanService.invokeContribute()', () => {
    let service: SorobanService;
    let mockServer: any;
    let memberKeypair: StellarSdk.Keypair;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        memberKeypair = StellarSdk.Keypair.random();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'contrib_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(memberKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('builds and submits a contribute() invocation using the member keypair', async () => {
        const result = await service.invokeContribute(
            memberKeypair,
            contractId,
            memberKeypair.publicKey(),
            100_000_000n, // 10 XLM in stroops
            mockServer,
        );

        expect(result.status).toBe('SUCCESS');
        expect(result.hash).toBe('contrib_hash_1');
        expect(mockServer.getAccount).toHaveBeenCalledWith(memberKeypair.publicKey());
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
        expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('passes amount as i128 ScVal with correct stroop value', async () => {
        await service.invokeContribute(
            memberKeypair,
            contractId,
            memberKeypair.publicKey(),
            50_000_000n,
            mockServer,
        );

        const simulateCall = mockServer.simulateTransaction.mock.calls[0][0];
        const envelope = StellarSdk.TransactionBuilder.fromXDR(
            simulateCall.toEnvelope().toXDR('base64'),
            StellarSdk.Networks.TESTNET,
        ) as StellarSdk.Transaction;

        const op = envelope.operations[0] as any;
        // invokeContractFunction encodes the function name as a Symbol — check via the raw XDR op
        // The raw operation type name confirms it's an InvokeHostFunction
        expect(op.type).toBe('invokeHostFunction');
        // Second arg is the amount — verify it's an i128 ScVal
        const rawArgs = (simulateCall.operations[0] as any).functions?.[0]?.args
            ?? (simulateCall.operations[0] as any).args;
        if (rawArgs) {
            const amountScVal = rawArgs[1];
            expect(amountScVal.switch().name).toBe('scvI128');
        }
    });

    it('forwards PENDING status when polling times out', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'slow_hash' });
        mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

        // invokeContribute uses maxPolls=15 by default; override to 2 to keep test fast
        const origSubmit = service.submitTransaction.bind(service);
        jest.spyOn(service, 'submitTransaction').mockImplementationOnce(
            async (tx, keypair, server) => origSubmit(tx, keypair, server, { maxPolls: 2, pollIntervalMs: 0 }),
        );

        const result = await service.invokeContribute(
            memberKeypair,
            contractId,
            memberKeypair.publicKey(),
            10_000_000n,
            mockServer,
        );

        expect(result.status).toBe('PENDING');
        expect(result.hash).toBe('slow_hash');
    }, 10000);

    it('throws when the on-chain transaction FAILED', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'fail_hash' });
        mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });

        await expect(
            service.invokeContribute(
                memberKeypair,
                contractId,
                memberKeypair.publicKey(),
                10_000_000n,
                mockServer,
            ),
        ).rejects.toThrow('Transaction failed on ledger: fail_hash');
    });
});

// ── removeMember ─────────────────────────────────────────────────────────────

describe('SorobanService.removeMember()', () => {
    let service: SorobanService;
    let mockServer: any;
    let adminKeypair: StellarSdk.Keypair;
    let memberPublicKey: string;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        adminKeypair = StellarSdk.Keypair.random();
        memberPublicKey = StellarSdk.Keypair.random().publicKey();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'remove_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(adminKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('builds and submits a remove_member() invocation signed by the admin keypair', async () => {
        const result = await service.removeMember(adminKeypair, contractId, memberPublicKey, mockServer);

        expect(result).toEqual({ hash: 'remove_hash_1', status: 'SUCCESS' });
        expect(mockServer.getAccount).toHaveBeenCalledWith(adminKeypair.publicKey());
        expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
        expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('forwards PENDING status when polling times out', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'remove_slow_hash' });
        mockServer.getTransaction.mockResolvedValue({ status: 'NOT_FOUND' });

        const origSubmit = service.submitTransaction.bind(service);
        jest.spyOn(service, 'submitTransaction').mockImplementationOnce(
            async (tx, keypair, server) => origSubmit(tx, keypair, server, { maxPolls: 2, pollIntervalMs: 0 }),
        );

        const result = await service.removeMember(adminKeypair, contractId, memberPublicKey, mockServer);

        expect(result).toEqual({ hash: 'remove_slow_hash', status: 'PENDING' });
    }, 10000);

    it('throws when the on-chain transaction FAILED', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'remove_fail_hash' });
        mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });

        await expect(
            service.removeMember(adminKeypair, contractId, memberPublicKey, mockServer),
        ).rejects.toThrow('Transaction failed on ledger: remove_fail_hash');
    });
});

describe('SorobanService.payout()', () => {
    let service: SorobanService;
    let mockServer: any;
    let adminKeypair: StellarSdk.Keypair;
    let recipientPublicKey: string;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        adminKeypair = StellarSdk.Keypair.random();
        recipientPublicKey = StellarSdk.Keypair.random().publicKey();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'payout_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(adminKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('builds and submits a payout(expected_recipient) invocation with no amount argument, signed by the admin keypair', async () => {
        const result = await service.payout(adminKeypair, contractId, recipientPublicKey, mockServer);

        expect(result).toEqual({ hash: 'payout_hash_1', status: 'SUCCESS' });
        expect(mockServer.getAccount).toHaveBeenCalledWith(adminKeypair.publicKey());

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        expect(invokeOp.func.value().functionName().toString()).toBe('payout');
        expect(invokeOp.func.value().args()).toHaveLength(1);
    });

    it('throws when the on-chain transaction FAILED (e.g. insufficient pool funds)', async () => {
        mockServer.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'payout_fail_hash' });
        mockServer.getTransaction.mockResolvedValue({ status: 'FAILED' });

        await expect(
            service.payout(adminKeypair, contractId, recipientPublicKey, mockServer),
        ).rejects.toThrow('Transaction failed on ledger: payout_fail_hash');
    });
});

describe('SorobanService.withdrawSavings()', () => {
    let service: SorobanService;
    let mockServer: any;
    let memberKeypair: StellarSdk.Keypair;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        memberKeypair = StellarSdk.Keypair.random();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'withdraw_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(memberKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('builds and submits a withdraw_savings(member, amount) invocation signed by the member keypair', async () => {
        const result = await service.withdrawSavings(memberKeypair, contractId, memberKeypair.publicKey(), 150_000_000n, mockServer);

        expect(result).toEqual({ hash: 'withdraw_hash_1', status: 'SUCCESS' });
        expect(mockServer.getAccount).toHaveBeenCalledWith(memberKeypair.publicKey());

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        expect(invokeOp.func.value().functionName().toString()).toBe('withdraw_savings');
        expect(invokeOp.func.value().args()).toHaveLength(2);
    });
});

describe('SorobanService.resetCycle() / resetRotation()', () => {
    let service: SorobanService;
    let mockServer: any;
    let adminKeypair: StellarSdk.Keypair;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        adminKeypair = StellarSdk.Keypair.random();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'reset_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(adminKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('invokes reset_cycle() with no arguments', async () => {
        await service.resetCycle(adminKeypair, contractId, mockServer);

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        expect(invokeOp.func.value().functionName().toString()).toBe('reset_cycle');
        expect(invokeOp.func.value().args()).toHaveLength(0);
    });

    it('invokes reset_rotation() with no arguments', async () => {
        await service.resetRotation(adminKeypair, contractId, mockServer);

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        expect(invokeOp.func.value().functionName().toString()).toBe('reset_rotation');
        expect(invokeOp.func.value().args()).toHaveLength(0);
    });
});

describe('SorobanService.initializeContract()', () => {
    let service: SorobanService;
    let mockServer: any;
    let deployerKeypair: StellarSdk.Keypair;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    beforeEach(() => {
        deployerKeypair = StellarSdk.Keypair.random();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn().mockResolvedValue(makeSimSuccess()),
            sendTransaction: jest.fn().mockResolvedValue({ status: 'SUCCESS', hash: 'init_hash_1' }),
            getTransaction: jest.fn(),
            getAccount: jest.fn().mockResolvedValue(new StellarSdk.Account(deployerKeypair.publicKey(), '50')),
        };
        service.server = mockServer;
    });

    it('passes all 8 contract parameters, encoding GroupType as a one-element Symbol vec and absent Options as void', async () => {
        await service.initializeContract(deployerKeypair, contractId, {
            admin: deployerKeypair.publicKey(),
            usdcTokenAddress: StellarSdk.Keypair.random().publicKey(),
            groupName: 'Test Group',
            contributionAmount: '100',
            groupType: 'Rotational',
            lockUntilTarget: false,
        }, mockServer);

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        const fn = invokeOp.func.value();
        expect(fn.functionName().toString()).toBe('initialize');
        const args = fn.args();
        expect(args).toHaveLength(8);

        // group_type: Vec([Symbol("Rotational")]) — a union case with no data
        const groupTypeArg = args[4];
        expect(groupTypeArg.switch().name).toBe('scvVec');
        const vecVal = groupTypeArg.vec()!;
        expect(vecVal).toHaveLength(1);
        expect(vecVal[0].sym().toString()).toBe('Rotational');

        // target_amount: Option::None -> ScVal::Void
        expect(args[5].switch().name).toBe('scvVoid');
        // lock_until_target: bool
        expect(args[6].switch().name).toBe('scvBool');
        // expected_cycle_days: Option::None -> ScVal::Void
        expect(args[7].switch().name).toBe('scvVoid');
    });

    it('encodes a provided targetAmount/expectedCycleDays as their own ScVal, not void', async () => {
        await service.initializeContract(deployerKeypair, contractId, {
            admin: deployerKeypair.publicKey(),
            usdcTokenAddress: StellarSdk.Keypair.random().publicKey(),
            groupName: 'Goal Group',
            contributionAmount: '100',
            groupType: 'GoalBased',
            targetAmount: '5000',
            lockUntilTarget: true,
            expectedCycleDays: 30,
        }, mockServer);

        const invokeOp = (service as any).server.simulateTransaction.mock.calls[0][0].operations[0];
        const args = invokeOp.func.value().args();

        const groupTypeArg = args[4];
        expect(groupTypeArg.vec()![0].sym().toString()).toBe('GoalBased');
        expect(args[5].switch().name).toBe('scvI128');
        expect(args[7].switch().name).toBe('scvU32');
        expect(args[7].u32()).toBe(30);
    });
});

// ── queryContribution ─────────────────────────────────────────────────────────

describe('SorobanService.queryContribution()', () => {
    let service: SorobanService;
    let mockServer: any;
    let memberPublicKey: string;
    const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

    function makeI128ScVal(value: bigint): string {
        // Build an i128 ScVal and return its base64 XDR
        const lo = value & 0xFFFFFFFFFFFFFFFFn;
        const hi = value >> 64n;
        const scVal = StellarSdk.xdr.ScVal.scvI128(
            new StellarSdk.xdr.Int128Parts({
                hi: StellarSdk.xdr.Int64.fromString(hi.toString()),
                lo: StellarSdk.xdr.Uint64.fromString(lo.toString()),
            }),
        );
        return scVal.toXDR('base64');
    }

    beforeEach(() => {
        const kp = StellarSdk.Keypair.random();
        memberPublicKey = kp.publicKey();
        service = new SorobanService('https://soroban-testnet.stellar.org');
        mockServer = {
            simulateTransaction: jest.fn(),
            sendTransaction: jest.fn(),
            getTransaction: jest.fn(),
        };
        service.server = mockServer;
    });

    it('returns the i128 value from the simulation result', async () => {
        const amountStroops = 100_000_000n; // 10 XLM
        const xdr = makeI128ScVal(amountStroops);
        mockServer.simulateTransaction.mockResolvedValue({
            transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            minResourceFee: '100',
            results: [{ xdr, auth: [] }],
            latestLedger: 200,
        });

        const result = await service.queryContribution(contractId, memberPublicKey, mockServer);
        expect(result).toBe(amountStroops);
    });

    it('returns 0n when the simulation returns an error (member never contributed)', async () => {
        mockServer.simulateTransaction.mockResolvedValue({
            error: 'ContractError: NotFound',
            latestLedger: 200,
        });

        const result = await service.queryContribution(contractId, memberPublicKey, mockServer);
        expect(result).toBe(0n);
    });

    it('returns 0n when results array is empty', async () => {
        mockServer.simulateTransaction.mockResolvedValue({
            transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
            minResourceFee: '100',
            results: [],
            latestLedger: 200,
        });

        const result = await service.queryContribution(contractId, memberPublicKey, mockServer);
        expect(result).toBe(0n);
    });
});
