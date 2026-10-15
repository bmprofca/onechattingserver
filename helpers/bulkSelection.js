// Shared helpers for "select all matching records" bulk actions.
// The client sends { select_all: true, excluded_ids: [...], filters: {...} } and the
// server resolves the target records itself, so selections are never limited to
// the rows the client happened to render.

export const isTruthyFlag = (value) =>
    value === true || value === 'true' || value === 1 || value === '1';

export const toIdList = (raw) => {
    if (raw === undefined || raw === null || raw === '') return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return Array.from(new Set(list.map((v) => String(v ?? '').trim()).filter(Boolean)));
};

// Upper bound for a single select-all operation; protects the DB from runaway updates.
export const MAX_BULK_SELECTION = 200000;
