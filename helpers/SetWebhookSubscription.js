import pool from "../db.js";
import { GetAiSensyProjectToken } from "./function.js";
import axios from "axios";
import { BASE_DOMAIN } from "./Config.js";

async function SetWebhookSubscription() {
    const [rows] = await pool.query(
        "SELECT project_id FROM aisensy_projects WHERE webhook_url = '' OR webhook_url IS NULL"
    );

    for (const element of rows) {
        const project_id = element?.project_id;
        const project_token = await GetAiSensyProjectToken(project_id);

        if (!project_token) {
            continue;
        }

        const webhookUrl = `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`;
        const options = {
            method: "PATCH",
            url: "https://backend.aisensy.com/direct-apis/t1/settings/update-webhook",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
                Authorization: `Bearer ${project_token}`,
            },
            data: { webhooks: { url: webhookUrl } },
        };

        try {
            await axios.request(options);
            await pool.query(
                "UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?",
                [webhookUrl, project_id]
            );
        } catch (error) {
            console.error("[partner-webhook] Webhook subscription error", {
                project_id,
                message: error?.message,
                response: error?.response?.data,
            });
        }
    }
}

export default SetWebhookSubscription;
