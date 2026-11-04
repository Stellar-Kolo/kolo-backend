import { PrismaClient, Prisma } from '@prisma/client';
import * as StellarSdk from '@stellar/stellar-sdk';
import { WhatsAppService } from './whatsapp.service';
import { SorobanService } from './soroban.service';
import { config } from '../config/env';
import { enqueueCycleEnd } from '../queue/contribution-scheduler.queue';
import { xlmToStroops } from '../utils/stellar-amount.util';
import { decrypt } from '../utils/encryption.util';
import { registerSecret, unregisterSecret } from '../utils/secret-registry';

const prisma = new PrismaClient();

/**
 * Builds the keypair for the contract's on-chain admin. This must be the
 * exact identity passed as `admin` to initialize() (see
 * SorobanService.deployGroupContract) — payout() and remove_member() both
 * check admin.require_auth_for_args against it.
 */
function getAdminKeypair(): StellarSdk.Keypair {
    if (!config.DEPLOYER_SECRET_KEY) {
        throw new Error('No admin signer configured — set DEPLOYER_SECRET_KEY to enable payouts and member removal.');
    }
    const seed = StellarSdk.StrKey.decodeEd25519SecretSeed(config.DEPLOYER_SECRET_KEY);
    try {
        return StellarSdk.Keypair.fromRawEd25519Seed(seed);
    } finally {
        seed.fill(0);
    }
}

export class PayoutOrderLockedError extends Error {
    constructor() {
        super('Payout order is locked for this cycle — the first contribution has already been recorded.');
        this.name = 'PayoutOrderLockedError';
    }
}

export class InvalidPayoutOrderError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidPayoutOrderError';
    }
}

export interface CycleContributionStatus {
    group: any;
    order: string[];
    cycleNumber: number;
    contributedUserIds: Set<string>;
    missingUserIds: string[];
    allContributed: boolean;
}

export class PayoutService {
    private whatsappService: WhatsAppService;
    private sorobanService: SorobanService;

    constructor(whatsappService?: WhatsAppService, sorobanService?: SorobanService) {
        this.whatsappService = whatsappService ?? new WhatsAppService();
        this.sorobanService = sorobanService ?? new SorobanService();
    }

    /**
     * Resolves the effective payout order for a group: the explicitly configured
     * order if one has been set, otherwise the order members joined in.
     */
    private resolveOrder(group: any): string[] {
        if (Array.isArray(group.payoutOrder) && group.payoutOrder.length > 0) {
            return group.payoutOrder as string[];
        }
        return group.members.map((m: any) => m.userId);
    }

    public async getEffectivePayoutOrder(groupId: string): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' } } },
        });
        if (!group) throw new Error('Group not found');
        return this.resolveOrder(group);
    }

    /**
     * Lets the group creator set or reorder the payout rotation. Locked once the
     * first contribution of a cycle has been recorded (see lockOrderForCycle).
     */
    public async setPayoutOrder(groupId: string, requesterUserId: string, order: string[]): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: true },
        });
        if (!group) throw new Error('Group not found');

        const requester = group.members.find((m: any) => m.userId === requesterUserId);
        if (!requester || requester.role !== 'CREATOR') {
            throw new Error('Only the group creator can set the payout order.');
        }

        if ((group as any).payoutOrderLockedAt) {
            throw new PayoutOrderLockedError();
        }

        const memberIds = new Set(group.members.map((m: any) => m.userId));
        const orderSet = new Set(order);
        if (orderSet.size !== order.length) {
            throw new InvalidPayoutOrderError('Payout order cannot contain duplicate members.');
        }
        if (orderSet.size !== memberIds.size || [...memberIds].some((id) => !orderSet.has(id))) {
            throw new InvalidPayoutOrderError('Payout order must include every current group member exactly once.');
        }

        const previousOrder = this.resolveOrder(group);

        await prisma.$transaction([
            prisma.savingsGroup.update({
                where: { id: groupId },
                data: { payoutOrder: order },
            }),
            prisma.payoutOrderLog.create({
                data: {
                    groupId,
                    changedBy: requesterUserId,
                    previousOrder,
                    newOrder: order,
                    reason: 'REORDER',
                },
            }),
        ]);

        return order;
    }

    /**
     * Locks in the payout order the moment the first contribution of a cycle
     * lands, so a creator can no longer reshuffle who gets paid after members
     * have already started contributing under the existing order.
     */
    public async lockOrderForCycle(groupId: string): Promise<void> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' } } },
        });
        if (!group || (group as any).payoutOrderLockedAt) return;

        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                payoutOrderLockedAt: new Date(),
                payoutOrder: this.resolveOrder(group),
            },
        });
    }

    public async getCycleContributionStatus(groupId: string): Promise<CycleContributionStatus> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: true } } },
        });
        if (!group) throw new Error('Group not found');

        const order = this.resolveOrder(group);
        const cycleNumber = (group as any).totalCycles + 1;

        const cycleWhere: any = { groupId, status: 'COMPLETED' };
        if (group.currentCycleStart) {
            cycleWhere.createdAt = { gte: group.currentCycleStart };
            if (group.currentCycleEnd) {
                cycleWhere.createdAt.lt = group.currentCycleEnd;
            }
        }

        const contributions = await prisma.contribution.findMany({ where: cycleWhere });
        const contributedUserIds = new Set(contributions.map((c) => c.userId));
        const missingUserIds = order.filter((userId) => !contributedUserIds.has(userId));

        return {
            group,
            order,
            cycleNumber,
            contributedUserIds,
            missingUserIds,
            allContributed: missingUserIds.length === 0,
        };
    }

    public async sendFinalWarnings(groupId: string): Promise<void> {
        const status = await this.getCycleContributionStatus(groupId);
        if (status.allContributed) return;

        const membersById = new Map(status.group.members.map((m: any) => [m.userId, m.user]));
        for (const userId of status.missingUserIds) {
            const user: any = membersById.get(userId);
            if (!user?.phoneNumber) continue;
            await this.whatsappService.sendMessage(
                user.phoneNumber,
                `⚠️ Final warning: you haven't contributed to "${status.group.name}" for this cycle yet. Please contribute before the group creator finalizes the payout.`,
            );
        }
    }

    /** Extends the current cycle's contribution deadline by 24h, up to a configured maximum. */
    public async extendDeadline(groupId: string): Promise<Date> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new Error('Group not found');
        if (!group.currentCycleEnd) throw new Error('Group has no active cycle.');

        if ((group as any).deadlineExtensionsUsed >= config.MAX_PAYOUT_DEADLINE_EXTENSIONS) {
            throw new Error(`Maximum deadline extensions (${config.MAX_PAYOUT_DEADLINE_EXTENSIONS}) already used for this cycle.`);
        }

        const newEnd = new Date(group.currentCycleEnd.getTime() + 24 * 60 * 60 * 1000);
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                currentCycleEnd: newEnd,
                deadlineExtensionsUsed: { increment: 1 },
            },
        });

        await enqueueCycleEnd(groupId, newEnd.getTime() - Date.now());
        await this.notifyAllMembers(groupId, `⏳ The contribution deadline for "${group.name}" has been extended by 24 hours.`);

        return newEnd;
    }

    /** Moves a defaulting member to the back of the rotation and logs the change for audit. */
    public async skipDefaultingMember(groupId: string, requesterUserId: string, defaultingUserId: string): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId }, include: { members: true } });
        if (!group) throw new Error('Group not found');

        const requester = group.members.find((m: any) => m.userId === requesterUserId);
        if (!requester || requester.role !== 'CREATOR') {
            throw new Error('Only the group creator can skip a defaulting member.');
        }

        const currentOrder = this.resolveOrder(group);
        if (!currentOrder.includes(defaultingUserId)) {
            throw new InvalidPayoutOrderError('That member is not part of the current payout order.');
        }

        const newOrder = currentOrder.filter((id) => id !== defaultingUserId);
        newOrder.push(defaultingUserId);

        await prisma.$transaction([
            prisma.savingsGroup.update({
                where: { id: groupId },
                data: { payoutOrder: newOrder },
            }),
            prisma.payoutOrderLog.create({
                data: {
                    groupId,
                    changedBy: requesterUserId,
                    previousOrder: currentOrder,
                    newOrder,
                    reason: 'SKIP_DEFAULT',
                },
            }),
        ]);

        return newOrder;
    }

    /** Pays out the reduced pool made up of only the members who actually contributed this cycle. */
    public async proceedWithPartialPool(groupId: string): Promise<any> {
        const status = await this.getCycleContributionStatus(groupId);
        const partialAmount = status.contributedUserIds.size * parseFloat(String(status.group.contributionAmount));
        return this.executePayout(groupId, String(partialAmount));
    }

    /**
     * Settles a positive net position (totalContributed - totalReceived) when
     * a member exits the group. Unlike executePayout(), this does not touch
     * the rotation index, cycle count, or Payout table: it's a settlement,
     * not a rotation payout.
     *
     * Only GoalBased groups have a sound on-chain mechanism for this: the
     * member calls withdraw_savings() themselves against their own recorded
     * total_contributions. Rotational groups have no such primitive — each
     * cycle's pool is paid out in full to that cycle's one recipient as soon
     * as it's collected, so a net position from an *earlier, already-settled*
     * cycle isn't sitting in the contract's balance to refund; only the
     * *current* cycle's contribution is refundable, and remove_member()
     * already does that automatically as part of removing the member. Calling
     * this for a Rotational group therefore does not attempt an on-chain
     * transfer — the computed netOwed is still recorded in MemberExitLog by
     * the caller, but as a settlement to resolve manually, not an automatic
     * payment.
     */
    public async refundMember(groupId: string, userId: string, amount: string): Promise<{ hash: string } | null> {
        if (parseFloat(amount) <= 0) return null;

        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { include: { user: true } } },
        });
        if (!group) throw new Error('Group not found');

        if (((group as any).groupType ?? 'Rotational') !== 'GoalBased') {
            return null;
        }

        const member = group.members.find((m: any) => m.userId === userId);
        if (!member?.user?.stellarWallet) {
            throw new Error(`Member ${userId} has no configured wallet; cannot process refund.`);
        }
        if (!group.stellarContractId) {
            throw new Error(`Group ${groupId} has no deployed contract; cannot process refund.`);
        }

        const memberWallet = JSON.parse(member.user.stellarWallet);
        let memberSecret: Buffer | null = null;
        try {
            memberSecret = decrypt(
                memberWallet.encryptedSecret,
                memberWallet.iv,
                memberWallet.authTag,
                memberWallet.keyVersion || member.user.encryptionKeyVersion,
            );
            registerSecret(memberSecret);
            const memberKeypair = StellarSdk.Keypair.fromRawEd25519Seed(memberSecret);
            const amountStroops = xlmToStroops(amount);

            const { hash } = await this.sorobanService.withdrawSavings(
                memberKeypair,
                group.stellarContractId,
                memberKeypair.publicKey(),
                amountStroops,
            );

            return { hash };
        } finally {
            if (memberSecret) {
                unregisterSecret(memberSecret);
                memberSecret.fill(0);
            }
        }
    }

    /**
     * Removes an exited member from the payout rotation, materializing the
     * default join order into an explicit payoutOrder first if none was set.
     * The current payout index is clamped so it still points at a valid
     * (or the last) position in the shortened order.
     */
    public async removeMemberFromOrder(groupId: string, exitedUserId: string): Promise<string[]> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' } } },
        });
        if (!group) throw new Error('Group not found');

        const currentOrder = this.resolveOrder(group);
        if (!currentOrder.includes(exitedUserId)) return currentOrder;

        const newOrder = currentOrder.filter((id) => id !== exitedUserId);
        const currentIndex = (group as any).currentPayoutIndex ?? 0;
        const newIndex = newOrder.length === 0 ? 0 : Math.min(currentIndex, newOrder.length - 1);

        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: { payoutOrder: newOrder, currentPayoutIndex: newIndex },
        });

        return newOrder;
    }

    /**
     * Executes the contract's payout() for the next recipient in rotation.
     *
     * `amountOverride` only affects the amount recorded on the DB Payout
     * row — the contract itself always transfers its own computed pool
     * (contribution_amount × the cycle's frozen member count) from its own
     * balance; there is no on-chain partial-payout mechanism. If called via
     * proceedWithPartialPool() while the contract's balance is short of the
     * full pool, the on-chain call panics ("Insufficient funds in contract
     * for full payout") rather than silently paying a reduced amount.
     */
    public async executePayout(groupId: string, amountOverride?: string): Promise<any> {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { orderBy: { joinedAt: 'asc' }, include: { user: true } } },
        });
        if (!group) throw new Error('Group not found');
        if (!group.stellarContractId) throw new Error(`Group ${groupId} has no deployed contract; cannot execute payout.`);

        const order = this.resolveOrder(group);
        if (order.length === 0) throw new Error('Group has no members to pay out to.');

        const cycleNumber = (group as any).totalCycles + 1;

        // Idempotency: a cycle-end retry or an extended-deadline re-check should
        // never pay the same recipient twice for the same cycle.
        const existingPayout = await prisma.payout.findFirst({ where: { groupId, cycleNumber } });
        if (existingPayout) {
            return existingPayout;
        }

        const recipientUserId = order[(group as any).currentPayoutIndex];
        const recipientMember = group.members.find((m: any) => m.userId === recipientUserId);
        if (!recipientMember?.user?.stellarWallet) {
            throw new Error(`Recipient ${recipientUserId} has no configured wallet; cannot execute payout.`);
        }

        const recipientPublicKey = JSON.parse(recipientMember.user.stellarWallet).publicKey;
        const amount = amountOverride ?? new Prisma.Decimal(group.contributionAmount).times(order.length).toString();

        const adminKeypair = getAdminKeypair();
        const { hash } = await this.sorobanService.payout(adminKeypair, group.stellarContractId, recipientPublicKey);

        // Every payout ends a contract-side contribution cycle (finer-grained
        // than the backend's own "cycle" = one full rotation) — advance it so
        // the next round of contribute() calls isn't rejected as a repeat.
        await this.sorobanService.resetCycle(adminKeypair, group.stellarContractId);

        const payout = await prisma.payout.create({
            data: {
                groupId,
                recipientId: recipientUserId,
                amount,
                transactionHash: hash,
                cycleNumber,
                status: 'COMPLETED',
            },
        });

        const nextIndex = (group as any).currentPayoutIndex + 1;
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: { currentPayoutIndex: nextIndex },
        });

        const recipientName = recipientMember.user.username ? `@${recipientMember.user.username}` : recipientMember.user.phoneNumber;
        await this.notifyAllMembers(groupId, `💸 ${recipientName} has received their payout of ${amount} USDC`);

        if (nextIndex >= order.length) {
            await this.completeCycle(groupId);
        }

        return payout;
    }

    /**
     * Called once every member has received a payout this rotation. Resets
     * the on-chain rotation index (NextPayoutIndex) back to the first
     * member — the per-payout contract cycle was already advanced by
     * resetCycle() in executePayout(), so this calls reset_rotation(), not
     * reset_cycle() again.
     */
    public async completeCycle(groupId: string): Promise<void> {
        const group = await prisma.savingsGroup.findUnique({ where: { id: groupId } });
        if (!group) throw new Error('Group not found');
        if (!group.stellarContractId) throw new Error(`Group ${groupId} has no deployed contract; cannot reset rotation.`);

        await this.sorobanService.resetRotation(getAdminKeypair(), group.stellarContractId);

        const newTotalCycles = (group as any).totalCycles + 1;
        await prisma.savingsGroup.update({
            where: { id: groupId },
            data: {
                totalCycles: newTotalCycles,
                currentPayoutIndex: 0,
                deadlineExtensionsUsed: 0,
                payoutOrderLockedAt: null,
            },
        });

        await this.notifyAllMembers(groupId, `🎉 Cycle ${newTotalCycles} complete! A new rotation begins.`);
    }

    /**
     * Entry point called when a group's contribution cycle ends. Pays out
     * automatically if every member contributed; otherwise warns defaulters and
     * asks the creator to choose WAIT, PROCEED, or SKIP.
     */
    public async processCycleEnd(groupId: string): Promise<void> {
        const status = await this.getCycleContributionStatus(groupId);

        if (status.allContributed) {
            await this.executePayout(groupId);
            return;
        }

        await this.sendFinalWarnings(groupId);

        const creator = status.group.members.find((m: any) => m.role === 'CREATOR');
        if (creator?.user?.phoneNumber) {
            await this.whatsappService.sendMessage(
                creator.user.phoneNumber,
                `⚠️ Not everyone has contributed to "${status.group.name}" this cycle. Reply with:\n` +
                `PAYOUT WAIT — extend the deadline by 24h\n` +
                `PAYOUT PROCEED — pay out with the partial pool\n` +
                `PAYOUT SKIP <phone or @username> — skip the defaulting member and reorder`,
            );
        }
    }

    private async notifyAllMembers(groupId: string, message: string): Promise<void> {
        const members = await prisma.groupMember.findMany({ where: { groupId }, include: { user: true } });
        for (const member of members) {
            if (!member.user?.phoneNumber) continue;
            try {
                await this.whatsappService.sendMessage(member.user.phoneNumber, message);
            } catch (e) {
                console.error(`Failed to notify ${member.user.phoneNumber}`, e);
            }
        }
    }
}
