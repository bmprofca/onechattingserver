import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";

/**
 * ------------------------------------------------------------------------
 * Token-based AI billing.
 *
 * Replaces the old flat "Rs per BOT message" model with:
 *
 *   bill = SUM( (input_tokens / 1000) * input_price_per_1k
 *             + (output_tokens / 1000) * output_price_per_1k )   [per project, per day]
 *        + PLATFORM_MARKUP_RATE  (10% on top, our margin)
 *
 * Requires two tables (see autoReply.js header comment for full DDL):
 *   - ai_usage_log:     one row per AI call, with input/output token counts,
 *                        written by autoReply.js as replies are generated.
 *   - ai_model_pricing:  Rs per 1K input/output tokens, keyed by
 *                        (provider, model), maintained independently of a
 *                        deploy so prices can be updated any time.
 *
 * `transactions` remains the source of truth / idempotency check for
 * whether a project has already been billed for a given day, exactly like
 * the previous flat-rate version — we just compute `amount` differently now.
 * ------------------------------------------------------------------------
 */

// Platform markup applied on top of raw token cost (10%).
const PLATFORM_MARKUP_RATE = 0.10;

// If a project's computed token cost for the day is a genuinely trivial
// fraction of a rupee, we still bill it (no artificial minimum) but round
// to paise so the ledger doesn't accumulate meaningless fractional noise.
function roundToPaise(amount) {
    return Math.round(amount * 100) / 100;
}

/**
 * Sums input/output tokens per (project_id, provider, model) for the given
 * billing window, prices each group using ai_model_pricing, and returns a Map of
 * project_id -> { rawCost, details: [{provider, model, tokens, cost}] }.
 *
 * Any (provider, model) pair with no pricing row is skipped and logged as a
 * warning rather than silently billed as zero — missing prices should be
 * visible, not invisible.
 */
async function computeProjectCosts(connection, windowStart, windowEnd) {
    const [usageRows] = await connection.query(
        `SELECT project_id, provider, model,
                SUM(input_tokens)  AS input_tokens,
                SUM(output_tokens) AS output_tokens
         FROM ai_usage_log
         WHERE create_date > ?
           AND create_date <= ?
         GROUP BY project_id, provider, model`,
        [windowStart, windowEnd]
    );

    if (usageRows.length === 0) {
        return new Map();
    }

    const [pricingRows] = await connection.query("SELECT * FROM ai_model_pricing");
    const priceMap = new Map(pricingRows.map((p) => [`${p.provider}::${p.model}`, p]));

    const projectCosts = new Map();

    for (const row of usageRows) {
        const key = `${row.provider}::${row.model}`;
        const price = priceMap.get(key);

        if (!price) {
            console.warn(`[aiBilling] No pricing configured for ${row.provider}/${row.model} — this usage is NOT being billed. Add a row to ai_model_pricing.`);
            continue;
        }

        const inputTokens = Number(row.input_tokens) || 0;
        const outputTokens = Number(row.output_tokens) || 0;

        const cost =
            (inputTokens / 1000) * Number(price.input_price_per_1k) +
            (outputTokens / 1000) * Number(price.output_price_per_1k);

        const existing = projectCosts.get(row.project_id) || { rawCost: 0, details: [] };
        existing.rawCost += cost;
        existing.details.push({
            provider: row.provider,
            model: row.model,
            inputTokens,
            outputTokens,
            cost,
        });
        projectCosts.set(row.project_id, existing);
    }

    return projectCosts;
}

function formatIstDateTime(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
    }).formatToParts(date).reduce((result, part) => {
        if (part.type !== "literal") result[part.type] = part.value;
        return result;
    }, {});

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function getNoonBillingWindow() {
    const [date] = formatIstDateTime(new Date()).split(" ");
    const windowEnd = `${date} 12:00:00`;
    const previousDay = new Date(`${date}T12:00:00Z`);
    previousDay.setUTCDate(previousDay.getUTCDate() - 1);
    const windowStart = previousDay.toISOString().slice(0, 19).replace("T", " ");

    return { windowStart, windowEnd, windowKey: `${windowStart} to ${windowEnd} IST` };
}

export async function generateAiBills() {
    let connection;
    try {
        connection = await pool.getConnection();

        const { windowStart, windowEnd, windowKey } = getNoonBillingWindow();

        console.log(`[aiBilling] Starting AI billing for window: ${windowKey}`);

        const projectCosts = await computeProjectCosts(connection, windowStart, windowEnd);

        if (projectCosts.size === 0) {
            console.log(`[aiBilling] No billable AI usage found for window: ${windowKey}.`);
            return;
        }

        for (const [projectUniqueId, { rawCost, details }] of projectCosts) {
            if (rawCost <= 0) continue;

            // ai_usage_log stores aisensy_projects.unique_id, while the
            // transactions and project_mapping tables use project_id.
            // Resolve the owner and actual project ID in one query.
            const [ownerRows] = await connection.query(
                `SELECT pm.username, ap.project_id
                 FROM aisensy_projects ap
                 INNER JOIN project_mapping pm ON pm.project_id = ap.project_id
                 WHERE ap.unique_id = ?
                   AND pm.type = 'admin'
                   AND pm.is_deleted = '0'
                 LIMIT 1`,
                [projectUniqueId]
            );

            if (ownerRows.length === 0) {
                console.log(`[aiBilling] No active admin owner found for project ${projectUniqueId}. Skipping billing.`);
                continue;
            }

            const username = ownerRows[0].username;
            const projectId = ownerRows[0].project_id;

            // Keep one ledger charge per project and billing window.
            const [existingBillRows] = await connection.query(
                `SELECT id FROM transactions
                 WHERE project_id = ?
                   AND transaction_type = 'ai auto reply bill'
                   AND type = '0'
                   AND remark LIKE ?
                 LIMIT 1`,
                [projectId, `AI billing window ${windowKey}%`]
            );

            if (existingBillRows.length > 0) {
                console.log(`[aiBilling] Bill already exists for project ${projectId}, window: ${windowKey}. Skipping.`);
                continue;
            }

            const platformFee = rawCost * PLATFORM_MARKUP_RATE;
            const billAmount = roundToPaise(rawCost + platformFee);

            if (billAmount <= 0) continue;

            const totalTokens = details.reduce((sum, d) => sum + d.inputTokens + d.outputTokens, 0);
            const modelsUsed = [...new Set(details.map((d) => `${d.provider}/${d.model}`))].join(", ");

            const remark =
                `AI billing window ${windowKey} ` +
                `(${totalTokens} tokens across ${modelsUsed}; ` +
                `base ₹${rawCost.toFixed(2)} + 10% platform fee ₹${platformFee.toFixed(2)})`;

            // The wallet balance is calculated from this debit transaction.
            await connection.query(
                "INSERT INTO transactions (transaction_id, username, project_id, amount, type, transaction_type, remark, create_date, create_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [RANDOM_STRING(30), username, projectId, billAmount, "0", "ai auto reply bill", remark, TIMESTAMP(), "SYSTEM"]
            );

            console.log(
                `[aiBilling] Billed ${username} (Project ${projectId}) for ${totalTokens} tokens ` +
                `= ₹${rawCost.toFixed(2)} base + ₹${platformFee.toFixed(2)} fee = ₹${billAmount} total.`
            );
        }

        console.log(`[aiBilling] Completed AI billing for window: ${windowKey}.`);
    } catch (error) {
        console.error("[aiBilling] Error generating AI bills:", error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
}
