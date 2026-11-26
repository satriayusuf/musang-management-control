import type {
  ClaimedCommand,
  CommandResult,
  HeartbeatResponse,
  RegisterResponse,
} from "./types.js";

/** Transport-level failure (DNS, refused, timeout, ...). Safe to retry with backoff. */
export class NetworkError extends Error {}

/** The server answered with a non-2xx status. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }

  /** True when the server says this session was superseded by a newer bridge. */
  get isSuperseded(): boolean {
    return (
      this.status === 409 &&
      typeof this.body === "object" &&
      this.body !== null &&
      (this.body as { error?: unknown }).error === "SESSION_SUPERSEDED"
    );
  }
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** Small HTTP client for the agent API. Outbound HTTPS only, Bearer agent token. */
export class BridgeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, timeoutMs = 10_000) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.timeoutMs),
      });
    } catch (err) {
      throw new NetworkError(err instanceof Error ? err.message : String(err));
    }

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) throw new HttpError(res.status, data);
    return data as T;
  }

  /** Pairing (no token) or re-attach (Bearer token). */
  register(body: Record<string, unknown>, token?: string): Promise<RegisterResponse> {
    return this.request<RegisterResponse>("POST", "/api/agents/register", { body, token });
  }

  /** Zero-touch self-enrollment with the enrollment key (first registration only). */
  selfRegister(body: Record<string, unknown>): Promise<RegisterResponse> {
    return this.request<RegisterResponse>("POST", "/api/bridge/self-register", { body });
  }

  heartbeat(
    agentId: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<HeartbeatResponse> {
    return this.request<HeartbeatResponse>("POST", `/api/agents/${agentId}/heartbeat`, {
      body,
      token,
    });
  }

  /** Poll + atomically claim queued commands for this agent. */
  async pollCommands(agentId: string, token: string): Promise<ClaimedCommand[]> {
    const data = await this.request<unknown>(
      "GET",
      `/api/agents/${agentId}/commands?status=queued`,
      { token },
    );
    if (Array.isArray(data)) return data as ClaimedCommand[];
    if (typeof data === "object" && data !== null) {
      const obj = data as { commands?: unknown; result?: unknown };
      if (Array.isArray(obj.commands)) return obj.commands as ClaimedCommand[];
      if (Array.isArray(obj.result)) return obj.result as ClaimedCommand[];
    }
    return [];
  }

  ack(agentId: string, token: string, cmdId: string, sessionId: string): Promise<unknown> {
    return this.request("POST", `/api/agents/${agentId}/commands/${cmdId}/ack`, {
      body: { session_id: sessionId },
      token,
    });
  }

  result(
    agentId: string,
    token: string,
    cmdId: string,
    sessionId: string,
    result: CommandResult,
  ): Promise<unknown> {
    const body: Record<string, unknown> = { session_id: sessionId, status: result.status };
    if (result.output !== undefined) body.output = result.output;
    if (result.exit_code !== undefined) body.exit_code = result.exit_code;
    if (result.error_reason !== undefined) body.error_reason = result.error_reason;
    return this.request("POST", `/api/agents/${agentId}/commands/${cmdId}/result`, {
      body,
      token,
    });
  }

  postEvent(
    agentId: string,
    token: string,
    body: { type: string; description: string; metadata?: Record<string, unknown> },
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.request("POST", `/api/agents/${agentId}/events`, { body, token, timeoutMs });
  }
}
