import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import { normalizeFlowGraph, validateFlowGraph } from "../helpers/flowBuilder.js";

const router = express.Router();

async function requestData(req, res) {
    const decrypt = Decrypt(req.body?.data || "", req.body?.key || "");
    if (!decrypt) { res.status(200).json({ error: "Failed to decrypt data" }); return null; }
    const username = req.headers.username || "";
    const projectId = decrypt.project_id;
    if (!projectId || !(await CheckUserProjectMaping(username, projectId))) { res.status(200).json({ error: "User is not assigned on the project" }); return null; }
    return { decrypt, username, projectId };
}

router.get("/status", auth, async (req, res) => {
    try {
        const username = req.headers.username || "";
        const projectId = req.query.project_id;
        if (!projectId || !(await CheckUserProjectMaping(username, projectId))) return res.status(200).json({ error: "User is not assigned on the project" });
        const [[row]] = await pool.query("SELECT flow_builder_enabled, active_flow_id FROM aisensy_projects WHERE project_id=? LIMIT 1", [projectId]);
        let flow = null;
        if (row?.active_flow_id) { const [[active]] = await pool.query("SELECT flow_id,name,status,version FROM flows WHERE flow_id=? AND project_id=? AND is_deleted='0' LIMIT 1", [row.active_flow_id, projectId]); flow = active || null; }
        return res.json({ error: false, flow_builder_enabled: row?.flow_builder_enabled === "1", active_flow: flow });
    } catch (error) { return res.status(200).json({ error: "Failed to fetch Flow Builder status", e: error.message }); }
});

router.post("/list", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const [rows] = await pool.query("SELECT flow_id,name,description,status,version,create_date,modify_date FROM flows WHERE project_id=? AND is_deleted='0' ORDER BY modify_date DESC", [ctx.projectId]); return res.json({ error: false, data: rows }); }
    catch (error) { return res.status(200).json({ error: "Failed to list flows", e: error.message }); }
});

router.post("/get", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const [[row]] = await pool.query("SELECT * FROM flows WHERE flow_id=? AND project_id=? AND is_deleted='0' LIMIT 1", [ctx.decrypt.flow_id, ctx.projectId]); if (!row) return res.status(200).json({ error: "Flow not found" }); return res.json({ error: false, data: { ...row, draft: JSON.parse(row.draft_json || "{}"), published: row.published_json ? JSON.parse(row.published_json) : null } }); }
    catch (error) { return res.status(200).json({ error: "Failed to fetch flow", e: error.message }); }
});

router.post("/create", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const graph = normalizeFlowGraph(ctx.decrypt.graph || { nodes: [], edges: [] }); const flowId = RANDOM_STRING(30); const now = TIMESTAMP(); await pool.query("INSERT INTO flows (flow_id,project_id,name,description,status,version,draft_json,create_date,create_by,modify_date,modify_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [flowId, ctx.projectId, ctx.decrypt.name || "Untitled flow", ctx.decrypt.description || null, "draft", 1, JSON.stringify(graph), now, ctx.username, now, ctx.username]); return res.json({ error: false, data: { flow_id: flowId, name: ctx.decrypt.name || "Untitled flow", graph }, msg: "Flow created successfully" }); }
    catch (error) { return res.status(200).json({ error: "Failed to create flow", e: error.message }); }
});

router.post("/update-draft", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const graph = normalizeFlowGraph(ctx.decrypt.graph); const [result] = await pool.query("UPDATE flows SET name=?,description=?,draft_json=?,modify_date=?,modify_by=? WHERE flow_id=? AND project_id=? AND is_deleted='0'", [ctx.decrypt.name || "Untitled flow", ctx.decrypt.description || null, JSON.stringify(graph), TIMESTAMP(), ctx.username, ctx.decrypt.flow_id, ctx.projectId]); if (!result.affectedRows) return res.status(200).json({ error: "Flow not found" }); return res.json({ error: false, data: graph, msg: "Draft saved successfully" }); }
    catch (error) { return res.status(200).json({ error: "Failed to save flow draft", e: error.message }); }
});

router.post("/validate", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    const result = validateFlowGraph(ctx.decrypt.graph); return res.json({ error: false, valid: result.valid, errors: result.errors });
});

router.post("/publish", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const [[flow]] = await pool.query("SELECT draft_json FROM flows WHERE flow_id=? AND project_id=? AND is_deleted='0' LIMIT 1", [ctx.decrypt.flow_id, ctx.projectId]); if (!flow) return res.status(200).json({ error: "Flow not found" }); const validation = validateFlowGraph(JSON.parse(flow.draft_json)); if (!validation.valid) return res.status(200).json({ error: "Flow is invalid", errors: validation.errors }); await pool.query("UPDATE flows SET published_json=draft_json,status='published',version=version+1,modify_date=?,modify_by=? WHERE flow_id=? AND project_id=?", [TIMESTAMP(), ctx.username, ctx.decrypt.flow_id, ctx.projectId]); return res.json({ error: false, msg: "Flow published successfully", version: validation.graph.version }); }
    catch (error) { return res.status(200).json({ error: "Failed to publish flow", e: error.message }); }
});

router.post("/toggle", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try { const enabled = ctx.decrypt.enabled === true || ctx.decrypt.enabled === "1" ? "1" : "0"; if (enabled === "1") { const [[flow]] = await pool.query("SELECT flow_id FROM flows WHERE flow_id=? AND project_id=? AND status='published' AND is_deleted='0' LIMIT 1", [ctx.decrypt.flow_id, ctx.projectId]); if (!flow) return res.status(200).json({ error: "A published flow is required before enabling Flow Builder" }); await pool.query("UPDATE aisensy_projects SET flow_builder_enabled='1',active_flow_id=?,modify_date=?,modify_by=? WHERE project_id=?", [ctx.decrypt.flow_id, TIMESTAMP(), ctx.username, ctx.projectId]); } else await pool.query("UPDATE aisensy_projects SET flow_builder_enabled='0',modify_date=?,modify_by=? WHERE project_id=?", [TIMESTAMP(), ctx.username, ctx.projectId]); return res.json({ error: false, flow_builder_enabled: enabled === "1", msg: `Flow Builder turned ${enabled === "1" ? "ON" : "OFF"}` }); }
    catch (error) { return res.status(200).json({ error: "Failed to update Flow Builder status", e: error.message }); }
});

router.post("/delete", auth, async (req, res) => {
    const ctx = await requestData(req, res); if (!ctx) return;
    try {
        const rawIds = ctx.decrypt.flow_ids || ctx.decrypt.ids || ctx.decrypt.flow_id || ctx.decrypt.id;
        const idList = Array.isArray(rawIds) ? rawIds : [rawIds];
        const flowIds = Array.from(new Set(idList.map(id => String(id || "").trim()).filter(Boolean)));

        if (flowIds.length === 0) {
            return res.status(200).json({ error: "No flow ID(s) provided for deletion" });
        }

        const now = TIMESTAMP();
        const [result] = await pool.query(
            "UPDATE flows SET is_deleted='1', status='archived', modify_date=?, modify_by=? WHERE flow_id IN (?) AND project_id=?",
            [now, ctx.username, flowIds, ctx.projectId]
        );

        await pool.query(
            "UPDATE aisensy_projects SET active_flow_id=NULL, flow_builder_enabled='0' WHERE project_id=? AND active_flow_id IN (?)",
            [ctx.projectId, flowIds]
        );

        return res.json({
            error: false,
            deleted_count: result.affectedRows,
            deleted_ids: flowIds,
            msg: `${flowIds.length} flow(s) deleted successfully`
        });
    } catch (error) {
        return res.status(200).json({ error: "Failed to delete flow(s)", e: error.message });
    }
});

export default router;
