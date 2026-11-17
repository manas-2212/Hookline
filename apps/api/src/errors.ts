import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";

/** RFC 9457 problem details. */
export class Problem extends Error {
  constructor(
    public status: number,
    public title: string,
    public detail?: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
  }
}

export const notFound = (what: string) => new Problem(404, "Not Found", `${what} not found`);
export const forbidden = (detail = "insufficient role") => new Problem(403, "Forbidden", detail);
export const unauthorized = (detail = "missing or invalid credentials") => new Problem(401, "Unauthorized", detail);

export function errorHandler(err: FastifyError | Problem, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof Problem) {
    return reply
      .status(err.status)
      .type("application/problem+json")
      .send({ type: "about:blank", title: err.title, status: err.status, detail: err.detail, instance: req.url, ...err.extra });
  }
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply
      .status(400)
      .type("application/problem+json")
      .send({
        type: "about:blank",
        title: "Bad Request",
        status: 400,
        detail: "request validation failed",
        instance: req.url,
        errors: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
      });
  }
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) req.log.error({ err }, "unhandled error");
  return reply
    .status(status)
    .type("application/problem+json")
    .send({ type: "about:blank", title: status >= 500 ? "Internal Server Error" : err.message, status, instance: req.url });
}
