export type Log = (code: string, details?: Record<string, string | number | boolean>) => void;

// Callers supply codes and identifiers, never provider error bodies or transcript text.
export const log: Log = (code, details = {}) => {
  console.error(JSON.stringify({ time: new Date().toISOString(), code, ...details }));
};
