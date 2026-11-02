import type { Instrumentation } from 'next';
import { errorFields, log } from './lib/log';

// Logs unhandled server errors caught by Next.js
export const onRequestError: Instrumentation.onRequestError = (error, request, context) => {
  log.error('request_error', {
    method: request.method,
    path: request.path,
    route: context.routePath,
    routeType: context.routeType,
    ...errorFields(error, true),
  });
};
