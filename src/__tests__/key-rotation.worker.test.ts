import { config } from '../config/env';
import { encrypt, decrypt } from '../utils/encryption.util';

// 1. Mock prisma
const mockUsers: any[] = [];
const mockUpdateOperations: any[] = [];

jest.mock('../lib/prisma', () => {
    const mockPrisma: any = {
        user: {
            findMany: jest.fn().mockImplementation(() => {
                // Return all mock users that haven't been migrated
                return mockUsers.filter(u => u.encryptionKeyVersion === 1);
            }),
            update: jest.fn().mockImplementation((args) => {
                mockUpdateOperations.push(args);
                const userIndex = mockUsers.findIndex(u => u.id === args.where.id);
                if (userIndex !== -1) {
                    mockUsers[userIndex] = { ...mockUsers[userIndex], ...args.data };
                }
                return args.data;
            })
        }
    };
    mockPrisma.$transaction = jest.fn().mockImplementation(async (callback) => {
        if (typeof callback === 'function') {
            return callback(mockPrisma);
        }
        return Promise.all(callback);
    });
    return { prisma: mockPrisma };
});

// 2. Mock BullMQ
const mockWorkerOn = jest.fn();
const mockWorkerClose = jest.fn();
let processorCallback: (job: any) => Promise<{ processedCount: number }> = async () => ({ processedCount: 0 });

const mockWorkerInstance = { on: mockWorkerOn, close: mockWorkerClose };
const mockWorkerConstructor = jest.fn().mockImplementation(
    (queueName: string, callback: (job: any) => Promise<any>, opts: any) => {
        processorCallback = callback;
        return mockWorkerInstance;
    }
);

jest.mock('bullmq', () => ({
    Worker: mockWorkerConstructor,
    Queue: jest.fn().mockImplementation(() => ({
        add: jest.fn(),
    })),
    QueueEvents: jest.fn(),
}));

import { prisma } from '../lib/prisma';
import { startKeyRotationWorker } from '../workers/key-rotation.worker';

describe('key-rotation.worker', () => {
    let originalConfig: typeof config;
    let worker: ReturnType<typeof startKeyRotationWorker>;

    beforeAll(() => {
        originalConfig = { ...config };
        config.ENCRYPTION_KEYS = {
            1: '1111111111111111111111111111111111111111111111111111111111111111',
            2: '2222222222222222222222222222222222222222222222222222222222222222',
        };
        config.CURRENT_ENCRYPTION_KEY_VERSION = 1;
        
        mockUsers.length = 0; // Clear
        for (let i = 0; i < 25; i++) {
            const rawSecret = `secret-data-${i}`;
            const { encryptedText, iv, authTag } = encrypt(rawSecret);
            const wallet = {
                publicKey: `pub-${i}`,
                encryptedSecret: encryptedText,
                iv,
                authTag,
                keyVersion: 1
            };

            mockUsers.push({
                id: `user-${i}`,
                phoneNumber: `+123456789${i.toString().padStart(2, '0')}`,
                username: `user${i}`,
                stellarWallet: JSON.stringify(wallet),
                encryptionKeyVersion: 1
            });
        }
    });

    afterAll(() => {
        Object.assign(config, originalConfig);
    });

    it('migrates wallets to the new key version successfully', async () => {
        config.CURRENT_ENCRYPTION_KEY_VERSION = 2;
        mockUpdateOperations.length = 0;

        worker = startKeyRotationWorker();
        const result = await processorCallback({ id: 'job-1' });
        
        expect(result.processedCount).toBe(25);
        expect(prisma.$transaction).toHaveBeenCalled();
        expect(prisma.user.update).toHaveBeenCalledTimes(25);
        
        // Check the first update payload
        const firstUpdate = mockUpdateOperations[0];
        expect(firstUpdate.where.id).toBe('user-0');
        expect(firstUpdate.data.encryptionKeyVersion).toBe(2);
        
        const newWallet = JSON.parse(firstUpdate.data.stellarWallet);
        expect(newWallet.keyVersion).toBe(2);
        
        // Decrypt with v2
        const decrypted = decrypt(newWallet.encryptedSecret, newWallet.iv, newWallet.authTag, 2);
        expect(decrypted.toString('utf8')).toBe('secret-data-0');
    });
});
