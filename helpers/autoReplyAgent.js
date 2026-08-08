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
const FALLBACK_NO_ANSWER = "Sorry, your query doesn't match any information we have. Please connect with our support team for further assistance.";
const FALLBACK_NO_CONTEXT = "Sorry, I don't have information about your query. Please connect with our support team for further assistance.";

// ─── Greeting / conversational detection ───────────────────────────────
const GREETING_PATTERNS = [
    /^\s*(h+i+|hey+|hello+|hii+|yo+|sup)\s*[!.,?]*\s*$/i,
    /^\s*(good\s*(morning|afternoon|evening|night|day))\s*[!.,?]*\s*$/i,
    /^\s*(how\s+are\s+you|how\s+r\s+u|howdy|what'?s\s+up|whatsup|wassup)\s*[!.,?]*\s*$/i,
    /^\s*(thanks?|thank\s*you|thx|ty)\s*[!.,?]*\s*$/i,
    /^\s*(ok|okay|cool|nice|great|good|fine|awesome|perfect)\s*[!.,?]*\s*$/i,
    /^\s*(bye+|goodbye|see\s+you|take\s+care|good\s+bye)\s*[!.,?]*\s*$/i,
    /^\s*(namaste|namaskar)\s*[!.,?]*\s*$/i,
];

const GREETING_RESPONSES = {
    greeting: [
        "Hello! 👋 Welcome! How can I help you today?",
        "Hi there! 😊 How can I assist you today?",
        "Hey! 👋 Great to hear from you. How can I help?",
    ],
    how_are_you: [
        "I'm doing great, thank you for asking! 😊 How can I help you today?",
        "I'm good, thanks! How may I assist you?",
    ],
    thanks: [
        "You're welcome! 😊 Is there anything else I can help you with?",
        "Happy to help! Let me know if you need anything else.",
    ],
    bye: [
        "Goodbye! 👋 Have a wonderful day!",
        "Take care! Feel free to reach out anytime. 😊",
    ],
    positive: [
        "Great! 😊 Is there anything I can help you with?",
        "Awesome! Let me know if you have any questions.",
    ],
};

/**
 * Check if a message is a simple greeting / conversational message.
 * Returns a friendly reply string, or null if it's NOT a greeting.
 */
function getGreetingReply(message) {
    const text = (message || '').trim();
    if (!text) return null;

    // Check against greeting patterns
    for (const pattern of GREETING_PATTERNS) {
        if (pattern.test(text)) {
            // Determine which category
            if (/how\s+(are|r)\s+(you|u)|howdy|what'?s\s+up|whatsup|wassup/i.test(text)) {
                return _pick(GREETING_RESPONSES.how_are_you);
            }
            if (/thanks?|thank\s*you|thx|ty/i.test(text)) {
                return _pick(GREETING_RESPONSES.thanks);
            }
            if (/bye|goodbye|see\s+you|take\s+care/i.test(text)) {
                return _pick(GREETING_RESPONSES.bye);
            }
            if (/^(ok|okay|cool|nice|great|good|fine|awesome|perfect)\s*[!.,?]*$/i.test(text)) {
                return _pick(GREETING_RESPONSES.positive);
            }
            return _pick(GREETING_RESPONSES.greeting);
        }
    }
    return null; // not a greeting
}

function _pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Detect if the AI response is a refusal/fallback rather than a real answer.
 * Catches both the explicit [FALLBACK] token and common AI-generated refusal phrases.
 */
function _isAIRefusal(text) {
    if (!text) return true;

    // Explicit fallback token
    if (text.includes('[FALLBACK]')) return true;

    const lower = text.toLowerCase();

    // Common AI refusal patterns
    const refusalPatterns = [
        "i'm unable to help",
        "i am unable to help",
        "i cannot assist",
        "i'm not able to help",
        "i don't have information",
        "i do not have information",
        "i don't have enough information",
        "please connect with our support",
        "please contact our support",
        "please reach out to our support",
        "i cannot help with this",
        "i'm unable to assist",
        "i am unable to assist",
        "outside my scope",
        "beyond my capabilities",
        "i don't have the ability",
    ];

    for (const pattern of refusalPatterns) {
        if (lower.includes(pattern)) return true;
    }

    return false;
}

// ─── AI-based reply for business queries ───────────────────────────────

/**
 * Generate a reply using the chosen provider's SDK based on the company context.
 * This is called ONLY for non-greeting messages (real business queries).
 *
 * @param {string} context - The company's Q&A context
 * @param {string} customerMessage - The incoming message from the customer
 * @param {string|null} personalApiKey - Optional personal API key to use instead of .env key
 * @param {string|null} personalModel - Optional model name from personal key config
 * @param {string|null} personalProvider - Optional provider name (gemini, openai, claude, groq)
 * @returns {Promise<string>} The generated reply or fallback message
 */
async function generateAutoReply(context, customerMessage, personalApiKey = null, personalModel = null, personalProvider = null) {
    const apiKey = personalApiKey || process.env.GEMINI_API_KEY;
    const provider = (personalApiKey ? personalProvider : 'gemini') || 'gemini';

    const hasContext = context && context.trim() !== '';

    // If there is no context AND no API key, return the no-context fallback directly
    if (!hasContext) {
        console.log("hello world");
        return FALLBACK_NO_CONTEXT;
    }

    if (!apiKey) {
        console.error("[AutoReply] No API key available for auto-reply");
        return FALLBACK_NO_CONTEXT;
    }

    try {
        const systemPrompt = `You are a helpful customer support assistant for a company.
Your job is to answer the customer's question ONLY based on the Company Context provided below.

RULES (you MUST follow these strictly):
1. If the Company Context contains the answer, reply clearly and helpfully.
2. If the Company Context does NOT contain the answer, you MUST respond with EXACTLY this and nothing else: [FALLBACK]
3. Do NOT make up answers or information that is not in the context.
4. Do NOT say things like "I'm unable to help" or "I cannot assist" — just output [FALLBACK] instead.
5. Do NOT apologize or explain why you can't answer — just output [FALLBACK].
6. NEVER generate your own refusal message. The ONLY acceptable non-answer is: [FALLBACK]

Company Context:
${context}
`;

        let responseText = '';

        console.log(`[AutoReply] Calling ${provider} AI for message: "${customerMessage}"`);
        console.log(`[AutoReply] Context length: ${context?.length || 0} chars`);

        if (provider === 'gemini') {
            const aiInstance = personalApiKey ? new GoogleGenerativeAI(personalApiKey) : genAI;
            
            // Map custom UI labels (e.g. "Gemini 3.1 Pro (High)") to valid Google model names
            let rawModel = personalModel || "gemini-2.0-flash";
            let modelName = rawModel;
            
            if (!modelName.toLowerCase().startsWith('gemini-') && !modelName.toLowerCase().startsWith('learnlm-')) {
                const lower = modelName.toLowerCase();
                if (lower.includes('pro')) {
                    modelName = 'gemini-1.5-pro';
                } else if (lower.includes('flash')) {
                    modelName = 'gemini-1.5-flash';
                } else {
                    modelName = 'gemini-2.0-flash';
                }
                console.log(`[AutoReply] Mapped UI model name "${rawModel}" to valid API model "${modelName}"`);
            }

            const model = aiInstance.getGenerativeModel({ 
                model: modelName,
                systemInstruction: systemPrompt 
            });

            const chat = model.startChat({
                generationConfig: {
                    temperature: 0.2,
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

        console.log(`[AutoReply] Raw AI response: "${responseText}"`);

        // If AI returned [FALLBACK] or a refusal-like message, use our own fallback
        if (_isAIRefusal(responseText)) {
            console.log(`[AutoReply] Detected AI refusal/fallback, using standard fallback message.`);
            return FALLBACK_NO_ANSWER;
        }

        return responseText;

    } catch (error) {
        console.error(`[AutoReply] Error generating AI reply via ${provider}:`, error?.message || error);
        return FALLBACK_NO_ANSWER;
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
        // 4. Determine the reply text
        //    Step A: Check if it's a greeting / conversational message (no AI needed)
        console.log(`[AutoReply] Processing message for project ${project_id}: "${messageText}"`);
        console.log(`[AutoReply] DB context value: ${context ? `"${context.substring(0, 100)}..."` : 'NULL/EMPTY'}`);
        console.log(`[AutoReply] agent_use_personal_key: ${agent_use_personal_key}, personalApiKey: ${personalApiKey ? 'SET' : 'NOT SET'}`);

        const greetingReply = getGreetingReply(messageText);
        let replyText;

        if (greetingReply) {
            // Greeting detected — reply immediately, no AI call required
            replyText = greetingReply;
            console.log(`[AutoReply] ✅ Greeting detected for project ${project_id}, replying locally: "${replyText}"`);
        } else {
            // Step B: It's a real query — use AI with context (or return fallback if no context)
            replyText = await generateAutoReply(context, messageText, personalApiKey, personalModel, personalProvider);
            console.log(`[AutoReply] 🤖 AI reply generated for project ${project_id}: "${replyText}"`);
        }

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
