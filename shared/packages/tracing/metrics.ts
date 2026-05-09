import { Registry, Histogram, Counter, collectDefaultMetrics } from "prom-client";
import { Request, Response, NextFunction } from "express";

export const register = new Registry();

collectDefaultMetrics({ register });

export const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
    registers: [register],
});

export const sagaEventCounter = new Counter({
    name: "saga_events_total",
    help: "Total saga events published",
    labelNames: ["event_name", "service"] as const,
    registers: [register],
});

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
        const duration = Number(process.hrtime.bigint() - start) / 1e9;
        const route = (req as any).route?.path || req.path;
        httpRequestDuration.observe(
            { method: req.method, route, status_code: String(res.statusCode) },
            duration
        );
    });
    next();
}
