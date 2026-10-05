import axios from "axios";
import crypto from "crypto";
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "./function.js";
import { getConfig } from "./runtimeConfig.js";

function razorpayAuth() {
    return {
        username: getConfig("razorpay_key_id"),
        password: getConfig("razorpay_key_secret"),
    };
}

async function completeWalletTopup({ order_id, username, db_amount, payment_ref, utr }) {
    await pool.query("UPDATE `payment_orders` SET `status`=?, `utr`=? WHERE order_id = ?", [
        "1",
        utr,
        order_id,
    ]);

    const transaction_id = RANDOM_STRING(30);
    await pool.query(
        "INSERT INTO `transactions`(`transaction_id`, `username`, `create_date`, `create_by`, `type`, `transaction_type`, `amount`, `value_1`, `value_2`) VALUES (?,?,?,?,?,?,?,?,?)",
        [transaction_id, username, TIMESTAMP(), username, "1", "wallet topup", db_amount, order_id, payment_ref]
    );
}

export async function initiateWalletTopup({
    order_id,
    username,
    amount,
    mobile,
    email,
    name,
}) {
    const amountPaise = Math.round(Number(amount) * 100);

    const { data } = await axios.post(
        "https://api.razorpay.com/v1/orders",
        {
            amount: amountPaise,
            currency: "INR",
            receipt: order_id,
            notes: {
                username,
                name,
                type: "wallet topup",
            },
        },
        { auth: razorpayAuth() }
    );

    if (!data?.id) {
        throw new Error("Failed to create Razorpay order");
    }

    await pool.query("UPDATE `payment_orders` SET `payment_id` = ? WHERE `order_id` = ?", [
        data.id,
        order_id,
    ]);

    return {
        gateway: "razorpay",
        token_id: data.id,
        order_id,
        key_id: getConfig("razorpay_key_id"),
        amount: amountPaise,
        currency: "INR",
        msg: "Razorpay order created successfully",
    };
}

function verifyRazorpayWebhookSignature(req) {
    const webhookSecret = getConfig("razorpay_webhook_secret");
    if (!webhookSecret || webhookSecret === "REPLACE_ME") {
        return true;
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) return false;

    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    const expected = crypto
        .createHmac("sha256", webhookSecret)
        .update(rawBody)
        .digest("hex");

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);

    if (expectedBuf.length !== signatureBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

export async function processWalletTopupWebhook(req) {
    const json = req?.body;

    if (!verifyRazorpayWebhookSignature(req)) {
        return { status: 401, body: { error: "Invalid webhook signature" } };
    }

    if (json?.event !== "payment.captured") {
        return { status: 200, body: { error: "Payment not captured" } };
    }

    const payment = json?.payload?.payment?.entity;
    const razorpay_order_id = payment?.order_id;
    const razorpay_payment_id = payment?.id;

    if (!razorpay_order_id || !razorpay_payment_id) {
        return { status: 200, body: { error: "Payment details not found" } };
    }

    const [check_row] = await pool.query(
        "SELECT * FROM `payment_orders` WHERE payment_id = ? AND status = ? AND type = ?",
        [razorpay_order_id, "0", "wallet topup"]
    );

    if (check_row.length === 0) {
        return { status: 200, body: { error: "Order not found or already processed" } };
    }

    const db_data = check_row[0];
    const order_id = db_data?.order_id;
    const db_amount = db_data?.amount;
    const username = db_data?.username;

    const { data: apiData } = await axios.get(
        `https://api.razorpay.com/v1/payments/${razorpay_payment_id}`,
        { auth: razorpayAuth() }
    );

    if (apiData?.status !== "captured") {
        return { status: 200, body: { error: "Payment not captured" } };
    }

    if (apiData?.order_id !== razorpay_order_id) {
        return { status: 200, body: { error: "Order mismatch" } };
    }

    const expectedPaise = Math.round(Number(db_amount) * 100);
    if (Number(apiData?.amount) !== expectedPaise) {
        return { status: 200, body: { error: "Amount mismatch" } };
    }

    const utr =
        apiData?.acquirer_data?.rrn ??
        apiData?.acquirer_data?.upi_transaction_id ??
        razorpay_payment_id;

    await completeWalletTopup({
        order_id,
        username,
        db_amount,
        payment_ref: razorpay_payment_id,
        utr,
    });

    return { status: 200, body: { error: false } };
}
