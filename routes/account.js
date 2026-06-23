import express from "express";
const router = express.Router();
import pool from "../db.js";
import { FUTURE_TIMESTAMP, GENERATE_PASSWORD, GET_BALANCE_BY_USERNAME, IS_STRONG_PASSWORD, RANDOM_STRING, TIMESTAMP, USER_DATA, validateTurnstileToken } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import { GOOGLE_CLIENT_ID } from "../helpers/Config.js";
import { OAuth2Client } from "google-auth-library";
import { sendPasswordResetEmail } from "../helpers/email.js";

router.post("/login", async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const email = decrypt.email;
    const password = decrypt.password;
    const captcha_token = decrypt?.captcha_token;

    if (!email || !password) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }
    if (!captcha_token) {
        return res.status(200).json({ error: 'Captcha verification is required' });
    }

    const isValidCaptcha = await validateTurnstileToken(captcha_token, req.ip || req.socket?.remoteAddress);
    if (!isValidCaptcha) {
        return res.status(200).json({ error: 'Captcha verification failed. Please try again.' });
    }

    const [data_row] = await pool.query("SELECT * FROM users WHERE email = ? AND password = ?", [email, password]);

    if (data_row.length !== 1) {
        return res.status(200).json({ error: 'Username or password is wrong' })
    }

    const user_data = data_row[0];
    const username = user_data.username;

    // GENERATE TOKEN
    const token = RANDOM_STRING(50);
    await pool.query("INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)", [username, TIMESTAMP(), username, TIMESTAMP(), username, token, FUTURE_TIMESTAMP(43200), '1']);

    const name = user_data.name;
    const country_code = user_data.country_code;
    const mobile = user_data.mobile;
    const db_email = user_data.email;

    const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

    const projects = [];

    if (project_row.length > 0) {
        project_row.forEach(element => {
            var project_object = {
                name: element.project_name,
                project_id: element.project_id,
                owned: element.type == 'admin' ? true : false,
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

    const email = decrypt.email;
    const password = decrypt.password;
    const confirm_password = decrypt.confirm_password;
    const name = decrypt.name;
    const firm_name = decrypt.firm_name;
    const mobile = decrypt.mobile;
    const country_code = decrypt.country_code;
    const captcha_token = decrypt?.captcha_token;

    if (!email || !password || !confirm_password || !name || !firm_name || !mobile || !country_code) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }
    if (!captcha_token) {
        return res.status(200).json({ error: 'Captcha verification is required' });
    }

    const isValidCaptcha = await validateTurnstileToken(captcha_token, req.ip || req.socket?.remoteAddress);
    if (!isValidCaptcha) {
        return res.status(200).json({ error: 'Captcha verification failed. Please try again.' });
    }

    if (password !== confirm_password) {
        return res.status(200).json({ error: 'Password & confirm password not matched' });
    }

    if (!IS_STRONG_PASSWORD(password)) {
        return res.status(200).json({ error: 'Please provide a strong password' });
    }


    const [data_row] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);

    if (data_row.length !== 0) {
        return res.status(200).json({ error: 'Email already registered' })
    }


    const conn = await pool.getConnection();
    try {
        var username = RANDOM_STRING(20);
        await pool.query("INSERT INTO `users`(`username`, `password`, `email`, `name`, `country_code`, `mobile`, `create_date`, `create_by`, `modify_date`, `modify_by`, `status`,`firm_name`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [username, password, email, name, country_code, mobile, TIMESTAMP(), username, TIMESTAMP(), username, '1', firm_name]);

        await conn.commit();

    } catch (error) {
        await conn.rollback();
        console.log(`Register error ${error}`);
        return res.status(200).json({ error: 'Failed to register' })
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
            }

            projects.push(project_object);
        });
    }

    const project_count = projects.length;


    return res.status(200).json({
        error: false,
        username: username,
        password,
        token: token,
        profile: {
            name,
            country_code,
            mobile,
            email: email,
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
        },
        balance,
        projects: {
            project_count,
            list: projects,
        },
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
    const name = decrypt?.name;
    const mobile = decrypt?.mobile;
    const gender = decrypt?.gender;
    const country_code = decrypt?.country_code;
    const firm_name = decrypt?.firm_name;
    const business_name = decrypt?.business_name;
    const business_type = decrypt?.business_type;


    if (!name || !mobile || !gender || !country_code || !firm_name || !business_name || !business_type) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    try {
        await pool.query(
            "UPDATE `users` SET `name`=?,`country_code`=?,`mobile`=?,`gender`=?,`firm_name`=?,`business_name`=?,`business_type`=?,`modify_date`=?,`modify_by`=? WHERE username = ?",
            [name, country_code, mobile, gender, firm_name, business_name, business_type, TIMESTAMP(), username, username]
        );

        const new_data = await USER_DATA(username);

        return res.status(200).json({
            error: false,
            profile: {
                name: new_data?.name,
                country_code: new_data?.country_code,
                mobile: new_data?.mobile,
                email: new_data?.email,
                gender: new_data?.gender,
                firm_name: new_data?.firm_name,
                business_name: new_data?.business_name,
                business_type: new_data?.business_type,
            },
            msg: 'Profile updated successfully'
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update profile'
        })
    }


});

router.post('/google-login', async (req, res) => {

    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);
    const google_token = decrypt.google_token;

    const client = new OAuth2Client(GOOGLE_CLIENT_ID);

    try {
        const ticket = await client.verifyIdToken({
            idToken: google_token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        const email = payload.email;

        const [check_row] = await pool.query("SELECT * FROM users WHERE email = ? AND status = ?", [email, '1']);

        if (check_row.length == 0) {
            return res.status(200).json({ error: 'Account not found on the google account' });
        }

        const user_data = check_row[0];
        const username = user_data?.username;
        const login_token = RANDOM_STRING(50);
        const name = user_data?.name;
        const country_code = user_data?.country_code;
        const mobile = user_data?.mobile;

        await pool.query("INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)", [username, TIMESTAMP(), username, TIMESTAMP(), username, login_token, FUTURE_TIMESTAMP(43200), '1']);

        const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

        const projects = [];

        if (project_row.length > 0) {
            project_row.forEach(element => {
                var project_object = {
                    name: element.project_name,
                    project_id: element.project_id,
                }

                projects.push(project_object);
            });
        }

        const project_count = projects.length;


        return res.status(200).json(
            {
                error: false,
                username,
                token: login_token,
                profile: {
                    name,
                    country_code,
                    mobile,
                    email,
                },
                project_count,
                projects: projects
            }
        );

    } catch (error) {
        return res.status(200).json({
            error: 'Google authentication failed',
            e: error
        });
    }
});

router.post('/google-register', async (req, res) => {

    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);
    const google_token = decrypt.google_token;

    const client = new OAuth2Client(GOOGLE_CLIENT_ID);


    const conn = await pool.getConnection();

    try {
        const ticket = await client.verifyIdToken({
            idToken: google_token,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        const email = payload.email;
        const name = payload.name;

        const [check_row] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);

        if (check_row.length > 0) {
            return res.status(200).json({ error: 'User already registered. Please signin with google' });
        }


        var username = RANDOM_STRING(20);
        var password = GENERATE_PASSWORD(8);
        await pool.query("INSERT INTO `users`(`username`, `password`, `email`, `name`, `create_date`, `create_by`, `modify_date`, `modify_by`, `status`) VALUES (?,?,?,?,?,?,?,?,?)", [username, password, email, name, TIMESTAMP(), username, TIMESTAMP(), username, '1']);


        const login_token = RANDOM_STRING(50);

        await pool.query("INSERT INTO `login_token`(`username`, `create_date`, `create_by`, `modify_date`, `modify_by`, `token`, `expire_date`, `status`) VALUES (?,?,?,?,?,?,?,?)", [username, TIMESTAMP(), username, TIMESTAMP(), username, login_token, FUTURE_TIMESTAMP(43200), '1']);


        const [project_row] = await pool.query("SELECT project_mapping.type, aisensy_projects.* FROM project_mapping JOIN aisensy_projects ON aisensy_projects.project_id = project_mapping.project_id WHERE project_mapping.username = ? AND project_mapping.is_deleted = ? AND aisensy_projects.status = ?", [username, '0', '1']);

        await conn.commit();

        const projects = [];

        if (project_row.length > 0) {
            project_row.forEach(element => {
                var project_object = {
                    name: element.project_name,
                    project_id: element.project_id,
                }

                projects.push(project_object);
            });
        }

        const project_count = projects.length;

        return res.status(200).json(
            {
                error: false,
                username,
                token: login_token,
                profile: {
                    name,
                    country_code: null,
                    mobile: null,
                    email,
                },
                project_count,
                projects: projects
            }
        );

    } catch (error) {
        await conn.rollback();
        return res.status(200).json({
            error: 'Google authentication failed',
            e: error
        });
    }
});

router.post("/session-check", auth, async (req, res) => {

    return res.status(200).json({
        error: false,
    });



});

router.post("/reset-password", async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const token = (decrypt?.token ?? "").toString().trim();
        const captcha_token = decrypt?.captcha_token;
        const password = decrypt?.password;

        if (!token) {
            return res.status(200).json({ error: "Token is required" });
        }
        if (!captcha_token) {
            return res.status(200).json({ error: "Captcha verification is required" });
        }
        if (!password) {
            return res.status(200).json({ error: "Password is required" });
        }

        const isValidCaptcha = await validateTurnstileToken(captcha_token, req.ip || req.socket?.remoteAddress);
        if (!isValidCaptcha) {
            return res.status(200).json({ error: "Captcha verification failed. Please try again." });
        }

        if (!IS_STRONG_PASSWORD(password)) {
            return res.status(200).json({ error: "Please provide a strong password" });
        }

        const [resetRows] = await pool.query(
            "SELECT * FROM password_resets WHERE token = ? AND status = ? AND expire_date > NOW()",
            [token, "0"]
        );
        if (resetRows.length === 0) {
            return res.status(200).json({ error: "Invalid or expired reset token. Please request a new password reset." });
        }

        const resetRow = resetRows[0];
        const username = resetRow.username;

        await pool.query("UPDATE users SET password = ?, modify_date = ?, modify_by = ? WHERE username = ?", [password, TIMESTAMP(), username, username]);
        await pool.query("UPDATE login_token SET status = ? WHERE username = ? AND status = ?", ["0", username, "1"]);
        await pool.query("UPDATE password_resets SET status = ? WHERE token = ?", ["1", token]);

        return res.status(200).json({
            error: false,
            msg: "Password reset successfully. Please login with your new password."
        });
    } catch (err) {
        console.error("[reset-password] Error:", err?.message || err);
        return res.status(200).json({ error: "Failed to reset password" });
    }
});

router.post("/reset-password-request", async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const email = (decrypt?.email ?? "").toString().trim();
        const captcha_token = decrypt?.captcha_token;

        if (!email) {
            return res.status(200).json({ error: "Email is required" });
        }
        if (!captcha_token) {
            return res.status(200).json({ error: "Captcha verification is required" });
        }

        const isValidCaptcha = await validateTurnstileToken(captcha_token, req.ip || req.socket?.remoteAddress);
        if (!isValidCaptcha) {
            return res.status(200).json({ error: "Captcha verification failed. Please try again." });
        }

        const [userRows] = await pool.query("SELECT username, name FROM users WHERE email = ? AND status = ?", [email, "1"]);
        if (userRows.length === 0) {
            return res.status(200).json({ error: false, msg: "If this email exists, a password reset link has been sent." });
        }

        const user = userRows[0];
        const username = user.username;
        const userName = user.name || "User";
        const token = RANDOM_STRING(50);
        const expire_date = FUTURE_TIMESTAMP(5);

        await pool.query(
            "INSERT INTO password_resets (username, email, create_date, create_ip, status, expire_date, token) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [username, email, TIMESTAMP(), req.ip || req.socket?.remoteAddress || null, "0", expire_date, token]
        );

        const sent = await sendPasswordResetEmail(email, token, userName);
        if (!sent) {
            return res.status(200).json({ error: "Failed to send reset email. Please try again later." });
        }

        return res.status(200).json({
            error: false,
            msg: "If this email exists, a password reset link has been sent."
        });
    } catch (err) {
        console.error("[password-reset] Error:", err?.message || err);
        return res.status(200).json({ error: "Failed to process request" });
    }
});

router.post("/change-password", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const old_password = decrypt?.old_password;
    const new_password = decrypt?.new_password;



    const is_strong = IS_STRONG_PASSWORD(new_password);

    if (is_strong == false) {
        return res.status(200).json({ error: 'Please provide a strong password' });
    }

    if (!old_password || !new_password) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    try {

        const [check_row] = await pool.query("SELECT * FROM users WHERE username = ? AND password = ?", [username, old_password]);
        if (check_row.length == 0) {
            return res.status(200).json({ error: 'Old password is wrong' });
        }

        await pool.query("UPDATE `users` SET `password`=?,`modify_date`=?,`modify_by`=? WHERE username = ?", [new_password, TIMESTAMP(), username, username]);

        await pool.query("UPDATE `login_token` SET status = '2' WHERE username = ? AND status = '1'", [username]);


        return res.status(200).json({
            error: false,
            msg: 'Password changed successfully'
        })

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to change password',
            e: error
        })
    }


});

export default router
