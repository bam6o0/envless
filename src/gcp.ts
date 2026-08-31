import type { Source } from "./manifest.ts";
import type { SecretFetcher } from "./resolve.ts";

type GcpSource = Extract<Source, { kind: "gcp" }>;

export class SecretAccessError extends Error {}

/**
 * Secret Manager fetcher backed by Application Default Credentials.
 *
 * The client is created lazily so `envless run` on a manifest with no secrets
 * neither loads the SDK nor needs credentials.
 */
export function gcpFetcher(): { fetch: SecretFetcher; close: () => Promise<void> } {
  type Client = import("@google-cloud/secret-manager").SecretManagerServiceClient;
  let client: Client | undefined;

  const fetch: SecretFetcher = async (source: GcpSource) => {
    if (!client) {
      const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
      client = new SecretManagerServiceClient();
    }
    const name = `projects/${source.project}/secrets/${source.secret}/versions/${source.version}`;
    try {
      const [version] = await client.accessSecretVersion({ name });
      const value = version.payload?.data?.toString();
      if (!value) {
        throw new SecretAccessError(`${name} has an empty payload`);
      }
      return value;
    } catch (err) {
      throw explain(err, name);
    }
  };

  return {
    fetch,
    // The gRPC channel keeps the process alive if it is not closed.
    close: async () => {
      await client?.close();
    },
  };
}

function explain(err: unknown, name: string): Error {
  if (err instanceof SecretAccessError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes("Could not load the default credentials") ||
    message.includes("UNAUTHENTICATED")
  ) {
    return new SecretAccessError(
      `not authenticated for ${name}\n  run: gcloud auth application-default login`
    );
  }
  if (message.includes("PERMISSION_DENIED")) {
    return new SecretAccessError(
      `permission denied for ${name}\n  the active identity needs roles/secretmanager.secretAccessor`
    );
  }
  if (message.includes("NOT_FOUND")) {
    return new SecretAccessError(
      `not found: ${name}\n  check the project and secret name in the manifest`
    );
  }
  return new SecretAccessError(`${name}: ${message}`);
}
