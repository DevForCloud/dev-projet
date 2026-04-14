require("./tracing");
const { register, httpRequestsTotal, httpRequestDurationMs } = require("./metrics");
const express = require("express");
const pino = require("pino");
const pinoHttp = require("pino-http");
const {
  startSubscriber,
  getNotifications,
  markAsRead,
} = require("./subscriber");

const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const ERROR_CODE = 500;
const app = express();

app.use(express.json());
app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = req.route
      ? `${req.baseUrl || ""}${req.route.path}`
      : req.baseUrl || req.path || "unknown";
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };

    httpRequestsTotal.inc(labels);
    httpRequestDurationMs.observe(labels, durationMs);
  });

  next();
});
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res) => {
      if (res.statusCode >= ERROR_CODE) return "error";
      return "info";
    },
    customSuccessMessage: (req, res) => {
      if (res.statusCode >= 400) return req.errorMessage ?? `request failed`;
      return `${req.method} completed`;
    },
    customErrorMessage: (req, res, err) => `request failed : ${err.message}`,
  }),
);

app.get("/health", (req, res) =>
  res.json({ status: "ok", service: "notification-service" }),
);

app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// GET /notifications?userId=xxx
app.get("/notifications", (req, res) => {
  const { userId } = req.query;
  res.json(getNotifications(userId));
});

// PATCH /notifications/:id/read
app.patch("/notifications/:id/read", (req, res) => {
  const notif = markAsRead(req.params.id);
  if (!notif) return res.status(404).json({ error: "Notification not found" });
  res.json(notif);
});

const PORT = process.env.PORT || 3003;
app.listen(PORT, async () => {
  await startSubscriber();
  logger.info({ port: PORT }, "notification-service started");
});
