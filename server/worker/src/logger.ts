import pino from 'pino';

const defaultLevel = process.env['VITEST'] ? 'silent' : (process.env['LOG_LEVEL'] ?? 'info');

export function createLogger(level = defaultLevel): pino.Logger {
  return pino({ level });
}

export const logger = createLogger();
