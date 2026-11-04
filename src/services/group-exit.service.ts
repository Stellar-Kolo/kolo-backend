import * as StellarSdk from '@stellar/stellar-sdk';
import { prisma } from '../lib/prisma';
import { PayoutService } from './payout.service';
import { SorobanService } from './soroban.service';
import { WhatsAppService } from './whatsapp.service';
import { removeGroupCycle } from '../queue/contribution-scheduler.queue';
import { config } from '../config/env';

export type GroupExitErrorCode =
    | 'group_not_found'
    | 'not_a_member'
    | 'already_left'
    | 'payout_received'
    | 'not_creator'
    | 'target_not_found'
    | 'cannot_kick_self';

/** Error thrown when a voluntary exit (LEAVE) or removal (KICK) cannot proceed. */
export class GroupExitError extends Error {
    constructor(public code: GroupExitErrorCode) {
        super(`Group exit error: ${code}`);
        this.name = 'GroupExitError';
    }
}

export interface ExitResult {
    member: any;
    totalContributed: string;
    totalReceived: string;
    netOwed: string;
    refundTxHash: string | null;
    groupPaused: boolean;
    creatorTransferredTo: string | null;
}

/**
 * Shared settlement path for both voluntary exit (LEAVE GROUP) and admin
 * removal (KICK): refund any positive net position, remove the member from
 * the Soroban contract and the payout rotation, soft-delete their membership,
 * transfer the creator role on if needed, and pause the group if membership
 * drops below the 2-member minimum. LEAVE and KICK must never diverge on this
 * path — only on who is allowed to trigger it.
 */
export class GroupExitService {
    private payoutService: PayoutService;
    private sorobanService: SorobanService;
    private whatsappService: WhatsAppService;

    constructor(payoutService?: PayoutService, sorobanService?: SorobanService, whatsappService?: WhatsAppService) {
        this.payoutService = payoutService ?? new PayoutService();
        this.sorobanService = sorobanService ?? new SorobanService();
        this.whatsappService = whatsappService ?? new WhatsAppService();
    }

    public async leaveGroup(userId: string, groupId: string): Promise<ExitResult> {
        const { group, member } = await this.loadGroupAndMember(groupId, userId);
        await this.assertCanExit(group, member);
        return this.performExit(group, member, userId, 'LEAVE');
    }

    public async kickMember(requesterUserId: string, groupId: string, targetUserId: string): Promise<ExitResult> {
        if (requesterUserId === targetUserId) {
            throw new GroupExitError('cannot_kick_self');
        }

        const group = await this.loadGroup(groupId);

        const requester = group.members.find((m: any) => m.userId === requesterUserId && m.status !== 'LEFT');
        if (!requester || requester.role !== 'CREATOR') {
            throw new GroupExitError('not_creator');
        }

        const member = group.members.find((m: any) => m.userId === targetUserId);
        if (!member) {
            throw new GroupExitError('target_not_found');
        }
        if (member.status === 'LEFT') {
            throw new GroupExitError('already_left');
        }

        await this.assertCanExit(group, member);
        return this.performExit(group, member, requesterUserId, 'KICK');
    }

    private async loadGroup(groupId: string) {
        const group = await prisma.savingsGroup.findUnique({
            where: { id: groupId },
            include: { members: { include: { user: true }, orderBy: { joinedAt: 'asc' } } },
        });
        if (!group) throw new GroupExitError('group_not_found');
        return group;
    }

    private async loadGroupAndMember(groupId: string, userId: string) {
        const group = await this.loadGroup(groupId);
        const member = group.members.find((m: any) => m.userId === userId);
        if (!member) throw new GroupExitError('not_a_member');
        if (member.status === 'LEFT') throw new GroupExitError('already_left');
        return { group, member };
    }

    /**
     * A member may exit only if they have not already received a payout in
     * the current cycle — otherwise they'd be taking money and leaving.
     */
    private async assertCanExit(group: any, member: any): Promise<void> {
        const cycleNumber = (group.totalCycles ?? 0) + 1;
        const payoutThisCycle = await prisma.payout.findFirst({
            where: { groupId: group.id, recipientId: member.userId, cycleNumber },
        });
        if (payoutThisCycle) throw new GroupExitError('payout_received');
    }

    private async computeSettlement(groupId: string, userId: string) {
        const [contributions, payouts] = await Promise.all([
            prisma.contribution.aggregate({
                where: { groupId, userId, status: 'COMPLETED' },
                _sum: { amount: true },
            }),
            prisma.payout.aggregate({
                where: { groupId, recipientId: userId },
                _sum: { amount: true },
            }),
        ]);

        const totalContributed = Number(contributions._sum.amount ?? 0);
        const totalReceived = Number(payouts._sum.amount ?? 0);
        const netOwed = totalContributed - totalReceived;

        return { totalContributed, totalReceived, netOwed };
    }

    private async performExit(group: any, member: any, initiatedBy: string, type: 'LEAVE' | 'KICK'): Promise<ExitResult> {
        const { totalContributed, totalReceived, netOwed } = await this.computeSettlement(group.id, member.userId);

        // Positive net position: the member is owed a refund from the group pool.
        // Negative: the group absorbs the loss — never charged back to the exiting member.
        let refundTxHash: string | null = null;
        if (netOwed > 0) {
            const refund = await this.payoutService.refundMember(group.id, member.userId, String(netOwed));
            refundTxHash = refund?.hash ?? null;
        }

        if (group.stellarContractId && member.user?.stellarWallet && config.DEPLOYER_SECRET_KEY) {
            try {
                const memberPublicKey = JSON.parse(member.user.stellarWallet).publicKey;
                const adminSeed = StellarSdk.StrKey.decodeEd25519SecretSeed(config.DEPLOYER_SECRET_KEY);
                const adminKeypair = StellarSdk.Keypair.fromRawEd25519Seed(adminSeed);
                try {
                    await this.sorobanService.removeMember(adminKeypair, group.stellarContractId, memberPublicKey);
                } finally {
                    adminSeed.fill(0);
                }
            } catch (e) {
                console.error(`Failed to remove member ${member.userId} from Soroban contract for group ${group.id}`, e);
            }
        }

        await prisma.groupMember.update({
            where: { id: member.id },
            data: { status: 'LEFT', leftAt: new Date() },
        });

        await prisma.memberExitLog.create({
            data: {
                groupId: group.id,
                userId: member.userId,
                initiatedBy,
                type,
                totalContributed: String(totalContributed),
                totalReceived: String(totalReceived),
                netOwed: String(netOwed),
                refundTxHash,
            },
        });

        await this.payoutService
            .removeMemberFromOrder(group.id, member.userId)
            .catch((e) => console.error(`Failed to adjust payout order for group ${group.id}`, e));

        const remainingActive = group.members.filter((m: any) => m.userId !== member.userId && m.status !== 'LEFT');

        let creatorTransferredTo: string | null = null;
        if (member.role === 'CREATOR') {
            const nextCreator = [...remainingActive].sort(
                (a: any, b: any) => new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime(),
            )[0];
            if (nextCreator) {
                await prisma.groupMember.update({ where: { id: nextCreator.id }, data: { role: 'CREATOR' } });
                creatorTransferredTo = nextCreator.userId;
            }
        }

        let groupPaused = false;
        if (remainingActive.length <= 1) {
            groupPaused = true;
            await prisma.savingsGroup.update({
                where: { id: group.id },
                data: { isPaused: true, pausedAt: new Date() },
            });
            await removeGroupCycle(group.id, group.contributionFrequency).catch((e) =>
                console.error(`Failed to stop scheduled reminders for group ${group.id}`, e),
            );
        }

        const memberName = member.user?.username ? `@${member.user.username}` : member.user?.phoneNumber ?? 'A member';
        await this.notifyGroup(group.id, member.userId, `${memberName} has left the group`);

        if (groupPaused && remainingActive.length === 1) {
            const lastMember = remainingActive[0];
            if (lastMember.user?.phoneNumber) {
                await this.whatsappService.sendMessage(
                    lastMember.user.phoneNumber,
                    `⚠️ Your group "${group.name}" has been paused — at least 2 members are required. Invite someone to resume contributions.`,
                );
            }
        }

        return {
            member,
            totalContributed: String(totalContributed),
            totalReceived: String(totalReceived),
            netOwed: String(netOwed),
            refundTxHash,
            groupPaused,
            creatorTransferredTo,
        };
    }

    private async notifyGroup(groupId: string, excludeUserId: string, message: string): Promise<void> {
        const members = await prisma.groupMember.findMany({
            where: { groupId, status: { not: 'LEFT' }, userId: { not: excludeUserId } },
            include: { user: true },
        });
        for (const m of members) {
            if (!m.user?.phoneNumber) continue;
            try {
                await this.whatsappService.sendMessage(m.user.phoneNumber, message);
            } catch (e) {
                console.error(`Failed to notify ${m.user.phoneNumber}`, e);
            }
        }
    }
}
