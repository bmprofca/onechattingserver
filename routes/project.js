import express from "express";
const router = express.Router();
import pool from "../db.js";
import { AISENSY_PROJECT_DATA, GENERATE_EMAIL_ADDRESS, GENERATE_PASSWORD, GET_ADMIN_OF_PROJECT, GET_BALANCE, GET_BALANCE_BY_USERNAME, GetAiSensyProjectToken, RANDOM_STRING, TIMESTAMP, TODAY_DATE, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import axios from "axios";
import { AISENSY_API_KEY, AISENSY_PARTNER_ID, BASE_DOMAIN, TEMPLATE_CHARGES } from "../helpers/Config.js";

router.post("/embed-signup", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    // CHECK IF PROJECT IS OWNER OF THE USER
    const [check_mapping] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND type = ?", [project_id, username, 'admin']);

    if (check_mapping.length !== 1) {
        return res.status(200).json({ error: 'Unauthorized Access' })
    }

    // CODE FOR FETCH AISENSY

    const project_data = await AISENSY_PROJECT_DATA(project_id);

    if (!project_data) {
        return res.status(200).json({ error: 'Can not get project data from database' });
    }

    const business_id = project_data.business_id;

    const options = {
        method: 'POST',
        url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/generate-waba-link`,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
        },
        data: {
            businessId: business_id,
            assistantId: project_id,
        }
    };

    try {
        const { data } = await axios.request(options);
        const url = data?.embeddedSignupURL;
        return res.status(200).json({
            error: false,
            url
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to get embed URL',
        })
    }

});

router.post("/submit-waba-id", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    console.log("Waba submit payload");
    console.log(decrypt);

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const waba_id = decrypt?.waba_id;
    if (!project_id || !waba_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    // CHECK IF PROJECT IS OWNER OF THE USER
    const [check_mapping] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND type = ?", [project_id, username, 'admin']);

    if (check_mapping.length !== 1) {
        return res.status(200).json({ error: 'Unauthorized Access' })
    }


    const options = {
        method: 'POST',
        url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/submit-facebook-access-token`,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
        },
        data: { assistantId: project_id, wabaAppId: waba_id }
    };

    try {
        await axios.request(options);
        return res.status(200).json({ error: false, msg: 'WABA connected successfully' });
    } catch (error) {
        // Check if error response has a message field
        const errorMessage = error?.response?.data?.message || 'Failed to connect WABA';
        return res.status(200).json({ error: errorMessage });
    }


});

router.post("/waba-information", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    // CHECK IF PROJECT IS OWNER OF THE USER
    const [check_mapping] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND type = ?", [project_id, username, 'admin']);

    if (check_mapping.length !== 1) {
        return res.status(200).json({ error: 'Unauthorized Access' })
    }


    const project_token = await GetAiSensyProjectToken(project_id);

    if (!project_token) {
        return res.status(200).json({ error: "Failed to get project token" });
    }


    const options = {
        method: 'GET',
        url: 'https://backend.aisensy.com/direct-apis/t1/get-business-info',
        headers: {
            Accept: 'application/json',
            Authorization: 'Bearer ' + project_token
        }
    };

    try {
        const { data } = await axios.request(options);

        const account_review_status = data?.data?.account_review_status;
        const business_verification_status = data?.data?.business_verification_status;
        const name = data?.data?.name;
        const business_name = data?.data?.on_behalf_of_business_info?.name;
        const business_status = data?.data?.on_behalf_of_business_info?.status;

        return res.status(200).json({
            error: false,
            account_review_status,
            business_verification_status,
            name,
            business_info: {
                name: business_name,
                status: business_status
            }
        })
    } catch (error) {
        console.log(error);

        return res.status(200).json({
            error: 'Failed to get WABA information',
        })
    }

});

router.post("/dashboard", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const [contact_row] = await pool.query("SELECT * FROM contacts WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
    const [message_row] = await pool.query("SELECT * FROM messages WHERE project_id = ?", [project_id]);
    const [today_out_row] = await pool.query("SELECT * FROM messages WHERE project_id = ? AND status IN (?) AND DATE(create_date) = ?", [project_id, ['sent', 'delivered', 'read'], TODAY_DATE()]);
    const [chat_row] = await pool.query("SELECT * FROM messages WHERE project_id = ? GROUP BY number", [project_id]);


    const [campaign_row] = await pool.query("SELECT * FROM `campaigns` WHERE project_id = ?", [project_id]);


    const [campaign_message_row] = await pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending, SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent, SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered, SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS \`read\`, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed FROM campaign_messages WHERE project_id = ? AND status != 'failed'`, [project_id]);

    const total_messages = Number(campaign_message_row[0]?.total);
    const pending_messages = Number(campaign_message_row[0]?.pending);
    const sent_messages = Number(campaign_message_row[0]?.sent);
    const delivered_messages = Number(campaign_message_row[0]?.delivered);
    const read_messages = Number(campaign_message_row[0]?.read);
    const failed_messages = Number(campaign_message_row[0]?.failed);

    const [template_row] = await pool.query(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'APPROVED' THEN 1 ELSE 0 END) AS approved, SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected, SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending FROM templates WHERE project_id = ? AND is_deleted = '0'`, [project_id]);

    const total_template = Number(template_row[0]?.total);
    const approved_template = Number(template_row[0]?.approved);
    const pending_template = Number(template_row[0]?.pending);
    const rejected_template = Number(template_row[0]?.rejected);

    return res.status(200).json({
        error: false,
        data: {
            campaign: {
                total: campaign_row.length,
                message: {
                    total: total_messages,
                    pending: pending_messages,
                    sent: sent_messages,
                    delivered: delivered_messages,
                    failed: failed_messages,
                    read: read_messages,
                }
            },
            template: {
                total: total_template,
                pending: pending_template,
                approved: approved_template,
                rejected: rejected_template,
            },
            contact: {
                total: contact_row.length
            },
            chat: {
                total: chat_row.length,
            },
            message: {
                total: message_row.length,
                today_sent: today_out_row.length
            }
        }
    })


});

const GetPermissionStatus = async (permission_id, permission) => {
    const [row] = await pool.query("SELECT * FROM `permission_options` WHERE `permission_id` = ? AND permission = ?", [permission_id, permission]);

    if (row.length > 0) {
        const data = row[0];
        if (data?.status == '1') {
            return true;
        } else {
            return false;
        }
    } else {
        return false;
    }
}

router.post("/info", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const [admin_row] = await pool.query("SELECT * FROM `project_mapping` WHERE `project_id` = ? AND `type` = ? AND `is_deleted` = ?", [project_id, 'admin', '0']);

    if (admin_row.length !== 1) {
        return res.status(200).json({ error: 'Project not found' });
    }
    const admin_username = admin_row[0]?.username;

    var permissions = {
        create_contact: false,
        edit_contact: false,
        delete_contact: false,
        view_contact: false,
        create_template: false,
        edit_template: false,
        delete_template: false,
        view_all_chat: false,
        broadcast_access: false,
        setting_access: false,
        chat_assign_access: false,
    };

    if (admin_username == username) {
        permissions.create_contact = true;
        permissions.edit_contact = true;
        permissions.delete_contact = true;
        permissions.view_contact = true;
        permissions.create_template = true;
        permissions.edit_template = true;
        permissions.delete_template = true;
        permissions.view_all_chat = true;
        permissions.broadcast_access = true;
        permissions.setting_access = true;
        permissions.chat_assign_access = true;
        var owned = true;
    } else {
        var owned = false;
        const [self_project_mapping] = await pool.query("SELECT * FROM `project_mapping` WHERE `username` = ? AND `project_id` = ?", [username, project_id]);
        const self_project = self_project_mapping[0];
        const permission_id = self_project?.permission_id;

        const create_contact = await GetPermissionStatus(permission_id, 'create contact');
        const edit_contact = await GetPermissionStatus(permission_id, 'edit contact');
        const delete_contact = await GetPermissionStatus(permission_id, 'delete contact');
        const view_contact = await GetPermissionStatus(permission_id, 'view contact');
        const create_template = await GetPermissionStatus(permission_id, 'create template');
        const edit_template = await GetPermissionStatus(permission_id, 'edit template');
        const delete_template = await GetPermissionStatus(permission_id, 'delete template');
        const view_all_chat = await GetPermissionStatus(permission_id, 'view all chat');
        const broadcast_access = await GetPermissionStatus(permission_id, 'broadcast access');
        const setting_access = await GetPermissionStatus(permission_id, 'setting access');
        const chat_assign_access = await GetPermissionStatus(permission_id, 'chat assign access');

        permissions.create_contact = create_contact;
        permissions.edit_contact = edit_contact;
        permissions.delete_contact = delete_contact;
        permissions.view_contact = view_contact;
        permissions.create_template = create_template;
        permissions.edit_template = edit_template;
        permissions.delete_template = delete_template;
        permissions.view_all_chat = view_all_chat;
        permissions.broadcast_access = broadcast_access;
        permissions.setting_access = setting_access;
        permissions.chat_assign_access = chat_assign_access;

    }


    const project_data = await AISENSY_PROJECT_DATA(project_id);


    return res.status(200).json({
        error: false,
        project: {
            name: project_data?.project_name,
            owned,
            project_id,
            status: project_data?.status == '1' ? true : false,
            charges: {
                marketing: Number(project_data?.marketing_charge),
                utility: Number(project_data?.utility_charge),
                authentication: Number(project_data?.authentication_charge),
            }
        },
        permissions
    })

});

router.post("/meta-details", auth, async (req, res) => {
    try {
        const data = req.body?.data || '';
        const key = req.body?.key || '';

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const project_id = decrypt?.project_id;
        if (!project_id) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }

        // NOTE: username is not used right now but kept for future access control
        const _username = req.headers["username"] ? req.headers["username"] : '';

        const project_token = await GetAiSensyProjectToken(project_id);
        if (!project_token) {
            return res.status(200).json({ error: 'Failed to get project token' });
        }

        const project_data = await AISENSY_PROJECT_DATA(project_id);
        const wa_display_image = project_data?.profile_picture;

        const res_data = {
            is_waba_connected: false,
            project: null,
            profile: null,
            charges: {
                marketing: Number(project_data?.marketing_charge),
                utility: Number(project_data?.utility_charge),
                authentication: Number(project_data?.authentication_charge),
            }
        };

        // Fetch project details from partner API
        const partnerOptions = {
            method: 'GET',
            url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/project/${project_id}`,
            headers: {
                Accept: 'application/json',
                'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
            }
        };

        let partnerData = null;
        try {
            const { data: partnerResp } = await axios.request(partnerOptions);
            partnerData = partnerResp || {};
        } catch (error) {
            console.error("[meta-details] Partner API error", { project_id, message: error?.message, response: error?.response?.data });
            res_data.project = { error: 'Error in fetching project details' };

            return res.status(200).json({ error: false, data: res_data });
        }

        const {
            name,
            status,
            wa_number,
            wa_messaging_tier,
            wa_display_name_status,
            fb_business_manager_status,
            wa_display_name,
            wa_quality_rating,
            wa_about,
            billing_currency,
            timezone,
            is_whatsapp_verified,
            daily_template_limit,
            wa_business_profile,
        } = partnerData;

        res_data.project = {
            error: false,
            name,
            status,
            wa_messaging_tier,
            wa_display_name_status,
            fb_business_manager_status,
            wa_display_name,
            wa_quality_rating,
            billing_currency,
            timezone,
            is_whatsapp_verified,
            daily_template_limit,
        };



        res_data.is_waba_connected = !!is_whatsapp_verified;
        await pool.query(
            "UPDATE `aisensy_projects` SET `is_waba_connected`=? WHERE project_id = ?",
            [res_data.is_waba_connected ? '1' : '0', project_id]
        );

        if (wa_business_profile) {
            res_data.profile = {
                about: wa_about,
                description: wa_business_profile?.description,
                profile_picture_url: wa_display_image,
                email: wa_business_profile?.email,
                websites: wa_business_profile?.websites,
                vertical: wa_business_profile?.vertical,
                address: wa_business_profile?.address,
                wa_number
            };

            // Best-effort webhook update (don't fail meta-details if it fails)
            const webhookOptions = {
                method: 'PATCH',
                url: 'https://backend.aisensy.com/direct-apis/t1/settings/update-webhook',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${project_token}`
                },
                data: { webhooks: { url: `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}` } }
            };

            try {
                await axios.request(webhookOptions);
                await pool.query(
                    "UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?",
                    [`${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`, project_id]
                );
            } catch (error) {
                console.error("[meta-details] Webhook subscription error", { project_id, message: error?.message, response: error?.response?.data });
                await pool.query(
                    "UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?",
                    ["", project_id]
                );
            }
        }

        return res.status(200).json({ error: false, data: res_data });
    } catch (error) {
        console.error("[meta-details] Unexpected error", { message: error?.message, stack: error?.stack });
        return res.status(200).json({ error: 'Failed to get project meta details' });
    }

});

function getEndDateFromStart(startDateStr, packageId) {
    const days = packageId === 'PROJECT_1M' ? 30 : packageId === 'PROJECT_1Y' ? 365 : null;
    if (days == null) return null;
    const d = new Date(startDateStr);
    d.setDate(d.getDate() + days);
    return d.toISOString().split('T')[0];
}

router.post("/create-project", auth, async (req, res) => {

    let connection;
    try {

        connection = await pool.getConnection();

        await connection.beginTransaction();

        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        } else {
            console.warn('⚠️ No request body received');
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            console.error('❌ Decryption failed - data:', data, 'key:', key);
            await connection.rollback();
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req.headers["username"] ? req.headers["username"] : '';
        const company_name = decrypt?.company_name;
        const project_name = decrypt?.project_name;
        const package_id = decrypt?.package_id;

        if (!company_name || !project_name || !package_id) {
            await connection.rollback();
            return res.status(200).json({ error: 'Provide all mandatory fields' });
        }

        const [package_row] = await connection.query("SELECT * FROM package WHERE package_id = ?", [package_id]);

        if (package_row.length == 0) {
            await connection.rollback();
            return res.status(200).json({
                error: 'Please provide valid package id'
            });
        }

        const package_data = package_row[0];
        let price = Number(package_data?.amount ?? 0);

        const [custom_row] = await connection.query(
            "SELECT monthly, yearly FROM custom_package WHERE username = ? LIMIT 1",
            [username]
        );
        if (custom_row && custom_row.length > 0) {
            const custom = custom_row[0];
            price = package_id === 'PROJECT_1M' ? Number(custom.monthly ?? price) : package_id === 'PROJECT_1Y' ? Number(custom.yearly ?? price) : price;
        }

        const balance = await GET_BALANCE_BY_USERNAME(username);
        if (balance < price) {
            return res.status(402).json({
                error: 'Insufficient balance'
            })
        }





        const user_data = await USER_DATA(username);

        const country_code = user_data?.country_code;
        const mobile = user_data?.mobile;

        if (country_code == '' || mobile == '') {
            await connection.rollback();
            return res.status(200).json({ error: 'Please add mobile number in your profile before creating project' });
        }

        const [business_row] = await connection.query("SELECT * FROM aisensy_businesses WHERE username = ?", [username]);

        let business_id;
        let business_email = GENERATE_EMAIL_ADDRESS();
        let business_password = GENERATE_PASSWORD(8);


        // BUSINESS CREATE
        if (business_row.length == 0) {
            try {
                const options = {
                    method: 'POST',
                    url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/business`,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                    },
                    data: {
                        display_name: project_name,
                        email: business_email,
                        company: company_name,
                        contact: `${country_code}${mobile}`,
                        timezone: 'Asia/Calcutta GMT+05:30',
                        currency: 'INR',
                        companySize: '10 - 20',
                        password: business_password
                    }
                };

                const { data } = await axios.request(options);

                if (data?.id) {
                    business_id = data?.id;

                    const unique_id = RANDOM_STRING(30);
                    await connection.query("INSERT INTO `aisensy_businesses`(`unique_id`, `business_email`, `business_id`, `password`, `username`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?,?,?,?)", [unique_id, business_email, data?.id, business_password, username, TIMESTAMP(), username, TIMESTAMP(), username]);
                } else {
                    console.error('❌ Business creation failed - no ID in response');
                    throw new Error('Business creation failed - no ID received');
                }

            } catch (error) {
                console.error('❌ BUSINESS CREATION ERROR:');
                console.error('Error Message:', error.message);
                console.error('Error Stack:', error.stack);

                if (error.response) {
                    console.error('Response Status:', error.response.status);
                    console.error('Response Data:', error.response.data);
                    console.error('Response Headers:', error.response.headers);
                } else if (error.request) {
                    console.error('No Response Received - Request:', error.request);
                } else {
                    console.error('Error Config:', error.config);
                }

                console.error('Business creation failed with credentials:', {
                    email: business_email,
                    company: company_name,
                    contact: `${user_data?.country_code}${user_data?.mobile}`
                });

                await connection.rollback();
                return res.status(200).json({
                    error: 'Failed to create business'
                });
            }
        } else {
            const business_data = business_row[0];
            business_id = business_data?.business_id;
            business_email = business_data?.business_email;
            business_password = business_data?.password;

        }

        // PROJECT CREATE & MAPPING
        let project_id;
        try {
            const options = {
                method: 'POST',
                url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/business/${business_id}/project`,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                },
                data: { name: project_name }
            };


            const { data } = await axios.request(options);
            project_id = data?.id;

            const unique_id = RANDOM_STRING(30);
            await connection.query("INSERT INTO `aisensy_projects`(`unique_id`, `project_id`, `project_name`, `business_id`, `create_date`, `create_by`, `modify_date`, `modify_by`, `marketing_charge`, `utility_charge`, `authentication_charge`, `status`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, project_name, business_id, TIMESTAMP(), username, TIMESTAMP(), username, TEMPLATE_CHARGES.marketing, TEMPLATE_CHARGES.utility, TEMPLATE_CHARGES.authentication, '1']);

            const map_id = RANDOM_STRING(30);
            await connection.query("INSERT INTO `project_mapping`(`unique_id`, `project_id`, `username`, `type`, `create_by`, `create_date`, `modify_by`, `modify_date`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?,?)", [map_id, project_id, username, 'admin', username, TIMESTAMP(), username, TIMESTAMP(), '0']);

        } catch (error) {
            console.error('❌ PROJECT CREATION & MAPPING ERROR:');

            await connection.rollback();
            return res.status(200).json({ error: error?.response?.data?.message || 'Failed to create project or project mapping' });
        }

        // PROJECT TOKEN
        try {
            const base64_econded = Buffer.from(`${business_email}:${business_password}:${project_id}`).toString("base64");
            const options3 = {
                method: 'POST',
                url: 'https://backend.aisensy.com/direct-apis/t1/users/regenrate-token',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${base64_econded}`
                },
                data: { direct_api: true }
            };


            const { data } = await axios.request(options3);

            const token = data?.users[0]?.token;

            if (!token) {
                console.error('❌ Token not found in response. Full response:', data);
                throw new Error('Token not received from API');
            }


            await connection.query("INSERT INTO `aisensy_token`(`project_id`, `token`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?)", [project_id, token, TIMESTAMP(), username, TIMESTAMP(), username]);

        } catch (error) {
            console.error('❌ TOKEN GENERATION ERROR:');
            console.error('Error Message:', error.message);
            console.error('Error Stack:', error.stack);

            if (error.response) {
                console.error('Response Status:', error.response.status);
                console.error('Response Headers:', error.response.headers);
                console.error('Response Data:', error.response.data);
                console.error('Response Status Text:', error.response.statusText);
            } else if (error.request) {
                console.error('No response received. Request details:', {
                    method: error.request.method,
                    path: error.request.path,
                    host: error.request.host
                });
            } else {
                console.error('Error Config:', error.config);
            }

            await connection.rollback();
            return res.status(200).json({
                error: 'Failed to create project token'
            });
        }

        const start_date = TODAY_DATE();
        const end_date = getEndDateFromStart(start_date, package_id);

        const subscription_id = RANDOM_STRING(30);
        const transaction_id = RANDOM_STRING(30);

        await connection.query("INSERT INTO `transactions`(`transaction_id`, `username`, `create_date`, `create_by`, `type`, `transaction_type`, `amount`, `value_1`, `value_2`,`value_3`) VALUES (?,?,?,?,?,?,?,?,?,?)", [transaction_id, username, TIMESTAMP(), username, '0', 'project create', price, 'subscription', 'project', subscription_id]);

        await connection.query("INSERT INTO `user_package`(`subscription_id`, `username`, `package_id`, `start_date`, `end_date`, `create_date`, `create_by`, `modify_date`, `modify_by`,`project_id`) VALUES (?,?,?,?,?,?,?,?,?,?)", [subscription_id, username, package_id, start_date, end_date, TIMESTAMP(), username, TIMESTAMP(), username, project_id]);

        // If everything is successful, commit the transaction
        await connection.commit();

        return res.status(200).json({
            error: false,
            msg: 'Project created successfully',
            data: {
                name: project_name,
                project_id,
            }
        });

    } catch (error) {
        console.error('❌ UNHANDLED ERROR IN CREATE-PROJECT:');
        console.error('Error Name:', error.name);
        console.error('Error Message:', error.message);
        console.error('Error Stack:', error.stack);
        console.error('Error Code:', error.code);

        // Rollback in case of any error
        if (connection) {
            await connection.rollback();
        }

        return res.status(200).json({
            error: 'Internal server error'
        });
    } finally {
        // Release the connection back to the pool
        if (connection) {
            connection.release();
        }
    }
});

router.post("/edit-project", auth, async (req, res) => {
    let connection;
    try {

        connection = await pool.getConnection();

        await connection.beginTransaction();

        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        } else {
            console.warn('⚠️ No request body received');
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            console.error('❌ Decryption failed - data:', data, 'key:', key);
            await connection.rollback();
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req.headers["username"] ? req.headers["username"] : '';
        const company_name = decrypt?.company_name;
        const project_name = decrypt?.project_name;


        if (!company_name || !project_name) {
            await connection.rollback();
            return res.status(200).json({ error: 'Provide all mandatory fields' });
        }


        const user_data = await USER_DATA(username);

        const country_code = user_data?.country_code;
        const mobile = user_data?.mobile;

        if (country_code == '' || mobile == '') {
            await connection.rollback();
            return res.status(200).json({ error: 'Please add mobile number in your profile before creating project' });
        }

        const [business_row] = await connection.query("SELECT * FROM aisensy_businesses WHERE username = ?", [username]);

        let business_id;
        let business_email = GENERATE_EMAIL_ADDRESS();
        let business_password = GENERATE_PASSWORD(8);


        // BUSINESS CREATE
        if (business_row.length == 0) {
            try {
                const options = {
                    method: 'POST',
                    url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/business`,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                    },
                    data: {
                        display_name: project_name,
                        email: business_email,
                        company: company_name,
                        contact: `${country_code}${mobile}`,
                        timezone: 'Asia/Calcutta GMT+05:30',
                        currency: 'INR',
                        companySize: '10 - 20',
                        password: business_password
                    }
                };

                const { data } = await axios.request(options);

                if (data?.id) {
                    business_id = data?.id;

                    const unique_id = RANDOM_STRING(30);
                    await connection.query("INSERT INTO `aisensy_businesses`(`unique_id`, `business_email`, `business_id`, `password`, `username`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?,?,?,?)", [unique_id, business_email, data?.id, business_password, username, TIMESTAMP(), username, TIMESTAMP(), username]);
                } else {
                    console.error('❌ Business creation failed - no ID in response');
                    throw new Error('Business creation failed - no ID received');
                }

            } catch (error) {
                console.error('❌ BUSINESS CREATION ERROR:');
                console.error('Error Message:', error.message);
                console.error('Error Stack:', error.stack);

                if (error.response) {
                    console.error('Response Status:', error.response.status);
                    console.error('Response Data:', error.response.data);
                    console.error('Response Headers:', error.response.headers);
                } else if (error.request) {
                    console.error('No Response Received - Request:', error.request);
                } else {
                    console.error('Error Config:', error.config);
                }

                console.error('Business creation failed with credentials:', {
                    email: business_email,
                    company: company_name,
                    contact: `${user_data?.country_code}${user_data?.mobile}`
                });

                await connection.rollback();
                return res.status(200).json({
                    error: 'Failed to create business'
                });
            }
        } else {
            const business_data = business_row[0];
            business_id = business_data?.business_id;
            business_email = business_data?.business_email;
            business_password = business_data?.password;

        }

        // PROJECT CREATE & MAPPING
        let project_id;
        try {
            const options = {
                method: 'POST',
                url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/business/${business_id}/project`,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                },
                data: { name: project_name }
            };


            const { data } = await axios.request(options);
            project_id = data?.id;

            const unique_id = RANDOM_STRING(30);
            await connection.query("INSERT INTO `aisensy_projects`(`unique_id`, `project_id`, `project_name`, `business_id`, `create_date`, `create_by`, `modify_date`, `modify_by`, `marketing_charge`, `utility_charge`, `authentication_charge`, `status`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, project_name, business_id, TIMESTAMP(), username, TIMESTAMP(), username, TEMPLATE_CHARGES.marketing, TEMPLATE_CHARGES.utility, TEMPLATE_CHARGES.authentication, '1']);

            const map_id = RANDOM_STRING(30);
            await connection.query("INSERT INTO `project_mapping`(`unique_id`, `project_id`, `username`, `type`, `create_by`, `create_date`, `modify_by`, `modify_date`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?,?)", [map_id, project_id, username, 'admin', username, TIMESTAMP(), username, TIMESTAMP(), '0']);

        } catch (error) {
            console.error('❌ PROJECT CREATION & MAPPING ERROR:');
            console.error('Error Message:', error.message);
            console.error('Error Stack:', error.stack);

            if (error.response) {
                console.error('Response Status:', error.response.status);
                console.error('Response Data:', error.response.data);
                console.error('Response Headers:', error.response.headers);
            } else if (error.request) {
                console.error('No Response Received - Request:', error.request);
            } else {
                console.error('Error Config:', error.config);
            }

            await connection.rollback();
            return res.status(200).json({ error: 'Failed to create project or project mapping' });
        }

        // PROJECT TOKEN
        try {
            const base64_econded = Buffer.from(`${business_email}:${business_password}:${project_id}`).toString("base64");
            const options3 = {
                method: 'POST',
                url: 'https://backend.aisensy.com/direct-apis/t1/users/regenrate-token',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Authorization: `Bearer ${base64_econded}`
                },
                data: { direct_api: true }
            };


            const { data } = await axios.request(options3);

            const token = data?.users[0]?.token;

            if (!token) {
                console.error('❌ Token not found in response. Full response:', data);
                throw new Error('Token not received from API');
            }


            await connection.query("INSERT INTO `aisensy_token`(`project_id`, `token`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?)", [project_id, token, TIMESTAMP(), username, TIMESTAMP(), username]);

        } catch (error) {
            console.error('❌ TOKEN GENERATION ERROR:');
            console.error('Error Message:', error.message);
            console.error('Error Stack:', error.stack);

            if (error.response) {
                console.error('Response Status:', error.response.status);
                console.error('Response Headers:', error.response.headers);
                console.error('Response Data:', error.response.data);
                console.error('Response Status Text:', error.response.statusText);
            } else if (error.request) {
                console.error('No response received. Request details:', {
                    method: error.request.method,
                    path: error.request.path,
                    host: error.request.host
                });
            } else {
                console.error('Error Config:', error.config);
            }

            console.error('Failed Request Details:', {
                url: 'https://backend.aisensy.com/direct-apis/t1/users/regenrate-token',
                method: 'POST',
                auth_credentials: {
                    business_email,
                    project_id,
                    password_length: business_password?.length
                }
            });

            await connection.rollback();
            return res.status(200).json({
                error: 'Failed to create project token'
            });
        }

        // If everything is successful, commit the transaction
        await connection.commit();

        return res.status(200).json({
            error: false,
            msg: 'Project created successfully',
            data: {
                name: project_name,
                project_id,
            }
        });

    } catch (error) {
        console.error('❌ UNHANDLED ERROR IN CREATE-PROJECT:');
        console.error('Error Name:', error.name);
        console.error('Error Message:', error.message);
        console.error('Error Stack:', error.stack);
        console.error('Error Code:', error.code);

        // Rollback in case of any error
        if (connection) {
            await connection.rollback();
        }

        return res.status(200).json({
            error: 'Internal server error'
        });
    } finally {
        // Release the connection back to the pool
        if (connection) {
            connection.release();
        }
    }
});

router.post("/update-waba-profile-picture", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const profile_picture = decrypt.profile_picture;

    console.log(profile_picture);


    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const admin_of_project = await GET_ADMIN_OF_PROJECT(project_id);

    if (username != admin_of_project) {
        return res.status(200).json({ error: 'You are not authorized' });
    }


    const options = {
        method: 'PATCH',
        url: 'https://backend.aisensy.com/direct-apis/t1/update-profile-picture',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            whatsAppDisplayImage: profile_picture
        }
    };

    console.log({
        method: 'PATCH',
        url: 'https://backend.aisensy.com/direct-apis/t1/update-profile-picture',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            whatsAppDisplayImage: profile_picture
        }
    });


    try {
        const { data } = await axios.request(options);
        if (data?.profileData?.whatsAppDisplayImage) {
            await pool.query("UPDATE aisensy_projects SET profile_picture = ? WHERE project_id = ?", [profile_picture, project_id]);
        }


        return res.status(200).json({
            error: false,
            msg: 'Profile picture updated successfully'
        })
    } catch (error) {

        return res.status(200).json({
            error: "Failed to update profile picture",
            e: error?.response?.data
        })
    }


});

router.post("/update-waba-profile-details", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }



    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const about = decrypt.about || "";
    const description = decrypt.description || "";
    const vertical = decrypt.vertical || "";
    const email = decrypt.email || "";
    const websites = decrypt.websites;
    const address = decrypt.address || "";
    const profile_picture = decrypt.profile_picture || "";

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const admin_of_project = await GET_ADMIN_OF_PROJECT(project_id);

    if (username != admin_of_project) {
        return res.status(200).json({ error: 'You are not authorized' });
    }


    const options = {
        method: 'PATCH',
        url: 'https://backend.aisensy.com/direct-apis/t1/update-profile',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${project_token}`
        },
        data: {
            whatsAppAbout: about,
            address: address,
            description: description,
            vertical: vertical,
            email: email,
            websites: websites,
            whatsAppDisplayImage: profile_picture
        }
    };

    try {
        await axios.request(options);
        await pool.query("UPDATE aisensy_projects SET profile_picture = ? WHERE project_id = ?", [profile_picture, project_id]);
        return res.status(200).json({
            error: false,
            msg: 'Profile details updated successfully'
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update profile details',
            e: error?.response?.data
        })
    }
});

router.post("/auto-case-create-status", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req.headers["username"] ? req.headers["username"] : '';
        const project_id = decrypt.project_id;

        if (!project_id) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }


        const project_token = await GetAiSensyProjectToken(project_id);
        if (!project_token) {
            return res.status(200).json({ error: 'Failed to get project token' });
        }

        const admin_of_project = await GET_ADMIN_OF_PROJECT(project_id);

        if (username != admin_of_project) {
            return res.status(200).json({ error: 'You are not authorized' });
        }

        const aisensy_project_data = await AISENSY_PROJECT_DATA(project_id);
        if (!aisensy_project_data) {
            return res.status(200).json({ error: 'Failed to get project data' });
        }

        const status = aisensy_project_data.auto_case_create;
        if (status == "1") {
            return res.status(200).json({
                error: false,
                status: true,
                msg: 'Auto case create is active'
            });
        } else {
            return res.status(200).json({
                error: false,
                status: false,
                msg: 'Auto case create is deactive'
            });
        }
    } catch (error) {
        return res.status(200).json({
            error: 'Internal server error',
            e: error?.message || error
        });
    }


});

router.post("/update-auto-case-create", auth, async (req, res) => {
    try {
        if (req.body && Object.keys(req.body).length > 0) {
            var data = req.body?.data || '';
            var key = req.body?.key || '';
        }

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }

        const username = req.headers["username"] ? req.headers["username"] : '';
        const project_id = decrypt.project_id;
        const action = decrypt.action || "deactive";

        if (!project_id || !action) {
            return res.status(200).json({ error: 'Provide all mandetory fields' });
        }


        const project_token = await GetAiSensyProjectToken(project_id);
        if (!project_token) {
            return res.status(200).json({ error: 'Failed to get project token' });
        }

        const admin_of_project = await GET_ADMIN_OF_PROJECT(project_id);

        if (username != admin_of_project) {
            return res.status(200).json({ error: 'You are not authorized' });
        }

        if (action == "active") {
            await pool.query(`UPDATE aisensy_projects SET auto_case_create = "1", modify_date = ?, modify_by = ? WHERE project_id = ?`, [TIMESTAMP(), username, project_id]);
        } else {
            await pool.query(`UPDATE aisensy_projects SET auto_case_create = "0", modify_date = ?, modify_by = ? WHERE project_id = ?`, [TIMESTAMP(), username, project_id]);
        }

        return res.status(200).json({
            error: false,
            msg: 'Auto case create updated successfully'
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Internal server error',
            e: error?.message || error
        });
    }


});

export default router
