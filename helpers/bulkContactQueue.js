import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "./function.js";

const QUEUE = [];
const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // keep job status for 1 hour
const BATCH_SIZE = 50;
let isProcessing = false;

function normalizeNumber(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim().replace(/\D/g, "");
}

function normalizeOptional(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length ? text : null;
}

function cleanupOldJobs() {
    const now = Date.now();
    for (const [jobId, job] of JOBS.entries()) {
        if (job.finished_at && now - job.finished_at > JOB_TTL_MS) {
            JOBS.delete(jobId);
        }
    }
}

async function upsertContact({ project_id, username, item }) {
    const number = normalizeNumber(item?.number);
    if (!number) {
        return { status: "skipped", reason: "Missing number" };
    }

    const name = normalizeOptional(item?.name) || number;
    const email = normalizeOptional(item?.email);
    const firm_name = normalizeOptional(item?.firm_name);
    const website = normalizeOptional(item?.website);
    const remark = normalizeOptional(item?.remark);
    const now = TIMESTAMP();

    const [existing] = await pool.query(
        "SELECT contact_id FROM `contacts` WHERE project_id = ? AND number = ? AND is_deleted = ? LIMIT 1",
        [project_id, number, "0"]
    );

    if (existing.length > 0) {
        await pool.query(
            "UPDATE `contacts` SET `name`=?, `email`=?, `firm_name`=?, `website`=?, `remark`=?, `modify_date`=?, `modify_by`=? WHERE project_id = ? AND number = ? AND is_deleted = ?",
            [name, email, firm_name, website, remark, now, username, project_id, number, "0"]
        );
        return { status: "updated", number };
    }

    const contact_id = RANDOM_STRING(20);
    await pool.query(
        "INSERT INTO `contacts`(`contact_id`, `project_id`, `name`, `number`, `email`, `firm_name`, `website`, `remark`, `create_date`, `create_by`, `modify_date`, `modify_by`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [contact_id, project_id, name, number, email, firm_name, website, remark, now, username, now, username, "0"]
    );

    const [assigned] = await pool.query(
        "SELECT id FROM `chat_assigned` WHERE project_id = ? AND number = ? AND username = ? LIMIT 1",
        [project_id, number, username]
    );

    if (assigned.length === 0) {
        await pool.query(
            "INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)",
            [project_id, number, username, now, username]
        );
    }

    return { status: "inserted", number };
}

async function processJob(job) {
    const { job_id, project_id, username, contacts } = job;
    const state = JOBS.get(job_id);
    if (!state) return;

    state.status = "processing";
    state.started_at = Date.now();

    for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
        const batch = contacts.slice(i, i + BATCH_SIZE);

        for (const item of batch) {
            try {
                const result = await upsertContact({ project_id, username, item });
                if (result.status === "inserted") state.inserted += 1;
                else if (result.status === "updated") state.updated += 1;
                else {
                    state.skipped += 1;
                    if (state.errors.length < 100) {
                        state.errors.push({ number: item?.number ?? null, reason: result.reason });
                    }
                }
            } catch (error) {
                state.failed += 1;
                if (state.errors.length < 100) {
                    state.errors.push({
                        number: item?.number ?? null,
                        reason: error?.message || "Failed to upsert contact",
                    });
                }
            }
            state.processed += 1;
        }
    }

    state.status = "completed";
    state.finished_at = Date.now();
}

async function drainQueue() {
    if (isProcessing) return;
    isProcessing = true;

    try {
        while (QUEUE.length > 0) {
            const job = QUEUE.shift();
            try {
                await processJob(job);
            } catch (error) {
                const state = JOBS.get(job.job_id);
                if (state) {
                    state.status = "failed";
                    state.finished_at = Date.now();
                    state.errors.push({ reason: error?.message || "Queue processing failed" });
                }
                console.error("bulkContactQueue job failed:", job.job_id, error?.message || error);
            }
            cleanupOldJobs();
        }
    } finally {
        isProcessing = false;
    }
}

/**
 * Enqueue a bulk contact upsert job and return immediately.
 * @returns {{ job_id: string, total: number }}
 */
export function enqueueBulkContactUpsert({ project_id, username, contacts }) {
    cleanupOldJobs();

    const job_id = RANDOM_STRING(24);
    const list = Array.isArray(contacts) ? contacts : [];

    JOBS.set(job_id, {
        job_id,
        project_id,
        status: "queued",
        total: list.length,
        processed: 0,
        inserted: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        errors: [],
        created_at: Date.now(),
        started_at: null,
        finished_at: null,
    });

    QUEUE.push({ job_id, project_id, username, contacts: list });

    setImmediate(() => {
        drainQueue().catch((err) => {
            console.error("bulkContactQueue drain error:", err?.message || err);
        });
    });

    return { job_id, total: list.length };
}

export function getBulkContactJob(job_id) {
    cleanupOldJobs();
    return JOBS.get(job_id) || null;
}
