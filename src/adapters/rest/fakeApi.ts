import { http, HttpResponse, type JsonBodyType, type PathParams, type RequestHandler } from 'msw';
import { createMemoryBackend, type MemoryBackend } from '@/adapters/memory';
import { keysToCamel, keysToSnake } from '@/lib/caseConversion';
import { AppError, toAppError, type ErrorCode } from '@/lib/errors';
import { parseOrInvalid } from '@/lib/validation';
import {
  categoryInputSchema,
  closeSessionRecordSchema,
  credentialsSchema,
  listSalesQuerySchema,
  openSessionRecordSchema,
  productCreateInputSchema,
  productUpdateInputSchema,
  saleRecordSchema,
  shopSettingsSchema,
  voidReceiptInputSchema,
  type AuthUser,
  type Backend,
  type DemoAccount,
} from '@/ports';
import { freshTerminalCode, type ContractFixture } from '@/ports/__contracts__';
import { createRestBackend } from './index';
import type { StorageLike } from './session';
import { HTTP_CREATED } from './writes';

/*
 * A fake of contracts/openapi.yaml for tests, as MSW handlers. There is no Spring Boot service yet,
 * so this stands in for one: it answers the shapes and statuses of the OpenAPI file over the memory
 * backend, which is the reference implementation of every port (its ledger, its order of checks and
 * its errors are the ones contracts/errors.md describes). The handlers only translate — bearer
 * token to a signed-in client, snake_case to camelCase and back, AppError to the error envelope and
 * its status — so a test that runs the port contract suite through them tests this adapter rather
 * than a second ledger written for the occasion.
 *
 * Nothing here ships: it is imported by tests only, never by src/lib/backend.ts.
 */

/** Where the fake API answers. Tests hand this to `createRestBackend`. */
export const FAKE_API_BASE_URL = 'http://rest.test';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVER_ERROR = 500;

/**
 * The status contracts/errors.md gives each code a server may send. The codes outside this table —
 * NETWORK_ERROR, CONFIG_ERROR, UNKNOWN — are the client's own and are not in the OpenAPI enum, so a
 * server that hits one has failed on its own: that is a 500 SERVER_ERROR on the wire.
 */
const WIRE_STATUS: Partial<Record<ErrorCode, number>> = {
  SERVER_ERROR: HTTP_SERVER_ERROR,
  RATE_LIMITED: 429,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  IDEMPOTENCY_CONFLICT: 409,
  SEQUENCE_GAP: 409,
  SESSION_CLOSED: 409,
  SESSION_ALREADY_OPEN: 409,
  TERMINAL_SUPERSEDED: 409,
};

/**
 * A port value on the wire: snake_case keys at any depth, values untouched. The cast says what
 * renaming keys cannot prove — a port DTO is JSON data, and renaming its keys keeps it JSON.
 */
function wire(value: unknown): JsonBodyType {
  return keysToSnake(value) as JsonBodyType;
}

function json(value: unknown, status: number): Response {
  return HttpResponse.json(wire(value), { status });
}

/** The error envelope of contracts/errors.md, with the status the code maps to. */
function errorResponse(error: AppError): Response {
  const code: ErrorCode = WIRE_STATUS[error.code] === undefined ? 'SERVER_ERROR' : error.code;
  return HttpResponse.json(
    { error: { code, message: error.message, details: wire(error.details) } },
    { status: WIRE_STATUS[code] ?? HTTP_SERVER_ERROR },
  );
}

/** Runs one request; every failure leaves as the envelope, as a real service would answer. */
function serve(body: () => Promise<Response>): Promise<Response> {
  return body().catch((error: unknown) => errorResponse(toAppError(error)));
}

/** The JSON body of a request, read into the camelCase shape the ports use. */
async function jsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) {
    throw new AppError('VALIDATION_ERROR', 'The request carries no body.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new AppError('VALIDATION_ERROR', 'The request body is not JSON.', { cause: error });
  }
  return keysToCamel(parsed);
}

/** One path parameter; MSW types a repeated segment as an array, and these routes have none. */
function param(params: PathParams, name: string): string {
  const value = params[name];
  if (typeof value !== 'string') {
    throw new AppError('UNKNOWN', `This route has no ${name} parameter.`);
  }
  return value;
}

/** A Member as the OpenAPI file defines it; `wire` renames the keys. */
function memberOf(user: AuthUser): object {
  return {
    userId: user.id,
    shopId: user.shopId,
    role: user.role,
    displayName: user.name,
    email: user.email,
  };
}

/** A record write's answer: 201 for the one this call stored, 200 for an outcome already stored. */
function written(result: { readonly status: string }, createdStatus: string): Response {
  return json(result, result.status === createdStatus ? HTTP_CREATED : HTTP_OK);
}

export interface FakeApiOptions {
  /** Where the API answers; default: FAKE_API_BASE_URL. */
  readonly baseUrl?: string;
  /** The data behind it; default: a new memory backend with the demo seed. */
  readonly backend?: MemoryBackend;
  /** What the token endpoint promises, in seconds; default: an hour. */
  readonly expiresIn?: number;
}

export interface FakeApi {
  readonly baseUrl: string;
  /** The shared data. Its `demoAccounts` are the sign-ins this API accepts. */
  readonly backend: MemoryBackend;
  /** For `setupServer(...)` or `server.use(...)`. */
  readonly handlers: readonly RequestHandler[];
  /** How many sign-ins this API has handed a token to. */
  tokenCount(): number;
}

/** One signed-in device: its own client of the shared data, like one browser. */
interface FakeClient {
  readonly backend: Backend;
  readonly user: AuthUser;
}

/** An API of its own, with data of its own. Every call builds a new one. */
export function createFakeApi(options: FakeApiOptions = {}): FakeApi {
  const baseUrl = (options.baseUrl ?? FAKE_API_BASE_URL).replace(/\/+$/, '');
  const backend = options.backend ?? createMemoryBackend();
  const expiresIn = options.expiresIn ?? 3600;
  const api = `${baseUrl}/api/v1`;
  const clients = new Map<string, FakeClient>();

  /** The member the request's bearer token belongs to. */
  function clientOf(request: Request): FakeClient {
    const header = request.headers.get('Authorization') ?? '';
    const prefix = 'Bearer ';
    const client = header.startsWith(prefix) ? clients.get(header.slice(prefix.length)) : undefined;
    if (!client) {
      throw new AppError('UNAUTHENTICATED', 'This request carries no session.');
    }
    return client;
  }

  const handlers: RequestHandler[] = [
    http.post(`${api}/auth/token`, ({ request }) =>
      serve(async () => {
        const credentials = parseOrInvalid(
          credentialsSchema,
          await jsonBody(request),
          'the credentials',
        );
        // A client of its own per token: one device holds one session, as a browser does.
        const client = backend.connect();
        const user = await client.auth.signIn(credentials);
        const accessToken = crypto.randomUUID();
        clients.set(accessToken, { backend: client, user });
        return json(
          { accessToken, tokenType: 'bearer', expiresIn, member: memberOf(user) },
          HTTP_OK,
        );
      }),
    ),

    http.get(`${api}/me`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const state = await client.backend.auth.getState();
        if (state.status !== 'authenticated') {
          throw new AppError('UNAUTHENTICATED', 'This session has ended.');
        }
        return json(memberOf(state.user), HTTP_OK);
      }),
    ),

    http.get(`${api}/products`, ({ request }) =>
      serve(async () => json(await clientOf(request).backend.catalog.listProducts(), HTTP_OK)),
    ),

    http.post(`${api}/products`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const input = parseOrInvalid(
          productCreateInputSchema,
          await jsonBody(request),
          'the product',
        );
        return json(await client.backend.catalog.createProduct(input), HTTP_CREATED);
      }),
    ),

    http.put(`${api}/products/:productId`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        const input = parseOrInvalid(
          productUpdateInputSchema,
          await jsonBody(request),
          'the product',
        );
        const product = await client.backend.catalog.updateProduct(
          param(params, 'productId'),
          input,
        );
        return json(product, HTTP_OK);
      }),
    ),

    http.delete(`${api}/products/:productId`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        await client.backend.catalog.deleteProduct(param(params, 'productId'));
        return new HttpResponse(null, { status: HTTP_NO_CONTENT });
      }),
    ),

    http.get(`${api}/categories`, ({ request }) =>
      serve(async () => json(await clientOf(request).backend.catalog.listCategories(), HTTP_OK)),
    ),

    http.post(`${api}/categories`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const input = parseOrInvalid(categoryInputSchema, await jsonBody(request), 'the category');
        return json(await client.backend.catalog.createCategory(input), HTTP_CREATED);
      }),
    ),

    http.delete(`${api}/categories/:categoryId`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        await client.backend.catalog.deleteCategory(param(params, 'categoryId'));
        return new HttpResponse(null, { status: HTTP_NO_CONTENT });
      }),
    ),

    http.get(`${api}/shop-settings`, ({ request }) =>
      serve(async () => json(await clientOf(request).backend.settings.getSettings(), HTTP_OK)),
    ),

    http.put(`${api}/shop-settings`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const input = parseOrInvalid(shopSettingsSchema, await jsonBody(request), 'the settings');
        return json(await client.backend.settings.updateSettings(input), HTTP_OK);
      }),
    ),

    http.post(`${api}/terminals/:terminalCode/registrations`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        const registration = await client.backend.terminals.register(param(params, 'terminalCode'));
        return json(registration, HTTP_CREATED);
      }),
    ),

    http.get(`${api}/cash-sessions`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const query = new URL(request.url).searchParams;
        const terminalId = query.get('terminal_id');
        if (terminalId === null) {
          throw new AppError('VALIDATION_ERROR', 'terminal_id is required.', {
            details: { field: 'terminal_id' },
          });
        }
        if (query.get('status') !== 'open') {
          // The ports ask for the open session only; this fake serves nothing it cannot answer.
          throw new AppError('VALIDATION_ERROR', 'This API lists sessions with status=open only.', {
            details: { field: 'status' },
          });
        }
        const session = await client.backend.sessions.current(terminalId);
        return json(session === null ? [] : [session], HTTP_OK);
      }),
    ),

    http.post(`${api}/cash-sessions`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const record = parseOrInvalid(
          openSessionRecordSchema,
          await jsonBody(request),
          'the session record',
        );
        return written(await client.backend.sessions.open(record), 'created');
      }),
    ),

    http.post(`${api}/cash-sessions/:sessionId/closures`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        const record = parseOrInvalid(
          closeSessionRecordSchema,
          await jsonBody(request),
          'the close record',
        );
        if (record.sessionId !== param(params, 'sessionId')) {
          throw new AppError(
            'VALIDATION_ERROR',
            'The record names another session than the path.',
            {
              details: { field: 'session_id' },
            },
          );
        }
        return written(await client.backend.sessions.close(record), 'created');
      }),
    ),

    http.get(`${api}/cash-sessions/:sessionId/z-report`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        const report = await client.backend.sessions.zReport(param(params, 'sessionId'));
        return json(report, HTTP_OK);
      }),
    ),

    http.get(`${api}/sales`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const search = new URL(request.url).searchParams;
        const limit = search.get('limit');
        const query = parseOrInvalid(
          listSalesQuerySchema,
          {
            terminalId: search.get('terminal_id') ?? undefined,
            sessionId: search.get('session_id') ?? undefined,
            limit: limit === null ? undefined : Number(limit),
          },
          'the sales query',
        );
        return json(await client.backend.sales.listSales(query), HTTP_OK);
      }),
    ),

    http.post(`${api}/sales`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const record = parseOrInvalid(saleRecordSchema, await jsonBody(request), 'the sale record');
        return written(await client.backend.sales.recordSale(record), 'created');
      }),
    ),

    http.get(`${api}/sales/:saleId`, ({ request, params }) =>
      serve(async () => {
        const client = clientOf(request);
        return json(await client.backend.sales.getSale(param(params, 'saleId')), HTTP_OK);
      }),
    ),

    http.post(`${api}/receipt-voids`, ({ request }) =>
      serve(async () => {
        const client = clientOf(request);
        const input = parseOrInvalid(voidReceiptInputSchema, await jsonBody(request), 'the void');
        return written(await client.backend.sales.voidReceipt(input), 'voided');
      }),
    ),
  ];

  return { baseUrl, backend, handlers, tokenCount: () => clients.size };
}

/** A session store of one device, in this process only. */
export function memoryStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
}

/** A REST backend of its own — one device — signed in as `account` against `api`. */
export async function signInDemo(api: FakeApi, account: DemoAccount): Promise<FakeMember> {
  const storage = memoryStorage();
  const backend = createRestBackend({
    baseUrl: api.baseUrl,
    storage: () => storage,
    storageKey: `rest-${account.email}`,
  });
  const user = await backend.auth.signIn({ email: account.email, password: account.password });
  return { backend, user, account };
}

/** One device, signed in, as the contract fixture and the adapter's own tests see it. */
export interface FakeMember {
  readonly backend: Backend;
  readonly user: AuthUser;
  readonly account: DemoAccount;
}

/**
 * The fixture the port contract suite runs on: one shop, seen through a REST backend signed in as
 * its admin and another signed in as its cashier. The API's handlers must already be installed.
 */
export async function demoFixture(api: FakeApi): Promise<ContractFixture> {
  const members: FakeMember[] = [];
  for (const account of api.backend.demoAccounts) {
    members.push(await signInDemo(api, account));
  }
  const admin = members.find((member) => member.user.role === 'admin');
  const cashier = members.find(
    (member) => member.user.role === 'cashier' && member.user.shopId === admin?.user.shopId,
  );
  if (!admin || !cashier) {
    throw new AppError(
      'CONFIG_ERROR',
      'This API offers no demo admin and cashier of one shop to run the contract as.',
    );
  }
  return {
    admin: admin.backend,
    cashier: cashier.backend,
    adminUser: admin.user,
    cashierUser: cashier.user,
    newTerminalCode: freshTerminalCode,
  };
}
