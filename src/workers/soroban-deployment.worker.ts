import { Worker, Job } from 'bullmq';
import { config } from '../config/env';
import { PrismaClient } from '@prisma/client';
import { sorobanService } from '../services/soroban.service';
import { observabilityService } from '../services/observability.service';
import { applyEncryptionMiddleware } from '../middleware/prisma-encryption.middleware';

const prisma = new PrismaClient();
applyEncryptionMiddleware(prisma);
const connection = { url: config.REDIS_URL };

let workerInstance: Worker | null = null;

export function startSorobanDeploymentWorker(): void {
    if (workerInstance) return;

    workerInstance = new Worker(
        'soroban-deployment',
        async (job: Job) => {
            const { groupId } = job.data;
            console.log(`Processing contract deployment for group ${groupId} (Job ${job.id})`);

            const group = await prisma.savingsGroup.findUnique({
                where: { id: groupId },
            });

            if (!group) {
                throw new Error(`Group not found for deployment: ${groupId}`);
            }

            // Update deploymentStatus to DEPLOYING
            await prisma.savingsGroup.update({
                where: { id: groupId },
                data: { deploymentStatus: 'DEPLOYING', deploymentError: null },
            });

            try {
                const result = await sorobanService.deployGroupContract({
                    groupId: group.id,
                    name: group.name,
                    contributionAmount: group.contributionAmount.toString(),
                    groupType: (group as any).groupType ?? 'Rotational',
                    targetAmount: (group as any).targetAmount?.toString() ?? null,
                    lockUntilTarget: (group as any).lockUntilTarget ?? false,
                });

                // Update group with contract ID and DEPLOYED status
                await prisma.savingsGroup.update({
                    where: { id: groupId },
                    data: {
                        stellarContractId: result.contractId,
                        deploymentStatus: 'DEPLOYED',
                        deploymentError: null,
                    },
                });

                console.log(`Successfully deployed contract ${result.contractId} for group ${groupId}`);
            } catch (error: any) {
                const errorMessage = error?.message || String(error);
                await prisma.savingsGroup.update({
                    where: { id: groupId },
                    data: {
                        deploymentStatus: 'FAILED',
                        deploymentError: errorMessage,
                    },
                });

                observabilityService.logError('Soroban contract deployment worker job failed', error, {
                    groupId,
                    attemptsMade: job.attemptsMade,
                });

                throw error;
            }
        },
        {
            connection,
            concurrency: 2,
        }
    );

    workerInstance.on('completed', (job) => {
        console.log(`Soroban deployment job ${job.id} completed`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`Soroban deployment job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err.message);
    });

    console.log('Soroban deployment worker started');
}

export async function closeSorobanDeploymentWorker(): Promise<void> {
    if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
    }
}
