import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import pool from "../db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultAccountPath = path.join(__dirname, "..", "config", "firebase-service-account.json");

let ready = false;
let initAttempted = false;

function initFirebase() {
    if (initAttempted) return ready;
    initAttempted = true;

    const filePath = defaultAccountPath;
    if (!fs.existsSync(filePath)) {
        console.warn(`FCM disabled: service account not found at ${filePath}`);
        return false;
    }

    try {
        const serviceAccount = JSON.parse(fs.readFileSync(filePath, "utf8"));
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
        });
        ready = true;
        console.log("FCM ready");
    } catch (error) {
        console.error("FCM init failed:", error.message);
    }

    return ready;
}

export async function ensureDeviceTokenTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_device_tokens (
            id INT AUTO_INCREMENT PRIMARY KEY,
            username VARCHAR(191) NOT NULL,
            token VARCHAR(512) NOT NULL,
            platform VARCHAR(20) NOT NULL DEFAULT 'android',
            updated_at DATETIME NOT NULL,
            UNIQUE KEY uniq_token (token),
            KEY idx_username (username)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
}

export function userIsOnline(WsIo, username) {
    if (!username || !WsIo) return false;
    const room = WsIo.sockets?.adapter?.rooms?.get(`mobile:${username}`);
    return Boolean(room && room.size > 0);
}

export async function saveDeviceToken(username, token, platform = "android") {
    await ensureDeviceTokenTable();
    await pool.query(
        `INSERT INTO user_device_tokens (username, token, platform, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE username = VALUES(username), platform = VALUES(platform), updated_at = NOW()`,
        [username, token, platform]
    );
}

export async function deleteDeviceToken(username, token) {
    await ensureDeviceTokenTable();
    if (token) {
        await pool.query("DELETE FROM user_device_tokens WHERE username = ? AND token = ?", [username, token]);
        return;
    }
    await pool.query("DELETE FROM user_device_tokens WHERE username = ?", [username]);
}

function messagePreview(message) {
    const text = String(message?.message || "").trim();
    if (text) return text.slice(0, 180);
    const type = String(message?.message_type || "");
    if (type.includes("image")) return "Photo";
    if (type.includes("video")) return "Video";
    if (type.includes("audio") || type.includes("voice")) return "Voice message";
    if (type.includes("document")) return "Document";
    if (type.includes("location")) return "Location";
    if (type.includes("sticker")) return "Sticker";
    return "New message";
}

export async function pushChatIfOffline(WsIo, username, payload) {
    if (!username) return;
    const message = payload?.message || {};
    if (message.type !== "in") return;
    // A closed app can leave the socket room occupied until the ping times out.
    // Still send the push. The open app ignores it and uses the socket instead.
    if (!initFirebase()) return;

    let rows = [];
    try {
        const [found] = await pool.query(
            "SELECT token FROM user_device_tokens WHERE username = ?",
            [username]
        );
        rows = found;
    } catch (error) {
        console.warn("FCM token lookup failed:", error.message);
        return;
    }

    if (!rows.length) return;

    const contact = payload?.contact || {};
    const contactNumber = String(contact.number || "");
    const contactName = String(contact.name || contactNumber || "New message");
    const body = messagePreview(message);
    const data = {
        type: "chat_message",
        contactNumber,
        contactName,
        messageText: body,
        projectId: String(payload?.project_id || ""),
        mediaType: String(message.message_type || ""),
    };

    try {
        const response = await admin.messaging().sendEachForMulticast({
            tokens: rows.map((row) => row.token),
            data,
            android: {
                priority: "high",
            },
        });

        const stale = [];
        response.responses.forEach((result, index) => {
            if (result.success) return;
            const code = result.error?.code || "unknown";
            console.warn(`FCM delivery failed (${code})`);
            if (
                code === "messaging/registration-token-not-registered" ||
                code === "messaging/invalid-registration-token"
            ) {
                stale.push(rows[index].token);
            }
        });
        if (response.successCount > 0) {
            console.log(`FCM delivered ${response.successCount}/${rows.length}`);
        }

        if (stale.length) {
            await pool.query(
                `DELETE FROM user_device_tokens WHERE token IN (${stale.map(() => "?").join(",")})`,
                stale
            );
        }
    } catch (error) {
        console.warn("FCM send failed:", error.message);
    }
}
