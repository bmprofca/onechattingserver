import pool from "../db.js";
import { TODAY_DATE } from "../helpers/function.js";

const TOKEN_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS) || 5 * 60 * 1000;
const PROJECT_MAPPING_CACHE_TTL_MS = Number(process.env.PROJECT_MAPPING_CACHE_TTL_MS) || 2 * 60 * 1000;
const PROJECT_VALIDITY_CACHE_TTL_MS = Number(process.env.PROJECT_VALIDITY_CACHE_TTL_MS) || 2 * 60 * 1000;
const TOKEN_CACHE_MAX_SIZE = 500;
const tokenCache = new Map();
const projectMappingCache = new Map();
const projectValidityCache = new Map();

function trimCache(cache, maxSize) {
    if (cache.size < maxSize) return;
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
}

function getCachedValue(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

function setCachedValue(cache, key, value, ttlMs, maxSize = 1000) {
    trimCache(cache, maxSize);
    cache.set(key, { value, expires: Date.now() + ttlMs });
}

async function checkToken(username, token) {
    const cacheKey = `${username}:${token}`;
    const cached = getCachedValue(tokenCache, cacheKey);
    if (cached !== null) {
        return cached;
    }

    try {
        const [rows] = await pool.query(
            "SELECT login_token.id, users.status AS user_status FROM login_token JOIN users ON users.username = login_token.username WHERE login_token.token = ? AND login_token.username = ? AND login_token.status = '1' LIMIT 1",
            [token, username]
        );

        const isValid = rows.length === 1 && rows[0]?.user_status === "1";
        setCachedValue(tokenCache, cacheKey, isValid, TOKEN_CACHE_TTL_MS, TOKEN_CACHE_MAX_SIZE);
        return isValid;
    } catch (err) {
        console.error("Token check error:", err);
        return false;
    }
}

async function auth(req, res, next) {
    const token = req.headers["token"] ? req.headers["token"] : "";
    const username = req.headers["username"] ? req.headers["username"] : "";

    if (!token || !username) {
        return res.status(200).json({ error: "Session expired" });
    }

    const isValid = await checkToken(username, token);

    if (!isValid) {
        return res.status(200).json({ error: "Session expired" });
    }

    next();
}

async function CheckUserProjectMaping(username, project_id) {
    const cacheKey = `${username}:${project_id}`;
    const cached = getCachedValue(projectMappingCache, cacheKey);
    if (cached !== null) {
        return cached;
    }

    const [row] = await pool.query(
        "SELECT id FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = ? LIMIT 1",
        [username, project_id, "0"]
    );

    const isMapped = row.length === 1;
    setCachedValue(projectMappingCache, cacheKey, isMapped, PROJECT_MAPPING_CACHE_TTL_MS);
    return isMapped;
}

async function CheckProjectValidity(project_id = "") {
    const cached = getCachedValue(projectValidityCache, project_id);
    if (cached !== null) {
        return cached;
    }

    try {
        const [rows] = await pool.query(
            "SELECT id FROM user_package WHERE project_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1",
            [project_id, TODAY_DATE(), TODAY_DATE()]
        );

        const isValid = rows.length > 0;
        setCachedValue(projectValidityCache, project_id, isValid, PROJECT_VALIDITY_CACHE_TTL_MS);
        return isValid;
    } catch (err) {
        console.error("CheckProjectValidity error:", err);
        return false;
    }
}

export { auth, CheckUserProjectMaping, CheckProjectValidity };
