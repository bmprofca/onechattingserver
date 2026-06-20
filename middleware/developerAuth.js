import pool from "../db.js";

function getTokenFromHeader(req) {
    return (req.headers["token"] || "").toString().trim();
}

async function developerMessageAuth(req, res, next) {
    const token = getTokenFromHeader(req);

    if (!token) {
        return res.status(401).json({ error: "Missing token" });
    }

    try {
        const mapping = await resolveDeveloperMessageMapping(token);
        if (!mapping) {
            return res.status(401).json({ error: "Invalid token" });
        }

        req.developerMapping = mapping;
        next();
    } catch (err) {
        console.error("developerMessageAuth error:", err);
        return res.status(500).json({ error: "Authentication failed" });
    }
}

async function resolveDeveloperMessageMapping(token) {
    const [rows] = await pool.query(
        `SELECT pm.*, ap.developer_access, ap.status AS project_status
         FROM project_mapping pm
         INNER JOIN aisensy_projects ap ON ap.project_id = pm.project_id
         WHERE pm.developer_token = ?
           AND pm.is_deleted = ?
           AND ap.developer_access = ?
           AND ap.status = ?`,
        [token, "0", "1", "1"]
    );

    if (rows.length === 1) {
        return rows[0];
    }

    return null;
}

async function resolveDeveloperSendMessageMapping(token) {
    const mapping = await resolveDeveloperMessageMapping(token);
    if (mapping) {
        return mapping;
    }

    const [projectRows] = await pool.query(
        `SELECT * FROM aisensy_projects
         WHERE developer_token = ?
           AND developer_access = ?
           AND status = ?`,
        [token, "1", "1"]
    );

    if (projectRows.length !== 1) {
        return null;
    }

    const project = projectRows[0];
    const [adminRows] = await pool.query(
        `SELECT * FROM project_mapping
         WHERE project_id = ?
           AND type = ?
           AND is_deleted = ?
         LIMIT 1`,
        [project.project_id, "admin", "0"]
    );

    if (adminRows.length !== 1) {
        return null;
    }

    return {
        ...adminRows[0],
        developer_access: project.developer_access,
        project_status: project.status,
        developer_token: token,
    };
}

async function developerSendMessageAuth(req, res, next) {
    const token = getTokenFromHeader(req);

    if (!token) {
        return res.status(401).json({ error: "Missing token" });
    }

    try {
        const mapping = await resolveDeveloperSendMessageMapping(token);
        if (!mapping) {
            return res.status(401).json({ error: "Invalid token" });
        }

        req.developerMapping = mapping;
        next();
    } catch (err) {
        console.error("developerSendMessageAuth error:", err);
        return res.status(500).json({ error: "Authentication failed" });
    }
}

async function developerTemplateAuth(req, res, next) {
    const token = getTokenFromHeader(req);

    if (!token) {
        return res.status(401).json({ error: "Missing token" });
    }

    try {
        const [rows] = await pool.query(
            `SELECT * FROM aisensy_projects
             WHERE developer_token = ?
               AND developer_access = ?
               AND status = ?`,
            [token, "1", "1"]
        );

        if (rows.length !== 1) {
            return res.status(401).json({ error: "Invalid token" });
        }

        req.developerProject = rows[0];
        next();
    } catch (err) {
        console.error("developerTemplateAuth error:", err);
        return res.status(500).json({ error: "Authentication failed" });
    }
}

export { developerMessageAuth, developerSendMessageAuth, developerTemplateAuth };
