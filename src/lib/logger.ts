import winston from "winston";

const { combine, timestamp, printf, colorize, splat } = winston.format;

const customFormat = printf(({ level, message, timestamp, ...meta }) => {
  const extra = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
  return `${timestamp} [${level}] ${message}${extra}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    splat(),
    timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    customFormat,
  ),
  defaultMeta: { service: "picser" },
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), customFormat),
      stderrLevels: ["error"],
    }),
  ],
});
