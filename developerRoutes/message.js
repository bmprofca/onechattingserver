import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import pool from "../db.js";
import { developerMessageAuth, developerSendMessageAuth } from "../middleware/developerAuth.js";
import { CheckProjectValidity } from "../middleware/auth.js";
import {
    AISENSY_PROJECT_DATA,
    GET_BALANCE,
    GetAiSensyProjectToken,
    GET_CHAT_MEDIA_KEY_PREFIX,
    GET_CHAT_MEDIA_URL,
    MOVE_MEDIA,
    RANDOM_STRING,
    TIMESTAMP,
    USER_DATA,
} from "../helpers/function.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { WsIo } from "../server.js";
import { emitToProjectSockets } from "../helpers/socketEmit.js";
import {
    buildTemplateDisplayMessage,
    expandTemplateMediaUrls,
    loadTemplateFromDb,
    parseMessageComponent,
} from "../helpers/templateStorage.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveProjectContext(req, res) {
    const project_id = req.developerMapping?.project_id;
    const username = req.developerMapping?.username;

    if (!project_id) {
        res.status(200).json({ error: "Invalid or missing token" });
        return null;
    }

    return { project_id, username };
}

function parseReplyFields(body) {
    const is_reply = body?.is_reply === true || body?.is_reply === "true";
    const reply_wamid = body?.reply_wamid ?? null;
    return { is_reply, reply_wamid, is_reply_value: is_reply ? "1" : "0" };
}

function validateReplyInput(is_reply, reply_wamid) {
    if (is_reply && !reply_wamid) {
        return "reply_wamid is required when is_reply is true";
    }
    return null;
}

async function fetchAssigned({ number, project_id, username }) {
    const [assignmentResult, usersResult] = await Promise.all([
        pool.query(
            "SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1",
            [project_id, number]
        ),
        pool.query(
            `SELECT users.*, project_mapping.type
             FROM project_mapping
             JOIN users ON users.username = project_mapping.username
             WHERE project_mapping.is_deleted = ?
             AND project_mapping.project_id = ?
             AND users.status = ?
             ORDER BY users.name ASC`,
            ["0", project_id, "1"]
        ),
    ]);

    const [assignments] = assignmentResult;
    const [usersRows] = usersResult;

    const users = usersRows.map((user) => ({
        username: user.username,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        type: user.type === "admin" ? "admin" : "agent",
        is_me: user.username === username,
    }));

    if (assignments.length === 0) {
        return { assigned: false, users };
    }

    const assignment = assignments[0];
    const assignedUserData = await USER_DATA(assignment.username);

    return {
        assigned: true,
        assigned_to_me: assignment.username === username,
        assigned_user: {
            name: assignedUserData?.name,
            mobile: assignedUserData?.mobile,
            email: assignedUserData?.email,
            status: assignedUserData?.status === "1",
            username: assignedUserData?.username,
        },
        users,
    };
}

async function emitChatAssignedSocket(project_id, number, username) {
    const assigning = await fetchAssigned({ number, project_id, username });
    await emitToProjectSockets(WsIo, project_id, "chat_assigned", { assigning });
}

async function emitChatSocket(db, project_id, number, return_message, options = {}) {
    const { templateContact = false } = options;

    let name = null;
    if (templateContact) {
        const [contact_row] = await db.query(
            "SELECT * FROM contacts WHERE project_id = ? AND number = ? AND is_deleted = ?",
            [project_id, number, "0"]
        );
        name = contact_row.length > 0 ? contact_row[0]?.name : false;
    } else {
        const [contact_row] = await db.query(
            "SELECT * FROM `contacts` WHERE project_id = ? AND number = ?",
            [project_id, number]
        );
        name = contact_row.length > 0 ? contact_row[0]?.name : null;
    }

    await emitToProjectSockets(WsIo, project_id, "chat", {
        message: return_message,
        project_id,
        contact: { number, name },
    });
}

async function ensureChatAssigned(db, project_id, number, username) {
    const [check_assigned] = await db.query(
        "SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1",
        [project_id, number]
    );

    if (check_assigned.length === 0) {
        await db.query(
            "INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)",
            [project_id, number, username, TIMESTAMP(), username]
        );

        await emitChatAssignedSocket(project_id, number, username);

        return { ok: true };
    }

    if (check_assigned[0]?.username !== username) {
        return { ok: false, error: "You are not assigned to this number" };
    }

    return { ok: true };
}

async function validateReplyWamid(db, project_id, reply_wamid) {
    const [reply_check] = await db.query(
        "SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?",
        [reply_wamid, project_id]
    );
    return reply_check.length > 0;
}

function formatSendBy(send_by_data) {
    return {
        username: send_by_data?.username,
        name: send_by_data?.name,
        mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
        email: send_by_data?.email,
        status: send_by_data?.status == "1",
    };
}

async function preSendChecks(project_id) {
    const project_validity = await CheckProjectValidity(project_id);
    if (!project_validity) {
        return { ok: false, error: "Project subscription is expired" };
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return { ok: false, error: "Failed to get project token" };
    }

    return { ok: true, project_token };
}

async function sendAisensyMessage(project_token, payload) {
    return axios.request({
        method: "POST",
        url: "https://backend.aisensy.com/direct-apis/t1/messages",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, application/xml",
            Authorization: `Bearer ${project_token}`,
        },
        data: payload,
    });
}

function withReplyContext(payload, is_reply, reply_wamid) {
    if (is_reply && reply_wamid) {
        return { ...payload, context: { message_id: reply_wamid } };
    }
    return payload;
}

router.get("/chat-list", developerMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const page_no = Number(req.query?.page_no || 1);
    let limit = Number(req.query?.limit ?? 100);
    if (!Number.isFinite(limit) || limit < 1) limit = 100;
    if (limit > 100) limit = 100;
    const offset = (page_no - 1) * limit;

    const search = (req.query?.search ?? "").toString().trim();
    const hasSearch = search.length > 0;
    const searchLike = `%${search}%`;


    const searchSql = hasSearch
        ? ` AND (
                m.number LIKE ? OR
                m.message LIKE ? OR
                contacts.name LIKE ? OR
                contacts.email LIKE ? OR
                contacts.firm_name LIKE ? OR
                contacts.website LIKE ? OR
                contacts.remark LIKE ?
            )`
        : "";
    const searchParams = hasSearch
        ? [searchLike, searchLike, searchLike, searchLike, searchLike, searchLike, searchLike]
        : [];

    const listSql =
        "SELECT m.*, contacts.name, CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc WHERE fc.project_id = m.project_id AND fc.number = m.number AND fc.username = ? AND fc.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite, (SELECT COUNT(*) FROM cases c WHERE c.project_id = m.project_id AND c.number = m.number AND c.status = '0') AS case_open_count, COUNT(CASE WHEN m2.type = 'in' AND m2.is_read = '0' THEN 1 END) AS unread_count FROM messages m INNER JOIN (SELECT project_id, number, MAX(id) AS last_id FROM messages GROUP BY project_id, number) AS last_msg ON m.project_id = last_msg.project_id AND m.number = last_msg.number AND m.id = last_msg.last_id LEFT JOIN contacts ON contacts.number = m.number AND contacts.project_id = m.project_id AND contacts.is_deleted = '0' LEFT JOIN messages m2 ON m2.number = m.number AND m2.project_id = m.project_id AND m2.type = 'in' AND m2.is_read = '0' WHERE m.project_id = ?" +
        searchSql +
        " GROUP BY m.id, contacts.name ORDER BY last_msg.last_id DESC LIMIT ?, ?";

    const countSql =
        "SELECT COUNT(*) AS total FROM (SELECT m.id FROM messages m INNER JOIN (SELECT project_id, number, MAX(id) AS last_id FROM messages GROUP BY project_id, number) AS last_msg ON m.project_id = last_msg.project_id AND m.number = last_msg.number AND m.id = last_msg.last_id LEFT JOIN contacts ON contacts.number = m.number AND contacts.project_id = m.project_id AND contacts.is_deleted = '0' WHERE m.project_id = ?" +
        searchSql +
        " GROUP BY m.id, contacts.name) AS chat_rows";

    const [[rows], [countRows]] = await Promise.all([
        pool.query(listSql, [username, project_id, ...searchParams, offset, limit]),
        pool.query(countSql, [project_id, ...searchParams]),
    ]);

    const total = Number(countRows[0]?.total) || 0;
    const total_pages = Math.ceil(total / limit) || 0;

    const res_data = [];

    if (rows.length > 0) {
        rows.forEach((element) => {
            const last_id = element.id;
            const unique_id = element.unique_id;
            const number = element.number;
            const wamid = element.wamid;
            const message = element.message;
            const create_date = element.create_date;
            const type = element.type;
            const message_type = element.message_type;
            const status = element.status;
            const failed_reason = element.failed_reason;
            const name = element.name;
            const is_favorite = element.is_favorite == "yes" ? true : false;
            const case_open_count = Number(element.case_open_count) || 0;
            const unread_count = element.unread_count;

            const object = {
                contact: { number, name, is_favorite },
                case_open_count,
                last_message: {
                    id: last_id,
                    wamid,
                    create_date,
                    type,
                    message_type,
                    message,
                    status,
                    unique_id,
                },
                unread_count,
            };

            if (status == "failed") {
                object.failed_reason = failed_reason;
            }

            res_data.push(object);
        });
    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        pagination: {
            page_no,
            limit,
            total,
            total_pages,
            has_more: page_no < total_pages,
        },
    });
});

router.get("/chat-history", developerMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    let last_id = Number(req.query?.last_id ?? 0);
    const number = req.query?.number;
    let limit = Number(req.query?.limit ?? 100);
    if (!Number.isFinite(limit) || limit < 1) limit = 100;
    if (limit > 100) limit = 100;

    if (!number) {
        return res.status(400).json({ error: "number is required" });
    }

    const cursorLastId = last_id == 0 ? 0 : last_id;
    const historySql =
        "SELECT messages.*,users.name AS sender_name,users.email AS sender_email,users.country_code AS sender_country_code, users.mobile AS sender_mobile,users.status AS sender_status,reader.name AS reader_name,reader.email AS reader_email,reader.country_code AS reader_country_code, reader.mobile AS reader_mobile,reader.status AS reader_status FROM messages LEFT JOIN users ON users.username = messages.message_by LEFT JOIN users reader ON reader.username = messages.read_by LEFT JOIN contacts ON contacts.number = messages.number AND contacts.project_id = messages.project_id AND contacts.is_deleted = '0' WHERE messages.project_id = ? AND messages.number = ? AND (? = 0 OR messages.id < ?) ORDER BY messages.id DESC LIMIT ?";

    const [[rows], [countRows], [assignRows]] = await Promise.all([
        pool.query(historySql, [project_id, number, cursorLastId, cursorLastId, limit]),
        pool.query(
            "SELECT COUNT(*) AS total FROM `messages` WHERE `project_id` = ? AND `number` = ?",
            [project_id, number]
        ),
        pool.query(
            `SELECT pm.developer_token
             FROM chat_assigned ca
             INNER JOIN project_mapping pm
               ON pm.username = ca.username
              AND pm.project_id = ca.project_id
              AND pm.is_deleted = '0'
             WHERE ca.project_id = ? AND ca.number = ?
             ORDER BY ca.id DESC
             LIMIT 1`,
            [project_id, number]
        ),
    ]);

    const total = Number(countRows[0]?.total) || 0;
    const assigned =
        assignRows[0]?.developer_token ?? req.developerMapping?.developer_token ?? null;

    const res_data = [];

    if (rows.length > 0) {
        for (const element of rows) {
            last_id = element.id;
            const unique_id = element.unique_id;
            const wamid = element.wamid;
            const create_date = element.create_date;
            const type = element.type;
            const message_type = element.message_type;
            const message = element.message;
            const file_name = element.file_name;
            const file_path = element.file_path;
            const failed_reason = element.failed_reason;
            let is_template = element.is_template;
            let is_forwarded = element.is_forwarded;
            let is_reply = element.is_reply;
            let is_voice = element.is_voice;
            const status = element.status;
            const location_address = element.location_address;
            const latitude = element.latitude;
            const longitude = element.longitude;
            const location_name = element.location_name;
            let is_read = element.is_read;
            const component = element.component;
            const template_id = element.template_id;
            let is_campaign = element.is_campaign;
            const campaign_id = element.campaign_id;

            is_template = is_template == "1" ? true : false;
            is_forwarded = is_forwarded == "1" ? true : false;
            is_reply = is_reply == "1" ? true : false;
            is_voice = is_voice == "1" ? true : false;
            is_read = is_read == "1" ? true : false;
            is_campaign = is_campaign == "1" ? true : false;

            const object = {
                message_id: unique_id,
                wamid,
                create_date,
                type,
                message_type,
                message,
                is_template,
                is_forwarded,
                is_reply,
                status,
                id: last_id,
                is_campaign,
            };

            if (type == "out") {
                object.send_by = {
                    username: element.message_by,
                    name: element.sender_name,
                    mobile: `${element.sender_country_code}${element.sender_mobile}`,
                    email: element.sender_email,
                    status: element.sender_status == "1" ? true : false,
                };

                if (is_campaign) {
                    object.campaign_id = campaign_id;
                }
            } else if (type == "in") {
                object.is_read = is_read;

                if (is_read) {
                    object.read_by = {
                        username: element.read_by,
                        name: element.reader_name,
                        mobile: `${element.reader_country_code}${element.reader_mobile}`,
                        email: element.reader_email,
                        status: element.reader_status == "1" ? true : false,
                    };
                }
            }

            if (status == "failed") {
                object.failed_reason = failed_reason;
            }

            if (message_type == "image") {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path);
                object.media_name = file_name;
            }
            if (message_type == "document") {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path);
                object.media_name = file_name;
            }
            if (message_type == "video") {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path);
                object.media_name = file_name;
            }
            if (message_type == "audio") {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path);
                object.media_name = file_name;
                object.is_voice = is_voice;
            }
            if (message_type == "location") {
                object.address = location_address;
                object.latitude = latitude;
                object.longitude = longitude;
                object.name = location_name;
            }

            if (message_type == "template") {
                const storedTemplate = await loadTemplateFromDb(project_id, template_id);
                const template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);
                const parsedComponent = parseMessageComponent(component);

                object.template = template;
                object.component = parsedComponent;

                if (!message || !String(message).trim()) {
                    object.message = buildTemplateDisplayMessage(template, parsedComponent);
                }
            }

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

                        const reply_is_template = reply_element.is_template == "1" ? true : false;
                        const reply_is_forwarded = reply_element.is_forwarded == "1" ? true : false;
                        const reply_is_reply = reply_element.is_reply == "1" ? true : false;
                        const reply_is_voice = reply_element.is_voice == "1" ? true : false;
                        const reply_is_read = reply_element.is_read == "1" ? true : false;
                        const reply_is_campaign = reply_element.is_campaign == "1" ? true : false;

                        const reply_object = {
                            message_id: reply_element.unique_id,
                            wamid: reply_element.wamid,
                            create_date: reply_element.create_date,
                            type: reply_element.type,
                            message_type: reply_element.message_type,
                            message: reply_element.message,
                            is_template: reply_is_template,
                            is_forwarded: reply_is_forwarded,
                            is_reply: reply_is_reply,
                            status: reply_element.status,
                            id: reply_element.id,
                            is_campaign: reply_is_campaign,
                        };

                        if (reply_element.type == "out") {
                            reply_object.send_by = {
                                username: reply_element.message_by,
                                name: reply_element.sender_name,
                                mobile: `${reply_element.sender_country_code}${reply_element.sender_mobile}`,
                                email: reply_element.sender_email,
                                status: reply_element.sender_status == "1" ? true : false,
                            };

                            if (reply_is_campaign) {
                                reply_object.campaign_id = reply_element.campaign_id;
                            }
                        } else if (reply_element.type == "in") {
                            reply_object.is_read = reply_is_read;

                            if (reply_is_read) {
                                reply_object.read_by = {
                                    username: reply_element.read_by,
                                    name: reply_element.reader_name,
                                    mobile: `${reply_element.reader_country_code}${reply_element.reader_mobile}`,
                                    email: reply_element.reader_email,
                                    status: reply_element.reader_status == "1" ? true : false,
                                };
                            }
                        }

                        if (reply_element.status == "failed") {
                            reply_object.failed_reason = reply_element.failed_reason;
                        }

                        if (reply_element.message_type == "image") {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'image', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == "document") {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'document', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == "video") {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'video', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == "audio") {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'audio', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                            reply_object.is_voice = reply_is_voice;
                        }
                        if (reply_element.message_type == "location") {
                            reply_object.address = reply_element.location_address;
                            reply_object.latitude = reply_element.latitude;
                            reply_object.longitude = reply_element.longitude;
                            reply_object.name = reply_element.location_name;
                        }

                        if (reply_element.message_type == "template") {
                            const reply_stored = await loadTemplateFromDb(project_id, reply_element.template_id);
                            const reply_template = await expandTemplateMediaUrls(project_id, reply_element.template_id, reply_stored);
                            const replyParsedComponent = parseMessageComponent(reply_element.component);

                            reply_object.template = reply_template;
                            reply_object.component = replyParsedComponent;

                            if (!reply_element.message || !String(reply_element.message).trim()) {
                                reply_object.message = buildTemplateDisplayMessage(reply_template, replyParsedComponent);
                            }
                        }

                        object.reply_to_message = reply_object;
                    }
                }
            }

            res_data.push(object);
        }
    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        assigned,
        pagination: {
            limit,
            total,
            last_id,
            has_more: res_data.length === limit,
        },
    });
});

router.post("/mark-as-read", developerMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const number = req.body?.number;

    if (!number) {
        return res.status(400).json({ error: "number is required" });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(400).json({ error: "Failed to get project token" });
    }

    const [message_row] = await pool.query(
        "SELECT * FROM `messages` WHERE number = ? AND project_id = ? AND type = ? ORDER BY id DESC LIMIT 1",
        [number, project_id, "in"]
    );

    if (message_row.length !== 1) {
        return res.status(200).json({ error: false });
    }

    const wamid = message_row[0]?.wamid;

    try {
        await axios.request({
            method: "POST",
            url: "https://backend.aisensy.com/direct-apis/t1/mark-read",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, application/xml",
                Authorization: `Bearer ${project_token}`,
            },
            data: {
                messageId: wamid,
            },
        });

        await pool.query(
            "UPDATE `messages` SET `is_read`=?, `read_by`=? WHERE project_id = ? AND number = ?",
            ["1", username, project_id, number]
        );

        const [[total_unread_count]] = await pool.query(
            "SELECT COUNT(*) AS count FROM `messages` WHERE `project_id` = ? AND `is_read` = ? AND type = 'in'",
            [project_id, "0"]
        );

        await emitToProjectSockets(WsIo, project_id, "total_unread_count", {
            count: Number(total_unread_count?.count) || 0,
            project_id,
        });

        return res.status(200).json({ error: false });
    } catch (error) {
        return res.status(400).json({ error: "Failed to mark as read" });
    }
});

router.post("/send-text-message", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const message = req.body?.message;
    const number = req.body?.number;
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!message || !number) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const checks = await preSendChecks(project_id);
    if (!checks.ok) {
        return res.status(400).json({ error: checks.error });
    }

    const unique_id = RANDOM_STRING(30);
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const assignment = await ensureChatAssigned(connection, project_id, number, username);
        if (!assignment.ok) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({ error: assignment.error });
        }

        await connection.query(
            "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [unique_id, project_id, TIMESTAMP(), username, "out", "text", message, number, "pending", is_reply_value, reply_wamid]
        );

        if (is_reply && reply_wamid) {
            const valid = await validateReplyWamid(connection, project_id, reply_wamid);
            if (!valid) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    error: "Invalid reply_wamid: message not found",
                    message_id: unique_id,
                    status: "failed",
                });
            }
        }

        try {
            const { data } = await sendAisensyMessage(
                checks.project_token,
                withReplyContext(
                    {
                        to: number,
                        type: "text",
                        recipient_type: "individual",
                        text: { body: message },
                    },
                    is_reply,
                    reply_wamid
                )
            );
            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
                error: axiosError?.response?.data?.message || "Failed to send message",
            });
        }

        const [new_row] = await connection.query(
            "SELECT * FROM messages WHERE project_id = ? AND unique_id = ?",
            [project_id, unique_id]
        );
        const new_data = new_row[0];
        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply,
            status: new_data?.status,
            type: "out",
            message_type: "text",
            id: new_data?.id,
            send_by: formatSendBy(send_by_data),
        };

        if (new_data?.status == "failed") {
            return_message.failed_reason = new_data?.failed_reason;
        }
        if (is_reply && reply_wamid) {
            return_message.reply_wamid = reply_wamid;
        }

        await emitChatSocket(connection, project_id, number, return_message);

        await connection.commit();
        connection.release();
        return res.status(200).json(return_message);
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (_) { }
            try {
                connection.release();
            } catch (_) { }
        }
        return res.status(500).json({ error: err?.message || "Transaction failed" });
    }
});

router.post("/send-image-message", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const message = req.body?.message ?? "";
    const number = req.body?.number;
    const image_link = req.body?.image_link;
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!number || !image_link) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const checks = await preSendChecks(project_id);
    if (!checks.ok) {
        return res.status(400).json({ error: checks.error });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'image');
    const file_path = await MOVE_MEDIA(image_link, folder_path);
    if (!file_path) {
        return res.status(400).json({ error: "Failed to retrieve image" });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path);

    const unique_id = RANDOM_STRING(30);
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const assignment = await ensureChatAssigned(connection, project_id, number, username);
        if (!assignment.ok) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({ error: assignment.error });
        }

        await connection.query(
            "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [unique_id, project_id, TIMESTAMP(), username, "out", "image", message, "image", file_path, number, "pending", is_reply_value, reply_wamid]
        );

        if (is_reply && reply_wamid) {
            const valid = await validateReplyWamid(connection, project_id, reply_wamid);
            if (!valid) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    error: "Invalid reply_wamid: message not found",
                    message_id: unique_id,
                    status: "failed",
                });
            }
        }

        try {
            const { data } = await sendAisensyMessage(
                checks.project_token,
                withReplyContext(
                    {
                        to: number,
                        type: "image",
                        image: { caption: message, link: media_link },
                    },
                    is_reply,
                    reply_wamid
                )
            );
            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
                error: axiosError?.response?.data?.message || "Failed to send message",
            });
        }

        const [new_row] = await connection.query(
            "SELECT * FROM messages WHERE project_id = ? AND unique_id = ?",
            [project_id, unique_id]
        );
        const new_data = new_row[0];
        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply,
            status: "pending",
            type: "out",
            message_type: "image",
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path),
            media_name: new_data?.file_name,
            send_by: formatSendBy(send_by_row[0]),
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;

        await emitChatSocket(connection, project_id, number, return_message);

        await connection.commit();
        connection.release();
        return res.status(200).json(return_message);
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (_) { }
            try {
                connection.release();
            } catch (_) { }
        }
        return res.status(500).json({ error: err?.message || "Transaction failed" });
    }
});

router.post("/send-video-message", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const message = req.body?.message ?? "";
    const number = req.body?.number;
    const video_link = req.body?.video_link;
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!number || !video_link) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const checks = await preSendChecks(project_id);
    if (!checks.ok) {
        return res.status(400).json({ error: checks.error });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'video');
    const file_path = await MOVE_MEDIA(video_link, folder_path);
    if (!file_path) {
        return res.status(400).json({ error: "Failed to retrieve video" });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path);

    const unique_id = RANDOM_STRING(30);
    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const assignment = await ensureChatAssigned(connection, project_id, number, username);
        if (!assignment.ok) {
            await connection.rollback();
            connection.release();
            return res.status(403).json({ error: assignment.error });
        }

        await connection.query(
            "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [unique_id, project_id, TIMESTAMP(), username, "out", "video", message, "video", file_path, number, "pending", is_reply_value, reply_wamid]
        );

        if (is_reply && reply_wamid) {
            const valid = await validateReplyWamid(connection, project_id, reply_wamid);
            if (!valid) {
                await connection.rollback();
                connection.release();
                return res.status(400).json({
                    error: "Invalid reply_wamid: message not found",
                    message_id: unique_id,
                    status: "failed",
                });
            }
        }

        try {
            const { data } = await sendAisensyMessage(
                checks.project_token,
                withReplyContext(
                    {
                        to: number,
                        type: "video",
                        video: { caption: message, link: media_link },
                    },
                    is_reply,
                    reply_wamid
                )
            );
            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            await connection.rollback();
            connection.release();
            return res.status(400).json({
                error: axiosError?.response?.data?.message || "Failed to send message",
            });
        }

        const [new_row] = await connection.query(
            "SELECT * FROM messages WHERE project_id = ? AND unique_id = ?",
            [project_id, unique_id]
        );
        const new_data = new_row[0];
        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply,
            status: "pending",
            type: "out",
            message_type: "video",
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path),
            media_name: new_data?.file_name,
            send_by: formatSendBy(send_by_row[0]),
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;

        await emitChatSocket(connection, project_id, number, return_message);

        await connection.commit();
        connection.release();
        return res.status(200).json(return_message);
    } catch (err) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (_) { }
            try {
                connection.release();
            } catch (_) { }
        }
        return res.status(500).json({ error: err?.message || "Transaction failed" });
    }
});

router.post("/send-document-message", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const message = req.body?.message ?? "";
    const number = req.body?.number;
    const document_link = req.body?.document_link;
    const document_name = req.body?.document_name || "Document";
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!number || !document_link) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const checks = await preSendChecks(project_id);
    if (!checks.ok) {
        return res.status(400).json({ error: checks.error });
    }

    const assignment = await ensureChatAssigned(pool, project_id, number, username);
    if (!assignment.ok) {
        return res.status(403).json({ error: assignment.error });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'document');
    const file_path = await MOVE_MEDIA(document_link, folder_path);
    if (!file_path) {
        return res.status(400).json({ error: "Failed to retrieve document" });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path);

    const unique_id = RANDOM_STRING(30);
    await pool.query(
        "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [unique_id, project_id, TIMESTAMP(), username, "out", "document", message, document_name, file_path, number, "pending", is_reply_value, reply_wamid]
    );

    if (is_reply && reply_wamid) {
        const valid = await validateReplyWamid(pool, project_id, reply_wamid);
        if (!valid) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", [
                "failed",
                "Invalid reply_wamid: message not found",
                unique_id,
            ]);
            return res.status(400).json({
                error: "Invalid reply_wamid: message not found",
                message_id: unique_id,
                status: "failed",
            });
        }
    }

    try {
        const { data } = await sendAisensyMessage(
            checks.project_token,
            withReplyContext(
                {
                    to: number,
                    type: "document",
                    document: {
                        caption: message,
                        link: media_link,
                        filename: document_name,
                    },
                },
                is_reply,
                reply_wamid
            )
        );

        const wamid = data?.messages[0]?.id;
        await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);

        const [new_row] = await pool.query(
            "SELECT * FROM messages WHERE project_id = ? AND unique_id = ?",
            [project_id, unique_id]
        );
        const new_data = new_row[0];
        const [send_by_row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);

        const return_message = {
            wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply,
            status: "pending",
            type: "out",
            message_type: "document",
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path),
            media_name: new_data?.file_name,
            send_by: formatSendBy(send_by_row[0]),
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;

        await emitChatSocket(pool, project_id, number, return_message);
        return res.status(200).json(return_message);
    } catch (error) {
        return res.status(400).json({ error: error?.response?.data?.message || "Failed to send message" });
    }
});

router.post("/send-audio-message", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const number = req.body?.number;
    const audio_link = req.body?.audio_link;
    const is_voice = req.body?.is_voice === true || req.body?.is_voice === "true" ? "1" : "0";
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!number || !audio_link) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const checks = await preSendChecks(project_id);
    if (!checks.ok) {
        return res.status(400).json({ error: checks.error });
    }

    const assignment = await ensureChatAssigned(pool, project_id, number, username);
    if (!assignment.ok) {
        return res.status(403).json({ error: assignment.error });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'audio');
    const file_path = await MOVE_MEDIA(audio_link, folder_path);
    if (!file_path) {
        return res.status(400).json({ error: "Failed to retrieve audio" });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path);

    const unique_id = RANDOM_STRING(30);
    await pool.query(
        "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `file_name`, `file_path`, `number`, `status`, `is_voice`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [unique_id, project_id, TIMESTAMP(), username, "out", "audio", "audio", file_path, number, "pending", is_voice, is_reply_value, reply_wamid]
    );

    if (is_reply && reply_wamid) {
        const valid = await validateReplyWamid(pool, project_id, reply_wamid);
        if (!valid) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", [
                "failed",
                "Invalid reply_wamid: message not found",
                unique_id,
            ]);
            return res.status(400).json({
                error: "Invalid reply_wamid: message not found",
                message_id: unique_id,
                status: "failed",
            });
        }
    }

    try {
        const { data } = await sendAisensyMessage(
            checks.project_token,
            withReplyContext(
                {
                    to: number,
                    type: "audio",
                    audio: { link: media_link },
                },
                is_reply,
                reply_wamid
            )
        );

        const wamid = data?.messages[0]?.id;
        await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);

        const [new_row] = await pool.query(
            "SELECT * FROM messages WHERE project_id = ? AND unique_id = ?",
            [project_id, unique_id]
        );
        const new_data = new_row[0];
        const [send_by_row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);

        const return_message = {
            wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply,
            status: "pending",
            type: "out",
            message_type: "audio",
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path),
            media_name: new_data?.file_name,
            is_voice: new_data?.is_voice == "1",
            send_by: formatSendBy(send_by_row[0]),
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;

        await emitChatSocket(pool, project_id, number, return_message);
        return res.status(200).json(return_message);
    } catch (error) {
        return res.status(400).json({ error: "Failed to send message" });
    }
});

router.post("/send-template", developerSendMessageAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id, username } = ctx;
    const number = req.body?.number;
    const template_id = req.body?.template_id;
    const component = req.body?.component;
    const { is_reply, reply_wamid, is_reply_value } = parseReplyFields(req.body);

    if (!number || !template_id || !component) {
        return res.status(400).json({ error: "Provide all mandatory fields" });
    }

    const replyError = validateReplyInput(is_reply, reply_wamid);
    if (replyError) {
        return res.status(400).json({ error: replyError });
    }

    const [template_row] = await pool.query(
        "SELECT * FROM templates WHERE project_id = ? AND template_id = ? AND status = ?",
        [project_id, template_id, "APPROVED"]
    );

    if (template_row.length === 0) {
        return res.status(400).json({ error: "Invalid template ID" });
    }

    const template_data = template_row[0];
    const template_name = template_data?.template_name;
    const language_code = template_data?.language_code;
    const category = template_data?.category;

    const BALANCE = await GET_BALANCE(project_id);
    const project_data = await AISENSY_PROJECT_DATA(project_id);
    const marketing_charge = project_data?.marketing_charge;
    const utility_charge = project_data?.utility_charge;
    const authentication_charge = project_data?.authentication_charge;

    if (category == "MARKETING") {
        if (BALANCE < marketing_charge) {
            return res.status(400).json({ error: "Please topup wallet before sending marketing template" });
        }
    } else if (category == "UTILITY") {
        if (BALANCE < utility_charge) {
            return res.status(400).json({ error: "Please topup wallet before sending utility template" });
        }
    } else if (category == "AUTHENTICATION") {
        if (BALANCE < authentication_charge) {
            return res.status(400).json({ error: "Please topup wallet before sending authentication template" });
        }
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(400).json({ error: "Failed to get project token" });
    }

    const unique_id = RANDOM_STRING(30);
    const component_string = JSON.stringify(component);
    await pool.query(
        "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `is_template`, `template_id`, `component`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [unique_id, project_id, TIMESTAMP(), username, "out", "template", "1", template_id, component_string, number, "pending", is_reply_value, reply_wamid]
    );

    if (is_reply && reply_wamid) {
        const valid = await validateReplyWamid(pool, project_id, reply_wamid);
        if (!valid) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", [
                "failed",
                "Invalid reply_wamid: message not found",
                unique_id,
            ]);
            return res.status(400).json({
                error: "Invalid reply_wamid: message not found",
                message_id: unique_id,
                status: "failed",
            });
        }
    }

    const templatePayload = {
        name: template_name,
        language: { code: language_code },
        components: component,
    };

    try {
        const { data } = await sendAisensyMessage(
            project_token,
            withReplyContext(
                {
                    to: number,
                    type: "template",
                    template: templatePayload,
                },
                is_reply,
                reply_wamid
            )
        );

        const wamid = data?.messages[0]?.id;
        const message_status = data?.messages[0]?.message_status;

        if (message_status == "accepted") {
            await pool.query("UPDATE `messages` SET `wamid` = ?, status = ? WHERE `unique_id` = ?", [
                wamid,
                "sent",
                unique_id,
            ]);

            const [new_data] = await pool.query("SELECT * FROM messages WHERE unique_id = ?", [unique_id]);
            const [message_by_data] = await pool.query("SELECT * FROM users WHERE username = ?", [
                new_data[0]?.message_by,
            ]);

            const storedTemplate = await loadTemplateFromDb(project_id, template_id);
            const templateJson = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);

            const return_message = {
                message_id: new_data[0]?.unique_id,
                wamid: new_data[0]?.wamid,
                create_date: new_data[0]?.create_date,
                type: new_data[0]?.type,
                message_type: new_data[0]?.message_type,
                message: buildTemplateDisplayMessage(templateJson, component),
                is_template: true,
                is_forwarded: false,
                is_reply,
                status: new_data[0]?.status,
                id: new_data[0]?.id,
                send_by: {
                    username: message_by_data[0]?.username,
                    name: message_by_data[0]?.name,
                    mobile: message_by_data[0]?.mobile,
                    email: message_by_data[0]?.email,
                    status: message_by_data[0]?.status == "1",
                },
                template: templateJson,
                component,
            };

            if (is_reply && reply_wamid) {
                return_message.reply_wamid = reply_wamid;
            }

            await emitChatSocket(pool, project_id, number, return_message, { templateContact: true });
            return res.status(200).json(return_message);
        }

        await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        return res.status(400).json({ error: "Failed to send message", wamid });
    } catch (error) {
        if (error.response) {
            return res.status(400).json({ error: error?.response?.error_data?.details || "Failed to send template" });
        }
        return res.status(400).json({ error: "Failed to send template" });
    }
});


export default router;