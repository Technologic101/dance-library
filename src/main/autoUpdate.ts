/**
 * Auto-update is intentionally disabled.
 *
 * Phase 6 will check GitHub Releases. This module must not set an update
 * feed, import an updater, or contact the network. CI does not publish releases.
 */
export const autoUpdateStatus = 'disabled' as const;

export type AutoUpdateStatus = typeof autoUpdateStatus;
