import axios from "axios";
import pool from "../../db.js";
import { GetAiSensyProjectToken, RANDOM_STRING, TIMESTAMP } from "../function.js";
import { WsIo } from "../../server.js";
import {
    buildTemplateDisplayMessage,
    expandTemplateMediaUrls,
    loadTemplateFromDb,
} from "../templateStorage.js";

/** In-memory lock: only one InitiateCampaignMessages per campaign at a time (prevents duplicate sends) */
const processingCampaigns = new Set();

const InitiateCampaignMessages = async ({ campaign_id }) => {
    if (processingCampaigns.has(campaign_id)) {
        return; // Already sending for this campaign
    }
    processingCampaigns.add(campaign_id);
    try {
        const [check_row] = await pool.query("SELECT * FROM campaigns WHERE campaign_id = ? AND status = ?", [campaign_id, '0']);
        if (check_row.length === 0) {
            console.error(`[InitiateCampaignMessages] Campaign ${campaign_id} not found or status != pending`);
            return;
        }

        const campaign_id_inner = check_row[0]?.campaign_id;
        const campaign_creator = check_row[0]?.create_by;
        const template_id = check_row[0]?.template_id;

        const [rows] = await pool.query("SELECT * FROM `campaign_messages` WHERE status = ? AND campaign_id = ?", ['pending', campaign_id_inner]);
        if (rows.length === 0) {
            console.error(`[InitiateCampaignMessages] No pending messages for campaign ${campaign_id}`);
        }

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const unique_id = element?.unique_id;
            const project_id = element?.project_id;
            const template_name = element?.template_name;
            const language_code = element?.language_code;
            let component = element?.component;
            const number = element?.number;

            if (typeof component === 'string') {
                try {
                    component = JSON.parse(component);
                } catch (e) {
                    await pool.query("UPDATE `campaign_messages` SET `status`=?,`failed_reason`=? WHERE unique_id = ?", ['failed', 'Invalid component format', unique_id]);
                    continue;
                }
            }
            const components = Array.isArray(component) ? component : (component ? [component] : []);


            const project_token = await GetAiSensyProjectToken(project_id);
            if (!project_token) {
                await pool.query("UPDATE `campaign_messages` SET `status`=?,`failed_reason`=? WHERE unique_id = ?", ['failed', 'Error on project token generation', unique_id]);
                continue;
            }

            // START
            var template = {
                "name": template_name,
                "language": {
                    "code": language_code
                },
                "components": components
            };


            const options = {
                method: 'POST',
                url: 'https://backend.aisensy.com/direct-apis/t1/messages',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, application/xml',
                    Authorization: `Bearer ${project_token}`
                },
                data: {
                    to: number,
                    type: 'template',
                    template: template
                }
            };

            try {
                const { data } = await axios.request(options);
                const wamid = data?.messages[0]?.id;
                const message_status = data?.messages[0]?.message_status;

                if (message_status == 'accepted') {
                    await pool.query("UPDATE `campaign_messages` SET `send_date`=?,`status`=?, `wamid` = ? WHERE unique_id = ?", [TIMESTAMP(), 'sent', wamid, unique_id]);



                    const message_id = RANDOM_STRING(30);
                    await pool.query(
                        "INSERT INTO messages SET unique_id=?, wamid=?, project_id=?, create_date=?, message_by=?, type=?, message_type=?, is_template=?, template_id=?, component=?, is_campaign=?, campaign_id=?, number=?, status=?",
                        [
                            message_id,
                            wamid,
                            project_id,
                            TIMESTAMP(),
                            campaign_creator,
                            "out",
                            "template",
                            "1",
                            template_id,
                            JSON.stringify(components),
                            "1",
                            campaign_id_inner,
                            number,
                            "sent"
                        ]
                    );


                    // SOCKET

                    const [new_data] = await pool.query("SELECT * FROM messages WHERE unique_id = ?", [message_id]);


                    const message_by = new_data[0]?.message_by;
                    const [message_by_data] = await pool.query("SELECT * FROM users WHERE username = ?", [message_by]);


                    // NEW
                    const storedTemplate = await loadTemplateFromDb(project_id, template_id);
                    var template_file_json = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);
                    // NEW END

                    const return_message = {
                        message_id: new_data[0]?.unique_id,
                        wamid: new_data[0]?.wamid,
                        create_date: new_data[0]?.create_date,
                        type: new_data[0]?.type,
                        message_type: new_data[0]?.message_type,
                        message: buildTemplateDisplayMessage(template_file_json, components),
                        is_template: true,
                        is_forwarded: false,
                        is_reply: false,
                        status: new_data[0]?.status,
                        id: new_data[0]?.id,
                        send_by: {
                            username: message_by_data[0]?.username,
                            name: message_by_data[0]?.name,
                            mobile: message_by_data[0]?.mobile,
                            email: message_by_data[0]?.email,
                            status: message_by_data[0]?.status == '1' ? true : false
                        },
                        template: template_file_json,
                        component: components
                    };

                    const [contact_row] = await pool.query("SELECT * FROM contacts WHERE project_id = ? AND number = ? AND is_deleted = ?", [project_id, number, '0']);
                    if (contact_row.length > 0) {
                        var name = contact_row[0]?.name;
                    } else {
                        var name = false;
                    }
                    const [room_row] = await pool.query("SELECT * FROM `project_mapping` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
                    if (room_row.length > 0) {
                        for (const roomObj of room_row) {
                            var room = roomObj?.username;
                            WsIo.to(room).emit("chat", {
                                message: return_message,
                                project_id,
                                contact: {
                                    number,
                                    name
                                }
                            });
                        }

                    }



                    // MESSAGE END

                } else {
                    await pool.query("UPDATE `campaign_messages` SET `status`=?,`failed_reason`=? WHERE unique_id = ?", ['failed', 'Error on sendMessage() API call (No Accepted)', unique_id]);
                }
            } catch (error) {
                const errMsg = error?.response?.data?.message || error?.message || 'Unknown error';
                console.error(`[InitiateCampaignMessages] Send failed for ${unique_id}:`, errMsg);
                if (error.response) {
                    await pool.query("UPDATE `campaign_messages` SET `status`=?,`failed_reason`=? WHERE unique_id = ? AND campaign_id = ?", ['failed', error?.response?.data?.message, unique_id, campaign_id_inner]);
                } else {
                    await pool.query("UPDATE `campaign_messages` SET `status`=?,`failed_reason`=? WHERE unique_id = ? AND campaign_id = ?", ['failed', 'Error on sendMessage() API call (Unknown Error)', unique_id, campaign_id_inner]);
                }
            }
        }

        await pool.query("UPDATE `campaigns` SET `status`= ? WHERE campaign_id = ?", ['1', campaign_id_inner]);
    } catch (err) {
        console.error(`[InitiateCampaignMessages] Unexpected error for campaign ${campaign_id}:`, err?.message || err);
    } finally {
        processingCampaigns.delete(campaign_id);
    }
}

export { InitiateCampaignMessages }