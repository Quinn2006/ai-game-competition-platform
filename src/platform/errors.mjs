export class AppError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function publicError(error, requestId) {
  const known = error instanceof AppError;
  return {
    status: known ? error.status : 500,
    body: { error: { code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : '服务暂时不可用', requestId } },
  };
}
