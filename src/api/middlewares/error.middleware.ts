import { Request, Response, NextFunction } from 'express';

export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  res.status(404).json({
    error: 'Not Found',
    message: `Cannot ${req.method} ${req.originalUrl}`,
  });
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const status = err.status || err.statusCode || 500;
  const isProd = process.env.NODE_ENV === 'production';
  const rawMessage = err.message || 'Internal Server Error';

  if (status === 413 || err.type === 'entity.too.large') {
    res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request payload exceeded maximum size limit',
    });
    return;
  }

  if (status === 504) {
    res.status(504).json({
      error: 'Gateway Timeout',
      message: rawMessage || 'Request processing exceeded timeout deadline',
    });
    return;
  }

  const responseMessage = status === 500 && isProd
    ? 'An unexpected internal error occurred'
    : rawMessage;

  console.error('[Unhandled Error]', {
    method: req.method,
    url: req.originalUrl,
    status,
    message: rawMessage,
    stack: !isProd ? err.stack : undefined,
  });

  res.status(status).json({
    error: status === 500 ? 'Internal Server Error' : err.name || 'Error',
    message: responseMessage,
  });
}
