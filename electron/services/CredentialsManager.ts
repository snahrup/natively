/**
 * CredentialsManager - Secure storage for API keys and service account paths
 * Uses Electron's safeStorage API for encryption at rest
 */

import { app, safeStorage } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CREDENTIALS_PATH = path.join(app.getPath('userData'), 'credentials.enc');

function loadCascadeProjectsEnv(): void {
    const envPath = path.join(os.homedir(), 'CascadeProjects', '.env');
    if (!fs.existsSync(envPath)) return;
    try {
        for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#') || !line.includes('=')) continue;
            const [rawKey, ...rawValueParts] = line.split('=');
            const key = rawKey.trim();
            if (!key || process.env[key]) continue;
            process.env[key] = rawValueParts.join('=').trim().replace(/^["']|["']$/g, '');
        }
    } catch (error) {
        console.warn('[CredentialsManager] Failed to load CascadeProjects AI defaults:', error);
    }
}

loadCascadeProjectsEnv();

export interface StoredCredentials {
    googleServiceAccountPath?: string;
    defaultModel?: string;
    nativelyApiKey?: string;
    // STT Provider settings
    sttProvider?: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively';
    groqSttApiKey?: string;
    groqSttModel?: string;
    openAiSttApiKey?: string;
    deepgramApiKey?: string;
    elevenLabsApiKey?: string;
    azureApiKey?: string;
    azureRegion?: string;
    ibmWatsonApiKey?: string;
    ibmWatsonRegion?: string;
    sonioxApiKey?: string;
    sttLanguage?: string;
    aiResponseLanguage?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh';
    // Tavily Search
    tavilyApiKey?: string;
}

export class CredentialsManager {
    private static instance: CredentialsManager;
    private credentials: StoredCredentials = {};

    private constructor() {
        // Load on construction after app ready
    }

    public static getInstance(): CredentialsManager {
        if (!CredentialsManager.instance) {
            CredentialsManager.instance = new CredentialsManager();
        }
        return CredentialsManager.instance;
    }

    /**
     * Initialize - load credentials from disk
     * Must be called after app.whenReady()
     */
    public init(): void {
        this.loadCredentials();
        console.log('[CredentialsManager] Initialized');
    }

    // =========================================================================
    // Getters
    // =========================================================================

    private isPlaceholderGoogleServiceAccountPath(filePath?: string): boolean {
        if (!filePath) return false;
        const normalized = filePath.replace(/\//g, '\\').toLowerCase();
        return normalized.includes('\\path\\to\\your\\service-account.json');
    }

    public getGoogleServiceAccountPath(): string | undefined {
        const filePath = this.credentials.googleServiceAccountPath;
        if (!filePath || this.isPlaceholderGoogleServiceAccountPath(filePath)) {
            return undefined;
        }
        return filePath;
    }

    public getSttProvider(): 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively' {
        const configured = this.credentials.sttProvider;
        if (configured && configured !== 'google') return configured;

        // Google is the weakest fallback for Steve's meeting use case. If a
        // higher-quality provider key is saved, promote it automatically unless
        // the user has explicitly selected another non-Google provider.
        if (this.credentials.nativelyApiKey) return 'natively';
        if (this.credentials.deepgramApiKey) return 'deepgram';
        if (this.credentials.sonioxApiKey) return 'soniox';
        if (this.credentials.openAiSttApiKey) return 'openai';
        if (this.credentials.elevenLabsApiKey) return 'elevenlabs';
        if (this.credentials.groqSttApiKey) return 'groq';
        if (this.credentials.azureApiKey) return 'azure';
        if (this.credentials.ibmWatsonApiKey) return 'ibmwatson';

        return configured || 'google';
    }

    public getDeepgramApiKey(): string | undefined {
        return this.credentials.deepgramApiKey;
    }

    public getGroqSttApiKey(): string | undefined {
        return this.credentials.groqSttApiKey;
    }

    public getGroqSttModel(): string {
        return this.credentials.groqSttModel || 'whisper-large-v3-turbo';
    }

    public getOpenAiSttApiKey(): string | undefined {
        return this.credentials.openAiSttApiKey;
    }

    public getElevenLabsApiKey(): string | undefined {
        return this.credentials.elevenLabsApiKey;
    }

    public getAzureApiKey(): string | undefined {
        return this.credentials.azureApiKey;
    }

    public getAzureRegion(): string {
        return this.credentials.azureRegion || 'eastus';
    }

    public getIbmWatsonApiKey(): string | undefined {
        return this.credentials.ibmWatsonApiKey;
    }

    public getIbmWatsonRegion(): string {
        return this.credentials.ibmWatsonRegion || 'us-south';
    }

    public getSonioxApiKey(): string | undefined {
        return this.credentials.sonioxApiKey;
    }

    public getTavilyApiKey(): string | undefined {
        return this.credentials.tavilyApiKey;
    }

    public getSttLanguage(): string {
        return this.credentials.sttLanguage || 'english-us';
    }

    public getAiResponseLanguage(): string {
        return this.credentials.aiResponseLanguage || 'auto';
    }

    public getReasoningEffort(): 'low' | 'medium' | 'high' | 'xhigh' {
        return this.credentials.reasoningEffort || 'xhigh';
    }

    public getDefaultModel(): string {
        return normalizeDefaultModel(this.credentials.defaultModel);
    }

    public getNativelyApiKey(): string | undefined {
        return this.credentials.nativelyApiKey;
    }

    public getAllCredentials(): StoredCredentials {
        return { ...this.credentials };
    }

    // =========================================================================
    // Setters (auto-save)
    // =========================================================================

    public setGoogleServiceAccountPath(filePath: string | null | undefined): void {
        const normalizedPath = filePath?.trim();
        if (!normalizedPath || this.isPlaceholderGoogleServiceAccountPath(normalizedPath)) {
            delete this.credentials.googleServiceAccountPath;
            this.saveCredentials();
            console.log('[CredentialsManager] Google Service Account path cleared');
            return;
        }

        this.credentials.googleServiceAccountPath = normalizedPath;
        this.saveCredentials();
        console.log('[CredentialsManager] Google Service Account path updated');
    }

    public setSttProvider(provider: 'google' | 'groq' | 'openai' | 'deepgram' | 'elevenlabs' | 'azure' | 'ibmwatson' | 'soniox' | 'natively'): void {
        this.credentials.sttProvider = provider;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Provider set to: ${provider}`);
    }

    public setDeepgramApiKey(key: string): void {
        this.credentials.deepgramApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Deepgram API Key updated');
    }

    public setGroqSttApiKey(key: string): void {
        this.credentials.groqSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Groq STT API Key updated');
    }

    public setOpenAiSttApiKey(key: string): void {
        this.credentials.openAiSttApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] OpenAI STT API Key updated');
    }

    public setGroqSttModel(model: string): void {
        this.credentials.groqSttModel = model;
        this.saveCredentials();
        console.log(`[CredentialsManager] Groq STT Model set to: ${model}`);
    }

    public setElevenLabsApiKey(key: string): void {
        this.credentials.elevenLabsApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] ElevenLabs API Key updated');
    }

    public setAzureApiKey(key: string): void {
        this.credentials.azureApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Azure API Key updated');
    }

    public setAzureRegion(region: string): void {
        this.credentials.azureRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] Azure Region set to: ${region}`);
    }

    public setIbmWatsonApiKey(key: string): void {
        this.credentials.ibmWatsonApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] IBM Watson API Key updated');
    }

    public setIbmWatsonRegion(region: string): void {
        this.credentials.ibmWatsonRegion = region;
        this.saveCredentials();
        console.log(`[CredentialsManager] IBM Watson Region set to: ${region}`);
    }

    public setSonioxApiKey(key: string): void {
        this.credentials.sonioxApiKey = key;
        this.saveCredentials();
        console.log('[CredentialsManager] Soniox API Key updated');
    }

    public setTavilyApiKey(key: string): void {
        // Store undefined (not empty string) when removing, so hasKey() checks stay consistent
        this.credentials.tavilyApiKey = key.trim() || undefined;
        this.saveCredentials();
        console.log('[CredentialsManager] Tavily API Key updated');
    }

    public setSttLanguage(language: string): void {
        this.credentials.sttLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] STT Language set to: ${language}`);
    }

    public setAiResponseLanguage(language: string): void {
        this.credentials.aiResponseLanguage = language;
        this.saveCredentials();
        console.log(`[CredentialsManager] AI Response Language set to: ${language}`);
    }

    public setReasoningEffort(effort: 'low' | 'medium' | 'high' | 'xhigh'): void {
        this.credentials.reasoningEffort = effort;
        this.saveCredentials();
        console.log(`[CredentialsManager] Reasoning Effort set to: ${effort}`);
    }

    public setDefaultModel(model: string): void {
        this.credentials.defaultModel = normalizeDefaultModel(model);
        this.saveCredentials();
        console.log(`[CredentialsManager] Default Model set to: ${this.credentials.defaultModel}`);
    }

    public setNativelyApiKey(key: string): void {
        const trimmed = key.trim();
        this.credentials.nativelyApiKey = trimmed || undefined;

        if (trimmed) {
            // Auto-promote natively STT if still on the default Google STT
            if (!this.credentials.sttProvider || this.credentials.sttProvider === 'google') {
                this.credentials.sttProvider = 'natively';
                console.log('[CredentialsManager] Auto-set STT provider to natively');
            }
        } else {
            if (this.credentials.sttProvider === 'natively') {
                this.credentials.sttProvider = 'google';
                console.log('[CredentialsManager] Natively key cleared — reset STT provider to Google');
            }
        }

        this.saveCredentials();
        console.log('[CredentialsManager] Natively API Key updated');
    }

    public clearAll(): void {
        this.scrubMemory();
        if (fs.existsSync(CREDENTIALS_PATH)) {
            fs.unlinkSync(CREDENTIALS_PATH);
        }
        const plaintextPath = CREDENTIALS_PATH + '.json';
        if (fs.existsSync(plaintextPath)) {
            fs.unlinkSync(plaintextPath);
        }
        console.log('[CredentialsManager] All credentials cleared');
    }

    /**
     * Scrub all API keys from memory to minimize exposure window.
     * Called on app quit and credential clear.
     */
    public scrubMemory(): void {
        // Overwrite each string field with empty before discarding
        for (const key of Object.keys(this.credentials) as (keyof StoredCredentials)[]) {
            const val = this.credentials[key];
            if (typeof val === 'string') {
                (this.credentials as any)[key] = '';
            }
        }
        this.credentials = {};
        console.log('[CredentialsManager] Memory scrubbed');
    }

    // =========================================================================
    // Storage (Encrypted)
    // =========================================================================

    private saveCredentials(): void {
        try {
            if (!safeStorage.isEncryptionAvailable()) {
                console.warn('[CredentialsManager] Encryption not available, falling back to plaintext');
                // Fallback: save as plaintext (less secure, but functional)
                const plainPath = CREDENTIALS_PATH + '.json';
                const tmpPlain = plainPath + '.tmp';
                fs.writeFileSync(tmpPlain, JSON.stringify(this.credentials));
                fs.renameSync(tmpPlain, plainPath);
                return;
            }

            const data = JSON.stringify(this.credentials);
            const encrypted = safeStorage.encryptString(data);
            const tmpEnc = CREDENTIALS_PATH + '.tmp';
            fs.writeFileSync(tmpEnc, encrypted);
            fs.renameSync(tmpEnc, CREDENTIALS_PATH);
        } catch (error) {
            console.error('[CredentialsManager] Failed to save credentials:', error);
        }
    }

    private scrubLegacyTextModelState(): void {
        let mutated = false;

        const legacyKeys = [
            'geminiApiKey',
            'groqApiKey',
            'openaiApiKey',
            'claudeApiKey',
            'customProviders',
            'curlProviders',
            'geminiPreferredModel',
            'groqPreferredModel',
            'openaiPreferredModel',
            'claudePreferredModel',
        ];

        for (const key of legacyKeys) {
            if ((this.credentials as Record<string, unknown>)[key] !== undefined) {
                delete (this.credentials as Record<string, unknown>)[key];
                mutated = true;
            }
        }

        const normalizedDefault = normalizeDefaultModel(this.credentials.defaultModel);
        if (this.credentials.defaultModel !== normalizedDefault) {
            this.credentials.defaultModel = normalizedDefault;
            mutated = true;
        }

        if (mutated) {
            this.saveCredentials();
            console.log('[CredentialsManager] Scrubbed legacy text-model API state from stored credentials');
        }
    }

    private loadCredentials(): void {
        try {
            // Try encrypted file first
            if (fs.existsSync(CREDENTIALS_PATH)) {
                if (!safeStorage.isEncryptionAvailable()) {
                    console.warn('[CredentialsManager] Encryption not available for load');
                    return;
                }

                const encrypted = fs.readFileSync(CREDENTIALS_PATH);
                const decrypted = safeStorage.decryptString(encrypted);
                try {
                    const parsed = JSON.parse(decrypted);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        this.scrubLegacyTextModelState();
                        console.log('[CredentialsManager] Loaded encrypted credentials');
                    } else {
                        throw new Error('Decrypted credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse decrypted credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }

                // Clean up any leftover plaintext fallback file to eliminate the data leak
                const plaintextPath = CREDENTIALS_PATH + '.json';
                if (fs.existsSync(plaintextPath)) {
                    try {
                        fs.unlinkSync(plaintextPath);
                        console.log('[CredentialsManager] Removed stale plaintext credential file');
                    } catch (cleanupErr) {
                        console.warn('[CredentialsManager] Could not remove stale plaintext file:', cleanupErr);
                    }
                }
                return;
            }

            // Fallback: try plaintext file
            const plaintextPath = CREDENTIALS_PATH + '.json';
            if (fs.existsSync(plaintextPath)) {
                const data = fs.readFileSync(plaintextPath, 'utf-8');
                try {
                    const parsed = JSON.parse(data);
                    if (typeof parsed === 'object' && parsed !== null) {
                        this.credentials = parsed;
                        this.scrubLegacyTextModelState();
                        console.log('[CredentialsManager] Loaded plaintext credentials');
                    } else {
                        throw new Error('Plaintext credentials is not a valid object');
                    }
                } catch (parseError) {
                    console.error('[CredentialsManager] Failed to parse plaintext credentials — file may be corrupted. Starting fresh:', parseError);
                    this.credentials = {};
                }
                return;
            }

            console.log('[CredentialsManager] No stored credentials found');
        } catch (error) {
            console.error('[CredentialsManager] Failed to load credentials:', error);
            this.credentials = {};
        }
    }
}

function normalizeDefaultModel(model?: string): string {
    const defaultClaudeModel = process.env.AI_CLAUDE_MODEL?.trim() || 'claude-opus-4-8';
    if (!model) return defaultClaudeModel;
    switch (model) {
        case 'claude':
        case 'claude-max':
        case 'claude-max-opus':
        case 'claude-max-opus-4-8':
        case 'claude-opus-4-8':
        case 'claude-max-opus-4-7':
        case 'claude-opus-4-7':
        case 'claude-max-opus-4-6':
        case 'claude-opus-4-6':
            return defaultClaudeModel;
        case 'claude-max-sonnet':
        case 'claude-max-sonnet-4-6':
            return 'claude-sonnet-4-6';
        case 'codex':
        case 'codex-gpt-5.5':
        case 'codex-gpt-5.2':
        case 'gpt-5.2':
            return 'gpt-5.5';
        case 'codex-gpt-5.4':
            return 'gpt-5.4';
        case 'codex-gpt-5.4-mini':
            return 'gpt-5.4-mini';
        case 'codex-gpt-5.3-codex':
        case 'codex-gpt-5.3-codex-spark':
        case 'gpt-5-codex':
        case 'gpt-5.3-codex':
        case 'gpt-5.3-codex-spark':
            return 'gpt-5.5';
        default:
            if (model.startsWith('claude-') || model.startsWith('gpt-5')) {
                return model;
            }
            return defaultClaudeModel;
    }
}
