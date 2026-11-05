import * as StellarSdk from '@stellar/stellar-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config/env';
import { observabilityService } from './observability.service';

// Module-level compatibility aliases for issue requirements
if (!(StellarSdk.Operation as any).uploadWasm) {
    (StellarSdk.Operation as any).uploadWasm = StellarSdk.Operation.uploadContractWasm;
}

if (!(StellarSdk as any).SorobanRpc) {
    (StellarSdk as any).SorobanRpc = StellarSdk.rpc;
}

export interface DeployGroupContractParams {
    groupId: string;
    name: string;
    contributionAmount: string | number | bigint;
    /** Mirrors the contract's GroupType enum. Defaults to 'Rotational'. */
    groupType?: 'Rotational' | 'GoalBased';
    targetAmount?: string | number | bigint | null;
    lockUntilTarget?: boolean;
    expectedCycleDays?: number | null;
    wasmPath?: string;
}

/**
 * Encodes a unit variant of the contract's GroupType union (no associated
 * data) the way the Soroban Rust SDK represents a plain `#[contracttype]`
 * union case: a one-element Vec holding the case name as a Symbol. Confirmed
 * against the built contract's own spec (`stellar contract info interface`),
 * which reports GroupType as `udt_union_v0` with `void_v0` cases.
 */
function groupTypeToScVal(groupType: 'Rotational' | 'GoalBased'): StellarSdk.xdr.ScVal {
    return StellarSdk.xdr.ScVal.scvVec([StellarSdk.xdr.ScVal.scvSymbol(groupType)]);
}

/** Option<T>::None is ScVal::Void; Option<T>::Some(x) is just x's own ScVal. */
function optionToScVal<T>(value: T | null | undefined, toScVal: (v: T) => StellarSdk.xdr.ScVal): StellarSdk.xdr.ScVal {
    return value === null || value === undefined ? StellarSdk.xdr.ScVal.scvVoid() : toScVal(value);
}

export interface DeploymentResult {
    contractId: string;
    latency: number;
}

/**
 * Low-level helper for deploying and invoking Soroban contracts.
 *
 * This service is intentionally designed to work against the configured
 * Soroban RPC endpoint and to operate in both testnet and public network modes.
 */
export class SorobanService {
    public server: StellarSdk.rpc.Server;

    /**
     * Create a SorobanService binding to the configured RPC endpoint.
     *
     * @param rpcUrl optional override for the Soroban RPC endpoint URL.
     */
    constructor(rpcUrl?: string) {
        const url = rpcUrl || config.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
        this.server = new StellarSdk.rpc.Server(url);
    }

    /**
     * Returns the active Stellar network passphrase based on application config.
     */
    public getNetworkPassphrase(): string {
        return config.STELLAR_NETWORK === 'TESTNET'
            ? StellarSdk.Networks.TESTNET
            : StellarSdk.Networks.PUBLIC;
    }

    /**
     * Loads the compiled .wasm contract binary from a configurable path.
     */
    public loadContractWasm(wasmPath?: string): Buffer {
        const targetPath = wasmPath || config.CONTRACT_WASM_PATH;
        const resolvedPath = path.isAbsolute(targetPath) ? targetPath : path.resolve(process.cwd(), targetPath);

        if (!fs.existsSync(resolvedPath)) {
            throw new Error(`WASM contract file not found at path: ${resolvedPath}`);
        }

        return fs.readFileSync(resolvedPath);
    }

    /**
     * Simulates transaction, handles retries for PENDING responses, applies restorePreamble if present,
     * and assembles resource limits & bumps fee to >= 1000 stroops.
     */
    public async simulateAndAssembleTransaction(
        tx: StellarSdk.Transaction,
        server?: StellarSdk.rpc.Server
    ): Promise<StellarSdk.Transaction> {
        const srv = server || this.server;
        let simRes: StellarSdk.rpc.Api.SimulateTransactionResponse | null = null;
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            simRes = await srv.simulateTransaction(tx);

            if (simRes && (simRes as any).status === 'PENDING') {
                if (attempts < maxAttempts) {
                    await new Promise((resolve) => setTimeout(resolve, 1000 * attempts));
                    continue;
                }
            }
            break;
        }

        if (!simRes) {
            throw new Error('Simulation failed: No response received from Soroban RPC.');
        }

        if (StellarSdk.rpc.Api.isSimulationError(simRes)) {
            throw new Error(`Simulation failed: ${(simRes as any).error || 'Unknown simulation error'}`);
        }

        // Handle restorePreamble for expired ledger entries
        if ((simRes as any).restorePreamble) {
            const preamble = (simRes as any).restorePreamble;
            if (preamble.transactionData) {
                // In the raw RPC response, transactionData is a base64 XDR string.
                // After parseRawSimulation, it becomes a SorobanDataBuilder instance.
                const sorobanData = typeof preamble.transactionData === 'string'
                    ? new StellarSdk.SorobanDataBuilder(preamble.transactionData).build()
                    : preamble.transactionData.build();

                tx = StellarSdk.TransactionBuilder.cloneFrom(tx, {
                    fee: tx.fee,
                    sorobanData,
                }).build();
            }
        }

        // Assemble transaction to attach resource limits from simulation
        const txBuilder = StellarSdk.rpc.assembleTransaction(tx, simRes);
        let assembledTx = txBuilder.build();

        // Enforce fee bumping: if base fee < 1000 stroops, bump to 1000
        const currentFee = Number(assembledTx.fee);
        if (isNaN(currentFee) || currentFee < 1000) {
            assembledTx = StellarSdk.TransactionBuilder.cloneFrom(assembledTx, {
                fee: '1000',
            }).build();
        }

        return assembledTx;
    }

    /**
     * Signs and submits a transaction, polling until confirmed or the poll limit
     * is reached.
     *
     * @returns `{ hash, status }` where status is `'SUCCESS'` when confirmed,
     *   `'PENDING'` when the poll limit expired before confirmation, or throws
     *   when the network returns an error or the transaction is `FAILED`.
     */
    public async submitTransaction(
        tx: StellarSdk.Transaction,
        signerKeypair: StellarSdk.Keypair,
        server?: StellarSdk.rpc.Server,
        options?: { maxPolls?: number; pollIntervalMs?: number }
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const maxPolls = options?.maxPolls ?? 10;
        const pollIntervalMs = options?.pollIntervalMs ?? 2000;

        tx.sign(signerKeypair);

        const response = await srv.sendTransaction(tx);
        const responseStatus = (response as any).status as string;

        if (responseStatus === 'ERROR') {
            throw new Error(`Transaction submission failed: ${JSON.stringify((response as any).errorResultXdr || response)}`);
        }

        const hash = (response as any).hash as string | undefined;
        if (!hash) {
            throw new Error('Transaction submission did not return a valid hash.');
        }

        if (responseStatus === 'SUCCESS') {
            return { hash, status: 'SUCCESS' };
        }

        // Poll for confirmation if PENDING or TRY_AGAIN_LATER
        let polls = 0;
        while (polls < maxPolls) {
            polls++;
            await new Promise((res) => setTimeout(res, pollIntervalMs));
            const statusRes = await srv.getTransaction(hash);
            const txStatus = (statusRes as any).status as string;

            if (txStatus === 'SUCCESS') {
                return { hash, status: 'SUCCESS' };
            }
            if (txStatus === 'FAILED') {
                throw new Error(`Transaction failed on ledger: ${hash}`);
            }
            // NOT_FOUND or PENDING — keep polling
        }

        // Poll limit reached without confirmation
        return { hash, status: 'PENDING' };
    }

    /**
     * Uploads the WASM binary to the Stellar network using StellarSdk.Operation.uploadContractWasm / uploadWasm.
     */
    public async uploadWasm(
        deployerKeypair: StellarSdk.Keypair,
        wasmBuffer: Buffer,
        server?: StellarSdk.rpc.Server
    ): Promise<{ wasmHash: Buffer; txHash: string }> {
        const srv = server || this.server;
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const uploadOp = (StellarSdk.Operation as any).uploadWasm
            ? (StellarSdk.Operation as any).uploadWasm({ wasm: wasmBuffer })
            : StellarSdk.Operation.uploadContractWasm({ wasm: wasmBuffer });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(uploadOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const { hash: txHash } = await this.submitTransaction(tx, deployerKeypair, srv);
        const wasmHash = StellarSdk.hash(wasmBuffer);

        return { wasmHash, txHash };
    }

    /**
     * Creates the contract instance using StellarSdk.Operation.createCustomContract().
     */
    public async createCustomContract(
        deployerKeypair: StellarSdk.Keypair,
        wasmHash: Buffer,
        salt?: Buffer,
        server?: StellarSdk.rpc.Server
    ): Promise<{ contractId: string; txHash: string }> {
        const srv = server || this.server;
        const actualSalt = salt || crypto.randomBytes(32);
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const createOp = StellarSdk.Operation.createCustomContract({
            address: new StellarSdk.Address(deployerKeypair.publicKey()),
            wasmHash,
            salt: actualSalt,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(createOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const { hash: txHash } = await this.submitTransaction(tx, deployerKeypair, srv);

        // Derive contract ID from address, salt, and network passphrase
        const preimage = StellarSdk.xdr.HashIdPreimage.envelopeTypeContractId(
            new StellarSdk.xdr.HashIdPreimageContractId({
                networkId: StellarSdk.hash(Buffer.from(this.getNetworkPassphrase())),
                contractIdPreimage: StellarSdk.xdr.ContractIdPreimage.contractIdPreimageFromAddress(
                    new StellarSdk.xdr.ContractIdPreimageFromAddress({
                        address: new StellarSdk.Address(deployerKeypair.publicKey()).toScAddress(),
                        salt: actualSalt,
                    })
                ),
            })
        );
        const contractId = StellarSdk.StrKey.encodeContract(StellarSdk.hash(preimage.toXDR()));

        return { contractId, txHash };
    }

    /**
     * Invokes the initialize() method on the deployed contract with group parameters.
     *
     * Must pass all 8 of the contract's initialize() parameters in order — an
     * earlier version of this method only passed the first 4, which Soroban
     * rejects outright (argument count/type must match the function's spec
     * exactly), so no group's contract was ever actually initializable.
     */
    public async initializeContract(
        deployerKeypair: StellarSdk.Keypair,
        contractId: string,
        params: {
            admin: string;
            usdcTokenAddress: string;
            groupName: string;
            contributionAmount: string | number | bigint;
            groupType: 'Rotational' | 'GoalBased';
            targetAmount?: string | number | bigint | null;
            lockUntilTarget: boolean;
            expectedCycleDays?: number | null;
        },
        server?: StellarSdk.rpc.Server
    ): Promise<{ txHash: string }> {
        const srv = server || this.server;
        const account = await srv.getAccount(deployerKeypair.publicKey());

        const amountBigInt = typeof params.contributionAmount === 'bigint'
            ? params.contributionAmount
            : BigInt(Math.floor(Number(params.contributionAmount)));

        const args = [
            new StellarSdk.Address(params.admin).toScVal(),
            new StellarSdk.Address(params.usdcTokenAddress).toScVal(),
            StellarSdk.nativeToScVal(params.groupName),
            StellarSdk.nativeToScVal(amountBigInt, { type: 'i128' }),
            groupTypeToScVal(params.groupType),
            optionToScVal(
                params.targetAmount,
                (v) => StellarSdk.nativeToScVal(typeof v === 'bigint' ? v : BigInt(Math.floor(Number(v))), { type: 'i128' }),
            ),
            StellarSdk.nativeToScVal(params.lockUntilTarget, { type: 'bool' }),
            optionToScVal(params.expectedCycleDays, (v) => StellarSdk.nativeToScVal(v, { type: 'u32' })),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'initialize',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);
        const { hash: txHash } = await this.submitTransaction(tx, deployerKeypair, srv);

        return { txHash };
    }

    /**
     * High-level contract deployment pipeline orchestrator.
     */
    public async deployGroupContract(params: DeployGroupContractParams): Promise<DeploymentResult> {
        const startTime = Date.now();
        observabilityService.logInfo('Starting contract deployment pipeline', { groupId: params.groupId });

        if (!config.DEPLOYER_SECRET_KEY) {
            const err = new Error('DEPLOYER_SECRET_KEY is not configured in environment variables.');
            const latency = Date.now() - startTime;
            observabilityService.logError('Contract deployment failed: Missing secret key', err, { groupId: params.groupId, latency });
            await observabilityService.alertCriticalFailure('Soroban deployment configuration error', err, { groupId: params.groupId, latency });
            throw err;
        }

try {
            const deployerSeed = StellarSdk.StrKey.decodeEd25519SecretSeed(config.DEPLOYER_SECRET_KEY);
            const deployerKeypair = StellarSdk.Keypair.fromRawEd25519Seed(deployerSeed);
            // The on-chain admin must always be this same deployer keypair —
            // it's the identity the backend later signs payout() and
            // remove_member() with (see PayoutService/GroupExitService). An
            // earlier version let the group creator's own wallet become the
            // on-chain admin, which the backend doesn't hold a signing key
            // for in that flow, so every later admin-authorized call would
            // fail its require_auth_for_args check.
            const admin = deployerKeypair.publicKey();
            if (!config.USDC_TOKEN_ADDRESS) {
                throw new Error('USDC_TOKEN_ADDRESS must be configured with a valid Soroban token contract before deploying a savings group.');
            }
            const usdcTokenAddress = config.USDC_TOKEN_ADDRESS;

            try {
                // 1. Load WASM
                const wasmBuffer = this.loadContractWasm(params.wasmPath);

                // 2. Upload WASM
                const { wasmHash } = await this.uploadWasm(deployerKeypair, wasmBuffer);

                // 3. Create Contract Instance
                const { contractId } = await this.createCustomContract(deployerKeypair, wasmHash);

                // 4. Invoke initialize()
                await this.initializeContract(deployerKeypair, contractId, {
                    admin,
                    usdcTokenAddress,
                    groupName: params.name,
                    contributionAmount: params.contributionAmount,
                    groupType: params.groupType ?? 'Rotational',
                    targetAmount: params.targetAmount ?? null,
                    lockUntilTarget: params.lockUntilTarget ?? false,
                    expectedCycleDays: params.expectedCycleDays ?? null,
                });

                const latency = Date.now() - startTime;
                observabilityService.logInfo('Contract deployment completed successfully', {
                    groupId: params.groupId,
                    contractId,
                    latency,
                });

                return { contractId, latency };
            } finally {
                deployerSeed.fill(0);
            }
        } catch (error: any) {
            const latency = Date.now() - startTime;
            observabilityService.logError('Contract deployment failed', error, {
                groupId: params.groupId,
                error: error?.message || String(error),
                latency,
            });
            await observabilityService.alertCriticalFailure('Contract deployment failed', error, {
                groupId: params.groupId,
                error: error?.message || String(error),
                latency,
            });
            throw error;
        }
    }
    /**
     * Invokes the Soroban contract's `contribute(member, amount)` function.
     *
     * The member keypair is required because the Soroban contract enforces
     * `member.require_auth()` — the member must co-sign the transaction.
     *
     * @param memberKeypair  Keypair for the contributing member (signs the tx).
     * @param contractId     Soroban contract address (C... strkey).
     * @param memberPublicKey  Stellar G... public key of the member.
     * @param amountStroops  Contribution amount expressed as stroops (i128).
     * @param server         Optional RPC server override.
     * @returns `{ hash, status }` from `submitTransaction()`.
     */
    public async invokeContribute(
        memberKeypair: StellarSdk.Keypair,
        contractId: string,
        memberPublicKey: string,
        amountStroops: bigint,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const account = await srv.getAccount(memberKeypair.publicKey());

        const args = [
            new StellarSdk.Address(memberPublicKey).toScVal(),
            StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'contribute',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(60)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);

        // Poll up to 15 times × 2 seconds = 30 seconds max (per issue requirement)
        return await this.submitTransaction(tx, memberKeypair, srv, {
            maxPolls: 15,
            pollIntervalMs: 2000,
        });
    }

    /**
     * Invokes the Soroban contract's `remove_member(member)` function, taking
     * an exiting or kicked member out of the contract's on-chain member list.
     *
     * Signed by the group admin/treasury keypair rather than the member —
     * a kicked member cannot be relied on to co-sign their own removal, so
     * the backend acts as the authorizing party for both LEAVE and KICK.
     *
     * @param adminKeypair    Keypair authorized to manage contract membership (signs the tx).
     * @param contractId      Soroban contract address (C... strkey).
     * @param memberPublicKey  Stellar G... public key of the member being removed.
     * @param server          Optional RPC server override.
     * @returns `{ hash, status }` from `submitTransaction()`.
     */
    public async removeMember(
        adminKeypair: StellarSdk.Keypair,
        contractId: string,
        memberPublicKey: string,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const account = await srv.getAccount(adminKeypair.publicKey());

        const args = [
            new StellarSdk.Address(memberPublicKey).toScVal(),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'remove_member',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);

        return await this.submitTransaction(tx, adminKeypair, srv);
    }

    /**
     * Invokes the Soroban contract's `payout(expected_recipient, amount)`
     * function — pays the next member in rotation order. Passing
     * `amountStroops` undefined/null requests the full computed pool
     * (contribution_amount × the cycle's frozen member count); passing a
     * value requests a partial payout, which the contract still bounds above
     * by that same full pool and by its own balance.
     *
     * Signed by the admin keypair (the same identity passed as `admin` to
     * initialize() — see deployGroupContract()), since the contract checks
     * `admin.require_auth_for_args` against both the recipient address and
     * the amount.
     *
     * @param adminKeypair       Keypair matching the contract's on-chain admin.
     * @param contractId         Soroban contract address (C... strkey).
     * @param recipientPublicKey Stellar G... public key of the expected next recipient.
     * @param amountStroops      Optional partial-payout amount, in stroops.
     * @param server             Optional RPC server override.
     * @returns `{ hash, status }` from `submitTransaction()`.
     */
    public async payout(
        adminKeypair: StellarSdk.Keypair,
        contractId: string,
        recipientPublicKey: string,
        amountStroops?: bigint | null,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const account = await srv.getAccount(adminKeypair.publicKey());

        const args = [
            new StellarSdk.Address(recipientPublicKey).toScVal(),
            optionToScVal(amountStroops, (v) => StellarSdk.nativeToScVal(v, { type: 'i128' })),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'payout',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);

        return await this.submitTransaction(tx, adminKeypair, srv);
    }

    /**
     * Invokes the Soroban contract's `withdraw_savings(member, amount)`
     * function — GoalBased groups only; the contract panics for Rotational
     * groups. Signed by the member themselves (member.require_auth()), since
     * this is the member reclaiming their own recorded contributions.
     *
     * @param memberKeypair    Keypair of the withdrawing member (signs the tx).
     * @param contractId       Soroban contract address (C... strkey).
     * @param memberPublicKey  Stellar G... public key of the withdrawing member.
     * @param amountStroops    Withdrawal amount in the token's smallest unit.
     * @param server           Optional RPC server override.
     * @returns `{ hash, status }` from `submitTransaction()`.
     */
    public async withdrawSavings(
        memberKeypair: StellarSdk.Keypair,
        contractId: string,
        memberPublicKey: string,
        amountStroops: bigint,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const account = await srv.getAccount(memberKeypair.publicKey());

        const args = [
            new StellarSdk.Address(memberPublicKey).toScVal(),
            StellarSdk.nativeToScVal(amountStroops, { type: 'i128' }),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'withdraw_savings',
            args,
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);

        return await this.submitTransaction(tx, memberKeypair, srv);
    }

    /** Shared builder for the contract's no-argument, admin-only functions. */
    private async invokeAdminNoArgFunction(
        adminKeypair: StellarSdk.Keypair,
        contractId: string,
        functionName: string,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        const srv = server || this.server;
        const account = await srv.getAccount(adminKeypair.publicKey());

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: functionName,
            args: [],
        });

        let tx = new StellarSdk.TransactionBuilder(account, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        tx = await this.simulateAndAssembleTransaction(tx, srv);

        return await this.submitTransaction(tx, adminKeypair, srv);
    }

    /**
     * Invokes the contract's `reset_cycle()` — advances CurrentCycleId so
     * members can contribute again. Per the contract's own doc comment, this
     * must run after *every* payout() within a rotation, not just the last
     * one: each contract "cycle" is one contribution round feeding one
     * payout, which is a finer grain than the backend's own "cycle" (a full
     * rotation through every member — see PayoutService.completeCycle).
     */
    public async resetCycle(
        adminKeypair: StellarSdk.Keypair,
        contractId: string,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        return this.invokeAdminNoArgFunction(adminKeypair, contractId, 'reset_cycle', server);
    }

    /**
     * Invokes the contract's `reset_rotation()` — zeroes NextPayoutIndex so
     * the rotation starts over from the first member. Call only once a full
     * rotation has completed (every member has received a payout), not
     * after each individual payout.
     */
    public async resetRotation(
        adminKeypair: StellarSdk.Keypair,
        contractId: string,
        server?: StellarSdk.rpc.Server
    ): Promise<{ hash: string; status: 'SUCCESS' | 'PENDING' }> {
        return this.invokeAdminNoArgFunction(adminKeypair, contractId, 'reset_rotation', server);
    }

    /**
     * Queries the Soroban contract's `get_contribution(member)` read-only view.
     *
     * Uses a simulation (no on-chain submission) so it is free and instant.
     *
     * @param contractId      Soroban contract address (C... strkey).
     * @param memberPublicKey  Stellar G... public key of the member.
     * @param server          Optional RPC server override.
     * @returns The member's total contribution this cycle expressed as a bigint
     *   of stroops. Returns `0n` when the member has no contribution record.
     */
    public async queryContribution(
        contractId: string,
        memberPublicKey: string,
        server?: StellarSdk.rpc.Server
    ): Promise<bigint> {
        const srv = server || this.server;

        // Build a throwaway account for the simulation — no real account needed
        // because this is a read-only simulation, not a submission.
        const dummyAccount = new StellarSdk.Account(memberPublicKey, '0');

        const args = [
            new StellarSdk.Address(memberPublicKey).toScVal(),
        ];

        const invokeOp = StellarSdk.Operation.invokeContractFunction({
            contract: contractId,
            function: 'get_contribution',
            args,
        });

        const tx = new StellarSdk.TransactionBuilder(dummyAccount, {
            fee: '1000',
            networkPassphrase: this.getNetworkPassphrase(),
        })
            .addOperation(invokeOp)
            .setTimeout(30)
            .build();

        const simRes = await srv.simulateTransaction(tx);

        if (StellarSdk.rpc.Api.isSimulationError(simRes)) {
            // Contract returns an error when the member has never contributed
            // (e.g., "NotFound" or similar). Treat as zero.
            return 0n;
        }

        const results = (simRes as any).results as Array<{ xdr: string }> | undefined;
        if (!results || results.length === 0) {
            return 0n;
        }

        try {
            const scVal = StellarSdk.xdr.ScVal.fromXDR(results[0].xdr, 'base64');
            // i128 ScVal: scvI128 contains lo (u64) and hi (i64)
            if (scVal.switch().name === 'scvI128') {
                const i128 = scVal.i128();
                const hi = BigInt(i128.hi().toString());
                const lo = BigInt(i128.lo().toString());
                // Reconstruct: hi * 2^64 + lo (treating lo as unsigned)
                return (hi << 64n) + lo;
            }
            // Fallback: try scValToNative for simpler numeric types
            const native = StellarSdk.scValToNative(scVal);
            return BigInt(native);
        } catch {
            return 0n;
        }
    }
}

export const sorobanService = new SorobanService();
