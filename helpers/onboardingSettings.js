import pool from "../db.js";

let tableReady;

export function ensureOnboardingSettingsTable() {
    if (!tableReady) {
        tableReady = pool.query(`
            CREATE TABLE IF NOT EXISTS onboarding_prompt_settings (
                project_id VARCHAR(191) NOT NULL,
                ice_breakers TEXT NOT NULL,
                slash_commands TEXT NOT NULL,
                modify_date DATETIME NOT NULL,
                modify_by VARCHAR(191) NOT NULL,
                PRIMARY KEY (project_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `).catch((error) => {
            tableReady = null;
            throw error;
        });
    }
    return tableReady;
}

export class OnboardingSettingsValidationError extends Error {}

function readLines(value, field, limit, maxLength) {
    if (!Array.isArray(value) || value.length > limit) {
        throw new OnboardingSettingsValidationError(`${field} must be a list of at most ${limit} items`);
    }
    return value.map((item, index) => {
        if (typeof item !== "string") {
            throw new OnboardingSettingsValidationError(`${field} item ${index + 1} must be text`);
        }
        const text = item.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
        if (!text || text.length > maxLength) {
            throw new OnboardingSettingsValidationError(`${field} items must contain 1-${maxLength} characters`);
        }
        return text;
    });
}

export function normalizeOnboardingSettings(input = {}) {
    const iceBreakers = readLines(input.ice_breakers, "Ice-breakers", 4, 80);
    const rawCommands = input.slash_commands;
    if (!Array.isArray(rawCommands) || rawCommands.length > 10) {
        throw new OnboardingSettingsValidationError("Slash commands must be a list of at most 10 items");
    }

    const seenCommands = new Set();
    const slashCommands = rawCommands.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new OnboardingSettingsValidationError(`Slash command ${index + 1} must include a command and description`);
        }
        const command = typeof item.command === "string" ? item.command.trim() : "";
        const description = typeof item.description === "string"
            ? item.description.replace(/[\u0000-\u001f\u007f]/g, " ").trim()
            : "";
        if (!/^\/[a-z0-9][a-z0-9_-]{0,31}$/i.test(command)) {
            throw new OnboardingSettingsValidationError(`Slash command ${index + 1} must start with / and use up to 32 letters, numbers, _ or -`);
        }
        if (description.length > 80) {
            throw new OnboardingSettingsValidationError(`Slash command ${index + 1} description must be 80 characters or fewer`);
        }
        const normalizedCommand = command.toLowerCase();
        if (seenCommands.has(normalizedCommand)) {
            throw new OnboardingSettingsValidationError("Slash commands must be unique");
        }
        seenCommands.add(normalizedCommand);
        return { command, description };
    });

    return { ice_breakers: iceBreakers, slash_commands: slashCommands };
}

export function getOnboardingCapabilities(providerType) {
    const supported = providerType === "own" || providerType === "aisensy";
    return {
        ice_breakers: supported,
        slash_commands: supported,
    };
}

export function parseOnboardingSettings(row) {
    if (!row) return { ice_breakers: [], slash_commands: [] };
    try {
        return normalizeOnboardingSettings({
            ice_breakers: JSON.parse(row.ice_breakers),
            slash_commands: JSON.parse(row.slash_commands),
        });
    } catch (error) {
        console.error("[onboarding-settings] Stored settings are invalid:", error?.message || error);
        throw new Error("Stored onboarding settings are invalid");
    }
}
