import express from "express";
import pool from "../db.js";
import { auth, CheckProjectValidity, CheckUserProjectMaping } from "../middleware/auth.js";
import { AISENSY_PROJECT_DATA, GET_BALANCE, GetAiSensyProjectToken, GET_CHAT_MEDIA_KEY_PREFIX, GET_CHAT_MEDIA_URL, MOVE_MEDIA, RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP, auditUserRecord } from "../helpers/function.js";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Decrypt } from "../helpers/Decrypt.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { WsIo } from "../server.js";
import moment from "moment";
import {
    buildTemplateDisplayMessage,
    expandTemplateMediaUrls,
    loadTemplateFromDb,
    parseMessageComponent,
} from "../helpers/templateStorage.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



router.post("/chat-list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    var page_no = Number(decrypt.page_no || 1);

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const limit = 100;
    const offset = (page_no - 1) * limit;

    var [rows] = await pool.query("SELECT m.*, contacts.name, CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc WHERE fc.project_id = m.project_id AND fc.number = m.number AND fc.username = ? AND fc.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite, (SELECT COUNT(*) FROM cases c WHERE c.project_id = m.project_id AND c.number = m.number AND c.status = '0') AS case_open_count, COUNT(CASE WHEN m2.type = 'in' AND m2.is_read = '0' THEN 1 END) AS unread_count FROM messages m INNER JOIN (SELECT project_id, number, MAX(id) AS last_id FROM messages GROUP BY project_id, number) AS last_msg ON m.project_id = last_msg.project_id AND m.number = last_msg.number AND m.id = last_msg.last_id LEFT JOIN contacts ON contacts.number = m.number AND contacts.project_id = m.project_id AND contacts.is_deleted = '0' LEFT JOIN messages m2 ON m2.number = m.number AND m2.project_id = m.project_id AND m2.type = 'in' AND m2.is_read = '0' WHERE m.project_id = ? GROUP BY m.id, contacts.name ORDER BY last_msg.last_id DESC LIMIT ?, ?", [username, project_id, offset, limit]);


    const res_data = [];

    if (rows.length > 0) {
        rows.forEach((element) => {
            var last_id = element.id
            var unique_id = element.unique_id;
            var number = element.number;
            var wamid = element.wamid;
            var message = element.message;
            var create_date = element.create_date;
            var type = element.type;
            var message_type = element.message_type;
            var status = element.status;
            var failed_reason = element.failed_reason;
            var name = element.name;
            var is_favorite = element.is_favorite == 'yes' ? true : false;
            var case_open_count = Number(element.case_open_count) || 0;
            var unread_count = element.unread_count;

            var object = {
                contact: {
                    number,
                    name,
                    is_favorite
                },
                case_open_count,
                last_message: {
                    id: last_id,
                    wamid,
                    create_date,
                    type,
                    message_type,
                    message,
                    status,
                    unique_id
                },
                unread_count
            };



            if (status == 'failed') {
                object.failed_reason = failed_reason;
            }

            res_data.push(object);

        });

    }


    return res.status(200).json({
        data: res_data,
        page_no,
        count: res_data.length
    });
});

const FetchAssigned = async ({ number, project_id, username }) => {

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
            ['0', project_id, '1']
        )
    ]);

    const [assignments] = assignmentResult;
    const [usersRows] = usersResult;

    var users = usersRows.map(user => ({
        username: user.username,
        name: user.name,
        mobile: user.mobile,
        email: user.email,
        type: user.type === 'admin' ? 'admin' : 'agent',
        is_me: user.username === username
    }));


    if (assignments.length == 0) {
        return {
            assigned: false,
            users
        };
    }


    const assignment = assignments[0];
    const isAssignedToMe = assignment.username == username;

    const assignedUserData = await USER_DATA(assignment.username);

    return {
        assigned: true,
        assigned_to_me: isAssignedToMe,
        assigned_user: {
            name: assignedUserData?.name,
            mobile: assignedUserData?.mobile,
            email: assignedUserData?.email,
            status: assignedUserData?.status === '1',
            username: assignedUserData?.username,
        },
        users
    };
}

router.post("/chat-history", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    var last_id = Number(decrypt.last_id);
    const number = decrypt.number;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    if (last_id == 0) {
        var [rows] = await pool.query(
            "SELECT messages.*,users.name AS sender_name,users.email AS sender_email,users.country_code AS sender_country_code, users.mobile AS sender_mobile,users.status AS sender_status,reader.name AS reader_name,reader.email AS reader_email,reader.country_code AS reader_country_code, reader.mobile AS reader_mobile,reader.status AS reader_status FROM messages LEFT JOIN users ON users.username = messages.message_by LEFT JOIN users reader ON reader.username = messages.read_by LEFT JOIN contacts ON contacts.number = messages.number AND contacts.project_id = messages.project_id AND contacts.is_deleted = '0' WHERE messages.project_id = ? AND messages.number = ? ORDER BY messages.id DESC LIMIT 100",
            [project_id, number]
        );
    } else {
        var [rows] = await pool.query(
            "SELECT messages.*,users.name AS sender_name,users.email AS sender_email,users.country_code AS sender_country_code, users.mobile AS sender_mobile,users.status AS sender_status,reader.name AS reader_name,reader.email AS reader_email,reader.country_code AS reader_country_code, reader.mobile AS reader_mobile,reader.status AS reader_status FROM messages LEFT JOIN users ON users.username = messages.message_by LEFT JOIN users reader ON reader.username = messages.read_by LEFT JOIN contacts ON contacts.number = messages.number AND contacts.project_id = messages.project_id AND contacts.is_deleted = '0' WHERE messages.project_id = ? AND messages.number = ? AND messages.id < ? ORDER BY messages.id DESC LIMIT 100",
            [project_id, number, last_id]
        );
    }

    const res_data = [];

    if (rows.length > 0) {
        for (const element of rows) {
            last_id = element.id
            var unique_id = element.unique_id;
            var wamid = element.wamid;
            var create_date = element.create_date;
            var type = element.type;
            var message_type = element.message_type;
            var message = element.message;
            var file_name = element.file_name;
            var file_path = element.file_path;
            var failed_reason = element.failed_reason;
            var is_template = element.is_template;
            var is_forwarded = element.is_forwarded;
            var is_reply = element.is_reply;
            var is_voice = element.is_voice;
            var status = element.status;
            var location_address = element.location_address;
            var latitude = element.latitude;
            var longitude = element.longitude;
            var location_name = element.location_name;
            var is_read = element.is_read;
            var read_by = element.read_by;
            var component = element.component;
            var template_id = element.template_id;
            var is_campaign = element.is_campaign;
            var campaign_id = element.campaign_id;

            var is_template = is_template == '1' ? true : false;
            var is_forwarded = is_forwarded == '1' ? true : false;
            var is_reply = is_reply == '1' ? true : false;
            var is_voice = is_voice == '1' ? true : false;
            var is_read = is_read == '1' ? true : false;
            var is_campaign = is_campaign == '1' ? true : false;

            var object = {
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
                is_campaign
            };

            if (type == 'out') {
                var send_by = {
                    username: element.message_by,
                    name: element.sender_name,
                    mobile: `${element.sender_country_code}${element.sender_mobile}`,
                    email: element.sender_email,
                    status: element.sender_status == '1' ? true : false,
                };

                object.send_by = send_by;

                if (is_campaign) {
                    object.campaign_id = campaign_id;
                }
            } else if (type == 'in') {
                object.is_read = is_read;

                if (is_read) {
                    var read_by = {
                        username: element.read_by,
                        name: element.reader_name,
                        mobile: `${element.reader_country_code}${element.reader_mobile}`,
                        email: element.reader_email,
                        status: element.reader_status == '1' ? true : false,
                    };
                    object.read_by = read_by;
                }
            }

            if (status == 'failed') {
                object.failed_reason = failed_reason;
            }

            if (message_type == 'image') {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path);
                object.media_name = file_name;
            }
            if (message_type == 'document') {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path);
                object.media_name = file_name;
            }
            if (message_type == 'video') {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path);
                object.media_name = file_name;
            }
            if (message_type == 'audio') {
                object.media_url = await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path);
                object.media_name = file_name;
                object.is_voice = is_voice;
            }
            if (message_type == 'location') {
                object.address = location_address;
                object.latitude = latitude;
                object.longitude = longitude;
                object.name = location_name;
            }

            if (message_type == 'template') {
                var storedTemplate = await loadTemplateFromDb(project_id, template_id);
                var template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);
                const parsedComponent = parseMessageComponent(component);

                object.template = template;
                object.component = parsedComponent;

                if (!message || !String(message).trim()) {
                    object.message = buildTemplateDisplayMessage(template, parsedComponent);
                }
            }

            if (is_reply) {
                object.reply_wamid = element.reply_wamid;

                // Fetch the replied message using reply_wamid
                if (element.reply_wamid) {
                    const [reply_rows] = await pool.query(
                        "SELECT messages.*,users.name AS sender_name,users.email AS sender_email,users.country_code AS sender_country_code, users.mobile AS sender_mobile,users.status AS sender_status,reader.name AS reader_name,reader.email AS reader_email,reader.country_code AS reader_country_code, reader.mobile AS reader_mobile,reader.status AS reader_status FROM messages LEFT JOIN users ON users.username = messages.message_by LEFT JOIN users reader ON reader.username = messages.read_by WHERE messages.project_id = ? AND messages.wamid = ? LIMIT 1",
                        [project_id, element.reply_wamid]
                    );

                    if (reply_rows.length > 0) {
                        const reply_element = reply_rows[0];
                        const reply_number = reply_element.number;

                        var reply_is_template = reply_element.is_template == '1' ? true : false;
                        var reply_is_forwarded = reply_element.is_forwarded == '1' ? true : false;
                        var reply_is_reply = reply_element.is_reply == '1' ? true : false;
                        var reply_is_voice = reply_element.is_voice == '1' ? true : false;
                        var reply_is_read = reply_element.is_read == '1' ? true : false;
                        var reply_is_campaign = reply_element.is_campaign == '1' ? true : false;

                        var reply_object = {
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
                            is_campaign: reply_is_campaign
                        };

                        if (reply_element.type == 'out') {
                            var reply_send_by = {
                                username: reply_element.message_by,
                                name: reply_element.sender_name,
                                mobile: `${reply_element.sender_country_code}${reply_element.sender_mobile}`,
                                email: reply_element.sender_email,
                                status: reply_element.sender_status == '1' ? true : false,
                            };
                            reply_object.send_by = reply_send_by;

                            if (reply_is_campaign) {
                                reply_object.campaign_id = reply_element.campaign_id;
                            }
                        } else if (reply_element.type == 'in') {
                            reply_object.is_read = reply_is_read;

                            if (reply_is_read) {
                                var reply_read_by = {
                                    username: reply_element.read_by,
                                    name: reply_element.reader_name,
                                    mobile: `${reply_element.reader_country_code}${reply_element.reader_mobile}`,
                                    email: reply_element.reader_email,
                                    status: reply_element.reader_status == '1' ? true : false,
                                };
                                reply_object.read_by = reply_read_by;
                            }
                        }

                        if (reply_element.status == 'failed') {
                            reply_object.failed_reason = reply_element.failed_reason;
                        }

                        if (reply_element.message_type == 'image') {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'image', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == 'document') {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'document', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == 'video') {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'video', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                        }
                        if (reply_element.message_type == 'audio') {
                            reply_object.media_url = await GET_CHAT_MEDIA_URL(project_id, reply_number, 'audio', reply_element.file_path);
                            reply_object.media_name = reply_element.file_name;
                            reply_object.is_voice = reply_is_voice;
                        }
                        if (reply_element.message_type == 'location') {
                            reply_object.address = reply_element.location_address;
                            reply_object.latitude = reply_element.latitude;
                            reply_object.longitude = reply_element.longitude;
                            reply_object.name = reply_element.location_name;
                        }

                        if (reply_element.message_type == 'template') {
                            var reply_stored = await loadTemplateFromDb(project_id, reply_element.template_id);
                            var reply_template = await expandTemplateMediaUrls(project_id, reply_element.template_id, reply_stored);
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


    // START
    const assigning = await FetchAssigned({ number, project_id, username });

    return res.status(200).json({
        data: res_data,
        last_id,
        count: res_data.length,
        assigning
    });
});

router.post("/check-chat-window", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const number = decrypt?.number;

    if (!project_id || !number) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }


    const now = moment();
    const past24h = now.clone().subtract(24, "hours");
    const formattedPast24h = past24h.format("YYYY-MM-DD HH:mm:ss");

    const [message_row] = await pool.query("SELECT * FROM `messages` WHERE project_id = ? AND number = ? AND status = ? AND (create_date BETWEEN ? AND ?) ORDER BY id DESC LIMIT 1", [project_id, number, 'received', formattedPast24h, TIMESTAMP()]);

    if (message_row.length == 0) {
        return res.status(200).json({ error: false, status: false });
    }

    return res.status(200).json({
        error: false,
        status: true,
        last_received: message_row[0]?.create_date
    })


});

router.post("/send-text-message", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const message = decrypt.message;
    const number = decrypt.number;
    const is_reply = decrypt.is_reply || false;
    const reply_wamid = decrypt.reply_wamid || null;

    if (!project_id || !message || !number || !message) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);

    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_validity = await CheckProjectValidity(project_id);

    if (!project_validity) {
        return res.status(200).json({ error: 'Project subscription is expired' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const unique_id = RANDOM_STRING(30);
    const is_reply_value = is_reply ? '1' : '0';

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [check_assigned] = await connection.query("SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1", [project_id, number]);

        if (check_assigned.length === 0) {
            await connection.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);

            // SOCKET START
            const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {

                const assigning = await FetchAssigned({ number, project_id, username });

                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", {
                        assigning
                    });
                }

            }
            // SOCKET END

        } else {
            const assigned_data = check_assigned[0];
            const assigned_user = assigned_data?.username;
            if (assigned_user !== username) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({ error: 'You are not assigned to this number' })
            }
        }

        await connection.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'text', message, number, 'pending', is_reply_value, reply_wamid]);


        // Validate reply_wamid if is_reply is true
        if (is_reply && reply_wamid) {
            const [reply_check] = await connection.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
            if (reply_check.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({
                    error: 'Invalid reply_wamid: message not found',
                    message_id: unique_id,
                    status: 'failed'
                });
            }
        }

        // Send via API inside transaction; only commit if send succeeds; rollback on failure
        const options = {
            method: 'POST',
            url: 'https://backend.aisensy.com/direct-apis/t1/messages',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, application/xml',
                Authorization: `Bearer ${project_token}`
            },
            data: {
                to: number,
                type: 'text',
                recipient_type: 'individual',
                text: { body: message },
                ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
            }
        };

        try {
            const { data } = await axios.request(options);

            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            console.log(axiosError);
            await connection.rollback();
            connection.release();
            connection = null;
            return res.status(200).json({ error: axiosError?.response?.data?.message || "Failed to send message" });
        }

        const [new_row] = await connection.query("SELECT * FROM messages WHERE project_id = ?  AND unique_id = ?", [project_id, unique_id]);
        const new_data = new_row[0];

        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];

        const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        const [contact_row] = await connection.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
        let name = null;
        if (contact_row.length > 0) {
            name = contact_row[0]?.name;
        }

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply: is_reply,
            status: new_data?.status,
            type: 'out',
            message_type: 'text',
            id: new_data?.id,
            send_by: {
                username: send_by_data?.username,
                name: send_by_data?.name,
                mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
                email: send_by_data?.email,
                status: send_by_data?.status == '1' ? true : false,
            }
        };

        if (new_data?.status == 'failed') {
            return_message.failed_reason = new_data?.failed_reason;
        }

        if (is_reply && reply_wamid) {
            return_message.reply_wamid = reply_wamid;
        }

        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                const room = roomObj?.username;
                WsIo.to(room).emit("chat", {
                    message: return_message,
                    project_id,
                    contact: {
                        number,
                        name
                    }
                });
            }
        }

        await connection.commit();
        connection.release();
        connection = null;
        return res.status(200).json(return_message);

    } catch (err) {
        if (connection) {
            try { await connection.rollback(); } catch (_) { }
            try { connection.release(); } catch (_) { }
            connection = null;
        }
        return res.status(200).json({ error: err?.message || 'Transaction failed' });
    }
});

router.post("/send-image-message", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const message = decrypt?.message;
    const number = decrypt?.number;
    const image_link = decrypt?.image_link;
    const is_reply = decrypt?.is_reply || false;
    const reply_wamid = decrypt?.reply_wamid || null;

    if (!project_id || !number || !image_link) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_validity = await CheckProjectValidity(project_id);

    if (!project_validity) {
        return res.status(200).json({ error: 'Project subscription is expired' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'image');
    const file_path = await MOVE_MEDIA(image_link, folder_path);

    if (!file_path) {
        return res.status(200).json({ error: 'Failed to retrive image' });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path);

    const unique_id = RANDOM_STRING(30);
    const is_reply_value = is_reply ? '1' : '0';

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [check_assigned] = await connection.query("SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1", [project_id, number]);

        if (check_assigned.length === 0) {
            await connection.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);
            const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {
                const assigning = await FetchAssigned({ number, project_id, username });
                for (const roomObj of room_row) {
                    const room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", { assigning });
                }
            }
        } else {
            const assigned_data = check_assigned[0];
            const assigned_user = assigned_data?.username;
            if (assigned_user !== username) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({ error: 'You are not assigned to this number' })
            }
        }

        await connection.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'image', message, 'image', file_path, number, 'pending', is_reply_value, reply_wamid]);

        if (is_reply && reply_wamid) {
            const [reply_check] = await connection.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
            if (reply_check.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({
                    error: 'Invalid reply_wamid: message not found',
                    message_id: unique_id,
                    status: 'failed'
                });
            }
        }

        const options = {
            method: 'POST',
            url: 'https://backend.aisensy.com/direct-apis/t1/messages',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, application/xml',
                Authorization: `Bearer ${project_token}`
            },
            data: {
                to: number,
                type: 'image',
                image: { caption: message, link: media_link },
                ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
            }
        };

        try {
            const { data } = await axios.request(options);
            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            await connection.rollback();
            connection.release();
            connection = null;
            return res.status(200).json({ error: axiosError?.response?.data?.message || "Failed to send message" });
        }

        const [new_row] = await connection.query("SELECT * FROM messages WHERE project_id = ?  AND unique_id = ?", [project_id, unique_id]);
        const new_data = new_row[0];
        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];
        const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        const [contact_row] = await connection.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
        let name = contact_row.length > 0 ? contact_row[0]?.name : null;

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply: is_reply,
            status: 'pending',
            type: 'out',
            message_type: 'image',
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'image', file_path),
            media_name: new_data?.file_name,
            send_by: {
                username: send_by_data?.username,
                name: send_by_data?.name,
                mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
                email: send_by_data?.email,
                status: send_by_data?.status == '1' ? true : false,
            }
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;
        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                WsIo.to(roomObj?.username).emit("chat", { message: return_message, project_id, contact: { number, name } });
            }
        }

        await connection.commit();
        connection.release();
        connection = null;
        return res.status(200).json(return_message);

    } catch (err) {
        if (connection) {
            try { await connection.rollback(); } catch (_) { }
            try { connection.release(); } catch (_) { }
            connection = null;
        }
        return res.status(200).json({ error: err?.message || 'Transaction failed' });
    }
});

router.post("/send-video-message", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const message = decrypt?.message;
    const number = decrypt?.number;
    const video_link = decrypt?.video_link;
    const is_reply = decrypt?.is_reply || false;
    const reply_wamid = decrypt?.reply_wamid || null;

    if (!project_id || !number || !video_link) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_validity = await CheckProjectValidity(project_id);
    if (!project_validity) {
        return res.status(200).json({ error: 'Project subscription is expired' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'video');
    const file_path = await MOVE_MEDIA(video_link, folder_path);

    if (!file_path) {
        return res.status(200).json({ error: 'Failed to retrive video' });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path);

    const unique_id = RANDOM_STRING(30);
    const is_reply_value = is_reply ? '1' : '0';

    let connection;
    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [check_assigned] = await connection.query("SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1", [project_id, number]);

        if (check_assigned.length === 0) {
            await connection.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);
            const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {
                const assigning = await FetchAssigned({ number, project_id, username });
                for (const roomObj of room_row) {
                    const room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", { assigning });
                }
            }
        } else {
            const assigned_data = check_assigned[0];
            const assigned_user = assigned_data?.username;
            if (assigned_user !== username) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({ error: 'You are not assigned to this number' })
            }
        }

        await connection.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'video', message, 'video', file_path, number, 'pending', is_reply_value, reply_wamid]);

        if (is_reply && reply_wamid) {
            const [reply_check] = await connection.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
            if (reply_check.length === 0) {
                await connection.rollback();
                connection.release();
                return res.status(200).json({
                    error: 'Invalid reply_wamid: message not found',
                    message_id: unique_id,
                    status: 'failed'
                });
            }
        }

        const options = {
            method: 'POST',
            url: 'https://backend.aisensy.com/direct-apis/t1/messages',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, application/xml',
                Authorization: `Bearer ${project_token}`
            },
            data: {
                to: number,
                type: 'video',
                video: { caption: message, link: media_link },
                ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
            }
        };

        try {
            const { data } = await axios.request(options);
            const wamid = data?.messages[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (axiosError) {
            await connection.rollback();
            connection.release();
            connection = null;
            return res.status(200).json({ error: axiosError?.response?.data?.message || "Failed to send message" });
        }

        const [new_row] = await connection.query("SELECT * FROM messages WHERE project_id = ?  AND unique_id = ?", [project_id, unique_id]);
        const new_data = new_row[0];
        const [send_by_row] = await connection.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];
        const [room_row] = await connection.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        const [contact_row] = await connection.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
        let name = contact_row.length > 0 ? contact_row[0]?.name : null;

        const return_message = {
            wamid: new_data?.wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply: is_reply,
            status: 'pending',
            type: 'out',
            message_type: 'video',
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'video', file_path),
            media_name: new_data?.file_name,
            send_by: {
                username: send_by_data?.username,
                name: send_by_data?.name,
                mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
                email: send_by_data?.email,
                status: send_by_data?.status == '1' ? true : false,
            }
        };
        if (is_reply && reply_wamid) return_message.reply_wamid = reply_wamid;
        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                WsIo.to(roomObj?.username).emit("chat", { message: return_message, project_id, contact: { number, name } });
            }
        }

        await connection.commit();
        connection.release();
        connection = null;
        return res.status(200).json(return_message);

    } catch (err) {
        if (connection) {
            try { await connection.rollback(); } catch (_) { }
            try { connection.release(); } catch (_) { }
            connection = null;
        }
        return res.status(200).json({ error: err?.message || 'Transaction failed' });
    }
});

router.post("/send-document-message", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const message = decrypt?.message;
    const number = decrypt?.number;
    const document_link = decrypt?.document_link;
    const document_name = decrypt?.document_name || 'Document';
    const is_reply = decrypt?.is_reply || false;
    const reply_wamid = decrypt?.reply_wamid || null;

    if (!project_id || !number || !document_link) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_validity = await CheckProjectValidity(project_id);

    if (!project_validity) {
        return res.status(200).json({ error: 'Project subscription is expired' })
    }

    const [check_assigned] = await pool.query("SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1", [project_id, number]);

    if (check_assigned.length === 0) {
        await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);

        // SOCKET START
        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        if (room_row.length > 0) {

            const assigning = await FetchAssigned({ number, project_id, username });

            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("chat_assigned", {
                    assigning
                });
            }

        }
        // SOCKET END
    } else {
        const assigned_data = check_assigned[0];
        const assigned_user = assigned_data?.username;
        if (assigned_user !== username) {
            return res.status(200).json({ error: 'You are not assigned to this number' })
        }
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'document');
    const file_path = await MOVE_MEDIA(document_link, folder_path);

    if (!file_path) {
        return res.status(200).json({ error: 'Failed to retrive document' });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path);

    const unique_id = RANDOM_STRING(30);
    const is_reply_value = is_reply ? '1' : '0';
    await pool.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `file_name`, `file_path`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'document', message, document_name, file_path, number, 'pending', is_reply_value, reply_wamid]);

    // Validate reply_wamid if is_reply is true
    if (is_reply && reply_wamid) {
        const [reply_check] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
        if (reply_check.length === 0) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", ['failed', 'Invalid reply_wamid: message not found', unique_id]);
            return res.status(200).json({
                error: 'Invalid reply_wamid: message not found',
                message_id: unique_id,
                status: 'failed'
            });
        }
    }

    const options = {
        method: 'POST',
        url: 'https://backend.aisensy.com/direct-apis/t1/messages',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/xml',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            to: number,
            type: 'document',
            document: {
                caption: message,
                link: media_link,
                filename: document_name
            },
            ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
        }
    };

    try {
        const { data } = await axios.request(options);

        const wamid = data?.messages[0]?.id;

        await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id])

        const [new_row] = await pool.query("SELECT * FROM messages WHERE project_id = ?  AND unique_id = ?", [project_id, unique_id]);
        const new_data = new_row[0];

        const [send_by_row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];


        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        const [contact_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
        if (contact_row.length > 0) {
            var name = contact_row[0]?.name;
        } else {
            var name = null;
        }


        const return_message = {
            wamid: wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply: is_reply,
            status: 'pending',
            type: 'out',
            message_type: 'document',
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'document', file_path),
            media_name: new_data?.file_name,
            send_by: {
                username: send_by_data?.username,
                name: send_by_data?.name,
                mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
                email: send_by_data?.email,
                status: send_by_data?.status == '1' ? true : false,
            }
        };

        if (is_reply && reply_wamid) {
            return_message.reply_wamid = reply_wamid;
        }

        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("chat", {
                    message: return_message,
                    project_id,
                    contact: {
                        number,
                        name
                    }
                });
            }

        }

        return res.status(200).json(return_message);
    } catch (error) {
        return res.status(200).json({ error: error?.response?.data?.message || "Failed to send message" });
    }
});

router.post("/send-audio-message", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const number = decrypt?.number;
    const audio_link = decrypt?.audio_link;
    var is_voice = decrypt?.is_voice;
    const is_reply = decrypt?.is_reply || false;
    const reply_wamid = decrypt?.reply_wamid || null;

    if (is_voice) {
        is_voice = '1';
    } else {
        is_voice = '0';
    }

    if (!project_id || !number || !audio_link) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_validity = await CheckProjectValidity(project_id);

    if (!project_validity) {
        return res.status(200).json({ error: 'Project subscription is expired' })
    }

    const [check_assigned] = await pool.query("SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1", [project_id, number]);

    if (check_assigned.length === 0) {
        await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);

        // SOCKET START
        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        if (room_row.length > 0) {

            const assigning = await FetchAssigned({ number, project_id, username });

            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("chat_assigned", {
                    assigning
                });
            }

        }
        // SOCKET END
    } else {
        const assigned_data = check_assigned[0];
        const assigned_user = assigned_data?.username;
        if (assigned_user !== username) {
            return res.status(200).json({ error: 'You are not assigned to this number' })
        }
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const folder_path = GET_CHAT_MEDIA_KEY_PREFIX(project_id, number, 'audio');
    const file_path = await MOVE_MEDIA(audio_link, folder_path);

    if (!file_path) {
        return res.status(200).json({ error: 'Failed to retrive audio' });
    }

    const media_link = await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path);

    const unique_id = RANDOM_STRING(30);
    const is_reply_value = is_reply ? '1' : '0';
    await pool.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `file_name`, `file_path`, `number`, `status`,`is_voice`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'audio', 'audio', file_path, number, 'pending', is_voice, is_reply_value, reply_wamid]);

    // Validate reply_wamid if is_reply is true
    if (is_reply && reply_wamid) {
        const [reply_check] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
        if (reply_check.length === 0) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", ['failed', 'Invalid reply_wamid: message not found', unique_id]);
            return res.status(200).json({
                error: 'Invalid reply_wamid: message not found',
                message_id: unique_id,
                status: 'failed'
            });
        }
    }

    const options = {
        method: 'POST',
        url: 'https://backend.aisensy.com/direct-apis/t1/messages',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/xml',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            to: number,
            type: 'audio',
            audio: {
                link: media_link
            },
            ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
        }
    };

    try {
        const { data } = await axios.request(options);

        const wamid = data?.messages[0]?.id;

        await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id])

        const [new_row] = await pool.query("SELECT * FROM messages WHERE project_id = ?  AND unique_id = ?", [project_id, unique_id]);
        const new_data = new_row[0];

        const [send_by_row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);
        const send_by_data = send_by_row[0];

        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        const [contact_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ?", [project_id, number]);
        if (contact_row.length > 0) {
            var name = contact_row[0]?.name;
        } else {
            var name = null;
        }


        const return_message = {
            wamid: wamid,
            message_id: unique_id,
            message: new_data?.message,
            create_date: new_data?.create_date,
            is_template: false,
            is_forwarded: false,
            is_reply: is_reply,
            status: 'pending',
            type: 'out',
            message_type: 'audio',
            id: new_data?.id,
            media_url: await GET_CHAT_MEDIA_URL(project_id, number, 'audio', file_path),
            media_name: new_data?.file_name,
            is_voice: new_data?.is_voice == '1' ? true : false,
            send_by: {
                username: send_by_data?.username,
                name: send_by_data?.name,
                mobile: `${send_by_data?.country_code}${send_by_data?.mobile}`,
                email: send_by_data?.email,
                status: send_by_data?.status == '1' ? true : false,
            }
        };

        if (is_reply && reply_wamid) {
            return_message.reply_wamid = reply_wamid;
        }

        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("chat", {
                    message: return_message,
                    project_id,
                    contact: {
                        number,
                        name
                    }
                });
            }

        }

        return res.status(200).json(return_message);
    } catch (error) {
        return res.status(200).json({ error: 'Failed to send message' })
    }



});

router.post("/mark-as-read", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const number = decrypt?.number;

    if (!project_id || !number) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const [message_row] = await pool.query("SELECT * FROM `messages` WHERE number = ? AND project_id = ? AND type = ? ORDER BY id DESC LIMIT 1", [number, project_id, 'in']);

    if (message_row.length == 1) {
        const wamid = message_row[0]?.wamid;
        const options = {
            method: 'POST',
            url: 'https://backend.aisensy.com/direct-apis/t1/mark-read',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, application/xml',
                Authorization: `Bearer ${project_token}`
            },
            data: {
                "messageId": wamid
            }
        };

        try {
            await axios.request(options);
            await pool.query("UPDATE `messages` SET `is_read`=?,`read_by`=? WHERE project_id = ? AND number = ?", ['1', username, project_id, number]);



            const [room_row] = await pool.query(
                "SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?",
                [project_id, "0"]
            );

            if (room_row.length > 0) {
                const [[total_unread_count]] = await pool.query("SELECT COUNT(*) AS count FROM `messages` WHERE `project_id` = ? AND `is_read` = ? AND type = 'in'", [project_id, "0"]);

                for (const roomObj of room_row) {
                    WsIo.to(roomObj?.username).emit("total_unread_count", {
                        count: Number(total_unread_count?.count) || 0,
                    });
                }
            }


            return res.status(200).json({
                error: false,
            })
        } catch (error) {
            return res.status(200).json({ error: 'Failed to mark as read' })
        }
    } else {
        return res.status(200).json({
            error: false,
        })
    }





});

router.post("/send-template", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt.project_id;
    const number = decrypt.number;
    const template_id = decrypt.template_id;
    const component = decrypt.component;
    const is_reply = decrypt.is_reply || false;
    const reply_wamid = decrypt.reply_wamid || null;

    if (!project_id || !component || !number || !template_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (is_reply && !reply_wamid) {
        return res.status(200).json({ error: 'reply_wamid is required when is_reply is true' });
    }


    var [template_row] = await pool.query("SELECT * FROM templates WHERE project_id = ? AND template_id = ? AND status = ?", [project_id, template_id, 'APPROVED']);

    if (template_row.length == 0) {
        return res.status(200).json({ error: 'Invalid template ID' });
    }

    var template_data = template_row[0];

    var template_name = template_data?.template_name;
    var language_code = template_data?.language_code;
    var category = template_data?.category;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const BALANCE = await GET_BALANCE(project_id);
    const project_data = await AISENSY_PROJECT_DATA(project_id);
    const marketing_charge = project_data?.marketing_charge;
    const utility_charge = project_data?.utility_charge;
    const authentication_charge = project_data?.authentication_charge;

    if (category == "MARKETING") {
        if (BALANCE < marketing_charge) {
            return res.status(200).json({ error: 'Please topup wallet before sending marketing template' })
        }
    } else if (category == "UTILITY") {
        if (BALANCE < utility_charge) {
            return res.status(200).json({ error: 'Please topup wallet before sending utility template' })
        }
    } else if (category == "AUTHENTICATION") {
        if (BALANCE < authentication_charge) {
            return res.status(200).json({ error: 'Please topup wallet before sending authentication template' })
        }
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const unique_id = RANDOM_STRING(30);
    var component_stirng = JSON.stringify(component);
    const is_reply_value = is_reply ? '1' : '0';
    await pool.query("INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `is_template`, `template_id`, `component`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, TIMESTAMP(), username, 'out', 'template', '1', template_id, component_stirng, number, 'pending', is_reply_value, reply_wamid]);

    // Validate reply_wamid if is_reply is true
    if (is_reply && reply_wamid) {
        const [reply_check] = await pool.query("SELECT * FROM `messages` WHERE `wamid` = ? AND `project_id` = ?", [reply_wamid, project_id]);
        if (reply_check.length === 0) {
            await pool.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", ['failed', 'Invalid reply_wamid: message not found', unique_id]);
            return res.status(200).json({
                error: 'Invalid reply_wamid: message not found',
                message_id: unique_id,
                status: 'failed'
            });
        }
    }



    var template = {
        "name": template_name,
        "language": {
            "code": language_code
        },
        "components": component
    };

    if (category == "MARKETING") {
        var endpoint = 'https://backend.aisensy.com/direct-apis/t1/messages';
    } else {
        var endpoint = 'https://backend.aisensy.com/direct-apis/t1/messages';
    }

    const options = {
        method: 'POST',
        url: endpoint,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/xml',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            to: number,
            type: 'template',
            template: template,
            ...(is_reply && reply_wamid ? { context: { message_id: reply_wamid } } : {})
        }
    };

    try {
        const { data } = await axios.request(options);
        const wamid = data?.messages[0]?.id;
        const message_status = data?.messages[0]?.message_status;


        if (message_status == 'accepted') {
            await pool.query("UPDATE `messages` SET `wamid` = ?, status = ? WHERE `unique_id` = ?", [wamid, 'sent', unique_id]);


            const [new_data] = await pool.query("SELECT * FROM messages WHERE unique_id = ?", [unique_id]);


            const message_by = new_data[0]?.message_by;
            const [message_by_data] = await pool.query("SELECT * FROM users WHERE username = ?", [message_by]);


            // NEW
            var storedTemplate = await loadTemplateFromDb(project_id, template_id);
            var template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);
            // NEW END

            const return_message = {
                message_id: new_data[0]?.unique_id,
                wamid: new_data[0]?.wamid,
                create_date: new_data[0]?.create_date,
                type: new_data[0]?.type,
                message_type: new_data[0]?.message_type,
                message: buildTemplateDisplayMessage(template, component),
                is_template: true,
                is_forwarded: false,
                is_reply: is_reply,
                status: new_data[0]?.status,
                id: new_data[0]?.id,
                send_by: {
                    username: message_by_data[0]?.username,
                    name: message_by_data[0]?.name,
                    mobile: message_by_data[0]?.mobile,
                    email: message_by_data[0]?.email,
                    status: message_by_data[0]?.status == '1' ? true : false
                },
                template: template,
                component: component
            };

            if (is_reply && reply_wamid) {
                return_message.reply_wamid = reply_wamid;
            }

            const [contact_row] = await pool.query("SELECT * FROM contacts WHERE project_id = ? AND number = ? AND is_deleted = ?", [project_id, number, '0']);
            if (contact_row.length > 0) {
                var name = contact_row[0]?.name;
            } else {
                var name = false;
            }
            const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {
                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat", {
                        message: return_message,
                        project_id,
                        contact: {
                            number,
                            name
                        }
                    });
                }

            }
            // SOCKET END

            return res.status(200).json(return_message)
        } else {
            await pool.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);

            return res.status(200).json({
                error: 'Failed to send message',
                wamid: wamid,
            })
        }


    } catch (error) {
        if (error.response) {
            return res.status(200).json({
                error: error?.response?.error_data?.details
            });
        } else {
            return res.status(200).json({
                error: "Failed to send template",
                e: error
            });
        }
    }

});

router.post("/chat-assign", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req?.headers["username"] ? req?.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const number = decrypt?.number;
    const type = decrypt?.type;
    const target = decrypt?.target;

    if (!project_id || !type || !number) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    if (type == 'unassign') {
        const [check_row] = await pool.query("SELECT * FROM `chat_assigned` WHERE number = ? AND username = ? AND project_id = ?", [number, username, project_id]);
        if (check_row.length == 0) {
            return res.status(200).json({
                error: "You are not assigned to this chat"
            })
        } else {
            await pool.query("DELETE FROM `chat_assigned` WHERE number = ? AND username = ? AND project_id = ?", [number, username, project_id]);

            // SOCKET START
            const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {

                const assigning = await FetchAssigned({ number, project_id, username });

                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", {
                        assigning
                    });
                }

            }
            // SOCKET END

            return res.status(200).json({
                error: false,
                msg: 'You have been unassigned from this chat'
            })
        }
    } else if (type == 'assign') {
        const [target_check] = await pool.query("SELECT * FROM `users` WHERE username = ? AND status = ?", [target, '1']);

        if (target_check.length == 0) {
            return res.status(200).json({
                error: "The selected user is invalid"
            })
        }

        // IF SELF IS ASSIGNED
        const [check_row] = await pool.query("SELECT * FROM `chat_assigned` WHERE number = ? AND username = ? AND project_id = ?", [number, username, project_id]);
        if (check_row.length > 0) {
            await pool.query("DELETE FROM `chat_assigned` WHERE number = ? AND project_id = ?", [number, project_id]);

            await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, target, TIMESTAMP(), username]);


            // SOCKET START
            const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {

                const assigning = await FetchAssigned({ number, project_id, username });

                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", {
                        assigning
                    });
                }

            }
            // SOCKET END

            return res.status(200).json({
                error: false,
                msg: "The user has been assigned successfully"
            })

        }


        // IF USER IS ADMIN
        const [map_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND username = ? AND is_deleted = ?", [project_id, username, '0']);
        if (map_row.length > 0 && map_row[0]?.type == 'admin') {
            await pool.query("DELETE FROM `chat_assigned` WHERE number = ? AND project_id = ?", [number, project_id]);

            await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, target, TIMESTAMP(), username]);

            // SOCKET START
            const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {

                const assigning = await FetchAssigned({ number, project_id, username });

                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", {
                        assigning
                    });
                }

            }
            // SOCKET END

            return res.status(200).json({
                error: false,
                msg: "The user has been assigned successfully"
            })
        }

        // IF USER HAS ACCESS TO ACCESS ASSIGN
        const map_data = map_row[0];
        const permission_id = map_data?.permission_id;
        const [permission_option_row] = await pool.query("SELECT * FROM `permission_options` WHERE permission_id = ? AND permission = ? AND status = ?", [permission_id, 'chat assign access', '1']);
        if (permission_option_row.length > 0) {
            await pool.query("DELETE FROM `chat_assigned` WHERE number = ? AND project_id = ?", [number, project_id]);

            await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, target, TIMESTAMP(), username]);


            // SOCKET START
            const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
            if (room_row.length > 0) {

                const assigning = await FetchAssigned({ number, project_id, username });

                for (const roomObj of room_row) {
                    var room = roomObj?.username;
                    WsIo.to(room).emit("chat_assigned", {
                        assigning
                    });
                }

            }
            // SOCKET END

            return res.status(200).json({
                error: false,
                msg: "The user has been assigned successfully"
            })
        }

    } else {
        return res.status(200).json({
            error: 'Invalid type provided'
        })
    }


});

router.post("/total-unread-count", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req?.headers["username"] ? req?.headers["username"] : '';
        const project_id = decrypt?.project_id;

        if (!project_id) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }


        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' })
        }


        const [[total_unread_count]] = await pool.query("SELECT COUNT(*) AS count FROM `messages` WHERE `project_id` = ? AND `is_read` = ? AND type = 'in'", [project_id, "0"]);

        const count = Number(total_unread_count?.count) || 0;

        return res.status(200).json({
            error: false,
            count,
            msg: 'Unread count fetched successfully'
        })
    } catch (error) {
        return res.status(200).json({ error: 'Failed to get unread count' })
    }




});

// DELETE THIS ENDPOINT
router.post("/case-status", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req?.headers["username"] ? req?.headers["username"] : '';
        const project_id = decrypt?.project_id;
        const number = decrypt?.number;

        if (!project_id || !number) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }


        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' })
        }

        const [unsolved_case_row] = await pool.query("SELECT * FROM `cases` WHERE project_id = ? AND number = ? AND status = ?", [project_id, number, '0']);

        if (unsolved_case_row.length > 0) {
            return res.status(200).json({
                error: false,
                status: true
            })
        } else {
            return res.status(200).json({
                error: false,
                status: false
            })
        }
    } catch (error) {
        return res.status(200).json({ error: 'Failed to get case status' })
    }




});


router.post("/open-case-count", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req?.headers["username"] ? req?.headers["username"] : '';
        const project_id = decrypt?.project_id;
        const number = decrypt?.number;

        if (!project_id || !number) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }


        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' })
        }

        const [case_open_count_row] = await pool.query("SELECT COUNT(*) AS case_open_count FROM cases WHERE project_id = ? AND number = ? AND status = '0'", [project_id, number]);
        const case_open_count = Number(case_open_count_row[0]?.case_open_count) || 0;

        return res.status(200).json({
            error: false,
            case_open_count
        })
    } catch (error) {
        return res.status(200).json({ error: 'Failed to get open case count' })
    }
});

router.post("/case-list", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req?.headers["username"] ? req?.headers["username"] : '';
        // Payload: project_id, number, status, search, page_no, limit
        const project_id = decrypt?.project_id;
        const number = (decrypt?.number ?? '').toString().trim();
        const page_no = Number(decrypt?.page_no) || 1;
        const limit = Math.min(Math.max(Number(decrypt?.limit) || 10, 1), 100);
        const offset = (page_no - 1) * limit;
        const search = (decrypt?.search ?? '').toString().trim();
        const statusParam = (decrypt?.status ?? '').toString().trim().toLowerCase();

        if (!project_id) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' });
        }

        // status: "open" -> cases.status = "0", "closed" -> cases.status = "1", blank/empty/other -> no filter
        let statusValue = null;
        if (statusParam === 'open') statusValue = '0';
        else if (statusParam === 'closed') statusValue = '1';

        const baseWhere = 'WHERE project_id = ?';
        const numberWhere = number ? ' AND number = ?' : '';
        const statusWhere = statusValue !== null ? ' AND status = ?' : '';
        const searchWhere = search ? ' AND (number LIKE ? OR case_id LIKE ? OR name LIKE ?)' : '';
        const params = [project_id];
        if (number) params.push(number);
        if (statusValue !== null) params.push(statusValue);
        if (search) {
            const term = `%${search}%`;
            params.push(term, term, term);
        }

        const countSql = `SELECT COUNT(*) AS total FROM \`cases\` ${baseWhere}${numberWhere}${statusWhere}${searchWhere}`;
        const [[{ total }]] = await pool.query(countSql, params);

        const listParams = [...params, offset, limit];
        const listSql = `SELECT * FROM \`cases\` ${baseWhere}${numberWhere}${statusWhere}${searchWhere} ORDER BY id DESC LIMIT ?, ?`;
        const [case_list_row] = await pool.query(listSql, listParams);

        const auditUsernames = case_list_row.flatMap((item) => [item?.create_by, item?.modify_by]);
        const userMap = await USER_DATA_MAP(auditUsernames);

        const return_data = case_list_row.map((item) => ({
            case_id: item?.case_id,
            number: item?.number,
            status: item?.status == "0",
            name: item?.name,
            remark: item?.remark,
            create_date: item?.create_date,
            create_by: auditUserRecord(userMap.get(item?.create_by) || {}, { includeUsername: true }),
            modify_date: item?.modify_date,
            modify_by: auditUserRecord(userMap.get(item?.modify_by) || {}, { includeUsername: true }),
        }));


        const total_page = Math.ceil(total / limit) || 1;
        const is_last_page = page_no >= total_page;

        return res.status(200).json({
            error: false,
            data: return_data,
            meta: {
                total: Number(total),
                page_no,
                limit,
                total_page,
                is_last_page,
            },
            msg: 'Case list fetched successfully'
        });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to get case status' });
    }
});

router.post("/case-create", auth, async (req, res) => {
    try {
        let data = '';
        let key = '';
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || '';
            key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = (req?.headers["username"] || '').toString().trim();
        const project_id = (decrypt?.project_id ?? '').toString().trim();
        const number = (decrypt?.number ?? '').toString().trim();
        const name = decrypt?.name != null ? String(decrypt.name) : null;
        const remark = decrypt?.remark != null ? String(decrypt.remark) : null;

        if (!project_id || !number) {
            return res.status(200).json({ error: 'Provide all mandatory fields: project_id, number' });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' });
        }

        const [assignedRow] = await pool.query(
            "SELECT username FROM chat_assigned WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1",
            [project_id, number]
        );
        if (assignedRow.length > 0 && assignedRow[0].username !== username) {
            return res.status(200).json({ error: 'Only the assigned user can create a case for this number' });
        }

        const case_id = RANDOM_STRING(30);
        const nameToSet = name !== null ? name : '';
        const remarkToSet = remark !== null ? remark : '';

        await pool.query(
            "INSERT INTO cases (case_id, project_id, number, name, remark, create_by, status) VALUES (?, ?, ?, ?, ?, ?, '0')",
            [case_id, project_id, number, nameToSet, remarkToSet, username]
        );




        // SOCKET START

        const [case_open_count_row] = await pool.query("SELECT COUNT(*) AS case_open_count FROM cases WHERE project_id = ? AND number = ? AND status = '0'", [project_id, number]);
        const case_open_count = case_open_count_row[0]?.case_open_count || 0;

        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("case_status", {
                    number: number,
                    case_open_count: case_open_count
                });
            }

        }
        // SOCKET END

        return res.status(200).json({
            error: false,
            data: { case_id, project_id, number, name: nameToSet, remark: remarkToSet, status: '0' },
            msg: 'Case created successfully'
        });
    } catch (error) {
        return res.status(200).json({ error: 'Failed to create case' });
    }
});

router.post("/case-edit", auth, async (req, res) => {
    try {
        let data = '';
        let key = '';
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || '';
            key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = (req?.headers["username"] || '').toString().trim();
        const project_id = (decrypt?.project_id ?? '').toString().trim();
        const case_id = (decrypt?.case_id ?? '').toString().trim();
        const name = decrypt?.name != null ? String(decrypt.name) : null;
        const remark = decrypt?.remark != null ? String(decrypt.remark) : null;
        const statusParam = (decrypt?.status ?? '').toString().trim().toLowerCase();

        if (!project_id || !case_id) {
            return res.status(200).json({ error: 'Provide all mandatory fields: project_id, case_id' });
        }
        if (!statusParam || !['open', 'closed'].includes(statusParam)) {
            return res.status(200).json({ error: 'Invalid status. Allowed values: open, closed' });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' });
        }

        const [caseRow] = await pool.query(
            "SELECT id, number, name AS current_name, remark AS current_remark FROM cases WHERE project_id = ? AND case_id = ? LIMIT 1",
            [project_id, case_id]
        );
        if (!caseRow || caseRow.length === 0) {
            return res.status(200).json({ error: 'Case not found' });
        }
        const caseRecord = caseRow[0];
        const caseNumber = caseRecord.number;

        const [assignedRow] = await pool.query(
            "SELECT username FROM chat_assigned WHERE project_id = ? AND number = ? ORDER BY id DESC LIMIT 1",
            [project_id, caseNumber]
        );
        if (assignedRow.length > 0 && assignedRow[0].username !== username) {
            return res.status(200).json({ error: 'Only the assigned user can edit this case' });
        }

        const db_status = statusParam === 'open' ? '0' : '1';
        const nameToSet = name !== null ? name : (caseRecord.current_name ?? '');
        const remarkToSet = remark !== null ? remark : (caseRecord.current_remark ?? '');

        await pool.query(
            "UPDATE cases SET modify_date = ?, modify_by = ?, name = ?, remark = ?, status = ? WHERE project_id = ? AND case_id = ?",
            [TIMESTAMP(), username, nameToSet, remarkToSet, db_status, project_id, case_id]
        );

        // SOCKET START

        const [case_open_count_row] = await pool.query("SELECT COUNT(*) AS case_open_count FROM cases WHERE project_id = ? AND number = ? AND status = '0'", [project_id, caseNumber]);
        const case_open_count = case_open_count_row[0]?.case_open_count || 0;

        const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
        if (room_row.length > 0) {
            for (const roomObj of room_row) {
                var room = roomObj?.username;
                WsIo.to(room).emit("case_status", {
                    number: caseNumber,
                    case_open_count: case_open_count
                });
            }

        }
        // SOCKET END

        return res.status(200).json({
            error: false,
            msg: 'Case updated successfully'
        });
    } catch (error) {
        return res.status(200).json({ error: 'Failed to update case' });
    }
});

router.post("/open-case-list", auth, async (req, res) => {
    try {
        let data = '';
        let key = '';
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || '';
            key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = (req?.headers["username"] || '').toString().trim();
        const project_id = (decrypt?.project_id ?? '').toString().trim();
        const page_no = Number(decrypt?.page_no) || 1;
        const limit = Math.min(Math.max(Number(decrypt?.limit) || 10, 1), 100);
        const offset = (page_no - 1) * limit;
        const search = (decrypt?.search ?? '').toString().trim();

        if (!project_id) {
            return res.status(200).json({ error: 'Provide all mandatory fields: project_id' });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: 'User is not assigned on the project' });
        }

        // Build search-aware filters
        // We want to search across case fields and contact fields (if contact exists)
        const hasSearch = !!search;
        const baseWhere = hasSearch
            ? `WHERE c.project_id = ? AND c.status = '0' AND (
                    c.number LIKE ? OR
                    c.case_id LIKE ? OR
                    c.name LIKE ? OR
                    c.remark LIKE ? OR
                    ct.name LIKE ? OR
                    ct.email LIKE ? OR
                    ct.firm_name LIKE ? OR
                    ct.website LIKE ? OR
                    ct.remark LIKE ?
                )`
            : `WHERE c.project_id = ? AND c.status = '0'`;

        const countParams = [project_id];
        if (hasSearch) {
            const like = `%${search}%`;
            countParams.push(like, like, like, like, like, like, like, like, like);
        }

        // Count distinct numbers that have at least one open case, with optional search
        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) AS total
             FROM (
                 SELECT c.number
                 FROM cases c
                 LEFT JOIN contacts ct ON ct.project_id = c.project_id AND ct.number = c.number AND ct.is_deleted = '0'
                 ${baseWhere}
                 GROUP BY c.project_id, c.number
             ) t`,
            countParams
        );

        const listParams = [project_id];
        if (hasSearch) {
            const like = `%${search}%`;
            listParams.push(like, like, like, like, like, like, like, like, like);
        }
        listParams.push(limit, offset);

        // Get paginated list of numbers with at least one open case, ordered by latest case id desc, with optional search
        const [numberRows] = await pool.query(
            `SELECT c.number, MAX(c.id) AS last_id
             FROM cases c
             LEFT JOIN contacts ct ON ct.project_id = c.project_id AND ct.number = c.number AND ct.is_deleted = '0'
             ${baseWhere}
             GROUP BY c.project_id, c.number
             ORDER BY last_id DESC
             LIMIT ? OFFSET ?`,
            listParams
        );

        if (numberRows.length === 0) {
            return res.status(200).json({
                error: false,
                data: [],
                meta: {
                    total: Number(total),
                    page_no,
                    limit,
                    total_page: 0,
                    is_last_page: true,
                },
                msg: 'Open case list fetched successfully'
            });
        }

        const numbers = numberRows.map((row) => row.number);

        // Fetch all open cases for these numbers
        const placeholders = numbers.map(() => "?").join(",");
        const [caseRows] = await pool.query(
            `SELECT *
             FROM cases
             WHERE project_id = ?
               AND status = '0'
               AND number IN (${placeholders})
             ORDER BY number, id DESC`,
            [project_id, ...numbers]
        );

        // Fetch contact data for these numbers (single query)
        const [contactRows] = await pool.query(
            `SELECT *
             FROM contacts
             WHERE project_id = ?
               AND is_deleted = '0'
               AND number IN (${placeholders})`,
            [project_id, ...numbers]
        );

        const contactMap = new Map();
        for (const c of contactRows) {
            contactMap.set(c.number, c);
        }

        // Group cases by number
        const caseMap = new Map();
        for (const element of caseRows) {
            const num = element.number;
            if (!caseMap.has(num)) {
                caseMap.set(num, []);
            }
            caseMap.get(num).push(element);
        }

        const caseAuditUsernames = caseRows.flatMap((element) => [element?.create_by, element?.modify_by]);
        const caseUserMap = await USER_DATA_MAP(caseAuditUsernames);

        const list = [];

        for (const row of numberRows) {
            const num = row.number;
            const casesForNumber = caseMap.get(num) || [];

            const caseDetails = casesForNumber.map((element) => ({
                case_id: element?.case_id,
                status: element?.status == "0",
                name: element?.name,
                remark: element?.remark,
                create_date: element?.create_date,
                create_by: auditUserRecord(caseUserMap.get(element?.create_by) || {}, { includeUsername: true }),
                modify_date: element?.modify_date,
                modify_by: auditUserRecord(caseUserMap.get(element?.modify_by) || {}, { includeUsername: true }),
            }));

            list.push({
                number: num,
                contact: contactMap.has(num) ? {
                    name: contactMap.get(num).name,
                    email: contactMap.get(num).email,
                    firm_name: contactMap.get(num).firm_name,
                    website: contactMap.get(num).website,
                    remark: contactMap.get(num).remark
                } : null,
                cases: caseDetails
            });
        }

        const total_page = total ? Math.ceil(total / limit) : 0;
        const is_last_page = total_page === 0 ? true : page_no >= total_page;

        return res.status(200).json({
            error: false,
            data: list,
            meta: {
                total: Number(total),
                page_no,
                limit,
                total_page,
                is_last_page,
            },
            msg: 'Open case list fetched successfully'
        });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to get open case list' });
    }
});

export default router;
