declare module "pg" {
  export interface QueryResult<T> {
    rows: T[];
  }

  export interface PoolConfig {
    connectionString?: string;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    query<T = unknown>(text: string, values?: unknown[]): Promise<QueryResult<T>>;
  }
}
