import express from 'express';
import {
    getAdminByToken,
    invalidateToken,
    getUsers,
    getUsersCount,
    getUserById,
    getUserDetailsForAdmin,
    getUserProfileAndStatsForAdmin,
    updateUserStatus,
    getProjects,
    getProjectsCount,
    getProjectById,
    getDashboardSummary,
    updateProjectCharges
} from '../helpers/adminDb.js';
import { GET_BALANCE_BY_USERNAME, RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP, FUTURE_TIMESTAMP } from '../helpers/function.js';
import subscriptionDb from '../helpers/subscriptionDb.js';
import { Decrypt } from '../helpers/Decrypt.js';
import pool from '../db.js';
import axios from 'axios';
import { sendOtpSms } from "../helpers/sms.js";
import { sendOtpWhatsApp } from "../helpers/whatsapp.js";
import { GetAiSensyProjectToken } from '../helpers/function.js';
import {
    AISENSY_API_KEY,
    AISENSY_PARTNER_ID,
    BASE_DOMAIN
} from '../helpers/Config.js';

const router = express.Router();

const getPagination = (query, defaultLimit = 50) => {
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1), 100);
    return { page, limit, offset: (page - 1) * limit };
};

const getOptionalFilter = (query, field, allowedValues) => {
    if (query[field] === undefined || query[field] === '') return undefined;
    const value = String(query[field]).trim();
    return !allowedValues || allowedValues.includes(value) ? value : null;
};


const authAdmin = async (req, res, next) => {
    try {
        let token =
            req.headers['x-auth-token'] ||
            req.headers['x-token'] ||
            req.headers['authorization'];

        if (!token) {
            return res.status(401).json({ error: 'Auth token required.' });
        }

        if (typeof token === 'string' && token.startsWith('Bearer ')) {
            token = token.slice(7).trim();
        }

        const admin = await getAdminByToken(token);

        if (!admin) {
            return res.status(401).json({ error: 'Invalid or expired token.' });
        }

        req.admin = admin;
        req.token = token;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Server error.' });
    }
};

router.post('/send-otp', async (req, res) => {
    try {
        const { mobile } = req.body;
        if (!mobile) return res.status(400).json({ error: 'Mobile number is required' });

        const [rows] = await pool.query(
            "SELECT id, username, email, role, name, country_code, mobile FROM users WHERE mobile = ? AND role = 'admin' LIMIT 1",
            [mobile]
        );

        console.log(rows);

        if (!rows || rows.length === 0) {
            return res.status(404).json({ error: 'Admin account not found for this mobile number.' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expire_date = FUTURE_TIMESTAMP(10); // 10 minutes expiry
        console.log(otp);

        const conn = await pool.getConnection();
        try {
            await conn.query("INSERT INTO otp_verifications (mobile, otp, expire_date, status) VALUES (?, ?, ?, 'pending')", [mobile, otp, expire_date]);
            await conn.commit();

            try {
                await sendOtpWhatsApp(mobile, otp);
                await sendOtpSms(mobile, otp);
            } catch (error) {
                console.error("Failed to send OTP:", error);
            }

            res.status(200).json({ error: false, message: 'OTP sent successfully' });
        } catch (error) {
            await conn.rollback();
            console.error("OTP send error:", error);
            return res.status(500).json({ error: 'Failed to send OTP' });
        } finally {
            if (conn) conn.release();
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { mobile, otp } = req.body;
        if (!mobile || !otp) return res.status(400).json({ error: 'Mobile number and OTP are required' });

        const [otp_row] = await pool.query("SELECT * FROM otp_verifications WHERE mobile = ? AND otp = ? AND status = 'pending' AND expire_date > NOW() ORDER BY id DESC LIMIT 1", [mobile, otp]);

        if (otp_row.length === 0) {
            return res.status(401).json({ error: 'Invalid or expired OTP' });
        }

        const [rows] = await pool.query(
            "SELECT id, username, email, role, name, country_code, mobile FROM users WHERE mobile = ? AND role = 'admin' LIMIT 1",
            [mobile]
        );

        let user = rows[0] || null;

        if (!user || user.role !== 'admin') {
            return res.status(401).json({ error: 'Admin account not found.' });
        }

        // Mark OTP as verified
        await pool.query("UPDATE otp_verifications SET status = 'verified' WHERE id = ?", [otp_row[0].id]);

        const { RANDOM_STRING, TIMESTAMP, FUTURE_TIMESTAMP } = await import(
            '../helpers/function.js'
        );
        const token = RANDOM_STRING(50);
        await pool.query(
            'INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)',
            [
                user.username,
                TIMESTAMP(),
                user.username,
                TIMESTAMP(),
                user.username,
                token,
                FUTURE_TIMESTAMP(43200),
                '1'
            ]
        );

        res.status(200).json({
            error: false,
            username: user.username,
            token: token,
            profile: {
                name: user.name,
                country_code: user.country_code,
                mobile: user.mobile,
                email: user.email
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Server error.' });
    }
});

router.post('/login', (req, res) => {
    return res.status(410).json({
        error: 'Password login is no longer available. Use /admin/send-otp followed by /admin/verify-otp.'
    });
});


router.use(authAdmin);

router.get('/user/transaction-history/:username', async (req, res) => {
    try {
        // Get username from URL parameter
        const targetUsername = req.params.username || '';

        if (!targetUsername || targetUsername.trim() === '') {
            return res.status(200).json({ error: 'Username is required' });
        }

        // Get query parameters
        const page_no = Number(req.query.page) || 1;
        let limit = Number(req.query.limit) || 20;
        limit = limit > 100 ? 100 : limit;
        const offset = (page_no - 1) * limit;

        // Get filter parameters from query string
        const transaction_type = req.query.transaction_type || '';
        const type = req.query.type || '';

        // Handle project_ids as comma-separated string
        let project_ids = [];
        if (req.query.project_ids) {
            project_ids = req.query.project_ids.split(',');
        }

        // Date formatting: Default to current date if not provided
        const getCurrentDate = () => {
            const now = new Date();
            const year = now.getFullYear();
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const day = String(now.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        };

        const from_date = req.query.from_date || getCurrentDate();
        const to_date = req.query.to_date || getCurrentDate();

        // Build query dynamically
        const queryResult = buildAdminTransactionQuery(targetUsername, from_date, to_date, transaction_type, type, project_ids, limit, offset);

        // Validate query result
        if (!queryResult || !queryResult.query) {
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

        if (sumQueryDebit && sumParamsDebit) {
            const [debit_result] = await pool.query(sumQueryDebit, sumParamsDebit);
            if (debit_result.length > 0 && debit_result[0].total_debit !== null) {
                total_debit = parseFloat(debit_result[0].total_debit).toFixed(2);
            }
        }

        if (sumQueryCredit && sumParamsCredit) {
            const [credit_result] = await pool.query(sumQueryCredit, sumParamsCredit);
            if (credit_result.length > 0 && credit_result[0].total_credit !== null) {
                total_credit = parseFloat(credit_result[0].total_credit).toFixed(2);
            }
        }

        // Execute main query
        const [rows] = await pool.query(query, params);
        const res_data = [];

        const creatorUsernames = rows
            .map((element) => element.create_by)
            .filter((createBy) => createBy && !['SYSTEM'].includes(createBy));
        const userMap = await USER_DATA_MAP(creatorUsernames);

        const walletOrderIds = rows
            .filter((element) => (element.transaction_type || '').toLowerCase().includes('wallet topup') && element.value_1)
            .map((element) => element.value_1);
        const templateWamids = rows
            .filter((element) => (element.transaction_type || '').toLowerCase().includes('template send') && element.value_1)
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
                    remark: element.remark,
                    created_by: element.create_by
                };

                // Add creator info if not SYSTEM
                if (!['SYSTEM'].includes(element.create_by)) {
                    const create_by_data = userMap.get(element.create_by) || {};
                    transaction.create_by_details = {
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
                    if (transactionType.includes('wallet topup')) {
                        const order_data = paymentOrderMap.get(element.value_1);
                        if (order_data) {
                            transaction.payment_details = {
                                payment_id: order_data.payment_id,
                                amount: Number(order_data.amount),
                                name: order_data.name,
                                email: order_data.email,
                                mobile: order_data.mobile,
                                utr: order_data.utr,
                                create_date: order_data.create_date,
                                status: order_data.status
                            };
                        }
                    }

                    // Template send: value_1 contains messages.wamid
                    else if (transactionType.includes('template send')) {
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

        // Return response with admin-friendly structure
        return res.status(200).json({
            error: false,
            data: res_data,
            username: targetUsername,
            summary: {
                total_debit,
                total_credit,
                current_balance: (parseFloat(total_credit) - parseFloat(total_debit)).toFixed(2)
            },
            pagination: {
                page: page_no,
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


const buildAdminTransactionQuery = (username, from_date, to_date, transaction_type, type, project_ids, limit, offset) => {
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

router.get('/profile', (req, res) => {
    const admin = req.admin || {};
    res.status(200).json({
        error: false,
        admin
    });
});



router.post('/logout', async (req, res) => {
    try {
        const token = req.token;
        if (token) {
            await invalidateToken(token);
        }
        res.status(200).json({ error: false, message: 'Logged out successfully.' });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});



router.get('/users', async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query);
        const filters = {
            search: String(req.query.search || '').trim(),
            status: getOptionalFilter(req.query, 'status', ['0', '1']),
            role: getOptionalFilter(req.query, 'role'),
            kyc_verified: getOptionalFilter(req.query, 'kyc_verified', ['0', '1'])
        };
        if (Object.values(filters).includes(null)) {
            return res.status(400).json({ error: 'status and kyc_verified must be 0 or 1.' });
        }

        const [list, total] = await Promise.all([
            getUsers(limit, offset, filters),
            getUsersCount(filters)
        ]);

        res.status(200).json({
            error: false,
            data: list,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        console.log(err);

        res.status(500).json({ error: 'Server error.' });
    }
});



router.get('/users/:username', async (req, res) => {
    try {
        const username = req.params.username;
        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Invalid username.' });
        }

        const data = await getUserProfileAndStatsForAdmin(username);
        if (!data) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.status(200).json({
            error: false,
            data
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

router.get('/users/:username/projects', async (req, res) => {
    try {
        const username = req.params.username;
        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Invalid username.' });
        }

        const [userCheck] = await pool.query('SELECT username FROM users WHERE username = ? LIMIT 1', [username]);
        if (!userCheck || userCheck.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const search = (req.query.search || '').trim();
        const like = search ? `%${search}%` : '%';
        const offset = (page - 1) * limit;

        const countWhere = search
            ? 'pm.username = ? AND (ap.project_id LIKE ? OR ap.project_name LIKE ? OR ap.business_id LIKE ?)'
            : 'pm.username = ?';
        const countParams = search ? [username, like, like, like] : [username];
        const [[countRow]] = await pool.query(
            `SELECT COUNT(*) AS total FROM project_mapping pm
             JOIN aisensy_projects ap ON ap.project_id = pm.project_id
             WHERE ${countWhere}`,
            countParams
        );
        const total = Number(countRow?.total ?? 0);

        const listWhere = search
            ? "pm.username = ? AND pm.type = 'admin' AND (ap.project_id LIKE ? OR ap.project_name LIKE ? OR ap.business_id LIKE ?)"
            : "pm.username = ? AND pm.type = 'admin'";
        const listParams = search ? [username, like, like, like, limit, offset] : [username, limit, offset];
        const [rows] = await pool.query(
            `SELECT ap.project_id, ap.project_name, ap.is_waba_connected, ap.create_date,
                    up.end_date AS expire_date
             FROM project_mapping pm
             JOIN aisensy_projects ap ON ap.project_id = pm.project_id
             LEFT JOIN user_package up ON up.username = pm.username AND up.project_id = ap.project_id
                 AND up.type = 'project'
                 AND up.id = (SELECT MAX(up2.id) FROM user_package up2 WHERE up2.username = pm.username AND up2.project_id = ap.project_id AND up2.type = 'project')
             WHERE ${listWhere}
             ORDER BY pm.id DESC
             LIMIT ? OFFSET ?`,
            listParams
        );

        const data = rows.map((row) => ({
            ...row,
            expire_date: row.expire_date ?? false
        }));

        res.status(200).json({
            error: false,
            data,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.', e: err });
    }
});

router.get('/users/:username/login-tokens', async (req, res) => {
    try {
        const username = req.params.username;
        if (!username || typeof username !== 'string') {
            return res.status(400).json({ error: 'Invalid username.' });
        }

        const [userCheck] = await pool.query('SELECT username FROM users WHERE username = ? LIMIT 1', [username]);
        if (!userCheck || userCheck.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 20;
        const offset = (page - 1) * limit;

        const [[countRow]] = await pool.query(
            'SELECT COUNT(*) AS total FROM login_token WHERE username = ?',
            [username]
        );
        const total = Number(countRow?.total ?? 0);

        const [rows] = await pool.query(
            'SELECT token, create_date, expire_date, status FROM login_token WHERE username = ? ORDER BY id DESC LIMIT ? OFFSET ?',
            [username, limit, offset]
        );

        res.status(200).json({
            error: false,
            data: rows,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

router.patch('/users/:id/status', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const { status } = req.body || {};

        if (!id) {
            return res.status(400).json({ error: 'Invalid user id.' });
        }

        if (status !== '0' && status !== '1') {
            return res
                .status(400)
                .json({ error: "Status must be '0' (inactive) or '1' (active)." });
        }

        const user = await getUserById(id);
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        await updateUserStatus(id, status);

        res.status(200).json({
            error: false,
            message: 'User status updated.'
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});


router.get('/projects', async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query);
        const filters = {
            search: String(req.query.search || '').trim(),
            status: getOptionalFilter(req.query, 'status'),
            is_waba_connected: getOptionalFilter(req.query, 'is_waba_connected', ['0', '1'])
        };
        if (filters.is_waba_connected === null) {
            return res.status(400).json({ error: 'is_waba_connected must be 0 or 1.' });
        }
        const [projects, total] = await Promise.all([
            getProjects(limit, offset, filters),
            getProjectsCount(filters)
        ]);
        res.status(200).json({
            error: false,
            data: projects,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit) || 1
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});


router.patch('/projects/:project_id/prices', async (req, res) => {
    try {
        const projectId = req.params.project_id;
        if (!projectId) {
            return res.status(400).json({ error: 'Project id is required.' });
        }

        const {
            marketing_charge,
            utility_charge,
            authentication_charge
        } = req.body || {};

        if (
            marketing_charge === undefined &&
            utility_charge === undefined &&
            authentication_charge === undefined
        ) {
            return res.status(400).json({
                error: 'Provide at least one price to update.'
            });
        }

        const parseOrUndefined = (val) => {
            if (val === undefined || val === null || val === '') return undefined;
            const num = Number(val);
            if (Number.isNaN(num)) {
                throw new Error('INVALID_NUMBER');
            }
            return num;
        };

        let charges;
        try {
            charges = {
                marketing_charge: parseOrUndefined(marketing_charge),
                utility_charge: parseOrUndefined(utility_charge),
                authentication_charge: parseOrUndefined(authentication_charge)
            };
        } catch (e) {
            if (e.message === 'INVALID_NUMBER') {
                return res.status(400).json({
                    error: 'Prices must be valid numbers.'
                });
            }
            throw e;
        }

        const project = await getProjectById(projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        await updateProjectCharges(projectId, charges);

        const updated = await getProjectById(projectId);

        return res.status(200).json({
            error: false,
            message: 'Project prices updated successfully.',
            data: updated
        });
    } catch (err) {
        return res.status(500).json({ error: 'Server error.' });
    }
});


router.get('/projects/:project_id/meta-details', async (req, res) => {
    try {
        const project_id = req.params.project_id;

        if (!project_id) {
            return res
                .status(200)
                .json({ error: 'Provide all mandetory fields' });
        }

        const project_token = await GetAiSensyProjectToken(project_id);
        if (!project_token) {
            return res
                .status(200)
                .json({ error: 'Failed to get project token' });
        }

        const res_data = {};

        const options2 = {
            method: 'GET',
            url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/project/${project_id}`,
            headers: {
                Accept: 'application/json',
                'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
            }
        };

        try {
            const { data } = await axios.request(options2);

            const {
                name,
                status,
                wa_number,
                wa_messaging_tier,
                wa_display_name_status,
                fb_business_manager_status,
                wa_display_name,
                wa_quality_rating,
                wa_about,
                wa_display_image,
                billing_currency,
                timezone,
                is_whatsapp_verified,
                daily_template_limit,
                wa_business_profile
            } = data || {};

            res_data.is_waba_connected = false;

            res_data.project = {
                error: false,
                name,
                status,
                wa_messaging_tier,
                wa_display_name_status,
                fb_business_manager_status,
                wa_display_name,
                wa_quality_rating,
                billing_currency,
                timezone,
                is_whatsapp_verified,
                daily_template_limit
            };

            if (wa_business_profile) {
                res_data.is_waba_connected = true;
                res_data.profile = {
                    about: wa_about,
                    description: wa_business_profile?.description,
                    profile_picture_url: wa_display_image,
                    email: wa_business_profile?.email,
                    websites: wa_business_profile?.websites,
                    vertical: wa_business_profile?.vertical,
                    address: wa_business_profile?.address,
                    wa_number
                };

                await pool.query(
                    'UPDATE `aisensy_projects` SET `is_waba_connected`=? WHERE project_id = ?',
                    ['1', project_id]
                );

                const options = {
                    method: 'PATCH',
                    url: 'https://backend.aisensy.com/direct-apis/t1/settings/update-webhook',
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        Authorization: `Bearer ${project_token}`
                    },
                    data: {
                        webhooks: {
                            url: `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`
                        }
                    }
                };
                try {
                    await axios.request(options);
                    await pool.query(
                        'UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?',
                        [
                            `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`,
                            project_id
                        ]
                    );
                } catch (error) {
                    console.error(
                        'Webhook subscription error for project id' +
                        project_id
                    );
                    console.error(error?.message || error);
                    await pool.query(
                        'UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?',
                        ['', project_id]
                    );
                }
            } else {
                await pool.query(
                    'UPDATE `aisensy_projects` SET `is_waba_connected`=? WHERE project_id = ?',
                    ['0', project_id]
                );
            }
        } catch (error) {
            console.log(error);
            res_data.project = {
                error: 'Error in fetching project details'
            };
        }

        return res.status(200).json({
            error: false,
            data: res_data
        });
    } catch (err) {
        return res.status(500).json({ error: 'Server error.' });
    }
});


router.get('/projects/:project_id', async (req, res) => {
    try {
        const projectId = req.params.project_id;
        if (!projectId) {
            return res.status(400).json({ error: 'Project id is required.' });
        }

        const project = await getProjectById(projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found.' });
        }

        res.status(200).json({
            error: false,
            data: project
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

router.get('/dashboard/summary', async (req, res) => {
    try {
        const summary = await getDashboardSummary();
        res.status(200).json({
            error: false,
            data: summary
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error.' });
    }
});

router.get('/packages', async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM package");

        const monthly_package = rows.filter(row => row.name === 'Monthly');
        const yearly_package = rows.filter(row => row.name === 'Yearly');

        return res.status(200).json({
            error: false,
            data: {
                monthly_package: monthly_package[0]?.amount,
                yearly_package: yearly_package[0]?.amount
            }
        });
    } catch (error) {
        return res.status(500).json({
            error: 'Server error.',
            e: error
        });
    }
});

router.patch('/update-packages', async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    if (!decrypt.monthly_package || !decrypt.yearly_package) {
        return res.status(400).json({ error: 'Monthly and yearly package are required' });
    }

    try {
        await pool.query("UPDATE package SET amount = ? WHERE package_id = 'PROJECT_1M'", [Number(decrypt.monthly_package)]);
        await pool.query("UPDATE package SET amount = ? WHERE package_id = 'PROJECT_1Y'", [Number(decrypt.yearly_package)]);

        return res.status(200).json({
            error: false,
            message: 'Packages updated successfully'
        });
    } catch (error) {
        return res.status(500).json({
            error: 'Server error.',
            e: error
        });
    }
});

router.post("/custom-packages", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;

        if (!page || !limit) {
            return res.status(400).json({ error: "Page and limit are required" });
        }

        const search = (decrypt.search || "").trim();
        const like = `%${search}%`;
        const offset = (page - 1) * limit;

        // total count
        const [[countRow]] = await pool.query(
            `SELECT COUNT(*) AS total
         FROM custom_package
         JOIN users ON users.username = custom_package.username
         WHERE users.name LIKE ? OR users.email LIKE ? OR users.mobile LIKE ?`,
            [like, like, like]
        );

        const total = Number(countRow.total || 0);

        // paginated data
        const [rows] = await pool.query(
            `SELECT custom_package.*, users.name, users.email, users.mobile, users.country_code, users.status
         FROM custom_package
         JOIN users ON users.username = custom_package.username
         WHERE users.name LIKE ? OR users.email LIKE ? OR users.mobile LIKE ?
         LIMIT ? OFFSET ?`,
            [like, like, like, limit, offset]
        );

        const users_list = rows.map((element) => ({
            custom_id: element.custom_id,
            user: {
                name: element.name,
                email: element.email,
                mobile: element.mobile,
                country_code: element.country_code,
                status: element.status == "1",
            },
            package: {
                monthly: element.monthly,
                yearly: element.yearly,
            },
        }));

        return res.status(200).json({
            error: false,
            data: users_list,
            pagination: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/update-custom-package", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        const custom_id = decrypt.custom_id;
        const monthly = decrypt.monthly;
        const yearly = decrypt.yearly;

        if (!custom_id) {
            return res.status(400).json({ error: "custom_id is required" });
        }

        const [existing] = await pool.query(
            "SELECT custom_id FROM custom_package WHERE custom_id = ? LIMIT 1",
            [custom_id]
        );

        if (!existing || existing.length === 0) {
            return res.status(400).json({ error: "custom_id does not exist" });
        }

        await pool.query(
            "UPDATE custom_package SET monthly = ?, yearly = ? WHERE custom_id = ?",
            [monthly, yearly, custom_id]
        );

        return res.status(200).json({
            error: false,
            message: "Custom package updated successfully",
        });
    } catch (error) {
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/create-custom-package", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        const username = (decrypt.username || "").trim();
        const monthly = decrypt.monthly;
        const yearly = decrypt.yearly;

        if (!username) {
            return res.status(400).json({ error: "username is required" });
        }

        const [existing] = await pool.query(
            "SELECT custom_id FROM custom_package WHERE username = ? LIMIT 1",
            [username]
        );

        if (existing && existing.length > 0) {
            return res.status(400).json({ error: "Username already has a custom package" });
        }

        const custom_id = RANDOM_STRING(30);

        await pool.query(
            "INSERT INTO custom_package (custom_id, username, monthly, yearly) VALUES (?, ?, ?, ?)",
            [custom_id, username, monthly, yearly]
        );

        return res.status(200).json({
            error: false,
            message: "Custom package created successfully",
            custom_id,
        });
    } catch (error) {
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/delete-custom-package", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        const custom_id = decrypt.custom_id;

        if (!custom_id) {
            return res.status(400).json({ error: "custom_id is required" });
        }

        const [existing] = await pool.query(
            "SELECT custom_id FROM custom_package WHERE custom_id = ? LIMIT 1",
            [custom_id]
        );

        if (!existing || existing.length === 0) {
            return res.status(400).json({ error: "custom_id does not exist" });
        }

        await pool.query("DELETE FROM custom_package WHERE custom_id = ?", [custom_id]);

        return res.status(200).json({
            error: false,
            message: "Custom package deleted successfully",
        });
    } catch (error) {
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/user-custom-packages/:username", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        const username = (req.params.username || "").trim();
        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        const [package_row] = await pool.query("SELECT * FROM package");
        const monthly_base = package_row.find((r) => r.name === "Monthly");
        const yearly_base = package_row.find((r) => r.name === "Yearly");
        const base = {
            monthly: Number(monthly_base?.amount ?? 0),
            yearly: Number(yearly_base?.amount ?? 0),
        };

        const [custom_row] = await pool.query(
            "SELECT custom_id, monthly, yearly FROM custom_package WHERE username = ? LIMIT 1",
            [username]
        );
        const has_custom_price = custom_row && custom_row.length > 0;
        const custom = has_custom_price
            ? {
                custom_id: custom_row[0].custom_id,
                monthly: Number(custom_row[0].monthly ?? base.monthly),
                yearly: Number(custom_row[0].yearly ?? base.yearly),
            }
            : null;

        return res.status(200).json({
            error: false,
            data: {
                base,
                has_custom_price,
                custom,
            },
            msg: "User custom packages fetched successfully",
        });
    } catch (error) {
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/credit-wallet/:username", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        // FIXED: Extract username from admin object if needed
        const admin = req?.admin?.username || req?.admin || "SYSTEM";
        const adminString = typeof admin === 'object' ? admin.username || 'SYSTEM' : admin;

        const username = (req.params.username || "").trim();
        const amount = Number(decrypt.amount);
        const remark = decrypt.remark || "";

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Valid amount is required" });
        }

        const [user_row] = await pool.query("SELECT username FROM users WHERE username = ? LIMIT 1", [username]);
        if (!user_row || user_row.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        await pool.query(
            "INSERT INTO transactions (transaction_id, username, amount, type, transaction_type, remark, create_date, create_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [RANDOM_STRING(30), username, amount, "1", "credit", remark, TIMESTAMP(), adminString]
        );

        return res.status(200).json({
            error: false,
            msg: "Wallet credited successfully",
        });
    } catch (error) {
        console.error("Credit wallet error:", error);
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

router.post("/debit-wallet/:username", async (req, res) => {
    try {
        const data = req.body?.data || "";
        const key = req.body?.key || "";

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(400).json({ error: "Failed to decrypt data" });
        }

        // FIXED: Extract username from admin object if needed
        const admin = req?.admin?.username || req?.admin || "SYSTEM";
        const adminString = typeof admin === 'object' ? admin.username || 'SYSTEM' : admin;

        const username = (req.params.username || "").trim();
        const amount = Number(decrypt.amount);
        const remark = decrypt.remark || "";

        if (!username) {
            return res.status(400).json({ error: "Username is required" });
        }

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: "Valid amount is required" });
        }

        const [user_row] = await pool.query("SELECT username FROM users WHERE username = ? LIMIT 1", [username]);
        if (!user_row || user_row.length === 0) {
            return res.status(404).json({ error: "User not found" });
        }

        await pool.query(
            "INSERT INTO transactions (transaction_id, username, amount, type, transaction_type, remark, create_date, create_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [RANDOM_STRING(30), username, amount, "0", "debit", remark, TIMESTAMP(), adminString]
        );

        return res.status(200).json({
            error: false,
            msg: "Wallet debited successfully",
        });
    } catch (error) {
        console.error("Debit wallet error:", error);
        return res.status(500).json({
            error: "Server error.",
            e: error?.message,
        });
    }
});

// ==========================================
// Global AI Providers CRUD APIs
// ==========================================

router.get("/ai-providers", async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query, 20);
        const filters = [];
        const values = [];
        const search = String(req.query.search || '').trim();
        const isActive = getOptionalFilter(req.query, 'is_active', ['0', '1']);
        if (isActive === null) return res.status(400).json({ error: 'is_active must be 0 or 1.' });
        if (search) {
            filters.push('provider LIKE ?');
            values.push(`%${search}%`);
        }
        if (isActive !== undefined) {
            filters.push('is_active = ?');
            values.push(isActive);
        }
        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
        const [[countRow], [rows]] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS total FROM global_ai_api_keys ${where}`, values),
            pool.query(
                `SELECT id, provider, api_key, is_active, create_date, modify_date FROM global_ai_api_keys ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
                [...values, limit, offset]
            )
        ]);
        const total = Number(countRow?.total || 0);
        return res.status(200).json({
            error: false,
            data: rows,
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1 }
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

router.post("/ai-providers", async (req, res) => {
    try {
        const { provider, api_key, is_active } = req.body || {};

        if (!provider || !api_key) {
            return res.status(400).json({ error: "provider and api_key are required" });
        }

        const activeStatus = is_active !== undefined ? is_active : '1';

        await pool.query(
            "INSERT INTO global_ai_api_keys (provider, api_key, is_active) VALUES (?, ?, ?)",
            [provider, api_key, activeStatus]
        );

        return res.status(200).json({ error: false, message: "AI provider added successfully" });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

router.put("/ai-providers/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const { provider, api_key, is_active } = req.body || {};

        if (!provider || !api_key) {
            return res.status(400).json({ error: "provider and api_key are required" });
        }

        const activeStatus = is_active !== undefined ? is_active : '1';

        const [result] = await pool.query(
            "UPDATE global_ai_api_keys SET provider = ?, api_key = ?, is_active = ? WHERE id = ?",
            [provider, api_key, activeStatus, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "AI provider not found" });
        }

        return res.status(200).json({ error: false, message: "AI provider updated successfully" });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

router.delete("/ai-providers/:id", async (req, res) => {
    try {
        const id = req.params.id;
        const [result] = await pool.query("DELETE FROM global_ai_api_keys WHERE id = ?", [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "AI provider not found" });
        }

        return res.status(200).json({ error: false, message: "AI provider deleted successfully" });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

// ==========================================
// AI Model Pricing CRUD APIs
// (ai_model_pricing: PRIMARY KEY (provider, model) — used by the
// token-based billing job to price ai_usage_log rows. See aiBilling.js.)
// ==========================================

const KNOWN_PROVIDERS = ['gemini', 'openai', 'claude', 'groq'];

/**
 * Validates the pricing payload shared by POST and PUT.
 * Returns { valid: true, values } or { valid: false, error }.
 */
const parsePricingPayload = (body, { requireAll }) => {
    const { provider, model, input_price_per_1k, output_price_per_1k } = body || {};

    if (requireAll && (!provider || !model)) {
        return { valid: false, error: 'provider and model are required.' };
    }

    if (provider !== undefined && !KNOWN_PROVIDERS.includes(String(provider).toLowerCase())) {
        return { valid: false, error: `provider must be one of: ${KNOWN_PROVIDERS.join(', ')}.` };
    }

    const parsePrice = (val, label) => {
        if (val === undefined) return undefined;
        const num = Number(val);
        if (Number.isNaN(num) || num < 0) {
            throw new Error(`${label} must be a non-negative number.`);
        }
        return num;
    };

    let inputPrice;
    let outputPrice;
    try {
        inputPrice = parsePrice(input_price_per_1k, 'input_price_per_1k');
        outputPrice = parsePrice(output_price_per_1k, 'output_price_per_1k');
    } catch (e) {
        return { valid: false, error: e.message };
    }

    if (requireAll && (inputPrice === undefined || outputPrice === undefined)) {
        return { valid: false, error: 'input_price_per_1k and output_price_per_1k are required.' };
    }

    return {
        valid: true,
        values: {
            provider: provider !== undefined ? String(provider).toLowerCase() : undefined,
            model: model !== undefined ? String(model).trim() : undefined,
            input_price_per_1k: inputPrice,
            output_price_per_1k: outputPrice,
        },
    };
};

// List pricing rows, optionally filtered by provider and/or a search term
// matched against the model name.
router.get("/ai-model-pricing", async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query, 20);
        const filters = [];
        const values = [];

        const provider = getOptionalFilter(req.query, 'provider', KNOWN_PROVIDERS);
        if (provider === null) {
            return res.status(400).json({ error: `provider must be one of: ${KNOWN_PROVIDERS.join(', ')}.` });
        }
        if (provider !== undefined) {
            filters.push('provider = ?');
            values.push(provider);
        }

        const search = String(req.query.search || '').trim();
        if (search) {
            filters.push('model LIKE ?');
            values.push(`%${search}%`);
        }

        const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

        const [[countRow], [rows]] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS total FROM ai_model_pricing ${where}`, values),
            pool.query(
                `SELECT provider, model, input_price_per_1k, output_price_per_1k
                 FROM ai_model_pricing ${where}
                 ORDER BY provider ASC, model ASC
                 LIMIT ? OFFSET ?`,
                [...values, limit, offset]
            )
        ]);

        const total = Number(countRow?.total || 0);
        return res.status(200).json({
            error: false,
            data: rows,
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1 }
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

// Fetch a single pricing row by its composite key.
router.get("/ai-model-pricing/:provider/:model", async (req, res) => {
    try {
        const { provider, model } = req.params;

        const [rows] = await pool.query(
            "SELECT provider, model, input_price_per_1k, output_price_per_1k FROM ai_model_pricing WHERE provider = ? AND model = ? LIMIT 1",
            [provider, model]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Pricing not found for this provider/model." });
        }

        return res.status(200).json({ error: false, data: rows[0] });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

// Create a new pricing row. provider + model form the primary key, so this
// 409s instead of silently overwriting an existing row — use PUT to update.
router.post("/ai-model-pricing", async (req, res) => {
    try {
        const parsed = parsePricingPayload(req.body, { requireAll: true });
        if (!parsed.valid) {
            return res.status(400).json({ error: parsed.error });
        }
        const { provider, model, input_price_per_1k, output_price_per_1k } = parsed.values;

        const [existing] = await pool.query(
            "SELECT provider FROM ai_model_pricing WHERE provider = ? AND model = ? LIMIT 1",
            [provider, model]
        );
        if (existing.length > 0) {
            return res.status(409).json({ error: "Pricing already exists for this provider/model. Use PUT to update it." });
        }

        await pool.query(
            "INSERT INTO ai_model_pricing (provider, model, input_price_per_1k, output_price_per_1k) VALUES (?, ?, ?, ?)",
            [provider, model, input_price_per_1k, output_price_per_1k]
        );

        return res.status(200).json({
            error: false,
            message: "AI model pricing added successfully",
            data: { provider, model, input_price_per_1k, output_price_per_1k }
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

// Update prices for an existing (provider, model) row. Either price can be
// omitted to leave it unchanged; the row itself (its key) cannot be renamed
// here — delete and recreate if the provider/model needs to change.
router.put("/ai-model-pricing/:provider/:model", async (req, res) => {
    try {
        const { provider, model } = req.params;

        const parsed = parsePricingPayload(req.body, { requireAll: false });
        if (!parsed.valid) {
            return res.status(400).json({ error: parsed.error });
        }
        const { input_price_per_1k, output_price_per_1k } = parsed.values;

        if (input_price_per_1k === undefined && output_price_per_1k === undefined) {
            return res.status(400).json({ error: 'Provide at least one of input_price_per_1k or output_price_per_1k to update.' });
        }

        const [existing] = await pool.query(
            "SELECT provider FROM ai_model_pricing WHERE provider = ? AND model = ? LIMIT 1",
            [provider, model]
        );
        if (existing.length === 0) {
            return res.status(404).json({ error: "Pricing not found for this provider/model." });
        }

        const setClauses = [];
        const setValues = [];
        if (input_price_per_1k !== undefined) {
            setClauses.push('input_price_per_1k = ?');
            setValues.push(input_price_per_1k);
        }
        if (output_price_per_1k !== undefined) {
            setClauses.push('output_price_per_1k = ?');
            setValues.push(output_price_per_1k);
        }

        await pool.query(
            `UPDATE ai_model_pricing SET ${setClauses.join(', ')} WHERE provider = ? AND model = ?`,
            [...setValues, provider, model]
        );

        const [updated] = await pool.query(
            "SELECT provider, model, input_price_per_1k, output_price_per_1k FROM ai_model_pricing WHERE provider = ? AND model = ? LIMIT 1",
            [provider, model]
        );

        return res.status(200).json({
            error: false,
            message: "AI model pricing updated successfully",
            data: updated[0]
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

// Delete a pricing row. Any usage logged against this provider/model after
// deletion will be skipped (and warned about) by the billing job until a
// new pricing row is added — see aiBilling.js.
router.delete("/ai-model-pricing/:provider/:model", async (req, res) => {
    try {
        const { provider, model } = req.params;

        const [result] = await pool.query(
            "DELETE FROM ai_model_pricing WHERE provider = ? AND model = ?",
            [provider, model]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Pricing not found for this provider/model." });
        }

        return res.status(200).json({ error: false, message: "AI model pricing deleted successfully" });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

export default router;