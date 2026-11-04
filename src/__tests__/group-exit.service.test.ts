import { GroupExitService, GroupExitError } from '../services/group-exit.service';
import { config } from '../config/env';

jest.mock('../lib/prisma', () => ({
    prisma: {
        savingsGroup: {
            findUnique: jest.fn(),
            update: jest.fn(),
        },
        groupMember: {
            update: jest.fn(),
            findMany: jest.fn(),
        },
        contribution: {
            aggregate: jest.fn(),
        },
        payout: {
            findFirst: jest.fn(),
            aggregate: jest.fn(),
        },
        memberExitLog: {
            create: jest.fn(),
        },
    },
}));

jest.mock('../queue/contribution-scheduler.queue', () => ({
    removeGroupCycle: jest.fn().mockResolvedValue(undefined),
}));

const { prisma } = require('../lib/prisma');
const { removeGroupCycle } = require('../queue/contribution-scheduler.queue');

function makeMember(userId: string, role: string, overrides: Record<string, any> = {}) {
    return {
        id: `m-${userId}`,
        userId,
        role,
        groupId: 'g1',
        status: 'ACTIVE',
        joinedAt: new Date(2026, 0, 1),
        user: {
            id: userId,
            phoneNumber: `+1${userId}`,
            username: null,
            stellarWallet: JSON.stringify({ publicKey: `PUB_${userId}` }),
        },
        ...overrides,
    };
}

function makeGroup(overrides: Record<string, any> = {}) {
    return {
        id: 'g1',
        name: 'Ajo Circle',
        contributionFrequency: 'MONTHLY',
        totalCycles: 0,
        stellarContractId: null,
        members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER'), makeMember('u3', 'MEMBER')],
        ...overrides,
    };
}

describe('GroupExitService', () => {
    let service: GroupExitService;
    let mockRefundMember: jest.Mock;
    let mockRemoveMemberFromOrder: jest.Mock;
    let mockSorobanRemoveMember: jest.Mock;
    let mockSendMessage: jest.Mock;
    let originalTreasurySecret: string;

    beforeAll(() => {
        originalTreasurySecret = config.DEPLOYER_SECRET_KEY;
    });

    afterAll(() => {
        config.DEPLOYER_SECRET_KEY = originalTreasurySecret;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        config.DEPLOYER_SECRET_KEY = '';

        prisma.contribution.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
        prisma.payout.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
        prisma.payout.findFirst.mockResolvedValue(null);
        prisma.groupMember.findMany.mockResolvedValue([]);
        (removeGroupCycle as jest.Mock).mockResolvedValue(undefined);

        mockRefundMember = jest.fn().mockResolvedValue({ hash: 'refund_tx_1' });
        mockRemoveMemberFromOrder = jest.fn().mockResolvedValue([]);
        mockSorobanRemoveMember = jest.fn().mockResolvedValue({ hash: 'remove_tx_1', status: 'SUCCESS' });
        mockSendMessage = jest.fn().mockResolvedValue(true);

        service = new GroupExitService(
            { refundMember: mockRefundMember, removeMemberFromOrder: mockRemoveMemberFromOrder } as any,
            { removeMember: mockSorobanRemoveMember } as any,
            { sendMessage: mockSendMessage } as any,
        );
    });

    describe('leaveGroup', () => {
        it('rejects when the group does not exist', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(null);

            await expect(service.leaveGroup('u2', 'g1')).rejects.toThrow(GroupExitError);
        });

        it('rejects when the user is not a member of the group', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            await expect(service.leaveGroup('u-ghost', 'g1')).rejects.toMatchObject({ code: 'not_a_member' });
        });

        it('rejects when the member has already left', async () => {
            const group = makeGroup({ members: [makeMember('u2', 'MEMBER', { status: 'LEFT' })] });
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);

            await expect(service.leaveGroup('u2', 'g1')).rejects.toMatchObject({ code: 'already_left' });
        });

        it('rejects an exit once the member has received a payout this cycle', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());
            prisma.payout.findFirst.mockResolvedValueOnce({ id: 'payout-1' });

            await expect(service.leaveGroup('u2', 'g1')).rejects.toMatchObject({ code: 'payout_received' });
            expect(prisma.payout.findFirst).toHaveBeenCalledWith({
                where: { groupId: 'g1', recipientId: 'u2', cycleNumber: 1 },
            });
        });

        it('computes settlement, refunds a positive net position, and soft-deletes the membership', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());
            prisma.contribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 100 } });
            prisma.payout.aggregate.mockResolvedValueOnce({ _sum: { amount: 40 } });

            const result = await service.leaveGroup('u2', 'g1');

            expect(result.totalContributed).toBe('100');
            expect(result.totalReceived).toBe('40');
            expect(result.netOwed).toBe('60');
            expect(mockRefundMember).toHaveBeenCalledWith('g1', 'u2', '60');
            expect(result.refundTxHash).toBe('refund_tx_1');

            expect(prisma.groupMember.update).toHaveBeenCalledWith({
                where: { id: 'm-u2' },
                data: { status: 'LEFT', leftAt: expect.any(Date) },
            });
            expect(prisma.memberExitLog.create).toHaveBeenCalledWith({
                data: {
                    groupId: 'g1',
                    userId: 'u2',
                    initiatedBy: 'u2',
                    type: 'LEAVE',
                    totalContributed: '100',
                    totalReceived: '40',
                    netOwed: '60',
                    refundTxHash: 'refund_tx_1',
                },
            });
            expect(mockRemoveMemberFromOrder).toHaveBeenCalledWith('g1', 'u2');
        });

        it('does not attempt a refund when the net position is negative, and logs the loss', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());
            prisma.contribution.aggregate.mockResolvedValueOnce({ _sum: { amount: 20 } });
            prisma.payout.aggregate.mockResolvedValueOnce({ _sum: { amount: 50 } });

            const result = await service.leaveGroup('u2', 'g1');

            expect(mockRefundMember).not.toHaveBeenCalled();
            expect(result.netOwed).toBe('-30');
            expect(result.refundTxHash).toBeNull();
            expect(prisma.memberExitLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ netOwed: '-30', refundTxHash: null }),
            });
        });

        it('invokes the Soroban remove_member call when the group has a deployed contract', async () => {
            config.DEPLOYER_SECRET_KEY = 'SDUXAYQVG4GSKJI7I7CANSO4UZEAS3R6KGV5XUBRFAVZEWWL2QNTCMMU';
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup({ stellarContractId: 'CCONTRACT123' }));

            await service.leaveGroup('u2', 'g1');

            expect(mockSorobanRemoveMember).toHaveBeenCalledWith(
                expect.anything(),
                'CCONTRACT123',
                'PUB_u2',
            );
        });

        it('does not fail the exit when the Soroban removal call throws', async () => {
            config.DEPLOYER_SECRET_KEY = 'SDUXAYQVG4GSKJI7I7CANSO4UZEAS3R6KGV5XUBRFAVZEWWL2QNTCMMU';
            mockSorobanRemoveMember.mockRejectedValueOnce(new Error('RPC unavailable'));
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup({ stellarContractId: 'CCONTRACT123' }));

            await expect(service.leaveGroup('u2', 'g1')).resolves.toBeDefined();
            expect(prisma.groupMember.update).toHaveBeenCalled();
        });

        it('notifies the remaining active members that the exiting member has left', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            await service.leaveGroup('u2', 'g1');

            expect(prisma.groupMember.findMany).toHaveBeenCalledWith({
                where: { groupId: 'g1', status: { not: 'LEFT' }, userId: { not: 'u2' } },
                include: { user: true },
            });
        });

        it('transfers the creator role to the next member in join order when the creator exits', async () => {
            const earlier = makeMember('u2', 'MEMBER', { joinedAt: new Date(2026, 0, 2) });
            const later = makeMember('u3', 'MEMBER', { joinedAt: new Date(2026, 0, 3) });
            const group = makeGroup({ members: [makeMember('u1', 'CREATOR', { joinedAt: new Date(2026, 0, 1) }), earlier, later] });
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);

            const result = await service.leaveGroup('u1', 'g1');

            expect(result.creatorTransferredTo).toBe('u2');
            expect(prisma.groupMember.update).toHaveBeenCalledWith({
                where: { id: 'm-u2' },
                data: { role: 'CREATOR' },
            });
        });

        it('does not transfer the role when a non-creator exits', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            const result = await service.leaveGroup('u2', 'g1');

            expect(result.creatorTransferredTo).toBeNull();
            expect(prisma.groupMember.update).not.toHaveBeenCalledWith({
                where: { id: 'm-u1' },
                data: { role: 'CREATOR' },
            });
        });

        it('pauses the group and stops scheduled reminders when membership drops to 1', async () => {
            const group = makeGroup({ members: [makeMember('u1', 'CREATOR'), makeMember('u2', 'MEMBER')] });
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(group);

            const result = await service.leaveGroup('u2', 'g1');

            expect(result.groupPaused).toBe(true);
            expect(prisma.savingsGroup.update).toHaveBeenCalledWith({
                where: { id: 'g1' },
                data: { isPaused: true, pausedAt: expect.any(Date) },
            });
            expect(removeGroupCycle).toHaveBeenCalledWith('g1', 'MONTHLY');
            expect(mockSendMessage).toHaveBeenCalledWith(
                '+1u1',
                expect.stringContaining('paused'),
            );
        });

        it('does not pause the group when 2 or more active members remain', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            const result = await service.leaveGroup('u2', 'g1');

            expect(result.groupPaused).toBe(false);
            expect(prisma.savingsGroup.update).not.toHaveBeenCalled();
            expect(removeGroupCycle).not.toHaveBeenCalled();
        });
    });

    describe('kickMember', () => {
        it('rejects when the requester is not the creator', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            await expect(service.kickMember('u2', 'g1', 'u3')).rejects.toMatchObject({ code: 'not_creator' });
        });

        it('rejects a creator trying to kick themselves', async () => {
            await expect(service.kickMember('u1', 'g1', 'u1')).rejects.toMatchObject({ code: 'cannot_kick_self' });
            expect(prisma.savingsGroup.findUnique).not.toHaveBeenCalled();
        });

        it('rejects when the target is not a member of the group', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            await expect(service.kickMember('u1', 'g1', 'u-ghost')).rejects.toMatchObject({ code: 'target_not_found' });
        });

        it('rejects kicking a member who already received a payout this cycle', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());
            prisma.payout.findFirst.mockResolvedValueOnce({ id: 'payout-1' });

            await expect(service.kickMember('u1', 'g1', 'u2')).rejects.toMatchObject({ code: 'payout_received' });
        });

        it('allows the creator to kick a member and logs it via the shared exit path', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValueOnce(makeGroup());

            const result = await service.kickMember('u1', 'g1', 'u2');

            expect(result.member.userId).toBe('u2');
            expect(prisma.memberExitLog.create).toHaveBeenCalledWith({
                data: expect.objectContaining({ userId: 'u2', initiatedBy: 'u1', type: 'KICK' }),
            });
            expect(prisma.groupMember.update).toHaveBeenCalledWith({
                where: { id: 'm-u2' },
                data: { status: 'LEFT', leftAt: expect.any(Date) },
            });
        });
    });
});
