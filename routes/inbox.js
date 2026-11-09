import express from "express";
import pool from "../db.js";
import { auth } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import {
    isActiveProjectMembership,
    insertInternalNote,
    normalizeCannedReply,
    normalizeConversationNumber
} from "../helpers/inboxProductivity.js";
import {
    buildContactTimelineQuery,
    normalizeTimelinePagination
} from "../helpers/contactTimeline.js";

const router = express.Router();

function getPayload(req) {
    const body = req.body || {};
    const payload = Decrypt(body.data, body.key);
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

function getProjectId(payload) {
    const projectId = typeof payload?.project_id === "string" ? payload.project_id.trim() : "";
    return projectId.length > 0 && projectId.length <= 100 ? projectId : "";
}

async function hasProjectMembership(username, projectId) {
    const [rows] = await pool.query(
        "SELECT username, project_id, is_deleted FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = '0' LIMIT 1",
        [username, projectId]
    );
    return isActiveProjectMembership(rows[0], username, projectId);
}

function sendFailure(res, status, message) {
    return res.status(status).json({ error: message });
}

async function authorizeProject(req, res, payload) {
    const projectId = getProjectId(payload);
    if (!projectId) {
        sendFailure(res, 400, "Provide project_id");
        return null;
    }
    const username = String(req.headers.username || "");
    if (!await hasProjectMembership(username, projectId)) {
        sendFailure(res, 403, "User is not assigned on the project");
        return null;
    }
    return { projectId, username };
}

async function authorizeConversation(req, res, payload) {
    const project = await authorizeProject(req, res, payload);
    if (!project) return null;
    const number = normalizeConversationNumber(payload?.number);
    if (!number) {
        sendFailure(res, 400, "Provide a valid conversation number");
        return null;
    }
    const [rows] = await pool.query(
        "SELECT id FROM messages WHERE project_id = ? AND number = ? LIMIT 1",
        [project.projectId, number]
    );
    if (!rows.length) {
        sendFailure(res, 404, "Conversation not found in this project");
        return null;
    }
    return { ...project, number };
}

function reportInboxError(res, error, action) {
    console.error(`Inbox ${action} failed:`, error);
    return sendFailure(res, 500, `Failed to ${action}`);
}

router.post("/contact-timeline", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const project = await authorizeProject(req, res, payload);
        if (!project) return;

        const number = normalizeConversationNumber(payload?.number);
        if (!number) {
            return sendFailure(res, 400, "Provide a valid contact number");
        }

        const { page, limit, offset } = normalizeTimelinePagination(
            payload?.page ?? payload?.page_no,
            payload?.limit
        );
        const timelineQuery = buildContactTimelineQuery(
            project.projectId,
            number,
            page,
            limit,
            offset
        );
        const [[countRows], [rows]] = await Promise.all([
            pool.query(timelineQuery.countSql, timelineQuery.countParams),
            pool.query(timelineQuery.dataSql, timelineQuery.dataParams)
        ]);
        const total = Number(countRows[0]?.total) || 0;

        return res.status(200).json({
            error: false,
            data: rows,
            meta: {
                page,
                limit,
                total,
                total_pages: Math.ceil(total / limit),
                has_more: offset + rows.length < total
            }
        });
    } catch (error) {
        return reportInboxError(res, error, "load contact timeline");
    }
});

router.post("/conversation-notes-list", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const conversation = await authorizeConversation(req, res, payload);
        if (!conversation) return;

        const [rows] = await pool.query(
            `SELECT note_id, note_text, create_date, create_by
             FROM inbox_internal_notes
             WHERE project_id = ? AND number = ?
             ORDER BY id DESC LIMIT 200`,
            [conversation.projectId, conversation.number]
        );
        return res.status(200).json({ error: false, data: rows });
    } catch (error) {
        return reportInboxError(res, error, "load conversation notes");
    }
});

router.post("/conversation-note-create", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const conversation = await authorizeConversation(req, res, payload);
        if (!conversation) return;

        const noteText = typeof payload?.note_text === "string" ? payload.note_text.trim() : "";
        if (!noteText || noteText.length > 5000) {
            return sendFailure(res, 400, "Note text must be between 1 and 5000 characters");
        }

        const noteId = RANDOM_STRING(30);
        const createdAt = TIMESTAMP();
        await insertInternalNote(pool, {
            noteId,
            projectId: conversation.projectId,
            number: conversation.number,
            noteText,
            createdAt,
            username: conversation.username
        });
        return res.status(200).json({
            error: false,
            data: {
                note_id: noteId,
                note_text: noteText,
                create_date: createdAt,
                create_by: conversation.username
            }
        });
    } catch (error) {
        return reportInboxError(res, error, "save conversation note");
    }
});

router.post("/conversation-labels", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const conversation = await authorizeConversation(req, res, payload);
        if (!conversation) return;

        const [rows] = await pool.query(
            `SELECT t.tag_id, t.name, t.color,
                    CASE WHEN m.tag_id IS NULL THEN 0 ELSE 1 END AS assigned
             FROM crm_tags t
             LEFT JOIN conversation_label_mapping m
               ON m.project_id = t.project_id AND m.number = ? AND m.tag_id = t.tag_id
              AND m.is_deleted = 0
             WHERE t.project_id = ? AND t.is_deleted = 0
             ORDER BY t.name`,
            [conversation.number, conversation.projectId]
        );
        return res.status(200).json({ error: false, data: rows });
    } catch (error) {
        return reportInboxError(res, error, "load conversation labels");
    }
});

router.post("/conversation-label-update", auth, async (req, res) => {
    let connection;
    try {
        const payload = getPayload(req);
        const conversation = await authorizeConversation(req, res, payload);
        if (!conversation) return;

        const tagId = typeof payload?.tag_id === "string" ? payload.tag_id.trim() : "";
        const action = payload?.action;
        if (!tagId || tagId.length > 100 || !["add", "remove"].includes(action)) {
            return sendFailure(res, 400, "Provide tag_id and add/remove action");
        }
        const [tagRows] = await pool.query(
            "SELECT tag_id FROM crm_tags WHERE project_id = ? AND tag_id = ? AND is_deleted = 0 LIMIT 1",
            [conversation.projectId, tagId]
        );
        if (!tagRows.length) return sendFailure(res, 404, "Label not found in this project");

        connection = await pool.getConnection();
        await connection.beginTransaction();
        if (action === "add") {
            await connection.query(
                `INSERT INTO conversation_label_mapping
                 (project_id, number, tag_id, create_date, create_by, is_deleted)
                 VALUES (?, ?, ?, ?, ?, 0)
                 ON DUPLICATE KEY UPDATE is_deleted = 0, create_date = VALUES(create_date),
                   create_by = VALUES(create_by), deleted_date = NULL, deleted_by = NULL`,
                [conversation.projectId, conversation.number, tagId, TIMESTAMP(), conversation.username]
            );
        } else {
            const deletedAt = TIMESTAMP();
            await connection.query(
                "UPDATE conversation_label_mapping SET is_deleted = 1, deleted_date = ?, deleted_by = ? WHERE project_id = ? AND number = ? AND tag_id = ? AND is_deleted = 0",
                [deletedAt, conversation.username, conversation.projectId, conversation.number, tagId]
            );
        }
        await connection.commit();
        return res.status(200).json({ error: false, msg: "Conversation label updated" });
    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error("Inbox conversation-label rollback failed:", rollbackError);
            }
        }
        return reportInboxError(res, error, "update conversation label");
    } finally {
        connection?.release();
    }
});

router.post("/canned-replies-list", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const project = await authorizeProject(req, res, payload);
        if (!project) return;
        const [rows] = await pool.query(
            `SELECT reply_id, shortcut, title, body
             FROM inbox_canned_replies
             WHERE project_id = ? AND is_deleted = 0
             ORDER BY shortcut`,
            [project.projectId]
        );
        return res.status(200).json({ error: false, data: rows });
    } catch (error) {
        return reportInboxError(res, error, "load canned replies");
    }
});

router.post("/canned-replies-create", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const project = await authorizeProject(req, res, payload);
        if (!project) return;
        let reply;
        try {
            reply = normalizeCannedReply(payload);
        } catch (error) {
            return sendFailure(res, 400, error.message);
        }

        const replyId = RANDOM_STRING(30);
        const createdAt = TIMESTAMP();
        await pool.query(
            `INSERT INTO inbox_canned_replies
             (reply_id, project_id, shortcut, title, body, create_date, create_by, modify_date, modify_by, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [replyId, project.projectId, reply.shortcut, reply.title, reply.body, createdAt, project.username, createdAt, project.username]
        );
        return res.status(200).json({
            error: false,
            data: { reply_id: replyId, ...reply }
        });
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") return sendFailure(res, 409, "That shortcut already exists in this project");
        return reportInboxError(res, error, "create canned reply");
    }
});

router.post("/canned-replies-update", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const project = await authorizeProject(req, res, payload);
        if (!project) return;

        const replyId = typeof payload?.reply_id === "string" ? payload.reply_id.trim() : "";
        if (!replyId || replyId.length > 100) return sendFailure(res, 400, "Provide reply_id");

        let reply;
        try {
            reply = normalizeCannedReply(payload);
        } catch (error) {
            return sendFailure(res, 400, error.message);
        }

        const [result] = await pool.query(
            `UPDATE inbox_canned_replies
             SET shortcut = ?, title = ?, body = ?, modify_date = ?, modify_by = ?
             WHERE project_id = ? AND reply_id = ? AND is_deleted = 0`,
            [reply.shortcut, reply.title, reply.body, TIMESTAMP(), project.username, project.projectId, replyId]
        );
        if (!result.affectedRows) {
            const [existing] = await pool.query(
                `SELECT reply_id FROM inbox_canned_replies
                 WHERE project_id = ? AND reply_id = ? AND is_deleted = 0 LIMIT 1`,
                [project.projectId, replyId]
            );
            if (!existing.length) return sendFailure(res, 404, "Canned reply not found in this project");
        }
        return res.status(200).json({
            error: false,
            data: { reply_id: replyId, ...reply }
        });
    } catch (error) {
        if (error?.code === "ER_DUP_ENTRY") return sendFailure(res, 409, "That shortcut already exists in this project");
        return reportInboxError(res, error, "update canned reply");
    }
});

router.post("/canned-replies-delete", auth, async (req, res) => {
    try {
        const payload = getPayload(req);
        const project = await authorizeProject(req, res, payload);
        if (!project) return;
        const replyId = typeof payload?.reply_id === "string" ? payload.reply_id.trim() : "";
        if (!replyId || replyId.length > 100) return sendFailure(res, 400, "Provide reply_id");

        const [result] = await pool.query(
            `UPDATE inbox_canned_replies SET is_deleted = 1, modify_date = ?, modify_by = ?
             WHERE project_id = ? AND reply_id = ? AND is_deleted = 0`,
            [TIMESTAMP(), project.username, project.projectId, replyId]
        );
        if (!result.affectedRows) return sendFailure(res, 404, "Canned reply not found in this project");
        return res.status(200).json({ error: false, msg: "Canned reply deleted" });
    } catch (error) {
        return reportInboxError(res, error, "delete canned reply");
    }
});

export default router;
