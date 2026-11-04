const STROOPS_PER_XLM = 10_000_000n;

/**
 * Converts a decimal XLM amount string to stroops (1 XLM = 10,000,000 stroops)
 * using only string/integer arithmetic — never floating-point.
 *
 * `Math.round(parseFloat(amountStr) * 10_000_000)` loses precision for
 * amounts that don't round-trip exactly through IEEE-754 doubles, which can
 * silently shift a financial amount by stroops before it reaches a Soroban
 * contract invocation. This operates on the decimal string directly instead.
 *
 * Throws for a non-numeric format, a negative or zero amount, or an amount
 * with more than 7 fractional digits (Stellar's smallest unit).
 */
export function xlmToStroops(amountStr: string): bigint {
    if (!/^\d+(\.\d+)?$/.test(amountStr)) {
        throw new Error(`Invalid XLM amount format: "${amountStr}"`);
    }

    const [integerPart, fractionalPart = ''] = amountStr.split('.');
    if (fractionalPart.length > 7) {
        throw new Error(`XLM amount exceeds 7 decimal places of precision: "${amountStr}"`);
    }

    const paddedFraction = fractionalPart.padEnd(7, '0');
    const stroops = BigInt(integerPart) * STROOPS_PER_XLM + (paddedFraction === '' ? 0n : BigInt(paddedFraction));

    if (stroops <= 0n) {
        throw new Error(`XLM amount must be greater than zero: "${amountStr}"`);
    }

    return stroops;
}
