import { Request, Response, NextFunction } from "express";

export function adminMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const role = req.headers["x-user-role"];

    if (role !== "admin") {
        return res.status(403).json({
            message: "Forbidden",
        });
    }

    next();
}