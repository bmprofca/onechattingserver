import express from "express";
import { developerSendMessageAuth } from "../middleware/developerAuth.js";
import { enqueueBulkContactUpsert, getBulkContactJob } from "../helpers/bulkContactQueue.js";

const router = express.Router();

const MAX_CONTACTS_PER_REQUEST = 10000;

function resolveProjectContext(req, res) {
    const project_id = req.developerMapping?.project_id;
    const username = req.developerMapping?.username;

    if (!project_id || !username) {
        res.status(200).json({ error: "Invalid or missing token" });
        return null;
    }

    return { project_id, username };
}

function extractContacts(body) {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.contacts)) return body.contacts;
    return null;
}

/**
 * POST /developer/contact/bulk-upsert
 * Header: token (developer token)
 * Body: [{ number, name?, email?, firm_name?, website?, remark? }, ...]
 *    or { contacts: [...] }
 *
 * Upserts by number within the authenticated project.
 * Returns immediately; insert/update runs in a background queue.
 */
router.post("/bulk-upsert", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id, username } = ctx;
        const contacts = extractContacts(req.body);

        if (!contacts) {
            return res.status(200).json({
                error: "Provide contacts as a JSON array, or { contacts: [...] }",
            });
        }

        if (contacts.length === 0) {
            return res.status(200).json({ error: "Contacts array cannot be empty" });
        }

        if (contacts.length > MAX_CONTACTS_PER_REQUEST) {
            return res.status(200).json({
                error: `Maximum ${MAX_CONTACTS_PER_REQUEST} contacts allowed per request`,
            });
        }

        const { job_id, total } = enqueueBulkContactUpsert({
            project_id,
            username,
            contacts,
        });

        return res.status(200).json({
            error: false,
            msg: "Bulk contact upsert accepted and is processing in the background",
            job_id,
            total,
            status_url: `/developer/contact/bulk-upsert-status?job_id=${job_id}`,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to queue bulk contact upsert",
            e: error?.message || error,
        });
    }
});

/**
 * GET /developer/contact/bulk-upsert-status?job_id=...
 * Header: token (developer token)
 */
router.get("/bulk-upsert-status", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const job_id = (req.query?.job_id || "").toString().trim();
        if (!job_id) {
            return res.status(200).json({ error: "Provide job_id" });
        }

        const job = getBulkContactJob(job_id);
        if (!job) {
            return res.status(200).json({ error: "Job not found or expired" });
        }

        if (job.project_id !== ctx.project_id) {
            return res.status(200).json({ error: "Unauthorized Access" });
        }

        return res.status(200).json({
            error: false,
            data: {
                job_id: job.job_id,
                status: job.status,
                total: job.total,
                processed: job.processed,
                inserted: job.inserted,
                updated: job.updated,
                skipped: job.skipped,
                failed: job.failed,
                errors: job.errors,
            },
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to fetch job status",
            e: error?.message || error,
        });
    }
});

export default router;
