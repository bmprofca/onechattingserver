import express from "express";
const router = express.Router();
import pool from "../db.js";
import { GENERATE_PASSWORD, RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth } from "../middleware/auth.js";
import axios from "axios";
import { AISENSY_API_KEY, AISENSY_PARTNER_ID } from "../helpers/Config.js";

// login
router.post("/create-business", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_email = decrypt.project_email;
    const company_name = decrypt.company_name;
    const website = decrypt.website;
    const project_mobile = decrypt.project_mobile;

    if (!project_email || !company_name || !website || !project_mobile) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const project_password = GENERATE_PASSWORD(8);

    const options = {
        method: 'POST',
        url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/business`,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
        },
        data: {
            display_name: company_name,
            email: project_email,
            company: company_name,
            contact: project_mobile,
            timezone: 'Asia/Calcutta GMT+05:30',
            currency: 'INR',
            companySize: '1 - 10',
            password: project_password
        }
    };


    const conn = await pool.getConnection();


    try {
        const { data } = await axios.request(options);


        const business_id = data?.business_id;
        const display_name = data?.display_name;
        const business_email = data?.user_name;


        const project_id = data?.project_ids[0];

        if (project_id) {
            // INSERT PROJECT
            await pool.query("INSERT INTO `aisensy_projects`(`unique_id`, `project_id`, `project_name`, `business_id`, `create_date`, `create_by`, `modify_date`, `modify_by`, `status`) VALUES (?,?,?,?,?,?,?,?,?)", [RANDOM_STRING(20), project_id, display_name, business_id, TIMESTAMP(), username, TIMESTAMP(), username, '1']);
        }


        // INSERT BUSINESS
        await pool.query("INSERT INTO `aisensy_businesses`(`unique_id`, `business_email`, `business_id`, `password`, `username`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?,?,?,?)", [RANDOM_STRING(20), business_email, business_id, project_password, username, TIMESTAMP(), username, TIMESTAMP(), username]);

        await conn.commit();

        return res.status(200).json({
            error: false,
            msg: "Business created successfully"
        })
    } catch (error) {
        await conn.rollback();
        if (error.response) {
            console.log(error.response);

            return res.status(200).json({
                error: error?.response?.data?.message,
            })
        } else {

            return res.status(200).json({
                error: 'Failed to create business',
            })
        }
    }

});

export default router
