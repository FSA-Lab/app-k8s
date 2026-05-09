import { Request, Response, NextFunction } from "express";

export function authMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
) {
    const userId = req.headers["x-user-id"];

    if (!userId) {
        return res.status(401).json({
            message: "Unauthorized",
        });
    }

    next();
}