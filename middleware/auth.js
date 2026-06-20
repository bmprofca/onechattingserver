import pool from "../db.js";
import { TODAY_DATE } from "../helpers/function.js";

async function checkToken(username, token) {
    try {
        const [rows] = await pool.query(
            "SELECT login_token.id,users.status AS user_status FROM login_token JOIN users ON users.username = login_token.username WHERE login_token.token = ? AND login_token.username = ? AND login_token.status = '1'",
            [token, username]
        );

        if (rows.length == 1) {
            var user_status = rows[0]?.user_status;
            if (user_status == '1') {
                return true;
            } else {
                return false;
            }
        } else {
            return false;
        }

    } catch (err) {
        console.error("Token check error:", err);
        return false;
    }
}

// Express middleware
async function auth(req, res, next) {
    const token = req.headers["token"] ? req.headers["token"] : '';
    const username = req.headers["username"] ? req.headers["username"] : '';

    if (!token || !username) {
        return res.status(200).json({ error: "Session expired" });
    }

    const isValid = await checkToken(username, token);

    if (!isValid) {
        return res.status(200).json({ error: "Session expired" });
    }

    next();
}

// Express middleware
async function CheckUserProjectMaping(username, project_id) {

    const [row] = await pool.query("SELECT * FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = ?", [username, project_id, '0']);

    if (row.length == 1) {
        return true;
    } else {
        return false;
    }
}

async function CheckProjectValidity(project_id = "") {
    try {
        const [rows] = await pool.query(
            "SELECT id FROM user_package WHERE project_id = ? AND start_date <= ? AND end_date >= ?",
            [project_id, TODAY_DATE(), TODAY_DATE()]
        );

        console.log(pool.format(
            "SELECT id FROM user_package WHERE project_id = ? AND start_date <= ? AND end_date >= ?",
            [project_id, TODAY_DATE(), TODAY_DATE()]
        ))

        if (rows.length > 0) {
            return true;
        } else {
            return false;
        }
    } catch (err) {
        console.error("CheckProjectValidity error:", err);
        return false;
    }
}

export { auth, CheckUserProjectMaping, CheckProjectValidity }
