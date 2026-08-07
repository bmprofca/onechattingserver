import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";

import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP, GetAiSensyProjectToken } from "./function.js";
import axios from "axios";
import { WsIo } from "../server.js";
import { emitToProjectSockets } from "./socketEmit.js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const FALLBACK_ERROR = "I'm unable to help with this at the moment. Please connect with our support agent for further assistance.";
const FALLBACK_NO_ANSWER = "Your Query related having no answer";
const FALLBACK_NO_CONTEXT = "Sorry, I have not information about you query";

/**
 * Generate a reply using the chosen provider's SDK based on the company context.
 * 
 * @param {string} context - The company's Q&A context
 * @param {string} customerMessage - The incoming message from the customer
 * @param {string|null} personalApiKey - Optional personal API key to use instead of .env key
 * @param {string|null} personalModel - Optional model name from personal key config
 * @param {string|null} personalProvider - Optional provider name (gemini, openai, claude, groq)
 * @returns {Promise<string>} The generated reply or FALLBACK_MESSAGE
 */
async function generateAutoReply(context, customerMessage, personalApiKey = null, personalModel = null, personalProvider = null) {
    const apiKey = personalApiKey || process.env.GEMINI_API_KEY;
    const provider = (personalApiKey ? personalProvider : 'gemini') || 'gemini';

    if (!apiKey) {
        console.error("No API key available for auto-reply");
        return FALLBACK_ERROR;
    }

    const hasContext = context && context.trim() !== '';

    try {
        const systemPrompt = `You are a helpful customer support agent for a company. 
1. You MUST naturally handle general conversational greetings (like "Hi", "Hello", "Good morning") and ask how you can help.
2. For specific questions about the company, its services, or policies, you MUST answer ONLY based on the provided company context below. 
3. If the context does not contain the answer to a specific question, or if there is no context provided, respond EXACTLY with: [FALLBACK]
4. Do not apologize or explain that you don't know. Just output [FALLBACK].

Company Context:
${hasContext ? context : 'No company context provided.'}
`;

        let responseText = '';

        if (provider === 'gemini') {
            const aiInstance = personalApiKey ? new GoogleGenerativeAI(personalApiKey) : genAI;
            const modelName = personalModel || "gemini-1.5-flash";
            const model = aiInstance.getGenerativeModel({ model: modelName });
            
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
            responseText = result.response.text().trim();

        } else if (provider === 'openai') {
            const openai = new OpenAI({ apiKey });
            const completion = await openai.chat.completions.create({
                model: personalModel || 'gpt-4o',
                temperature: 0.2,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: customerMessage }
                ]
            });
            responseText = completion.choices[0].message.content.trim();

        } else if (provider === 'claude') {
            const anthropic = new Anthropic({ apiKey });
            const msg = await anthropic.messages.create({
                model: personalModel || 'claude-3-5-sonnet-latest',
                max_tokens: 1024,
                temperature: 0.2,
                system: systemPrompt,
                messages: [
                    { role: 'user', content: customerMessage }
                ]
            });
            responseText = msg.content[0].text.trim();

        } else if (provider === 'groq') {
            const groq = new Groq({ apiKey });
            const completion = await groq.chat.completions.create({
                model: personalModel || 'groq-1',
                temperature: 0.2,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: customerMessage }
                ]
            });
            responseText = completion.choices[0].message.content.trim();
        }

        if (responseText === '[FALLBACK]') {
            return hasContext ? FALLBACK_NO_ANSWER : FALLBACK_NO_CONTEXT;
        }

        return responseText;

    } catch (error) {
        console.error(`Error generating AI reply via ${provider}:`, error);
        return FALLBACK_ERROR;
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

        // 1. Check project auto_reply setting, type, context, and personal key preference
        const [projectRows] = await connection.query(
            "SELECT unique_id, auto_reply, auto_reply_type, context, agent_use_personal_key FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) return; // Project not found

        const { unique_id: projectUniqueId, auto_reply, auto_reply_type, context, agent_use_personal_key } = projectRows[0];
        
        // If auto_reply is off, skip
        if (auto_reply !== '1') return;

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

        // 3. Determine which API key to use
        let personalApiKey = null;
        let personalModel = null;
        let personalProvider = null;

        if (agent_use_personal_key === '1') {
            // Fetch the active personal API key for this project
            const [keyRows] = await connection.query(
                "SELECT api_key, api_model, api_provider FROM project_agent_api_keys WHERE aisensy_project = ? AND is_active = '1' AND is_deleted = '0' ORDER BY create_date DESC LIMIT 1",
                [projectUniqueId]
            );

            if (keyRows.length > 0) {
                personalApiKey = keyRows[0].api_key;
                personalModel = keyRows[0].api_model || null;
                personalProvider = keyRows[0].api_provider || null;
            } else {
                console.warn(`agent_use_personal_key is ON for project ${project_id} but no active API key found. Falling back to .env key.`);
            }
        }

        // 4. Generate AI Reply (with personal key if available, otherwise .env key)
        const replyText = await generateAutoReply(context, messageText, personalApiKey, personalModel, personalProvider);

        // 5. Send the reply via AiSensy API
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

        // 6. Emit via Socket
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
