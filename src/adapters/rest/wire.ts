import type { z } from 'zod';
import { keysToCamel, keysToSnake } from '@/lib/caseConversion';
import { parseOrInvalid } from '@/lib/validation';
import type { components } from './api.types';

/*
 * The wire shapes of contracts/openapi.yaml. `api.types.ts` next to this file is generated from the
 * YAML by `npm run api:types`, which runs openapi-typescript through npx because that package peer-
 * requires TypeScript 5 while this project is on 6; the output is committed, so nobody needs the
 * network to build.
 *
 * The generated `ErrorCode` is deliberately NOT the app's ErrorCode. The OpenAPI enum lists only the
 * codes a server can send; NETWORK_ERROR, CONFIG_ERROR and UNKNOWN are raised on this side of the
 * wire and never travel, so a generated union would be missing exactly the codes the client needs
 * most. src/lib/errors.ts owns the app's list, and http.ts checks an envelope's code against it
 * (`isErrorCode`): a code outside that list is classified by the HTTP status instead, as
 * contracts/errors.md says.
 */

type Schemas = components['schemas'];

export type WireCredentials = Schemas['Credentials'];
export type WireToken = Schemas['Token'];
export type WireMember = Schemas['Member'];
export type WireProduct = Schemas['Product'];
export type WireProductCreate = Schemas['ProductCreate'];
export type WireProductUpdate = Schemas['ProductUpdate'];
export type WireCategory = Schemas['Category'];
export type WireCategoryCreate = Schemas['CategoryCreate'];
export type WireShopSettings = Schemas['ShopSettings'];
export type WireTerminalRegistration = Schemas['TerminalRegistration'];
export type WireCashSession = Schemas['CashSession'];
export type WireZReport = Schemas['ZReport'];
export type WireOpenSessionRecord = Schemas['OpenSessionRecord'];
export type WireCloseSessionRecord = Schemas['CloseSessionRecord'];
export type WireOpenSessionResult = Schemas['OpenSessionResult'];
export type WireCloseSessionResult = Schemas['CloseSessionResult'];
export type WireSale = Schemas['Sale'];
export type WireSaleRecord = Schemas['SaleRecord'];
export type WireRecordSaleResult = Schemas['RecordSaleResult'];
export type WireVoidReceiptRequest = Schemas['VoidReceiptRequest'];
export type WireVoidReceiptResult = Schemas['VoidReceiptResult'];
export type WireErrorEnvelope = Schemas['ErrorEnvelope'];

/**
 * A port DTO as a request body: every key renamed to snake_case at any depth, every value left
 * exactly as it was, so `payload_hash` still matches the record it was computed over
 * (contracts/errors.md). `Body` names the generated shape the result has to match; renaming keys is
 * beyond what the type system can follow, so the OpenAPI type states it where a reader can check it.
 */
export function toWire<Body>(value: object): Body {
  return keysToSnake(value) as Body;
}

/**
 * A response read into a port DTO: keys renamed to camelCase, then checked with a port schema. The
 * check is the real guarantee — the generated types describe what the server promises, `schema`
 * decides what the app accepts — and an answer that fails it is VALIDATION_ERROR, because no retry
 * will make it readable.
 */
export function fromWire<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  what: string,
): z.output<Schema> {
  return parseOrInvalid(schema, keysToCamel(value), what);
}
