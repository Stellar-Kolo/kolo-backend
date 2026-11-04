import { startContributionSchedulerWorker, closeContributionWorker } from '../workers/contribution-scheduler.worker';
import { redisClient } from '../lib/redis';
import { PrismaClient } from '@prisma/client';
import { WhatsAppService } from '../services/whatsapp.service';
import { PayoutService } from '../services/payout.service';
import { Job } from 'bullmq';

jest.mock('@prisma/client', () => {
    const mockPrisma = {
        savingsGroup: {
            update: jest.fn(),
            findUnique: jest.fn()
        },
        contribution: {
            findMany: jest.fn()
        }
    };
    return {
        PrismaClient: jest.fn(() => mockPrisma)
    };
});

jest.mock('../middleware/prisma-encryption.middleware', () => ({
    applyEncryptionMiddleware: jest.fn(),
}));

jest.mock('../services/whatsapp.service');
jest.mock('../services/payout.service');
jest.mock('../queue/contribution-scheduler.queue');

jest.mock('bullmq', () => {
    let workerCallback: any;
    return {
        Worker: jest.fn().mockImplementation((name, cb, opts) => {
            workerCallback = cb;
            return {
                on: jest.fn(),
                close: jest.fn().mockResolvedValue(true)
            };
        }),
        getWorkerCallback: () => workerCallback
    };
});

describe('Contribution Scheduler Worker', () => {
    let prisma: any;
    let workerCallback: any;

    beforeAll(() => {
        Object.defineProperty(redisClient, 'status', { value: 'ready' });
        prisma = new PrismaClient();
    });

    afterAll(async () => {
        if (redisClient.status === 'ready') {
            await redisClient.quit().catch(() => {});
        }
    });

    beforeEach(() => {
        jest.clearAllMocks();
        startContributionSchedulerWorker();
        const bullmq = require('bullmq');
        workerCallback = bullmq.getWorkerCallback();
    });

    afterEach(async () => {
        await closeContributionWorker();
    });

    describe('last-call-reminder', () => {
        it('should send reminder only to non-contributing members and use idempotency', async () => {
            const now = new Date();
            const groupMock = {
                id: 'group-1',
                name: 'Test Group',
                contributionAmount: '100',
                currentCycleStart: new Date(now.getTime() - 100000),
                currentCycleEnd: new Date(now.getTime() + 100000),
                members: [
                    { userId: 'user-1', user: { phoneNumber: '+1234567890' } }, // Non-contributor
                    { userId: 'user-2', user: { phoneNumber: '+0987654321' } }  // Contributor
                ]
            };

            prisma.savingsGroup.findUnique.mockResolvedValue(groupMock);

            prisma.contribution.findMany.mockResolvedValue([
                { userId: 'user-2', status: 'COMPLETED' } // user-2 has contributed
            ]);

            const mockSet = jest.spyOn(redisClient, 'set').mockImplementation(async (key, value, exStr, ex, nxStr) => {
                if (key.includes('user-1')) return 'OK'; // simulate success for user-1
                return null;
            });

            const job = {
                name: 'last-call-reminder',
                id: 'job-1',
                data: { groupId: 'group-1' }
            } as Job;

            await workerCallback(job);

            expect(prisma.savingsGroup.findUnique).toHaveBeenCalledWith({
                where: { id: 'group-1' },
                include: { members: { include: { user: true } } }
            });

            expect(prisma.contribution.findMany).toHaveBeenCalled();

            const whatsappMock = WhatsAppService.prototype.sendMessage as jest.Mock;
            expect(whatsappMock).toHaveBeenCalledTimes(1);
            expect(whatsappMock).toHaveBeenCalledWith(
                '+1234567890',
                expect.stringContaining('Last call reminder')
            );
        });
    });

    describe('cycle-end', () => {
        it('delegates to PayoutService.processCycleEnd for the group', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValue({ id: 'group-1' });

            const job = {
                name: 'cycle-end',
                id: 'job-2',
                data: { groupId: 'group-1' }
            } as Job;

            await workerCallback(job);

            const processCycleEndMock = PayoutService.prototype.processCycleEnd as jest.Mock;
            expect(processCycleEndMock).toHaveBeenCalledWith('group-1');
        });

        it('does nothing when the group no longer exists', async () => {
            prisma.savingsGroup.findUnique.mockResolvedValue(null);

            const job = {
                name: 'cycle-end',
                id: 'job-3',
                data: { groupId: 'ghost-group' }
            } as Job;

            await workerCallback(job);

            const processCycleEndMock = PayoutService.prototype.processCycleEnd as jest.Mock;
            expect(processCycleEndMock).not.toHaveBeenCalled();
        });
    });
});
