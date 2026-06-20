import pool from "../db.js";
import { GET_BALANCE_BY_USERNAME, GET_PROJECTS_OF_USER } from "./function.js";

// Get admin user by username
export async function getAdminByUsername(username) {
    const [rows] = await pool.query(
        "SELECT id, username, email, password, role, name, country_code, mobile FROM users WHERE username = ? AND role = 'admin' LIMIT 1",
        [username]
    );
    return rows[0] || null;
}

// Get admin user from an active token
export async function getAdminByToken(token) {
    const [rows] = await pool.query(
        `SELECT 
            u.id,
            u.username,
            u.email,
            u.name,
            u.country_code,
            u.mobile,
            u.role
        FROM login_token lt
        JOIN users u ON u.username = lt.username
        WHERE 
            lt.token = ? 
            AND lt.status = '1' 
            AND lt.expire_date > NOW()
            AND u.role = 'admin'
        LIMIT 1`,
        [token]
    );
    return rows[0] || null;
}

// Invalidate a specific token (used on logout)
export async function invalidateToken(token) {
    await pool.query(
        "UPDATE login_token SET status = '0' WHERE token = ?",
        [token]
    );
}

// List users for admin panel (basic info only)
export async function getUsers(limit = 50, offset = 0) {
    const [rows] = await pool.query(
        `SELECT 
            username,
            email,
            password,
            mobile,
            country_code,
            status,
            role,
            kyc_verified,
            name,
            firm_name,
            business_name,
            business_type,
            create_date,
            modify_date
        FROM users
        ORDER BY id DESC
        LIMIT ? OFFSET ?`,
        [Number(limit), Number(offset)]
    );


    for (let index = 0; index < rows.length; index++) {
        const element = rows[index];

        const username = element?.username;
        const balance = await GET_BALANCE_BY_USERNAME(username);
        element.balance = balance;

        const projects = await GET_PROJECTS_OF_USER(username);
        element.projects = projects;

        rows[index] = element;
    }

    return rows;
}

export async function getUsersCount() {
    const [rows] = await pool.query(
        "SELECT COUNT(*) AS total FROM users"
    );
    return rows[0]?.total || 0;
}

export async function getUserById(id) {
    const [rows] = await pool.query(
        "SELECT id, username, email, mobile, status, role, kyc_verified, name, firm_name, business_name, business_type FROM users WHERE id = ? LIMIT 1",
        [id]
    );
    return rows[0] || null;
}

/** User profile and transaction stats only (no projects, transactions list, payments, tokens). */
export async function getUserProfileAndStatsForAdmin(username) {
    const [userRows] = await pool.query(
        'SELECT username, name, email, country_code, mobile, password, status, kyc_verified, firm_name, business_name, business_type, create_date, modify_date FROM users WHERE username = ? LIMIT 1',
        [username]
    );
    const user = userRows[0];
    if (!user) return null;

    const [txSummaryRows] = await pool.query(
        `SELECT 
            SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit,
            SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit
        FROM transactions WHERE username = ?`,
        [username]
    );
    const tx = txSummaryRows[0] || {};
    const total_credit = Number(tx.total_credit || 0);
    const total_debit = Number(tx.total_debit || 0);
    const balance = await GET_BALANCE_BY_USERNAME(username);

    return {
        user,
        stats: { total_credit, total_debit, balance }
    };
}

export async function getUserDetailsForAdmin(username) {
    const [userRows] = await pool.query(
        'SELECT name, email, country_code, mobile, password, status, kyc_verified, firm_name, business_name, business_type FROM users WHERE username = ? LIMIT 1',
        [username]
    );

    const user = userRows[0];
    if (!user) {
        return null;
    }

    const [
        [projectMappings],
        [transactions],
        [txSummaryRows],
        [paymentOrders],
        [loginTokens],
        [businessRows]
    ] = await Promise.all([
        pool.query(
            `SELECT 
                pm.*,
                ap.project_name,
                ap.project_id,
                ap.status AS project_status,
                ap.is_waba_connected
            FROM project_mapping pm
            LEFT JOIN aisensy_projects ap ON ap.project_id = pm.project_id
            WHERE pm.username = ?`,
            [username]
        ),
        pool.query(
            'SELECT * FROM transactions WHERE username = ? ORDER BY id DESC',
            [username]
        ),
        pool.query(
            `SELECT 
                SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit,
                SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit
            FROM transactions
            WHERE username = ?`,
            [username]
        ),
        pool.query(
            'SELECT * FROM payment_orders WHERE username = ? ORDER BY id DESC',
            [username]
        ),
        pool.query(
            'SELECT * FROM login_token WHERE username = ? ORDER BY id DESC',
            [username]
        ),
        pool.query(
            'SELECT * FROM aisensy_businesses WHERE username = ? LIMIT 1',
            [username]
        )
    ]);

    const txSummary = txSummaryRows[0] || {};
    const total_credit = Number(txSummary.total_credit || 0);
    const total_debit = Number(txSummary.total_debit || 0);

    return {
        user,
        business: businessRows[0] || null,
        projects: projectMappings,
        transactions: {
            list: transactions,
            summary: {
                total_credit,
                total_debit,
                balance: total_credit - total_debit
            }
        },
        payments: paymentOrders,
        tokens: loginTokens
    };
}

export async function updateUserStatus(id, status) {
    await pool.query(
        "UPDATE users SET status = ? WHERE id = ?",
        [status, id]
    );
}

// List projects for admin panel
export async function getProjects() {
    const [rows] = await pool.query(
        `SELECT 
            id,
            project_id,
            project_name,
            business_id,
            status,
            is_waba_connected,
            marketing_charge,
            utility_charge,
            authentication_charge
        FROM aisensy_projects
        ORDER BY id DESC`
    );
    return rows;
}

export async function getProjectById(projectId) {
    const [rows] = await pool.query(
        `SELECT 
            id,
            project_id,
            project_name,
            business_id,
            status,
            is_waba_connected,
            marketing_charge,
            utility_charge,
            authentication_charge
        FROM aisensy_projects
        WHERE project_id = ?
        LIMIT 1`,
        [projectId]
    );
    return rows[0] || null;
}

export async function updateProjectCharges(projectId, charges = {}) {
    const fields = [];
    const values = [];

    if (charges.marketing_charge !== undefined) {
        fields.push('marketing_charge = ?');
        values.push(charges.marketing_charge);
    }
    if (charges.utility_charge !== undefined) {
        fields.push('utility_charge = ?');
        values.push(charges.utility_charge);
    }
    if (charges.authentication_charge !== undefined) {
        fields.push('authentication_charge = ?');
        values.push(charges.authentication_charge);
    }

    if (!fields.length) {
        return;
    }

    values.push(projectId);

    const sql = `
        UPDATE aisensy_projects
        SET ${fields.join(', ')}
        WHERE project_id = ?
    `;

    await pool.query(sql, values);
}

// High-level dashboard summary for admin panel
export async function getDashboardSummary() {
    const [
        [usersCount],
        [activeUsersCount],
        [projectsCount],
        [templatesCount],
        [messagesCount],
        [campaignsCount],
        [transactionsSummary]
    ] = await Promise.all([
        pool.query("SELECT COUNT(*) AS total FROM users"),
        pool.query("SELECT COUNT(*) AS total FROM users WHERE status = '1'"),
        pool.query("SELECT COUNT(*) AS total FROM aisensy_projects"),
        pool.query("SELECT COUNT(*) AS total FROM templates"),
        pool.query("SELECT COUNT(*) AS total FROM messages"),
        pool.query("SELECT COUNT(*) AS total FROM campaigns"),
        pool.query(
            `SELECT 
                SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit,
                SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit
            FROM transactions`
        )
    ]);

    const txRow = transactionsSummary[0] || {};
    const total_credit = Number(txRow.total_credit || 0);
    const total_debit = Number(txRow.total_debit || 0);

    return {
        users: {
            total: usersCount[0]?.total || 0,
            active: activeUsersCount[0]?.total || 0
        },
        projects: projectsCount[0]?.total || 0,
        templates: templatesCount[0]?.total || 0,
        messages: messagesCount[0]?.total || 0,
        campaigns: campaignsCount[0]?.total || 0,
        transactions: {
            total_credit,
            total_debit,
            balance: total_credit - total_debit
        }
    };
}

