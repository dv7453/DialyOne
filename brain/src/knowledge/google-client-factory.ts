import { OAuth2Client } from 'google-auth-library';
import { google, gmail_v1, type Common } from 'googleapis';
import container from '../di/container.js';
import { IOAuthRepo } from '../auth/repo.js';
import { IClientRegistrationRepo } from '../auth/client-repo.js';
import { getProviderConfig } from '../auth/providers.js';
import * as oauthClient from '../auth/oauth-client.js';
import type { Configuration } from '../auth/oauth-client.js';
import { OAuthTokens } from '../auth/types.js';

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** 429 anywhere, or Gmail's alternate 403-with-rate-limit-reason form. */
function isRateLimitError(err: Common.GaxiosError): boolean {
    const status = err.response?.status ?? err.status;
    if (status === 429) return true;
    if (status !== 403) return false;
    const data = err.response?.data as { error?: { errors?: { reason?: string }[] } } | undefined;
    return (data?.error?.errors ?? []).some((e) => e.reason !== undefined && RATE_LIMIT_REASONS.has(e.reason));
}

/** Retry-After in ms, capped at 30s; 2s when the header is absent/unparsable. */
function rateLimitDelayMs(err: Common.GaxiosError): number {
    const seconds = Number(err.response?.headers?.get('retry-after'));
    return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) * 1000 : 2000;
}

/**
 * Factory for creating and managing Google OAuth2Client instances.
 * Handles caching, token refresh, and client reuse for Google API SDKs.
 *
 * Local BYOK Google OAuth only: user-supplied client_id+secret; refresh
 * runs locally via openid-client.
 */
export class GoogleClientFactory {
    private static readonly PROVIDER_NAME = 'google';
    private static cache: {
        config: Configuration | null;
        client: OAuth2Client | null;
        tokens: OAuthTokens | null;
        clientId: string | null;
        clientSecret: string | null;
    } = {
        config: null,
        client: null,
        tokens: null,
        clientId: null,
        clientSecret: null,
    };

    /**
     * Promise singleton so concurrent getClient() callers share a single
     * pass through the read/refresh/build pipeline rather than fanning
     * out parallel refreshes. The check-and-assign must be atomic (no
     * `await` between them) so two callers in the same tick can't both
     * pass the null check before either assigns — that's why getClient()
     * is a thin synchronous wrapper around getClientInner().
     */
    private static inFlightClient: Promise<OAuth2Client | null> | null = null;

    private static async resolveByokCredentials(): Promise<{ clientId: string; clientSecret?: string }> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const connection = await oauthRepo.read(this.PROVIDER_NAME);
        if (!connection.clientId) {
            await oauthRepo.upsert(this.PROVIDER_NAME, { error: 'Google client ID missing. Please reconnect.' });
            throw new Error('Google client ID missing. Please reconnect.');
        }
        return { clientId: connection.clientId, clientSecret: connection.clientSecret ?? undefined };
    }

    /**
     * Get or create OAuth2Client, reusing the cached instance when possible.
     *
     * The check-and-assign of `inFlightClient` is synchronous so concurrent
     * callers in the same tick coalesce onto a single pipeline run. The actual
     * work lives in getClientInner(); this wrapper exists purely to guarantee
     * the dedup invariant.
     */
    static async getClient(): Promise<OAuth2Client | null> {
        if (this.inFlightClient) {
            return this.inFlightClient;
        }
        this.inFlightClient = this.getClientInner().finally(() => {
            this.inFlightClient = null;
        });
        return this.inFlightClient;
    }

    private static async getClientInner(): Promise<OAuth2Client | null> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const connection = await oauthRepo.read(this.PROVIDER_NAME);
        const tokens = connection.tokens ?? null;

        if (!tokens) {
            this.clearCache();
            return null;
        }

        try {
            await this.initializeConfigCache();
        } catch (error) {
            console.error('[OAuth] Failed to initialize Google OAuth configuration:', error);
            this.clearCache();
            return null;
        }
        if (!this.cache.config) {
            return null;
        }

        if (oauthClient.isTokenExpired(tokens)) {
            if (!tokens.refresh_token) {
                console.log('[OAuth] Google token expired and no refresh token available.');
                await oauthRepo.upsert(this.PROVIDER_NAME, { error: 'Missing refresh token. Please reconnect.' });
                this.clearCache();
                return null;
            }
            return this.refreshAndBuild(tokens);
        }

        if (this.cache.client && this.cache.tokens && this.cache.tokens.access_token === tokens.access_token) {
            return this.cache.client;
        }

        return this.buildAndCacheClient(tokens);
    }

    private static async refreshAndBuild(tokens: OAuthTokens): Promise<OAuth2Client | null> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');

        try {
            const secsSinceExpiry = Math.floor(Date.now() / 1000) - tokens.expires_at;
            console.log(`[OAuth] Google token expired ${secsSinceExpiry}s ago, refreshing locally...`);
            if (!this.cache.config) {
                throw new Error('Google OAuth config not initialized');
            }
            const existingScopes = tokens.scopes;
            const refreshedTokens = await oauthClient.refreshTokens(this.cache.config, tokens.refresh_token!, existingScopes);

            await oauthRepo.upsert(this.PROVIDER_NAME, { tokens: refreshedTokens, error: null });
            const ttl = refreshedTokens.expires_at - Math.floor(Date.now() / 1000);
            console.log(`[OAuth] Google token refreshed successfully (new expires_at=${refreshedTokens.expires_at}, ttl=${ttl}s)`);
            return this.buildAndCacheClient(refreshedTokens);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to refresh token for Google';
            await oauthRepo.upsert(this.PROVIDER_NAME, { error: message });
            console.error('[OAuth] Failed to refresh token for Google:', error);
            this.clearCache();
            return null;
        }
    }

    private static async buildAndCacheClient(tokens: OAuthTokens): Promise<OAuth2Client> {
        if (!this.cache.clientId) {
            const creds = await this.resolveByokCredentials();
            this.cache.clientId = creds.clientId;
            this.cache.clientSecret = creds.clientSecret ?? null;
        }

        const client = this.createByokClient(tokens, this.cache.clientId!, this.cache.clientSecret ?? undefined);
        this.cache.tokens = tokens;
        this.cache.client = client;
        return client;
    }

    /**
     * Check if credentials are available and have required scopes
     */
    static async hasValidCredentials(requiredScopes: string | string[]): Promise<boolean> {
        const status = await this.getCredentialStatus(requiredScopes);
        return status.hasRequiredScopes;
    }

    static async getCredentialStatus(requiredScopes: string | string[]): Promise<{
        connected: boolean;
        hasRequiredScopes: boolean;
        missingScopes: string[];
    }> {
        const oauthRepo = container.resolve<IOAuthRepo>('oauthRepo');
        const { tokens } = await oauthRepo.read(this.PROVIDER_NAME);
        if (!tokens) {
            const scopesArray = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
            return {
                connected: false,
                hasRequiredScopes: false,
                missingScopes: scopesArray,
            };
        }

        const scopesArray = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];
        const granted = new Set(tokens.scopes ?? []);
        const missingScopes = scopesArray.filter(scope => !granted.has(scope));
        if (!tokens.scopes || tokens.scopes.length === 0) {
            return {
                connected: true,
                hasRequiredScopes: false,
                missingScopes,
            };
        }
        return {
            connected: true,
            hasRequiredScopes: missingScopes.length === 0,
            missingScopes,
        };
    }

    /**
     * Clear cache (useful for testing or when credentials are revoked)
     */
    static clearCache(): void {
        console.log('[OAuth] Clearing Google auth cache');
        this.cache.config = null;
        this.cache.client = null;
        this.cache.tokens = null;
        this.cache.clientId = null;
        this.cache.clientSecret = null;
    }

    /**
     * Initialize cached openid-client configuration for local Google OAuth.
     */
    private static async initializeConfigCache(): Promise<void> {
        const { clientId, clientSecret } = await this.resolveByokCredentials();

        if (this.cache.config && this.cache.clientId === clientId && this.cache.clientSecret === (clientSecret ?? null)) {
            return; // Already initialized for these credentials
        }

        if (this.cache.clientId && (this.cache.clientId !== clientId || this.cache.clientSecret !== (clientSecret ?? null))) {
            this.clearCache();
        }

        console.log('[OAuth] Initializing Google OAuth configuration...');
        const providerConfig = await getProviderConfig(this.PROVIDER_NAME);

        if (providerConfig.discovery.mode === 'issuer') {
            if (providerConfig.client.mode === 'static') {
                // Discover endpoints, use static client ID
                console.log('[OAuth] Discovery mode: issuer with static client ID');
                this.cache.config = await oauthClient.discoverConfiguration(
                    providerConfig.discovery.issuer,
                    clientId,
                    clientSecret
                );
            } else {
                // DCR mode - need existing registration
                console.log('[OAuth] Discovery mode: issuer with DCR');
                const clientRepo = container.resolve<IClientRegistrationRepo>('clientRegistrationRepo');
                const existingRegistration = await clientRepo.getClientRegistration(this.PROVIDER_NAME);

                if (!existingRegistration) {
                    throw new Error('Google client not registered. Please connect account first.');
                }

                this.cache.config = await oauthClient.discoverConfiguration(
                    providerConfig.discovery.issuer,
                    existingRegistration.client_id
                );
            }
        } else {
            // Static endpoints
            if (providerConfig.client.mode !== 'static') {
                throw new Error('DCR requires discovery mode "issuer", not "static"');
            }

            console.log('[OAuth] Using static endpoints (no discovery)');
            this.cache.config = oauthClient.createStaticConfiguration(
                providerConfig.discovery.authorizationEndpoint,
                providerConfig.discovery.tokenEndpoint,
                clientId,
                providerConfig.discovery.revocationEndpoint,
                clientSecret
            );
        }

        this.cache.clientId = clientId;
        this.cache.clientSecret = clientSecret ?? null;
        console.log('[OAuth] Google OAuth configuration initialized');
    }

    /**
     * Gmail API client with rate-limit retry — parity with Outlook's
     * graphFetch (outlook-client-factory.ts): one retry per request on a
     * throttled response, waiting out Retry-After capped at 30s (2s when the
     * header is absent). gaxios' stock retry can't express this — its delay
     * formula never reads Retry-After, and its default method list excludes
     * POST, which modify/trash/send all use — so both hooks are custom. A
     * request still throttled after the retry fails like any other error.
     */
    static gmailClient(auth: OAuth2Client): gmail_v1.Gmail {
        return google.gmail({
            version: 'v1',
            auth,
            retryConfig: {
                retry: 1,
                shouldRetry: (err) =>
                    (err.config.retryConfig?.currentRetryAttempt ?? 0) < 1 && isRateLimitError(err),
                retryBackoff: (err) => {
                    const waitMs = rateLimitDelayMs(err);
                    console.warn(`[Gmail] rate limited — retrying after ${waitMs}ms`);
                    return new Promise((resolve) => setTimeout(resolve, waitMs));
                },
            },
        });
    }

    /** BYOK OAuth2Client — has client_id + secret + refresh_token. */
    private static createByokClient(tokens: OAuthTokens, clientId: string, clientSecret?: string): OAuth2Client {
        const client = new OAuth2Client(clientId, clientSecret ?? undefined, undefined);
        client.setCredentials({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            expiry_date: tokens.expires_at * 1000,
            scope: tokens.scopes?.join(' ') || undefined,
        });
        return client;
    }
}
