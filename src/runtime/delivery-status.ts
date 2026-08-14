export type DeliveryKind =
  | "ok"
  | "auth"
  | "gated"
  | "not_deployed"
  | "rate_limited"
  | "rejected_payload"
  | "network";

export type DeliveryOverall = "ok" | "pending" | "degraded" | "blocked" | "disabled";

export interface DeliveryResult {
  readonly kind: DeliveryKind;
  readonly status: number | null;
  readonly message: string | null;
}

export interface EventsDeliveryStatus {
  readonly lastOutcome: DeliveryResult | null;
  readonly lastAcceptedAt: number | null;
  readonly lastAttemptAt: number | null;
  readonly lastError: string | null;
  readonly accepted: number;
  readonly rejected: number;
  readonly dropped: number;
}

export interface SnapshotDeliveryStatus {
  readonly lastDurableAt: number | null;
  readonly pendingSince: number | null;
  readonly lastOutcome: DeliveryResult | null;
}

export interface RuntimeDeliveryStatus {
  readonly overall: DeliveryOverall;
  readonly events: EventsDeliveryStatus;
  readonly snapshots: Readonly<Record<string, SnapshotDeliveryStatus>>;
}

export interface DeliveryStatusOptions {
  readonly enabled?: boolean;
  readonly warnOnFailure?: boolean;
  readonly onStatusChange?: (status: RuntimeDeliveryStatus) => void;
}

interface MutableEventsDeliveryStatus {
  lastOutcome: DeliveryResult | null;
  lastAcceptedAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  accepted: number;
  rejected: number;
  dropped: number;
}

interface MutableSnapshotDeliveryStatus {
  lastDurableAt: number | null;
  pendingSince: number | null;
  lastOutcome: DeliveryResult | null;
}

const BLOCKED_KINDS = new Set<DeliveryKind>(["auth", "gated", "not_deployed"]);
const FAILURE_MEANINGS: Readonly<Record<Exclude<DeliveryKind, "ok">, string>> = {
  auth: "authentication failed — facts are not persisting",
  gated:
    "requests are intercepted by an auth gate before reaching Ratel Cloud — facts are not persisting",
  not_deployed: "the runtime ingestion endpoint is not deployed — facts are not persisting",
  rate_limited: "Ratel Cloud is rate limiting delivery — facts may be delayed",
  rejected_payload: "Ratel Cloud rejected the payload — some facts are not persisting",
  network: "Ratel Cloud cannot be reached — facts may be delayed",
};

/** Shared, fail-open delivery health for runtime events and catalog snapshots. */
export class DeliveryStatus {
  readonly #enabled: boolean;
  readonly #warnOnFailure: boolean;
  readonly #onStatusChange: ((status: RuntimeDeliveryStatus) => void) | undefined;
  readonly #events: MutableEventsDeliveryStatus = {
    lastOutcome: null,
    lastAcceptedAt: null,
    lastAttemptAt: null,
    lastError: null,
    accepted: 0,
    rejected: 0,
    dropped: 0,
  };
  readonly #snapshots = new Map<string, MutableSnapshotDeliveryStatus>();
  readonly #targetKinds = new Map<string, DeliveryKind>();
  readonly #warnedKinds = new Set<DeliveryKind>();

  constructor(options: DeliveryStatusOptions = {}) {
    this.#enabled = options.enabled ?? true;
    this.#warnOnFailure = options.warnOnFailure ?? true;
    this.#onStatusChange = options.onStatusChange;
  }

  snapshot(): RuntimeDeliveryStatus {
    const snapshots = Object.create(null) as Record<string, SnapshotDeliveryStatus>;
    for (const [sourceId, status] of this.#snapshots) {
      snapshots[sourceId] = {
        ...status,
        lastOutcome: cloneResult(status.lastOutcome),
      };
    }
    return {
      overall: this.#overall(),
      events: {
        ...this.#events,
        lastOutcome: cloneResult(this.#events.lastOutcome),
      },
      snapshots,
    };
  }

  recordEvents(
    result: DeliveryResult,
    counts: { readonly accepted?: number; readonly rejected?: number } = {},
  ): void {
    try {
      const now = Date.now();
      const accepted = safeCount(counts.accepted);
      this.#events.lastOutcome = result;
      this.#events.lastAttemptAt = now;
      this.#events.lastError = result.message;
      this.#events.accepted += accepted;
      this.#events.rejected += safeCount(counts.rejected);
      if (result.kind === "ok" || accepted > 0) this.#events.lastAcceptedAt = now;
      this.#transition("events", result.kind);
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordEventRejections(count: number): void {
    try {
      if (count <= 0) return;
      this.recordEvents(
        {
          kind: "rejected_payload",
          status: null,
          message: "one or more events could not be serialized for delivery",
        },
        { rejected: count },
      );
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordEventDrops(count: number): void {
    try {
      this.#events.dropped += safeCount(count);
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordSnapshotPending(sourceId: string): void {
    try {
      const status = this.#snapshotFor(sourceId);
      status.pendingSince ??= Date.now();
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordSnapshot(sourceId: string, result: DeliveryResult): void {
    try {
      const status = this.#snapshotFor(sourceId);
      status.lastOutcome = result;
      this.#transition(`snapshot:${sourceId}`, result.kind);
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordSnapshotDurable(sourceId: string, result: DeliveryResult, settled: boolean): void {
    try {
      const status = this.#snapshotFor(sourceId);
      status.lastOutcome = result;
      status.lastDurableAt = Date.now();
      if (settled) status.pendingSince = null;
      this.#transition(`snapshot:${sourceId}`, result.kind);
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  recordSnapshotSettled(sourceId: string): void {
    try {
      const status = this.#snapshotFor(sourceId);
      if (status.pendingSince === null) return;
      const result: DeliveryResult = { kind: "ok", status: null, message: null };
      status.lastOutcome = result;
      status.pendingSince = null;
      this.#transition(`snapshot:${sourceId}`, result.kind);
    } catch {
      // Observability cannot affect agent delivery.
    }
  }

  #overall(): DeliveryOverall {
    if (!this.#enabled) return "disabled";
    const outcomes = [
      this.#events.lastOutcome?.kind,
      ...[...this.#snapshots.values()].map((status) => status.lastOutcome?.kind),
    ];
    if (outcomes.some((kind) => kind !== undefined && BLOCKED_KINDS.has(kind))) {
      return "blocked";
    }
    if (outcomes.some((kind) => kind !== undefined && kind !== "ok")) return "degraded";
    if (
      this.#events.lastOutcome === null ||
      [...this.#snapshots.values()].some((status) => status.pendingSince !== null)
    ) {
      return "pending";
    }
    return "ok";
  }

  #snapshotFor(sourceId: string): MutableSnapshotDeliveryStatus {
    const existing = this.#snapshots.get(sourceId);
    if (existing) return existing;
    const created: MutableSnapshotDeliveryStatus = {
      lastDurableAt: null,
      pendingSince: null,
      lastOutcome: null,
    };
    this.#snapshots.set(sourceId, created);
    return created;
  }

  #transition(target: string, kind: DeliveryKind): void {
    const previous = this.#targetKinds.get(target);
    if (previous === kind) return;
    this.#targetKinds.set(target, kind);
    if (previous !== undefined && !this.#hasActiveKind(previous))
      this.#warnedKinds.delete(previous);
    if (kind !== "ok" && !this.#warnedKinds.has(kind)) {
      this.#warnedKinds.add(kind);
      if (this.#warnOnFailure) this.#warn(kind);
    }
    try {
      this.#onStatusChange?.(this.snapshot());
    } catch {
      // User callbacks remain fail-open.
    }
  }

  #hasActiveKind(kind: DeliveryKind): boolean {
    for (const active of this.#targetKinds.values()) {
      if (active === kind) return true;
    }
    return false;
  }

  #warn(kind: Exclude<DeliveryKind, "ok">): void {
    try {
      console.warn(`[ratel-cloud-sdk/runtime] ${kind}: ${FAILURE_MEANINGS[kind]}`);
    } catch {
      // Console diagnostics remain fail-open.
    }
  }
}

export function classifyDelivery(response: Response | undefined): DeliveryResult {
  if (response === undefined) {
    return {
      kind: "network",
      status: null,
      message: "request failed before reaching Ratel Cloud",
    };
  }
  const { status } = response;
  if (status >= 200 && status < 300) return { kind: "ok", status, message: null };
  if (status >= 300 && status < 400) {
    return { kind: "gated", status, message: `request intercepted with HTTP ${status}` };
  }
  if (status === 401) return { kind: "auth", status, message: "authentication failed" };
  if (status === 404) {
    return { kind: "not_deployed", status, message: "runtime ingestion endpoint not found" };
  }
  if (status === 429) return { kind: "rate_limited", status, message: "rate limited" };
  if (status >= 400 && status < 500) {
    return { kind: "rejected_payload", status, message: `payload rejected with HTTP ${status}` };
  }
  return { kind: "network", status, message: `delivery failed with HTTP ${status}` };
}

function cloneResult(result: DeliveryResult | null): DeliveryResult | null {
  return result === null ? null : { ...result };
}

function safeCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0 ? (value as number) : 0;
}
