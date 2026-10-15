import express from "express";
const router = express.Router();
import pool from "../db.js";
import { FUTURE_TIMESTAMP, GENERATE_PASSWORD, GET_BALANCE_BY_USERNAME, IS_STRONG_PASSWORD, RANDOM_STRING, TIMESTAMP, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import { sendPasswordResetEmail } from "../helpers/email.js";
import { listPendingInvitationsForUser } from "../helpers/agentInvitations.js";
import { sendOtpSms } from "../helpers/sms.js";
import { sendOtpWhatsApp } from "../helpers/whatsapp.js";
import { isB2Enabled, uploadBufferToB2, getProxyMediaUrl, getContentTypeFromExtension } from "../helpers/b2Storage.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { fileTypeFromBuffer } from "file-type";
import { deleteDeviceToken, saveDeviceToken } from "../helpers/fcm.js";
import fs from "fs";
import path from "path";

const REVIEW_MOBILE = "9876543210";
const REVIEW_OTP = "123456";

function isReviewMobile(mobile) {
    return String(mobile || "").replace(/\D/g, "") === REVIEW_MOBILE;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let otpPurposeReady = null;
function ensureOtpPurposeColumn() {
    if (!otpPurposeReady) {
        otpPurposeReady = (async () => {
            const [rows] = await pool.query(
                `SELECT COLUMN_NAME AS name
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = DATABASE()
                   AND TABLE_NAME = 'otp_verifications'
                   AND COLUMN_NAME = 'purpose'`
            );
            if (!rows.length) {
                await pool.query("ALTER TABLE otp_verifications ADD COLUMN purpose VARCHAR(32) NULL");
            }
        })().catch((error) => {
            otpPurposeReady = null;
            throw error;
        });
    }
    return otpPurposeReady;
}

function maskMobile(mobile) {
    const digits = String(mobile || "").replace(/\D/g, "");
    if (digits.length <= 4) return digits;
    return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

async function issueMobileOtp(mobile, purpose) {
    await ensureOtpPurposeColumn();
    const reviewLogin = isReviewMobile(mobile);
    const otp = reviewLogin ? REVIEW_OTP : Math.floor(100000 + Math.random() * 900000).toString();
    const expire_date = FUTURE_TIMESTAMP(reviewLogin ? 525600 : 10);
    if (!reviewLogin) console.log("OTP", otp);
    await pool.query(
        "INSERT INTO otp_verifications (mobile, otp, expire_date, status, purpose) VALUES (?, ?, ?, 'pending', ?)",
        [mobile, otp, expire_date, purpose]
    );
    if (!reviewLogin) {
        try {
            await sendOtpWhatsApp(mobile, otp);
            await sendOtpSms(mobile, otp);
        } catch (error) {
            console.error("Failed to send OTP:", error);
        }
    }
}

function profilePayload(user) {
    return {
        name: user?.name,
        country_code: user?.country_code,
        mobile: user?.mobile,
        email: user?.email || "",
        gender: user?.gender,
        firm_name: user?.firm_name,
        business_name: user?.business_name,
        business_type: user?.business_type,
        profile_picture: user?.profile_picture || "",
    };
}

router.post("/send-otp", async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const mobile = decrypt.mobile;
    const purpose = decrypt.purpose;

    if (!mobile) {
        return res.status(200).json({ error: 'Mobile number is required' });
    }

    if (!purpose || !['login', 'signup'].includes(purpose)) {
        return res.status(200).json({ error: 'Provide a valid purpose (login or signup)' });
    }

    // Check whether the user already exists, then branch on purpose
    const [existing_user] = await pool.query("SELECT id FROM users WHERE mobile = ?", [mobile]);
    const userExists = existing_user.length > 0;

    if (purpose === 'login' && !userExists) {
        return res.status(200).json({ error: 'User not registered. Please sign up.' });
    }

    if (purpose === 'signup' && userExists) {
        return res.status(200).json({ error: 'Mobile number already registered' });
    }

    const reviewLogin = isReviewMobile(mobile);
    const otp = reviewLogin ? REVIEW_OTP : Math.floor(100000 + Math.random() * 900000).toString();
    const expire_date = FUTURE_TIMESTAMP(reviewLogin ? 525600 : 10);
    if (!reviewLogin) console.log("OTP", otp);

    await ensureOtpPurposeColumn();
    const conn = await pool.getConnection();
    try {
        await conn.query("INSERT INTO otp_verifications (mobile, otp, expire_date, status, purpose) VALUES (?, ?, ?, 'pending', ?)", [mobile, otp, expire_date, purpose]);
        await conn.commit();

        if (!reviewLogin) {
            try {
                await sendOtpWhatsApp(mobile, otp);
                await sendOtpSms(mobile, otp);
            } catch (error) {
                console.error("Failed to send OTP:", error);
            }
        }

        return res.status(200).json({ error: false, msg: 'OTP sent successfully' });
    } catch (error) {
        await conn.rollback();
        console.error("OTP send error:", error);
        return res.status(200).json({ error: 'Failed to send OTP' });
    } finally {
        conn.release();
    }
});

router.post("/login", async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const mobile = decrypt.mobile;
    const otp = decrypt.otp;

    if (!mobile || !otp) {
        return res.status(200).json({ error: 'Provide mobile and OTP' });
    }

    const reviewLogin = isReviewMobile(mobile) && String(otp) === REVIEW_OTP;
    await ensureOtpPurposeColumn();
    const [otp_row] = reviewLogin
        ? [[]]
        : await pool.query("SELECT * FROM otp_verifications WHERE mobile = ? AND otp = ? AND status = 'pending' AND expire_date > NOW() AND (purpose IS NULL OR purpose = 'login') ORDER BY id DESC LIMIT 1", [mobile, otp]);

    if (!reviewLogin && otp_row.length === 0) {
        return res.status(200).json({ error: 'Invalid or expired OTP' });
    }

    const [data_row] = await pool.query("SELECT * FROM users WHERE mobile = ?", [mobile]);

    if (data_row.length === 0) {
        return res.status(200).json({ error: 'User not registered. Please sign up.' })
    }

    if (!reviewLogin) {
        await pool.query("UPDATE otp_verifications SET status = 'verified' WHERE id = ?", [otp_row[0].id]);
    }

    const user_data = data_row[0];
    const username = user_data.username;

    // GENERATE TOKEN
    const token = RANDOM_STRING(50);
    await pool.query("INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)", [username, TIMESTAMP(), username, TIMESTAMP(), username, token, FUTURE_TIMESTAMP(43200), '1']);

    const name = user_data.name;
    const country_code = user_data.country_code;
    const db_email = user_data.email;

    const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

    const projects = [];

    if (project_row.length > 0) {
        project_row.forEach(element => {
            var project_object = {
                name: element.project_name,
                project_id: element.project_id,
                owned: element.type == 'admin' ? true : false,
                profile_picture: element.profile_picture || "",
                profile_image: element.profile_picture || "",
                logo: element.profile_picture || "",
                image: element.profile_picture || "",
            }

            projects.push(project_object);
        });
    }

    const project_count = projects.length;

    return res.status(200).json({
        error: false,
        username: username,
        token: token,
        profile: {
            name,
            country_code,
            mobile,
            email: db_email,
            profile_picture: user_data.profile_picture || "",
        },
        project_count,
        projects: projects
    })
});

router.post("/register", async (req, res) => {

    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const name = String(decrypt.name || '').trim();
    const firm_name = String(decrypt.firm_name || '').trim();
    const mobile = String(decrypt.mobile || '').trim();
    const country_code = String(decrypt.country_code || '').trim();
    const otp = String(decrypt.otp || '').trim();
    const email = String(decrypt.email || '').trim();

    if (!name || !mobile || !country_code || !otp) {
        return res.status(200).json({ error: 'Provide all mandatory fields' });
    }

    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(200).json({ error: 'Enter a valid email' });
    }

    await ensureOtpPurposeColumn();
    const [otp_row] = await pool.query("SELECT * FROM otp_verifications WHERE mobile = ? AND otp = ? AND status = 'pending' AND expire_date > NOW() AND (purpose IS NULL OR purpose = 'signup') ORDER BY id DESC LIMIT 1", [mobile, otp]);

    if (otp_row.length === 0) {
        return res.status(200).json({ error: 'Invalid or expired OTP' });
    }

    const [data_row] = await pool.query("SELECT * FROM users WHERE mobile = ?", [mobile]);

    if (data_row.length !== 0) {
        return res.status(200).json({ error: 'Mobile number already registered' })
    }

    const conn = await pool.getConnection();
    try {
        var username = RANDOM_STRING(20);
        await pool.query("INSERT INTO `users`(`username`, `email`, `name`, `country_code`, `mobile`, `create_date`, `create_by`, `modify_date`, `modify_by`, `status`,`firm_name`) VALUES (?,?,?,?,?,?,?,?,?,?,?)", [username, email, name, country_code, mobile, TIMESTAMP(), username, TIMESTAMP(), username, '1', firm_name]);

        // Mark OTP as verified
        await pool.query("UPDATE otp_verifications SET status = 'verified' WHERE id = ?", [otp_row[0].id]);

        await conn.commit();

    } catch (error) {
        await conn.rollback();
        console.log(`Register error ${error}`);
        return res.status(200).json({ error: 'Failed to register' })
    } finally {
        conn.release();
    }

    // GENERATE TOKEN
    const token = RANDOM_STRING(50);
    await pool.query("INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)", [username, TIMESTAMP(), username, TIMESTAMP(), username, token, FUTURE_TIMESTAMP(43200), '1']);

    const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

    const projects = [];

    if (project_row.length > 0) {
        project_row.forEach(element => {
            var project_object = {
                name: element.project_name,
                project_id: element.project_id,
                owned: element.type == 'admin' ? true : false,
                profile_picture: element.profile_picture || "",
                profile_image: element.profile_picture || "",
                logo: element.profile_picture || "",
                image: element.profile_picture || "",
            }

            projects.push(project_object);
        });
    }

    const project_count = projects.length;

    return res.status(200).json({
        error: false,
        username: username,
        token: token,
        profile: {
            name,
            country_code,
            mobile,
            email: email,
            profile_picture: "",
        },
        project: {
            project_count,
            projects: projects
        }
    })
});

const GetProjectsAdminDetails = async (project_id) => {
    const [project_row] = await pool.query("SELECT username FROM project_mapping WHERE project_id = ? AND type = 'admin'", [project_id]);
    if (project_row.length == 1) {
        const mapped_project = project_row[0];

        const admin_username = mapped_project.username;

        const admin_profile = await USER_DATA(admin_username);

        return {
            username: admin_username,
            name: admin_profile.name,
            country_code: admin_profile.country_code,
            mobile: admin_profile.mobile,
            email: admin_profile.email,
            profile_picture: admin_profile.profile_picture || "",
            status: admin_profile.status == "1" ? true : false,
        }

    } else {
        return {};
    }
}

router.post("/profile", auth, async (req, res) => {
    const username = req.headers["username"] ? req.headers["username"] : '';

    const [data_row] = await pool.query("SELECT * FROM users WHERE username = ?", [username]);

    if (data_row.length !== 1) {
        return res.status(200).json({ error: 'Username not found' })
    }

    const user_data = data_row[0];

    const name = user_data.name;
    const country_code = user_data.country_code;
    const mobile = user_data.mobile;
    const email = user_data.email;
    const gender = user_data.gender;
    const firm_name = user_data.firm_name;
    const business_name = user_data.business_name;
    const business_type = user_data.business_type;
    const profile_picture = user_data.profile_picture || "";

    const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

    const projects = [];

    if (project_row.length > 0) {
        for (let i = 0; i < project_row.length; i++) {
            const element = project_row[i];
            const project_id = element.project_id;

            const admin_details = await GetProjectsAdminDetails(project_id);

            var project_object = {
                name: element.project_name,
                project_id,
                owned: element.type == 'admin' ? true : false,
                profile_picture: element.profile_picture || "",
                profile_image: element.profile_picture || "",
                logo: element.profile_picture || "",
                image: element.profile_picture || "",
                owner_name: admin_details.name,
            };

            projects.push(project_object);
        }
    }

    const project_count = projects.length;

    const balance = await GET_BALANCE_BY_USERNAME(username);

    const return_json = {
        error: false,
        username: username,
        profile: {
            name,
            country_code,
            mobile,
            email,
            gender,
            firm_name,
            business_name,
            business_type,
            profile_picture,
        },
        balance,
        projects: {
            project_count,
            list: projects,
        },
        pending_invitations: await listPendingInvitationsForUser(username).catch(() => []),
    }

    const [business_details] = await pool.query("SELECT * FROM aisensy_businesses WHERE username = ?", [username]);

    if (business_details.length > 0) {
        return_json.business = {
            is_business_created: business_details.length > 0,
            business_id: business_details[0]?.business_id || false,
        }
    } else {
        return_json.business = {
            is_business_created: business_details.length > 0,
        }
    }

    return res.status(200).json(return_json)
});

router.post("/edit-profile", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const name = String(decrypt?.name || '').trim();
    const gender = decrypt?.gender;
    const firm_name = String(decrypt?.firm_name || '').trim();
    const business_name = String(decrypt?.business_name || '').trim();
    const business_type = decrypt?.business_type;
    const profile_picture = decrypt?.profile_picture !== undefined ? decrypt.profile_picture : null;
    const emailProvided = Object.prototype.hasOwnProperty.call(decrypt, 'email');
    const email = emailProvided ? String(decrypt.email || '').trim() : undefined;

    if (!name || !gender || !firm_name || !business_name || !business_type) {
        return res.status(200).json({ error: 'Provide all mandatory fields' });
    }

    if (email === '') {
        return res.status(200).json({ error: 'Confirm the code sent to your mobile to remove your email' });
    }

    if (email && !EMAIL_PATTERN.test(email)) {
        return res.status(200).json({ error: 'Enter a valid email' });
    }

    try {
        if (email) {
            const [duplicate] = await pool.query(
                "SELECT username FROM users WHERE email = ? AND username <> ? LIMIT 1",
                [email, username]
            );
            if (duplicate.length) {
                return res.status(200).json({ error: 'This email is already used by another account' });
            }
        }

        const fields = ["`name`=?", "`gender`=?", "`firm_name`=?", "`business_name`=?", "`business_type`=?", "`modify_date`=?", "`modify_by`=?"];
        const params = [name, gender, firm_name, business_name, business_type, TIMESTAMP(), username];
        if (email !== undefined) {
            fields.push("`email`=?");
            params.push(email);
        }
        if (profile_picture !== null) {
            fields.push("`profile_picture`=?");
            params.push(profile_picture);
        }
        params.push(username);
        await pool.query(`UPDATE \`users\` SET ${fields.join(", ")} WHERE username = ?`, params);

        const new_data = await USER_DATA(username);

        return res.status(200).json({
            error: false,
            profile: profilePayload(new_data),
            msg: 'Profile updated successfully'
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update profile'
        })
    }
});

router.post("/email/remove-otp", auth, async (req, res) => {
    const username = req.headers["username"] ? String(req.headers["username"]) : '';
    const user = await USER_DATA(username);
    if (!user) {
        return res.status(200).json({ error: 'User not found' });
    }
    if (!String(user.email || '').trim()) {
        return res.status(200).json({ error: 'There is no email on this account' });
    }
    if (!user.mobile) {
        return res.status(200).json({ error: 'This account has no mobile number' });
    }

    try {
        await issueMobileOtp(user.mobile, 'email_remove');
        return res.status(200).json({
            error: false,
            msg: 'OTP sent successfully',
            mobile_hint: maskMobile(user.mobile),
            country_code: user.country_code || '',
        });
    } catch (error) {
        console.error("Email remove OTP error:", error);
        return res.status(200).json({ error: 'Failed to send OTP' });
    }
});

router.post("/email/remove", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);
    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const otp = String(decrypt.otp || '').trim();
    if (!otp) {
        return res.status(200).json({ error: 'Enter the code sent to your mobile' });
    }

    const username = req.headers["username"] ? String(req.headers["username"]) : '';
    const user = await USER_DATA(username);
    if (!user?.mobile) {
        return res.status(200).json({ error: 'This account has no mobile number' });
    }
    if (!String(user.email || '').trim()) {
        return res.status(200).json({ error: 'There is no email on this account' });
    }

    try {
        await ensureOtpPurposeColumn();
        const [otp_row] = await pool.query(
            "SELECT * FROM otp_verifications WHERE mobile = ? AND otp = ? AND purpose = 'email_remove' AND status = 'pending' AND expire_date > NOW() ORDER BY id DESC LIMIT 1",
            [user.mobile, otp]
        );
        if (otp_row.length === 0) {
            return res.status(200).json({ error: 'Invalid or expired OTP' });
        }

        await pool.query("UPDATE otp_verifications SET status = 'verified' WHERE id = ?", [otp_row[0].id]);
        await pool.query(
            "UPDATE `users` SET `email` = '', `modify_date` = ?, `modify_by` = ? WHERE username = ?",
            [TIMESTAMP(), username, username]
        );

        const new_data = await USER_DATA(username);
        return res.status(200).json({
            error: false,
            profile: profilePayload(new_data),
            msg: 'Email removed',
        });
    } catch (error) {
        console.error("Email remove error:", error);
        return res.status(200).json({ error: 'Failed to remove email' });
    }
});

async function saveAvatarImage(username, base64Data, originalFileName = 'avatar.png') {
    let cleanBase64 = String(base64Data || '').trim();
    let declaredMime = '';
    if (cleanBase64.includes(";base64,")) {
        const parts = cleanBase64.split(";base64,");
        declaredMime = parts[0].replace("data:", "");
        cleanBase64 = parts[1];
    }

    const buffer = Buffer.from(cleanBase64, "base64");
    const detectedType = await fileTypeFromBuffer(buffer);
    const ext = detectedType?.ext || path.extname(originalFileName).replace(/^\./, "") || "png";
    const contentType = detectedType?.mime || declaredMime || getContentTypeFromExtension(ext) || "image/png";
    const fileName = `${RANDOM_STRING(25)}.${ext}`;

    if (isB2Enabled()) {
        const objectKey = `avatars/${username}/${fileName}`;
        await uploadBufferToB2(objectKey, buffer, contentType);
        return getProxyMediaUrl(objectKey);
    } else {
        const dir = path.join(process.cwd(), "public", "avatars", username);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, buffer);
        return `${BASE_DOMAIN}/avatars/${username}/${fileName}`;
    }
}

const handleProfilePictureUpdate = async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    let profile_picture = decrypt?.profile_picture || '';
    const image_base64 = decrypt?.image_base64 || decrypt?.base64 || decrypt?.image || '';
    const file_name = decrypt?.file_name || 'avatar.png';

    if (!profile_picture && !image_base64) {
        return res.status(200).json({ error: 'profile_picture or image_base64 is required' });
    }

    try {
        if (image_base64) {
            profile_picture = await saveAvatarImage(username, image_base64, file_name);
        }

        await pool.query(
            "UPDATE `users` SET `profile_picture` = ?, `modify_date` = ?, `modify_by` = ? WHERE username = ?",
            [profile_picture, TIMESTAMP(), username, username]
        );

        return res.status(200).json({
            error: false,
            msg: 'Profile picture updated successfully',
            profile_picture: profile_picture
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update profile picture',
            e: error.message || error
        });
    }
};

router.post("/update-profile-picture", auth, handleProfilePictureUpdate);
router.post("/upload-profile-picture", auth, handleProfilePictureUpdate);

router.post("/session-check", auth, async (req, res) => {

    return res.status(200).json({
        error: false,
    });



});

router.post("/fcm-token", auth, async (req, res) => {
    try {
        const username = req.headers["username"] || "";
        const data = req.body?.data || "";
        const key = req.body?.key || "";
        const decrypt = Decrypt(data, key);
        const token = String(decrypt?.token || "").trim();
        const platform = String(decrypt?.platform || "android").trim() || "android";

        if (!username || !token) {
            return res.status(200).json({ error: "Provide a device token" });
        }

        await saveDeviceToken(username, token, platform);
        return res.status(200).json({ error: false });
    } catch (error) {
        return res.status(200).json({ error: error.message || "Failed to save device token" });
    }
});

router.post("/fcm-token/remove", auth, async (req, res) => {
    try {
        const username = req.headers["username"] || "";
        const data = req.body?.data || "";
        const key = req.body?.key || "";
        const decrypt = Decrypt(data, key);
        const token = String(decrypt?.token || "").trim();
        await deleteDeviceToken(username, token);
        return res.status(200).json({ error: false });
    } catch (error) {
        return res.status(200).json({ error: error.message || "Failed to remove device token" });
    }
});

router.post("/logout", auth, async (req, res) => {
    try {
        const token = req.headers["token"];
        if (token) {
            await pool.query("UPDATE `login_token` SET status = '0' WHERE token = ?", [token]);
        }
        return res.status(200).json({
            error: false,
            msg: "Logged out successfully"
        });
    } catch (err) {
        return res.status(200).json({ error: "Failed to logout" });
    }
});

// ==========================================
// AI auto-reply charges for the currently authenticated user. Charges are
// debited from the user's wallet and stored in the transactions ledger.
// ==========================================

router.get("/ai-bills", auth, async (req, res) => {
    try {
        const username = req.headers["username"];
        const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
        const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 20, 1), 100);
        const projectIds = [...new Set(
            [req.query.project_ids, req.query.project_id]
                .flat(Infinity)
                .flatMap((value) => String(value || '').split(','))
                .map((value) => value.trim())
                .filter(Boolean)
        )].slice(0, 50);
        const fromDate = String(req.query.from_date || '').trim();
        const toDate = String(req.query.to_date || '').trim();
        const validDate = /^\d{4}-\d{2}-\d{2}$/;

        if ((fromDate && !validDate.test(fromDate)) || (toDate && !validDate.test(toDate))) {
            return res.status(400).json({ error: 'from_date and to_date must use YYYY-MM-DD format.' });
        }
        if (fromDate && toDate && fromDate > toDate) {
            return res.status(400).json({ error: 'from_date cannot be later than to_date.' });
        }

        const conditions = [
            'username = ?',
            "transaction_type = 'ai auto reply bill'",
            "type = '0'"
        ];
        const params = [username];

        if (projectIds.length === 1) {
            conditions.push('project_id = ?');
            params.push(projectIds[0]);
        } else if (projectIds.length > 1) {
            conditions.push(`project_id IN (${projectIds.map(() => '?').join(',')})`);
            params.push(...projectIds);
        }
        if (fromDate) {
            conditions.push('DATE(create_date) >= ?');
            params.push(fromDate);
        }
        if (toDate) {
            conditions.push('DATE(create_date) <= ?');
            params.push(toDate);
        }

        const whereClause = conditions.join(' AND ');
        const [[countResult]] = await pool.query(
            `SELECT COUNT(*) AS total, COALESCE(SUM(amount), 0) AS total_amount
             FROM transactions WHERE ${whereClause}`,
            params
        );
        const totalRecords = Number(countResult?.total || 0);
        const [rows] = await pool.query(
            `SELECT transaction_id, project_id, amount, transaction_type, remark, create_date
             FROM transactions
             WHERE ${whereClause}
             ORDER BY create_date DESC, id DESC
             LIMIT ? OFFSET ?`,
            [...params, limit, (page - 1) * limit]
        );

        return res.status(200).json({
            error: false,
            data: rows,
            summary: {
                total_bills: totalRecords,
                total_amount: Number(countResult?.total_amount || 0)
            },
            pagination: {
                page,
                limit,
                total_records: totalRecords,
                total_pages: Math.ceil(totalRecords / limit),
                has_more: page * limit < totalRecords
            }
        });
    } catch (error) {
        return res.status(500).json({ error: "Server error.", e: error?.message });
    }
});

export default router