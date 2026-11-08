export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AuthContext {
  sessionId?: string;
  sessionName?: string;
  /** Set only for HTTP requests authenticated by the shared bearer token. */
  sharedBearer?: true;
}
