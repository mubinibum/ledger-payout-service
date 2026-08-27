import { pino, type Logger, type LoggerOptions } from 'pino';
import { loadEnv } from '../config/env.js';

/**
 * Shared pino configuration. In development the output is pretty-printed if `pino-pretty`
 * is installed; otherwise it stays as line-delimited JSON so it can be shipped to a log
 * pipeline unchanged. The same options drive both Fastify's request logger and the
 * standalone `logger` used for startup/shutdown.
 */
export function loggerOptions(): LoggerOptions {
  const env = loadEnv();
  const base: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'ledger-payout-service' },
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.secret'],
      censor: '[redacted]',
    },
  };
  if (env.NODE_ENV === 'development') {
    return {
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      },
    };
  }
  return base;
}

/** Standalone logger for lifecycle events outside the request path. */
export const logger: Logger = pino(loggerOptions());
