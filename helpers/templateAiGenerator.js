import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import Groq from "groq-sdk";
import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "./function.js";

const DEFAULT_MODELS = {
    gemini: "gemini-3.6-flash",
    openai: "gpt-4o",
    claude: "claude-3-5-sonnet-latest",
    groq: "llama-3.3-70b-versatile",
};

/**
 * Resolve AI provider configuration for a project:
 * 1. If project has agent_use_personal_key = '1', check project_agent_api_keys for active key.
 * 2. Otherwise (default), use platform active key from global_ai_api_keys.
 */
export async function resolveAiProviderConfig(connection, projectId) {
    const conn = connection || pool;

    let projectUniqueId = projectId;
    let agentUsePersonalKey = "0";

    // Query aisensy_projects to check personal key flag and get unique_id
    const [projectRows] = await conn.query(
        "SELECT unique_id, agent_use_personal_key FROM aisensy_projects WHERE project_id = ? OR unique_id = ? LIMIT 1",
        [projectId, projectId]
    );

    if (projectRows.length > 0) {
        projectUniqueId = projectRows[0].unique_id || projectId;
        agentUsePersonalKey = projectRows[0].agent_use_personal_key || "0";
    }

    // 1. Personal Key if enabled
    if (agentUsePersonalKey === "1") {
        const [keyRows] = await conn.query(
            "SELECT api_key, api_provider FROM project_agent_api_keys WHERE aisensy_project = ? AND is_active = '1' AND is_deleted = '0' ORDER BY create_date DESC LIMIT 1",
            [projectUniqueId]
        );

        if (keyRows.length > 0 && keyRows[0].api_key) {
            const provider = (keyRows[0].api_provider || "gemini").toLowerCase();
            return {
                apiKey: keyRows[0].api_key,
                provider: DEFAULT_MODELS[provider] ? provider : "gemini",
                model: DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini,
                source: "project_personal_key",
                projectUniqueId,
            };
        }
    }

    // 2. Platform default key from global_ai_api_keys
    const [platformKeyRows] = await conn.query(
        "SELECT api_key, provider FROM global_ai_api_keys WHERE is_active = '1' ORDER BY create_date DESC LIMIT 1"
    );

    if (platformKeyRows.length > 0 && platformKeyRows[0].api_key) {
        const provider = (platformKeyRows[0].provider || "gemini").toLowerCase();
        return {
            apiKey: platformKeyRows[0].api_key,
            provider: DEFAULT_MODELS[provider] ? provider : "gemini",
            model: DEFAULT_MODELS[provider] || DEFAULT_MODELS.gemini,
            source: "platform_global_key",
            projectUniqueId,
        };
    }

    return null;
}

/**
 * Log token usage in ai_usage_log table
 */
export async function logAiUsage(connection, { projectId, provider, model, callType = "template_gen", inputTokens = 0, outputTokens = 0 }) {
    try {
        const conn = connection || pool;
        await conn.query(
            "INSERT INTO ai_usage_log (project_id, message_unique_id, provider, model, call_type, input_tokens, output_tokens, create_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
                projectId || "unknown",
                RANDOM_STRING(30),
                provider || "unknown",
                model || "unknown",
                callType,
                Number(inputTokens) || 0,
                Number(outputTokens) || 0,
                TIMESTAMP(),
            ]
        );
    } catch (err) {
        console.error("[AiUsageLog] Failed to log AI usage:", err.message);
    }
}

/**
 * Normalizes usage object to numbers
 */
function toUsage(inputTokens, outputTokens) {
    return {
        inputTokens: Number(inputTokens) || 0,
        outputTokens: Number(outputTokens) || 0,
    };
}

// Meta template button labels are plain text only: no variables, line breaks,
// emoji, or WhatsApp formatting markers, and a maximum of 25 characters.
function sanitizeTemplateButtonText(value, fallback = "Learn more") {
    const cleaned = String(value || fallback)
        .normalize("NFKC")
        .replace(/\{\{[^}]+\}\}/g, "")
        .replace(/[\r\n]+/g, " ")
        .replace(/[\*_~`]/g, "")
        .replace(/\p{Extended_Pictographic}/gu, "")
        .replace(/[\uFE0E\uFE0F\u200D]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 25);
    return cleaned || fallback;
}

export function sanitizeTemplateButtons(components) {
    return components.map((component) => {
        if (String(component.type || "").toUpperCase() !== "BUTTONS" || !Array.isArray(component.buttons)) return component;
        return {
            ...component,
            buttons: component.buttons.slice(0, 3).map((button) => {
                const type = String(button.type || "QUICK_REPLY").toUpperCase();
                const normalized = { ...button, type, text: sanitizeTemplateButtonText(button.text, type === "URL" ? "Visit website" : type === "PHONE_NUMBER" ? "Call us" : "Learn more") };
                if (typeof normalized.url === "string") {
                    normalized.url = normalized.url.replace(/\{\{[^}]+\}\}/g, "").replace(/[\r\n]/g, "").trim();
                    delete normalized.example;
                }
                if (typeof normalized.phone_number === "string") normalized.phone_number = normalized.phone_number.replace(/[^0-9+]/g, "");
                return normalized;
            }),
        };
    });
}

/**
 * Call Gemini
 */
async function callGeminiTemplate({ apiKey, model, systemPrompt, userPrompt }) {
    const client = new GoogleGenerativeAI(apiKey);
    const genModel = client.getGenerativeModel({
        model: model || DEFAULT_MODELS.gemini,
        systemInstruction: systemPrompt,
    });
    const result = await genModel.generateContent(userPrompt);
    const usageMeta = result.response.usageMetadata || {};
    return {
        text: result.response.text().trim(),
        usage: toUsage(usageMeta.promptTokenCount, usageMeta.candidatesTokenCount),
    };
}

/**
 * Call OpenAI
 */
async function callOpenAITemplate({ apiKey, model, systemPrompt, userPrompt }) {
    const client = new OpenAI({ apiKey });
    const completion = await client.chat.completions.create({
        model: model || DEFAULT_MODELS.openai,
        temperature: 0.3,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
    });
    return {
        text: completion.choices[0].message.content.trim(),
        usage: toUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens),
    };
}

/**
 * Call Claude
 */
async function callClaudeTemplate({ apiKey, model, systemPrompt, userPrompt }) {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
        model: model || DEFAULT_MODELS.claude,
        max_tokens: 2048,
        temperature: 0.3,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });
    return {
        text: msg.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim(),
        usage: toUsage(msg.usage?.input_tokens, msg.usage?.output_tokens),
    };
}

/**
 * Call Groq
 */
async function callGroqTemplate({ apiKey, model, systemPrompt, userPrompt }) {
    const client = new Groq({ apiKey });
    const completion = await client.chat.completions.create({
        model: model || DEFAULT_MODELS.groq,
        temperature: 0.3,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
        ],
    });
    return {
        text: completion.choices[0].message.content.trim(),
        usage: toUsage(completion.usage?.prompt_tokens, completion.usage?.completion_tokens),
    };
}

const PROVIDER_HANDLERS = {
    gemini: callGeminiTemplate,
    openai: callOpenAITemplate,
    claude: callClaudeTemplate,
    groq: callGroqTemplate,
};

/**
 * Build system prompt for WhatsApp Template Generation according to Meta WhatsApp Cloud API specifications.
 */
function buildTemplateSystemPrompt() {
    return `You are an expert Meta WhatsApp Business API Template creator and copywriter.
Your task is to generate high-converting, fully compliant WhatsApp message templates strictly formatted for Meta WhatsApp Cloud API and AiSensy.

Meta WhatsApp Template Specifications:
1. "name": Lowercase alphanumeric and underscores only (e.g., "order_confirmation_v1", "summer_sale_50_off"). No spaces, hyphens, or uppercase letters. Max 512 characters.
2. "category": Must be one of "MARKETING", "UTILITY", or "AUTHENTICATION".
3. "language": Standard language code, e.g. "en_US", "en", "hi", "es", "pt_BR", etc. Default "en".
4. "components": An array of valid WhatsApp template component objects:
   - "HEADER" (optional):
     - "format": "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT"
     - If format is "TEXT", provide "text": "..." (Max 60 characters). Can contain variable {{1}} with example.
   - "BODY" (required):
     - "text": Main template body text (Max 1024 characters).
     - Variables in body MUST be sequential starting from {{1}}, then {{2}}, {{3}}, etc. without skipping numbers.
     - Never start or end body with a variable.
     - "example": REQUIRED if variables are used in body. Format:
       "example": {
         "body_text": [
           ["SampleVal1", "SampleVal2", ...]
         ]
       }
   - "FOOTER" (optional):
     - "text": Short footer text (Max 60 characters, e.g. "Reply STOP to unsubscribe" or "Terms & Conditions apply"). No variables allowed in footer.
   - "BUTTONS" (optional):
     - "type": "BUTTONS"
     - "buttons": Array of button objects:
       - Quick Reply: { "type": "QUICK_REPLY", "text": "Button Label" } (Max 25 chars text, max 3 buttons)
       - URL: { "type": "URL", "text": "Visit Website", "url": "https://example.com/page" } (Optional {{1}} at end with example array, e.g. "example": ["ref123"])
       - Phone Number: { "type": "PHONE_NUMBER", "text": "Call Support", "phone_number": "+1234567890" }
       - OTP: { "type": "OTP", "otp_type": "COPY_CODE", "text": "Copy Code" } (for AUTHENTICATION templates)

Output JSON Schema:
Respond ONLY with a valid JSON object without markdown fences, explanation outside JSON, or comments.
{
  "name": "template_name_in_lowercase_snake_case",
  "category": "MARKETING",
  "language": "en",
  "components": [
    {
      "type": "HEADER",
      "format": "TEXT",
      "text": "Header Text"
    },
    {
      "type": "BODY",
      "text": "Hello {{1}}, here is your code {{2}}.",
      "example": {
        "body_text": [
          ["John", "ABC-123"]
        ]
      }
    },
    {
      "type": "FOOTER",
      "text": "Footer text"
    },
    {
      "type": "BUTTONS",
      "buttons": [
        { "type": "QUICK_REPLY", "text": "Yes" },
        { "type": "URL", "text": "Visit Website", "url": "https://example.com" }
      ]
    }
  ],
  "sample_variables": {
    "1": "Customer Name (e.g. John)",
    "2": "Promo Code (e.g. ABC-123)"
  },
  "explanation": "Brief explanation of why this copy and structure was chosen."
}`;
}

/**
 * Cleans markdown code fences and parses JSON safely.
 */
function parseAiJsonResponse(rawText) {
    if (!rawText) return null;
    let cleanText = rawText.trim();

    // Remove markdown code blocks if present
    if (cleanText.startsWith("```")) {
        cleanText = cleanText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    }

    try {
        return JSON.parse(cleanText);
    } catch (err) {
        // Fallback regex match for first JSON object
        const match = cleanText.match(/\{[\s\S]*\}/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (_) {}
        }
        return null;
    }
}

/**
 * Validate and normalize the generated template object
 */
function normalizeTemplate(parsedData, fallbackCategory = "MARKETING", fallbackLanguage = "en") {
    if (!parsedData || typeof parsedData !== "object") {
        throw new Error("AI returned invalid data format");
    }

    // Name sanitization: lowercase alphanumeric and underscore only
    let name = String(parsedData.name || "ai_template_" + RANDOM_STRING(6).toLowerCase())
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "");

    if (!name) name = "template_" + RANDOM_STRING(8).toLowerCase();

    // Category
    const allowedCategories = ["MARKETING", "UTILITY", "AUTHENTICATION"];
    let category = String(parsedData.category || fallbackCategory).toUpperCase();
    if (!allowedCategories.includes(category)) {
        category = fallbackCategory.toUpperCase();
    }

    // Language
    const language = String(parsedData.language || fallbackLanguage || "en");

    // Components validation
    let components = Array.isArray(parsedData.components) ? parsedData.components : [];

    // Ensure there is at least a BODY component
    let bodyComp = components.find((c) => c && String(c.type).toUpperCase() === "BODY");
    if (!bodyComp) {
        bodyComp = {
            type: "BODY",
            text: "Hello {{1}}, thank you for reaching out to us!",
            example: {
                body_text: [["Valued Customer"]],
            },
        };
        components.push(bodyComp);
    }

    // Normalize component types to uppercase
    components = components.map((c) => {
        const type = String(c.type || "").toUpperCase();
        const norm = { ...c, type };
        if (type === "HEADER" && c.format) {
            norm.format = String(c.format).toUpperCase();
        }
        return norm;
    });

    components = sanitizeTemplateButtons(components);

    const templatePayload = {
        name,
        category,
        language,
        components,
    };

    return {
        template: templatePayload,
        sample_variables: parsedData.sample_variables || {},
        explanation: parsedData.explanation || "Template generated using AI.",
    };
}

/**
 * Main function to generate template using AI
 */
export async function generateWhatsAppTemplateWithAi({
    projectId,
    prompt,
    category = "MARKETING",
    language = "en",
    tone = "friendly and persuasive",
    headerType = null,
    buttonType = null,
    customInstructions = "",
}) {
    if (!prompt || String(prompt).trim() === "") {
        throw new Error("Prompt/use-case description is required");
    }

    // 1. Resolve AI configuration
    const aiConfig = await resolveAiProviderConfig(pool, projectId);
    if (!aiConfig || !aiConfig.apiKey) {
        throw new Error("No active AI API key found. Please configure a platform AI key in global_ai_api_keys or project personal key.");
    }

    const { apiKey, provider, model } = aiConfig;
    const handler = PROVIDER_HANDLERS[provider];
    if (!handler) {
        throw new Error(`Unsupported AI provider: ${provider}`);
    }

    // 2. Build prompts
    const systemPrompt = buildTemplateSystemPrompt();
    let userPrompt = `Generate a WhatsApp Template based on the following requirements:
- Use-case / Prompt: "${prompt}"
- Category: ${category || "MARKETING"}
- Language: ${language || "en"}
- Tone: ${tone || "friendly and engaging"}
`;

    if (headerType && headerType !== "NONE") {
        userPrompt += `- Header Preference: Include a ${headerType.toUpperCase()} header.\n`;
    } else if (headerType === "NONE") {
        userPrompt += `- Header Preference: Do NOT include a header component.\n`;
    }

    if (buttonType && buttonType !== "NONE") {
        userPrompt += `- Buttons Preference: Include ${buttonType} buttons.\n`;
    } else if (buttonType === "NONE") {
        userPrompt += `- Buttons Preference: Do NOT include any buttons.\n`;
    }

    if (customInstructions && customInstructions.trim()) {
        userPrompt += `- Additional Custom Instructions: ${customInstructions.trim()}\n`;
    }

    userPrompt += `\nRemember to return ONLY the valid JSON object without any backticks or extra text outside JSON.`;

    // 3. Call AI
    const result = await handler({
        apiKey,
        model,
        systemPrompt,
        userPrompt,
    });

    // 4. Log AI usage
    await logAiUsage(pool, {
        projectId,
        provider,
        model,
        callType: "template_gen",
        inputTokens: result.usage?.inputTokens || 0,
        outputTokens: result.usage?.outputTokens || 0,
    });

    // 5. Parse and Normalize
    const parsed = parseAiJsonResponse(result.text);
    if (!parsed) {
        console.error("[TemplateAiGenerator] Raw AI response could not be parsed:", result.text);
        throw new Error("Failed to parse template JSON from AI response.");
    }

    const normalized = normalizeTemplate(parsed, category, language);

    return {
        ...normalized,
        provider,
        model,
        usage: result.usage,
    };
}
