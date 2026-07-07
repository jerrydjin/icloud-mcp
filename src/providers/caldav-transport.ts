import { createDAVClient, type DAVCalendar, type DAVCollection } from "tsdav";
import type { ServiceProvider } from "../types.js";

// Shared CalDAV/CardDAV transport. Handles connection setup, Basic auth, and
// one-time discovery. Subclasses (CalendarProvider, RemindersProvider via CalDAV-VTODO,
// ContactsProvider via CardDAV) inherit connection management and add resource-specific
// operations.
//
// CalDAV/CardDAV are stateless HTTP with Basic auth per request. There's no persistent
// connection, no keepalive, no NOOP equivalent. ensureConnected() guards one-time
// PROPFIND discovery only.

export type DAVClientInstance = Awaited<ReturnType<typeof createDAVClient>>;

export type AccountType = "caldav" | "carddav";

export abstract class CalDavTransport implements ServiceProvider {
  protected client: DAVClientInstance | null = null;
  protected connected = false;

  constructor(
    protected serverUrl: string,
    protected email: string,
    protected password: string,
    protected accountType: AccountType
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    this.client = await createDAVClient({
      serverUrl: this.serverUrl,
      credentials: {
        username: this.email,
        password: this.password,
      },
      authMethod: "Basic",
      defaultAccountType: this.accountType,
    });
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.connected = false;
    this.onDisconnect();
  }

  async ensureConnected(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
  }

  /**
   * Hook for subclasses to clear their own caches on disconnect. Default: no-op.
   */
  protected onDisconnect(): void {}

  /**
   * Subclasses access the underlying DAV client through this getter so they get
   * a sensible error if they forget to call ensureConnected().
   */
  protected get dav(): DAVClientInstance {
    if (!this.client) {
      throw new Error(
        `${this.constructor.name} not connected — call ensureConnected() first`
      );
    }
    return this.client;
  }
}

export type { DAVCalendar, DAVCollection };
