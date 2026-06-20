import pool from "../db.js";
import { GetAiSensyProjectToken } from "./function.js";
import axios from "axios";
import { BASE_DOMAIN } from "./Config.js";

async function SetWebhookSubscription() {

    const [rows] = await pool.query("SELECT * FROM aisensy_projects WHERE webhook_url = ''", []);

    for (let index = 0; index < rows.length; index++) {
        const element = rows[index];

        const project_id = element?.project_id;



        const project_token = await GetAiSensyProjectToken(project_id);

        const options = {
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
            await axios.request(options);
            await pool.query("UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?", [`${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`, project_id]);
        } catch (error) {
            console.error("[partner-webhook] Webhook subscription error", { project_id, message: error?.message, response: error?.response?.data });
        }

        await pool.query("UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?", [`${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`, project_id]);


    }

}

export default SetWebhookSubscription;