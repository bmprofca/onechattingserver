import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { AISENSY_PROJECT_DATA, GET_BALANCE_BY_USERNAME, RANDOM_STRING, TIMESTAMP, TODAY_DATE, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";


const router = express.Router();

/** Returns end_date (YYYY-MM-DD) from start_date + 30 or 365 days based on package_id; null if invalid package. */
function getEndDateFromStart(startDateStr, packageId) {
    const days = packageId === 'PROJECT_1M' ? 30 : packageId === 'PROJECT_1Y' ? 365 : null;
    if (days == null) return null;
    const d = new Date(startDateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

router.post("/", auth, async (req, res) => {
    const username = req.headers["username"] ? req.headers["username"] : "";

    const [package_row] = await pool.query("SELECT * FROM package");

    const monthly = package_row.find(item => item.name === "Monthly");
    const yearly = package_row.find(item => item.name === "Yearly");

    const [custom_row] = await pool.query(
        "SELECT monthly, yearly FROM custom_package WHERE username = ? LIMIT 1",
        [username]
    );
    const custom = custom_row && custom_row.length > 0 ? custom_row[0] : null;


    const [self_project_row] = await pool.query("SELECT * FROM project_mapping WHERE username = ? AND type = 'admin'", [username]);

    const package_record = [];

    for (let index = 0; index < self_project_row.length; index++) {
        const element = self_project_row[index];

        const project_id = element.project_id;

        const project_data = await AISENSY_PROJECT_DATA(project_id);

        const [user_package] = await pool.query("SELECT * FROM user_package WHERE username = ? AND project_id = ? AND type = 'project' ORDER BY id DESC LIMIT 1", [username, project_id]);

        const object = {
            project_id,
            project_name: project_data?.project_name,
            has_package_record: false
        };


        if (user_package.length > 0) {
            const end_date = user_package[0].end_date;
            object.has_package_record = true;
            object.end_date = end_date;
        }

        package_record.push(object);


    }


    return res.status(200).json({
        error: false,
        data: {
            package: {
                monthly: {
                    amount: custom ? custom.monthly : monthly.amount,
                    package_id: monthly.package_id,
                },
                yearly: {
                    amount: custom ? custom.yearly : yearly.amount,
                    package_id: yearly.package_id,
                }
            },
            package_record
        }
    });
});


router.post("/purchase", auth, async (req, res) => {
    const data = req.body?.data ?? '';
    const key = req.body?.key ?? '';
    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }


    const username = req.headers["username"] ?? '';
    const projects = decrypt?.projects ?? [];
    if (projects.length === 0) {
        return res.status(200).json({ error: 'Please select atleast one project' });
    }

    const [package_row] = await pool.query("SELECT * FROM package");
    let monthly_price = Number(package_row.find(item => item.name === "Monthly")?.amount ?? 0);
    let yearly_price = Number(package_row.find(item => item.name === "Yearly")?.amount ?? 0);

    const [custom_row] = await pool.query(
        "SELECT monthly, yearly FROM custom_package WHERE username = ? LIMIT 1",
        [username]
    );
    if (custom_row && custom_row.length > 0) {
        monthly_price = Number(custom_row[0].monthly ?? monthly_price);
        yearly_price = Number(custom_row[0].yearly ?? yearly_price);
    }

    const priceByPackage = { PROJECT_1M: monthly_price, PROJECT_1Y: yearly_price };
    const total_amount = projects.reduce((sum, p) => sum + (priceByPackage[p?.package_id] ?? 0), 0);

    const user_balance = await GET_BALANCE_BY_USERNAME(username);
    if (user_balance < total_amount) {
        return res.status(402).json({ error: 'Insufficient balance' });
    }

    const today = TODAY_DATE();

    for (const element of projects) {
        const project_id = element?.project_id ?? '';
        const package_id = element?.package_id ?? '';

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project', project_id });
        }

        const [old_package_row] = await pool.query(
            "SELECT * FROM user_package WHERE username = ? AND project_id = ? AND type = 'project' ORDER BY id DESC LIMIT 1",
            [username, project_id]
        );

        const start_date = (old_package_row.length === 0 || old_package_row[0]?.end_date <= today)
            ? today
            : old_package_row[0].end_date;

        const end_date = getEndDateFromStart(start_date, package_id);
        if (!end_date) continue;

        const subscription_id = RANDOM_STRING(30);
        await pool.query(
            "INSERT INTO user_package (subscription_id, username, project_id, start_date, end_date, type, package_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [subscription_id, username, project_id, start_date, end_date, 'project', package_id]
        );

        const transaction_id = RANDOM_STRING(30);
        await pool.query(
            "INSERT INTO transactions (transaction_id, username, create_date, create_by, type, transaction_type, amount, value_1, value_2, value_3) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [transaction_id, username, TIMESTAMP(), username, '0', 'project renewal', total_amount, 'subscription', 'project', subscription_id]
        );
    }

    return res.status(200).json({ error: false, msg: 'Plan purchased successfully' });
});


export default router;
