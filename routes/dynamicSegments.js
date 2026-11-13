import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import {
    buildSegmentRecipientQuery,
    normalizeSegmentDefinition,
    normalizeSegmentName,
    SegmentValidationError,
    validateSegmentReferences,
} from "../helpers/dynamicSegments.js";

const router = express.Router();
const SEGMENT_CONTACT_PAGE_SIZE = 25;
const MAX_SEGMENT_CONTACT_PAGE = 10000;

async function requireProjectAccess(req, res, projectId) {
    if (!projectId || projectId.length > 100) {
        res.status(400).json({ error: "A valid project_id is required" });
        return false;
    }
    if (!(await CheckUserProjectMaping(req.headers.username || "", projectId))) {
        res.status(403).json({ error: "User is not assigned to this project" });
        return false;
    }
    return true;
}

function readDefinition(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function handleError(res, error, operation) {
    if (error instanceof SegmentValidationError || error instanceof SyntaxError) {
        return res.status(400).json({ error: error.message });
    }
    console.error(`[dynamic-segments] ${operation} failed:`, error?.message || error);
    return res.status(500).json({ error: "Dynamic segments request failed" });
}

async function getDefinition(connection, projectId, segmentId) {
    const [rows] = await connection.query(
        "SELECT definition_json FROM dynamic_segments WHERE project_id = ? AND segment_id = ? AND is_deleted = 0 LIMIT 1",
        [projectId, segmentId]
    );
    if (rows.length === 0) return null;
    return normalizeSegmentDefinition(readDefinition(rows[0].definition_json));
}

async function resolveDefinition(connection, projectId, definition, options = {}) {
    const normalized = normalizeSegmentDefinition(definition);
    const customFieldIds = await validateSegmentReferences(connection, projectId, normalized);
    const query = buildSegmentRecipientQuery(normalized, { projectId, customFieldIds, ...options });
    return { normalized, query };
}

router.get("/", auth, async (req, res) => {
    const projectId = String(req.query.project_id || "");
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        const [rows] = await pool.query(
            `SELECT segment_id, name, definition_json, create_date, modify_date
             FROM dynamic_segments
             WHERE project_id = ? AND is_deleted = 0
             ORDER BY name, id`,
            [projectId]
        );
        return res.json({
            error: false,
            data: rows.map((row) => ({
                segment_id: row.segment_id,
                name: row.name,
                definition: readDefinition(row.definition_json),
                create_date: row.create_date,
                modify_date: row.modify_date,
            })),
        });
    } catch (error) {
        return handleError(res, error, "list");
    }
});

router.post("/preview", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    let connection;
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        connection = await pool.getConnection();
        const definition = req.body?.segment_id
            ? await getDefinition(connection, projectId, String(req.body.segment_id))
            : req.body?.definition;
        if (!definition) return res.status(404).json({ error: "Segment not found" });
        const { query } = await resolveDefinition(connection, projectId, definition, { countOnly: true });
        const [rows] = await connection.query(query.sql, query.params);
        return res.json({ error: false, data: { count: Number(rows[0]?.count || 0) } });
    } catch (error) {
        return handleError(res, error, "preview");
    } finally {
        connection?.release();
    }
});

router.get("/:segmentId/contacts", auth, async (req, res) => {
    const projectId = String(req.query.project_id || "");
    const segmentId = String(req.params.segmentId || "");
    const pageValue = req.query.page === undefined ? "1" : req.query.page;
    const page = typeof pageValue === "string" ? Number(pageValue) : NaN;
    let connection;
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        if (!segmentId || segmentId.length > 30) return res.status(400).json({ error: "Invalid segment id" });
        if (!Number.isInteger(page) || page < 1 || page > MAX_SEGMENT_CONTACT_PAGE) {
            return res.status(400).json({ error: "Page must be an integer from 1 to 10000" });
        }

        connection = await pool.getConnection();
        const definition = await getDefinition(connection, projectId, segmentId);
        if (!definition) return res.status(404).json({ error: "Segment not found" });
        const customFieldIds = await validateSegmentReferences(connection, projectId, definition);
        const countQuery = buildSegmentRecipientQuery(definition, {
            projectId,
            customFieldIds,
            countOnly: true,
        });
        const [countRows] = await connection.query(countQuery.sql, countQuery.params);
        const total = Number(countRows[0]?.count || 0);
        const contactsQuery = buildSegmentRecipientQuery(definition, {
            projectId,
            customFieldIds,
            limit: SEGMENT_CONTACT_PAGE_SIZE,
            offset: (page - 1) * SEGMENT_CONTACT_PAGE_SIZE,
        });
        const [contacts] = await connection.query(contactsQuery.sql, contactsQuery.params);
        return res.json({
            error: false,
            data: {
                contacts,
                pagination: {
                    page,
                    page_size: SEGMENT_CONTACT_PAGE_SIZE,
                    total,
                    total_pages: Math.ceil(total / SEGMENT_CONTACT_PAGE_SIZE),
                },
            },
        });
    } catch (error) {
        return handleError(res, error, "contacts");
    } finally {
        connection?.release();
    }
});

router.post("/", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    const username = String(req.headers.username || "");
    let connection;
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        const name = normalizeSegmentName(req.body?.name);
        const definition = normalizeSegmentDefinition(req.body?.definition);
        connection = await pool.getConnection();
        await validateSegmentReferences(connection, projectId, definition);
        const segmentId = RANDOM_STRING(30);
        const now = TIMESTAMP();
        await connection.query(
            `INSERT INTO dynamic_segments
                (segment_id, project_id, name, definition_json, create_date, create_by, modify_date, modify_by, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [segmentId, projectId, name, JSON.stringify(definition), now, username, now, username]
        );
        return res.status(201).json({
            error: false,
            data: { segment_id: segmentId, project_id: projectId, name, definition },
        });
    } catch (error) {
        return handleError(res, error, "create");
    } finally {
        connection?.release();
    }
});

router.put("/:segmentId", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    const segmentId = String(req.params.segmentId || "");
    const username = String(req.headers.username || "");
    let connection;
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        if (!segmentId || segmentId.length > 30) return res.status(400).json({ error: "Invalid segment id" });
        const name = normalizeSegmentName(req.body?.name);
        const definition = normalizeSegmentDefinition(req.body?.definition);
        connection = await pool.getConnection();
        await validateSegmentReferences(connection, projectId, definition);
        const [result] = await connection.query(
            `UPDATE dynamic_segments
             SET name = ?, definition_json = ?, modify_date = ?, modify_by = ?
             WHERE project_id = ? AND segment_id = ? AND is_deleted = 0`,
            [name, JSON.stringify(definition), TIMESTAMP(), username, projectId, segmentId]
        );
        if (result.affectedRows === 0) {
            const [existing] = await connection.query(
                "SELECT segment_id FROM dynamic_segments WHERE project_id = ? AND segment_id = ? AND is_deleted = 0 LIMIT 1",
                [projectId, segmentId]
            );
            if (existing.length === 0) return res.status(404).json({ error: "Segment not found" });
        }
        return res.json({ error: false, data: { segment_id: segmentId, name, definition } });
    } catch (error) {
        return handleError(res, error, "update");
    } finally {
        connection?.release();
    }
});

router.delete("/:segmentId", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || req.query.project_id || "");
    const segmentId = String(req.params.segmentId || "");
    const username = String(req.headers.username || "");
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return;
        if (!segmentId || segmentId.length > 30) return res.status(400).json({ error: "Invalid segment id" });
        const [result] = await pool.query(
            `UPDATE dynamic_segments
             SET is_deleted = 1, modify_date = ?, modify_by = ?
             WHERE project_id = ? AND segment_id = ? AND is_deleted = 0`,
            [TIMESTAMP(), username, projectId, segmentId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Segment not found" });
        return res.json({ error: false, data: { segment_id: segmentId, deleted: true } });
    } catch (error) {
        return handleError(res, error, "delete");
    }
});

export default router;
