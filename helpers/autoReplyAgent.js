import { GoogleGenerativeAI } from "@google/generative-ai";
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP, GetAiSensyProjectToken } from "./function.js";
import axios from "axios";
import { WsIo } from "../server.js";
import { emitToProjectSockets } from "./socketEmit.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const FALLBACK_MESSAGE = "I'm unable to help with this. Please connect with our support agent for further assistance.";

/**
 * Generate a reply using Google Gemini based on the company context.
 * 
 * @param {string} context - The company's Q&A context
 * @param {string} customerMessage - The incoming message from the customer
 * @returns {Promise<string>} The generated reply or FALLBACK_MESSAGE
 */
async function generateAutoReply(context, customerMessage) {
    if (!process.env.GEMINI_API_KEY) {
        console.error("GEMINI_API_KEY is not set in environment variables");
        return FALLBACK_MESSAGE;
    }

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        
        const systemPrompt = `You are a helpful customer support agent for a company. 
Answer ONLY based on the provided company context below. 
If the context does not contain the answer or if the user's request cannot be fully satisfied by the context alone, respond EXACTLY with: [FALLBACK]
Do not apologize or explain that you don't know. Just output [FALLBACK].

Company Context:
${context}
`;

        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: systemPrompt }],
                },
                {
                    role: "model",
                    parts: [{ text: "Understood. I will only answer based on the context, or output [FALLBACK]." }],
                },
            ],
            generationConfig: {
                temperature: 0.2, // Low temperature for factual, less creative responses
            },
        });

        const result = await chat.sendMessage(customerMessage);
        const responseText = result.response.text().trim();

        if (responseText === '[FALLBACK]') {
            return FALLBACK_MESSAGE;
        }

        return responseText;

    } catch (error) {
        console.error("Error generating AI reply:", error);
        return FALLBACK_MESSAGE;
    }
}

/**
 * Handle auto-reply logic for an incoming message.
 * 
 * @param {string} project_id - The project ID
 * @param {string} sender - The customer's WhatsApp number
 * @param {string} messageText - The text of the incoming message
 * @param {string} incomingUniqueId - The unique ID of the incoming message in DB
 */
export async function handleAutoReply(project_id, sender, messageText, incomingUniqueId) {
    if (!messageText || messageText.trim() === '') return;

    let connection;
    try {
        connection = await pool.getConnection();

        // 1. Check project auto_reply setting, type and context
        const [projectRows] = await connection.query(
            "SELECT auto_reply, auto_reply_type, context FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) return; // Project not found

        const { auto_reply, auto_reply_type, context } = projectRows[0];
        
        // If auto_reply is off, or context is empty, skip
        if (auto_reply !== '1' || !context || context.trim() === '') return;

        // 2. If type is 'new', check if this contact has any prior message history
        // If they do, skip auto-reply (only reply to brand-new contacts)
        // If type is 'all', skip this check and always reply
        if ((auto_reply_type || 'new') === 'new') {
            const [historyRows] = await connection.query(
                "SELECT id FROM messages WHERE project_id = ? AND number = ? AND unique_id != ? LIMIT 1",
                [project_id, sender, incomingUniqueId]
            );

            if (historyRows.length > 0) {
                // Contact has previous message history, do not auto-reply
                return;
            }
        }

        // 3. Generate AI Reply
        const replyText = await generateAutoReply(context, messageText);

        // 4. Send the reply via AiSensy API
        const projectToken = await GetAiSensyProjectToken(project_id);
        if (!projectToken) {
            console.error("Failed to get AiSensy token for project", project_id);
            return;
        }

        const unique_id = RANDOM_STRING(30);

        // Save to DB first as pending
        await connection.query(
            "INSERT INTO `messages`(`unique_id`, `project_id`, `create_date`, `message_by`, `type`, `message_type`, `message`, `number`, `status`, `is_reply`, `reply_wamid`) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            [unique_id, project_id, TIMESTAMP(), 'BOT', 'out', 'text', replyText, sender, 'pending', '0', null]
        );

        // Send API request
        const options = {
            method: 'POST',
            url: 'https://backend.aisensy.com/direct-apis/t1/messages',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, application/xml',
                Authorization: `Bearer ${projectToken}`
            },
            data: {
                to: sender,
                type: 'text',
                recipient_type: 'individual',
                text: { body: replyText }
            }
        };

        let wamid = null;
        let status = 'sent';
        let failed_reason = null;

        try {
            const { data } = await axios.request(options);
            wamid = data?.messages?.[0]?.id;
            await connection.query("UPDATE `messages` SET `wamid` = ? WHERE `unique_id` = ?", [wamid, unique_id]);
        } catch (apiError) {
            console.error("AiSensy API error sending bot reply:", apiError?.response?.data || apiError.message);
            status = 'failed';
            failed_reason = apiError?.response?.data?.message || "Failed to send message via AiSensy";
            await connection.query("UPDATE `messages` SET `status` = ?, `failed_reason` = ? WHERE `unique_id` = ?", [status, failed_reason, unique_id]);
        }

        // 5. Emit via Socket
        const [newMsgRows] = await connection.query("SELECT * FROM messages WHERE unique_id = ?", [unique_id]);
        
        if (newMsgRows.length > 0) {
            const newMsg = newMsgRows[0];
            
            // Get contact name if available
            const [contactRows] = await connection.query("SELECT name FROM contacts WHERE project_id = ? AND number = ?", [project_id, sender]);
            const name = contactRows.length > 0 ? contactRows[0].name : null;

            const returnMessage = {
                wamid: newMsg.wamid,
                message_id: unique_id,
                message: newMsg.message,
                create_date: newMsg.create_date,
                is_template: false,
                is_forwarded: false,
                is_reply: false,
                status: newMsg.status,
                type: 'out',
                message_type: 'text',
                id: newMsg.id,
                send_by: {
                    username: 'BOT',
                    name: 'Auto-Reply Bot',
                    mobile: null,
                    email: null,
                    status: true,
                }
            };

            if (status === 'failed') {
                returnMessage.failed_reason = failed_reason;
            }

            await emitToProjectSockets(WsIo, project_id, "chat", {
                message: returnMessage,
                project_id,
                contact: { number: sender, name }
            });
        }

    } catch (error) {
        console.error("Error in handleAutoReply:", error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
}
