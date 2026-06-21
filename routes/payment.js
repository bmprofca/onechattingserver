import express from "express";
const router = express.Router();
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP, auditUserRecord } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import subscriptionDb from "../helpers/subscriptionDb.js";
import { initiateWalletTopup } from "../helpers/paymentGateway.js";


router.post("/transaction-history", auth, async (req, res) => {
    try {
        // Extract and validate request data
        const { data = '', key = '' } = req.body || {};
        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req.headers["username"] ? req.headers["username"] : '';

        if (!username || username.trim() === '') {
            return res.status(200).json({ error: 'Username is required' });
        }

        const page_no = Number(decrypt.page_no) || 1;
        let limit = Number(decrypt.limit) || 20;

        // Ensure limit doesn't exceed 100
        if (limit > 100) {
            limit = 100;
        }

        const offset = (page_no - 1) * limit;

        // Get filter parameters from payload
        const transaction_type = decrypt.transaction_type || '';
        const type = decrypt.type || '';
        const project_ids = Array.isArray(decrypt.project_ids) ? decrypt.project_ids : [];

        // Date formatting: Get current date in YYYY-MM-DD format if not provided
        const getCurrentDate = () => {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const from_date = decrypt.from_date || getCurrentDate();
        const to_date = decrypt.to_date || getCurrentDate();

        // Build query dynamically
        const queryResult = buildTransactionQuery(username, from_date, to_date, transaction_type, type, project_ids, limit, offset);

        // Validate query result
        if (!queryResult || !queryResult.query || !queryResult.sumQueryDebit || !queryResult.sumQueryCredit) {
            console.error('Query building failed:', queryResult);
            return res.status(200).json({ error: 'Failed to build query' });
        }

        const { query, countQuery, params, countParams, sumQueryDebit, sumQueryCredit, sumParamsDebit, sumParamsCredit } = queryResult;

        // Get total count
        const [total_count_result] = await pool.query(countQuery, countParams);
        const total_records = total_count_result[0]?.total || 0;
        const total_pages = Math.ceil(total_records / limit);

        // Calculate total debit (type="0") and total credit (type="1")
        let total_debit = '0.00';
        let total_credit = '0.00';

        const [debit_result] = await pool.query(sumQueryDebit, sumParamsDebit);
        if (debit_result.length > 0 && debit_result[0].total_debit !== null) {
            total_debit = parseFloat(debit_result[0].total_debit).toFixed(2);
        }

        const [credit_result] = await pool.query(sumQueryCredit, sumParamsCredit);
        if (credit_result.length > 0 && credit_result[0].total_credit !== null) {
            total_credit = parseFloat(credit_result[0].total_credit).toFixed(2);
        }

        // Execute query
        const [rows] = await pool.query(query, params);
        const res_data = [];

        const creatorUsernames = rows
            .map((element) => element.create_by)
            .filter((createBy) => createBy && !['SYSTEM'].includes(createBy));
        const userMap = await USER_DATA_MAP(creatorUsernames);

        const walletOrderIds = rows
            .filter((element) => {
                const transactionType = (element.transaction_type || '').toLowerCase();
                return element.value_1 && (transactionType === 'wallet topup' || transactionType.includes('wallet topup'));
            })
            .map((element) => element.value_1);
        const templateWamids = rows
            .filter((element) => {
                const transactionType = (element.transaction_type || '').toLowerCase();
                return element.value_1 && (transactionType === 'template send' || transactionType.includes('template send'));
            })
            .map((element) => element.value_1);

        let paymentOrderMap = new Map();
        if (walletOrderIds.length > 0) {
            const [orderRows] = await pool.query(
                "SELECT order_id, payment_id, type, amount, name, email, mobile, utr, status, create_date FROM payment_orders WHERE order_id IN (?)",
                [[...new Set(walletOrderIds)]]
            );
            paymentOrderMap = new Map(orderRows.map((order) => [order.order_id, order]));
        }

        let messageMap = new Map();
        if (templateWamids.length > 0) {
            const [messageRows] = await pool.query(
                "SELECT messages.*, templates.template_name, templates.language_code, templates.category FROM messages JOIN templates ON templates.template_id = messages.template_id WHERE wamid IN (?)",
                [[...new Set(templateWamids)]]
            );
            messageMap = new Map(messageRows.map((message) => [message.wamid, message]));
        }

        // Process results
        if (rows.length > 0) {
            for (const element of rows) {
                const transaction = {
                    transaction_id: element.transaction_id,
                    create_date: element.create_date,
                    type: element.type == '1',
                    transaction_type: element.transaction_type,
                    amount: element.amount,
                    remark: element.remark
                };

                // Add creator info if not SYSTEM
                if (!['SYSTEM'].includes(element.create_by)) {
                    const create_by_data = userMap.get(element.create_by) || {};
                    transaction.create_by = {
                        username: create_by_data?.username,
                        mobile: create_by_data?.mobile,
                        email: create_by_data?.email,
                        status: create_by_data?.status == '1',
                    };
                }

                // Add reference details based on transaction_type
                if (element.transaction_type && element.value_1) {
                    const transactionType = element.transaction_type.toLowerCase();

                    // Wallet topup: value_1 contains payment_orders.order_id
                    if (transactionType === 'wallet topup' || transactionType.includes('wallet topup')) {
                        const order_data = paymentOrderMap.get(element.value_1);
                        if (order_data) {
                            transaction.payment_details = {
                                payment_id: order_data.payment_id,
                                amount: Number(order_data.amount),
                                name: order_data.name,
                                email: order_data.email,
                                mobile: order_data.mobile,
                                utr: order_data.utr,
                                create_date: order_data.create_date
                            };
                        }
                    }

                    // Template send: value_1 contains messages.wamid
                    else if (transactionType === 'template send' || transactionType.includes('template send')) {
                        const msg_data = messageMap.get(element.value_1);
                        if (msg_data) {
                            transaction.message_details = {
                                unique_id: msg_data.unique_id,
                                wamid: msg_data.wamid,
                                project_id: msg_data.project_id,
                                message_by: msg_data.message_by,
                                number: msg_data.number,
                                create_date: msg_data.create_date,
                                template_name: msg_data.template_name,
                                language_code: msg_data.language_code,
                                category: msg_data.category,
                            };
                        }
                    }
                }

                res_data.push(transaction);
            }
        }

        // Return response
        return res.status(200).json({
            data: res_data,
            count: res_data.length,
            total_debit,
            total_credit,
            meta: {
                page_no,
                limit,
                total_records,
                total_pages,
                has_more: page_no < total_pages
            }
        });

    } catch (error) {
        console.error('Transaction history error:', error);
        return res.status(200).json({
            error: 'Failed to fetch transaction history'
        });
    }
});

const buildTransactionQuery = (username, from_date, to_date, transaction_type, type, project_ids, limit, offset) => {
    const baseConditions = ['username = ?'];
    const baseParams = [username];

    // Add date range filter on create_date
    // Use DATE() function to compare dates only (ignoring time)
    baseConditions.push('DATE(create_date) >= ?');
    baseParams.push(from_date);
    baseConditions.push('DATE(create_date) <= ?');
    baseParams.push(to_date);

    // Add transaction_type filter if provided (using LIKE clause)
    if (transaction_type && transaction_type.trim() !== '') {
        baseConditions.push('transaction_type LIKE ?');
        baseParams.push(`%${transaction_type}%`);
    }

    // Add project_ids filter if provided (non-empty array)
    if (Array.isArray(project_ids) && project_ids.length > 0) {
        // Filter out empty/null values and convert to strings
        const validProjectIds = project_ids
            .filter(id => id !== null && id !== undefined && id !== '')
            .map(id => String(id).trim())
            .filter(id => id !== '');

        if (validProjectIds.length > 0) {
            const placeholders = validProjectIds.map(() => '?').join(',');
            baseConditions.push(`project_id IN (${placeholders})`);
            baseParams.push(...validProjectIds);
        }
    }

    // Build base where clause (without type filter, for sum queries)
    const baseWhereClause = baseConditions.join(' AND ');

    // Build conditions with type filter for main query
    const conditions = [...baseConditions];
    const params = [...baseParams];

    // Add type filter if provided (using LIKE clause)
    // type: "0" = debit, "1" = credit
    if (type && type.trim() !== '') {
        conditions.push('type LIKE ?');
        params.push(`%${type}%`);
    }

    // Build the where clause with type filter
    const whereClause = conditions.join(' AND ');

    // Build the main query with LIMIT and OFFSET
    const query = `SELECT * FROM transactions WHERE ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`;
    const queryParams = [...params, limit, offset];

    // Build the count query
    const countQuery = `SELECT COUNT(*) as total FROM transactions WHERE ${whereClause}`;
    const countParams = params;

    // Build sum queries for debit and credit (using base conditions without type filter)
    // Debit sum: type = "0"
    const debitConditions = [...baseConditions, 'type = ?'];
    const debitWhereClause = debitConditions.join(' AND ');
    const sumQueryDebit = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(10,2))), 0) as total_debit FROM transactions WHERE ${debitWhereClause}`;
    const sumParamsDebit = [...baseParams, '0'];

    // Credit sum: type = "1"
    const creditConditions = [...baseConditions, 'type = ?'];
    const creditWhereClause = creditConditions.join(' AND ');
    const sumQueryCredit = `SELECT COALESCE(SUM(CAST(amount AS DECIMAL(10,2))), 0) as total_credit FROM transactions WHERE ${creditWhereClause}`;
    const sumParamsCredit = [...baseParams, '1'];

    return {
        query,
        countQuery,
        params: queryParams,
        countParams,
        sumQueryDebit,
        sumQueryCredit,
        sumParamsDebit,
        sumParamsCredit
    };
};

router.post("/wallet-topup", auth, async (req, res) => {
    const data = req.body?.data ?? '';
    const key = req.body?.key ?? '';
    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ?? '';
    const amount = decrypt.amount;
    const user_data = await USER_DATA(username);

    const mobile = user_data?.mobile ?? '';
    const email = user_data?.email ?? '';
    const name = user_data?.name ?? '';
    const order_id = RANDOM_STRING(10);

    try {
        await pool.query(
            "INSERT INTO `payment_orders`(`order_id`, `username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `amount`, `type`, `status`, `mobile`, `email`, `name`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [order_id, username, TIMESTAMP(), username, TIMESTAMP(), username, amount, 'wallet topup', '0', mobile, email, name]
        );

        const result = await initiateWalletTopup({
            order_id,
            username,
            amount,
            mobile,
            email,
            name,
        });


        return res.status(200).json({
            error: false,
            ...result,
        });
    } catch (error) {
        console.log("[wallet-topup]", error?.response?.data ?? error.message);
        return res.status(200).json({
            error:
                error?.response?.data?.error?.description ??
                error?.response?.data?.message ??
                error?.response?.data?.error ??
                error?.message ??
                "Failed to generate payment token",
        });
    }
});

router.post("/payment-status", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const order_id = decrypt.order_id;

    const [check_row] = await pool.query("SELECT * FROM payment_orders WHERE order_id = ? AND username = ?", [order_id, username]);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Order not found' })
    }

    const payment_data = check_row[0];

    if (payment_data?.status == '0') {
        var return_status = 'PENDING';
    } else if (payment_data?.status == '1') {
        var return_status = 'SUCCESS';
    } else if (payment_data?.status == '2') {
        var return_status = 'FAILED';
    }

    const create_by_data = await USER_DATA(payment_data?.create_by);

    return res.status(200).json({
        error: false,
        order_id: payment_data?.order_id,
        type: payment_data?.type,
        payment_id: payment_data?.payment_id,
        name: payment_data?.name,
        email: payment_data?.email,
        mobile: payment_data?.mobile,
        create_date: payment_data?.create_date,
        utr: payment_data?.utr,
        status: return_status,
        create_by: {
            name: create_by_data?.name,
            mobile: create_by_data?.mobile,
            email: create_by_data?.email,
            status: create_by_data?.status == '1' ? true : false,
        },
        amount: Number(payment_data?.amount)
    })

});


export default router
