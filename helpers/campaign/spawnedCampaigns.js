/** Campaigns we've recently spawned (processInBackground*) - avoid re-picking before entry_complete is set */
export const spawnedCampaigns = new Map();
export const SPAWN_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function markCampaignSpawned(campaign_id) {
    spawnedCampaigns.set(campaign_id, Date.now());
}
