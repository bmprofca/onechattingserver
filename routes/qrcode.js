import express from "express";
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP, FUTURE_TIMESTAMP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import { sendOtpSms } from "../helpers/sms.js";
import { sendOtpWhatsApp } from "../helpers/whatsapp.js";
import { getAdminByToken } from "../helpers/adminDb.js";
import crypto from "crypto";

const router = express.Router();

const generateNumericQrId = () => crypto.randomInt(1000000000, 9999999999).toString();

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN AUTH MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
const authAdmin = async (req, res, next) => {
    try {
        let token =
            req.headers["x-auth-token"] ||
            req.headers["x-token"] ||
            req.headers["authorization"];

        if (!token) {
            return res.status(401).json({ error: "Auth token required." });
        }

        if (typeof token === "string" && token.startsWith("Bearer ")) {
            token = token.slice(7).trim();
        }

        const admin = await getAdminByToken(token);

        if (!admin) {
            return res.status(401).json({ error: "Invalid or expired token." });
        }

        req.admin = admin;
        req.token = token;
        next();
    } catch (err) {
        return res.status(500).json({ error: "Server error." });
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /qrcode/admin/all — List all QR codes across all projects with project info
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/all", authAdmin, async (req, res) => {
    try {
        const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;
        const search = String(req.query.search || '').trim();
        const mappingStatus = String(req.query.mapping_status || 'all').toLowerCase();
        const where = [];
        const params = [];
        if (search) {
            where.push('(q.qr_id LIKE ? OR q.project_id LIKE ? OR p.project_name LIKE ?)');
            const term = `%${search}%`;
            params.push(term, term, term);
        }
        if (mappingStatus === 'mapped') where.push('q.project_id IS NOT NULL');
        if (mappingStatus === 'unmapped') where.push('q.project_id IS NULL');
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const [[countRow]] = await pool.query(`
            SELECT COUNT(*) AS total
            FROM project_qr_codes q
            LEFT JOIN aisensy_projects p ON p.project_id = q.project_id
            ${whereSql}`, params);
        const [rows] = await pool.query(`
            SELECT 
                q.id,
                q.qr_id,
                q.project_id,
                q.status,
                q.scan_count,
                q.created_by,
                q.create_date,
                q.modify_date,
                p.project_name,
                p.profile_picture,
                p.wa_number
            FROM project_qr_codes q
            LEFT JOIN aisensy_projects p ON p.project_id = q.project_id
            ${whereSql}
            ORDER BY q.create_date DESC
            LIMIT ? OFFSET ?`, [...params, limit, offset]);

        // Mapping is intentionally one-to-one: only projects without an active QR
        // are offered to the administrator.
        const [projects] = await pool.query(
            `SELECT p.project_id, p.project_name, p.profile_picture, p.wa_number
             FROM aisensy_projects p
             LEFT JOIN project_qr_codes q ON q.project_id = p.project_id AND q.status = '1'
             WHERE p.status = '1' AND p.wa_number IS NOT NULL AND p.wa_number != '' AND q.id IS NULL
             ORDER BY p.project_name ASC`
        );
        const [allProjects] = await pool.query(
            "SELECT project_id, project_name, profile_picture, wa_number FROM aisensy_projects WHERE status = '1' AND wa_number IS NOT NULL AND wa_number != '' ORDER BY project_name ASC"
        );

        return res.status(200).json({
            error: false,
            qr_codes: rows,
            projects,
            all_projects: allProjects,
            pagination: { page, limit, total: Number(countRow.total) || 0, total_pages: Math.max(1, Math.ceil(Number(countRow.total || 0) / limit)) },
            filters: { search, mapping_status: mappingStatus }
        });
    } catch (error) {
        console.error("Admin QR list all error:", error);
        return res.status(500).json({ error: "Failed to fetch all QR codes" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /qrcode/admin/generate — Admin panel generates QR code for any project
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/generate", authAdmin, async (req, res) => {
    try {
        const count = Math.min(500, Math.max(1, Number.parseInt(req.body?.count, 10) || 0));
        if (!count) return res.status(400).json({ error: "count must be between 1 and 500" });
        const qrIds = new Set();
        while (qrIds.size < count) qrIds.add(generateNumericQrId());
        const candidates = [...qrIds];
        const placeholders = candidates.map(() => '?').join(',');
        const [existing] = await pool.query(`SELECT qr_id FROM project_qr_codes WHERE qr_id IN (${placeholders})`, candidates);
        const existingIds = new Set(existing.map((row) => row.qr_id));
        const uniqueIds = candidates.filter((id) => !existingIds.has(id));
        if (uniqueIds.length !== count) return res.status(409).json({ error: "QR collision detected; please retry" });
        const created_by = req.admin.username || "admin";
        const now = TIMESTAMP();
        const values = uniqueIds.flatMap((qrId) => [qrId, created_by, now]);
        const valueSql = uniqueIds.map(() => "(?, NULL, ?, '1', ?)").join(',');
        await pool.query(`INSERT INTO project_qr_codes (qr_id, project_id, created_by, status, create_date) VALUES ${valueSql}`, values);

        return res.status(200).json({
            error: false,
            msg: `${count} QR code${count === 1 ? '' : 's'} generated successfully`,
            qr_codes: uniqueIds.map((qr_id) => ({ qr_id, project_id: null, status: '1', scan_count: 0, create_date: now })),
        });
    } catch (error) {
        console.error("QR generate error:", error);
        return res.status(500).json({ error: "Failed to generate QR code" });
    }
});

// POST /qrcode/admin/update — Edit QR label/status or map/unmap its project
router.post("/admin/update", authAdmin, async (req, res) => {
    try {
        const { qr_id, project_id, status } = req.body;
        if (!qr_id) return res.status(400).json({ error: "qr_id is required" });
        if (status !== undefined && !["0", "1"].includes(String(status))) {
            return res.status(400).json({ error: "status must be 0 or 1" });
        }
        const [qrRows] = await pool.query("SELECT id FROM project_qr_codes WHERE qr_id = ?", [qr_id]);
        if (!qrRows.length) return res.status(404).json({ error: "QR code not found" });
        const [currentRows] = await pool.query("SELECT project_id, status FROM project_qr_codes WHERE qr_id = ?", [qr_id]);
        const current = currentRows[0];

        if (project_id !== undefined && project_id !== null && project_id !== "") {
            const [projectRows] = await pool.query(
                "SELECT project_id FROM aisensy_projects WHERE project_id = ? AND status = '1' AND wa_number IS NOT NULL AND wa_number != ''",
                [project_id]
            );
            if (!projectRows.length) return res.status(404).json({ error: "Project not found or has no WhatsApp number" });
            const [mappedRows] = await pool.query(
                "SELECT qr_id FROM project_qr_codes WHERE project_id = ? AND status = '1' AND qr_id <> ?",
                [project_id, qr_id]
            );
            if (mappedRows.length) return res.status(409).json({ error: "Project is already mapped to another active QR code" });
        }

        await pool.query(
            `UPDATE project_qr_codes SET project_id = ?, status = COALESCE(?, status), modify_date = ? WHERE qr_id = ?`,
            [project_id === undefined ? current.project_id : (project_id || null), status === undefined ? null : String(status), TIMESTAMP(), qr_id]
        );
        return res.status(200).json({ error: false, msg: "QR code updated successfully" });
    } catch (error) {
        console.error("QR update error:", error);
        return res.status(500).json({ error: "Failed to update QR code" });
    }
});

// POST /qrcode/admin/map — Map one generated QR to one currently unmapped project
router.post("/admin/map", authAdmin, async (req, res) => {
    try {
        const { qr_id, project_id } = req.body;
        if (!qr_id || !project_id) return res.status(400).json({ error: "qr_id and project_id are required" });

        const [qrRows] = await pool.query(
            "SELECT qr_id, project_id, status FROM project_qr_codes WHERE qr_id = ?",
            [qr_id]
        );
        if (!qrRows.length) return res.status(404).json({ error: "QR code not found" });
        if (qrRows[0].project_id) return res.status(409).json({ error: "QR code is already mapped" });

        const [projectRows] = await pool.query(
            "SELECT project_id FROM aisensy_projects WHERE project_id = ? AND status = '1' AND wa_number IS NOT NULL AND wa_number != ''",
            [project_id]
        );
        if (!projectRows.length) return res.status(404).json({ error: "Project is not active or has no WhatsApp number" });

        const [mappedRows] = await pool.query(
            "SELECT qr_id FROM project_qr_codes WHERE project_id = ? AND status = '1' LIMIT 1",
            [project_id]
        );
        if (mappedRows.length) return res.status(409).json({ error: "Project is already mapped to a QR code" });

        await pool.query(
            "UPDATE project_qr_codes SET project_id = ?, modify_date = ? WHERE qr_id = ? AND project_id IS NULL",
            [project_id, TIMESTAMP(), qr_id]
        );
        return res.status(200).json({ error: false, msg: "QR code mapped to project successfully" });
    } catch (error) {
        console.error("QR map error:", error);
        return res.status(500).json({ error: "Failed to map QR code" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /qrcode/admin/list/:project_id — Admin lists QR codes for a specific project
// ─────────────────────────────────────────────────────────────────────────────
router.get("/admin/list/:project_id", authAdmin, async (req, res) => {
    try {
        const { project_id } = req.params;

        const [rows] = await pool.query(
            "SELECT qr_id, project_id, status, scan_count, create_date, modify_date FROM project_qr_codes WHERE project_id = ? ORDER BY create_date DESC",
            [project_id]
        );

        return res.status(200).json({
            error: false,
            qr_codes: rows,
        });
    } catch (error) {
        console.error("QR list error:", error);
        return res.status(500).json({ error: "Failed to fetch QR codes" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /qrcode/admin/toggle-status — Admin toggles QR code active/inactive
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/toggle-status", authAdmin, async (req, res) => {
    try {
        const { qr_id, status } = req.body;

        if (!qr_id || !["0", "1"].includes(status)) {
            return res.status(400).json({ error: "qr_id and valid status (0 or 1) are required" });
        }

        const [result] = await pool.query(
            "UPDATE project_qr_codes SET status = ?, modify_date = ? WHERE qr_id = ?",
            [status, TIMESTAMP(), qr_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "QR code not found" });
        }

        return res.status(200).json({
            error: false,
            msg: `QR code ${status === "1" ? "activated" : "deactivated"} successfully`,
        });
    } catch (error) {
        console.error("QR toggle error:", error);
        return res.status(500).json({ error: "Failed to update QR code status" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /qrcode/admin/delete — Admin deletes a QR code
// ─────────────────────────────────────────────────────────────────────────────
router.post("/admin/delete", authAdmin, async (req, res) => {
    try {
        const { qr_id } = req.body;

        if (!qr_id) {
            return res.status(400).json({ error: "qr_id is required" });
        }

        const [result] = await pool.query(
            "DELETE FROM project_qr_codes WHERE qr_id = ?",
            [qr_id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: "QR code not found" });
        }

        return res.status(200).json({
            error: false,
            msg: "QR code deleted successfully",
        });
    } catch (error) {
        console.error("QR delete error:", error);
        return res.status(500).json({ error: "Failed to delete QR code" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CLIENT WEB ROUTES (Read-Only: Project members can ONLY view existing QR codes)
// ─────────────────────────────────────────────────────────────────────────────

// POST /qrcode/list — Project members can view generated QR codes for their project
router.post("/list", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const project_id = decrypt.project_id;

        if (!project_id) {
            return res.status(200).json({ error: "project_id is required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access" });
        }

        const [rows] = await pool.query(
            "SELECT qr_id, project_id, status, scan_count, create_date, modify_date FROM project_qr_codes WHERE project_id = ? AND status = '1' ORDER BY create_date DESC",
            [project_id]
        );

        return res.status(200).json({
            error: false,
            qr_codes: rows,
        });
    } catch (error) {
        console.error("Client QR list error:", error);
        return res.status(200).json({ error: "Failed to fetch QR codes" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ROUTES (no auth — called on QR scan)
// ─────────────────────────────────────────────────────────────────────────────

// GET /qrcode/validate/:qr_id — Validate QR code and return project metadata for client-side redirect
router.get("/validate/:qr_id", async (req, res) => {
    try {
        const { qr_id } = req.params;

        if (!qr_id) {
            return res.status(200).json({ error: "QR code ID is required" });
        }

        const [qrRows] = await pool.query(
            "SELECT qr_id, project_id, status FROM project_qr_codes WHERE qr_id = ?",
            [qr_id]
        );

        if (qrRows.length === 0) {
            return res.status(200).json({ error: "Invalid QR code" });
        }

        const qrCode = qrRows[0];

        if (qrCode.status !== "1") {
            return res.status(200).json({ error: "This QR code has been deactivated" });
        }

        // Get project info including wa_number
        const [projectRows] = await pool.query(
            "SELECT project_id, project_name, profile_picture, wa_number FROM aisensy_projects WHERE project_id = ? AND status = '1'",
            [qrCode.project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: "Project not found or inactive" });
        }

        const project = projectRows[0];

        if (!project.wa_number) {
            return res.status(200).json({ error: "WhatsApp number is not configured for this project" });
        }

        // Increment scan count (fire and forget)
        pool.query(
            "UPDATE project_qr_codes SET scan_count = scan_count + 1 WHERE qr_id = ?",
            [qr_id]
        ).catch(() => {});

        // Format clean WhatsApp number (keep only digits)
        const cleanWaNumber = project.wa_number.replace(/\D/g, "");

        // Construct default message containing the project ID and QR reference
        const messageText = `Hello! I'd like to connect. (Project ID: ${project.project_id}) [Ref: ${qrCode.qr_id}]`;

        return res.status(200).json({
            error: false,
            project: {
                project_id: project.project_id,
                project_name: project.project_name,
                profile_picture: project.profile_picture || "",
                phone_number: cleanWaNumber,
            },
            phone_number: cleanWaNumber,
            custom_message: messageText,
        });
    } catch (error) {
        console.error("QR validate error:", error);
        return res.status(200).json({ error: "Failed to validate QR code" });
    }
});

// POST /qrcode/scan-action — Main orchestration endpoint
// Handles: verify session -> register if needed -> map to project -> return token
router.post("/scan-action", async (req, res) => {
    try {
        const {
            qr_id,
            token,
            username,
            name,
            mobile,
            country_code,
            email,
            firm_name,
            otp,
        } = req.body;

        if (!qr_id) {
            return res.status(200).json({ error: "QR code ID is required" });
        }

        // 1. Validate QR code
        const [qrRows] = await pool.query(
            "SELECT qr_id, project_id, status FROM project_qr_codes WHERE qr_id = ? AND status = '1'",
            [qr_id]
        );

        if (qrRows.length === 0) {
            return res.status(200).json({ error: "Invalid or inactive QR code" });
        }

        const project_id = qrRows[0].project_id;

        // Verify project is active
        const [projectRows] = await pool.query(
            "SELECT project_id, project_name FROM aisensy_projects WHERE project_id = ? AND status = '1'",
            [project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: "Project not found or inactive" });
        }

        const project_name = projectRows[0].project_name;

        // 2. If token + username provided, try existing session
        if (token && username) {
            // Verify the token is valid
            const [tokenRows] = await pool.query(
                "SELECT login_token.id, users.status AS user_status, users.username, users.name, users.mobile, users.email FROM login_token JOIN users ON users.username = login_token.username WHERE login_token.token = ? AND login_token.username = ? AND login_token.status = '1' LIMIT 1",
                [token, username]
            );

            if (tokenRows.length === 1 && tokenRows[0].user_status === "1") {
                // Valid session — check/create mapping
                // Resolve identity from the verified token so the public scan
                // page does not need to expose the user's profile fields.
                const sessionMobile = mobile || tokenRows[0].mobile;
                const sessionName = name || tokenRows[0].name;
                const sessionEmail = email || tokenRows[0].email;
                const result = await ensureProjectMapping(username, project_id);

                if (result.error) {
                    return res.status(200).json({ error: result.error });
                }

                // Get updated project list for user
                const [allProjects] = await pool.query(
                    "SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = '0' AND aisensy_projects.status = '1'",
                    [username]
                );

                const projects = allProjects.map((element) => ({
                    name: element.project_name,
                    project_id: element.project_id,
                    owned: element.type === "admin",
                    profile_picture: element.profile_picture || "",
                    profile_image: element.profile_picture || "",
                    logo: element.profile_picture || "",
                    image: element.profile_picture || "",
                }));

                return res.status(200).json({
                    error: false,
                    action: "open_chatroom",
                    project_id,
                    project_name,
                    token,
                    username,
                    is_new_mapping: result.is_new,
                    projects,
                    project_count: projects.length,
                });
            }

            // Token invalid — fall through to require auth
            return res.status(200).json({
                error: false,
                action: "require_auth",
                msg: "Session expired. Please login again.",
            });
        }

        // 3. If mobile + otp provided, handle login/register flow
        if (mobile && otp) {
            // Verify OTP
            const [otpRows] = await pool.query(
                "SELECT * FROM otp_verifications WHERE mobile = ? AND otp = ? AND status = 'pending' AND expire_date > NOW() ORDER BY id DESC LIMIT 1",
                [mobile, otp]
            );

            if (otpRows.length === 0) {
                return res.status(200).json({ error: "Invalid or expired OTP" });
            }

            // Mark OTP as verified
            await pool.query(
                "UPDATE otp_verifications SET status = 'verified' WHERE id = ?",
                [otpRows[0].id]
            );

            // Check if user exists
            const [userRows] = await pool.query(
                "SELECT * FROM users WHERE mobile = ?",
                [mobile]
            );

            let user_username;
            let is_new_user = false;

            if (userRows.length > 0) {
                // Existing user — login
                user_username = userRows[0].username;
            } else {
                // New user — register
                if (!name) {
                    return res.status(200).json({ error: "Name is required for registration" });
                }

                user_username = RANDOM_STRING(20);
                is_new_user = true;

                const user_country_code = country_code || "91";
                const user_email = email || "";
                const user_firm_name = firm_name || name;

                await pool.query(
                    "INSERT INTO users (username, email, name, country_code, mobile, create_date, create_by, modify_date, modify_by, status, firm_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        user_username,
                        user_email,
                        name,
                        user_country_code,
                        mobile,
                        TIMESTAMP(),
                        user_username,
                        TIMESTAMP(),
                        user_username,
                        "1",
                        user_firm_name,
                    ]
                );
            }

            // Generate login token
            const new_token = RANDOM_STRING(50);
            await pool.query(
                "INSERT INTO login_token (username, create_date, create_by, modify_date, modify_by, token, expire_date, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    user_username,
                    TIMESTAMP(),
                    user_username,
                    TIMESTAMP(),
                    user_username,
                    new_token,
                    FUTURE_TIMESTAMP(43200), // 30 days
                    "1",
                ]
            );

            // Ensure project mapping
            const mapResult = await ensureProjectMapping(user_username, project_id);

            if (mapResult.error) {
                return res.status(200).json({ error: mapResult.error });
            }

            // Get user profile
            const [profileRows] = await pool.query(
                "SELECT name, country_code, mobile, email, firm_name FROM users WHERE username = ?",
                [user_username]
            );

            const profile = profileRows.length > 0 ? profileRows[0] : {};

            // Get all projects for this user
            const [allProjects] = await pool.query(
                "SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = '0' AND aisensy_projects.status = '1'",
                [user_username]
            );

            const projects = allProjects.map((element) => ({
                name: element.project_name,
                project_id: element.project_id,
                owned: element.type === "admin",
                profile_picture: element.profile_picture || "",
                profile_image: element.profile_picture || "",
                logo: element.profile_picture || "",
                image: element.profile_picture || "",
            }));

            // Also auto-record into qr_scanned_users if not existing for this project & mobile
            try {
                const [existingScanned] = await pool.query(
                    "SELECT id FROM qr_scanned_users WHERE project_id = ? AND mobile = ? AND status = '1'",
                    [project_id, sessionMobile]
                );
                if (existingScanned.length === 0) {
                    const scan_id = RANDOM_STRING(20);
                    await pool.query(
                        `INSERT INTO qr_scanned_users 
                        (scan_id, project_id, qr_id, name, mobile, email, company, added_by, status, create_date) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, '1', ?)`,
                        [
                            scan_id,
                            project_id,
                            qr_id,
                            profile.name || sessionName || "Scanned User",
                            sessionMobile,
                            profile.email || sessionEmail || null,
                            profile.firm_name || firm_name || null,
                            user_username,
                            TIMESTAMP()
                        ]
                    );
                }
            } catch (scanRecordErr) {
                console.error("Failed to auto-record scanned user:", scanRecordErr);
            }

            return res.status(200).json({
                error: false,
                action: "open_chatroom",
                project_id,
                project_name,
                token: new_token,
                username: user_username,
                is_new_user,
                is_new_mapping: mapResult.is_new,
                profile: {
                    name: profile.name,
                    country_code: profile.country_code,
                    mobile: profile.mobile,
                    email: profile.email,
                },
                projects,
                project_count: projects.length,
            });
        }

        // 4. If only mobile provided (no OTP), send OTP
        if (mobile && !otp) {
            // Generate and send OTP
            const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
            const expire_date = FUTURE_TIMESTAMP(10); // 10 minutes

            await pool.query(
                "INSERT INTO otp_verifications (mobile, otp, expire_date, status) VALUES (?, ?, ?, 'pending')",
                [mobile, generatedOtp, expire_date]
            );

            // Send OTP via WhatsApp and SMS
            try {
                await sendOtpWhatsApp(mobile, generatedOtp);
                await sendOtpSms(mobile, generatedOtp);
            } catch (otpSendError) {
                console.error("Failed to send OTP via QR scan:", otpSendError);
            }

            // Check if user exists (to tell frontend if registration fields are needed)
            const [existingUser] = await pool.query(
                "SELECT username, name, email, firm_name FROM users WHERE mobile = ?",
                [mobile]
            );

            return res.status(200).json({
                error: false,
                action: "otp_sent",
                msg: "OTP sent successfully",
                is_existing_user: existingUser.length > 0,
                user_info: existingUser.length > 0 ? {
                    name: existingUser[0].name,
                    email: existingUser[0].email,
                    firm_name: existingUser[0].firm_name
                } : null
            });
        }

        // No valid action possible
        return res.status(200).json({
            error: "Please provide either login credentials or mobile number",
        });
    } catch (error) {
        console.error("QR scan-action error:", error);
        return res.status(200).json({ error: "Something went wrong. Please try again." });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PROJECT OWNER: SCANNED USERS MANAGEMENT ROUTES (Authenticated)
// ─────────────────────────────────────────────────────────────────────────────

// POST /qrcode/scanned-users/list — Get list of scanned users for a project
router.post("/scanned-users/list", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const project_id = decrypt.project_id;
        const search = decrypt.search ? decrypt.search.trim() : "";
        const page = Math.max(1, parseInt(decrypt.page) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(decrypt.limit) || 20));
        const offset = (page - 1) * limit;

        if (!project_id) {
            return res.status(200).json({ error: "project_id is required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access to project" });
        }

        let whereClause = "WHERE u.project_id = ? AND u.status = '1'";
        const queryParams = [project_id];

        if (search) {
            whereClause += " AND (u.name LIKE ? OR u.mobile LIKE ? OR u.email LIKE ? OR u.company LIKE ? OR u.tags LIKE ?)";
            const searchParam = `%${search}%`;
            queryParams.push(searchParam, searchParam, searchParam, searchParam, searchParam);
        }

        // Count total matching
        const [countResult] = await pool.query(
            `SELECT COUNT(*) AS total FROM qr_scanned_users u ${whereClause}`,
            queryParams
        );
        const total = countResult[0]?.total || 0;

        // Fetch records with QR source joined
        const listParams = [...queryParams, limit, offset];
        const [rows] = await pool.query(
            `SELECT 
                u.id,
                u.scan_id,
                u.project_id,
                u.qr_id,
                u.name,
                u.mobile,
                u.email,
                u.dob,
                u.anniversary,
                u.address,
                u.company,
                u.notes,
                u.tags,
                u.added_by,
                u.status,
                u.create_date,
                u.modify_date,
                q.qr_id AS qr_source
            FROM qr_scanned_users u
            LEFT JOIN project_qr_codes q ON q.qr_id = u.qr_id
            ${whereClause}
            ORDER BY u.id DESC
            LIMIT ? OFFSET ?`,
            listParams
        );

        return res.status(200).json({
            error: false,
            data: rows,
            pagination: {
                total,
                page,
                limit,
                total_pages: Math.ceil(total / limit) || 1
            }
        });
    } catch (error) {
        console.error("Scanned users list error:", error);
        return res.status(200).json({ error: "Failed to fetch scanned users" });
    }
});

// POST /qrcode/scanned-users/add — Project owner manually adds a scanned user
router.post("/scanned-users/add", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const {
            project_id,
            qr_id,
            name,
            mobile,
            email,
            dob,
            anniversary,
            address,
            company,
            notes,
            tags
        } = decrypt;

        if (!project_id) {
            return res.status(200).json({ error: "project_id is required" });
        }

        if (!name || !name.trim()) {
            return res.status(200).json({ error: "Name is required" });
        }

        if (!mobile || !mobile.trim()) {
            return res.status(200).json({ error: "Mobile number is required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access to project" });
        }

        const scan_id = RANDOM_STRING(20);

        await pool.query(
            `INSERT INTO qr_scanned_users 
            (scan_id, project_id, qr_id, name, mobile, email, dob, anniversary, address, company, notes, tags, added_by, status, create_date) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?)`,
            [
                scan_id,
                project_id,
                qr_id || null,
                name.trim(),
                mobile.trim(),
                email ? email.trim() : null,
                dob || null,
                anniversary || null,
                address ? address.trim() : null,
                company ? company.trim() : null,
                notes ? notes.trim() : null,
                tags ? tags.trim() : null,
                username,
                TIMESTAMP()
            ]
        );

        return res.status(200).json({
            error: false,
            msg: "Scanned user record added successfully",
            scan_id
        });
    } catch (error) {
        console.error("Scanned user add error:", error);
        return res.status(200).json({ error: "Failed to add scanned user record" });
    }
});

// POST /qrcode/scanned-users/update — Update a scanned user record
router.post("/scanned-users/update", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const {
            scan_id,
            project_id,
            qr_id,
            name,
            mobile,
            email,
            dob,
            anniversary,
            address,
            company,
            notes,
            tags
        } = decrypt;

        if (!scan_id || !project_id) {
            return res.status(200).json({ error: "scan_id and project_id are required" });
        }

        if (!name || !name.trim()) {
            return res.status(200).json({ error: "Name is required" });
        }

        if (!mobile || !mobile.trim()) {
            return res.status(200).json({ error: "Mobile number is required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access to project" });
        }

        const [result] = await pool.query(
            `UPDATE qr_scanned_users 
            SET 
                name = ?,
                mobile = ?,
                email = ?,
                dob = ?,
                anniversary = ?,
                address = ?,
                company = ?,
                notes = ?,
                tags = ?,
                modify_date = ?
            WHERE scan_id = ? AND project_id = ? AND status = '1'`,
            [
                name.trim(),
                mobile.trim(),
                email ? email.trim() : null,
                dob || null,
                anniversary || null,
                address ? address.trim() : null,
                company ? company.trim() : null,
                notes ? notes.trim() : null,
                tags ? tags.trim() : null,
                TIMESTAMP(),
                scan_id,
                project_id
            ]
        );

        if (result.affectedRows === 0) {
            return res.status(200).json({ error: "Scanned user record not found" });
        }

        return res.status(200).json({
            error: false,
            msg: "Scanned user record updated successfully"
        });
    } catch (error) {
        console.error("Scanned user update error:", error);
        return res.status(200).json({ error: "Failed to update scanned user record" });
    }
});

// POST /qrcode/scanned-users/delete — Soft-delete a scanned user record
router.post("/scanned-users/delete", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const { scan_id, project_id } = decrypt;

        if (!scan_id || !project_id) {
            return res.status(200).json({ error: "scan_id and project_id are required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access to project" });
        }

        const [result] = await pool.query(
            "UPDATE qr_scanned_users SET status = '0', modify_date = ? WHERE scan_id = ? AND project_id = ?",
            [TIMESTAMP(), scan_id, project_id]
        );

        if (result.affectedRows === 0) {
            return res.status(200).json({ error: "Scanned user record not found" });
        }

        return res.status(200).json({
            error: false,
            msg: "Scanned user record deleted successfully"
        });
    } catch (error) {
        console.error("Scanned user delete error:", error);
        return res.status(200).json({ error: "Failed to delete scanned user record" });
    }
});

// POST /qrcode/scanned-users/count — Get total count of scanned users for project
router.post("/scanned-users/count", auth, async (req, res) => {
    try {
        let data = "";
        let key = "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body?.data || "";
            key = req.body?.key || "";
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] || "";
        const { project_id } = decrypt;

        if (!project_id) {
            return res.status(200).json({ error: "project_id is required" });
        }

        // Check project access
        const [check_mapping] = await pool.query(
            "SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = '0'",
            [project_id, username]
        );

        if (check_mapping.length === 0) {
            return res.status(200).json({ error: "Unauthorized access to project" });
        }

        const [countRow] = await pool.query(
            "SELECT COUNT(*) AS total FROM qr_scanned_users WHERE project_id = ? AND status = '1'",
            [project_id]
        );

        return res.status(200).json({
            error: false,
            total: Number(countRow[0]?.total) || 0
        });
    } catch (error) {
        console.error("Scanned users count error:", error);
        return res.status(200).json({ error: "Failed to count scanned users" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Ensure a user is mapped to a project
// ─────────────────────────────────────────────────────────────────────────────
async function ensureProjectMapping(username, project_id) {
    try {
        // Check existing mapping
        const [existingMapping] = await pool.query(
            "SELECT id FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = '0'",
            [username, project_id]
        );

        if (existingMapping.length > 0) {
            return { is_new: false };
        }

        // Create new mapping
        const unique_id = RANDOM_STRING(30);

        await pool.query(
            "INSERT INTO project_mapping (unique_id, project_id, username, type, create_by, create_date, modify_by, modify_date, is_deleted) VALUES (?, ?, ?, 'agent', ?, ?, ?, ?, '0')",
            [
                unique_id,
                project_id,
                username,
                username,
                TIMESTAMP(),
                username,
                TIMESTAMP(),
            ]
        );

        return { is_new: true };
    } catch (error) {
        console.error("ensureProjectMapping error:", error);
        return { error: "Failed to create project mapping" };
    }
}

export default router;
