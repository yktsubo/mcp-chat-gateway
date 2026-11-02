// Server logs written as one-line JSON to stdout/stderr.
// Do not pass tokens, secrets, or authorization codes.

type Fields = Record<string, unknown>;

/** Converts an error to log fields, optionally with the stack */
export function errorFields(error: unknown, withStack = false): Fields {
  if (!(error instanceof Error)) return { error: String(error) };
  return { error: `${error.name}: ${error.message}`, ...(withStack && error.stack ? { stack: error.stack } : {}) };
}

function write(level: 'info' | 'warn' | 'error', event: string, fields: Fields) {
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  info: (event: string, fields: Fields = {}) => write('info', event, fields),
  warn: (event: string, fields: Fields = {}) => write('warn', event, fields),
  error: (event: string, fields: Fields = {}) => write('error', event, fields),
};
