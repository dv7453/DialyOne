interface RemoteConfig {
    appUrl: string;
    supabaseUrl: string;
    websocketApiUrl: string;
    spacesApexUrl: string | null;
}

export async function getRemoteConfig(): Promise<RemoteConfig> {
    throw new Error("Hosted Rowboat API removed — no remote /v1/config.");
}

export async function getWebappUrl(): Promise<string> {
    throw new Error("Hosted Rowboat webapp removed.");
}
