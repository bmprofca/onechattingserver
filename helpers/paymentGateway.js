import axios from "axios";
import crypto from "crypto";
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "./function.js";
import { APP_DOMAIN } from "./Config.js";

export const ACTIVE_GATEWAY = process.env.ACTIVE_GATEWAY || "cashfree"; // razorpay | zwitch | cashfree

const ZWITCH_PAYMENT_API_URL = "https://api.zwitch.io/v1/pg/payment_token";
const ZWITCH_PAYMENT_ACCESS_KEY = process.env.ZWITCH_PAYMENT_ACCESS_KEY;
const ZWITCH_PAYMENT_AUTH_TOKEN = process.env.ZWITCH_PAYMENT_AUTH_TOKEN;

const ZWITCH_WEBHOOK_ACCESS_KEY = process.env.ZWITCH_WEBHOOK_ACCESS_KEY;
const ZWITCH_WEBHOOK_AUTH_TOKEN = process.env.ZWITCH_WEBHOOK_AUTH_TOKEN;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const CASHFREE_ENV = process.env.CASHFREE_ENV || "production"; // sandbox | production
const CASHFREE_API_BASE =
    CASHFREE_ENV === "production" ? "https://api.cashfree.com/pg" : "https://sandbox.cashfree.com/pg";
const CASHFREE_APP_ID =
    CASHFREE_ENV === "production" ? process.env.CASHFREE_APP_ID_PROD : process.env.CASHFREE_APP_ID_TEST;
const CASHFREE_SECRET_KEY =
    CASHFREE_ENV === "production" ? process.env.CASHFREE_SECRET_KEY_PROD : process.env.CASHFREE_SECRET_KEY_TEST;
const CASHFREE_API_VERSION = "2023-08-01";

const razorpayAuth = {
    username: RAZORPAY_KEY_ID,
    password: RAZORPAY_KEY_SECRET,
};

function cashfreeHeaders() {
    return {
        "x-client-id": CASHFREE_APP_ID,
        "x-client-secret": CASHFREE_SECRET_KEY,
        "x-api-version": CASHFREE_API_VERSION,
        "Content-Type": "application/json",
        Accept: "application/json",
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
    if (ACTIVE_GATEWAY === "razorpay") {
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
            { auth: razorpayAuth }
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
            key_id: RAZORPAY_KEY_ID,
            amount: amountPaise,
            currency: "INR",
            msg: "Razorpay order created successfully",
        };
    }

    if (ACTIVE_GATEWAY === "cashfree") {
        const orderAmount = Number(amount);

        const { data } = await axios.post(
            `${CASHFREE_API_BASE}/orders`,
            {
                order_amount: orderAmount,
                order_currency: "INR",
                order_id,
                customer_details: {
                    customer_id: username,
                    customer_name: name || username,
                    customer_email: email || undefined,
                    customer_phone: mobile || "9999999999",
                },
                order_meta: {
                    return_url: `${APP_DOMAIN}/wallet?order_id={order_id}`,
                },
                order_note: "wallet topup",
            },
            { headers: cashfreeHeaders() }
        );

        if (!data?.payment_session_id) {
            throw new Error(data?.message || "Failed to create Cashfree order");
        }

        const gatewayOrderRef = data?.cf_order_id ?? data?.order_id ?? order_id;

        await pool.query("UPDATE `payment_orders` SET `payment_id` = ? WHERE `order_id` = ?", [
            String(gatewayOrderRef),
            order_id,
        ]);

        return {
            gateway: "cashfree",
            token_id: data.payment_session_id,
            payment_session_id: data.payment_session_id,
            order_id,
            cf_order_id: data?.cf_order_id ?? null,
            app_id: CASHFREE_APP_ID,
            environment: CASHFREE_ENV,
            amount: orderAmount,
            currency: "INR",
            msg: "Cashfree order created successfully",
        };
    }

    const payload = {
        amount: Number(amount),
        contact_number: mobile,
        email_id: email,
        currency: "INR",
        mtx: order_id,
        udf: {
            key_1: name,
            key_2: "wallet topup",
        },
    };

    const { data: json } = await axios.post(ZWITCH_PAYMENT_API_URL, payload, {
        headers: {
            "Access-Key": ZWITCH_PAYMENT_ACCESS_KEY,
            Authorization: `Bearer ${ZWITCH_PAYMENT_AUTH_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json",
        },
    });

    if (json?.status !== "created") {
        throw new Error(json?.message ?? "Failed to create payment token");
    }

    await pool.query("UPDATE `payment_orders` SET `payment_id` = ? WHERE `order_id` = ?", [
        json.id,
        order_id,
    ]);

    return {
        gateway: "zwitch",
        token_id: json.id,
        order_id,
        msg: "Payment token created successfully",
    };
}

function verifyRazorpayWebhookSignature(req) {
    if (!RAZORPAY_WEBHOOK_SECRET || RAZORPAY_WEBHOOK_SECRET === "REPLACE_ME") {
        return true;
    }

    const signature = req.headers["x-razorpay-signature"];
    if (!signature) return false;

    const rawBody = req.rawBody ?? JSON.stringify(req.body);
    const expected = crypto
        .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);

    if (expectedBuf.length !== signatureBuf.length) {
        return false;
    }

    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

function verifyCashfreeWebhookSignature(req) {
    const signature = req.headers["x-webhook-signature"];
    const timestamp = req.headers["x-webhook-timestamp"];

    if (!signature || !timestamp) {
        console.log("[cashfree webhook] missing signature headers");
        return false;
    }

    const rawBody = req.rawBody;
    if (!rawBody) {
        console.log("[cashfree webhook] rawBody missing — ensure express.json verify captures it for /webhook/wallet-topup");
        return false;
    }

    const expected = crypto
        .createHmac("sha256", CASHFREE_SECRET_KEY)
        .update(String(timestamp) + rawBody)
        .digest("base64");

    const expectedBuf = Buffer.from(expected);
    const signatureBuf = Buffer.from(signature);

    if (expectedBuf.length !== signatureBuf.length) {
        console.log("[cashfree webhook] signature length mismatch");
        return false;
    }

    return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

async function verifyCashfreeOrderPaid(cashfreeOrderId, expectedAmount) {
    const { data } = await axios.get(`${CASHFREE_API_BASE}/orders/${cashfreeOrderId}`, {
        headers: cashfreeHeaders(),
    });

    if (data?.order_status !== "PAID") {
        return { ok: false, error: "Payment not completed" };
    }

    if (Number(data?.order_amount) !== Number(expectedAmount)) {
        return { ok: false, error: "Amount mismatch" };
    }

    return { ok: true, data };
}

export async function processWalletTopupWebhook(req) {
    if (ACTIVE_GATEWAY === "razorpay") {
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
            { auth: razorpayAuth }
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

    if (ACTIVE_GATEWAY === "cashfree") {
        const json = req?.body;

        if (!verifyCashfreeWebhookSignature(req)) {
            return { status: 401, body: { error: "Invalid webhook signature" } };
        }

        const webhookType = json?.type;
        if (webhookType !== "PAYMENT_SUCCESS_WEBHOOK") {
            return { status: 200, body: { error: "Payment not successful" } };
        }

        const cashfreeOrderId = json?.data?.order?.order_id;
        const payment = json?.data?.payment;

        if (!cashfreeOrderId) {
            return { status: 200, body: { error: "Order ID not found in webhook" } };
        }

        if (payment?.payment_status && payment.payment_status !== "SUCCESS") {
            return { status: 200, body: { error: "Payment not successful" } };
        }

        const [checkByOrderId] = await pool.query(
            "SELECT * FROM `payment_orders` WHERE order_id = ? AND status = ? AND type = ?",
            [cashfreeOrderId, "0", "wallet topup"]
        );

        let db_data = checkByOrderId[0];

        if (!db_data) {
            const [byPaymentId] = await pool.query(
                "SELECT * FROM `payment_orders` WHERE payment_id = ? AND status = ? AND type = ?",
                [String(cashfreeOrderId), "0", "wallet topup"]
            );

            if (byPaymentId.length === 0) {
                return { status: 200, body: { error: "Order not found or already processed" } };
            }

            db_data = byPaymentId[0];
        }

        const order_id = db_data?.order_id;
        const db_amount = db_data?.amount;
        const username = db_data?.username;

        const verification = await verifyCashfreeOrderPaid(cashfreeOrderId, db_amount);
        if (!verification.ok) {
            return { status: 200, body: { error: verification.error } };
        }

        const cfPaymentId = payment?.cf_payment_id ?? json?.data?.payment_gateway_details?.gateway_payment_id;
        const utr = payment?.bank_reference ?? (cfPaymentId ? String(cfPaymentId) : cashfreeOrderId);

        await completeWalletTopup({
            order_id,
            username,
            db_amount,
            payment_ref: cfPaymentId ? String(cfPaymentId) : cashfreeOrderId,
            utr,
        });

        return { status: 200, body: { error: false } };
    }

    const json = req?.body;

    if (json?.status !== "captured") {
        return { status: 200, body: { error: "Payment not captured" } };
    }

    const payment_token = json?.payment_token?.id;
    if (!payment_token) {
        return { status: 200, body: { error: "Payment token not found" } };
    }

    const [check_row] = await pool.query(
        "SELECT * FROM `payment_orders` WHERE payment_id = ? AND status = ? AND type = ?",
        [payment_token, "0", "wallet topup"]
    );

    if (check_row.length === 0) {
        return { status: 200, body: { error: "Order not found or already processed" } };
    }

    const db_data = check_row[0];
    const order_id = db_data?.order_id;
    const db_amount = db_data?.amount;
    const username = db_data?.username;

    const { data: apiData } = await axios.get(
        `https://api.zwitch.io/v1/pg/payment_token/${payment_token}/payment`,
        {
            headers: {
                "Access-Key": ZWITCH_WEBHOOK_ACCESS_KEY,
                Authorization: `Bearer ${ZWITCH_WEBHOOK_AUTH_TOKEN}`,
                Accept: "application/json",
                "Content-Type": "application/json",
            },
        }
    );

    if (apiData?.status !== "captured") {
        return { status: 200, body: { error: "Payment not captured" } };
    }

    const utr = apiData?.utr ?? apiData?.reference_id ?? apiData?.pg_txn_ref_num ?? null;

    await completeWalletTopup({
        order_id,
        username,
        db_amount,
        payment_ref: payment_token,
        utr,
    });

    return { status: 200, body: { error: false } };
}
