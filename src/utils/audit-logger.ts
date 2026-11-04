import { prisma } from '../lib/prisma';

export type SecretOperation = 'SEND' | 'CONTRIBUTE' | 'WITHDRAW' | 'TRUSTLINE' | 'KEY_ROTATION';

export async function logSecretAccess(
    userId: string,
    operation: SecretOperation,
    success: boolean,
    errorMessage?: string
): Promise<void> {
    try {
        await prisma.secretAccessLog.create({
            data: {
                userId,
                operation,
                success,
                errorMessage,
            },
        });
    } catch (e) {
        console.error('Audit log failed:', e);
    }
}