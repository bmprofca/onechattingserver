import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";

const router = express.Router();

const getProjectIdFromBody = (req) => {
    const project_id = req.body?.project_id;
    return project_id ? String(project_id).trim() : "";
};

const verifyProjectOwner = async (username, project_id) => {
    const [rows] = await pool.query(
        "SELECT id FROM project_mapping WHERE project_id = ? AND username = ? AND type = ? AND is_deleted = ? LIMIT 1",
        [project_id, username, "admin", "0"]
    );

    return rows.length === 1;
};

router.post("/access-info", auth, async (req, res) => {
    try {
        const username = req.headers["username"] ? req.headers["username"] : "";
        const project_id = getProjectIdFromBody(req);

        if (!project_id) {
            return res.status(200).json({ error: "Provide project_id in payload" });
        }

        const isOwner = await verifyProjectOwner(username, project_id);
        if (!isOwner) {
            return res.status(200).json({ error: "Unauthorized Access" });
        }

        const [project_row] = await pool.query(
            "SELECT developer_access, developer_token FROM aisensy_projects WHERE project_id = ? AND status = ?",
            [project_id, "1"]
        );

        if (project_row.length !== 1) {
            return res.status(200).json({ error: "Project not found" });
        }

        const [mapping_rows] = await pool.query(
            `SELECT pm.unique_id, pm.username, pm.type, pm.developer_token, pm.is_deleted,
                    users.name, users.email, users.status
             FROM project_mapping pm
             JOIN users ON users.username = pm.username
             WHERE pm.project_id = ?
               AND pm.is_deleted = ?
               AND users.status = ?
             ORDER BY FIELD(pm.type, 'admin', 'agent'), users.name ASC`,
            [project_id, "0", "1"]
        );

        const users = mapping_rows.map((row) => ({
            unique_id: row.unique_id,
            username: row.username,
            name: row.name,
            email: row.email,
            type: row.type,
            status: row.status === "1",
            is_deleted: row.is_deleted === "1",
            developer_token: row.developer_token || "",
        }));

        return res.status(200).json({
            error: false,
            developer_access: project_row[0].developer_access === "1",
            developer_token: project_row[0].developer_token || "",
            users,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Internal server error",
            e: error?.message || error,
        });
    }
});

router.post("/update-developer-access", auth, async (req, res) => {
    try {
        const username = req.headers["username"] ? req.headers["username"] : "";
        const project_id = getProjectIdFromBody(req);
        const { status } = req.body || {};

        if (!project_id) {
            return res.status(200).json({ error: "Provide project_id in payload" });
        }

        if (typeof status !== "boolean") {
            return res.status(200).json({ error: "Provide valid status (true or false)" });
        }

        const isOwner = await verifyProjectOwner(username, project_id);
        if (!isOwner) {
            return res.status(200).json({ error: "Unauthorized Access" });
        }

        const [project_row] = await pool.query(
            "SELECT * FROM aisensy_projects WHERE project_id = ? AND status = ?",
            [project_id, "1"]
        );

        if (project_row.length !== 1) {
            return res.status(200).json({ error: "Project not found" });
        }

        const developer_access = status ? "1" : "0";

        await pool.query(
            "UPDATE aisensy_projects SET developer_access = ?, modify_date = ?, modify_by = ? WHERE project_id = ?",
            [developer_access, TIMESTAMP(), username, project_id]
        );

        return res.status(200).json({
            error: false,
            msg: "Developer access updated successfully",
            developer_access: status,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Internal server error",
            e: error?.message || error,
        });
    }
});

router.put("/update-developer-access", auth, async (req, res) => {
    try {
        const username = req.headers["username"] ? req.headers["username"] : "";
        const project_id = getProjectIdFromBody(req);

        if (!project_id) {
            return res.status(200).json({ error: "Provide project_id in payload" });
        }

        const isOwner = await verifyProjectOwner(username, project_id);
        if (!isOwner) {
            return res.status(200).json({ error: "Unauthorized Access" });
        }

        const [project_row] = await pool.query(
            "SELECT * FROM aisensy_projects WHERE project_id = ? AND status = ?",
            [project_id, "1"]
        );

        if (project_row.length !== 1) {
            return res.status(200).json({ error: "Project not found" });
        }

        const developer_token = RANDOM_STRING(50);

        await pool.query(
            "UPDATE aisensy_projects SET developer_token = ?, modify_date = ?, modify_by = ? WHERE project_id = ?",
            [developer_token, TIMESTAMP(), username, project_id]
        );

        return res.status(200).json({
            error: false,
            msg: "Developer token updated successfully",
            developer_token,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Internal server error",
            e: error?.message || error,
        });
    }
});

router.put("/update-agent-developer-token", auth, async (req, res) => {
    try {
        const username = req.headers["username"] ? req.headers["username"] : "";
        const project_id = getProjectIdFromBody(req);
        const { unique_id } = req.body || {};

        if (!project_id) {
            return res.status(200).json({ error: "Provide project_id in payload" });
        }

        if (!unique_id) {
            return res.status(200).json({ error: "Provide unique_id in payload" });
        }

        const isOwner = await verifyProjectOwner(username, project_id);
        if (!isOwner) {
            return res.status(200).json({ error: "Unauthorized Access" });
        }

        const [mapping_row] = await pool.query(
            "SELECT * FROM project_mapping WHERE unique_id = ? AND project_id = ? AND is_deleted = ?",
            [unique_id, project_id, "0"]
        );

        if (mapping_row.length !== 1) {
            return res.status(200).json({ error: "User mapping not found" });
        }

        const developer_token = RANDOM_STRING(50);

        await pool.query(
            "UPDATE project_mapping SET developer_token = ?, modify_by = ?, modify_date = ? WHERE unique_id = ? AND project_id = ?",
            [developer_token, username, TIMESTAMP(), unique_id, project_id]
        );

        return res.status(200).json({
            error: false,
            msg: "User developer token updated successfully",
            developer_token,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Internal server error",
            e: error?.message || error,
        });
    }
});

export default router;
