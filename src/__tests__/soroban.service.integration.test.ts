import axios from 'axios';
import * as StellarSdk from '@stellar/stellar-sdk';
import path from 'path';
import { SorobanService } from '../services/soroban.service';
import { config } from '../config/env';

jest.setTimeout(120000);

describe('SorobanService Integration', () => {
    let sorobanService: SorobanService;
    let deployerKeypair: StellarSdk.Keypair;

    const contractWasmPath = path.resolve(__dirname, '../../contracts/savings_group.wasm');

    beforeAll(() => {
        config.STELLAR_NETWORK = 'TESTNET';
        sorobanService = new SorobanService();
    });

    async function fundTestnetAccount(publicKey: string): Promise<void> {
        const response = await axios.get(`https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`);
        if (response.status !== 200) {
            throw new Error(`Friendbot funding failed with status ${response.status}`);
        }
    }

    it('deploys a Soroban contract on testnet and executes initialize()', async () => {
        deployerKeypair = StellarSdk.Keypair.random();

        await fundTestnetAccount(deployerKeypair.publicKey());
        await new Promise((resolve) => setTimeout(resolve, 5000));

        config.DEPLOYER_SECRET_KEY = deployerKeypair.secret();

        const wasmBuffer = sorobanService.loadContractWasm(contractWasmPath);
        expect(wasmBuffer.length).toBeGreaterThan(0);

        const { wasmHash } = await sorobanService.uploadWasm(deployerKeypair, wasmBuffer);
        expect(wasmHash).toBeInstanceOf(Buffer);
        expect(wasmHash.length).toBeGreaterThan(0);

        const { contractId } = await sorobanService.createCustomContract(deployerKeypair, wasmHash);
        expect(typeof contractId).toBe('string');
        expect(contractId).toMatch(/^C/);

        const initializeResult = await sorobanService.initializeContract(deployerKeypair, contractId, {
            admin: deployerKeypair.publicKey(),
            usdcTokenAddress: config.USDC_TOKEN_ADDRESS,
            groupName: 'Test Group',
            contributionAmount: '100',
            groupType: 'Rotational',
            lockUntilTarget: false,
        });

        expect(initializeResult).toHaveProperty('txHash');
        expect(typeof initializeResult.txHash).toBe('string');

        const txStatus = await sorobanService.server.getTransaction(initializeResult.txHash);
        expect((txStatus as any).status).toBe('SUCCESS');
    });
});
