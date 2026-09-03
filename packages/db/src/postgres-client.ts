import postgres from "postgres";

export type PostgresClient = ReturnType<typeof postgres>;
export type PostgresClientOptions = NonNullable<Parameters<typeof postgres>[1]>;

export function createPostgresClient(
  databaseUrl: string,
  options?: PostgresClientOptions,
): PostgresClient {
  return postgres(databaseUrl, options);
}
