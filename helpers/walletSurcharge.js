import pool from "../db.js";
import { getConfigNumber } from "./runtimeConfig.js";

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

export function getWalletSurchargeConfig() {
    const percent = Math.min(100, Math.max(0, getConfigNumber("wallet_surcharge_percent", 0)));
    const flat = Math.max(0, roundMoney(getConfigNumber("wallet_surcharge_flat", 0)));
    return { percent, flat };
}

/**
 * Wallet credit is what the user asked to add.
 * Surcharge is percent of that credit, plus a flat rupee fee.
 * Payable is what Razorpay charges. The wallet is credited only `credit`.
 */
export function calculateWalletSurcharge(creditAmount, config = getWalletSurchargeConfig()) {
    const credit = roundMoney(creditAmount);
    const percent = Math.min(100, Math.max(0, Number(config.percent) || 0));
    const flat = Math.max(0, roundMoney(config.flat || 0));
    const percentFee = credit > 0 ? roundMoney((credit * percent) / 100) : 0;
    const surcharge = credit > 0 ? roundMoney(percentFee + flat) : 0;
    const payable = roundMoney(credit + surcharge);
    return { credit, percent, flat, percent_fee: percentFee, surcharge, payable };
}

let columnsReady = null;

export function ensurePaymentOrderFeeColumns() {
    if (!columnsReady) {
        columnsReady = addPaymentOrderFeeColumns().catch((error) => {
            columnsReady = null;
            throw error;
        });
    }
    return columnsReady;
}

async function addPaymentOrderFeeColumns() {
    const [rows] = await pool.query(
        `SELECT COLUMN_NAME AS name
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'payment_orders'
           AND COLUMN_NAME IN ('surcharge', 'payable')`
    );
    const have = new Set(rows.map((row) => row.name));
    if (!have.has("surcharge")) {
        await pool.query("ALTER TABLE payment_orders ADD COLUMN surcharge DECIMAL(12,2) NOT NULL DEFAULT 0");
    }
    if (!have.has("payable")) {
        await pool.query("ALTER TABLE payment_orders ADD COLUMN payable DECIMAL(12,2) NULL");
    }
}
