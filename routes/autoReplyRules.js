import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import { mapAutoReplyRule, normalizeRuleInput, RuleValidationError } from "../helpers/autoReplyRules.js";

const router = express.Router();

async function requireProjectAccess(req, res, projectId) {
    if (!projectId || projectId.length > 191) {
        res.status(400).json({ error: "A valid project_id is required" });
        return false;
    }
    if (!(await CheckUserProjectMaping(req.headers.username || "", projectId))) {
        res.status(403).json({ error: "User is not assigned to this project" });
        return false;
    }
    return true;
}

function handleError(res, error, operation) {
    if (error instanceof RuleValidationError) {
        return res.status(400).json({ error: error.message });
    }
    console.error(`[auto-reply-rules] ${operation} failed:`, error?.message || error);
    return res.status(500).json({ error: "Auto-reply rules request failed" });
}

router.get("/", auth, async (req, res) => {
    const projectId = String(req.query.project_id || "");
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return undefined;
        const [rows] = await pool.query(
            `SELECT id, unique_id, name, rule_type, keywords, match_type, reply_payload,
                    timezone, days_of_week, business_hours, start_time, end_time, priority,
                    is_active, triggered_count, last_triggered_at, create_date, modify_date
             FROM auto_reply_rules
             WHERE project_id = ?
             ORDER BY priority ASC, id ASC`,
            [projectId]
        );
        return res.json({ data: { rules: rows.map(mapAutoReplyRule) } });
    } catch (error) {
        return handleError(res, error, "list");
    }
});

router.post("/", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    try {
        if (!(await requireProjectAccess(req, res, projectId))) return undefined;
        const rule = normalizeRuleInput(req.body);
        const uniqueId = RANDOM_STRING(30);
        const now = TIMESTAMP();
        const [result] = await pool.query(
            `INSERT INTO auto_reply_rules
                (unique_id, project_id, name, rule_type, keywords, match_type, reply_payload,
                 timezone, days_of_week, business_hours, start_time, end_time, priority,
                 is_active, triggered_count, create_date, create_by, modify_date, modify_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
            [
                uniqueId, projectId, rule.name, rule.ruleType, JSON.stringify(rule.keywords),
                rule.matchType, JSON.stringify({ type: "text", text: rule.response }), rule.timezone,
                rule.daysOfWeek.join(","), rule.businessHours ? 1 : 0, rule.startTime, rule.endTime,
                rule.priority, rule.enabled ? 1 : 0, now, req.headers.username || "", now,
                req.headers.username || "",
            ]
        );
        const [rows] = await pool.query(
            "SELECT * FROM auto_reply_rules WHERE id = ? AND project_id = ? LIMIT 1",
            [result.insertId, projectId]
        );
        return res.status(201).json({ data: { rule: mapAutoReplyRule(rows[0]) } });
    } catch (error) {
        return handleError(res, error, "create");
    }
});

router.put("/:id", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    const ruleId = Number(req.params.id);
    try {
        if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
            return res.status(400).json({ error: "Invalid rule id" });
        }
        if (!(await requireProjectAccess(req, res, projectId))) return undefined;
        const rule = normalizeRuleInput(req.body);
        const now = TIMESTAMP();
        const [result] = await pool.query(
            `UPDATE auto_reply_rules
             SET name = ?, rule_type = ?, keywords = ?, match_type = ?, reply_payload = ?,
                 timezone = ?, days_of_week = ?, business_hours = ?, start_time = ?, end_time = ?,
                 priority = ?, is_active = ?, modify_date = ?, modify_by = ?
             WHERE id = ? AND project_id = ?`,
            [
                rule.name, rule.ruleType, JSON.stringify(rule.keywords), rule.matchType,
                JSON.stringify({ type: "text", text: rule.response }), rule.timezone,
                rule.daysOfWeek.join(","), rule.businessHours ? 1 : 0, rule.startTime, rule.endTime,
                rule.priority, rule.enabled ? 1 : 0, now, req.headers.username || "", ruleId, projectId,
            ]
        );
        if (result.affectedRows === 0) {
            const [existing] = await pool.query(
                "SELECT id FROM auto_reply_rules WHERE id = ? AND project_id = ? LIMIT 1",
                [ruleId, projectId]
            );
            if (existing.length === 0) return res.status(404).json({ error: "Rule not found" });
        }
        const [rows] = await pool.query(
            "SELECT * FROM auto_reply_rules WHERE id = ? AND project_id = ? LIMIT 1",
            [ruleId, projectId]
        );
        return res.json({ data: { rule: mapAutoReplyRule(rows[0]) } });
    } catch (error) {
        return handleError(res, error, "update");
    }
});

router.patch("/:id/status", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    const ruleId = Number(req.params.id);
    const enabled = req.body?.enabled;
    try {
        if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
            return res.status(400).json({ error: "Invalid rule id" });
        }
        if (typeof enabled !== "boolean") {
            return res.status(400).json({ error: "Enabled status must be a boolean" });
        }
        if (!(await requireProjectAccess(req, res, projectId))) return undefined;
        const [result] = await pool.query(
            "UPDATE auto_reply_rules SET is_active = ?, modify_date = ?, modify_by = ? WHERE id = ? AND project_id = ?",
            [enabled ? 1 : 0, TIMESTAMP(), req.headers.username || "", ruleId, projectId]
        );
        if (result.affectedRows === 0) {
            const [existing] = await pool.query(
                "SELECT id FROM auto_reply_rules WHERE id = ? AND project_id = ? LIMIT 1",
                [ruleId, projectId]
            );
            if (existing.length === 0) return res.status(404).json({ error: "Rule not found" });
        }
        return res.json({ data: { id: ruleId, enabled } });
    } catch (error) {
        return handleError(res, error, "toggle");
    }
});

router.delete("/:id", auth, async (req, res) => {
    const projectId = String(req.body?.project_id || "");
    const ruleId = Number(req.params.id);
    try {
        if (!Number.isSafeInteger(ruleId) || ruleId < 1) {
            return res.status(400).json({ error: "Invalid rule id" });
        }
        if (!(await requireProjectAccess(req, res, projectId))) return undefined;
        const [result] = await pool.query(
            "DELETE FROM auto_reply_rules WHERE id = ? AND project_id = ?",
            [ruleId, projectId]
        );
        if (result.affectedRows === 0) return res.status(404).json({ error: "Rule not found" });
        return res.json({ data: { id: ruleId, deleted: true } });
    } catch (error) {
        return handleError(res, error, "delete");
    }
});

export default router;
