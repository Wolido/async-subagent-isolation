/**
 * Web API version literal of the local web view.
 *
 * Bumped to 2 in round 7: `GET /api/tree` changed from a bare array to the
 * object `{ apiVersion, nodes, truncated, expand }`. Consumers (`server.ts`,
 * later `page.ts`) import this constant instead of hard-coding the number.
 */

export const API_VERSION = 2;
