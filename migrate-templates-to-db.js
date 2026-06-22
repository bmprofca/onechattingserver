/**
 * One-time migration: legacy Server/media/templates/*.json → templates.template_json + B2 media.
 *
 * Usage:
 *   node migrate-templates-to-db.js           # migrate only rows with empty/default template_json
 *   node migrate-templates-to-db.js --force   # re-process all files (re-upload media if URLs present)
 *   node migrate-templates-to-db.js --dry-run    # preview without DB/B2 changes
 *   node migrate-templates-to-db.js --json-only    # save template_json with filenames only (skip B2 upload)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "./db.js";
import { assertB2Configured } from "./helpers/b2Storage.js";
import {
    normalizeTemplateMediaToFilenames,
    processTemplateMediaForStorage,
    serializeTemplateJson,
} from "./helpers/templateStorage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, "media/templates");

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const force = args.has("--force");
const jsonOnly = args.has("--json-only");
const onlyPending = args.has("--only-pending") || (!force && !dryRun && !jsonOnly);

function parseExistingJson(value) {
    try {
        return typeof value === "string" ? JSON.parse(value) : value;
    } catch {
        return {};
    }
}

function isEmptyTemplateJson(value) {
    if (!value || value === "{}") {
        return true;
    }
    try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return !parsed || Object.keys(parsed).length === 0;
    } catch {
        return true;
    }
}

function templateHasRemoteMedia(template) {
    const components = template?.components;
    if (!Array.isArray(components)) {
        return false;
    }

    for (const component of components) {
        if (component?.type !== "HEADER") {
            continue;
        }
        const handles = component?.example?.header_handle;
        if (Array.isArray(handles) && handles.some((h) => typeof h === "string" && /^https?:\/\//i.test(h))) {
            return true;
        }
        const headerUrl = component?.example?.header_url;
        if (typeof headerUrl === "string" && /^https?:\/\//i.test(headerUrl)) {
            return true;
        }
    }
    return false;
}

async function migrateOne(fileName) {
    const template_id = path.basename(fileName, ".json");
    const filePath = path.join(TEMPLATE_DIR, fileName);

    let template;
    try {
        template = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        return { template_id, status: "error", error: `Invalid JSON: ${err.message}` };
    }

    const [rows] = await pool.query(
        "SELECT template_id, project_id, template_json FROM templates WHERE template_id = ? LIMIT 1",
        [template_id]
    );

    if (rows.length === 0) {
        return { template_id, status: "skipped", reason: "No matching row in templates table" };
    }

    const { project_id, template_json: existingJson } = rows[0];

    if (!force && onlyPending && !isEmptyTemplateJson(existingJson)) {
        const existing = parseExistingJson(existingJson);
        if (!templateHasRemoteMedia(existing)) {
            return { template_id, status: "skipped", reason: "template_json already populated" };
        }
    }

    const hasMedia = templateHasRemoteMedia(template);

    if (dryRun) {
        return {
            template_id,
            project_id,
            status: "dry-run",
            hasMedia,
            wouldUpdate: true,
        };
    }

    try {
        let storageTemplate;
        let mediaUploaded = false;
        let mediaWarning = null;

        if (hasMedia && !jsonOnly) {
            try {
                storageTemplate = await processTemplateMediaForStorage(project_id, template_id, template);
                mediaUploaded = true;
            } catch (mediaErr) {
                storageTemplate = normalizeTemplateMediaToFilenames(template);
                mediaWarning = mediaErr?.message || String(mediaErr);
            }
        } else if (hasMedia) {
            storageTemplate = normalizeTemplateMediaToFilenames(template);
        } else {
            storageTemplate = template;
        }

        const templateJson = serializeTemplateJson(storageTemplate);

        await pool.query(
            "UPDATE templates SET template_json = ? WHERE template_id = ? AND project_id = ?",
            [templateJson, template_id, project_id]
        );

        return {
            template_id,
            project_id,
            status: mediaWarning ? "migrated-partial" : "migrated",
            hasMedia,
            mediaUploaded,
            mediaWarning,
        };
    } catch (err) {
        return {
            template_id,
            project_id,
            status: "error",
            error: err?.message || String(err),
        };
    }
}

async function main() {
    if (!dryRun && !jsonOnly) {
        assertB2Configured();
    }

    if (!fs.existsSync(TEMPLATE_DIR)) {
        console.error(`Template directory not found: ${TEMPLATE_DIR}`);
        process.exit(1);
    }

    const files = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith(".json")).sort();
    console.log(`Found ${files.length} template JSON file(s). dry-run=${dryRun} force=${force} json-only=${jsonOnly}\n`);

    const results = { migrated: 0, partial: 0, skipped: 0, errors: 0, dryRun: 0 };

    for (const fileName of files) {
        const result = await migrateOne(fileName);
        const label = `[${result.status}] ${result.template_id}`;

        if (result.status === "migrated") {
            results.migrated++;
            console.log(`${label} → project ${result.project_id}${result.mediaUploaded ? " (media uploaded to B2)" : ""}`);
        } else if (result.status === "migrated-partial") {
            results.partial++;
            console.log(`${label} → project ${result.project_id} (JSON saved; B2 upload failed: ${result.mediaWarning})`);
        } else if (result.status === "dry-run") {
            results.dryRun++;
            console.log(`${label} → project ${result.project_id}${result.hasMedia ? " (has media URLs)" : " (no media)"}`);
        } else if (result.status === "skipped") {
            results.skipped++;
            console.log(`${label} — ${result.reason}`);
        } else {
            results.errors++;
            console.error(`${label} — ${result.error}`);
        }
    }

    console.log("\n--- Summary ---");
    console.log(`Migrated:         ${results.migrated}`);
    console.log(`Partial (no B2):  ${results.partial}`);
    console.log(`Skipped:          ${results.skipped}`);
    console.log(`Errors:           ${results.errors}`);
    if (dryRun) {
        console.log(`Dry-run:  ${results.dryRun} would be updated`);
    }

    await pool.end();
    process.exit(results.errors > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error("Migration failed:", err);
    pool.end().finally(() => process.exit(1));
});
