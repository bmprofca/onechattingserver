import axios from "axios";
import pool from "../db.js";
import {
    GetAiSensyProjectToken,
    RANDOM_STRING,
    TIMESTAMP,
    FORMAT_DATETIME,
} from "../helpers/function.js";
import { formatIndianMobileForSend, validateTenDigitMobile } from "../helpers/mobile.js";

/**
 * Format date in Asia/Kolkata timezone to get current MM-DD and YYYY.
 */
function getIstDateInfo(date = new Date()) {
    const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const parts = formatter.formatToParts(date).reduce((res, p) => {
        if (p.type !== "literal") res[p.type] = p.value;
        return res;
    }, {});

    return {
        year: parts.year,
        month: parts.month,
        day: parts.day,
        monthDay: `${parts.month}-${parts.day}`, // "MM-DD"
        fullDate: `${parts.year}-${parts.month}-${parts.day}`, // "YYYY-MM-DD"
    };
}

/**
 * Build default wishing text message for birthday or anniversary.
 */
function buildWishMessage({ name, type, projectName }) {
    const displayName = (name && name.trim()) ? name.trim() : "Valued Customer";
    const sender = projectName ? `\n\nWarm regards,\n*${projectName}*` : "";

    if (type === "birthday") {
        return `🎂 *Happy Birthday, ${displayName}!* 🎉\n\nWishing you a fantastic day filled with joy, good health, success, and prosperity! Have a wonderful year ahead.${sender}`;
    }

    if (type === "anniversary") {
        return `💐 *Happy Anniversary, ${displayName}!* 🥂\n\nWishing you another wonderful year of love, happiness, and togetherness. May your bond grow stronger with each passing day!${sender}`;
    }

    return `Dear ${displayName}, wishing you all the best on this special day!${sender}`;
}

/**
 * Send WhatsApp text message via AiSensy Direct API.
 */
async function sendWhatsAppDirectMessage(projectToken, recipientMobile, messageText) {
    const options = {
        method: "POST",
        url: "https://backend.aisensy.com/direct-apis/t1/messages",
        headers: {
            "Content-Type": "application/json",
            Accept: "application/json, application/xml",
            Authorization: `Bearer ${projectToken}`,
        },
        data: {
            to: recipientMobile,
            type: "text",
            recipient_type: "individual",
            text: {
                body: messageText,
            },
        },
        timeout: 20000,
    };

    const response = await axios.request(options);
    const wamid = response?.data?.messages?.[0]?.id || null;
    const messageStatus = response?.data?.messages?.[0]?.message_status || null;
    return { wamid, messageStatus, raw: response?.data };
}

/**
 * Main routine to process birthday & anniversary wishes.
 * Runs daily at 12:01 AM IST.
 */
export async function processDailyWishes(customDate = null) {
    const { year, monthDay, fullDate } = getIstDateInfo(customDate || new Date());
    console.log(`[WishCron] 🚀 Starting Birthday & Anniversary wish job for IST date: ${fullDate} (${monthDay})`);

    let connection;
    let birthdaySentCount = 0;
    let anniversarySentCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    try {
        connection = await pool.getConnection();

        // 1. Find active users celebrating Birthday today (matching MM-DD)
        const [birthdayUsers] = await connection.query(
            `SELECT u.id, u.scan_id, u.project_id, u.qr_id, u.name, u.mobile, u.email, u.dob,
                    p.project_name
             FROM qr_scanned_users u
             LEFT JOIN aisensy_projects p ON p.project_id = u.project_id
             WHERE u.status = '1'
               AND u.dob IS NOT NULL
               AND DATE_FORMAT(u.dob, '%m-%d') = ?`,
            [monthDay]
        );

        // 2. Find active users celebrating Anniversary today (matching MM-DD)
        const [anniversaryUsers] = await connection.query(
            `SELECT u.id, u.scan_id, u.project_id, u.qr_id, u.name, u.mobile, u.email, u.anniversary,
                    p.project_name
             FROM qr_scanned_users u
             LEFT JOIN aisensy_projects p ON p.project_id = u.project_id
             WHERE u.status = '1'
               AND u.anniversary IS NOT NULL
               AND DATE_FORMAT(u.anniversary, '%m-%d') = ?`,
            [monthDay]
        );

        console.log(`[WishCron] Found ${birthdayUsers.length} birthday(s) and ${anniversaryUsers.length} anniversary(ies) for ${monthDay}.`);

        // Helper to process a wish recipient list
        const handleWishesList = async (users, wishType) => {
            for (const user of users) {
                const { project_id, mobile, name, project_name } = user;

                if (!mobile) {
                    console.log(`[WishCron] User ID ${user.id} has no mobile number. Skipping.`);
                    skippedCount++;
                    continue;
                }

                // Format mobile number
                let cleanMobile;
                try {
                    const tenDigit = validateTenDigitMobile(mobile);
                    if (tenDigit) {
                        cleanMobile = formatIndianMobileForSend(tenDigit);
                    } else {
                        cleanMobile = String(mobile).replace(/\D/g, "");
                    }
                } catch (e) {
                    cleanMobile = String(mobile).replace(/\D/g, "");
                }

                if (!cleanMobile || cleanMobile.length < 10) {
                    console.log(`[WishCron] Invalid mobile number '${mobile}' for user ID ${user.id}. Skipping.`);
                    skippedCount++;
                    continue;
                }

                // Check deduplication in messages table for current day & wish type
                const [existingWish] = await connection.query(
                    `SELECT unique_id FROM messages 
                     WHERE project_id = ? 
                       AND number = ? 
                       AND message_by = 'SYSTEM_WISH_CRON'
                       AND DATE(create_date) = ?
                       AND (
                           (type = 'out' AND message LIKE ?) 
                           OR (type = 'out' AND message LIKE ?)
                       )
                     LIMIT 1`,
                    [
                        project_id,
                        cleanMobile,
                        fullDate,
                        wishType === "birthday" ? "%Happy Birthday%" : "%Happy Anniversary%",
                        `%${wishType}%`
                    ]
                );

                if (existingWish.length > 0) {
                    console.log(`[WishCron] ${wishType} wish already sent today (${fullDate}) to ${cleanMobile} (Project: ${project_id}). Skipping.`);
                    skippedCount++;
                    continue;
                }

                // Retrieve project token
                const projectToken = await GetAiSensyProjectToken(project_id);
                if (!projectToken) {
                    console.warn(`[WishCron] No project token found for project_id: ${project_id}. Skipping user ${cleanMobile}.`);
                    skippedCount++;
                    continue;
                }

                // Construct greeting
                const messageText = buildWishMessage({
                    name,
                    type: wishType,
                    projectName: project_name || "",
                });

                const unique_id = RANDOM_STRING(30);

                try {
                    const { wamid, messageStatus } = await sendWhatsAppDirectMessage(
                        projectToken,
                        cleanMobile,
                        messageText
                    );

                    const dbStatus = messageStatus === "accepted" || wamid ? "sent" : "pending";

                    // Insert outbound message record
                    await connection.query(
                        `INSERT INTO messages (
                            unique_id, wamid, project_id, create_date, message_by,
                            type, message_type, message, status, number,
                            is_forwarded, is_reply
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0', '0')`,
                        [
                            unique_id,
                            wamid || null,
                            project_id,
                            TIMESTAMP(),
                            "SYSTEM_WISH_CRON",
                            "out",
                            "text",
                            messageText,
                            dbStatus,
                            cleanMobile
                        ]
                    );

                    if (wishType === "birthday") {
                        birthdaySentCount++;
                    } else {
                        anniversarySentCount++;
                    }

                    console.log(`[WishCron] ✅ Sent ${wishType} wish to ${name || 'User'} (${cleanMobile}), WAMID: ${wamid || 'N/A'}`);
                } catch (sendError) {
                    errorCount++;
                    console.error(
                        `[WishCron] ❌ Failed to send ${wishType} to ${cleanMobile} (Project ${project_id}):`,
                        sendError?.response?.data || sendError?.message || sendError
                    );

                    // Record failed attempt for traceability
                    try {
                        await connection.query(
                            `INSERT INTO messages (
                                unique_id, project_id, create_date, message_by,
                                type, message_type, message, status, number,
                                is_forwarded, is_reply
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, '0', '0')`,
                            [
                                unique_id,
                                project_id,
                                TIMESTAMP(),
                                "SYSTEM_WISH_CRON",
                                "out",
                                "text",
                                messageText,
                                cleanMobile
                            ]
                        );
                    } catch (dbErr) {
                        console.error("[WishCron] Failed to record failed message to DB:", dbErr.message);
                    }
                }
            }
        };

        // Process birthdays first, then anniversaries
        await handleWishesList(birthdayUsers, "birthday");
        await handleWishesList(anniversaryUsers, "anniversary");

        console.log(
            `[WishCron] ✨ Completed wish processing for ${fullDate}: Birthday Sent=${birthdaySentCount}, Anniversary Sent=${anniversarySentCount}, Skipped=${skippedCount}, Errors=${errorCount}`
        );

        return {
            success: true,
            fullDate,
            birthdaySentCount,
            anniversarySentCount,
            skippedCount,
            errorCount,
        };
    } catch (err) {
        console.error("[WishCron] Error in processDailyWishes:", err);
        return { success: false, error: err.message };
    } finally {
        if (connection) {
            connection.release();
        }
    }
}
