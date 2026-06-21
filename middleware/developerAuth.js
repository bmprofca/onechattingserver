import pool from "../db.js";

const DEVELOPER_AUTH_CACHE_TTL_MS = Number(process.env.DEVELOPER_AUTH_CACHE_TTL_MS) || 5 * 60 * 1000;
const developerAuthCache = new Map();

function getTokenFromHeader(req) {
    return (req.headers["token"] || "").toString().trim();
}

function getCachedDeveloperAuth(token) {
    const entry = developerAuthCache.get(token);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        developerAuthCache.delete(token);
        return null;
    }
    return entry.value;
}

function setCachedDeveloperAuth(token, value) {
    if (developerAuthCache.size >= 500) {
        const oldestKey = developerAuthCache.keys().next().value;
        if (oldestKey) developerAuthCache.delete(oldestKey);
    }
    developerAuthCache.set(token, {
        value,
        expires: Date.now() + DEVELOPER_AUTH_CACHE_TTL_MS,
    });
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
    const cached = getCachedDeveloperAuth(`message:${token}`);
    if (cached !== undefined) {
        return cached;
    }

    const [rows] = await pool.query(
        `SELECT pm.*, ap.developer_access, ap.status AS project_status
         FROM project_mapping pm
         INNER JOIN aisensy_projects ap ON ap.project_id = pm.project_id
         WHERE pm.developer_token = ?
           AND pm.is_deleted = ?
           AND ap.developer_access = ?
           AND ap.status = ?
         LIMIT 1`,
        [token, "0", "1", "1"]
    );

    const mapping = rows.length === 1 ? rows[0] : null;
    setCachedDeveloperAuth(`message:${token}`, mapping);
    return mapping;
}

async function resolveDeveloperSendMessageMapping(token) {
    const cached = getCachedDeveloperAuth(`send:${token}`);
    if (cached !== undefined) {
        return cached;
    }

    const mappingFromAgent = await resolveDeveloperMessageMapping(token);
    if (mappingFromAgent) {
        setCachedDeveloperAuth(`send:${token}`, mappingFromAgent);
        return mappingFromAgent;
    }

    const [projectRows] = await pool.query(
        `SELECT * FROM aisensy_projects
         WHERE developer_token = ?
           AND developer_access = ?
           AND status = ?
         LIMIT 1`,
        [token, "1", "1"]
    );

    if (projectRows.length !== 1) {
        setCachedDeveloperAuth(`send:${token}`, null);
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
        setCachedDeveloperAuth(`send:${token}`, null);
        return null;
    }

    const mapping = {
        ...adminRows[0],
        developer_access: project.developer_access,
        project_status: project.status,
        developer_token: token,
    };
    setCachedDeveloperAuth(`send:${token}`, mapping);
    return mapping;
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
        const cached = getCachedDeveloperAuth(`template:${token}`);
        if (cached !== undefined) {
            if (!cached) {
                return res.status(401).json({ error: "Invalid token" });
            }
            req.developerProject = cached;
            return next();
        }

        const [rows] = await pool.query(
            `SELECT * FROM aisensy_projects
             WHERE developer_token = ?
               AND developer_access = ?
               AND status = ?
             LIMIT 1`,
            [token, "1", "1"]
        );

        const project = rows.length === 1 ? rows[0] : null;
        setCachedDeveloperAuth(`template:${token}`, project);

        if (!project) {
            return res.status(401).json({ error: "Invalid token" });
        }

        req.developerProject = project;
        next();
    } catch (err) {
        console.error("developerTemplateAuth error:", err);
        return res.status(500).json({ error: "Authentication failed" });
    }
}

export { developerMessageAuth, developerSendMessageAuth, developerTemplateAuth };
