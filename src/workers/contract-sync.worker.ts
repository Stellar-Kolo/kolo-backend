/**
 * Contract-Sync Reconciliation Worker
 *
 * Runs every 5 minutes.  For every active SavingsGroup that has a deployed
 * Soroban contract, it:
 *   1. Fetches each member's on-chain contribution via get_contribution(),
 *      a lifetime-cumulative total.
 *   2. Sums that member's COMPLETED Contribution records across all cycles.
 *   3. Flags any divergence as a ReconciliationMismatch record.
 *   4. Does NOT auto-fix — mismatches require admin review.
 *
 * Crash-recovery idempotency: if the backend crashed after on-chain confirmation
 * but before the DB write, this worker will detect that the on-chain amount is
 * higher than the DB total and log a RECONCILIATION_MISMATCH event so an admin
 * can resolve it by writing the missing DB record.
 */
import { Worker, Job } from 'bullmq';
import { PrismaClient, Prisma } from '@prisma/client';
import { config } from '../config/env';
import { SorobanService } from '../services/soroban.service';
import { observabilityService } from '../services/observability.service';
import { scheduleReconciliation, getContractSyncQueue } from '../queue/contract-sync.queue';
import { applyEncryptionMiddleware } from '../middleware/prisma-encryption.middleware';
import { xlmToStroops } from '../utils/stellar-amount.util';

const prisma = new PrismaClient();
applyEncryptionMiddleware(prisma);
const connection = { url: config.REDIS_URL };

let workerInstance: Worker | null = null;

export function startContractSyncWorker(): void {
    if (workerInstance) return;

    const sorobanService = new SorobanService();

    workerInstance = new Worker(
        'contract-sync',
        async (job: Job) => {
            if (job.name !== 'reconcile') return;
            console.log(`[ContractSyncWorker] Starting reconciliation run (job ${job.id})`);
            await runReconciliation(sorobanService);
        },
        {
            connection,
            concurrency: 1, // reconciliation must run serially to avoid duplicate mismatch records
        },
    );

    workerInstance.on('completed', (job) => {
        console.log(`[ContractSyncWorker] Reconciliation job ${job.id} completed`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`[ContractSyncWorker] Reconciliation job ${job?.id} failed:`, err.message);
    });

    // Register the 5-minute repeating schedule
    scheduleReconciliation().catch((err) =>
        console.error('[ContractSyncWorker] Failed to schedule reconciliation:', err),
    );

    console.log('[ContractSyncWorker] Started — reconciliation scheduled every 5 minutes');
}

/**
 * Core reconciliation logic.  Separated from the BullMQ callback so it can be
 * called directly from tests.
 */
export async function runReconciliation(sorobanService: SorobanService): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = { groupsScanned: 0, membersChecked: 0, mismatchesFound: 0, errors: [] };

    // Only scan groups that have a fully deployed Soroban contract
    const groups = await prisma.savingsGroup.findMany({
        where: {
            deploymentStatus: 'DEPLOYED',
            stellarContractId: { not: null },
        },
        include: {
            // Members who have left are excluded: remove_member() refunds and
            // zeroes their on-chain total_contributions, and their settlement
            // is already recorded in MemberExitLog, so they are not comparable
            // against an ongoing DB total here.
            members: {
                where: { status: 'ACTIVE' },
                include: { user: true },
            },
        },
    });

    summary.groupsScanned = groups.length;

    for (const group of groups) {
        const contractId = group.stellarContractId!;

        for (const membership of group.members) {
            const member = membership.user;
            summary.membersChecked++;

            if (!member.stellarWallet) continue;

            let memberPublicKey: string;
            try {
                const wallet = JSON.parse(member.stellarWallet as string);
                memberPublicKey = wallet.publicKey;
            } catch {
                summary.errors.push(`[group=${group.id}] Could not parse wallet for user ${member.id}`);
                continue;
            }

            // 1. Query on-chain contribution (returns stroops as bigint)
            let onChainStroops: bigint;
            try {
                onChainStroops = await sorobanService.queryContribution(contractId, memberPublicKey);
            } catch (err: any) {
                summary.errors.push(
                    `[group=${group.id}] queryContribution failed for user ${member.id}: ${err.message}`,
                );
                observabilityService.logError('ReconciliationWorker: queryContribution error', err, {
                    groupId: group.id,
                    userId: member.id,
                });
                continue;
            }

            // 2. Sum ALL completed DB contributions for this member, across every
            // cycle — not just the current one. The contract's get_contribution()
            // returns a lifetime-cumulative total_contributions, so comparing it
            // against a single-cycle DB window produced a false mismatch for any
            // member who had already contributed in an earlier, completed cycle.
            //
            // Withdrawals and emergency-withdraws are not reachable through any
            // current backend flow (handleWithdraw() is a stub that never invokes
            // the contract), so they are not modeled as debits here. A member who
            // has exited is excluded from this scan entirely (see the query
            // above) rather than modeled as a refund debit, since remove_member()
            // zeroes their on-chain total and their settlement is already
            // recorded in MemberExitLog.
            //
            // Each row is converted individually with xlmToStroops (exact
            // string/integer arithmetic) and summed as bigint, so this side of
            // the comparison never passes through floating point either.
            let dbStroops: bigint;
            try {
                const dbContributions = await prisma.contribution.findMany({
                    where: {
                        userId: member.id,
                        groupId: group.id,
                        status: 'COMPLETED',
                    },
                });
                dbStroops = dbContributions.reduce((acc, c) => acc + xlmToStroops(String(c.amount)), 0n);
            } catch (err: any) {
                summary.errors.push(
                    `[group=${group.id}] failed to total DB contributions for user ${member.id}: ${err.message}`,
                );
                observabilityService.logError('ReconciliationWorker: DB aggregation error', err, {
                    groupId: group.id,
                    userId: member.id,
                });
                continue;
            }

            // 3. Compare — allow a 1-stroop tolerance for floating-point rounding
            if (onChainStroops === dbStroops || Math.abs(Number(onChainStroops - dbStroops)) <= 1) {
                continue; // ✅ in sync
            }

            // 4. Mismatch detected — log for admin review, do NOT auto-fix
            summary.mismatchesFound++;

            const onChainXlm = new Prisma.Decimal(Number(onChainStroops) / 10_000_000);
            const dbXlm = new Prisma.Decimal(Number(dbStroops) / 10_000_000);

            // Re-running every 5 minutes must not keep piling up rows for the
            // same ongoing, unresolved divergence — only persist a new record
            // if this member doesn't already have one awaiting admin review.
            const existingUnresolved = await prisma.reconciliationMismatch.findFirst({
                where: { groupId: group.id, userId: member.id, resolvedAt: null },
            });

            if (!existingUnresolved) {
                await prisma.reconciliationMismatch.create({
                    data: {
                        groupId: group.id,
                        userId: member.id,
                        onChainAmount: onChainXlm,
                        dbAmount: dbXlm,
                    },
                });
            }

            observabilityService.logError(
                'RECONCILIATION_MISMATCH',
                new Error('On-chain contribution amount does not match DB total'),
                {
                    groupId: group.id,
                    userId: member.id,
                    onChainXlm: onChainXlm.toString(),
                    dbXlm: dbXlm.toString(),
                    deltaSproops: (onChainStroops - dbStroops).toString(),
                },
            );
        }
    }

    observabilityService.logInfo('[ContractSyncWorker] Reconciliation run complete', {
        groupsScanned: summary.groupsScanned,
        membersChecked: summary.membersChecked,
        mismatchesFound: summary.mismatchesFound,
        errors: summary.errors.length,
    });

    return summary;
}

export interface ReconciliationSummary {
    groupsScanned: number;
    membersChecked: number;
    mismatchesFound: number;
    errors: string[];
}

export async function closeContractSyncWorker(): Promise<void> {
    if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
    }
}
