import express from "express";
const router = express.Router();
import pool from "../db.js";
import { AISENSY_PROJECT_DATA, GET_ADMIN_OF_PROJECT, GetAiSensyProjectToken, RANDOM_STRING, SAVE_MEDIA, TIMESTAMP } from "../helpers/function.js";
import { WsIo } from "../server.js";
import { emitToProjectSockets } from "../helpers/socketEmit.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { processWalletTopupWebhook } from "../helpers/paymentGateway.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEBHOOK_QUEUE_DIR = path.join(__dirname, "../webhookqueue");
const __processingProjects = new Set();

function __sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function __sanitizeProjectId(project_id) {
    const s = String(project_id || "").trim();
    // Safe filename only
    if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error("Invalid project_id");
    return s;
}

function __qPaths(project_id) {
    const pid = __sanitizeProjectId(project_id);
    return {
        pid,
        queueFile: path.join(WEBHOOK_QUEUE_DIR, `${pid}.json`),
        lockFile: path.join(WEBHOOK_QUEUE_DIR, `${pid}.lock`),
        inflightFile: path.join(WEBHOOK_QUEUE_DIR, `${pid}.inflight.json`),
        failedFile: path.join(WEBHOOK_QUEUE_DIR, `${pid}.failed.json`),
    };
}

async function __ensureQueueDir() {
    await fs.promises.mkdir(WEBHOOK_QUEUE_DIR, { recursive: true });
}

// Cross-process (same server) lock using lock file (wx)
// If lock file is older than maxLockAgeMs, treat as stale (crashed process) and remove it.
const LOCK_MAX_AGE_MS = 60 * 1000; // 60 seconds

async function __acquireLock(lockFile, { retries = 240, delayMs = 25, maxLockAgeMs = LOCK_MAX_AGE_MS } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
        for (let i = 0; i < retries; i++) {
            try {
                const handle = await fs.promises.open(lockFile, "wx");
                return handle;
            } catch (e) {
                if (e?.code !== "EEXIST") throw e;
                await __sleep(delayMs);
            }
        }
        // Retries exhausted: try to recover from stale lock
        if (maxLockAgeMs > 0) {
            try {
                const stat = await fs.promises.stat(lockFile);
                const ageMs = Date.now() - stat.mtimeMs;
                if (ageMs >= maxLockAgeMs) {
                    await fs.promises.unlink(lockFile).catch(() => { });
                    await __sleep(50);
                    continue; // retry outer loop (one more full acquire cycle)
                }
            } catch (statErr) {
                if (statErr?.code === "ENOENT") {
                    continue; // lock gone, retry acquire
                }
            }
        }
        break;
    }
    throw new Error(`Lock timeout: ${lockFile}`);
}

async function __releaseLock(handle, lockFile) {
    try { await handle.close(); } catch { }
    try { await fs.promises.unlink(lockFile); } catch { }
}

async function __readJsonArray(file) {
    try {
        const txt = await fs.promises.readFile(file, "utf8");
        const data = JSON.parse(txt || "[]");
        return Array.isArray(data) ? data : [];
    } catch (e) {
        if (e?.code === "ENOENT") return [];
        throw e;
    }
}

async function __writeJsonAtomic(file, data) {
    const tmp = `${file}.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.promises.rename(tmp, file);
}

async function __appendFailed(project_id, item) {
    const { failedFile } = __qPaths(project_id);
    const arr = await __readJsonArray(failedFile);
    arr.push(item);
    await __writeJsonAtomic(failedFile, arr);
}

async function __enqueueWebhookToFile(project_id, jsonObj) {
    await __ensureQueueDir();
    const { queueFile, lockFile } = __qPaths(project_id);

    let raw_json = "{}";
    try { raw_json = JSON.stringify(jsonObj ?? {}); } catch { }

    const item = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        received_at: new Date().toISOString(),
        raw_json,
        attempts: 0,
    };

    const lockHandle = await __acquireLock(lockFile);
    try {
        const q = await __readJsonArray(queueFile);
        q.push(item); // FIFO append
        await __writeJsonAtomic(queueFile, q);
    } finally {
        await __releaseLock(lockHandle, lockFile);
    }

    __triggerProjectProcessing(project_id);
}

async function __popNextItem(project_id, { mode = "fifo" } = {}) {
    const { queueFile, lockFile, inflightFile } = __qPaths(project_id);

    const lockHandle = await __acquireLock(lockFile);
    try {
        // If inflight exists, process it first
        if (fs.existsSync(inflightFile)) {
            const txt = await fs.promises.readFile(inflightFile, "utf8");
            const item = JSON.parse(txt || "null");
            return item || null;
        }

        const q = await __readJsonArray(queueFile);
        if (!q.length) return null;

        const item = mode === "lifo" ? q.pop() : q.shift();

        await __writeJsonAtomic(queueFile, q);
        await fs.promises.writeFile(inflightFile, JSON.stringify(item, null, 2), "utf8");
        return item;
    } finally {
        await __releaseLock(lockHandle, lockFile);
    }
}

async function __clearInflight(project_id) {
    const { lockFile, inflightFile } = __qPaths(project_id);
    const lockHandle = await __acquireLock(lockFile);
    try {
        await fs.promises.unlink(inflightFile).catch(() => { });
    } finally {
        await __releaseLock(lockHandle, lockFile);
    }
}

function __triggerProjectProcessing(project_id) {
    const pid = __sanitizeProjectId(project_id);
    if (__processingProjects.has(pid)) return;

    __processingProjects.add(pid);
    __processProjectQueue(pid)
        .catch((e) => console.error("Webhook queue processor error:", pid, e?.stack || e))
        .finally(() => __processingProjects.delete(pid));
}

async function __processProjectQueue(project_id) {
    // You said "from last object": that is LIFO.
    // But WhatsApp ordering is usually safer with FIFO.
    // Choose one:
    const MODE = "fifo"; // change to "lifo" if you really want last-in-first-out

    while (true) {
        const item = await __popNextItem(project_id, { mode: MODE });
        if (!item) break;

        try {
            const payload = JSON.parse(item.raw_json || "{}");
            await __handleWebhookPayload(project_id, payload, item.raw_json);

            await __clearInflight(project_id);
        } catch (err) {
            const msg = String(err?.stack || err?.message || err);
            console.error("Webhook payload failed:", project_id, msg);

            item.attempts = Number(item.attempts || 0) + 1;
            item.last_error = msg;
            item.last_failed_at = new Date().toISOString();

            await __clearInflight(project_id);

            // retry up to 5 times
            if (item.attempts >= 5) {
                await __appendFailed(project_id, item);
            } else {
                // re-enqueue (end)
                const { queueFile, lockFile } = __qPaths(project_id);
                const lockHandle = await __acquireLock(lockFile);
                try {
                    const q = await __readJsonArray(queueFile);
                    q.push(item);
                    await __writeJsonAtomic(queueFile, q);
                } finally {
                    await __releaseLock(lockHandle, lockFile);
                }
            }
        }
    }
}

export async function startWebhookQueueDaemon({ intervalMs = 500 } = {}) {
    await __ensureQueueDir();

    setInterval(async () => {
        try {
            const files = await fs.promises.readdir(WEBHOOK_QUEUE_DIR);
            const pids = new Set();

            for (const f of files) {
                if (f.endsWith(".json") && !f.endsWith(".failed.json") && !f.endsWith(".inflight.json")) {
                    pids.add(f.replace(/\.json$/, ""));
                }
                if (f.endsWith(".inflight.json")) {
                    pids.add(f.replace(/\.inflight\.json$/, ""));
                }
            }

            for (const pid of pids) __triggerProjectProcessing(pid);
        } catch (e) {
            console.error("Queue daemon scan error:", e?.message || e);
        }
    }, intervalMs);
}

/**
 * For an incoming message: ensure an open case exists for (project_id, number);
 * if not, create one. Then insert a row into case_messages linking the case to the message.
 * case_messages stores the messages table's unique_id (in unique_id and message_id columns).
 */
async function __ensureCaseAndAddMessage(project_id, number, message_unique_id) {
    const [openCase] = await pool.query(
        "SELECT case_id FROM cases WHERE project_id = ? AND number = ? AND status = '0' LIMIT 1",
        [project_id, number]
    );
    let case_id;
    if (!openCase || openCase.length === 0) {
        case_id = RANDOM_STRING(30);
        await pool.query(
            "INSERT INTO cases (case_id, project_id, number, create_by, status) VALUES (?, ?, ?, 'WEBHOOK', '0')",
            [case_id, project_id, number]
        );
    } else {
        case_id = openCase[0].case_id;
    }
    await pool.query(
        "INSERT INTO case_messages (unique_id, project_id, case_id, message_id) VALUES (?, ?, ?, ?)",
        [message_unique_id, project_id, case_id, message_unique_id]
    );
}

async function __handleWebhookPayload(project_id, json, raw_json) {
    // keep your test logging
    // await pool.query("INSERT INTO `test`(`value`) VALUES (?)", [raw_json]);

    if (!json?.entry || !Array.isArray(json.entry)) return;

    for (const entry of json.entry) {
        const changes0 = entry?.changes?.[0];
        if (!changes0) continue;

        const changes = changes0?.value || {};
        const field = changes0?.field;

        const messages = changes.messages;
        const message_echoes = changes.message_echoes;
        const statuses = changes.statuses;

        // ---------------- INCOMING MESSAGE WEBHOOK ----------------
        if (messages && messages.length > 0) {
            for (const message of messages) {
                const messageType = message.type;
                const unique_id = RANDOM_STRING(30);
                const wamid = message?.id;

                if (messageType === "text") {
                    const sender = message?.from;
                    const msg = message?.text?.body;
                    const is_forwarded = message?.context?.forwarded ? "1" : "0";
                    const reply_wamid = message?.context?.id || null;
                    const is_reply = reply_wamid ? "1" : "0";

                    await pool.query(
                        "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "text", msg, "received", raw_json, sender, is_forwarded, is_reply, reply_wamid]
                    );
                } else if (messageType === "image") {
                    const sender = message?.from;
                    const folder_path = `media/chat/${project_id}/${sender}/image`;
                    const media_id = message?.image?.id;

                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);
                    if (file_path) {
                        const caption = message?.image?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        await pool.query(
                            "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "image", caption, "received", raw_json, sender, file_path, "Image", is_forwarded, is_reply, reply_wamid]
                        );
                    }
                } else if (messageType === "video") {
                    const sender = message?.from;
                    const folder_path = `media/chat/${project_id}/${sender}/video`;
                    const media_id = message?.video?.id;

                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);
                    if (file_path) {
                        const caption = message?.video?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        await pool.query(
                            "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "video", caption, "received", raw_json, sender, file_path, "Video", is_forwarded, is_reply, reply_wamid]
                        );
                    }
                } else if (messageType === "document") {
                    const sender = message?.from;
                    const folder_path = `media/chat/${project_id}/${sender}/document`;
                    const media_id = message?.document?.id;

                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);
                    if (file_path) {
                        const caption = message?.document?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const file_name = message?.document?.filename ? message.document.filename : "Document";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";


                        await pool.query(
                            "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "document", caption, "received", raw_json, sender, file_path, file_name, is_forwarded, is_reply, reply_wamid]
                        );
                    }
                } else if (messageType === "audio") {
                    const sender = message?.from;
                    const folder_path = `media/chat/${project_id}/${sender}/audio`;
                    const media_id = message?.audio?.id;

                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);
                    if (file_path) {
                        const caption = message?.audio?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const is_voice = message?.audio?.voice ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        await pool.query(
                            "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_voice`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "audio", caption, "received", raw_json, sender, file_path, "Audio", is_forwarded, is_voice, is_reply, reply_wamid]
                        );
                    }
                } else if (messageType === "location") {
                    const sender = message?.from;
                    const caption = message?.location?.caption;
                    const address = message?.location?.address;
                    const latitude = message?.location?.latitude;
                    const longitude = message?.location?.longitude;
                    const location_name = message?.location?.name;

                    const is_forwarded = message?.context?.forwarded ? "1" : "0";
                    const reply_wamid = message?.context?.id || null;
                    const is_reply = reply_wamid ? "1" : "0";

                    await pool.query(
                        "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`is_forwarded`,`location_address`,`latitude`,`longitude`,`location_name`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "location", caption, "received", raw_json, sender, is_forwarded, address, latitude, longitude, location_name, is_reply, reply_wamid]
                    );
                } else if (messageType === "button") {
                    const sender = message?.from;
                    const msg = message?.button?.text;
                    const reply_wamid = message?.context?.id;
                    const is_forwarded = message?.context?.forwarded ? "1" : "0";

                    await pool.query(
                        "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        [unique_id, wamid, project_id, TIMESTAMP(), "WEBHOOK", "in", "text", msg, "received", raw_json, sender, is_forwarded, "1", reply_wamid]
                    );
                }

                // Emit chat (your original block unchanged, but now sequential)
                const [updated_row] = await pool.query("SELECT * FROM messages WHERE unique_id = ?", [unique_id]);
                if (updated_row.length > 0) {
                    const element = updated_row[0];

                    // Case: create/link case only if aisensy_projects.auto_case_create == "1"
                    if (element.type === "in") {
                        const [[projectRow]] = await pool.query(
                            "SELECT auto_case_create FROM aisensy_projects WHERE project_id = ? LIMIT 1",
                            [project_id]
                        );
                        if (projectRow?.auto_case_create === "1") {
                            await __ensureCaseAndAddMessage(project_id, element.number, unique_id);
                        }
                    }

                    let {
                        id, create_date, type, message_type, message: message_msg, file_name, file_path, failed_reason,
                        is_template, is_forwarded, is_reply, is_voice, status, location_address, latitude, longitude,
                        location_name, is_read, read_by, number, is_campaign, campaign_id
                    } = element;

                    is_template = is_template == "1";
                    is_forwarded = is_forwarded == "1";
                    is_reply = is_reply == "1";
                    is_voice = is_voice == "1";
                    is_read = is_read == "1";
                    is_campaign = is_campaign == "1";

                    const object = {
                        message_id: unique_id,
                        wamid,
                        create_date,
                        type,
                        message_type,
                        message: message_msg,
                        is_template,
                        is_forwarded,
                        is_reply,
                        status,
                        id,
                        is_campaign,
                    };

                    if (type === "in") {
                        object.is_read = is_read;
                        if (is_read) {
                            const [reader_row] = await pool.query("SELECT * FROM users WHERE username = ?", [read_by]);
                            if (reader_row.length > 0) {
                                object.read_by = {
                                    username: reader_row[0]?.username,
                                    name: reader_row[0]?.name,
                                    mobile: `${reader_row[0]?.country_code}${reader_row[0]?.mobile}`,
                                    email: reader_row[0]?.email,
                                    status: reader_row[0]?.status == "1",
                                };
                            }
                        }
                    }

                    if (is_campaign) object.campaign_id = campaign_id;
                    if (status === "failed") object.failed_reason = failed_reason;

                    if (message_type === "image") {
                        object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${number}/image/${file_path}`;
                        object.media_name = file_name;
                    }
                    if (message_type === "document") {
                        object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${number}/document/${file_path}`;
                        object.media_name = file_name;
                    }
                    if (message_type === "video") {
                        object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${number}/video/${file_path}`;
                        object.media_name = file_name;
                    }
                    if (message_type === "audio") {
                        object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${number}/audio/${file_path}`;
                        object.media_name = file_name;
                        object.is_voice = is_voice;
                    }
                    if (message_type === "location") {
                        object.address = location_address;
                        object.latitude = latitude;
                        object.longitude = longitude;
                        object.name = location_name;
                    }

                    // reply_to_message block (unchanged)
                    if (is_reply) {
                        object.reply_wamid = element.reply_wamid;

                        if (element.reply_wamid) {
                            const [reply_rows] = await pool.query(
                                "SELECT messages.*,users.name AS sender_name,users.email AS sender_email,users.country_code AS sender_country_code, users.mobile AS sender_mobile,users.status AS sender_status,reader.name AS reader_name,reader.email AS reader_email,reader.country_code AS reader_country_code, reader.mobile AS reader_mobile,reader.status AS reader_status FROM messages LEFT JOIN users ON users.username = messages.message_by LEFT JOIN users reader ON reader.username = messages.read_by WHERE messages.project_id = ? AND messages.wamid = ? LIMIT 1",
                                [project_id, element.reply_wamid]
                            );

                            if (reply_rows.length > 0) {
                                const reply_element = reply_rows[0];
                                const reply_number = reply_element.number;

                                const reply_object = {
                                    message_id: reply_element.unique_id,
                                    wamid: reply_element.wamid,
                                    create_date: reply_element.create_date,
                                    type: reply_element.type,
                                    message_type: reply_element.message_type,
                                    message: reply_element.message,
                                    is_template: reply_element.is_template == "1",
                                    is_forwarded: reply_element.is_forwarded == "1",
                                    is_reply: reply_element.is_reply == "1",
                                    status: reply_element.status,
                                    id: reply_element.id,
                                    is_campaign: reply_element.is_campaign == "1",
                                };

                                if (reply_element.type === "out") {
                                    reply_object.send_by = {
                                        username: reply_element.message_by,
                                        name: reply_element.sender_name,
                                        mobile: `${reply_element.sender_country_code}${reply_element.sender_mobile}`,
                                        email: reply_element.sender_email,
                                        status: reply_element.sender_status == "1",
                                    };
                                    if (reply_object.is_campaign) reply_object.campaign_id = reply_element.campaign_id;
                                } else if (reply_element.type === "in") {
                                    reply_object.is_read = reply_element.is_read == "1";
                                    if (reply_object.is_read) {
                                        reply_object.read_by = {
                                            username: reply_element.read_by,
                                            name: reply_element.reader_name,
                                            mobile: `${reply_element.reader_country_code}${reply_element.reader_mobile}`,
                                            email: reply_element.reader_email,
                                            status: reply_element.reader_status == "1",
                                        };
                                    }
                                }

                                if (reply_element.status === "failed") reply_object.failed_reason = reply_element.failed_reason;

                                if (reply_element.message_type === "image") {
                                    reply_object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${reply_number}/image/${reply_element.file_path}`;
                                    reply_object.media_name = reply_element.file_name;
                                }
                                if (reply_element.message_type === "document") {
                                    reply_object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${reply_number}/document/${reply_element.file_path}`;
                                    reply_object.media_name = reply_element.file_name;
                                }
                                if (reply_element.message_type === "video") {
                                    reply_object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${reply_number}/video/${reply_element.file_path}`;
                                    reply_object.media_name = reply_element.file_name;
                                }
                                if (reply_element.message_type === "audio") {
                                    reply_object.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${reply_number}/audio/${reply_element.file_path}`;
                                    reply_object.media_name = reply_element.file_name;
                                    reply_object.is_voice = reply_element.is_voice == "1";
                                }
                                if (reply_element.message_type === "location") {
                                    reply_object.address = reply_element.location_address;
                                    reply_object.latitude = reply_element.latitude;
                                    reply_object.longitude = reply_element.longitude;
                                    reply_object.name = reply_element.location_name;
                                }

                                if (reply_element.message_type === "template") {
                                    const tplFile = path.join(__dirname, "../media/templates/" + reply_element.template_id + ".json");
                                    const reply_template = fs.existsSync(tplFile) ? JSON.parse(fs.readFileSync(tplFile, "utf8")) : {};
                                    reply_object.template = reply_template;
                                    if (reply_element.component) reply_object.component = JSON.parse(reply_element.component);
                                }

                                object.reply_to_message = reply_object;
                            }
                        }
                    }

                    const [[total_unread_count]] = await pool.query("SELECT COUNT(*) AS count FROM `messages` WHERE `project_id` = ? AND `is_read` = ? AND type = 'in'", [project_id, "0"]);

                    const [case_open_count_row] = await pool.query("SELECT COUNT(*) AS case_open_count FROM cases WHERE project_id = ? AND number = ? AND status = '0'", [project_id, number]);
                    const case_open_count = Number(case_open_count_row[0]?.case_open_count) || 0;

                    const [contact_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
                    const name = contact_row.length > 0 ? contact_row[0]?.name : null;

                    await emitToProjectSockets(WsIo, project_id, "chat", {
                        message: object,
                        project_id,
                        contact: { number, name },
                    });

                    await emitToProjectSockets(WsIo, project_id, "total_unread_count", {
                        count: Number(total_unread_count?.count) || 0,
                        project_id,
                    });

                    await emitToProjectSockets(WsIo, project_id, "case_status", {
                        number,
                        case_open_count,
                    });
                }
            }
        }

        // ---------------- OUTGOING MESSAGE WEBHOOK (co-existence) ----------------
        if (field === "smb_message_echoes" && message_echoes && message_echoes.length > 0) {
            const admin_username = await GET_ADMIN_OF_PROJECT(project_id);

            async function emitOutgoingEcho(project_id, unique_id, recipient) {
                const [msg_row] = await pool.query("SELECT * FROM `messages` WHERE `unique_id` = ?", [unique_id]);
                if (msg_row.length === 0) return;
                const el = msg_row[0];
                const [send_by_row] = await pool.query("SELECT * FROM users WHERE username = ?", [admin_username]);
                const send_by_data = send_by_row[0];
                const [contact_row] = await pool.query("SELECT * FROM contacts WHERE project_id = ? AND number = ?", [project_id, recipient]);
                const name = contact_row.length > 0 ? contact_row[0]?.name : null;

                const is_forwarded = el.is_forwarded == "1";
                const is_reply = el.is_reply == "1";

                const return_message = {
                    wamid: el.wamid,
                    message_id: unique_id,
                    message: el.message,
                    create_date: el.create_date,
                    is_template: false,
                    is_forwarded,
                    is_reply,
                    status: "pending",
                    type: "out",
                    message_type: el.message_type,
                    id: el.id,
                    send_by: send_by_data ? {
                        username: send_by_data.username,
                        name: send_by_data.name,
                        mobile: `${send_by_data?.country_code ?? ""}${send_by_data?.mobile ?? ""}`,
                        email: send_by_data.email,
                        status: send_by_data.status == "1",
                    } : { username: admin_username, name: null, mobile: null, email: null, status: false },
                };
                if (el.message_type === "image") {
                    return_message.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${recipient}/image/${el.file_path}`;
                    return_message.media_name = el.file_name;
                } else if (el.message_type === "video") {
                    return_message.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${recipient}/video/${el.file_path}`;
                    return_message.media_name = el.file_name;
                } else if (el.message_type === "document") {
                    return_message.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${recipient}/document/${el.file_path}`;
                    return_message.media_name = el.file_name;
                } else if (el.message_type === "audio") {
                    return_message.media_url = `${BASE_DOMAIN}/chat-media/${project_id}/${recipient}/audio/${el.file_path}`;
                    return_message.media_name = el.file_name;
                    return_message.is_voice = el.is_voice == "1";
                }
                if (is_reply && el.reply_wamid) return_message.reply_wamid = el.reply_wamid;

                await emitToProjectSockets(WsIo, project_id, "chat", {
                    message: return_message,
                    project_id,
                    contact: { number: recipient, name },
                });
            }

            for (const message of message_echoes) {
                const messageType = message.type;
                const wamid = message?.id;
                const recipient = message?.to;

                const [existing_message] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ?", [wamid]);
                const message_exists = existing_message.length > 0;
                const unique_id = message_exists ? existing_message[0].unique_id : RANDOM_STRING(30);
                let didProcess = false;

                if (messageType === "text") {
                    const msg = message?.text?.body;
                    const is_forwarded = message?.context?.forwarded ? "1" : "0";
                    const reply_wamid = message?.context?.id || null;
                    const is_reply = reply_wamid ? "1" : "0";

                    if (message_exists) {
                        await pool.query(
                            "UPDATE `messages` SET `message_type` = ?, `message` = ?, `raw_json` = ?, `number` = ?, `is_forwarded` = ?, `is_reply` = ?, `reply_wamid` = ? WHERE `wamid` = ?",
                            ["text", msg, raw_json, recipient, is_forwarded, is_reply, reply_wamid, wamid]
                        );
                    } else {
                        await pool.query(
                            "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "text", msg, "pending", raw_json, recipient, is_forwarded, is_reply, reply_wamid]
                        );
                    }
                    didProcess = true;
                } else if (messageType === "image") {
                    const folder_path = `media/chat/${project_id}/${recipient}/image`;
                    const media_id = message?.image?.id;
                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);

                    if (file_path) {
                        const caption = message?.image?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        if (message_exists) {
                            await pool.query(
                                "UPDATE `messages` SET `message_type` = ?, `message` = ?, `raw_json` = ?, `number` = ?, `file_path` = ?, `file_name` = ?, `is_forwarded` = ?, `is_reply` = ?, `reply_wamid` = ? WHERE `wamid` = ?",
                                ["image", caption, raw_json, recipient, file_path, "Image", is_forwarded, is_reply, reply_wamid, wamid]
                            );
                        } else {
                            await pool.query(
                                "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "image", caption, "pending", raw_json, recipient, file_path, "Image", is_forwarded, is_reply, reply_wamid]
                            );
                        }
                        didProcess = true;
                    }
                } else if (messageType === "video") {
                    const folder_path = `media/chat/${project_id}/${recipient}/video`;
                    const media_id = message?.video?.id;
                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);

                    if (file_path) {
                        const caption = message?.video?.caption;
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        if (message_exists) {
                            await pool.query(
                                "UPDATE `messages` SET `message_type` = ?, `message` = ?, `raw_json` = ?, `number` = ?, `file_path` = ?, `file_name` = ?, `is_forwarded` = ?, `is_reply` = ?, `reply_wamid` = ? WHERE `wamid` = ?",
                                ["video", caption, raw_json, recipient, file_path, "Video", is_forwarded, is_reply, reply_wamid, wamid]
                            );
                        } else {
                            await pool.query(
                                "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "video", caption, "pending", raw_json, recipient, file_path, "Video", is_forwarded, is_reply, reply_wamid]
                            );
                        }
                        didProcess = true;
                    }
                } else if (messageType === "document") {
                    const folder_path = `media/chat/${project_id}/${recipient}/document`;
                    const media_id = message?.document?.id;
                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);

                    if (file_path) {
                        const caption = message?.document?.caption;
                        const file_name = message?.document?.file_name || "Document";
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        if (message_exists) {
                            await pool.query(
                                "UPDATE `messages` SET `message_type` = ?, `message` = ?, `raw_json` = ?, `number` = ?, `file_path` = ?, `file_name` = ?, `is_forwarded` = ?, `is_reply` = ?, `reply_wamid` = ? WHERE `wamid` = ?",
                                ["document", caption, raw_json, recipient, file_path, file_name, is_forwarded, is_reply, reply_wamid, wamid]
                            );
                        } else {
                            await pool.query(
                                "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "document", caption, "pending", raw_json, recipient, file_path, file_name, is_forwarded, is_reply, reply_wamid]
                            );
                        }
                        didProcess = true;
                    }
                } else if (messageType === "audio") {
                    const folder_path = `media/chat/${project_id}/${recipient}/audio`;
                    const media_id = message?.audio?.id;
                    const file_path = await SAVE_MEDIA(project_id, media_id, folder_path);

                    if (file_path) {
                        const caption = message?.audio?.caption;
                        const is_voice = message?.audio?.voice ? "1" : "0";
                        const is_forwarded = message?.context?.forwarded ? "1" : "0";
                        const reply_wamid = message?.context?.id || null;
                        const is_reply = reply_wamid ? "1" : "0";

                        if (message_exists) {
                            await pool.query(
                                "UPDATE `messages` SET `message_type` = ?, `message` = ?, `raw_json` = ?, `number` = ?, `file_path` = ?, `file_name` = ?, `is_forwarded` = ?, `is_voice` = ?, `is_reply` = ?, `reply_wamid` = ? WHERE `wamid` = ?",
                                ["audio", caption, raw_json, recipient, file_path, "Audio", is_forwarded, is_voice, is_reply, reply_wamid, wamid]
                            );
                        } else {
                            await pool.query(
                                "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `status`, `raw_json`,`number`,`file_path`,`file_name`,`is_forwarded`,`is_voice`,`is_reply`,`reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "audio", caption, "pending", raw_json, recipient, file_path, "Audio", is_forwarded, is_voice, is_reply, reply_wamid]
                            );
                        }
                        didProcess = true;
                    }
                }

                if (didProcess) {
                    await emitOutgoingEcho(project_id, unique_id, recipient);
                }
            }
        }

        // ---------------- STATUS (FIXED: sequential for...of + awaited DebitBalance) ----------------
        if (statuses && statuses.length > 0) {
            for (const status of statuses) {
                const wamid = status.id;
                const webhook_status = status.status;

                const [message_row] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ?", [wamid]);

                let current_message_row = message_row;
                if (message_row.length === 0) {
                    const admin_username = await GET_ADMIN_OF_PROJECT(project_id);
                    const unique_id = RANDOM_STRING(30);
                    const placeholder_status = ["sent", "delivered", "read", "failed"].includes(webhook_status) ? webhook_status : "pending";

                    let failed_reason = null;
                    if (webhook_status === "failed" && status?.errors && status.errors.length > 0) {
                        const error = status.errors[0];
                        failed_reason = error?.error_data?.details || error?.message || error?.title || "Message delivery failed";
                    }

                    await pool.query(
                        "INSERT INTO `messages`(`unique_id`, `wamid`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `status`, `raw_json`, `failed_reason`) VALUES (?,?,?,?,?,?,?,?,?,?)",
                        [unique_id, wamid, project_id, TIMESTAMP(), admin_username, "out", "text", placeholder_status, raw_json, failed_reason]
                    );

                    const [new_message_row] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ?", [wamid]);
                    current_message_row = new_message_row;
                }

                if (current_message_row.length > 0) {
                    const current_status = current_message_row[0]?.status;
                    const is_campaign = current_message_row[0]?.is_campaign == "1";
                    const campaign_id = current_message_row[0]?.campaign_id;

                    async function emitStatus(changes, extra = {}) {
                        const [[total_unread_count]] = await pool.query("SELECT COUNT(*) AS count FROM `messages` WHERE `project_id` = ? AND `is_read` = ? AND type = 'in'", [project_id, "0"]);

                        await emitToProjectSockets(WsIo, project_id, "message_status", {
                            message_id: current_message_row[0]?.unique_id,
                            last_id: current_message_row[0]?.id,
                            project_id,
                            changes,
                            ...extra,
                        });

                        await emitToProjectSockets(WsIo, project_id, "total_unread_count", {
                            count: Number(total_unread_count?.count) || 0,
                            project_id,
                        });
                    }

                    // Status flow: sent -> delivered -> read, or sent -> failed.
                    // Only allow: pending->*, sent->delivered|read|failed, delivered->read. Never allow read->sent/delivered or delivered->failed.
                    const allowedTransition = (from, to) => {
                        if (to === "sent") return from === "pending";
                        if (to === "delivered") return from === "pending" || from === "sent";
                        if (to === "read") return from === "pending" || from === "sent" || from === "delivered";
                        if (to === "failed") return from === "pending" || from === "sent";
                        return false;
                    };

                    if (webhook_status === "sent" && allowedTransition(current_status, "sent")) {
                        await pool.query("UPDATE `messages` SET `status` = ? WHERE `wamid` = ?", ["sent", wamid]);
                        if (is_campaign) await pool.query("UPDATE `campaign_messages` SET `status`= ? WHERE wamid= ? AND campaign_id= ?", ["sent", wamid, campaign_id]);
                        await emitStatus("sent");
                    }

                    if (webhook_status === "delivered" && allowedTransition(current_status, "delivered")) {
                        await pool.query("UPDATE `messages` SET `status` = ? WHERE `wamid` = ?", ["delivered", wamid]);
                        if (is_campaign) await pool.query("UPDATE `campaign_messages` SET `status`= ? WHERE wamid= ? AND campaign_id= ?", ["delivered", wamid, campaign_id]);
                        await emitStatus("delivered");
                    }

                    if (webhook_status === "read" && allowedTransition(current_status, "read")) {
                        await pool.query("UPDATE `messages` SET `status` = ? WHERE `wamid` = ?", ["read", wamid]);
                        if (is_campaign) await pool.query("UPDATE `campaign_messages` SET `status`= ? WHERE wamid= ? AND campaign_id= ?", ["read", wamid, campaign_id]);
                        await emitStatus("read");
                    }

                    if (webhook_status === "failed" && allowedTransition(current_status, "failed")) {
                        let failed_reason = "Message delivery failed";
                        if (status?.errors && status.errors.length > 0) {
                            const error = status.errors[0];
                            failed_reason = error?.error_data?.details || error?.message || error?.title || failed_reason;
                        }
                        await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `wamid` = ?", ["failed", failed_reason, wamid]);
                        if (is_campaign) await pool.query("UPDATE `campaign_messages` SET `status`= ?, `failed_reason`=? WHERE wamid= ? AND campaign_id= ?", ["failed", failed_reason, wamid, campaign_id]);
                        await emitStatus("failed", { failed_reason });
                    }
                }

                // PRICING CODES (FIX: await)
                const pricing = status?.pricing;
                if (pricing?.billable) {
                    const category = pricing?.category;
                    await DebitBalance(wamid, category);
                }
            }
        }

        // ---------------- TEMPLATE STATUS UPDATE ----------------
        if (field == "message_template_status_update") {
            const value = changes0?.value;
            const st = value?.event;
            const waba_template_id = value?.message_template_id;
            const reject_reason = value?.reason;

            await pool.query("UPDATE `templates` SET `status`=?,`reject_reason`=? WHERE waba_template_id = ?", [st, reject_reason, waba_template_id]);

            if (st == "APPROVED") {
                // START

                const [template_rows] = await pool.query("SELECT * FROM `templates` WHERE `waba_template_id` = ?", [waba_template_id]);
                const project_id = template_rows?.[0]?.project_id;

                if (project_id) {
                    const project_token = await GetAiSensyProjectToken(project_id);
                    if (project_token) {
                        const options = {
                            method: 'GET',
                            url: 'https://backend.aisensy.com/direct-apis/t1/get-template/' + waba_template_id,
                            headers: {
                                Accept: 'application/json',
                                Authorization: 'Bearer ' + project_token
                            }
                        };

                        const { data } = await axios.request(options);
                        const category = data?.category;
                        if (category == "MARKETING" || category == "UTILITY") {
                            await pool.query("UPDATE `templates` SET `category`=? WHERE waba_template_id = ?", [category, waba_template_id]);
                        }
                    }
                }
                // END
            }
        }
    }
}

router.post("/aisensy-webhook/:project_id", async (req, res) => {
    const { project_id } = req.params;

    // Enqueue to file (serial per project)
    try {
        await __enqueueWebhookToFile(project_id, req.body);
    } catch (e) {
        console.error("Webhook enqueue error:", e?.message || e);
        // Still ACK 200 to avoid Meta retry storms
    }

    return res.status(200).json({ ok: true });
});

async function DebitBalance(wamid, category) {

    const [check_row] = await pool.query("SELECT * FROM transactions WHERE value_1 = ?", [wamid]);

    if (check_row.length == 0) {
        const [message_row] = await pool.query("SELECT * FROM messages WHERE wamid = ?", [wamid]);
        if (message_row.length > 0) {
            const message_data = message_row[0];
            const project_id = message_data?.project_id;

            const project_data = await AISENSY_PROJECT_DATA(project_id);
            const admin_username = await GET_ADMIN_OF_PROJECT(project_id);

            const charges = project_data[`${category}_charge`];

            const transaction_id = RANDOM_STRING(30);
            await pool.query("INSERT INTO `transactions`(`transaction_id`, `project_id`, `create_date`, `create_by`, `type`, `transaction_type`, `amount`, `value_1`, `value_2`,`username`) VALUES (?,?,?,?,?,?,?,?,?,?)", [transaction_id, project_id, TIMESTAMP(), 'SYSTEM', '0', 'template send', charges, wamid, category, admin_username]);
        }
    }


}


// Wallet topup webhook — gateway selected via ACTIVE_GATEWAY in helpers/paymentGateway.js
// Zwitch:   { status: "captured", payment_token: { id } }
// Razorpay: { event: "payment.captured", payload: { payment: { entity: { ... } } } }
// Cashfree: { type: "PAYMENT_SUCCESS_WEBHOOK", data: { order: { order_id }, payment: { ... } } }
router.post("/wallet-topup", async (req, res) => {
    try {
        const result = await processWalletTopupWebhook(req);
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.log("[wallet-topup webhook]", error?.response?.data ?? error.message);
        return res.status(200).json({ error: "Failed to verify payment" });
    }
});


router.post("/partner-webhook", async (req, res) => {
    const json = req?.body;


    if (json?.event == "project_waba_updated") {
        const project_data = json?.data?.project;
        const project_id = project_data?.id;
        const is_whatsapp_verified = project_data?.is_whatsapp_verified;


        if (is_whatsapp_verified == true) {
            const wa_number = project_data?.wa_number;


            const project_token = await GetAiSensyProjectToken(project_id);

            const options = {
                method: 'PATCH',
                url: 'https://backend.aisensy.com/direct-apis/t1/settings/update-webhook',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${project_token}`
                },
                data: { webhooks: { url: `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}` } }
            };
            try {
                await axios.request(options);
                await pool.query("UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?", [`${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`, project_id]);
            } catch (error) {
                console.error("[partner-webhook] Webhook subscription error", { project_id, message: error?.message, response: error?.response?.data });
            }

            await pool.query("UPDATE `aisensy_projects` SET `is_waba_connected`=?, `wa_number`=? WHERE project_id = ?", ['1', wa_number, project_id]);
        }
    }

    return res.status(200).json({ ok: true });
})

export default router