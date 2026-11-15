/** `#rrggbb` candidate from a draft that may omit the leading `#`. */
export const withHash = (draft: string): string => (draft.startsWith('#') ? draft : `#${draft}`);

/** Id of the editable copy made from a built-in theme. */
export const customCopyId = (themeId: string): string => `${themeId}-custom`;

/** Id for an explicit duplicate (Ctrl+D); truncated so it stays a valid theme id. */
export const duplicateId = (themeId: string): string => `${themeId.slice(0, 28)}-copy`;

export const HEX_CHAR = /^[#0-9a-fA-F]$/;
