import { xlmToStroops } from '../utils/stellar-amount.util';

describe('xlmToStroops', () => {
    it('converts a whole XLM amount', () => {
        expect(xlmToStroops('1')).toBe(10_000_000n);
    });

    it('converts the smallest unit (1 stroop)', () => {
        expect(xlmToStroops('0.0000001')).toBe(1n);
    });

    it('converts a fractional XLM amount exactly', () => {
        expect(xlmToStroops('123.45')).toBe(1_234_500_000n);
    });

    it('converts an amount with trailing zeros exactly', () => {
        expect(xlmToStroops('1.5000000')).toBe(15_000_000n);
    });

    it('converts an amount prone to floating-point drift exactly', () => {
        // 0.1 + 0.2 style inputs lose precision through
        // Math.round(parseFloat(x) * 10_000_000); string arithmetic must not.
        expect(xlmToStroops('0.3')).toBe(3_000_000n);
        expect(xlmToStroops('7.0000003')).toBe(70_000_003n);
    });

    it('converts a large whole-number amount exactly', () => {
        expect(xlmToStroops('999999')).toBe(9_999_990_000_000n);
    });

    it('rejects a zero amount', () => {
        expect(() => xlmToStroops('0')).toThrow(/greater than zero/);
        expect(() => xlmToStroops('0.0000000')).toThrow(/greater than zero/);
    });

    it('rejects a negative amount', () => {
        expect(() => xlmToStroops('-5')).toThrow(/Invalid XLM amount format/);
    });

    it('rejects a non-numeric amount', () => {
        expect(() => xlmToStroops('abc')).toThrow(/Invalid XLM amount format/);
        expect(() => xlmToStroops('1.2.3')).toThrow(/Invalid XLM amount format/);
        expect(() => xlmToStroops('')).toThrow(/Invalid XLM amount format/);
    });

    it('rejects precision beyond 7 decimal places', () => {
        expect(() => xlmToStroops('1.12345678')).toThrow(/exceeds 7 decimal places/);
    });
});
