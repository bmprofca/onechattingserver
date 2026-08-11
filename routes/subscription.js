import express from "express";
import pool from "../db.js";
import { getAdminByToken } from "../helpers/adminDb.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";

const router = express.Router();

/** Restrict every subscription-package endpoint to an authenticated admin. */
async function authAdmin(req, res, next) {
    try {
        let token =
            req.headers["x-auth-token"] ||
            req.headers["x-token"] ||
            req.headers.authorization;

        if (typeof token === "string" && token.startsWith("Bearer ")) {
            token = token.slice(7).trim();
        }

        if (!token) {
            return res.status(401).json({ error: "Admin authentication token is required." });
        }

        const admin = await getAdminByToken(token);
        if (!admin) {
            return res.status(401).json({ error: "Invalid or expired admin token." });
        }

        req.admin = admin;
        next();
    } catch (error) {
        console.error("[subscription] admin authentication failed", error);
        return res.status(500).json({ error: "Failed to authenticate admin." });
    }
}

function validatePackage(body, { partial = false } = {}) {
    const errors = [];
    const value = {};

    if (!partial || body.package_id !== undefined) {
        const packageId = String(body.package_id || "").trim();
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(packageId)) {
            errors.push("package_id must contain only letters, numbers, underscores, or hyphens.");
        } else {
            value.package_id = packageId;
        }
    }

    if (!partial || body.name !== undefined) {
        const name = String(body.name || "").trim();
        if (!name || name.length > 100) {
            errors.push("name is required and must be at most 100 characters.");
        } else {
            value.name = name;
        }
    }

    if (!partial || body.amount !== undefined) {
        const amount = Number(body.amount);
        if (!Number.isFinite(amount) || amount < 0) {
            errors.push("amount must be a non-negative number.");
        } else {
            value.amount = amount;
        }
    }

    if (!partial || body.validity !== undefined) {
        const validity = String(body.validity || "").trim();
        if (!validity || validity.length > 100) {
            errors.push("validity is required and must be at most 100 characters.");
        } else {
            value.validity = validity;
        }
    }

    return { errors, value };
}

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validateUserPackage(body, { partial = false } = {}) {
    const errors = [];
    const value = {};
    const stringFields = ["subscription_id", "username", "package_id", "project_id", "type"];

    for (const field of stringFields) {
        if (!partial || body[field] !== undefined) {
            const fieldValue = String(body[field] || "").trim();
            if (!fieldValue || fieldValue.length > 100) {
                errors.push(`${field} is required and must be at most 100 characters.`);
            } else {
                value[field] = fieldValue;
            }
        }
    }

    if (!partial || body.amount !== undefined) {
        const amount = Number(body.amount ?? 0);
        if (!Number.isFinite(amount) || amount < 0) {
            errors.push("amount must be a non-negative number.");
        } else {
            value.amount = amount;
        }
    }

    for (const field of ["start_date", "end_date"]) {
        if (!partial || body[field] !== undefined) {
            if (!isValidDate(body[field])) {
                errors.push(`${field} must be a valid date in YYYY-MM-DD format.`);
            } else {
                value[field] = body[field];
            }
        }
    }

    if (value.start_date && value.end_date && value.end_date < value.start_date) {
        errors.push("end_date must be on or after start_date.");
    }

    return { errors, value };
}

async function validateUserPackageReferences(value) {
    if (value.username !== undefined) {
        const [users] = await pool.query("SELECT username FROM users WHERE username = ? LIMIT 1", [value.username]);
        if (!users.length) return "User not found.";
    }

    if (value.package_id !== undefined) {
        const [packages] = await pool.query("SELECT package_id FROM package WHERE package_id = ? LIMIT 1", [value.package_id]);
        if (!packages.length) return "Package not found.";
    }

    if (value.project_id !== undefined) {
        const [projects] = await pool.query("SELECT project_id FROM aisensy_projects WHERE project_id = ? LIMIT 1", [value.project_id]);
        if (!projects.length) return "Project not found.";
    }

    return null;
}

const userPackageColumns = `
    id, subscription_id, username, package_id, project_id, type, amount,
    start_date, end_date, create_date, create_by, modify_date, modify_by`;

function getPagination(query, defaultLimit = 20) {
    const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || defaultLimit, 1), 100);
    return { page, limit, offset: (page - 1) * limit };
}

router.use(authAdmin);

// GET /subscription/packages?search=&package_id=&name=&validity=&min_amount=&max_amount=&page=&limit=
router.get("/packages", async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query);
        const filters = [];
        const values = [];
        const search = String(req.query.search || "").trim();

        if (search) {
            const like = `%${search}%`;
            filters.push("(package_id LIKE ? OR name LIKE ? OR validity LIKE ?)");
            values.push(like, like, like);
        }
        for (const field of ["package_id", "name", "validity"]) {
            if (req.query[field]) {
                filters.push(`${field} = ?`);
                values.push(String(req.query[field]).trim());
            }
        }
        for (const [queryField, operator] of [["min_amount", ">="], ["max_amount", "<="]]) {
            if (req.query[queryField] !== undefined && req.query[queryField] !== "") {
                const amount = Number(req.query[queryField]);
                if (!Number.isFinite(amount)) return res.status(400).json({ error: `${queryField} must be a valid number.` });
                filters.push(`amount ${operator} ?`);
                values.push(amount);
            }
        }
        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const [[count], [packages]] = await Promise.all([
            pool.query(`SELECT COUNT(*) AS total FROM package ${where}`, values),
            pool.query(
                `SELECT id, package_id, name, amount, validity FROM package ${where} ORDER BY id ASC LIMIT ? OFFSET ?`,
                [...values, limit, offset]
            )
        ]);
        const total = Number(count?.total || 0);
        return res.status(200).json({
            error: false,
            data: packages,
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) || 1 }
        });
    } catch (error) {
        console.error("[subscription] list packages failed", error);
        return res.status(500).json({ error: "Failed to fetch packages." });
    }
});

// GET /subscription/packages/:packageId
router.get("/packages/:packageId", async (req, res) => {
    try {
        const [packages] = await pool.query(
            "SELECT id, package_id, name, amount, validity FROM package WHERE package_id = ? LIMIT 1",
            [req.params.packageId]
        );
        if (!packages.length) return res.status(404).json({ error: "Package not found." });
        return res.status(200).json({ error: false, data: packages[0] });
    } catch (error) {
        console.error("[subscription] get package failed", error);
        return res.status(500).json({ error: "Failed to fetch package." });
    }
});

// POST /subscription/packages
router.post("/packages", async (req, res) => {
    const { errors, value } = validatePackage(req.body || {});
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    try {
        const [existing] = await pool.query("SELECT id FROM package WHERE package_id = ? LIMIT 1", [value.package_id]);
        if (existing.length) return res.status(409).json({ error: "A package with this package_id already exists." });

        const [result] = await pool.query(
            "INSERT INTO package (package_id, name, amount, validity) VALUES (?, ?, ?, ?)",
            [value.package_id, value.name, value.amount, value.validity]
        );
        return res.status(201).json({
            error: false,
            message: "Package created successfully.",
            data: { id: result.insertId, ...value }
        });
    } catch (error) {
        console.error("[subscription] create package failed", error);
        return res.status(500).json({ error: "Failed to create package." });
    }
});

// PATCH /subscription/packages/:packageId
router.patch("/packages/:packageId", async (req, res) => {
    if (req.body?.package_id !== undefined && req.body.package_id !== req.params.packageId) {
        return res.status(400).json({ error: "package_id cannot be changed after a package is created." });
    }

    const { errors, value } = validatePackage(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    delete value.package_id;
    if (!Object.keys(value).length) return res.status(400).json({ error: "Provide at least one package field to update." });

    try {
        const [current] = await pool.query("SELECT id FROM package WHERE package_id = ? LIMIT 1", [req.params.packageId]);
        if (!current.length) return res.status(404).json({ error: "Package not found." });

        const fields = Object.keys(value);
        const sql = `UPDATE package SET ${fields.map((field) => `${field} = ?`).join(", ")} WHERE package_id = ?`;
        await pool.query(sql, [...fields.map((field) => value[field]), req.params.packageId]);

        const [packages] = await pool.query(
            "SELECT id, package_id, name, amount, validity FROM package WHERE package_id = ? LIMIT 1",
            [req.params.packageId]
        );
        return res.status(200).json({ error: false, message: "Package updated successfully.", data: packages[0] });
    } catch (error) {
        console.error("[subscription] update package failed", error);
        return res.status(500).json({ error: "Failed to update package." });
    }
});

// DELETE /subscription/packages/:packageId
router.delete("/packages/:packageId", async (req, res) => {
    try {
        const [packages] = await pool.query("SELECT id FROM package WHERE package_id = ? LIMIT 1", [req.params.packageId]);
        if (!packages.length) return res.status(404).json({ error: "Package not found." });

        // Existing subscriptions must retain their package reference.
        const [usage] = await pool.query("SELECT id FROM user_package WHERE package_id = ? LIMIT 1", [req.params.packageId]);
        if (usage.length) {
            return res.status(409).json({ error: "Package cannot be deleted because it is used by existing subscriptions." });
        }

        await pool.query("DELETE FROM package WHERE package_id = ?", [req.params.packageId]);
        return res.status(200).json({ error: false, message: "Package deleted successfully." });
    } catch (error) {
        console.error("[subscription] delete package failed", error);
        return res.status(500).json({ error: "Failed to delete package." });
    }
});

// GET /subscription/user-packages?search=&username=&project_id=&package_id=&type=&start_date_from=&start_date_to=&end_date_from=&end_date_to=&page=&limit=
router.get("/user-packages", async (req, res) => {
    try {
        const { page, limit, offset } = getPagination(req.query);
        const filters = [];
        const values = [];

        const search = String(req.query.search || "").trim();
        if (search) {
            const like = `%${search}%`;
            filters.push("(subscription_id LIKE ? OR username LIKE ? OR package_id LIKE ? OR project_id LIKE ? OR type LIKE ?)");
            values.push(like, like, like, like, like);
        }

        for (const field of ["username", "project_id", "package_id", "type"]) {
            if (req.query[field]) {
                filters.push(`${field} = ?`);
                values.push(String(req.query[field]).trim());
            }
        }

        for (const [queryField, column, operator] of [
            ["start_date_from", "start_date", ">="],
            ["start_date_to", "start_date", "<="],
            ["end_date_from", "end_date", ">="],
            ["end_date_to", "end_date", "<="],
        ]) {
            if (req.query[queryField]) {
                if (!isValidDate(req.query[queryField])) {
                    return res.status(400).json({ error: `${queryField} must be a valid date in YYYY-MM-DD format.` });
                }
                filters.push(`${column} ${operator} ?`);
                values.push(req.query[queryField]);
            }
        }

        const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
        const [[count]] = await pool.query(`SELECT COUNT(*) AS total FROM user_package ${where}`, values);
        const [subscriptions] = await pool.query(
            `SELECT ${userPackageColumns} FROM user_package ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
            [...values, limit, offset]
        );

        return res.status(200).json({
            error: false,
            data: subscriptions,
            pagination: {
                page,
                limit,
                total: Number(count?.total || 0),
                total_pages: Math.ceil(Number(count?.total || 0) / limit) || 1
            }
        });
    } catch (error) {
        console.error("[subscription] list user packages failed", error);
        return res.status(500).json({ error: "Failed to fetch user packages." });
    }
});

// GET /subscription/user-packages/:id
router.get("/user-packages/:id", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid user package id." });

    try {
        const [subscriptions] = await pool.query(
            `SELECT ${userPackageColumns} FROM user_package WHERE id = ? LIMIT 1`,
            [id]
        );
        if (!subscriptions.length) return res.status(404).json({ error: "User package not found." });
        return res.status(200).json({ error: false, data: subscriptions[0] });
    } catch (error) {
        console.error("[subscription] get user package failed", error);
        return res.status(500).json({ error: "Failed to fetch user package." });
    }
});

// POST /subscription/user-packages
router.post("/user-packages", async (req, res) => {
    const input = { ...(req.body || {}) };
    input.subscription_id = input.subscription_id || RANDOM_STRING(30);
    const { errors, value } = validateUserPackage(input);
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });

    try {
        const referenceError = await validateUserPackageReferences(value);
        if (referenceError) return res.status(404).json({ error: referenceError });

        const [existing] = await pool.query(
            "SELECT id FROM user_package WHERE subscription_id = ? LIMIT 1",
            [value.subscription_id]
        );
        if (existing.length) return res.status(409).json({ error: "A user package with this subscription_id already exists." });

        const auditUsername = req.admin.username;
        const [result] = await pool.query(
            `INSERT INTO user_package
                (subscription_id, username, package_id, project_id, type, amount, start_date, end_date, create_date, create_by, modify_date, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                value.subscription_id, value.username, value.package_id, value.project_id,
                value.type, value.amount, value.start_date, value.end_date,
                TIMESTAMP(), auditUsername, TIMESTAMP(), auditUsername
            ]
        );
        const [subscriptions] = await pool.query(`SELECT ${userPackageColumns} FROM user_package WHERE id = ? LIMIT 1`, [result.insertId]);
        return res.status(201).json({ error: false, message: "User package created successfully.", data: subscriptions[0] });
    } catch (error) {
        console.error("[subscription] create user package failed", error);
        return res.status(500).json({ error: "Failed to create user package." });
    }
});

// PATCH /subscription/user-packages/:id
router.patch("/user-packages/:id", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid user package id." });

    const { errors, value } = validateUserPackage(req.body || {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors.join(" ") });
    if (!Object.keys(value).length) return res.status(400).json({ error: "Provide at least one user package field to update." });

    try {
        const [currentRows] = await pool.query(`SELECT ${userPackageColumns} FROM user_package WHERE id = ? LIMIT 1`, [id]);
        if (!currentRows.length) return res.status(404).json({ error: "User package not found." });

        const current = currentRows[0];
        if (value.end_date && new Date(value.start_date || current.start_date) > new Date(value.end_date)) {
            return res.status(400).json({ error: "end_date must be on or after start_date." });
        }
        if (value.start_date && new Date(value.start_date) > new Date(value.end_date || current.end_date)) {
            return res.status(400).json({ error: "end_date must be on or after start_date." });
        }

        const referenceError = await validateUserPackageReferences(value);
        if (referenceError) return res.status(404).json({ error: referenceError });

        const fields = Object.keys(value);
        const sql = `UPDATE user_package SET ${fields.map((field) => `${field} = ?`).join(", ")}, modify_date = ?, modify_by = ? WHERE id = ?`;
        await pool.query(sql, [...fields.map((field) => value[field]), TIMESTAMP(), req.admin.username, id]);

        const [subscriptions] = await pool.query(`SELECT ${userPackageColumns} FROM user_package WHERE id = ? LIMIT 1`, [id]);
        return res.status(200).json({ error: false, message: "User package updated successfully.", data: subscriptions[0] });
    } catch (error) {
        console.error("[subscription] update user package failed", error);
        return res.status(500).json({ error: "Failed to update user package." });
    }
});

// DELETE /subscription/user-packages/:id
router.delete("/user-packages/:id", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid user package id." });

    try {
        const [result] = await pool.query("DELETE FROM user_package WHERE id = ?", [id]);
        if (!result.affectedRows) return res.status(404).json({ error: "User package not found." });
        return res.status(200).json({ error: false, message: "User package deleted successfully." });
    } catch (error) {
        console.error("[subscription] delete user package failed", error);
        return res.status(500).json({ error: "Failed to delete user package." });
    }
});

export default router;
