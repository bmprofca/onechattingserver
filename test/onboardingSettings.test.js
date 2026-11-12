import test from "node:test";
import assert from "node:assert/strict";
import {
    getOnboardingCapabilities,
    normalizeOnboardingSettings,
    OnboardingSettingsValidationError,
    parseOnboardingSettings,
} from "../helpers/onboardingSettings.js";

test("normalizes valid onboarding prompt settings", () => {
    assert.deepEqual(normalizeOnboardingSettings({
        ice_breakers: ["  Ask about pricing ", "Talk to support"],
        slash_commands: [{ command: "/pricing", description: "See plans" }],
    }), {
        ice_breakers: ["Ask about pricing", "Talk to support"],
        slash_commands: [{ command: "/pricing", description: "See plans" }],
    });
});

test("rejects duplicate or malformed slash commands and oversized prompt lists", () => {
    assert.throws(() => normalizeOnboardingSettings({
        ice_breakers: [],
        slash_commands: [
            { command: "/Help", description: "" },
            { command: "/help", description: "" },
        ],
    }), OnboardingSettingsValidationError);
    assert.throws(() => normalizeOnboardingSettings({
        ice_breakers: ["one", "two", "three", "four", "five"],
        slash_commands: [],
    }), OnboardingSettingsValidationError);
    assert.throws(() => normalizeOnboardingSettings({
        ice_breakers: [],
        slash_commands: [{ command: "help", description: "" }],
    }), OnboardingSettingsValidationError);
});

test("enables prompt settings for configured providers and disables unknown providers", () => {
    assert.deepEqual(getOnboardingCapabilities("own"), { ice_breakers: true, slash_commands: true });
    assert.deepEqual(getOnboardingCapabilities("aisensy"), { ice_breakers: true, slash_commands: true });
    assert.deepEqual(getOnboardingCapabilities("unknown"), { ice_breakers: false, slash_commands: false });
    assert.deepEqual(parseOnboardingSettings(null), { ice_breakers: [], slash_commands: [] });
});
