/** `@ratel-ai/cloud-sdk/runtime` — fail-open runtime facts delivery. */

export type {
  RuntimeCatalogSnapshot,
  RuntimeCatalogToolDefinition,
  RuntimeEvent,
} from "../types.js";
export {
  type AttachOptions,
  attach,
  type RatelRuntime,
  type RatelRuntimeCatalog,
  type RatelRuntimeCatalogToolDefinition,
  type RatelRuntimeEvents,
  type RuntimeAttachment,
  type RuntimeEventSubscription,
} from "./attach.js";
export {
  type DeliveryKind,
  type DeliveryOverall,
  type DeliveryResult,
  DeliveryStatus,
  type DeliveryStatusOptions,
  type EventsDeliveryStatus,
  type RuntimeDeliveryStatus,
  type SnapshotDeliveryStatus,
} from "./delivery-status.js";
export { hashCatalogSnapshot } from "./hash.js";
export {
  RUNTIME_EVENT_BATCH_MAX_BYTES,
  RUNTIME_EVENT_BATCH_MAX_EVENTS,
  RUNTIME_EVENT_MAX_BYTES,
  type RuntimeEventRejection,
  RuntimeEventsPublisher,
  type RuntimeEventsPublisherOptions,
  type RuntimeEventsRetryOptions,
} from "./publisher.js";
export {
  CatalogSnapshotsPublisher,
  type CatalogSnapshotsPublisherOptions,
} from "./snapshots.js";
