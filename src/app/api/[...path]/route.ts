import { fail } from "@/lib/api";

/**
 * Any /api path that no route serves: a JSON 404, whatever the method.
 * Without this, a POST or DELETE to an unknown path was answered with the
 * app's HTML page and a 200, which a client reads as success (#71). Every
 * real route is more specific than this one, so it never shadows them.
 */
function notFound() {
  return fail("Not found.", 404);
}

export const GET = notFound;
export const HEAD = notFound;
export const POST = notFound;
export const PUT = notFound;
export const PATCH = notFound;
export const DELETE = notFound;
