import axios from "axios";
import pool from "../db.js";
import { fileTypeFromBuffer } from "file-type";
import { TURNSTILE_SECRET_KEY } from "./Config.js";
import fs from "fs";
import path from "path";

const RANDOM_STRING = (length = 10) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let randomPart = '';
    for (let i = 0; i < length; i++) {
        randomPart += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    const timestamp = new Date().getTime();
    let str = randomPart + timestamp;

    // Shuffle the string using Fisher-Yates algorithm
    const arr = str.split('');
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.join('');
}

const IST_TIMEZONE = "Asia/Kolkata";

const toISTDateTimeString = (date = new Date()) =>
    date.toLocaleString("sv-SE", { timeZone: IST_TIMEZONE });

const TIMESTAMP = () => toISTDateTimeString(new Date());

const FUTURE_TIMESTAMP = (minutes = 3) => {
    const future = new Date(Date.now() + minutes * 60 * 1000);
    return toISTDateTimeString(future);
};


const AISENSY_TOKEN_CACHE_TTL_MS = Number(process.env.AISENSY_TOKEN_CACHE_TTL_MS) || 10 * 60 * 1000;
const PROJECT_DATA_CACHE_TTL_MS = Number(process.env.PROJECT_DATA_CACHE_TTL_MS) || 5 * 60 * 1000;
const aisensyTokenCache = new Map();
const projectDataCache = new Map();

function getCacheEntry(cache, key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (entry.expires <= Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry.value;
}

function setCacheEntry(cache, key, value, ttlMs) {
    cache.set(key, { value, expires: Date.now() + ttlMs });
}

const GetAiSensyProjectToken = async (projectid) => {
    const cached = getCacheEntry(aisensyTokenCache, projectid);
    if (cached !== null) {
        return cached;
    }

    const [rows] = await pool.query(
        "SELECT token FROM aisensy_token WHERE project_id = ? LIMIT 1",
        [projectid]
    );

    const token = rows.length === 1 ? rows[0].token : false;
    if (token) {
        setCacheEntry(aisensyTokenCache, projectid, token, AISENSY_TOKEN_CACHE_TTL_MS);
    }
    return token;
};


function GENERATE_PASSWORD(length = 8) {
    const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const lower = "abcdefghijklmnopqrstuvwxyz";
    const numbers = "0123456789";
    const special = "@#%";
    const allChars = upper + lower + numbers + special;

    let password = "";

    // Ensure at least one of each type
    password += upper[Math.floor(Math.random() * upper.length)];
    password += lower[Math.floor(Math.random() * lower.length)];
    password += numbers[Math.floor(Math.random() * numbers.length)];
    password += special[Math.floor(Math.random() * special.length)];

    while (password.length < length) {
        password += allChars[Math.floor(Math.random() * allChars.length)];
    }

    password = password.split("").sort(() => Math.random() - 0.5).join("");

    return password;
}

function IS_STRONG_PASSWORD(password) {
    const regex = /^(?=\S{8,}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).*$/;
    return regex.test(String(password || ""));
}



async function AISENSY_PROJECT_DATA(project_id) {
    const cached = getCacheEntry(projectDataCache, project_id);
    if (cached !== null) {
        return cached;
    }

    const [row] = await pool.query("SELECT * FROM aisensy_projects WHERE project_id = ? LIMIT 1", [project_id]);

    const data = row.length === 1 ? row[0] : false;
    if (data) {
        setCacheEntry(projectDataCache, project_id, data, PROJECT_DATA_CACHE_TTL_MS);
    }
    return data;
}

async function SAVE_MEDIA(projectid, mediaId, folderPath) {
    const AiSensyToken = await GetAiSensyProjectToken(projectid);

    let obj;
    try {
        obj = await axios.post(
            "https://backend.aisensy.com/direct-apis/t1/get-media",
            { id: mediaId },
            {
                headers: {
                    Accept: "application/json",
                    Authorization: "Bearer " + AiSensyToken,
                    "Content-Type": "application/json"
                },
                timeout: 30000,
                maxRedirects: 10
            }
        );
    } catch (error) {
        console.log(`❌ Error on getting media: projectid=${projectid}, mediaId=${mediaId}`, error.message);
        return false;
    }

    // ✅ AiSensy returns a Buffer-like object
    const buffer = Buffer.from(obj.data.data);

    const type = await fileTypeFromBuffer(buffer);
    if (!type) {
        console.log(`❌ Unknown file type: projectid=${projectid}, mediaId=${mediaId}`);
        return false;
    }

    if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
    }

    const filename = `${RANDOM_STRING(15)}.${type.ext}`;
    const filePath = path.join(folderPath, filename);

    await fs.promises.writeFile(filePath, buffer);

    return filename;
}

async function MOVE_MEDIA(fileUrl, folderPath) {

    const allowedExtensions = [
        "jpg",
        "jpeg",
        "png",
        "pdf",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "ppt",
        "pptx",
        "txt",
        "csv",
        "mp4",
        "mp3",
        "aac",
        "amr",
        "wav",
        "ogg",
        "opus",
        "webm"
    ];

    try {
        const urlParts = new URL(fileUrl);
        let ext = path.extname(urlParts.pathname).toLowerCase().replace(".", "");

        if (!ext || !allowedExtensions.includes(ext)) {
            console.error("❌ Invalid or unsupported media URL:", fileUrl);
            return false;
        }

        const fileName = RANDOM_STRING(30) + "." + ext;

        if (!fs.existsSync(folderPath)) {
            fs.mkdirSync(folderPath, { recursive: true });
        }

        const filePath = path.join(folderPath, fileName);

        const response = await axios.get(fileUrl, {
            responseType: "arraybuffer",
        });

        await fs.promises.writeFile(filePath, response.data);

        return fileName;
    } catch (err) {
        console.error("❌ Error in MOVE_MEDIA:", err.message);
        return false;
    }
}

async function USER_DATA(username = '') {
    const [row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);

    if (row.length == 1) {
        return row[0];
    } else {
        return {};
    }
}

async function USER_DATA_MAP(usernames = []) {
    const unique = [...new Set(usernames.filter(Boolean))];
    if (unique.length === 0) {
        return new Map();
    }

    const [rows] = await pool.query(
        "SELECT * FROM users WHERE username IN (?)",
        [unique]
    );

    return new Map(rows.map((row) => [row.username, row]));
}

function auditUserRecord(user = {}, { includeUsername = false } = {}) {
    const record = {
        name: user?.name,
        mobile: user?.mobile,
        email: user?.email,
        status: user?.status === "1",
    };

    if (includeUsername) {
        record.username = user?.username;
    }

    return record;
}

async function GET_BALANCE(project_id = '') {

    const [username_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND type = ?", [project_id, 'admin']);

    if (username_row.length == 0) {
        return false;
    }

    const username = username_row[0]?.username;

    const [rows] = await pool.query(`SELECT SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit, SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit FROM transactions WHERE username = ?`, [username]);

    const total_credit = rows[0].total_credit || 0;
    const total_debit = rows[0].total_debit || 0;

    const balance = Number(total_credit - total_debit);

    return balance;

}

async function GET_BALANCE_BY_USERNAME(username = '') {

    const [rows] = await pool.query(`SELECT SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit, SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit FROM transactions WHERE username = ?`, [username]);

    const total_credit = rows[0].total_credit || 0;
    const total_debit = rows[0].total_debit || 0;

    const balance = Number(total_credit - total_debit);

    return balance;

}

async function GET_ADMIN_OF_PROJECT(project_id = '') {

    const [username_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND type = ?", [project_id, 'admin']);

    if (username_row.length == 0) {
        return false;
    }
    return username_row[0]?.username;

}

async function GET_PROJECTS_OF_USER(username) {


    const [rows] = await pool.query(
        `SELECT ap.project_id, ap.project_name, ap.is_waba_connected, ap.create_date,
            up.end_date AS expire_date
     FROM project_mapping pm
     JOIN aisensy_projects ap ON ap.project_id = pm.project_id
     LEFT JOIN user_package up ON up.username = pm.username AND up.project_id = ap.project_id
         AND up.type = 'project'
         AND up.id = (SELECT MAX(up2.id) FROM user_package up2 WHERE up2.username = pm.username AND up2.project_id = ap.project_id AND up2.type = 'project')
     WHERE pm.username = ? AND pm.type = 'admin'`,
        [username]
    );

    return rows;

}

function GENERATE_EMAIL_ADDRESS() {
    const username = RANDOM_STRING(3);
    return `${username}.whatsapp.business@onesaas.in`;
}


const TODAY_DATE = () =>
    new Date().toLocaleDateString("sv-SE", { timeZone: IST_TIMEZONE });

const GET_PROJECT_BILLING_STATUS = async (project_id = '') => {
    const [row] = await pool.query("SELECT id FROM user_package WHERE project_id = ? AND start_date <= ? AND end_date >= ? LIMIT 1", [project_id, TODAY_DATE(), TODAY_DATE()]);

    return row.length > 0;
};

const GET_ACTIVE_BILLING_PROJECT_IDS = async (today = TODAY_DATE()) => {
    const [rows] = await pool.query(
        "SELECT DISTINCT project_id FROM user_package WHERE start_date <= ? AND end_date >= ?",
        [today, today]
    );

    return new Set(rows.map((row) => row.project_id));
};

/**
 * Validate Cloudflare Turnstile token from client.
 * @param {string} token - Token from client (cf-turnstile-response)
 * @param {string} [remoteip] - Optional visitor IP for additional validation
 * @returns {Promise<boolean>} - true if valid, false otherwise
 */
const validateTurnstileToken = async (token, remoteip = null) => {
    if (!token || typeof token !== "string" || token.trim() === "") {
        return false;
    }
    if (token.length > 2048) {
        return false;
    }
    try {
        const data = { secret: TURNSTILE_SECRET_KEY, response: token };
        if (remoteip) data.remoteip = remoteip;

        const { data: result } = await axios.post(
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            data,
            {
                headers: { "Content-Type": "application/json" },
                timeout: 10000
            }
        );
        return !!result?.success;
    } catch (error) {
        return false;
    }
};

export {
    RANDOM_STRING,
    TIMESTAMP,
    GetAiSensyProjectToken,
    FUTURE_TIMESTAMP,
    GENERATE_PASSWORD,
    IS_STRONG_PASSWORD,
    AISENSY_PROJECT_DATA,
    SAVE_MEDIA,
    MOVE_MEDIA,
    USER_DATA,
    USER_DATA_MAP,
    auditUserRecord,
    GET_BALANCE,
    GET_ADMIN_OF_PROJECT,
    GENERATE_EMAIL_ADDRESS,
    TODAY_DATE,
    GET_BALANCE_BY_USERNAME,
    GET_PROJECTS_OF_USER,
    GET_PROJECT_BILLING_STATUS,
    GET_ACTIVE_BILLING_PROJECT_IDS,
    validateTurnstileToken
};